/**
 * Player: kinematic character controller, vehicle enter/exit, health, money —
 * and Ilie Bolojan-Agatinei himself.
 *
 * The placeholder capsule is gone. The player now drives a real skinned
 * humanoid from `src/characters`: procedurally generated body, 22-bone rig,
 * speed-blended locomotion, foot IK against the collision world, additive
 * look-at, a punch, and a ragdoll on death. Movement itself is unchanged —
 * responsive walk/jog/sprint with slope and step handling — the character is
 * driven FROM the controller, never the other way round.
 *
 * OWNER: player/character agent.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, System } from '../core/engine';
import { CG, CHARACTER_SKIN, GROUP, PhysicsWorld, probeGroups } from '../physics/physics';
import { CharacterFactory, HERO_APPEARANCE, type CharacterActor } from '../characters';
import {
  Services,
  type CharacterHandle,
  type CityService,
  type Faction,
  type LocomotionState,
  type PlayerService,
  type VehicleClass,
  type VehicleHandle,
} from '../core/services';

const WALK = 2.1;
const JOG = 4.6;
const SPRINT = 7.4;
const CROUCH = 1.35;
/** Ceiling for anything that is not travel forward — backpedal and side-step. */
const BACKPEDAL = 2.6;
const JUMP_SPEED = 5.1;
const GRAVITY = -21;

/** Camera/body yaw error that starts a turn on the spot, and that ends it. */
const TURN_IN_PLACE_START = 0.95;
const TURN_IN_PLACE_STOP = 0.10;

/* ---- how travel direction is split between the body and the blend ----
 *
 * Two things have to be true at once and they pull in opposite directions:
 *
 *   W+D must RUN OFF AT 45 DEGREES — the body turns into the diagonal, the
 *   way it does in every third-person open-world game, instead of standing
 *   square to the camera doing a strafe blend that reads as "running forward
 *   somehow";
 *
 *   S must still BACKPEDAL — the body stays square to the camera and the leg
 *   cycle runs in reverse, instead of the character spinning to face away and
 *   running "forwards" along it, which is what facing travel used to do.
 *
 * The resolution is that neither rule is global: which one applies is a
 * function of how far off the camera the travel is. Inside a forward cone the
 * body owns the direction; outside it the animation does; and between them the
 * offset is shared, so a stick sweeping from ahead to abeam turns the body out
 * and hands the remainder to the strafe axis without a switch anywhere.
 */
/** Travel within this of camera-forward turns the body ALL the way into it. */
const TRAVEL_TURN_FULL = 1.00;
/** Past this it is a side-step or a backpedal: the body stays on the camera. */
const TRAVEL_TURN_NONE = 1.55;
/** Beyond this off camera-forward, travel is not "forward" for speed purposes. */
const TRAVEL_FORWARD_CONE = 1.21;

/**
 * The heading the body wants, given where the camera looks and where the
 * character is travelling. Pure — `src/gameplay/player.test.ts` pins the three
 * cases that matter (diagonal, backpedal, side-step) on it.
 *
 * `aiming` is the seam for an aim mode: sighting a weapon means the body must
 * stay square to the camera at every travel direction, so the whole blend
 * collapses to "face the camera" with one flag.
 */
export function travelBodyYaw(camYaw: number, travelYaw: number, aiming = false): number {
  const rel = angleDelta(travelYaw, camYaw);
  if (aiming) return camYaw;
  const w = 1 - THREE.MathUtils.smoothstep(Math.abs(rel), TRAVEL_TURN_FULL, TRAVEL_TURN_NONE);
  return camYaw + rel * w;
}

/**
 * World travel expressed in the body's own frame, which is what the 2D gait
 * blend consumes. Character space faces +Z with +X to the character's LEFT
 * (see `src/characters/rig.ts`).
 */
export function bodyTravel(bodyYaw: number, vx: number, vz: number): { f: number; s: number } {
  const sy = Math.sin(bodyYaw);
  const cy = Math.cos(bodyYaw);
  return { f: vx * sy + vz * cy, s: vx * cy - vz * sy };
}

/**
 * Stick input in world space, relative to where the camera looks.
 *
 *   forward F = ( sin(yaw), 0,  cos(yaw) )   — matches CameraSystem's rig
 *   right   R = F x up = (-cos(yaw), 0, sin(yaw))
 *
 * The strafe terms once used +R's negation, which is why A and D came out
 * swapped on screen; the sign lives here now so it is pinned by a test.
 */
export function cameraTravel(camYaw: number, moveX: number, moveY: number): { x: number; z: number } {
  return {
    x: Math.sin(camYaw) * moveY - Math.cos(camYaw) * moveX,
    z: Math.cos(camYaw) * moveY + Math.sin(camYaw) * moveX,
  };
}

