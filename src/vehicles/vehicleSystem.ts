/**
 * Raycast-vehicle driving.
 *
 * OWNER: vehicle agent. Baseline delivers a working 4-wheel raycast car with
 * suspension, weight transfer, slip-based grip, handbrake, and a placeholder
 * body. The vehicle agent must deliver: a real Dacia 1300 silhouette
 * (battered yellow/purple), per-class handling, damage deformation, working
 * lights/brake lights/indicators, skidmarks, exhaust, engine audio hooks,
 * and the other traffic classes.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, System } from '../core/engine';
import { CG, GROUP, PhysicsWorld, groups } from '../physics/physics';
import { Palette } from '../artDirection';
import {
  Services,
  type Faction,
  type VehicleClass,
  type VehicleHandle,
  type VehicleService,
} from '../core/services';

interface WheelSpec {
  /** Local-space attachment point of the suspension. */
  offset: THREE.Vector3;
  radius: number;
  steered: boolean;
  driven: boolean;
  handbraked: boolean;
}

export interface VehicleTuning {
  mass: number;
  /** Half-extents of the collision box. */
  halfExtents: THREE.Vector3;
  /** Centre of mass offset — lower = more stable. */
  comOffset: THREE.Vector3;
  suspensionRest: number;
  suspensionStiffness: number;
  suspensionDamping: number;
  maxSuspensionTravel: number;
  engineForce: number;
  brakeForce: number;
  handbrakeForce: number;
  maxSteerRad: number;
  /** Steering falls off with speed for stability. */
  steerSpeedFalloff: number;
  /** Lateral grip coefficient per wheel. */
  gripFront: number;
  gripRear: number;
  topSpeed: number;
  downforce: number;
  wheels: WheelSpec[];
}

const DACIA_TUNING: VehicleTuning = {
  mass: 980,
  halfExtents: new THREE.Vector3(0.82, 0.52, 2.02),
  comOffset: new THREE.Vector3(0, -0.34, 0.06),
  suspensionRest: 0.46,
  suspensionStiffness: 30,
  suspensionDamping: 3.6,
  maxSuspensionTravel: 0.28,
  engineForce: 7400,
  brakeForce: 5200,
  handbrakeForce: 8200,
  maxSteerRad: 0.56,
  steerSpeedFalloff: 0.045,
  gripFront: 5.4,
  gripRear: 4.7,
  topSpeed: 41, // m/s ~ 148 km/h; the Dacia is not fast
  downforce: 8,
  wheels: [
    { offset: new THREE.Vector3(-0.76, -0.24, 1.32), radius: 0.32, steered: true, driven: false, handbraked: false },
    { offset: new THREE.Vector3(0.76, -0.24, 1.32), radius: 0.32, steered: true, driven: false, handbraked: false },
    { offset: new THREE.Vector3(-0.76, -0.24, -1.28), radius: 0.32, steered: false, driven: true, handbraked: true },
    { offset: new THREE.Vector3(0.76, -0.24, -1.28), radius: 0.32, steered: false, driven: true, handbraked: true },
  ],
};

const TUNING: Record<VehicleClass, VehicleTuning> = {
  dacia: DACIA_TUNING,
  sedan: { ...DACIA_TUNING, mass: 1250, engineForce: 9200, topSpeed: 48, gripFront: 6.0, gripRear: 5.4 },
  hatch: { ...DACIA_TUNING, mass: 1050, engineForce: 8200, topSpeed: 45 },
  van: { ...DACIA_TUNING, mass: 1900, engineForce: 11000, topSpeed: 40, halfExtents: new THREE.Vector3(0.95, 0.85, 2.5) },
  truck: { ...DACIA_TUNING, mass: 4200, engineForce: 20000, topSpeed: 32, halfExtents: new THREE.Vector3(1.15, 1.2, 3.6) },
  bus: { ...DACIA_TUNING, mass: 8000, engineForce: 30000, topSpeed: 28, halfExtents: new THREE.Vector3(1.3, 1.5, 5.5) },
  police: { ...DACIA_TUNING, mass: 1350, engineForce: 12500, topSpeed: 54, gripFront: 6.6, gripRear: 6.0 },
  tram: { ...DACIA_TUNING, mass: 20000, engineForce: 40000, topSpeed: 18, halfExtents: new THREE.Vector3(1.3, 1.7, 8) },
  scooter: { ...DACIA_TUNING, mass: 120, engineForce: 900, topSpeed: 12, halfExtents: new THREE.Vector3(0.25, 0.4, 0.6) },
};

const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

