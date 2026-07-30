/**
 * Vehicle simulation and bodywork.
 *
 * Raycast vehicle (4 suspension rays, slip-based grip, load transfer) plus the
 * whole presentation layer: procedural bodies, working lamps, damage
 * deformation, skidmarks, tyre smoke and exhaust.
 *
 * Handling brief for the Dacia: forgiving at low speed, slow to wind up, capped
 * top speed, trivially easy to handbrake-turn, mildly oversteery once moving,
 * with exaggerated *visual* body roll / squat / dive that never touches the
 * collider — so it feels heavy and theatrical but cannot be flipped by its own
 * animation.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, System } from '../core/engine';
import { CG, GROUP, PhysicsWorld, groups } from '../physics/physics';
import { Rng } from '../core/rng';
import {
  Services,
  type Faction,
  type VehicleClass,
  type VehicleHandle,
  type VehicleService,
} from '../core/services';
import { createCarMaterial, makeCarUniforms, type CarUniforms } from './builder';
import { vehicleAtlas } from './texture';
import { SPECS, VARIANTS, buildBody, cachedBodyStats, type BodyAnchors, type VehicleSpec } from './bodies';
import { CLASS_MODELS, MODELS, heroDents, modelFor, type ModelHandling, type VehicleModel } from './models';
import type { DoorPart } from './carkit';
import { wheelGeometry } from './wheels';
import { VehicleLamps, VehicleLightPool, contactShadowAssets } from './lights';
import { DamageModel, deform } from './damage';
import { ParticlePool, SkidmarkPool } from './skidmarks';

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

interface WheelSpec {
  offset: THREE.Vector3;
  radius: number;
  steered: boolean;
  driven: boolean;
  handbraked: boolean;
}

export interface VehicleTuning {
  spec: VehicleSpec;
  mass: number;
  halfExtents: THREE.Vector3;
  colliderCentreY: number;
  comOffset: THREE.Vector3;
  suspensionRest: number;
  suspensionStiffness: number;
  suspensionDamping: number;
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  maxSteerRad: number;
  steerSpeedFalloff: number;
  steerRate: number;
  gripFront: number;
  gripRear: number;
  /** How much rear grip is lost at top speed — this is the oversteer dial. */
  rearGripFade: number;
  handbrakeSlide: number;
  topSpeed: number;
  reverseSpeed: number;
  downforce: number;
  /** Visual-only body motion gains. */
  rollGain: number;
  pitchGain: number;
  /** How hard the chassis fights being tipped over. */
  antiRoll: number;
  wheels: WheelSpec[];
  seats: number;
}

interface HandlingOverride extends ModelHandling {
  mass: number;
  engineForce: number;
  topSpeed: number;
}

const HANDLING: Record<VehicleClass, HandlingOverride> = {
  // Slow, soft, tail-happy. 112 km/h flat out and it takes a while to get there.
  dacia: {
    mass: 950, engineForce: 6200, topSpeed: 34, gripFront: 6.8, gripRear: 6.0,
    rearGripFade: 0.30, maxSteerRad: 0.62, suspensionStiffness: 25,
    rollGain: 1.0, pitchGain: 1.0, brakeForce: 6200, handbrakeForce: 9200, antiRoll: 1.25,
  },
  sedan: { mass: 1320, engineForce: 9600, topSpeed: 44, gripFront: 8.4, gripRear: 8.0, rearGripFade: 0.16, rollGain: 0.6, pitchGain: 0.7, suspensionStiffness: 32 },
  hatch: { mass: 1080, engineForce: 8000, topSpeed: 40, gripFront: 8.0, gripRear: 7.4, rearGripFade: 0.2, rollGain: 0.75, pitchGain: 0.8, suspensionStiffness: 30 },
  van: { mass: 1980, engineForce: 11500, topSpeed: 35, gripFront: 7.2, gripRear: 7.0, rearGripFade: 0.22, rollGain: 1.35, pitchGain: 1.0, suspensionStiffness: 28, antiRoll: 1.5 },
  truck: { mass: 6200, engineForce: 30000, topSpeed: 28, gripFront: 7.4, gripRear: 7.4, rearGripFade: 0.1, rollGain: 1.4, pitchGain: 0.9, suspensionStiffness: 30, antiRoll: 1.9 },
  bus: { mass: 11000, engineForce: 44000, topSpeed: 25, gripFront: 7.6, gripRear: 7.6, rearGripFade: 0.08, rollGain: 1.3, pitchGain: 0.8, suspensionStiffness: 30, antiRoll: 2.2, maxSteerRad: 0.42 },
  police: { mass: 1420, engineForce: 13500, topSpeed: 50, gripFront: 9.4, gripRear: 9.0, rearGripFade: 0.14, rollGain: 0.55, pitchGain: 0.6, suspensionStiffness: 36, brakeForce: 9000, antiRoll: 1.4 },
  tram: { mass: 26000, engineForce: 60000, topSpeed: 17, gripFront: 14, gripRear: 14, rearGripFade: 0, maxSteerRad: 0.06, rollGain: 0.18, pitchGain: 0.2, antiRoll: 3.2, suspensionStiffness: 42 },
  scooter: { mass: 30, engineForce: 260, topSpeed: 8.5, gripFront: 9, gripRear: 9, rearGripFade: 0, maxSteerRad: 0.7, rollGain: 0.5, pitchGain: 0.5, antiRoll: 4.5, suspensionStiffness: 40 },
};

function makeTuning(kind: VehicleClass, model: VehicleModel): VehicleTuning {
  const spec = model.spec;
  const h: HandlingOverride = { ...HANDLING[kind], ...(model.handling ?? {}) };
  const stiffness = h.suspensionStiffness ?? 28;
  const rest = Math.min(0.36, spec.wheelRadius * 1.15);
  // Static compression at rest: spring force must balance a quarter of the
  // weight, so this is exactly where the wheel sits when parked.
  const restCompression = 9.81 / stiffness;
  const wheelCentreY = -spec.rideHeight + spec.wheelRadius;
  const attachY = wheelCentreY + rest * (1 - restCompression);

  const wheels: WheelSpec[] = [];
  if (spec.twoWheeled) {
    wheels.push(
      { offset: new THREE.Vector3(0, attachY, spec.frontAxleZ), radius: spec.wheelRadius, steered: true, driven: false, handbraked: false },
      { offset: new THREE.Vector3(0, attachY, spec.rearAxleZ), radius: spec.wheelRadius, steered: false, driven: true, handbraked: true },
    );
  } else {
    for (const sx of [-1, 1]) {
      wheels.push({ offset: new THREE.Vector3(sx * spec.trackHalf, attachY, spec.frontAxleZ), radius: spec.wheelRadius, steered: true, driven: false, handbraked: false });
    }
    for (const sx of [-1, 1]) {
      wheels.push({ offset: new THREE.Vector3(sx * spec.trackHalf, attachY, spec.rearAxleZ), radius: spec.wheelRadius, steered: false, driven: true, handbraked: true });
    }
    // Extra unpowered axles. A 15 m tram carried on four rays 10.8 m apart has
    // 2.2 m of unsupported overhang at each end, so every road crown pitched it
    // like a see-saw and the nose speared into the tarmac; a bus and a truck
    // want their real rear bogies for the same reason.
    for (const az of spec.extraAxles ?? []) {
      for (const sx of [-1, 1]) {
        wheels.push({ offset: new THREE.Vector3(sx * spec.trackHalf, attachY, az), radius: spec.wheelRadius, steered: false, driven: false, handbraked: true });
      }
    }
  }

  // Collider covers the lower body only — a box up to the belt line keeps the
  // car from catching its own roof on things and keeps the inertia low. Long
  // vehicles get more ground clearance under the box and a slightly shorter
  // one, or the corners catch every kerb and launch them.
  const halfY = Math.max(0.3, spec.height * 0.34);
  const clearance = THREE.MathUtils.clamp(spec.wheelRadius * 0.5, 0.14, 0.26);
  const colliderCentreY = -spec.rideHeight + halfY + clearance;
  const halfZ = spec.length > 6 ? spec.length * 0.455 : spec.length * 0.48;

  return {
    spec,
    mass: h.mass,
    halfExtents: new THREE.Vector3(spec.width * 0.48, halfY, halfZ),
    colliderCentreY,
    comOffset: new THREE.Vector3(0, -spec.rideHeight + spec.height * 0.20, spec.length * 0.01),
    suspensionRest: rest,
    suspensionStiffness: stiffness,
    suspensionDamping: 3.4,
    engineForce: h.engineForce,
    brakeForce: h.brakeForce ?? h.engineForce * 1.15,
    handbrakeForce: h.handbrakeForce ?? h.engineForce * 1.5,
    maxSteerRad: h.maxSteerRad ?? 0.56,
    steerSpeedFalloff: 0.052,
    steerRate: 7.5,
    gripFront: h.gripFront ?? 8,
    gripRear: h.gripRear ?? 7.5,
    rearGripFade: h.rearGripFade ?? 0.18,
    handbrakeSlide: kind === 'dacia' ? 0.16 : 0.22,
    topSpeed: h.topSpeed,
    reverseSpeed: h.topSpeed * 0.32,
    downforce: h.downforce ?? 10,
    rollGain: h.rollGain ?? 0.8,
    pitchGain: h.pitchGain ?? 0.8,
    antiRoll: h.antiRoll ?? 1.3,
    wheels,
    seats: spec.seats,
  };
}