/**
 * THE SURFACE THE SOLES BELONG ON, out of everything that has an opinion about
 * it — and they disagree, which is the whole reason this exists.
 *
 *   `rayY`     a real ray down the middle of the capsule. Right nearly always,
 *              and wrong at exactly the moment it matters: on a kerb edge it
 *              can find the carriageway a few centimetres beside the footway
 *              the man is standing on.
 *   `restY`    what the capsule sweep touched. Catches the kerb nose, the step
 *              tread and the crate lid, because it is the whole capsule
 *              footprint rather than one line through it. Only trusted at or
 *              below the capsule base — above it means the sweep found
 *              something the capsule is beside, not on.
 *   `analytic` the city's own footway height. Coarse, but it is what the crowd
 *              is placed with, so agreeing with it is what makes the player's
 *              soles agree with the pedestrians' standing next to him.
 *
 * The highest of them wins: a sole resting a centimetre high reads as standing,
 * a sole a centimetre low reads as sunk, and that asymmetry is the bug report.
 * Returns null when nothing has an opinion at all — over a hole, mid-fall — and
 * the caller should fall back to the capsule.
 */
export function footSurface(
  capsuleBase: number,
  rayY: number | null,
  restY: number | null,
  analyticY: number | null,
): number | null {
  let best = Number.NEGATIVE_INFINITY;
  if (rayY !== null) best = Math.max(best, rayY);
  if (restY !== null && restY <= capsuleBase + CHARACTER_SKIN * 1.5) best = Math.max(best, restY);
  // A footway height from half a metre away is about a different storey.
  if (analyticY !== null && Math.abs(analyticY - capsuleBase) < 0.75) best = Math.max(best, analyticY);
  return best > Number.NEGATIVE_INFINITY ? best : null;
}

/* ---- boarding sequence ---- */
/** How far outboard of the seat the character stands to work the door. */
const DOOR_STANDOFF = 0.92;
/** Past this the hand-off is scripted, not walked — play no animation. */
const BOARD_MAX_REACH = 5.0;
const BOARD_ENTER_DUR = 1.30;
const BOARD_EXIT_DUR = 1.05;
/** Timeline beats, as a fraction of the sequence. */
const ALIGN_END = 0.26;
const OPEN_END = 0.50;
const IN_END = 0.84;

interface BoardDrive {
  /** 0 = standing at the door, 1 = fully seated. */
  sit: number;
  /** 0..1 how far the near arm is out on the door. */
  reach: number;
  /** +1 = door on the character's left, -1 = right. */
  side: number;
  /** True while the reach is the pull-shut rather than the pull-open. */
  closing: boolean;
}

interface BoardState {
  mode: 'enter' | 'exit';
  t: number;
  dur: number;
  vehicle: VehicleHandle;
  from: THREE.Vector3;
  fromYaw: number;
  toYaw: number;
}

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
/** Diagnostics only — kept separate so it can never alias the boarding scratch. */
const _sole = new THREE.Vector3();

/** Triangular 0 -> 1 -> 0 over [a, b]. */
function pulse(x: number, a: number, b: number): number {
  if (x <= a || x >= b) return 0;
  const t = (x - a) / (b - a);
  return Math.sin(t * Math.PI);
}

/** Absolute interpolation between two angles along the short arc. */
function dampAngleTo(from: number, to: number, t: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * THREE.MathUtils.clamp(t, 0, 1);
}

/** Hero stature — the collider is sized to match so he never floats or sinks. */
const HERO_HEIGHT = HERO_APPEARANCE.height;

/**
 * FOOTING. The same collision layers the pedestrian foot IK probes against
 * (`src/characters/ik.ts`), so the player's soles agree with the crowd's.
 */
const GROUND_MASK = probeGroups(CG.STATIC | CG.TERRAIN | CG.PROP);
/** The settle also stands on cars and crates — anything solid he can be on. */
const SETTLE_MASK = probeGroups(CG.STATIC | CG.TERRAIN | CG.PROP | CG.VEHICLE);
const DOWN = new THREE.Vector3(0, -1, 0);
/** How far above the capsule base the ground probe starts. */
const PROBE_RISE = 0.85;
/** Probe length below the start; covers a kerb up and a kerb down. */
const PROBE_DROP = 2.2;
/** Above this step the visual root snaps instead of easing (stairs, teleport). */
const FOOTING_SNAP = 0.55;

/* ---- capsule settle ----
 * The sweep starts above the capsule so it can climb back out of anything it
 * has been driven into, and reaches far enough below to find the floor after a
 * step down. Both are bounded: the lift must clear a landing's worth of
 * penetration without reaching a doorway lintel, and the correction itself is
 * capped so the settle can never be mistaken for a lift onto a ledge. */
const SETTLE_LIFT = 0.45;
const SETTLE_DROP = 0.5;
/** Most the settle will raise the capsule in one step. */
const SETTLE_MAX_RISE = 0.45;

/**
 * Seat anchors, per vehicle class: how far the driver's hip point sits above
 * the vehicle body origin, before the sit pose offset is applied. Derived from
 * the ride heights in `src/vehicles/bodies.ts`.
 */