class Vehicle implements VehicleHandle {
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly rotation = new THREE.Quaternion();
  readonly occupants: string[] = [];

  body!: RAPIER.RigidBody;
  collider!: RAPIER.Collider;
  tuning: VehicleTuning;

  health = 1000;
  readonly maxHealth = 1000;
  seats = 4;

  throttle = 0;
  steerInput = 0;
  handbrakeInput = false;
  steerAngle = 0;

  wheelMeshes: THREE.Object3D[] = [];
  wheelContact: boolean[] = [];
  wheelCompression: number[] = [];
  wheelSpin: number[] = [];
  /** Lateral slip per wheel, used for tyre squeal + skidmarks. */
  wheelSlip: number[] = [];

  private _fwd = new THREE.Vector3();
  private _right = new THREE.Vector3();
  private _up = new THREE.Vector3();
  private _tmp = new THREE.Vector3();
  private _tmp2 = new THREE.Vector3();

  constructor(
    readonly id: string,
    readonly kind: VehicleClass,
    readonly faction: Faction,
    private phys: PhysicsWorld,
  ) {
    this.tuning = TUNING[kind];
    this.wheelContact = this.tuning.wheels.map(() => false);
    this.wheelCompression = this.tuning.wheels.map(() => 0);
    this.wheelSpin = this.tuning.wheels.map(() => 0);
    this.wheelSlip = this.tuning.wheels.map(() => 0);
  }

  get speed(): number {
    const v = this.body.linvel();
    this.object.getWorldDirection(this._fwd);
    return this._tmp.set(v.x, v.y, v.z).dot(this._fwd);
  }

  get isWrecked(): boolean {
    return this.health <= 0;
  }

  setControls(throttle: number, steer: number, handbrake: boolean): void {
    this.throttle = THREE.MathUtils.clamp(throttle, -1, 1);
    this.steerInput = THREE.MathUtils.clamp(steer, -1, 1);
    this.handbrakeInput = handbrake;
  }

  applyDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
  }

  teleport(position: THREE.Vector3, headingRad: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, headingRad);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  recover(): void {
    const t = this.body.translation();
    const e = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(this.body.rotation().x, this.body.rotation().y, this.body.rotation().z, this.body.rotation().w),
      'YXZ',
    );
    this.teleport(new THREE.Vector3(t.x, t.y + 1.2, t.z), e.y);
  }

  /** Called from the vehicle system's fixed update. */
  simulate(dt: number): void {
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

    // Speed-sensitive steering.
    const steerLimit = tuning.maxSteerRad / (1 + absSpeed * tuning.steerSpeedFalloff);
    const targetSteer = this.steerInput * steerLimit;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * 9);

    let groundedWheels = 0;

    for (let i = 0; i < tuning.wheels.length; i++) {
      const w = tuning.wheels[i];

      // World-space suspension attachment.
      const attach = this._tmp.copy(w.offset).applyQuaternion(this.rotation).add(this.position);
      const rayLen = tuning.suspensionRest + w.radius;
      const hit = this.phys.raycast(
        attach,
        DOWN,
        rayLen,
        groups(CG.WHEEL_RAY, CG.STATIC | CG.TERRAIN | CG.PROP),
        this.collider,
      );

      if (!hit) {
        this.wheelContact[i] = false;
        this.wheelCompression[i] += (0 - this.wheelCompression[i]) * Math.min(1, dt * 8);
        this.wheelSlip[i] *= 0.9;
        this.wheelSpin[i] += fwdSpeed / w.radius * dt;
        continue;
      }

      groundedWheels++;
      this.wheelContact[i] = true;
      const compression = 1 - THREE.MathUtils.clamp((hit.distance - w.radius) / tuning.suspensionRest, 0, 1);
      const prev = this.wheelCompression[i];
      this.wheelCompression[i] = compression;
      const compressionRate = (compression - prev) / dt;

      // Suspension force along the vehicle's up axis.
      const springForce = compression * tuning.suspensionStiffness * tuning.mass * 0.25;
      const damperForce = compressionRate * tuning.suspensionDamping * tuning.mass * 0.25;
      const suspension = THREE.MathUtils.clamp(springForce + damperForce, 0, tuning.mass * 45);

      const forceVec = new THREE.Vector3().copy(hit.normal).multiplyScalar(suspension * dt);
      body.applyImpulseAtPoint(
        { x: forceVec.x, y: forceVec.y, z: forceVec.z },
        { x: attach.x, y: attach.y, z: attach.z },
        true,
      );

      // Wheel-space axes (steered wheels rotate about the body up axis).
      const wheelFwd = new THREE.Vector3().copy(this._fwd);
      const wheelRight = new THREE.Vector3().copy(this._right);
      if (w.steered) {
        wheelFwd.applyAxisAngle(this._up, this.steerAngle);
        wheelRight.applyAxisAngle(this._up, this.steerAngle);
      }

      // Velocity at the contact patch.
      const contactPoint = new THREE.Vector3().copy(attach).addScaledVector(DOWN, hit.distance);
      const pv = body.linvel();
      const av = body.angvel();
      const rel = new THREE.Vector3().subVectors(contactPoint, this.position);
      const pointVel = new THREE.Vector3(pv.x, pv.y, pv.z).add(
        new THREE.Vector3(av.x, av.y, av.z).cross(rel),
      );

      const lateralSpeed = pointVel.dot(wheelRight);
      const longitudinalSpeed = pointVel.dot(wheelFwd);

      // Lateral grip — an impulse that cancels sideways slide, capped by grip.
      const gripCoef = w.steered ? tuning.gripFront : tuning.gripRear;
      const loadFactor = suspension / (tuning.mass * 9.81 * 0.25);
      let maxLateral = gripCoef * tuning.mass * 0.25 * Math.min(2, loadFactor) * dt;
      if (this.handbrakeInput && w.handbraked) maxLateral *= 0.34; // let the back slide
      const lateralImpulse = THREE.MathUtils.clamp(-lateralSpeed * tuning.mass * 0.25, -maxLateral, maxLateral);
      this.wheelSlip[i] = Math.abs(lateralSpeed) - Math.abs(lateralImpulse) / (tuning.mass * 0.25);

      const latVec = new THREE.Vector3().copy(wheelRight).multiplyScalar(lateralImpulse);
      body.applyImpulseAtPoint(
        { x: latVec.x, y: latVec.y, z: latVec.z },
        { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z },
        true,
      );

      // Drive / brake along the wheel forward axis.
      let longImpulse = 0;
      const wantsReverse = this.throttle < -0.02;
      const movingForward = fwdSpeed > 0.6;

      if (w.driven && this.throttle > 0.02) {
        const speedRatio = THREE.MathUtils.clamp(absSpeed / tuning.topSpeed, 0, 1);
        const powerCurve = 1 - speedRatio * speedRatio;
        longImpulse = this.throttle * tuning.engineForce * powerCurve * dt * 0.5;
      } else if (wantsReverse) {
        if (movingForward) {
          longImpulse = -tuning.brakeForce * dt * 0.5; // brake first
        } else if (w.driven) {
          longImpulse = this.throttle * tuning.engineForce * 0.45 * dt * 0.5;
        }
      }

      if (this.handbrakeInput && w.handbraked) {
        longImpulse = -THREE.MathUtils.clamp(longitudinalSpeed, -1, 1) * tuning.handbrakeForce * dt * 0.5;
      }

      // Rolling resistance.
      longImpulse -= longitudinalSpeed * tuning.mass * 0.25 * 0.018;

      const longVec = new THREE.Vector3().copy(wheelFwd).multiplyScalar(longImpulse);
      body.applyImpulseAtPoint(
        { x: longVec.x, y: longVec.y, z: longVec.z },
        { x: contactPoint.x, y: contactPoint.y, z: contactPoint.z },
        true,
      );

      this.wheelSpin[i] += (longitudinalSpeed / w.radius) * dt;
    }

    // Anti-roll: resist body roll so the Dacia leans without flipping.
    if (groundedWheels >= 2) {
      const roll = this._up.dot(UP);
      if (roll < 0.999) {
        const corrective = new THREE.Vector3().crossVectors(this._up, UP).multiplyScalar(tuning.mass * 0.9 * dt);
        body.applyTorqueImpulse({ x: corrective.x, y: corrective.y, z: corrective.z }, true);
      }
      // Mild downforce keeps it planted at speed.
      const df = -tuning.downforce * absSpeed * dt;
      body.applyImpulse({ x: 0, y: df, z: 0 }, true);
    }

    // Visual wheels.
    for (let i = 0; i < this.wheelMeshes.length; i++) {
      const mesh = this.wheelMeshes[i];
      const w = tuning.wheels[i];
      const drop = tuning.suspensionRest * (1 - this.wheelCompression[i]);
      mesh.position.set(w.offset.x, w.offset.y - drop + 0.06, w.offset.z);
      mesh.rotation.set(this.wheelSpin[i], w.steered ? this.steerAngle : 0, 0, 'YXZ');
    }
  }
}

export class VehicleSystem implements System, VehicleService {
  readonly name = 'vehicles';
  readonly order = 110;