/** Tuning is per MODEL, not per class — a Duster and an Oltcit are both hatches. */
const TUNING_CACHE = new Map<string, VehicleTuning>();
function tuningFor(kind: VehicleClass, model: VehicleModel): VehicleTuning {
  let t = TUNING_CACHE.get(model.id);
  if (!t) {
    t = makeTuning(kind, model);
    TUNING_CACHE.set(model.id, t);
  }
  return t;
}

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/* ------------------------------------------------------------------ */
/* Doors                                                               */
/* ------------------------------------------------------------------ */

interface DoorState {
  readonly part: DoorPart;
  readonly group: THREE.Group;
  /** 0 shut, 1 fully open. */
  open: number;
  target: number;
  /** Sprung shut when nothing is holding it open. */
  autoClose: boolean;
}

/**
 * What `src/gameplay/player.ts` (and anything else that wants to open a door)
 * can rely on. `VehicleHandle` in the frozen `core/services.ts` does not
 * declare these, so callers duck-type:
 *
 *   const d = v as Partial<VehicleDoors>;
 *   d.setDoorOpen?.('driver', amount);
 */
export interface VehicleDoors {
  /** Door ids present on this vehicle, e.g. frontLeft / frontRight / rearLeft. */
  readonly doorIds: ReadonlyArray<string>;
  /** `'driver'` resolves to the left-hand front door (this city drives LHD). */
  setDoorOpen(id: string, amount: number): void;
  /** World point a character should stand at to work this door. */
  doorAnchor(id: string, out: THREE.Vector3): THREE.Vector3 | null;
  /** World point the occupant of this door's seat ends up at. */
  seatAnchor(id: string, out: THREE.Vector3): THREE.Vector3 | null;
}

/* ------------------------------------------------------------------ */
/* Vehicle                                                             */
/* ------------------------------------------------------------------ */

class Vehicle implements VehicleHandle {
  readonly object = new THREE.Group();
  /** Everything that leans: shell, glass, interior. Wheels stay on the road. */
  readonly bodyGroup = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly rotation = new THREE.Quaternion();
  readonly occupants: string[] = [];

  body!: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  tuning: VehicleTuning;
  anchors!: BodyAnchors;
  uniforms: CarUniforms = makeCarUniforms();
  lamps!: VehicleLamps;
  damage: DamageModel;
  shellMesh!: THREE.Mesh;
  glassMesh: THREE.Mesh | null = null;
  contactShadow: THREE.Mesh | null = null;
  driverMesh: THREE.Mesh | null = null;
  lodBand = -1;
  /** Baked-in filth, before any collision damage. */
  baseGrime = 0;

  /** Openable doors, in the order the model declared them. */
  readonly doors: DoorState[] = [];

  seats: number;
  throttle = 0;
  steerInput = 0;
  handbrakeInput = false;
  steerAngle = 0;
  siren = 0;
  headlightLevel = 1;
  indicator: -1 | 0 | 1 | 2 = 0;

  wheelMeshes: THREE.Object3D[] = [];
  wheelContact: boolean[] = [];
  wheelCompression: number[] = [];
  wheelSpin: number[] = [];
  wheelSlip: number[] = [];
  wheelPoint: THREE.Vector3[] = [];
  private lastSkid: THREE.Vector3[] = [];
  private skidding: boolean[] = [];

  /** Smoothed accelerations that drive the visual body motion. */
  private latAccel = 0;
  private longAccel = 0;
  private prevFwdSpeed = 0;
  private upsideTime = 0;
  /** Seconds with no wheel touching anything. Drives the stuck rescue. */
  airTime = 0;
  private exhaustTimer = 0;
  private smokeTimer = 0;
  private engineBound = false;
  audioBoundName = '';

  distanceToCamera = 0;
  /** Contact force above which a hit counts as a crash, not resting weight. */
  readonly crashThreshold: number;
  /** Freshly spawned vehicles ignore contacts while they settle. */
  private grace = 3.0;
  /** True while the static-friction clamp is holding the car still. */
  parked = false;
  /** Decaying peak speed. Crash damage needs closing speed, not just contact —
   *  this is what stops a car wedged against a kerb grinding itself to death. */
  recentSpeed = 0;

  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _up = new THREE.Vector3();
  private _tmp = new THREE.Vector3();
  private _tmp2 = new THREE.Vector3();
  private _tmp3 = new THREE.Vector3();

  constructor(
    readonly id: string,
    readonly kind: VehicleClass,
    readonly faction: Faction,
    private phys: PhysicsWorld,
    readonly model: VehicleModel,
  ) {
    this.tuning = tuningFor(kind, model);
    this.seats = this.tuning.seats;
    const n = this.tuning.wheels.length;
    this.wheelContact = new Array(n).fill(false);
    this.wheelCompression = new Array(n).fill(0);
    this.wheelSpin = new Array(n).fill(0);
    this.wheelSlip = new Array(n).fill(0);
    this.wheelPoint = Array.from({ length: n }, () => new THREE.Vector3());
    this.lastSkid = Array.from({ length: n }, () => new THREE.Vector3());
    this.skidding = new Array(n).fill(false);
    this.damage = new DamageModel(kind === 'dacia' ? 1000 : kind === 'truck' || kind === 'bus' || kind === 'tram' ? 4200 : 1200);
    this.crashThreshold = this.tuning.mass * 9.81 * 2.4;
    this.object.add(this.bodyGroup);
  }

  get settled(): boolean {
    return this.grace <= 0;
  }

  tickGrace(dt: number): void {
    if (this.grace > 0) this.grace -= dt;
    this.damage.tick(dt);
  }

  get health(): number { return this.damage.health; }
  get maxHealth(): number { return this.damage.maxHealth; }
  get isWrecked(): boolean { return this.damage.isWrecked; }

  get speed(): number {
    const v = this.body.linvel();
    this._fwd.set(0, 0, 1).applyQuaternion(this.rotation);
    return this._tmp.set(v.x, v.y, v.z).dot(this._fwd);
  }

  setControls(throttle: number, steer: number, handbrake: boolean): void {
    this.throttle = THREE.MathUtils.clamp(throttle, -1, 1);
    // NEGATED. `wheelFwd.applyAxisAngle(up, steerAngle)` rotates the forward
    // vector about +Y, and a positive rotation takes +Z toward +X — but the
    // car's right is F x up = (-cos, 0, sin), i.e. -X. So a positive steer
    // input turned the car LEFT. Negating here fixes the physics and the
    // visual wheel rotation together, since both read `steerAngle`.
    this.steerInput = -THREE.MathUtils.clamp(steer, -1, 1);
    this.handbrakeInput = handbrake;
  }

  /* ---------------- doors (see `VehicleDoors`) ---------------- */

  get doorIds(): ReadonlyArray<string> {
    return this.doors.map((d) => d.part.id);
  }

  private findDoor(id: string): DoorState | undefined {
    if (id === 'driver') return this.doors.find((d) => d.part.row === 0 && d.part.side < 0) ?? this.doors[0];
    if (id === 'passenger') return this.doors.find((d) => d.part.row === 0 && d.part.side > 0);
    return this.doors.find((d) => d.part.id === id);
  }

  setDoorOpen(id: string, amount: number): void {
    const d = this.findDoor(id);
    if (!d) return;
    d.target = THREE.MathUtils.clamp(amount, 0, 1);
    d.autoClose = d.target <= 0.001;
  }