const SEAT_RISE: Partial<Record<VehicleClass, number>> = {
  dacia: 0, sedan: 0, hatch: 0, police: 0, van: 0.29, truck: 0.49,
  bus: 0.33, tram: 0.05, scooter: 0.57,
};
/** Lateral seat position (matches the steering wheel in dacia.ts). */
const SEAT_X: Partial<Record<VehicleClass, number>> = {
  dacia: -0.34, scooter: 0, bus: -0.62, truck: -0.55, tram: 0,
};

class PlayerCharacter implements CharacterHandle {
  readonly id = 'player';
  readonly archetype = 'builder' as const;
  readonly faction: Faction = 'player';
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  health = 100;
  readonly maxHealth = 100;
  state: LocomotionState = 'idle';
  /** Set once the rigged actor exists. */
  actor: CharacterActor | null = null;

  get isAlive(): boolean {
    return this.health > 0;
  }

  applyDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
  }
  moveTo(): void {
    /* player is driven by input, not AI */
  }
  lookAt(target: THREE.Vector3): void {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    this.object.rotation.y = Math.atan2(dx, dz);
  }
  playState(s: LocomotionState): void {
    this.state = s;
    this.actor?.playState(s);
  }
  ragdoll(impulse?: THREE.Vector3): void {
    this.state = 'ragdoll';
    this.actor?.ragdoll(impulse);
  }
}

export class PlayerSystem implements System, PlayerService {
  readonly name = 'player';
  readonly order = 200;

  readonly character = new PlayerCharacter();
  /** Yaw the character faces, radians. Camera writes this. */
  desiredYaw = 0;

  private ctx!: GameContext;
  private phys!: PhysicsWorld;
  private controller!: RAPIER.KinematicCharacterController;
  private body!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  private velocityY = 0;
  private grounded = true;
  private wasGrounded = true;
  private airTime = 0;
  private _vehicle: VehicleHandle | null = null;
  private _lei = 3400;
  private spawnPoint = new THREE.Vector3(0, 2, 0);
  private enterCooldown = 0;

  private actor: CharacterActor | null = null;
  private planarSpeed = 0;
  private prevYaw = 0;
  private turnRate = 0;
  private crouching = false;
  private deathTimer = 0;
  private lookTarget: THREE.Vector3 | null = null;

  /* ---- directional locomotion ---- */
  /** Travel in body space, -1..1. +F forward, +S toward the character's LEFT. */
  private moveF = 0;
  private moveS = 0;
  /** World heading of travel this step; equals the camera yaw when standing. */
  private travelYaw = 0;
  private turnInPlace = false;
  /**
   * BODY HEADING, radians. Stored here and nowhere else.
   *
   * It used to live in `character.object.rotation.y`, which cannot hold it:
   * writing `object.quaternion.setFromAxisAngle(UP, yaw)` makes three re-derive
   * the Euler in XYZ order, where `y = asin(m13)` is clamped to +/-90 degrees
   * and the overflow is pushed into x and z as +/-PI. The transform stays
   * correct, but the number read back does not — so every heading past a
   * quarter turn was fed back into the next frame's damp as a DIFFERENT angle.
   * That is why turning could stall around 86 degrees and why long turns
   * juddered.
   */
  private bodyYaw = 0;

  /** Cosmetic enter/exit sequence. Never gates any state the contract exposes. */
  private board: BoardState | null = null;

  /**
   * AIM SEAM. While aiming the body must stay square to the camera whatever
   * direction it travels — that is what makes a weapon point where you look —
   * so the travel/camera blend collapses to "face the camera". Nothing sets it
   * yet; `setAiming` is the whole integration surface for when something does.
   */
  private _aiming = false;

  /* ---- footing ---- */
  private city: CityService | null = null;
  /** Smoothed surface height the soles are placed on. */
  private footY = 0;
  /** Raw surface height under the capsule this step (diagnostics). */
  private surfaceY = 0;
  /** Surface the capsule settled onto this step, or -inf if it is airborne. */
  private restY = Number.NEGATIVE_INFINITY;
  /** How far the settle had to lift the capsule this step (diagnostics). */
  private sink = 0;
  private readonly _probe = new THREE.Vector3();

  private readonly radius = 0.32;
  private readonly halfHeight = HERO_HEIGHT * 0.5 - 0.32;

  get position(): THREE.Vector3 {
    return this.character.position;
  }
  get inVehicle(): VehicleHandle | null {
    return this._vehicle;
  }
  get isOnFoot(): boolean {
    return this._vehicle === null;
  }
  get health(): number {
    return this.character.health;
  }
  get maxHealth(): number {
    return this.character.maxHealth;
  }
  get lei(): number {
    return this._lei;
  }
  get aiming(): boolean {
    return this._aiming;
  }
  /** See `_aiming`. Aiming pins the body to the camera; travel drives the gait. */
  setAiming(on: boolean): void {
    this._aiming = on;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    ctx.provide(Services.Player, this);

    const city = ctx.tryGet(Services.City) ?? null;
    this.city = city;
    if (city) {
      const bh = city.landmarks.get('buildersHouse');
      if (bh) this.spawnPoint.set(bh.position.x + 8, 2, bh.position.z + 12);
    }

    this.buildHero(ctx);
    ctx.scene.add(this.character.object);

    const bodyDesc = this.phys.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z);
    this.body = this.phys.world.createRigidBody(bodyDesc);
    const cDesc = this.phys.rapier.ColliderDesc
      .capsule(this.halfHeight, this.radius)
      .setCollisionGroups(GROUP.player);
    this.collider = this.phys.world.createCollider(cDesc, this.body);
    this.controller = this.phys.createCharacterController();