  private vehicles = new Map<string, Vehicle>();
  private list: Vehicle[] = [];
  private phys!: PhysicsWorld;
  private ctx!: GameContext;
  private nextId = 1;

  get all(): ReadonlyArray<VehicleHandle> {
    return this.list;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    ctx.provide(Services.Vehicles, this);
  }

  spawn(
    kind: VehicleClass,
    position: THREE.Vector3,
    headingRad: number,
    opts?: { colorSeed?: number; faction?: Faction },
  ): VehicleHandle {
    const id = `veh_${this.nextId++}`;
    const v = new Vehicle(id, kind, opts?.faction ?? 'civilian', this.phys);
    const tuning = v.tuning;

    const q = new THREE.Quaternion().setFromAxisAngle(UP, headingRad);
    const bodyDesc = this.phys.rapier.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y + tuning.suspensionRest + 0.3, position.z)
      .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      .setLinearDamping(0.06)
      .setAngularDamping(1.4)
      .setCcdEnabled(true);
    v.body = this.phys.world.createRigidBody(bodyDesc);

    const cDesc = this.phys.rapier.ColliderDesc
      .cuboid(tuning.halfExtents.x, tuning.halfExtents.y, tuning.halfExtents.z)
      .setCollisionGroups(GROUP.vehicle)
      .setMass(tuning.mass)
      .setFriction(0.35)
      .setRestitution(0.08)
      .setActiveEvents(this.phys.rapier.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(9000);
    v.collider = this.phys.world.createCollider(cDesc, v.body);

    // Lower the centre of mass so it corners instead of tipping.
    v.body.setAdditionalMassProperties(
      tuning.mass,
      { x: tuning.comOffset.x, y: tuning.comOffset.y, z: tuning.comOffset.z },
      { x: tuning.mass * 0.42, y: tuning.mass * 0.52, z: tuning.mass * 0.20 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.buildPlaceholderBody(v);
    this.ctx.scene.add(v.object);

    this.vehicles.set(id, v);
    this.list.push(v);
    return v;
  }

  /** PLACEHOLDER MESH — the vehicle agent replaces this with real bodywork. */
  private buildPlaceholderBody(v: Vehicle): void {
    const t = v.tuning;
    const isDacia = v.kind === 'dacia';
    const bodyMat = new THREE.MeshStandardMaterial({
      color: isDacia ? Palette.daciaYellow : v.faction === 'police' ? Palette.policeBlue : Palette.concreteGrey,
      roughness: 0.42,
      metalness: 0.55,
      envMapIntensity: 1.6,
    });
    const shell = new THREE.Mesh(
      new THREE.BoxGeometry(t.halfExtents.x * 2, t.halfExtents.y * 1.15, t.halfExtents.z * 2),
      bodyMat,
    );
    shell.castShadow = true;
    shell.receiveShadow = true;
    v.object.add(shell);

    if (isDacia) {
      const patch = new THREE.Mesh(
        new THREE.BoxGeometry(t.halfExtents.x * 2.02, t.halfExtents.y * 0.7, t.halfExtents.z * 0.7),
        new THREE.MeshStandardMaterial({ color: Palette.daciaPurple, roughness: 0.5, metalness: 0.4 }),
      );
      patch.position.set(0, 0, -t.halfExtents.z * 0.5);
      patch.castShadow = true;
      v.object.add(patch);
    }

    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(t.halfExtents.x * 1.7, t.halfExtents.y * 0.9, t.halfExtents.z * 1.0),
      new THREE.MeshStandardMaterial({ color: Palette.glassTint, roughness: 0.08, metalness: 0.2, envMapIntensity: 2.4 }),
    );
    cabin.position.set(0, t.halfExtents.y * 1.0, -0.1);
    cabin.castShadow = true;
    v.object.add(cabin);

    const wheelGeo = new THREE.CylinderGeometry(t.wheels[0].radius, t.wheels[0].radius, 0.24, 18);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0d0d10, roughness: 0.85, metalness: 0.05 });
    for (const w of t.wheels) {
      const mesh = new THREE.Mesh(wheelGeo, wheelMat);
      mesh.position.copy(w.offset);
      mesh.castShadow = true;
      v.object.add(mesh);
      v.wheelMeshes.push(mesh);
    }
  }

  despawn(id: string): void {
    const v = this.vehicles.get(id);
    if (!v) return;
    this.ctx.scene.remove(v.object);
    this.phys.world.removeRigidBody(v.body);
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
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  fixedUpdate(dt: number): void {
    for (const v of this.list) v.simulate(dt);
  }
}