  doorAnchor(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const d = this.findDoor(id);
    if (!d) return null;
    return out.copy(d.part.board).applyQuaternion(this.rotation).add(this.position);
  }

  seatAnchor(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const d = this.findDoor(id);
    if (!d) return null;
    return out.copy(d.part.seat).applyQuaternion(this.rotation).add(this.position);
  }

  private updateDoors(dt: number): void {
    for (const d of this.doors) {
      // A door left open while the car drives away swings shut on its own.
      if (d.autoClose && d.target > 0) d.target = 0;
      const k = Math.min(1, dt * (d.target > d.open ? 6.5 : 8.5));
      d.open += (d.target - d.open) * k;
      if (Math.abs(d.open - d.target) < 0.002) d.open = d.target;
      d.group.rotation.y = -d.part.side * d.open * d.part.maxAngle;
    }
  }

  /** Not part of VehicleService — police/AI cast to this. */
  setSiren(on: boolean): void { this.siren = on ? 1 : 0; }
  setIndicator(i: -1 | 0 | 1 | 2): void { this.indicator = i; }
  setHeadlights(level: number): void { this.headlightLevel = THREE.MathUtils.clamp(level, 0, 1); }

  applyDamage(amount: number): void {
    const before = this.damage.health;
    this.damage.applyDamage(amount);
    void before;
  }