    this.character.position.copy(this.spawnPoint);
    this.footY = this.spawnPoint.y;

    // Footing/locomotion diagnostics for the screenshot harness. Read-only.
    if (typeof window !== 'undefined') this.installDebugHook();
  }

  /** `window.__GTA_CHAR__` — what the automated playtests measure the body by. */
  private installDebugHook(): void {
    (window as unknown as { __GTA_CHAR__: unknown }).__GTA_CHAR__ = {
      footing: () => ({
        root: this.character.position.toArray(),
        capsuleBase: this.body.translation().y - this.halfHeight - this.radius,
        surfaceY: this.surfaceY,
        restY: this.restY > -1e5 ? this.restY : null,
        /** How far the settle had to lift him. Zero means nothing sank. */
        sink: this.sink,
        analytic: this.city ? this.city.spatial.groundHeight(this.character.position.x, this.character.position.z) : null,
        grounded: this.grounded,
        state: this.character.state,
        /** Where the soles ACTUALLY are, after animation and foot IK. */
        soles: this.soleHeights(),
      }),
      locomotion: () => ({
        state: this.character.state,
        speed: this.planarSpeed,
        bodyYaw: this.bodyYaw,
        camYaw: this.desiredYaw,
        /** Body heading minus camera heading. 0 = square on, +/-0.785 = a 45 run. */
        bodyOffCam: angleDelta(this.bodyYaw, this.desiredYaw),
        travelYaw: this.travelYaw,
        moveF: this.moveF,
        moveS: this.moveS,
        turnRate: this.turnRate,
        aiming: this._aiming,
      }),
      boarding: () => (this.board ? { mode: this.board.mode, t: this.board.t, dur: this.board.dur } : null),
    };
  }

  /**
   * World height of each sole, after the gait and the foot IK have had their
   * say. This is the number the bug report is actually about — the root and the
   * capsule are only ever means to it — so the playtests measure it directly
   * rather than inferring it from the collider.
   */
  private soleHeights(): { left: number; right: number } | null {
    const actor = this.actor;
    if (!actor) return null;
    const scale = actor.scale;
    const sole = actor.rig.metrics.ankleY * scale;
    _sole.setFromMatrixPosition(actor.rig.byName.footL.matrixWorld);
    const left = _sole.y - sole;
    _sole.setFromMatrixPosition(actor.rig.byName.footR.matrixWorld);
    return { left, right: _sole.y - sole };
  }

  /** ILIE BOLOJAN-AGATINEI — dark practical kit, one loud purple harness. */
  private buildHero(ctx: GameContext): void {
    const factory = CharacterFactory.of(ctx);
    this.actor = factory.create(HERO_APPEARANCE, { hero: true, seed: 11 });
    this.actor.footIk = true;
    this.character.actor = this.actor;
    this.character.object.add(this.actor.object);

    // Step-timed footfalls. Any system can hook the same callback shape; the
    // audio service gets them for free here.
    this.actor.onFootfall = (_foot, pos, intensity) => {
      ctx.tryGet(Services.Audio)?.oneShot('footstep', pos, 0.22 + intensity * 0.42);
    };
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    this.enterCooldown = Math.max(0, this.enterCooldown - dt);

    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this.respawn();
      return;
    }

    if (this._vehicle) {
      this.driveUpdate(dt, ctx);
      return;
    }
    this.walkUpdate(dt, ctx);
  }

  private _move = new THREE.Vector3();
  private _desired = new THREE.Vector3();

  private walkUpdate(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    // Climbing out of a car owns the body until it is done. It always finishes
    // — the sequence is a timer, not a wait — so this can never trap the player.
    const boarding = this.board !== null;
    const ax = boarding ? 0 : input.axes.moveX;
    const ay = boarding ? 0 : input.axes.moveY;
    const mag = Math.min(1, Math.hypot(ax, ay));

    this.crouching = !boarding && input.action('crouch');

    // Movement is relative to the camera yaw.
    const yaw = this.desiredYaw;
    const dir = cameraTravel(yaw, ax, ay);
    this._desired.set(dir.x, 0, dir.z);
    const moving = mag > 0.01 && this._desired.lengthSq() > 1e-6;

    /* -------- how fast, given WHICH WAY --------
     * A man does not backpedal at 7.4 m/s and does not side-step at a sprint.
     * Capping by direction is also what keeps the 2D blend honest: the strafe
     * and back clips never have to carry a speed they were not authored for. */
    const travelYaw = moving ? Math.atan2(this._desired.x, this._desired.z) : yaw;
    this.travelYaw = travelYaw;
    const forwardish = Math.abs(angleDelta(travelYaw, yaw)) < TRAVEL_FORWARD_CONE;
    const sprint = !boarding && input.action('sprint') && !this.crouching && forwardish;
    let speed = !moving
      ? 0
      : this.crouching ? CROUCH * Math.min(1, mag / 0.7)
      : sprint ? SPRINT
      : mag > 0.65 ? JOG
      : WALK;
    if (!this.crouching && !forwardish) speed = Math.min(speed, BACKPEDAL);
    if (moving) this._desired.normalize().multiplyScalar(speed);

    /* -------- body orientation --------
     * THIRD-PERSON DIRECTIONAL LOCOMOTION, shared between the body and the
     * blend by how far off the camera the travel is — see `travelBodyYaw`.
     * Inside the forward cone the body turns into travel, so W+D genuinely
     * runs off at 45 degrees; abeam and behind it stays square to the camera
     * and A/S/D feed the strafe/back axes of the gait instead of the yaw. */
    const bodyYaw = this.bodyYaw;
    if (moving) {
      this.turnInPlace = false;
      this.bodyYaw = dampAngle(bodyYaw, travelBodyYaw(yaw, travelYaw, this._aiming), 13, dt);
    } else {
      // Idle: the body hangs where it is until the camera has swung far enough
      // to be worth a step, then turns on the spot and settles.
      const off = Math.abs(angleDelta(yaw, bodyYaw));
      if (off > TURN_IN_PLACE_START) this.turnInPlace = true;
      else if (off < TURN_IN_PLACE_STOP) this.turnInPlace = false;
      if (this.turnInPlace) this.bodyYaw = dampAngle(bodyYaw, yaw, 6.5, dt);
    }
    const yawNow = this.bodyYaw;

    /* -------- movement in BODY space, which is what the blend wants -------- */
    const invSpeed = 1 / Math.max(WALK, speed);
    const travel = bodyTravel(yawNow, this._desired.x * invSpeed, this._desired.z * invSpeed);
    const wantF = moving ? travel.f : 0;
    const wantS = moving ? travel.s : 0;
    const kd = 1 - Math.exp(-16 * dt);
    this.moveF += (THREE.MathUtils.clamp(wantF, -1, 1) - this.moveF) * kd;
    this.moveS += (THREE.MathUtils.clamp(wantS, -1, 1) - this.moveS) * kd;
    let dYaw = yawNow - this.prevYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.turnRate = dYaw / Math.max(1e-4, dt);
    this.prevYaw = yawNow;

    if (this.grounded && !boarding && input.action('jump') && !this.crouching) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
      this.character.playState('jump');
    }
    this.velocityY = Math.max(-55, this.velocityY + GRAVITY * dt);

    this._move.set(this._desired.x * dt, this.velocityY * dt, this._desired.z * dt);

    this.controller.computeColliderMovement(this.collider, this._move);
    const corrected = this.controller.computedMovement();
    this.wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    const impactSpeed = this.velocityY;
    if (this.grounded && this.velocityY < 0) this.velocityY = 0;

    const t = this.body.translation();
    const nx = t.x + corrected.x;
    let ny = t.y + corrected.y;
    const nz = t.z + corrected.z;

    /* -------- SETTLE: put the capsule back on top of the world --------
     *
     * This is the fix for feet that sank. Rapier's kinematic controller sweeps
     * from wherever the collider already is and never pushes it back out of
     * anything it is inside, so a landing that drives the capsule 0.1-0.3 m
     * into the pavement is permanent — every later step just slides along at
     * the wrong height, and `computedGrounded()` reports true the whole time,
     * which is why it never looked like a bug in the controller. Measured on a
     * pavement it settled anywhere from 0.06 m above the surface to 0.30 m
     * below it depending only on how the last landing happened to land.
     *
     * `capsuleRest` re-derives the correct height from the capsule itself,
     * swept down from above so it can climb back out. Only ever upward: if the
     * capsule is high, gravity is already dealing with it, and hoisting the
     * character to meet a surface he has walked off would be a step up he never
     * took. Bounded, and only while grounded, so no ledge is ever climbed by
     * standing next to it. */
    this.sink = 0;
    this.restY = Number.NEGATIVE_INFINITY;
    if (this.grounded && this.velocityY <= 0) {
      const rest = this.phys.capsuleRest(this.collider, nx, ny, nz, {
        lift: SETTLE_LIFT,
        drop: SETTLE_DROP,
        filterGroups: SETTLE_MASK,
      });
      if (rest) {
        const want = rest.centerY + CHARACTER_SKIN;
        this.sink = want - ny;
        if (this.sink > 1e-4 && this.sink <= SETTLE_MAX_RISE) ny = want;
        this.restY = rest.surfaceY;
      }
    }
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });

    this.character.position.set(nx, this.footingY(nx, ny, nz, dt), nz);
    this.character.object.position.copy(this.character.position);
    this.character.object.quaternion.setFromAxisAngle(UP, yawNow);

    // Locomotion state for the animation system.
    const planar = Math.hypot(corrected.x, corrected.z) / Math.max(1e-4, dt);
    this.planarSpeed = Math.min(planar, SPRINT + 1);
    this.airTime = this.grounded ? 0 : this.airTime + dt;

    const landing = this.grounded && !this.wasGrounded && impactSpeed < -5.5;

    let state: LocomotionState;
    if (!this.grounded) {
      state = this.velocityY > 0.6 && this.airTime < 0.42 ? 'jump' : 'fall';
    } else if (landing) {
      state = 'land';
    } else if (this.crouching) {
      state = this.planarSpeed < 0.25 ? 'crouchIdle' : 'crouchWalk';
    } else if (this.planarSpeed < 0.25) {
      state = 'idle';
    } else if (this.planarSpeed > SPRINT - 1.2) {
      state = 'sprint';
    } else if (this.planarSpeed > WALK + 0.6) {
      state = 'jog';
    } else {
      state = 'walk';
    }
    if (this.character.state !== 'punch' || state !== 'idle') this.character.state = state;

    if (landing) {
      this.ctx.tryGet(Services.Camera)?.shake(Math.min(0.5, -impactSpeed * 0.03), 0.18);
    }

    if (ny < -30) this.respawn();

    if (!boarding && ctx.input.actionPressed('punch')) this.character.playState('punch');

    // Enter a nearby vehicle.
    if (!boarding && input.actionPressed('interact') && this.enterCooldown <= 0) {
      const vehicles = ctx.tryGet(Services.Vehicles);
      const near = vehicles?.nearestEnterable(this.character.position, 3.6);
      if (near) this.enterVehicle(near);
    }
  }

  /**
   * WHERE THE SOLES GO.
   *
   * The capsule base is NOT the ground. Rapier's kinematic controller keeps a
   * skin offset under the collider, `enableSnapToGround` lets the base hover
   * over a lip it has just cleared, and on București's raised footways
   * (`KERB_H`, `src/world/city/roads.ts`) the capsule can settle against the
   * kerb face rather than its top — so `capsuleBase` reads carriageway height
   * while the character is visibly standing on the pavement. Placing the visual
   * root at `capsuleBase` therefore buries him up to the shins.
   *
   * Every pedestrian avoids this because the crowd never uses a capsule for
   * placement: `src/ai/peds.ts` writes `p.position.y = spatial.groundHeight(x, z)`
   * and hands that straight to `actor.setTransform`. This does the same thing
   * with more precision — a real downward ray against the collision world, with
   * the city's analytic `groundHeight` as the fallback — and eases across steps
   * so a kerb is a step-up rather than a pop. Airborne, the capsule base is the
   * truth again, so jumps and falls are unaffected.
   *
   * Since the capsule now SETTLES (see `walkUpdate`) its base is honest again,
   * so this is back to being a refinement rather than the only thing holding
   * him up: it picks the highest of the ray, the capsule's own contact surface
   * — which is what catches a kerb nose or the lid of a crate the ray down the
   * middle misses — and the city's analytic footway height.
   */
  private footingY(x: number, capsuleY: number, z: number, dt: number): number {
    const base = capsuleY - this.halfHeight - this.radius;

    if (!this.grounded) {
      this.footY = base;
      this.surfaceY = base;
      return base;
    }

    // Probe from just above the capsule base so a kerb the capsule is standing
    // beside cannot shadow the surface it is standing ON.
    this._probe.set(x, base + PROBE_RISE, z);
    const hit = this.phys.raycast(this._probe, DOWN, PROBE_RISE + PROBE_DROP, GROUND_MASK, this.collider);
    const analytic = this.city ? this.city.spatial.groundHeight(x, z) : Number.NEGATIVE_INFINITY;

    let surface = footSurface(
      base,
      hit ? hit.point.y : null,
      this.restY > -1e5 ? this.restY : null,
      analytic > -1e5 ? analytic : null,
    ) ?? Number.NEGATIVE_INFINITY;

    if (surface < -1e5) {
      this.footY = base;
      this.surfaceY = base;
      return base;
    }
    // Never let a bad probe drop him through the floor he is standing on.
    surface = Math.max(surface, base - 0.5);
    this.surfaceY = surface;

    const delta = surface - this.footY;
    this.footY = Math.abs(delta) > FOOTING_SNAP
      ? surface
      : this.footY + delta * (1 - Math.exp(-26 * dt));
    return this.footY;
  }

  private driveUpdate(dt: number, ctx: GameContext): void {
    const v = this._vehicle!;
    const input = ctx.input;
    // Nobody pulls away while a leg is still outside the car.
    const boarding = this.board !== null;
    if (boarding) v.setControls(0, 0, false);
    else v.setControls(input.axes.throttle, input.axes.steer, input.handbrake);

    this.character.position.copy(v.position);
    this.character.state = 'drive';
    this.planarSpeed = 0;
    this.moveF = 0;
    this.moveS = 0;

    if (!boarding && input.actionPressed('interact') && this.enterCooldown <= 0) this.exitVehicle();
    void dt;
  }

  /** Per-frame: pose the hero. Physics already ran this frame. */
  update(dt: number, ctx: GameContext): void {
    const actor = this.actor;
    if (!actor) return;

    const board = this.board ? this.updateBoarding(dt) : null;
    if (!board && this._vehicle) this.seatInVehicle(this._vehicle);

    actor.drive({
      state: this.character.state,
      speed: this.planarSpeed,
      grounded: this.grounded || this._vehicle !== null,
      turnRate: this.turnRate,
      steer: this._vehicle ? ctx.input.axes.steer : 0,
      verticalSpeed: this.velocityY,
      moveForward: this.moveF,
      moveStrafe: this.moveS,
      board,
    });
    actor.lookAt(this.lookTarget);
    actor.update(dt, ctx);
  }

  private _seat = new THREE.Vector3();

  private seatInVehicle(v: VehicleHandle): void {
    this.seatPoint(v, this._seat);
    this.character.object.position.copy(this._seat);
    this.character.object.quaternion.copy(v.rotation);
  }

  /** World position of the driver's hip point. */
  private seatPoint(v: VehicleHandle, out: THREE.Vector3): THREE.Vector3 {
    const scale = HERO_HEIGHT / 1.75;
    const rise = SEAT_RISE[v.kind] ?? 0;
    const sx = SEAT_X[v.kind] ?? -0.36;
    return out.set(sx, rise - 0.44 * scale, 0.04).applyQuaternion(v.rotation).add(v.position);
  }

  /** World position the character stands at while working the driver's door. */
  private doorPoint(v: VehicleHandle, out: THREE.Vector3): THREE.Vector3 {
    const sx = SEAT_X[v.kind] ?? -0.36;
    const side = sx <= 0 ? -1 : 1;
    return out.set(sx + side * DOOR_STANDOFF, -0.42, 0.02).applyQuaternion(v.rotation).add(v.position);
  }

  /* ------------------------------------------------------------------ *
   * ENTER / EXIT
   *
   * The SERVICE CONTRACT is unchanged and still instantaneous: the instant
   * `enterVehicle` is called the occupant is registered, `inVehicle` reports
   * the handle, the event fires and the camera switches — everything that
   * calls into `PlayerService` sees exactly what it saw before. What is new is
   * a purely COSMETIC sequence layered on top, which owns nothing but the
   * mesh's transform and pose for a second or so.
   *
   * That split is what makes it interruptible-safe. A sequence can be
   * cancelled, replaced or never started (a scripted `giveVehicle` teleports
   * the player in from ten metres away — there is no believable path, so there
   * is no animation) and the game state is identical either way. Nothing waits
   * on it, so nothing can dead-lock behind it.
   * ------------------------------------------------------------------ */

  enterVehicle(v: VehicleHandle): void {
    if (this._vehicle) return;
    this._vehicle = v;
    (v.occupants as string[]).push('player');
    this.character.state = 'drive';
    this.enterCooldown = 0.45;
    this.beginBoarding('enter', v);
    if (!this.board) this.seatInVehicle(v);
    this.ctx.events.emit('player:enteredVehicle', { vehicleId: v.id });
    this.ctx.tryGet(Services.Camera)?.setMode('vehicle');
  }

  exitVehicle(): void {
    const v = this._vehicle;
    if (!v) return;
    const idx = (v.occupants as string[]).indexOf('player');
    if (idx >= 0) (v.occupants as string[]).splice(idx, 1);

    // Step out to the driver's side, clear of the body.
    const side = new THREE.Vector3(-2.1, 0.4, 0).applyQuaternion(v.rotation);
    const p = v.position.clone().add(side);
    this.body.setNextKinematicTranslation({
      x: p.x,
      y: p.y + this.halfHeight + this.radius,
      z: p.z,
    });
    this.body.setTranslation({ x: p.x, y: p.y + this.halfHeight + this.radius, z: p.z }, true);
    this.character.position.copy(p);
    this.character.object.position.copy(p);
    this.character.object.quaternion.setFromAxisAngle(UP, this.bodyYaw);
    this.character.object.visible = true;
    this.character.state = 'idle';
    this._vehicle = null;
    this.velocityY = 0;
    this.footY = p.y;
    this.enterCooldown = 0.45;
    this.beginBoarding('exit', v);
    this.ctx.events.emit('player:exitedVehicle', { vehicleId: v.id });
    this.ctx.tryGet(Services.Camera)?.setMode('thirdPerson');
  }

  private beginBoarding(mode: 'enter' | 'exit', v: VehicleHandle): void {
    const door = this.doorPoint(v, _v0);
    const from = mode === 'enter' ? this.character.position : this.seatPoint(v, _v1);
    // No believable path from ten metres away, and none needed at speed: a
    // scripted hand-off or a moving car both take the old instant placement.
    if (from.distanceTo(door) > BOARD_MAX_REACH || Math.abs(v.speed) > 2.4) {
      this.board = null;
      return;
    }
    this.board = {
      mode,
      t: 0,
      dur: mode === 'enter' ? BOARD_ENTER_DUR : BOARD_EXIT_DUR,
      vehicle: v,
      from: from.clone(),
      fromYaw: this.bodyYaw,
      toYaw: this.bodyYaw,
    };
  }

  /**
   * Walk to the door, open it, get in, pull it shut — and the reverse. Returns
   * the pose payload for the animation controller, or null once it is done.
   */
  private updateBoarding(dt: number): BoardDrive | null {
    const b = this.board;
    if (!b) return null;
    b.t += dt;
    const u = THREE.MathUtils.clamp(b.t / b.dur, 0, 1);
    const v = b.vehicle;

    // Recomputed every frame: a car left in gear does not wait to be boarded.
    const door = this.doorPoint(v, _v0);
    const seat = this.seatPoint(v, _v1);
    // Facing the door aperture: the character-space +Z axis points at the seat.
    _v2.subVectors(seat, door);
    const faceDoorYaw = Math.atan2(_v2.x, _v2.z);
    const carYaw = Math.atan2(
      2 * (v.rotation.w * v.rotation.y + v.rotation.x * v.rotation.z),
      1 - 2 * (v.rotation.y * v.rotation.y + v.rotation.x * v.rotation.x),
    );

    // Timeline, as fractions of the sequence. Enter and exit are the same four
    // beats read in opposite order.
    const p = b.mode === 'enter' ? u : 1 - u;
    const align = THREE.MathUtils.smoothstep(p, 0, ALIGN_END);          // walk to the door
    const open = pulse(p, ALIGN_END, OPEN_END);                          // hand on the handle, pull
    const sit = THREE.MathUtils.smoothstep(p, OPEN_END - 0.04, IN_END);  // body into the seat
    const close = pulse(p, IN_END, 1);                                   // reach back, pull shut

    // Position: from -> door -> seat. Height rides an arc so the hips clear the
    // sill instead of sliding through it.
    _v3.lerpVectors(b.from, door, align);
    _v3.lerp(seat, sit);
    _v3.y += Math.sin(Math.PI * THREE.MathUtils.clamp(sit, 0, 1)) * 0.055;

    const yaw = dampAngleTo(
      dampAngleTo(b.fromYaw, faceDoorYaw, align),
      carYaw,
      sit,
    );
    b.toYaw = yaw;

    this.character.object.position.copy(_v3);
    this.character.object.quaternion.setFromAxisAngle(UP, yaw);
    // Keep the on-foot body yaw in step so releasing the sequence never snaps.
    this.bodyYaw = yaw;
    this.prevYaw = yaw;

    if (u >= 1) {
      this.board = null;
      if (this._vehicle) this.seatInVehicle(this._vehicle);
      return null;
    }
    return {
      sit: THREE.MathUtils.clamp(sit, 0, 1),
      reach: Math.max(open, close * 0.9),
      // The driver's door is on the character's LEFT of the seat (SEAT_X < 0),
      // so the near arm is the left one going in and coming out.
      side: (SEAT_X[v.kind] ?? -0.36) <= 0 ? 1 : -1,
      closing: close > open,
    };
  }

  applyDamage(amount: number, _source?: Faction, point?: THREE.Vector3): void {
    if (this.deathTimer > 0) return;
    this.character.applyDamage(amount);
    this.ctx.events.emit('player:damaged', { amount, health: this.character.health });
    if (this.character.health > 0) {
      if (amount > 18) this.character.playState('stagger');
      return;
    }
    // Death: collapse into a ragdoll, then respawn.
    const impulse = new THREE.Vector3(0, 2.2, 0);
    if (point) {
      impulse.add(this.character.position.clone().sub(point).setY(0).normalize().multiplyScalar(4.5));
    } else {
      impulse.z -= 3;
    }
    this.character.playState('die');
    this.actor?.ragdoll(impulse);
    this.deathTimer = 2.9;
    this.ctx.events.emit('player:died', { cause: 'damage' });
  }

  teleport(p: THREE.Vector3, headingRad = 0): void {
    this.body.setTranslation({ x: p.x, y: p.y + this.halfHeight + this.radius, z: p.z }, true);
    this.character.position.copy(p);
    this.character.object.position.copy(p);
    this.character.object.quaternion.setFromAxisAngle(UP, headingRad);
    this.bodyYaw = headingRad;
    this.prevYaw = headingRad;
    this.velocityY = 0;
    // The footing filter must not ease across a teleport.
    this.footY = p.y;
    this.moveF = 0;
    this.moveS = 0;
    this.turnInPlace = false;
    this.board = null;
  }

  respawn(): void {
    if (this._vehicle) this.exitVehicle();
    this.character.health = this.character.maxHealth;
    this.deathTimer = 0;
    this.actor?.revive();
    this.character.state = 'idle';
    this.teleport(this.spawnPoint);
    this.ctx.events.emit('player:respawned', { position: this.spawnPoint.clone() });
  }

  addLei(delta: number, reason: string): void {
    this._lei = Math.max(0, this._lei + delta);
    this.ctx.events.emit('economy:changed', { lei: this._lei, delta, reason });
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function angleDelta(target: number, current: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(target, current) * (1 - Math.exp(-lambda * dt));
}