  teleport(position: THREE.Vector3, headingRad: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, headingRad);
    this.body.setTranslation({ x: position.x, y: position.y + this.tuning.spec.rideHeight, z: position.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.upsideTime = 0;
  }

  recover(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w), 'YXZ');
    this.teleport(new THREE.Vector3(t.x, t.y - this.tuning.spec.rideHeight + 0.25, t.z), e.y);
  }

  /* ---------------- simulation ---------------- */

  simulate(dt: number): void {
    this.tickGrace(dt);
    const body = this.body;
    const t = body.translation();
    const r = body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.rotation.set(r.x, r.y, r.z, r.w);
    this.object.position.copy(this.position);
    this.object.quaternion.copy(this.rotation);

    this._fwd.set(0, 0, 1).applyQuaternion(this.rotation);
    this._right.set(1, 0, 0).applyQuaternion(this.rotation);
    this._up.set(0, 1, 0).applyQuaternion(this.rotation);

    const tuning = this.tuning;
    const lin = body.linvel();
    const vel = this._tmp2.set(lin.x, lin.y, lin.z);
    const fwdSpeed = vel.dot(this._fwd);
    const absSpeed = Math.abs(fwdSpeed);
    const speedRatio = THREE.MathUtils.clamp(absSpeed / tuning.topSpeed, 0, 1.4);
    this.recentSpeed = Math.max(vel.length(), this.recentSpeed * 0.94);

    // --- steering: generous when parking, tight at speed -----------------
    const steerLimit = tuning.maxSteerRad / (1 + absSpeed * tuning.steerSpeedFalloff);
    const targetSteer = this.steerInput * steerLimit;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * tuning.steerRate);

    let groundedWheels = 0;
    const rearGrip = tuning.gripRear * (1 - tuning.rearGripFade * Math.min(1, speedRatio));

    for (let i = 0; i < tuning.wheels.length; i++) {
      const w = tuning.wheels[i];
      const attach = this._tmp.copy(w.offset).applyQuaternion(this.rotation).add(this.position);
      const rayLen = tuning.suspensionRest + w.radius;
      // NB: membership must be one of the bits inside physics.ts' ALL_SOLID
      // mask, otherwise the filter test can never pass and the ray matches
      // nothing. CG.WHEEL_RAY is outside that mask — see the report.
      const hit = this.phys.raycast(
        attach, DOWN, rayLen,
        groups(CG.VEHICLE, CG.STATIC | CG.TERRAIN | CG.PROP),
        this.collider,
      );

      if (!hit) {
        this.wheelContact[i] = false;
        this.wheelCompression[i] += (0 - this.wheelCompression[i]) * Math.min(1, dt * 8);
        this.wheelSlip[i] *= 0.9;
        this.wheelSpin[i] += (fwdSpeed / w.radius) * dt;
        this.skidding[i] = false;
        continue;
      }

      groundedWheels++;
      this.wheelContact[i] = true;
      const compression = 1 - THREE.MathUtils.clamp((hit.distance - w.radius) / tuning.suspensionRest, 0, 1);
      const prev = this.wheelCompression[i];
      this.wheelCompression[i] = compression;
      const compressionRate = (compression - prev) / dt;

      const springForce = compression * tuning.suspensionStiffness * tuning.mass * 0.25;
      const damperForce = compressionRate * tuning.suspensionDamping * tuning.mass * 0.25;
      const suspension = THREE.MathUtils.clamp(springForce + damperForce, 0, tuning.mass * 45);

      const fv = this._tmp3.copy(hit.normal).multiplyScalar(suspension * dt);
      body.applyImpulseAtPoint({ x: fv.x, y: fv.y, z: fv.z }, { x: attach.x, y: attach.y, z: attach.z }, true);

      const wheelFwd = _wf.copy(this._fwd);
      const wheelRight = _wr.copy(this._right);
      if (w.steered) {
        wheelFwd.applyAxisAngle(this._up, this.steerAngle);
        wheelRight.applyAxisAngle(this._up, this.steerAngle);
      }

      const contactPoint = _cp.copy(attach).addScaledVector(DOWN, hit.distance);
      this.wheelPoint[i].copy(hit.point);
      const av = body.angvel();
      const rel = _rel.subVectors(contactPoint, this.position);
      const pointVel = _pv.set(lin.x, lin.y, lin.z).add(_av.set(av.x, av.y, av.z).cross(rel));

      const lateralSpeed = pointVel.dot(wheelRight);
      const longitudinalSpeed = pointVel.dot(wheelFwd);

      const gripCoef = w.steered ? tuning.gripFront : rearGrip;
      const loadFactor = suspension / (tuning.mass * 9.81 * 0.25);
      let maxLateral = gripCoef * tuning.mass * 0.25 * Math.min(2.2, loadFactor) * dt;
      if (this.handbrakeInput && w.handbraked) maxLateral *= tuning.handbrakeSlide;
      const lateralImpulse = THREE.MathUtils.clamp(-lateralSpeed * tuning.mass * 0.25, -maxLateral, maxLateral);
      const slip = Math.abs(lateralSpeed) - Math.abs(lateralImpulse) / (tuning.mass * 0.25);
      this.wheelSlip[i] = Math.max(0, slip);

      const lv = _lv.copy(wheelRight).multiplyScalar(lateralImpulse);
      body.applyImpulseAtPoint({ x: lv.x, y: lv.y, z: lv.z }, { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z }, true);

      // --- drive / brake ------------------------------------------------
      let longImpulse = 0;
      const wantsReverse = this.throttle < -0.02;
      const movingForward = fwdSpeed > 0.6;

      if (w.driven && this.throttle > 0.02) {
        // Torque curve: soft off idle, peaky in the middle, dying at the top.
        const rr = THREE.MathUtils.clamp(absSpeed / tuning.topSpeed, 0, 1);
        const curve = (0.55 + 0.75 * rr - 0.55 * rr * rr) * (1 - rr * rr * rr);
        longImpulse = this.throttle * tuning.engineForce * curve * dt * 0.5;
      } else if (wantsReverse) {
        if (movingForward) {
          longImpulse = -tuning.brakeForce * dt * 0.5;
        } else if (w.driven && absSpeed < tuning.reverseSpeed) {
          longImpulse = this.throttle * tuning.engineForce * 0.42 * dt * 0.5;
        }
      } else if (Math.abs(this.throttle) <= 0.02) {
        // Engine braking — makes it feel weighty the moment you lift.
        longImpulse = -longitudinalSpeed * tuning.mass * 0.25 * 0.12 * dt;
      }

      if (this.handbrakeInput && w.handbraked) {
        longImpulse = -THREE.MathUtils.clamp(longitudinalSpeed, -1, 1) * tuning.handbrakeForce * dt * 0.5;
      }

      // Rolling resistance + aero. These are FORCES, so they must be scaled by
      // dt to become impulses; without that a car tops out at walking pace.
      const rollRes = longitudinalSpeed * tuning.mass * 0.25 * 0.025;
      const aero = Math.sign(longitudinalSpeed) * longitudinalSpeed * longitudinalSpeed * tuning.mass * 0.25 * 0.0016;
      longImpulse -= (rollRes + aero) * dt;

      const lgv = _lg.copy(wheelFwd).multiplyScalar(longImpulse);
      body.applyImpulseAtPoint({ x: lgv.x, y: lgv.y, z: lgv.z }, { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z }, true);

      this.wheelSpin[i] += (longitudinalSpeed / w.radius) * dt;
      if (this.handbrakeInput && w.handbraked) this.wheelSpin[i] += 0; // locked
      this.skidding[i] = this.wheelSlip[i] > 1.6 || (this.handbrakeInput && w.handbraked && absSpeed > 3);
    }

    this.airTime = groundedWheels === 0 ? this.airTime + dt : 0;

    // --- static friction -------------------------------------------------
    //
    // Rolling resistance is a viscous term: it scales with speed, so it can
    // never actually bring a body to rest — it only ever halves the remaining
    // creep. Combined with the suspension's sideways impulses on a road that is
    // never perfectly level, a parked car walked several metres down the street
    // on its own. Real tyres have stiction; below a threshold, with no throttle
    // and every wheel on the ground, this pins the car.
    this.parked = false;
    if (
      Math.abs(this.throttle) <= 0.02 && !this.handbrakeInput &&
      groundedWheels >= tuning.wheels.length - (tuning.wheels.length > 2 ? 1 : 0)
    ) {
      // Re-read the velocity: `lin` was sampled before this step's suspension
      // impulses, and writing that stale vertical component back would erase
      // every spring force the wheels just applied — the car then settles onto
      // its collider box with the wheels buried in the road.
      const cur = body.linvel();
      const planar = Math.hypot(cur.x, cur.z);
      if (planar < 0.55) {
        const av3 = body.angvel();
        const yaw = Math.abs(av3.y);
        // Only the PLANAR components may ever be touched here.
        if (planar < 0.05 && yaw < 0.06) {
          body.setLinvel({ x: 0, y: cur.y, z: 0 }, true);
          body.setAngvel({ x: av3.x, y: 0, z: av3.z }, true);
          this.parked = true;
        } else {
          const k = Math.min(1, dt * 16);
          body.setLinvel({ x: cur.x * (1 - k), y: cur.y, z: cur.z * (1 - k) }, true);
          body.setAngvel({ x: av3.x, y: av3.y * (1 - k), z: av3.z }, true);
        }
      }
    }

    // --- stability -------------------------------------------------------
    const uprightness = this._up.dot(UP);
    if (uprightness < 0.999) {
      // Restoring torque: gentle while planted, brutal once genuinely tipping.
      const strength = uprightness > 0.55 ? tuning.antiRoll : tuning.antiRoll * 3.4;
      const corrective = _corr.crossVectors(this._up, UP).multiplyScalar(tuning.mass * strength * dt);
      body.applyTorqueImpulse({ x: corrective.x, y: corrective.y, z: corrective.z }, true);
    }
    if (groundedWheels >= 2) {
      const df = -tuning.downforce * absSpeed * dt;
      body.applyImpulse({ x: 0, y: df, z: 0 }, true);
    }
    // Hard cap on roll rate so nothing can spin the car about its long axis.
    {
      const av = body.angvel();
      const rollRate = _av.set(av.x, av.y, av.z).dot(this._fwd);
      if (Math.abs(rollRate) > 2.2) {
        const excess = rollRate - Math.sign(rollRate) * 2.2;
        const damp = _corr.copy(this._fwd).multiplyScalar(-excess * tuning.mass * 0.06);
        body.applyTorqueImpulse({ x: damp.x, y: damp.y, z: damp.z }, true);
      }
    }

    /* --- rail vehicles are ON RAILS ------------------------------------
     *
     * A 15 m rigid box on suspension rays is a see-saw: a road crown, a kerb
     * or a Dacia under one corner pitched the tram, the pitch drove the nose
     * into the tarmac, and the reaction threw the whole thing into the air —
     * which is exactly the "trams jumping off the rails" report. A tram has no
     * suspension geometry that can do that: the bogies hold it square to the
     * permanent way. So we pin the attitude to yaw-only, kill any upward
     * velocity it did not get from the ground, and let the wheels only ever
     * hold it up.
     *
     * (Lateral position — whether it is ON the rails at all — is the traffic
     * system's routing, not ours. See the report.)
     */
    if (tuning.spec.railed) {
      _railE.setFromQuaternion(this.rotation, 'YXZ');
      _railQ.setFromAxisAngle(UP, _railE.y);
      body.setRotation({ x: _railQ.x, y: _railQ.y, z: _railQ.z, w: _railQ.w }, true);
      const av = body.angvel();
      body.setAngvel({ x: 0, y: av.y, z: 0 }, true);
      const lv = body.linvel();
      if (lv.y > 0) body.setLinvel({ x: lv.x, y: 0, z: lv.z }, true);
      this.rotation.copy(_railQ);
      this.object.quaternion.copy(_railQ);
      this.upsideTime = 0;
    }

    // Self-recovery: about a second on the roof and it flips itself back.
    if (uprightness < 0.1) {
      this.upsideTime += dt;
      if (this.upsideTime > 1.0) this.recover();
    } else {
      this.upsideTime = 0;
    }

    // --- accelerations used by the visual body -------------------------
    const av2 = body.angvel();
    const yawRate = _av.set(av2.x, av2.y, av2.z).dot(this._up);
    const targetLat = fwdSpeed * yawRate;
    this.latAccel += (targetLat - this.latAccel) * Math.min(1, dt * 8);
    const targetLong = (fwdSpeed - this.prevFwdSpeed) / dt;
    this.prevFwdSpeed = fwdSpeed;
    this.longAccel += (THREE.MathUtils.clamp(targetLong, -30, 30) - this.longAccel) * Math.min(1, dt * 7);
  }

  /* ---------------- presentation ---------------- */

  updateVisual(dt: number, near: boolean, skid: SkidmarkPool | null, parts: ParticlePool | null): void {
    const tuning = this.tuning;

    // Wheels ride the suspension; the body leans on top of them.
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const mesh = this.wheelMeshes[i];
      const w = tuning.wheels[i];
      const drop = tuning.suspensionRest * (1 - this.wheelCompression[i]);
      mesh.position.set(w.offset.x, w.offset.y - drop, w.offset.z);
      mesh.rotation.set(this.wheelSpin[i], w.steered ? this.steerAngle : 0, 0, 'YXZ');
    }

    // Exaggerated but purely cosmetic roll / squat / dive.
    const roll = THREE.MathUtils.clamp(this.latAccel * 0.0165 * tuning.rollGain, -0.15, 0.15);
    const pitch = THREE.MathUtils.clamp(-this.longAccel * 0.012 * tuning.pitchGain, -0.10, 0.10);
    const bg = this.bodyGroup;
    bg.rotation.z += (roll - bg.rotation.z) * Math.min(1, dt * 9);
    bg.rotation.x += (pitch - bg.rotation.x) * Math.min(1, dt * 9);
    let comp = 0;
    for (let i = 0; i < this.wheelCompression.length; i++) comp += this.wheelCompression[i];
    comp /= Math.max(1, this.wheelCompression.length);
    const targetY = (comp - 9.81 / tuning.suspensionStiffness) * tuning.suspensionRest * -0.55;
    bg.position.y += (targetY - bg.position.y) * Math.min(1, dt * 10);

    // Keep the contact shadow lying flat on the road no matter how the body is
    // pitched or rolled, and lift it away when the car leaves the ground.
    if (this.contactShadow) {
      _shadowE.setFromQuaternion(this.rotation, 'YXZ');
      _shadowQ.setFromAxisAngle(UP, _shadowE.y);
      _shadowInv.copy(this.rotation).invert();
      this.contactShadow.quaternion.copy(_shadowInv).multiply(_shadowQ).multiply(FLAT_Q);
      let grounded = 0;
      for (let i = 0; i < this.wheelContact.length; i++) if (this.wheelContact[i]) grounded++;
      const want = grounded / Math.max(1, this.wheelContact.length);
      this.contactShadow.visible = want > 0.1 && this.lodBand <= 1;
    }

    this.updateDoors(dt);

    // Filth: what the car came with, plus what the crashes added.
    this.uniforms.uGrime.value = Math.min(1, this.baseGrime + (1 - this.damage.ratio) * 0.55);

    // A driver is only visible when somebody is actually in there. Traffic and
    // police cars are always crewed; the player's parked car is not.
    if (this.driverMesh) {
      const crewed = this.occupants.length > 0 || this.faction !== 'player';
      this.driverMesh.visible = crewed && this.lodBand <= 2;
    }

    // Lamps.
    const braking = (this.throttle < -0.05 && this.speed > 0.4) || this.handbrakeInput;
    const s = this.lamps.state;
    s.head = this.headlightLevel;
    s.brake = braking ? 1 : 0;
    s.reverse = this.speed < -0.4 ? 1 : 0;
    s.interior = this.occupants.length > 0 ? 0.75 : 0.35;
    s.indicator = this.indicator;
    s.siren = this.siren;
    this.lamps.update(dt);

    if (!near || !skid || !parts) return;

    // Rubber and smoke.
    const speed = Math.abs(this.speed);
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      if (!this.wheelContact[i]) { this.lastSkid[i].set(0, 0, 0); continue; }
      const p = this.wheelPoint[i];
      const strength = THREE.MathUtils.clamp((this.wheelSlip[i] - 1.2) / 3.2, 0, 1);
      const locked = this.handbrakeInput && tuning.wheels[i].handbraked && speed > 2.5 ? 0.75 : 0;
      const total = Math.max(strength, locked);
      if (total <= 0.05) { this.lastSkid[i].set(0, 0, 0); continue; }
      const last = this.lastSkid[i];
      if (last.lengthSq() > 0 && last.distanceToSquared(p) > 0.012) {
        _sr.copy(this._right).setY(0).normalize();
        skid.segment(last, p, _sr, tuning.spec.tyreWidth * 1.25, total);
        last.copy(p);
      } else if (last.lengthSq() === 0) {
        last.copy(p);
      }
      if (total > 0.35 && Math.random() < 0.5) {
        parts.emit(
          _sp.set(p.x, p.y + 0.06, p.z),
          _sv.set((Math.random() - 0.5) * 1.4, 0.5 + Math.random() * 0.7, (Math.random() - 0.5) * 1.4),
          'smoke', 0.55 + total * 0.5, 1.5,
        );
      }
    }

    // Exhaust.
    this.exhaustTimer -= dt;
    if (this.exhaustTimer <= 0 && this.anchors.exhaust.length) {
      this.exhaustTimer = 0.055 + Math.random() * 0.06;
      const a = this.anchors.exhaust[0];
      _sp.copy(a).applyQuaternion(this.rotation).add(this.position);
      _sv.copy(this._fwd).multiplyScalar(-1.1 - Math.abs(this.throttle) * 2.2);
      _sv.y += 0.35;
      const puff = 0.16 + Math.abs(this.throttle) * 0.22;
      parts.emit(_sp, _sv, 'exhaust', puff, 1.05);
    }

    // Engine smoke once the car is beaten up.
    const smoke = this.damage.smoke;
    if (smoke > 0.02) {
      this.smokeTimer -= dt;
      if (this.smokeTimer <= 0) {
        this.smokeTimer = 0.07;
        _sp.set(0, tuning.spec.height * 0.35 - tuning.spec.rideHeight, tuning.spec.length * 0.32)
          .applyQuaternion(this.rotation).add(this.position);
        _sv.set((Math.random() - 0.5) * 0.6, 1.2 + smoke * 1.6, (Math.random() - 0.5) * 0.6);
        parts.emit(_sp, _sv, 'enginesmoke', 0.5 + smoke * 0.7, 1.9);
      }
    }
  }

  /**
   * Distance LOD. Shadow casting is the expensive part — with cascaded shadows
   * every caster is drawn once per cascade, so a car 200m away that casts a
   * shadow costs as much as the hero car in front of the camera.
   */
  applyLod(distance: number): void {
    const band = distance < 26 ? 0 : distance < 70 ? 1 : distance < 130 ? 2 : 3;
    if (band === this.lodBand) return;
    this.lodBand = band;
    this.shellMesh.castShadow = band <= 1;
    this.shellMesh.receiveShadow = band === 0;
    // Shadow casting is the LOD, NOT visibility — a wheel that vanishes from
    // the main pass turns the car into a tricycle.
    for (const w of this.wheelMeshes) {
      w.castShadow = band === 0;
      w.visible = true;
    }
    // Glass stays on at every distance; a car with holes for windows at 140 m
    // is far more obvious than the cost of six extra transparent triangles.
    if (this.glassMesh) this.glassMesh.visible = true;
  }

  bindAudio(ctx: GameContext): void {
    if (this.engineBound) return;
    const audio = ctx.tryGet(Services.Audio);
    if (!audio) return;
    audio.bindEngine(this.id, this.object);
    this.engineBound = true;
  }

  unbindAudio(ctx: GameContext): void {
    if (!this.engineBound) return;
    ctx.tryGet(Services.Audio)?.unbindEngine(this.id);
    this.engineBound = false;
  }
}

/* scratch vectors shared by the simulation loop */
const _wf = new THREE.Vector3();
const _wr = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _av = new THREE.Vector3();
const _lv = new THREE.Vector3();
const _lg = new THREE.Vector3();
const _corr = new THREE.Vector3();
const _sr = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _local = new THREE.Vector3();
const _invQ = new THREE.Quaternion();
const _shadowE = new THREE.Euler();
const _shadowQ = new THREE.Quaternion();
const _shadowInv = new THREE.Quaternion();
const _railE = new THREE.Euler();
const _railQ = new THREE.Quaternion();
const FLAT_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export class VehicleSystem implements System, VehicleService {
  readonly name = 'vehicles';
  readonly order = 110;

  private vehicles = new Map<string, Vehicle>();
  private list: Vehicle[] = [];
  private byCollider = new Map<number, Vehicle>();
  private phys!: PhysicsWorld;
  private ctx!: GameContext;
  private nextId = 1;
  private atlas!: THREE.Texture;
  private lightPool!: VehicleLightPool;
  private skid: SkidmarkPool | null = null;
  private parts: ParticlePool | null = null;
  private rng = new Rng('vehicles');
  private drawDistance = 260;
  private nightFactor = 1;
  private wantShowcase = false;
  private wantHarness = false;
  /** Walking position for `__VEH__.stage`, so a staged fleet never overlaps. */
  private stageCursor = 0;
  /** Ids staged by the debug helpers, so they can be cleared without touching traffic. */
  private staged: string[] = [];

  /**
   * Spawn a specific MODEL. The class/variant indirection exists for traffic;
   * the showroom helpers want a named car, so this searches for the variant
   * that resolves to it.
   */
  private stageModel(modelId: string, pos: THREE.Vector3, heading: number): Vehicle {
    const m = MODELS[modelId];
    const list = CLASS_MODELS[m.cls];
    let variant = list.indexOf(modelId);
    if (variant < 0) variant = 0;
    // Offset by one full cycle so the paint rng differs from the traffic default.
    const seed = variant + list.length;
    const v = this.spawn(m.cls, pos, heading, {
      faction: modelId === 'ministry' ? 'police' : 'civilian',
      colorSeed: seed,
    }) as Vehicle;
    this.staged.push(v.id);
    return v;
  }

  private unstage(): void {
    for (const id of this.staged) this.despawn(id);
    this.staged.length = 0;
    this.stageCursor = 0;
  }

  get all(): ReadonlyArray<VehicleHandle> {
    return this.list;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    this.atlas = vehicleAtlas();
    const quality = ctx.tryGet(Services.Render)?.quality ?? 'high';
    this.lightPool = new VehicleLightPool(ctx.scene, quality);
    this.skid = new SkidmarkPool(ctx.scene, quality === 'low' ? 320 : 900);
    this.parts = new ParticlePool(ctx.scene, quality === 'low' ? 300 : 900);
    this.drawDistance = quality === 'low' ? 110 : quality === 'medium' ? 170 : quality === 'high' ? 240 : 330;
    ctx.provide(Services.Vehicles, this);

    const params = new URLSearchParams(location.search);
    this.wantShowcase = params.has('vehshow');
    this.wantHarness = params.has('vehtest');

    // Small automation surface for bodywork/handling iteration. Additive only —
    // it never replaces anything on window.__GTA_DEBUG__.
    (window as unknown as { __VEH__: unknown }).__VEH__ = {
      list: () => this.list.map((v) => ({
        id: v.id, kind: v.kind, model: v.model.id,
        pos: [v.position.x, v.position.y, v.position.z],
        speed: +v.speed.toFixed(2),
        health: v.health,
        grounded: v.wheelContact.filter(Boolean).length,
        comp: v.wheelCompression.map((c) => +c.toFixed(2)),
        throttle: v.throttle,
        heading: +new THREE.Euler().setFromQuaternion(v.rotation, 'YXZ').y.toFixed(3),
      })),
      controls: (id: string, throttle: number, steer: number, handbrake = false) =>
        this.vehicles.get(id)?.setControls(throttle, steer, handbrake),
      lights: (id: string, o: { head?: number; indicator?: -1 | 0 | 1 | 2; siren?: boolean }) => {
        const v = this.vehicles.get(id);
        if (!v) return;
        if (o.head !== undefined) v.setHeadlights(o.head);
        if (o.indicator !== undefined) v.setIndicator(o.indicator);
        if (o.siren !== undefined) v.setSiren(o.siren);
      },
      hit: (id: string, impulse: number) => {
        const v = this.vehicles.get(id);
        if (!v) return;
        v.damage.impact(new THREE.Vector3(v.tuning.halfExtents.x, 0, 0.9), impulse + v.crashThreshold, v.crashThreshold);
      },
      spawn: (kind: VehicleClass, x: number, z: number, heading = 0, seed = 1) =>
        this.spawn(kind, new THREE.Vector3(x, 0.4, z), heading, { colorSeed: seed }).id,
      showcase: () => this.showcase(),
      models: () => Object.values(MODELS).map((m) => ({
        id: m.id, cls: m.cls, label: m.label,
        size: [m.spec.length, m.spec.width, m.spec.height],
      })),
      bodyStats: () => cachedBodyStats(),
      doors: (id: string) => {
        const v = this.vehicles.get(id);
        return v ? v.doors.map((d) => ({ id: d.part.id, open: +d.open.toFixed(2), target: d.target })) : null;
      },
      openDoor: (id: string, door: string, amount = 1) => this.vehicles.get(id)?.setDoorOpen(door, amount),
      /**
       * Stage one of EVERY model down the nearest road, in a fixed order, so a
       * screenshot pass covers the whole fleet.
       */
      fleet: (only?: string) => {
        const out: Array<{ id: string; model: string; heading: number }> = [];
        for (const m of Object.values(MODELS)) {
          if (only && m.id !== only) continue;
          const gap = m.spec.length * 0.5 + 4;
          const along = this.stageCursor + gap;
          this.stageCursor = along + gap;
          const { pos, heading } = this.roadSlot(along);
          const v = this.stageModel(m.id, pos, heading);
          out.push({ id: v.id, model: v.model.id, heading });
        }
        return out;
      },
      /** One named model on the nearest clear road slot; previous ones removed. */
      only: (modelId: string, offset = 0) => {
        this.unstage();
        const m = MODELS[modelId];
        if (!m) return null;
        const { pos, heading } = this.roadSlot(offset);
        const v = this.stageModel(m.id, pos, heading);
        return { id: v.id, model: v.model.id, heading };
      },
      unstage: () => this.unstage(),
      /**
       * Put one vehicle of `kind` on a clear road node, aligned with the road.
       *
       * Successive calls automatically walk down the road by the length of what
       * has already been staged (plus a 3 m gap). Staging a fleet used to drop
       * every vehicle on the same node, which produced a pile-up that then
       * ground itself to scrap.
       */
      stage: (kind: VehicleClass, sideOffset?: number) => {
        const gap = SPECS[kind].length * 0.5 + 3;
        const along = sideOffset ?? this.stageCursor + gap;
        this.stageCursor = along + gap;
        const { pos, heading } = this.roadSlot(along);
        const v = this.spawn(kind, pos, heading, {
          faction: kind === 'dacia' ? 'player' : 'civilian',
          colorSeed: kind === 'dacia' ? 0 : 3,
        }) as Vehicle;
        return { id: v.id, heading };
      },
      clear: () => {
        for (const v of [...this.list]) this.despawn(v.id);
        this.stageCursor = 0;
      },
    };
  }

  /* ---------------- spawning ---------------- */

  spawn(
    kind: VehicleClass,
    position: THREE.Vector3,
    headingRad: number,
    opts?: { colorSeed?: number; faction?: Faction },
  ): VehicleHandle {
    const id = `veh_${this.nextId++}`;
    const faction = opts?.faction ?? (kind === 'police' ? 'police' : 'civilian');
    const colorSeed = opts?.colorSeed ?? this.rng.int(0, 4096);
    const hero = kind === 'dacia' && (faction === 'player' || colorSeed === 0);
    const variant = hero ? 0 : colorSeed % VARIANTS[kind];
    const v = new Vehicle(id, kind, faction, this.phys, modelFor(kind, variant, hero));
    const tuning = v.tuning;

    const q = new THREE.Quaternion().setFromAxisAngle(UP, headingRad);
    const bodyDesc = this.phys.rapier.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y + tuning.spec.rideHeight + 0.05, position.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.05)
      .setAngularDamping(1.9)
      .setCcdEnabled(true);
    v.body = this.phys.world.createRigidBody(bodyDesc);

    // The collider contributes NO mass — everything comes from the explicit
    // mass properties below, otherwise Rapier adds the two together and the
    // car ends up at twice its intended weight (and sits on its bump stops).
    const cDesc = this.phys.rapier.ColliderDesc
      .cuboid(tuning.halfExtents.x, tuning.halfExtents.y, tuning.halfExtents.z)
      .setTranslation(0, tuning.colliderCentreY, 0)
      .setCollisionGroups(GROUP.vehicle)
      .setMass(0)
      .setFriction(0.5)
      .setRestitution(0.06)
      .setActiveEvents(this.phys.rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(v.crashThreshold);
    v.collider = this.phys.world.createCollider(cDesc, v.body);
    this.byCollider.set(v.collider.handle, v);

    v.body.setAdditionalMassProperties(
      tuning.mass,
      { x: tuning.comOffset.x, y: tuning.comOffset.y, z: tuning.comOffset.z },
      {
        x: tuning.mass * 0.34,
        y: tuning.mass * 0.46,
        z: tuning.mass * 0.16,
      },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.buildMesh(v, variant, hero);
    this.ctx.scene.add(v.object);

    this.vehicles.set(id, v);
    this.list.push(v);
    return v;
  }

  private buildMesh(v: Vehicle, variant: number, hero: boolean): void {
    const build = buildBody(v.kind, variant, hero);
    v.anchors = build.anchors;
    // Every car in this city has been standing in the same wet street.
    v.baseGrime = hero ? 0.26 : new Rng(`grime-${v.kind}-${variant}`).range(0.04, 0.28);

    const opaque = createCarMaterial(this.atlas, v.uniforms, { alphaTest: 0.4 });
    const glassMat = createCarMaterial(this.atlas, v.uniforms, {
      transparent: true, opacity: 0.72, side: THREE.DoubleSide, glass: true,
    });
    glassMat.envMapIntensity = 3.0;

    let shellGeo = build.shell;
    if (hero) {
      // The hero car is already battered before you ever touch it.
      shellGeo = build.shell.clone();
      deform(shellGeo, heroDents(new Rng('hero-dents')));
    }

    const shell = new THREE.Mesh(shellGeo, opaque);
    shell.castShadow = true;
    shell.receiveShadow = true;
    v.shellMesh = shell;
    v.bodyGroup.add(shell);

    if ((build.glass.attributes.position as THREE.BufferAttribute).count > 0) {
      const glass = new THREE.Mesh(build.glass, glassMat);
      glass.castShadow = false;
      glass.receiveShadow = false;
      glass.renderOrder = 3;
      v.glassMesh = glass;
      v.bodyGroup.add(glass);
    }

    // Doors: one group per door, pivoted on the hinge, carrying the skin that
    // was routed out of the body loft plus that door's own glass.
    for (const part of build.doors ?? []) {
      const group = new THREE.Group();
      group.position.copy(part.hinge);
      let doorGeo = part.shell;
      if (hero) {
        // The baked-in hero damage has to reach the doors too, or the car has
        // pristine panels bolted into a dented shell.
        doorGeo = part.shell.clone();
        const local = heroDents(new Rng('hero-dents')).map((dn) => ({
          p: dn.p.clone().sub(part.hinge), r: dn.r, d: dn.d,
        }));
        deform(doorGeo, local);
      }
      const skin = new THREE.Mesh(doorGeo, opaque);
      skin.castShadow = true;
      skin.receiveShadow = true;
      group.add(skin);
      if ((part.glass.attributes.position as THREE.BufferAttribute).count > 0) {
        const dg = new THREE.Mesh(part.glass, glassMat);
        dg.renderOrder = 3;
        group.add(dg);
      }
      v.bodyGroup.add(group);
      v.doors.push({ part, group, open: 0, target: 0, autoClose: true });
    }

    if (build.driver && (build.driver.attributes.position as THREE.BufferAttribute).count > 0) {
      const dm = new THREE.Mesh(build.driver, opaque);
      dm.castShadow = false;
      dm.receiveShadow = false;
      dm.visible = false;
      v.driverMesh = dm;
      v.bodyGroup.add(dm);
    }

    const spec = v.tuning.spec;
    // Two geometries per class: the rim detail has to face outboard on both
    // sides or every wheel on the left presents a blank black disc.
    const wheelGeoR = wheelGeometry(spec.wheelStyle, spec.wheelRadius, spec.tyreWidth, 1);
    const wheelGeoL = wheelGeometry(spec.wheelStyle, spec.wheelRadius, spec.tyreWidth, -1);
    const wheelMat = createCarMaterial(this.atlas, v.uniforms, { alphaTest: 0 });
    for (const w of v.tuning.wheels) {
      const mesh = new THREE.Mesh(w.offset.x < 0 ? wheelGeoL : wheelGeoR, wheelMat);
      mesh.position.copy(w.offset);
      mesh.castShadow = true;
      v.object.add(mesh);
      v.wheelMeshes.push(mesh);
    }

    // Contact shadow: one ground decal per vehicle, shared geometry+material.
    // Without it every car in a mirror-bright wet lane visibly floats.
    {
      const cs = contactShadowAssets();
      const decal = new THREE.Mesh(cs.geo, cs.mat);
      decal.rotation.x = -Math.PI / 2;
      decal.scale.set(spec.width * 1.85, spec.length * 1.24, 1);
      decal.position.y = -spec.rideHeight + 0.015;
      decal.renderOrder = 1;
      decal.castShadow = false;
      decal.receiveShadow = false;
      v.object.add(decal);
      v.contactShadow = decal;
    }

    v.lamps = new VehicleLamps(v.uniforms, v.kind === 'police');
  }

  despawn(id: string): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    v.unbindAudio(this.ctx);
    this.ctx.scene.remove(v.object);
    this.byCollider.delete(v.collider.handle);
    this.phys.world.removeRigidBody(v.body);
    v.damage.dispose();
    this.vehicles.delete(id);
    const i = this.list.indexOf(v);
    if (i >= 0) this.list.splice(i, 1);
  }

  get(id: string): VehicleHandle | undefined {
    return this.vehicles.get(id);
  }

  nearestEnterable(p: THREE.Vector3, radius: number): VehicleHandle | undefined {
    let best: Vehicle | undefined;
    let bestD = radius * radius;
    for (const v of this.list) {
      if (v.occupants.length >= v.seats || v.isWrecked) continue;
      const d = v.position.distanceToSquared(p);
      if (d < bestD) { bestD = d; best = v; }
    }
    return best;
  }

  /* ---------------- frame ---------------- */

  fixedUpdate(dt: number): void {
    if (this.harness) this.runHarness(dt);
    for (const v of this.list) {
      v.simulate(dt);
      // Stuck rescue: a vehicle that has had no wheel on anything for four
      // seconds has fallen off geometry somewhere. Left alone it grinds down a
      // wall taking contact damage until it is scrap. Put it back on a road.
      if (v.airTime > 4 && v.occupants.length === 0) {
        const { pos, heading } = this.roadSlot(this.rng.range(-30, 30));
        v.teleport(pos, heading);
        v.airTime = 0;
      }
    }
    this.drainCollisions();
  }

  /**
   * In-simulation handling harness (`?vehtest=1`). Runs on the fixed step, so
   * the numbers are frame-rate independent and reproducible: 0-100 time, top
   * speed, steady-state cornering, handbrake yaw rate, braking distance and
   * roll-over recovery all land in `window.__VEHTEST__`.
   */
  private harness: { t: number; car: Vehicle; log: number[][]; done: boolean } | null = null;

  private runHarness(dt: number): void {
    const h = this.harness!;
    h.t += dt;
    const t = h.t;
    const v = h.car;

    if (t < 18) v.setControls(1, 0, false);
    else if (t < 22) v.setControls(1, 0.8, false);
    else if (t < 26) v.setControls(0.35, 1, true);
    else if (t < 29) v.setControls(-1, 0, false);
    else if (t < 29.05) {
      // Kick it onto its roof to time the self-recovery.
      v.body.applyTorqueImpulse({ x: 0, y: 0, z: v.tuning.mass * 2.6 }, true);
      v.body.applyImpulse({ x: 0, y: v.tuning.mass * 1.6, z: 0 }, true);
      v.setControls(0, 0, false);
    } else v.setControls(0, 0, false);

    if (h.log.length < t * 4) {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.rotation);
      const av = v.body.angvel();
      h.log.push([
        +t.toFixed(2), +v.speed.toFixed(2), +av.y.toFixed(2),
        +up.y.toFixed(2), +v.position.y.toFixed(2), v.wheelContact.filter(Boolean).length,
      ]);
    }
    if (t > 34 && !h.done) {
      h.done = true;
      (window as unknown as { __VEHTEST__: unknown }).__VEHTEST__ = {
        done: true,
        log: h.log,
        topSpeed: Math.max(...h.log.map((r) => r[1])),
        zeroTo50kmh: (h.log.find((r) => r[1] > 13.9) ?? [-1])[0],
        zeroTo100kmh: (h.log.find((r) => r[1] > 27.8) ?? [-1])[0],
      };
    }
  }

  private drainCollisions(): void {
    this.phys.drainContactForceEvents((event) => {
      const magnitude = event.totalForceMagnitude();
      const a = this.byCollider.get(event.collider1());
      const b = this.byCollider.get(event.collider2());
      const dir = event.maxForceDirection();
      for (const v of [a, b]) {
        if (!v || !v.settled) continue;
        // A 26 tonne tram is not damaged by a Dacia, and it certainly is not
        // damaged by the road it is standing on.
        if (v.tuning.spec.railed) continue;
        if (magnitude < v.crashThreshold) continue;
        const other = v === a ? b : a;
        // Damage needs a genuine impact, which means RELATIVE motion. Grading
        // on absolute speed meant a stationary vehicle wedged against a kerb
        // kept registering its own resting weight as a crash and ground itself
        // to scrap. A parked car is never in a collision.
        if (v.parked) continue;
        const lv = v.body.linvel();
        // Against a static collider (kerb, wall, prop) the only thing that can
        // constitute an impact is this vehicle's own CURRENT speed. Using the
        // decaying peak let a vehicle that had merely arrived somewhere keep
        // taking hits from the surface it was resting on.
        if (Math.hypot(lv.x, lv.y, lv.z) < (other ? 2.0 : 4.0)) continue;
        const closing = other
          ? _relVel.set(
              lv.x - other.body.linvel().x,
              lv.y - other.body.linvel().y,
              lv.z - other.body.linvel().z,
            ).length()
          : v.recentSpeed;
        if (closing < 2.4) continue;
        // Approximate the impact point: walk out along the contact normal to
        // the surface of the body box.
        _invQ.copy(v.rotation).invert();
        _local.set(dir.x, dir.y, dir.z).applyQuaternion(_invQ).normalize();
        const he = v.tuning.halfExtents;
        const sc = Math.min(
          he.x / Math.max(0.05, Math.abs(_local.x)),
          Math.min(he.y / Math.max(0.05, Math.abs(_local.y)), he.z / Math.max(0.05, Math.abs(_local.z))),
        );
        _local.multiplyScalar(-sc);
        _local.y += v.tuning.colliderCentreY;

        const before = v.health;
        const dealt = v.damage.impact(_local, magnitude, v.crashThreshold, v.occupants.length ? 1 : 0.8);
        if (dealt > 0) {
          this.ctx.events.emit('vehicle:collision', {
            vehicleId: v.id,
            impulse: magnitude,
            position: v.position.clone(),
          });
          if (this.parts && dealt > 30) {
            _sp.copy(_local).applyQuaternion(v.rotation).add(v.position);
            for (let s = 0; s < 6; s++) {
              _sv.set((Math.random() - 0.5) * 6, Math.random() * 4 + 1, (Math.random() - 0.5) * 6);
              this.parts.emit(_sp, _sv, 'spark', 0.10, 0.45);
            }
          }
          if (before > 0 && v.health <= 0) {
            this.ctx.events.emit('vehicle:destroyed', { vehicleId: v.id });
          }
        }
      }
    });
  }

  update(dt: number, ctx: GameContext): void {
    if (this.wantShowcase) {
      this.wantShowcase = false;
      this.showcase();
    }
    if (this.wantHarness) {
      this.wantHarness = false;
      // Line the test car up along an actual road link so it has a clear run.
      const city = ctx.tryGet(Services.City);
      const p = ctx.tryGet(Services.Player)?.position ?? new THREE.Vector3();
      let base = p.clone();
      let heading = 0;
      if (city) {
        const id = city.nearestNode(p);
        const node = city.roadNodes[id];
        if (node) {
          const link = node.links.map((l) => city.roadNodes[l]).find((n) => !!n);
          base = node.position.clone();
          if (link) {
            const dx = link.position.x - node.position.x;
            const dz = link.position.z - node.position.z;
            heading = Math.atan2(dx, dz);
            base.addScaledVector(new THREE.Vector3(dx, 0, dz).normalize(), -6);
          }
        }
      }
      const car = this.spawn('dacia', new THREE.Vector3(base.x, 0.4, base.z), heading, {
        faction: 'player', colorSeed: 0,
      }) as Vehicle;
      this.harness = { t: 0, car, log: [], done: false };
      (window as unknown as { __VEHTEST__: unknown }).__VEHTEST__ = { done: false, log: [] };
    }
    const camPos = ctx.camera.position;
    const weather = ctx.tryGet(Services.Weather);
    // Headlights come on at dusk — which, in this city, is always.
    const hour = weather?.timeOfDay ?? 19.4;
    const night = hour > 17.2 || hour < 7.6 ? 1 : 0.12;
    this.nightFactor = night;
    const wanted = ctx.tryGet(Services.Wanted);
    const chasing = (wanted?.stars ?? 0) > 0;

    for (const v of this.list) {
      v.distanceToCamera = v.position.distanceTo(camPos);
      const visible = v.distanceToCamera < this.drawDistance;
      if (v.object.visible !== visible) v.object.visible = visible;
      if (!visible) continue;

      if (v.kind === 'scooter' || v.kind === 'tram') v.setHeadlights(night > 0.5 ? 1 : 0.2);
      else v.setHeadlights(night);
      if (v.kind === 'police') v.setSiren(chasing);

      v.applyLod(v.distanceToCamera);
      const near = v.distanceToCamera < 90;
      v.updateVisual(dt, near, near ? this.skid : null, near ? this.parts : null);
      v.damage.flush(v.shellMesh, dt);
      if (v.occupants.length) v.bindAudio(ctx);
    }

    this.skid?.update(dt);
    this.parts?.update(dt, ctx.renderer.domElement.clientHeight || 1080);
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    // Hand the small pool of real lights to whatever is closest to the camera.
    this.lightPool.begin();
    for (const v of this.list) {
      if (!v.object.visible || v.distanceToCamera > 120) continue;
      const headOn = v.lamps.state.head;
      const brake = v.lamps.state.brake;
      const siren = v.lamps.state.siren;
      if (headOn < 0.05 && brake < 0.5 && siren < 0.5) continue;
      this.lightPool.request({
        position: v.position,
        quaternion: v.rotation,
        anchors: v.anchors.headlights,
        intensity: headOn,
        groundY: v.position.y - v.tuning.spec.rideHeight,
        distance: v.distanceToCamera,
        point: brake > 0.5 || siren > 0.5
          ? {
              colour: siren > 0.5 ? _sirenCol : _brakeCol,
              intensity: siren > 0.5 ? 6 : 2.4,
              position: _pointPos.copy(v.anchors.taillights[0] ?? _zero)
                .setX(0)
                .applyQuaternion(v.rotation)
                .add(v.position)
                .clone(),
              range: siren > 0.5 ? 14 : 8,
            }
          : undefined,
      });
    }
    this.lightPool.end();
    void ctx;
  }

  /* ---------------- debug showroom ---------------- */

  /**
   * A point on the nearest road, aligned with the road direction.
   *
   * The slot is validated before it is handed back: walking blindly down the
   * road tangent for tens of metres runs off the end of the link and drops
   * vehicles onto pavements, into buildings or into thin air, where they take
   * damage until they die. The point is snapped back onto the road graph,
   * rejected if it lands inside a blocker, and lifted to the real ground
   * height rather than a hardcoded 0.5.
   */
  private roadSlot(along = 0): { pos: THREE.Vector3; heading: number } {
    const city = this.ctx.tryGet(Services.City);
    const p = this.ctx.tryGet(Services.Player)?.position ?? new THREE.Vector3();
    const pos = p.clone();
    let heading = 0;
    if (city) {
      let node = city.roadNodes[city.nearestNode(p)];
      if (node) {
        pos.copy(node.position);
        // Walk the road GRAPH, not a single tangent. Extrapolating one link's
        // direction for 80 m runs straight off the end of that link and puts
        // long vehicles on the pavement or in a building.
        let remaining = 14 + along;
        let prev = -1;
        const dir = new THREE.Vector3();
        for (let hop = 0; hop < 24 && remaining > 0; hop++) {
          const next = node.links
            .map((l) => ({ id: l, n: city.roadNodes[l] }))
            .find((c) => !!c.n && c.id !== prev);
          if (!next || !next.n) break;
          dir.subVectors(next.n.position, node.position).setY(0);
          const seg = dir.length();
          if (seg < 1e-3) break;
          dir.divideScalar(seg);
          heading = Math.atan2(dir.x, dir.z);
          const step = Math.min(remaining, seg - 4);
          if (step > 0) pos.addScaledVector(dir, step);
          remaining -= step;
          if (remaining <= 0) break;
          prev = city.roadNodes.indexOf(node);
          pos.copy(next.n.position);
          node = next.n;
        }
      }
      // Reject a blocked slot by walking back toward the node until it clears.
      // (Do NOT snapToRoad here: it collapses onto the nearest centreline point
      // and stacks every staged vehicle on top of the previous one.)
      if (node) {
        const dir = new THREE.Vector3().subVectors(pos, node.position).setY(0);
        const dist = dir.length();
        if (dist > 1e-3) {
          dir.divideScalar(dist);
          for (let step = 0; step < 8 && city.spatial.isBlocked(pos.x, pos.z); step++) {
            pos.addScaledVector(dir, -Math.max(2, dist / 8));
          }
        }
      }
      // Drop from just above the real ground rather than a hardcoded 0.5, which
      // is under the road in the raised districts and 0.5 m in the air elsewhere.
      const gh = city.spatial.groundHeight(pos.x, pos.z);
      pos.y = (Number.isFinite(gh) ? gh : 0) + 0.35;
    } else {
      pos.y = 0.5;
    }
    return { pos, heading };
  }

  private showcase(): void {
    const kinds: VehicleClass[] = ['dacia', 'sedan', 'hatch', 'police', 'van', 'truck', 'bus', 'tram', 'scooter'];
    const player = this.ctx.tryGet(Services.Player);
    const origin = player ? player.position.clone() : new THREE.Vector3();
    // Lay the line-up down the middle of the nearest road so nothing spawns
    // inside a building.
    const road = new THREE.Vector3();
    this.ctx.tryGet(Services.City)?.spatial.snapToRoad(origin, road);
    const base = road.lengthSq() > 0 ? road : origin;
    let z = 0;
    for (const k of kinds) {
      z += SPECS[k].length * 0.5 + 2.0;
      this.spawn(k, new THREE.Vector3(base.x, 0.4, base.z + z), 0, {
        faction: k === 'dacia' ? 'player' : 'civilian',
        colorSeed: 3,
      });
      z += SPECS[k].length * 0.5;
    }
  }

  dispose(): void {
    this.skid?.dispose();
    this.parts?.dispose();
    this.lightPool?.dispose();
  }
}

const _brakeCol = new THREE.Color(0xff2a20);
const _sirenCol = new THREE.Color(0x3a6cff);
const _pointPos = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _relVel = new THREE.Vector3();
