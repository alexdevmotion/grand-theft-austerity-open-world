/**
 * ANIMATION — a procedural state machine for the whole LocomotionState union.
 *
 * There is no mocap in this project, so every clip is authored as curves:
 * harmonics and gaussian lobes for the gait, keyed segments for the one-shots.
 * Locomotion is NOT four separate states that snap — idle / walk / jog / sprint
 * are evaluated as a continuous blend driven by ground speed, sharing one gait
 * phase, so acceleration reads as a real gait change rather than a crossfade.
 *
 * WHAT MAKES IT READ AS A PERSON
 *   - arm swing counter-phased to the legs, with speed-dependent elbow flex
 *   - pelvis yaw and chest counter-rotation about the spine
 *   - pelvis vertical bob at twice stride frequency, lateral shift onto the
 *     stance leg, and contralateral hip drop
 *   - head stabilisation that cancels most of the pelvis bob and roll
 *   - breathing and slow weight shifts layered additively on every state
 *   - phase advanced by DISTANCE, not time, so nobody ever skates
 *   - footfall events at heel strike for audio/VFX to hook
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { LocomotionState } from '../core/services';
import type { PhysicsWorld } from '../physics/physics';
import { applyLookAt, solveFootIk, type FootIkState } from './ik';
import { BI, BONE_COUNT, CORE_BONE_COUNT, DIGITS, type BodyMetrics, type Rig } from './rig';

/* ------------------------------------------------------------------ */
/* Pose                                                                */
/* ------------------------------------------------------------------ */

/** Per-bone rotation delta relative to the bind pose, plus a root offset. */
export class Pose {
  readonly q = new Float32Array(BONE_COUNT * 4);
  readonly root = new THREE.Vector3();
  /** Extra yaw applied to the whole body (staggering, drive lean). */
  rootYaw = 0;
  /**
   * How many bones this pose evaluates. Actors that never show their hands run
   * at `CORE_BONE_COUNT` and leave the twenty finger bones in bind, so the
   * crowd pays nothing for a feature it is too far away to display.
   */
  limit = BONE_COUNT;

  constructor() {
    this.identity();
  }

  identity(): void {
    const q = this.q;
    for (let i = 0; i < this.limit; i++) {
      q[i * 4] = 0;
      q[i * 4 + 1] = 0;
      q[i * 4 + 2] = 0;
      q[i * 4 + 3] = 1;
    }
    this.root.set(0, 0, 0);
    this.rootYaw = 0;
  }

  /** Euler (YXZ) in the bone's rest frame: x = pitch forward, y = twist, z = lateral right. */
  setEuler(b: number, x: number, y: number, z: number): void {
    const c1 = Math.cos(x * 0.5), s1 = Math.sin(x * 0.5);
    const c2 = Math.cos(y * 0.5), s2 = Math.sin(y * 0.5);
    const c3 = Math.cos(z * 0.5), s3 = Math.sin(z * 0.5);
    const i = b * 4;
    this.q[i] = s1 * c2 * c3 + c1 * s2 * s3;
    this.q[i + 1] = c1 * s2 * c3 - s1 * c2 * s3;
    this.q[i + 2] = c1 * c2 * s3 - s1 * s2 * c3;
    this.q[i + 3] = c1 * c2 * c3 + s1 * s2 * s3;
  }

  /** Post-multiply an additive rotation onto a bone (layered clips). */
  addEuler(b: number, x: number, y: number, z: number, w = 1): void {
    if (w === 0) return;
    const c1 = Math.cos(x * w * 0.5), s1 = Math.sin(x * w * 0.5);
    const c2 = Math.cos(y * w * 0.5), s2 = Math.sin(y * w * 0.5);
    const c3 = Math.cos(z * w * 0.5), s3 = Math.sin(z * w * 0.5);
    const ax = s1 * c2 * c3 + c1 * s2 * s3;
    const ay = c1 * s2 * c3 - s1 * c2 * s3;
    const az = c1 * c2 * s3 - s1 * s2 * c3;
    const aw = c1 * c2 * c3 + s1 * s2 * s3;
    const i = b * 4;
    const bx = this.q[i], by = this.q[i + 1], bz = this.q[i + 2], bw = this.q[i + 3];
    this.q[i] = bw * ax + bx * aw + by * az - bz * ay;
    this.q[i + 1] = bw * ay - bx * az + by * aw + bz * ax;
    this.q[i + 2] = bw * az + bx * ay - by * ax + bz * aw;
    this.q[i + 3] = bw * aw - bx * ax - by * ay - bz * az;
  }

  copy(o: Pose): void {
    this.q.set(o.q);
    this.root.copy(o.root);
    this.rootYaw = o.rootYaw;
  }

  /** this = slerp(a, b, t) */
  blend(a: Pose, b: Pose, t: number): void {
    if (t <= 0) return this.copy(a);
    if (t >= 1) return this.copy(b);
    for (let i = 0; i < this.limit; i++) {
      slerpInto(this.q, a.q, b.q, i * 4, t);
    }
    this.root.lerpVectors(a.root, b.root, t);
    this.rootYaw = a.rootYaw + (b.rootYaw - a.rootYaw) * t;
  }
}

function slerpInto(out: Float32Array, A: Float32Array, B: Float32Array, o: number, t: number): void {
  let ax = A[o], ay = A[o + 1], az = A[o + 2], aw = A[o + 3];
  const bx = B[o], by = B[o + 1], bz = B[o + 2], bw = B[o + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    ax = -ax; ay = -ay; az = -az; aw = -aw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  let x = ax * s0 + bx * s1;
  let y = ay * s0 + by * s1;
  let z = az * s0 + bz * s1;
  let w = aw * s0 + bw * s1;
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w;
}

/* ------------------------------------------------------------------ */
/* Gait definition                                                     */
/* ------------------------------------------------------------------ */

interface Gait {
  speed: number;
  stride: number;
  duty: number;
  thighA: number;
  thighBias: number;
  kneeLoad: number;
  kneeSwing: number;
  kneeBase: number;
  ankPush: number;
  ankLift: number;
  bob: number;
  lateral: number;
  hipRoll: number;
  pelvisYaw: number;
  chestYaw: number;
  armA: number;
  armBias: number;
  elbow: number;
  elbowSwing: number;
  lean: number;
  shoulderDrop: number;
  headBob: number;
}

const IDLE_GAIT: Gait = {
  speed: 0, stride: 1, duty: 1,
  thighA: 0, thighBias: 0.02, kneeLoad: 0, kneeSwing: 0, kneeBase: 0.055,
  ankPush: 0, ankLift: 0, bob: 0, lateral: 0, hipRoll: 0,
  pelvisYaw: 0, chestYaw: 0, armA: 0, armBias: 0.03, elbow: 0.17, elbowSwing: 0,
  lean: 0.012, shoulderDrop: 0.05, headBob: 0,
};

/**
 * WALK. The arm, trunk and bob channels were all authored a third of the way
 * to life and an immersion review called the result a floating mannequin.
 *
 *   armA      0.36 -> 0.58   ±21° of shoulder swing is what a treadmill study
 *                            measures and what a game reads as "dead arms".
 *                            Games sit nearer ±33°, and the arms are the first
 *                            thing the eye uses to decide a walk is a walk.
 *   elbow /   0.26 / 0.20    the elbow barely moved through the cycle, so the
 *   elbowSwing               hand travelled less than the shoulder did.
 *   bob       0.030 -> 0.044 15 mm of pelvis rise. A real walk is 20-25 mm,
 *                            and below that the body slides rather than steps.
 *   lateral   0.022 -> 0.034 the pelvis has to move ONTO the stance leg.
 *   pelvisYaw /              trunk counter-rotation: the difference between a
 *   chestYaw                 spine and a broom handle.
 */
const WALK_GAIT: Gait = {
  speed: 1.7, stride: 1.44, duty: 0.62,
  thighA: 0.42, thighBias: 0.03, kneeLoad: 0.30, kneeSwing: 1.04, kneeBase: 0.06,
  ankPush: 0.40, ankLift: 0.24, bob: 0.044, lateral: 0.034, hipRoll: 0.072,
  pelvisYaw: 0.15, chestYaw: 0.145, armA: 0.58, armBias: 0.02, elbow: 0.36, elbowSwing: 0.44,
  lean: 0.045, shoulderDrop: 0.04, headBob: 0.35,
};

const JOG_GAIT: Gait = {
  speed: 4.3, stride: 2.34, duty: 0.40,
  thighA: 0.62, thighBias: 0.06, kneeLoad: 0.46, kneeSwing: 1.62, kneeBase: 0.10,
  ankPush: 0.54, ankLift: 0.36, bob: 0.061, lateral: 0.024, hipRoll: 0.082,
  pelvisYaw: 0.20, chestYaw: 0.205, armA: 0.86, armBias: 0.10, elbow: 1.18, elbowSwing: 0.50,
  lean: 0.135, shoulderDrop: 0.02, headBob: 0.55,
};

const SPRINT_GAIT: Gait = {
  speed: 7.4, stride: 3.20, duty: 0.30,
  thighA: 0.88, thighBias: 0.10, kneeLoad: 0.52, kneeSwing: 2.10, kneeBase: 0.12,
  ankPush: 0.64, ankLift: 0.44, bob: 0.076, lateral: 0.016, hipRoll: 0.090,
  pelvisYaw: 0.24, chestYaw: 0.255, armA: 1.16, armBias: 0.16, elbow: 1.58, elbowSwing: 0.52,
  lean: 0.27, shoulderDrop: 0.0, headBob: 0.66,
};

const CROUCH_WALK_GAIT: Gait = {
  speed: 1.4, stride: 0.95, duty: 0.66,
  thighA: 0.30, thighBias: 0.86, kneeLoad: 0.22, kneeSwing: 0.62, kneeBase: 1.28,
  ankPush: 0.22, ankLift: 0.18, bob: 0.016, lateral: 0.020, hipRoll: 0.040,
  pelvisYaw: 0.07, chestYaw: 0.06, armA: 0.24, armBias: 0.42, elbow: 0.95, elbowSwing: 0.14,
  lean: 0.34, shoulderDrop: 0.10, headBob: 0.30,
};

const CROUCH_IDLE_GAIT: Gait = {
  ...CROUCH_WALK_GAIT,
  speed: 0, thighA: 0, kneeLoad: 0, kneeSwing: 0, ankPush: 0, ankLift: 0,
  bob: 0, lateral: 0, hipRoll: 0, pelvisYaw: 0, chestYaw: 0, armA: 0, elbowSwing: 0,
};

const LOCOMOTION_LADDER: Gait[] = [IDLE_GAIT, WALK_GAIT, JOG_GAIT, SPRINT_GAIT];

/**
 * Blend two gaits. Runs unconditionally for every actor every frame.
 *
 * This used to build a generic closure and drive it with 22 computed-key
 * accesses — 88 megamorphic property lookups plus one closure allocation per
 * actor per frame. Written out as straight field assignments it is the same
 * arithmetic against inline-cached slots, and allocates nothing.
 */
function lerpGait(a: Gait, b: Gait, t: number, out: Gait): Gait {
  out.speed = a.speed + (b.speed - a.speed) * t;
  out.stride = a.stride + (b.stride - a.stride) * t;
  out.duty = a.duty + (b.duty - a.duty) * t;
  out.thighA = a.thighA + (b.thighA - a.thighA) * t;
  out.thighBias = a.thighBias + (b.thighBias - a.thighBias) * t;
  out.kneeLoad = a.kneeLoad + (b.kneeLoad - a.kneeLoad) * t;
  out.kneeSwing = a.kneeSwing + (b.kneeSwing - a.kneeSwing) * t;
  out.kneeBase = a.kneeBase + (b.kneeBase - a.kneeBase) * t;
  out.ankPush = a.ankPush + (b.ankPush - a.ankPush) * t;
  out.ankLift = a.ankLift + (b.ankLift - a.ankLift) * t;
  out.bob = a.bob + (b.bob - a.bob) * t;
  out.lateral = a.lateral + (b.lateral - a.lateral) * t;
  out.hipRoll = a.hipRoll + (b.hipRoll - a.hipRoll) * t;
  out.pelvisYaw = a.pelvisYaw + (b.pelvisYaw - a.pelvisYaw) * t;
  out.chestYaw = a.chestYaw + (b.chestYaw - a.chestYaw) * t;
  out.armA = a.armA + (b.armA - a.armA) * t;
  out.armBias = a.armBias + (b.armBias - a.armBias) * t;
  out.elbow = a.elbow + (b.elbow - a.elbow) * t;
  out.elbowSwing = a.elbowSwing + (b.elbowSwing - a.elbowSwing) * t;
  out.lean = a.lean + (b.lean - a.lean) * t;
  out.shoulderDrop = a.shoulderDrop + (b.shoulderDrop - a.shoulderDrop) * t;
  out.headBob = a.headBob + (b.headBob - a.headBob) * t;
  return out;
}

/* ------------------------------------------------------------------ */
/* Per-person gait                                                     */
/* ------------------------------------------------------------------ */

/**
 * HOW THIS PARTICULAR PERSON WALKS.
 *
 * One shared `Gait` table drives every character in the game, which is correct
 * — there is one human gait — and was also the loudest thing wrong with the
 * crowd: eighty people crossing Piața Victoriei in perfect lockstep is uncanny
 * in a way no single body is. Real difference between two walkers is not a
 * different clip, it is the same clip with different constants: stride length,
 * how much arm they use, how bent they carry the elbow, whether they stoop,
 * how much they bounce, how much they swing the hips, and — for about one in
 * fourteen people on a real pavement — a hitch on one side.
 *
 * Derived once per actor from the actor's seed, so it is stable across a save,
 * identical on every machine, and costs nothing per frame.
 *
 * STRIDE IS COUPLED TO LEG AMPLITUDE on purpose. Phase is advanced by distance
 * travelled divided by `stride`, so lengthening someone's stride without also
 * lengthening the arc their foot sweeps makes the foot slide — the exact defect
 * the last locomotion pass was written to kill.
 */
export interface GaitStyle {
  /** Stride-length multiplier. >1 is a long, loping step at a lower cadence. */
  stride: number;
  /** Arm swing multiplier. Some people walk with their arms nearly still. */
  arm: number;
  /** Difference between the two arms, radians — nobody is symmetric. */
  armAsym: number;
  /** Constant elbow flex: arms carried high and bent, or hanging long. */
  armCarriage: number;
  /** Constant lateral flare of the upper arms. Wide for heavy/built walkers. */
  armOut: number;
  /** Constant forward flexion of the trunk. */
  stoop: number;
  /** Vertical bob multiplier. */
  bounce: number;
  /** Pelvis/thorax counter-rotation multiplier. */
  swagger: number;
  /** Lateral pelvis-shift multiplier. */
  sway: number;
  /** External rotation of the feet, radians. */
  toeOut: number;
  /** Constant head pitch (down = looking at the pavement). */
  headDown: number;
  /** Constant head roll. */
  headTilt: number;
  /** Constant shoulder-height difference, radians. */
  shoulderTilt: number;
  /** 0 = sound. Above 0, an antalgic hitch loading `limpSide`. */
  limp: number;
  /** Which leg is sore: 0 = left, 1 = right. */
  limpSide: 0 | 1;
}

/** The gait every clip was authored against. Variation multiplies onto this. */
export const NEUTRAL_GAIT_STYLE: GaitStyle = {
  stride: 1, arm: 1, armAsym: 0, armCarriage: 0, armOut: 0, stoop: 0,
  bounce: 1, swagger: 1, sway: 1, toeOut: 0, headDown: 0, headTilt: 0,
  shoulderTilt: 0, limp: 0, limpSide: 0,
};

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Roll one person's walk.
 *
 * `variation` scales the whole spread and gates the limp: the player is given
 * a reduced spread and no limp, because the one body the camera lives behind
 * for six hours should not have a quirk you cannot un-see.
 */
export function gaitStyleFor(seed: number, variation = 1): GaitStyle {
  const v = clamp(variation, 0, 1);
  if (v <= 0) return { ...NEUTRAL_GAIT_STYLE };
  const r = new Rng(`gait:${seed | 0}`);
  const g = (): number => r.gauss();
  // Drawn unconditionally so the rest of the stream does not shift when the
  // limp is gated off — the same seed has to describe the same person.
  const limpRoll = r.next();
  const limpSide: 0 | 1 = r.next() < 0.5 ? 0 : 1;
  return {
    stride: clamp(1 + 0.13 * v * g(), 0.80, 1.24),
    // The top of this range is a hard clamp, not a tail to be generous with:
    // at 1.45 the hand already covers 800 mm fore-and-aft at walking pace, and
    // anything past it reads as windmilling rather than as a brisk walker.
    arm: clamp(1 + 0.34 * v * g(), 0.52, 1.45),
    armAsym: 0.045 * v * g(),
    armCarriage: Math.max(0, g()) * 0.30 * v,
    armOut: 0.055 * v * g(),
    stoop: Math.max(0, g()) * 0.075 * v,
    bounce: clamp(1 + 0.28 * v * g(), 0.55, 1.55),
    swagger: clamp(1 + 0.42 * v * g(), 0.35, 1.85),
    sway: clamp(1 + 0.34 * v * g(), 0.45, 1.70),
    toeOut: 0.055 + 0.075 * v * g(),
    headDown: 0.055 * v * g(),
    headTilt: 0.042 * v * g(),
    shoulderTilt: 0.038 * v * g(),
    // About one pavement in fourteen. Reduced-spread bodies (the player) never
    // draw one at all.
    limp: v > 0.6 && limpRoll < 0.07 ? 0.35 + (limpRoll / 0.07) * 0.65 : 0,
    limpSide,
  };
}

/** Distance around the unit circle. */
function cyc(p: number, c: number): number {
  let d = p - c;
  d -= Math.floor(d + 0.5);
  return d;
}

function lobe(p: number, c: number, s: number): number {
  const d = cyc(p, c) / s;
  return Math.exp(-0.5 * d * d);
}

const TAU = Math.PI * 2;

/** Finger closure on a steering wheel rim. A full fist (1) clips the rim. */
export const WHEEL_GRIP = 0.82;

/* ------------------------------------------------------------------ */
/* Drive input                                                         */
/* ------------------------------------------------------------------ */

export interface Drive {
  state: LocomotionState;
  /** Planar ground speed, m/s. */
  speed: number;
  grounded: boolean;
  /** rad/s of body yaw change — drives the lean into turns. */
  turnRate?: number;
  /** -1..1, only used by the drive pose. */
  steer?: number;
  /** Signed vertical speed, shapes jump/fall. */
  verticalSpeed?: number;
  /**
   * TRAVEL DIRECTION IN BODY SPACE, -1..1 each. `moveForward` is along the
   * character's +Z, `moveStrafe` along its +X (its LEFT — see rig.ts). Omit
   * both and the gait behaves exactly as it always did: straight ahead.
   *
   * This is what makes S look like a backpedal rather than a spin. A mover that
   * turns the body to face travel can only ever report (0, 1); a mover that
   * holds the body on the camera reports the real vector, and the gait steers
   * itself along it.
   */
  moveForward?: number;
  moveStrafe?: number;
  /** Vehicle boarding overlay. Present only during the enter/exit sequence. */
  board?: BoardPose | null;
}

/** Payload for the enter/exit-vehicle sequence, authored by the mover. */
export interface BoardPose {
  /** 0 = standing at the door, 1 = fully seated. */
  sit: number;
  /** 0..1 extension of the near arm onto the door. */
  reach: number;
  /** +1 = door on the character's left, -1 = right. */
  side: number;
  /** Pull-shut rather than pull-open — the reach starts inboard. */
  closing: boolean;
}

type Internal =
  | 'locomotion' | 'crouch' | 'jump' | 'fall' | 'land'
  | 'sit' | 'drive' | 'stagger' | 'punch' | 'die' | 'ragdoll' | 'board';

const ONE_SHOT_DURATION: Partial<Record<Internal, number>> = {
  land: 0.34,
  stagger: 0.72,
  punch: 0.46,
  die: 1.15,
};

const BLEND_IN: Record<Internal, number> = {
  locomotion: 0.17, crouch: 0.22, jump: 0.09, fall: 0.15, land: 0.07,
  sit: 0.34, drive: 0.30, stagger: 0.07, punch: 0.06, die: 0.11, ragdoll: 0.0,
  board: 0.12,
};

function internalOf(s: LocomotionState): Internal {
  switch (s) {
    case 'idle': case 'walk': case 'jog': case 'sprint': return 'locomotion';
    case 'crouchIdle': case 'crouchWalk': return 'crouch';
    default: return s as Internal;
  }
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

export class AnimationController {
  readonly pose = new Pose();

  onFootfall: ((foot: 'left' | 'right', localPos: THREE.Vector3, intensity: number) => void) | null = null;

  /** 0..1 per foot — 1 while the foot should stay planted. Read by foot IK. */
  readonly footPlant: [number, number] = [1, 1];

  private readonly rig: Rig;
  private readonly m: BodyMetrics;
  private readonly seed: number;
  /** This character's own walk. See `gaitStyleFor`. */
  readonly style: GaitStyle;

  private state: Internal = 'locomotion';
  private requested: LocomotionState = 'idle';
  private prev = new Pose();
  private work = new Pose();
  private blendT = 1;
  private blendDur = 0.2;
  private shotT = 0;

  private clock = 0;
  private phase = 0;
  private speed = 0;
  private smoothSpeed = 0;
  private grounded = true;
  private turnRate = 0;
  private lean = 0;
  private steer = 0;
  private vertical = 0;
  private gait: Gait = { ...IDLE_GAIT };
  private gaitScratch: Gait = { ...IDLE_GAIT };
  private locoWeight = 0;

  /** Requested travel direction in body space (unit). */
  private wantF = 1;
  private wantS = 0;
  /** Smoothed travel direction actually driving the gait. */
  private dirAngle = 0;
  private dirF = 1;
  private dirS = 0;
  /** Yaw rate used for the step-round-on-the-spot layer. */
  private turnStepRate = 0;
  /** 0..1 finger curl per hand — index 0 left, 1 right. */
  private readonly grip: [number, number] = [0, 0];
  private board: BoardPose | null = null;

  private lookTarget: THREE.Vector3 | null = null;
  private lookWeight = 1;
  private lookYaw = 0;
  private lookPitch = 0;

  private ikState: FootIkState;

  /**
   * Evaluate the finger bones. Off for the crowd — see `Pose.limit`. Turning it
   * on costs 20 more bones through identity/blend/applyTo, which is why it is
   * a per-actor decision and not a global one.
   */
  set handDetail(on: boolean) {
    const n = on ? BONE_COUNT : CORE_BONE_COUNT;
    this.pose.limit = n;
    this.prev.limit = n;
    this.work.limit = n;
  }

  get handDetail(): boolean {
    return this.pose.limit > CORE_BONE_COUNT;
  }

  /**
   * `variation` is how far this character's walk is allowed to stray from the
   * authored one — 1 for the crowd, less for the player (see `gaitStyleFor`).
   */
  constructor(rig: Rig, seed = 0, variation = 1) {
    this.rig = rig;
    this.m = rig.metrics;
    this.handDetail = false;
    this.style = gaitStyleFor(seed, variation);
    this.seed = (seed % 1000) * 0.618;
    this.phase = (this.seed * 7.3) % 1;
    this.clock = this.seed * 3.1;
    this.ikState = {
      hipOffset: 0,
      footY: [0, 0],
      footNormal: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)],
      blend: [0, 0],
    };
  }

  /** True while the current state has both feet on real ground. */
  get groundedPose(): boolean {
    return (this.state === 'locomotion' || this.state === 'crouch') && this.grounded;
  }

  get currentPhase(): number {
    return this.phase;
  }

  drive(d: Drive): void {
    this.speed = d.speed;
    this.grounded = d.grounded;
    this.turnRate = d.turnRate ?? 0;
    this.steer = d.steer ?? 0;
    this.vertical = d.verticalSpeed ?? 0;

    // Direction of travel in body space. Defaults to straight ahead so every
    // existing caller (the whole crowd) is bit-identical to before.
    const mf = d.moveForward;
    const ms = d.moveStrafe;
    if (mf === undefined && ms === undefined) {
      this.wantF = 1;
      this.wantS = 0;
    } else {
      const f = mf ?? 0;
      const s = ms ?? 0;
      const len = Math.hypot(f, s);
      if (len < 0.08) {
        // Below the deadzone keep the last heading rather than snapping the
        // gait to "forward" every time the stick crosses centre.
        this.wantF = this.wantF || 1;
      } else {
        this.wantF = f / len;
        this.wantS = s / len;
      }
    }

    this.board = d.board ?? null;
    if (this.board) {
      this.requested = d.state;
      this.enter('board');
    } else {
      this.request(d.state);
    }
  }

  request(s: LocomotionState): void {
    this.requested = s;
    this.enter(internalOf(s));
  }

  private enter(want: Internal): void {
    if (want === this.state) return;
    // A one-shot in flight only yields to a more urgent one-shot.
    if (ONE_SHOT_DURATION[this.state] !== undefined && this.shotT > 0) {
      const rank: Partial<Record<Internal, number>> = { land: 1, punch: 2, stagger: 3, die: 4 };
      const cur = rank[this.state] ?? 0;
      const nxt = rank[want] ?? 0;
      if (nxt <= cur && want !== 'ragdoll') return;
    }
    this.prev.copy(this.pose);
    this.state = want;
    this.blendDur = BLEND_IN[want] ?? 0.18;
    this.blendT = this.blendDur <= 0 ? 1 : 0;
    this.shotT = ONE_SHOT_DURATION[want] ?? 0;
  }

  reset(s: LocomotionState): void {
    this.state = internalOf(s);
    this.requested = s;
    this.blendT = 1;
    this.shotT = 0;
    this.pose.identity();
    this.prev.identity();
  }

  setLookTarget(t: THREE.Vector3 | null, weight = 1): void {
    this.lookTarget = t;
    this.lookWeight = weight;
  }

  /** Keep the clock/phase moving without evaluating anything (off-screen). */
  advanceClockOnly(dt: number): void {
    if (dt <= 0) return;
    this.clock += dt;
    const stride = Math.max(0.4, this.gait.stride * this.style.stride);
    this.phase = (this.phase + (this.speed / stride) * dt) % 1;
  }

  update(dt: number): void {
    if (dt <= 0) dt = 1 / 60;
    this.clock += dt;

    // Speed smoothing keeps the gait blend from chattering on stick noise.
    const k = 1 - Math.exp(-11 * dt);
    this.smoothSpeed += (this.speed - this.smoothSpeed) * k;
    this.lean += (this.turnRate - this.lean) * (1 - Math.exp(-7 * dt));

    // Travel direction eases so a flick from forward to strafe is a turn of the
    // gait, not a jump cut. It is smoothed as an ANGLE, not as a vector: a
    // component-wise lerp between (1,0) and (-1,0) followed by a renormalise
    // never leaves +1 — the gait would refuse to ever reverse.
    const kd = 1 - Math.exp(-9 * dt);
    let da = Math.atan2(this.wantS, this.wantF) - this.dirAngle;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    this.dirAngle += da * kd;
    this.dirF = Math.cos(this.dirAngle);
    this.dirS = Math.sin(this.dirAngle);
    // Stepping round on the spot only counts while there is no travel to speak of.
    const idleTurn = this.smoothSpeed < 0.55 ? this.turnRate : 0;
    this.turnStepRate += (idleTurn - this.turnStepRate) * (1 - Math.exp(-9 * dt));

    this.selectGait();

    // Distance-driven phase — this is what stops foot skating. A side-step and
    // a backpedal cover less ground per stride than a stride forward, so the
    // cadence has to come up or the feet skate exactly as they would have.
    const dirStride = 0.62 + 0.38 * Math.abs(this.dirF);
    const stride = Math.max(0.45, this.gait.stride * dirStride * this.style.stride);
    const cadenceFloor = this.locoWeight > 0.02 && this.smoothSpeed > 0.15 ? 0.32 : 0;
    // Turning on the spot advances the cycle from yaw rate instead of speed.
    const turnCadence = Math.min(1.35, Math.abs(this.turnStepRate) * 0.34);
    const rate = Math.max(cadenceFloor, this.smoothSpeed / stride, turnCadence);
    const before = this.phase;
    this.phase = (this.phase + rate * dt) % 1;
    if (this.state === 'locomotion' || this.state === 'crouch') {
      this.emitFootfalls(before, this.phase, rate * dt);
    }

    if (this.shotT > 0) {
      this.shotT -= dt;
      if (this.shotT <= 0) {
        this.shotT = 0;
        if (this.state === 'die') this.state = 'ragdoll';
        else if (this.state !== 'ragdoll') this.request(this.requested);
      }
    }

    this.evaluate(this.work);

    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / Math.max(1e-4, this.blendDur));
      const t = smoothstep(this.blendT);
      this.pose.blend(this.prev, this.work, t);
    } else {
      this.pose.copy(this.work);
    }

    this.updateLook(dt);
  }

  private selectGait(): void {
    if (this.state === 'crouch') {
      const t = THREE.MathUtils.clamp(this.smoothSpeed / 1.5, 0, 1);
      this.gait = lerpGait(CROUCH_IDLE_GAIT, CROUCH_WALK_GAIT, t, this.gaitScratch);
      this.locoWeight = t;
      return;
    }
    const s = this.smoothSpeed;
    let i = 0;
    while (i < LOCOMOTION_LADDER.length - 2 && s > LOCOMOTION_LADDER[i + 1].speed) i++;
    const a = LOCOMOTION_LADDER[i];
    const b = LOCOMOTION_LADDER[i + 1];
    const t = THREE.MathUtils.clamp((s - a.speed) / Math.max(0.001, b.speed - a.speed), 0, 1);
    this.gait = lerpGait(a, b, t, this.gaitScratch);
    this.locoWeight = THREE.MathUtils.clamp(s / 0.85, 0, 1);
  }

  private emitFootfalls(p0: number, p1: number, delta: number): void {
    if (!this.onFootfall || this.locoWeight < 0.12 || !this.grounded || delta <= 0) return;
    const crossed = (target: number): boolean => {
      const a = p0 % 1;
      const b = a + delta;
      const t = target < a ? target + 1 : target;
      return t >= a && t < b;
    };
    const intensity = THREE.MathUtils.clamp(this.smoothSpeed / 7, 0.18, 1);
    if (crossed(0)) this.onFootfall('left', this.footWorld(0), intensity);
    if (crossed(0.5)) this.onFootfall('right', this.footWorld(1), intensity);
    void p1;
  }

  private _foot = new THREE.Vector3();
  private footWorld(i: number): THREE.Vector3 {
    const b = i === 0 ? this.rig.byName.footL : this.rig.byName.footR;
    return this._foot.setFromMatrixPosition(b.matrixWorld);
  }

  /* ---------------- clip evaluation ---------------- */

  private evaluate(out: Pose): void {
    out.identity();
    switch (this.state) {
      case 'locomotion':
      case 'crouch':
        this.gaitClip(out);
        break;
      case 'jump': this.jumpClip(out); break;
      case 'fall': this.fallClip(out); break;
      case 'land': this.landClip(out); break;
      case 'sit': this.sitClip(out, false); break;
      case 'drive': this.sitClip(out, true); break;
      case 'board': this.boardClip(out); break;
      case 'stagger': this.staggerClip(out); break;
      case 'punch': this.punchClip(out); break;
      case 'die': this.dieClip(out); break;
      case 'ragdoll': break;
    }
    if (this.state !== 'ragdoll') this.additive(out);
  }

  /**
   * Idle / walk / jog / sprint / crouch, all from one parameterised gait —
   * STEERED BY THE DIRECTION OF TRAVEL.
   *
   * A 2D locomotion set is normally four recorded clips (fwd / back / left /
   * right) cross-faded on a blend square. There is no mocap here, so the same
   * result is reached analytically: the gait is authored once in the sagittal
   * plane and then projected onto the travel vector.
   *
   *   - the FORWARD component scales every sagittal channel (thigh pitch, ankle
   *     push-off, forward lean, arm swing) and, when it goes negative, plays the
   *     leg cycle time-REVERSED, which is what a backpedal physically is: the
   *     same limb trajectory traced the other way, toe-down first, heel last.
   *   - the STRAFE component drives hip abduction/adduction — the legs scissor
   *     sideways instead of fore/aft — plus a lateral lean and a wider arm
   *     carriage, which is what a side-step looks like.
   *   - both blend continuously, so a diagonal is a genuine diagonal rather
   *     than a snap between two clips, and every speed tier (walk / jog /
   *     sprint) inherits the direction because it is one gait, not twelve.
   *
   * Turning on the spot is folded in through `turnStep`: with no travel the
   * lateral channel is driven by yaw rate instead, so the feet shuffle round
   * rather than the whole body sliding round a planted pair of boots.
   */
  private gaitClip(out: Pose): void {
    const g = this.gait;
    const st = this.style;
    const p = this.phase;
    const w = this.locoWeight;

    // Idle-only micro motion: slow weight shift onto alternating legs.
    const idleW = 1 - w;
    const shift = Math.sin(this.clock * 0.55 + this.seed * 4) * idleW;
    const sway = Math.sin(this.clock * 0.31 + this.seed * 9) * idleW;

    // Travel direction, smoothed in `update`.
    const fwd = this.dirF;
    const strafe = this.dirS;
    const back = fwd < 0;
    // Time-reverse the cycle when backing up. cos() is even, so the thigh swing
    // is untouched; the knee and ankle lobes mirror, which is exactly the
    // difference between a heel strike and a toe strike.
    const rev = (x: number): number => (back ? (1 - x + 1) % 1 : x);
    const sag = Math.abs(fwd);
    const lat = Math.abs(strafe);
    // In-place turning: no travel, but the feet still have to step round.
    const turnStep = THREE.MathUtils.clamp(Math.abs(this.turnStepRate) * 0.42, 0, 1) * (1 - w);
    const latDrive = strafe * lat + (turnStep > 0 ? Math.sign(this.turnStepRate) * turnStep : 0);
    const cycle = Math.max(w, turnStep * 0.75);

    /* ---- this person's stride ----
     *
     * Phase is advanced by distance / stride, so a long strider MUST sweep a
     * proportionally longer arc with the leg or the foot slides. Held to 35% +
     * 65% of the stride multiplier so an extreme roll never produces a goose
     * step; the residual slip is smaller than the slip the shared gait already
     * carries. */
    const legK = 0.35 + 0.65 * st.stride;
    const thighA = g.thighA * legK;
    const ankPush = g.ankPush * legK;

    /* ---- the antalgic hitch ----
     *
     * A limp is not an asymmetric leg, it is a body avoiding a leg: stance on
     * the sore side is cut short, the pelvis drops away from it, the trunk
     * lurches over it to take the load off, and the body sinks as it lands.
     * All four come off one lobe centred on the sore leg's stance. */
    const soreStance = st.limpSide === 0 ? p : (p + 0.5) % 1;
    const limpLoad = st.limp > 0 ? st.limp * lobe(soreStance, 0.22, 0.17) * cycle * sag : 0;
    const limpSgn = st.limpSide === 0 ? 1 : -1;

    /* ---- legs ---- */
    for (let side = 0; side < 2; side++) {
      const lp0 = side === 0 ? p : (p + 0.5) % 1;
      const lp = rev(lp0);
      const sgn = side === 0 ? 1 : -1;
      const thigh = side === 0 ? BI.thighL : BI.thighR;
      const shin = side === 0 ? BI.shinL : BI.shinR;
      const foot = side === 0 ? BI.footL : BI.footR;
      const toe = side === 0 ? BI.toeL : BI.toeR;
      // The sore leg is kept stiffer and does less work; the sound one takes up
      // the slack, which is why a limp is visible from behind at fifty metres.
      const isSore = side === st.limpSide;
      const sore = isSore ? st.limp : 0;
      // Stance is cut short on the sore side and lengthened on the sound one.
      const duty = g.duty + (isSore ? -0.09 : 0.06) * st.limp;

      const swingC = Math.cos(TAU * lp);
      const thighPitch = g.thighBias * (back ? -0.4 : 1)
        + thighA * (1 - sore * 0.30) * swingC * w * sag * (back ? -1 : 1)
        + idleW * (0.02 + shift * sgn * 0.03);
      const kneeFlex = g.kneeBase
        + (g.kneeLoad * lobe(lp, 0.14, 0.11) + g.kneeSwing * (1 - sore * 0.45) * lobe(lp, 0.76, 0.135)) * cycle
          * Math.max(sag, lat * 0.55, turnStep)
        + idleW * (0.02 - shift * sgn * 0.05);
      const anklePitch =
        (-ankPush * (1 - sore * 0.5) * lobe(lp, duty - 0.03, 0.075) + g.ankLift * lobe(lp, 0.86, 0.13)) * w * sag
        - kneeFlex * 0.18 + thighPitch * 0.10;
      const toePitch = -ankPush * 0.9 * lobe(lp, duty - 0.01, 0.06) * w * sag;

      // Lateral channel. +Z rotation swings the tip to the character's RIGHT,
      // so travelling LEFT (strafe > 0) needs a negative term. One leg reaches
      // out while the other closes up — that is a side-step.
      const abduct = -latDrive * (thighA * 0.72) * swingC * Math.max(cycle, turnStep);

      // Stance/swing plant weight for foot IK.
      const planted = lp < duty ? 1 : 0;
      const edge = 0.06;
      const pw = planted
        ? THREE.MathUtils.smoothstep(Math.min(lp, duty - lp) / edge, 0, 1)
        : 0;
      this.footPlant[side] = cycle < 0.05 ? 1 : Math.max(pw, 1 - cycle);

      out.setEuler(
        thigh,
        thighPitch,
        sgn * 0.02 * w,
        sgn * (0.02 + g.hipRoll * 0.25 * swingC * w * sag) + abduct,
      );
      out.setEuler(shin, -kneeFlex, 0, 0);
      // The foot's long axis points FORWARD, so its local +Z swings the toe to
      // the character's left — the reverse of every downward-pointing bone in
      // the rig. `sgn * toeOut` is therefore genuinely toes-out, which is where
      // a relaxed human foot sits and where these used to be very slightly not.
      out.setEuler(foot, anklePitch, 0, sgn * st.toeOut - abduct * 0.35);
      out.setEuler(toe, toePitch, 0, 0);
    }

    /* ---- pelvis ---- */
    const bob = -g.bob * st.bounce * 0.5 * Math.cos(2 * TAU * p) * cycle - limpLoad * 0.045;
    const latShift = g.lateral * st.sway * Math.cos(TAU * p) * w + idleW * shift * 0.016;
    out.root.set(latShift, bob, 0);
    // Pelvis/chest counter-rotation belongs to a forward gait; a side-step has
    // almost none of it, and a backpedal has it reversed.
    const twist = w * fwd;
    const pelvisYaw = -g.pelvisYaw * st.swagger * Math.cos(TAU * p) * twist;
    const pelvisRoll = -g.hipRoll * Math.cos(TAU * p) * w * sag + idleW * shift * 0.03
      // The unsupported hip drops away from the sore leg (Trendelenburg).
      + limpLoad * 0.20 * limpSgn;
    const leanIn = THREE.MathUtils.clamp(this.lean * 0.09, -0.16, 0.16) * Math.min(1, this.smoothSpeed / 3);
    // Forward lean follows travel: leaning FORWARD while backing up is the
    // single loudest tell that a backpedal is a mis-used forward clip.
    const bodyLean = g.lean * fwd;
    // Lean into the side-step, the way anyone carrying their weight sideways does.
    const sideLean = -strafe * lat * 0.16 * w;
    /* The trunk pitches twice a cycle: it is thrown forward as the body vaults
     * over the stance leg and checks at heel strike. Small — a couple of
     * degrees — but its absence is most of what "rigid torso" means, because
     * the spine is otherwise a rigid link between two things that do move. */
    const trunkPitch = g.bob * st.bounce * 0.85 * Math.cos(2 * TAU * (p - 0.07)) * cycle * sag;
    out.setEuler(BI.hips, bodyLean * 0.35, pelvisYaw, pelvisRoll + leanIn + sideLean * 0.35);

    /* ---- spine ----
     *
     * THE THORAX LAGS THE PELVIS. The two counter-rotate, but not as a rigid
     * see-saw: the spine is a torsion spring and the shoulders arrive about an
     * eighth of a cycle after the hips. Driving both off the same cosine — the
     * way this did — produces a body hinged at the waist, which reads as
     * mechanical however large you make the angles.
     *
     * The trunk also side-bends over the loaded leg, opposite the pelvic drop,
     * which is what keeps the head over the feet.
     */
    const chestYaw = g.chestYaw * st.swagger * Math.cos(TAU * (p - 0.12)) * twist;
    const trunkBend = -pelvisRoll * 0.42 - limpLoad * 0.16 * limpSgn;
    const stoop = st.stoop * sag;
    out.setEuler(
      BI.spine,
      bodyLean * 0.30 + stoop * 0.42 + trunkPitch * 0.55,
      chestYaw * 0.45,
      trunkBend * 0.85 + idleW * sway * 0.012 + sideLean * 0.3,
    );
    out.setEuler(
      BI.chest,
      bodyLean * 0.24 + stoop * 0.34 + trunkPitch * 0.35,
      chestYaw * 0.55,
      trunkBend * 0.55 - leanIn * 0.5 + sideLean * 0.25,
    );
    out.setEuler(BI.upperChest, bodyLean * 0.14 + stoop * 0.24, chestYaw * 0.30, trunkBend * 0.30);

    /* ---- head stabilisation ----
     *
     * The head is the one part of a walking person that barely moves: the
     * vestibulo-ocular reflex holds it level while everything under it
     * oscillates. So the neck cancels most of the trunk's bob, pitch, twist and
     * side-bend — and the stoop, or a stooped pedestrian would walk staring at
     * his own boots. What is left over is this person's own carriage. */
    const totalLean = bodyLean * (0.35 + 0.30 + 0.24 + 0.14) + stoop;
    out.setEuler(
      BI.neck,
      -totalLean * 0.55 - g.headBob * bob * 1.2 - trunkPitch * 0.75 + st.headDown * 0.45,
      -chestYaw * 0.62,
      -trunkBend * 0.55 + st.headTilt * 0.45,
    );
    out.setEuler(
      BI.head,
      -totalLean * 0.35 - trunkPitch * 0.35 + st.headDown * 0.55
        + idleW * Math.sin(this.clock * 0.23 + this.seed) * 0.02,
      -chestYaw * 0.35,
      -trunkBend * 0.25 + st.headTilt * 0.55,
    );

    /* ---- arms ----
     *
     * ARM SWING IS NOT A DECORATION. It is the counterweight that cancels the
     * angular momentum the legs put into the body, and it is the first thing an
     * eye uses to decide whether it is looking at a person or at a puppet on a
     * stick. Three things were wrong here:
     *
     *  1. THE ELBOW WAS PHASED BACKWARDS. `max(0, sgn*cos)` peaks when the
     *     same-side LEG is forward — which is exactly when the arm is BEHIND
     *     the body. So the elbow straightened on the forward swing and folded
     *     on the backswing, and the hand's travel cancelled a large part of the
     *     shoulder's. Measured on a walking pedestrian, the hand covered 375 mm
     *     fore-and-aft while the shoulder was authored for well over half a
     *     metre. The elbow now flexes THROUGH the forward swing, lagging it
     *     slightly, and extends behind — which is what an arm does.
     *  2. THE SHOULDER GIRDLE WAS BOLTED DOWN. The clavicle carried a constant
     *     and nothing else. It now protracts with the arm and rides the trunk's
     *     side-bend, so the shoulder line lives instead of translating.
     *  3. EVERYONE'S ARMS WERE THE SAME. Amplitude, carriage and left/right
     *     asymmetry all come off the ped's own seed now.
     */
    const armPh = rev(p);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const clav = side === 0 ? BI.clavicleL : BI.clavicleR;
      const upper = side === 0 ? BI.upperArmL : BI.upperArmR;
      const fore = side === 0 ? BI.forearmL : BI.forearmR;
      const hand = side === 0 ? BI.handL : BI.handR;
      // +1 = fully forward. Counter-phased to the same-side leg, and only as
      // far as the sagittal travel warrants: side-stepping does not swing the
      // arms fore and aft.
      const norm = -sgn * Math.cos(TAU * armPh);
      // The arm on the sore side is held still — people guard a limp with it.
      const sideArm = st.arm * (1 + sgn * st.armAsym) * (side === st.limpSide ? 1 - st.limp * 0.45 : 1);
      const swing = g.armA * sideArm * norm * w * sag * (back ? -0.55 : 1);
      const armPitch = (g.armBias + st.armCarriage * 0.20) * (back ? 0.5 : 1) + swing;
      // Flexion peaks a tenth of a cycle after the arm passes the hip on its
      // way forward, and bottoms out at full extension behind.
      const flex = Math.max(0, -sgn * Math.cos(TAU * (armPh - 0.10)));
      const elbowFlex = g.elbow + st.armCarriage + g.elbowSwing * flex * w * sag;
      // Arms tuck in as speed rises; they hang wide when idle, and wider still
      // when the body is carrying itself sideways.
      const tuck = -0.13 * w * sag - 0.02 + lat * 0.10 * w + st.armOut;
      out.setEuler(
        clav,
        // Protraction: the whole shoulder girdle travels with the arm.
        -g.shoulderDrop * 0.4 + swing * 0.17,
        swing * 0.09,
        sgn * (g.shoulderDrop + idleW * shift * 0.02 - trunkBend * 0.45) + st.shoulderTilt,
      );
      out.setEuler(upper, armPitch, sgn * -0.10 * w * sag, sgn * (tuck + Math.abs(swing) * 0.10));
      out.setEuler(fore, elbowFlex, sgn * 0.22 * w, sgn * 0.05);
      // The hand lags the forearm — a wrist is not welded.
      out.setEuler(hand, -0.04 + swing * 0.20 - elbowFlex * 0.10, 0, sgn * 0.06);
    }

    this.handsClip(out, 0, 0);
  }

  private jumpClip(out: Pose): void {
    const rise = THREE.MathUtils.clamp(this.vertical / 5, -1, 1);
    const t = THREE.MathUtils.clamp(1 - rise, 0, 1);
    out.root.set(0, 0.02, 0);
    out.setEuler(BI.hips, 0.10, 0, 0);
    out.setEuler(BI.spine, 0.06, 0, 0);
    out.setEuler(BI.chest, 0.05, 0, 0);
    out.setEuler(BI.neck, -0.10, 0, 0);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, 0.55 - t * 0.30 + sgn * 0.05, 0, sgn * 0.06);
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -(0.95 - t * 0.35) - sgn * 0.08, 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, -0.30, 0, 0);
      out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.12, 0, sgn * 0.14);
      out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, -1.25 + t * 0.35, 0, sgn * -0.34);
      out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 0.55, 0, 0);
    }
    this.footPlant[0] = 0;
    this.footPlant[1] = 0;
  }

  private fallClip(out: Pose): void {
    const t = THREE.MathUtils.clamp(-this.vertical / 12, 0, 1);
    const flail = Math.sin(this.clock * 7.5) * 0.10 * t;
    out.setEuler(BI.hips, -0.10 - t * 0.12, 0, 0);
    out.setEuler(BI.spine, -0.06, 0, flail * 0.4);
    out.setEuler(BI.chest, -0.04, 0, -flail * 0.3);
    out.setEuler(BI.neck, 0.14 + t * 0.10, 0, 0);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, -0.18 + sgn * (0.16 + t * 0.12), 0, sgn * 0.10);
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -(0.35 + t * 0.35) + sgn * 0.16, 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, -0.22, 0, 0);
      out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.16, 0, sgn * 0.20);
      out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, -0.55 - t * 0.35 + flail * sgn, 0, sgn * -0.62);
      out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 0.72 + t * 0.25, 0, 0);
    }
    this.footPlant[0] = 0;
    this.footPlant[1] = 0;
  }

  private landClip(out: Pose): void {
    const dur = ONE_SHOT_DURATION.land!;
    const t = 1 - THREE.MathUtils.clamp(this.shotT / dur, 0, 1);
    // Fast compression, slower recovery.
    const c = t < 0.32 ? t / 0.32 : 1 - (t - 0.32) / 0.68;
    const comp = Math.sin(c * Math.PI * 0.5);
    out.root.set(0, -0.26 * comp, 0);
    out.setEuler(BI.hips, 0.30 * comp, 0, 0);
    out.setEuler(BI.spine, 0.16 * comp, 0, 0);
    out.setEuler(BI.chest, 0.10 * comp, 0, 0);
    out.setEuler(BI.neck, -0.22 * comp, 0, 0);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, 0.70 * comp + sgn * 0.06, 0, sgn * (0.05 + 0.10 * comp));
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -1.35 * comp, 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, 0.52 * comp, 0, 0);
      out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.10 * comp, 0, sgn * 0.10 * comp);
      out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, -0.45 * comp, 0, sgn * -0.35 * comp);
      out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 0.55 + 0.45 * comp, 0, 0);
    }
    this.footPlant[0] = 1;
    this.footPlant[1] = 1;
  }

  private sitClip(out: Pose, driving: boolean): void {
    const m = this.m;
    // Hips drop from standing height to seat height; the owner places the root
    // at the seat floor.
    out.root.set(0, -(m.hipY - 0.44), driving ? 0.02 : 0.0);
    const breathe = Math.sin(this.clock * 1.35 + this.seed) * 0.012;
    out.setEuler(BI.hips, -0.10, 0, 0);
    out.setEuler(BI.spine, 0.10 + breathe, 0, 0);
    out.setEuler(BI.chest, 0.06, 0, 0);
    out.setEuler(BI.upperChest, 0.02, 0, 0);
    out.setEuler(BI.neck, -0.10, 0, 0);
    out.setEuler(BI.head, -0.04, 0, 0);

    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, 1.52, 0, sgn * (driving ? 0.12 : 0.18));
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -1.30 + (driving && side === 1 ? 0.18 : 0), 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, -0.22, 0, sgn * 0.05);
      out.setEuler(side === 0 ? BI.toeL : BI.toeR, 0, 0, 0);
    }

    if (driving) {
      const st = THREE.MathUtils.clamp(this.steer, -1, 1);
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        // Hands up and forward onto the wheel; steering rolls them opposite.
        out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.16, 0, sgn * 0.16);
        out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, 0.92 + sgn * st * 0.30, sgn * -0.22, sgn * -0.30);
        out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 1.05 - sgn * st * 0.28, sgn * 0.30, sgn * 0.10);
        out.setEuler(side === 0 ? BI.handL : BI.handR, 0.10, 0, sgn * 0.30);
      }
      out.setEuler(BI.upperChest, 0.02, -st * 0.06, 0);
    } else {
      for (let side = 0; side < 2; side++) {
        const sgn = side === 0 ? 1 : -1;
        out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.06, 0, sgn * 0.05);
        out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, 0.45, 0, sgn * -0.06);
        out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 0.75, sgn * 0.18, 0);
        out.setEuler(side === 0 ? BI.handL : BI.handR, -0.10, 0, 0);
      }
    }
    this.footPlant[0] = 0;
    this.footPlant[1] = 0;
    // Hands closed on the wheel rim when driving, loose in the lap when not.
    this.handsClip(out, driving ? WHEEL_GRIP : 0.14, driving ? WHEEL_GRIP : 0.14);
  }

  /**
   * ENTER / EXIT A VEHICLE.
   *
   * Four beats, driven by the mover through `BoardPose`: stand at the door,
   * hand on the handle and pull, swing the body down into the seat, reach back
   * and pull the door shut. `sit` blends the whole skeleton from standing to
   * the seated pose; `reach` is a separate additive lobe on the near arm so the
   * door work can overlap the sit rather than queue behind it.
   *
   * The near leg leads into the footwell and the far leg follows, which is the
   * detail that stops it reading as a body being lowered by a crane. The pelvis
   * carries a small yaw toward the door so the character enters at an angle,
   * the way a person actually gets into a car.
   */
  private boardClip(out: Pose): void {
    const b = this.board;
    if (!b) return this.sitClip(out, true);
    const m = this.m;
    const sit = THREE.MathUtils.clamp(b.sit, 0, 1);
    const stand = 1 - sit;
    const reach = THREE.MathUtils.clamp(b.reach, 0, 1);
    // side = +1 when the door is on the character's LEFT.
    const s = b.side >= 0 ? 1 : -1;
    const nearIsLeft = s > 0;
    const breathe = Math.sin(this.clock * 1.35 + this.seed) * 0.010;

    // `mid` peaks at 1 halfway through the transfer and is 0 at both ends: the
    // twist, the duck and the sideways shift all belong to the middle of the
    // move and none of them belong to standing or to sitting.
    const mid = 4 * sit * stand;

    // Hips travel from standing height down to seat height.
    out.root.set(-s * 0.06 * mid, -(m.hipY - 0.44) * sit, 0.02 * sit);
    // Turned toward the door on the way in, squared up once seated.
    const enterYaw = s * 0.42 * mid;
    out.setEuler(BI.hips, -0.10 * sit + 0.05 * stand, enterYaw, s * 0.10 * mid);
    out.setEuler(BI.spine, 0.10 * sit + breathe, -enterYaw * 0.4, 0);
    // Ducking under the roof line is most of what sells getting in.
    out.setEuler(BI.chest, 0.06 * sit + 0.30 * mid, -enterYaw * 0.3, 0);
    out.setEuler(BI.upperChest, 0.02, 0, 0);
    out.setEuler(BI.neck, -0.10 * sit + 0.22 * mid, 0, 0);
    // He looks where his hand is going.
    out.setEuler(BI.head, -0.04, s * 0.28 * reach, 0);

    /* ---- legs: the near one leads into the footwell ---- */
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const near = (side === 0) === nearIsLeft;
      // The leading leg is ahead of the trailing one through the swing.
      const lead = near ? Math.min(1, sit * 1.55) : Math.max(0, sit * 1.55 - 0.55) / 0.45;
      const l = THREE.MathUtils.clamp(lead, 0, 1);
      const swing = 4 * l * (1 - l);
      out.setEuler(
        side === 0 ? BI.thighL : BI.thighR,
        1.52 * l + 0.06 * (1 - l),
        near ? -s * 0.22 * swing : 0,
        sgn * 0.12 * l + (near ? -s * 0.30 * swing : 0),
      );
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -1.30 * l - 0.16 * (1 - l) + (side === 1 ? 0.18 * l : 0), 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, -0.22 * l, 0, sgn * 0.05);
      out.setEuler(side === 0 ? BI.toeL : BI.toeR, 0, 0, 0);
    }

    /* ---- arms: the near hand works the door, the far hand takes the sill ---- */
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const near = (side === 0) === nearIsLeft;
      const clav = side === 0 ? BI.clavicleL : BI.clavicleR;
      const upper = side === 0 ? BI.upperArmL : BI.upperArmR;
      const fore = side === 0 ? BI.forearmL : BI.forearmR;
      const hand = side === 0 ? BI.handL : BI.handR;

      if (near) {
        // Out, down and across to the handle; the pull-shut starts inboard and
        // sweeps out, which is why `closing` flips the lateral term.
        const dir = b.closing ? -1 : 1;
        out.setEuler(clav, -0.10 - 0.22 * reach, 0, sgn * (0.10 + 0.20 * reach));
        out.setEuler(upper, 0.30 * sit + (0.95 + 0.35 * sit) * reach, sgn * -0.30 * reach * dir, sgn * (-0.20 - 0.55 * reach));
        out.setEuler(fore, 0.75 * sit + 0.55 * reach, sgn * (0.18 + 0.35 * reach), sgn * 0.05);
        out.setEuler(hand, -0.10 + 0.35 * reach, 0, sgn * (0.10 + 0.25 * reach));
        this.grip[side] = Math.max(this.grip[side] * 0.6, reach);
      } else {
        // Far hand braces on the seat / wheel rim.
        out.setEuler(clav, -0.06 - 0.06 * sit, 0, sgn * 0.05);
        out.setEuler(upper, 0.45 * sit + 0.30 * stand, 0, sgn * (-0.06 - 0.10 * sit));
        out.setEuler(fore, 0.75 * sit + 0.35 * stand, sgn * 0.18, 0);
        out.setEuler(hand, -0.10, 0, 0);
        this.grip[side] = 0.35 * sit;
      }
    }

    this.footPlant[0] = stand * (nearIsLeft ? 0.3 : 1);
    this.footPlant[1] = stand * (nearIsLeft ? 1 : 0.3);
    this.handsClip(out, this.grip[0], this.grip[1]);
  }

  private staggerClip(out: Pose): void {
    const dur = ONE_SHOT_DURATION.stagger!;
    const t = 1 - THREE.MathUtils.clamp(this.shotT / dur, 0, 1);
    const hit = Math.exp(-t * 6.5);
    const recover = 1 - hit;
    const wob = Math.sin(t * 19) * hit;
    out.root.set(wob * 0.03, -0.05 * hit, -0.06 * hit);
    out.rootYaw = wob * 0.10;
    out.setEuler(BI.hips, -0.24 * hit + 0.06 * recover, wob * 0.10, wob * 0.09);
    out.setEuler(BI.spine, -0.28 * hit, wob * 0.12, -wob * 0.10);
    out.setEuler(BI.chest, -0.18 * hit, wob * 0.08, wob * 0.06);
    out.setEuler(BI.neck, 0.36 * hit, -wob * 0.14, 0);
    out.setEuler(BI.head, 0.22 * hit, 0, wob * 0.10);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, (sgn > 0 ? -0.42 : 0.34) * hit, 0, sgn * 0.16 * hit);
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -(0.30 + 0.5 * hit), 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, 0.12 * hit, 0, 0);
      out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.28 * hit, 0, sgn * 0.24 * hit);
      out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, -0.95 * hit + wob * sgn * 0.3, 0, sgn * -0.75 * hit);
      out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 0.85 + 0.5 * hit, 0, 0);
    }
    this.footPlant[0] = 0.4;
    this.footPlant[1] = 0.4;
  }

  private punchClip(out: Pose): void {
    const dur = ONE_SHOT_DURATION.punch!;
    const t = 1 - THREE.MathUtils.clamp(this.shotT / dur, 0, 1);
    // wind-up 0..0.34, strike 0.34..0.52, recover 0.52..1
    const wind = t < 0.34 ? t / 0.34 : 1 - THREE.MathUtils.clamp((t - 0.34) / 0.18, 0, 1);
    const ext = t < 0.34 ? 0 : t < 0.52 ? (t - 0.34) / 0.18 : 1 - (t - 0.52) / 0.48;
    const twist = -0.30 * wind + 0.34 * ext;

    out.root.set(0, -0.02 * wind, 0.05 * ext);
    out.setEuler(BI.hips, 0.05, twist * 0.75, 0);
    out.setEuler(BI.spine, 0.08 * ext, twist * 0.9, 0);
    out.setEuler(BI.chest, 0.06 * ext, twist * 1.1, 0);
    out.setEuler(BI.upperChest, 0.02, twist * 0.6, 0);
    out.setEuler(BI.neck, -0.06, -twist * 0.5, 0);

    // Right arm throws; left guards the face.
    out.setEuler(BI.clavicleR, -0.10 - 0.24 * ext, 0, -0.10 - 0.22 * ext);
    out.setEuler(BI.upperArmR, -0.30 * wind + 1.32 * ext, -0.35 * ext, -0.30 - 0.22 * ext);
    out.setEuler(BI.forearmR, 1.75 * (1 - ext) + 0.12, 0.30 * ext, 0);
    out.setEuler(BI.handR, 0.05, 0, -0.12);

    out.setEuler(BI.clavicleL, -0.14, 0, 0.14);
    out.setEuler(BI.upperArmL, 0.95 + 0.15 * wind, -0.20, -0.55);
    out.setEuler(BI.forearmL, 1.85, 0.55, 0);
    out.setEuler(BI.handL, 0.10, 0, 0.15);

    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, sgn > 0 ? 0.26 : -0.22, 0, sgn * 0.12);
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -0.34 - 0.10 * ext, 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, 0.10, 0, 0);
    }
    this.footPlant[0] = 1;
    this.footPlant[1] = 0.7;
    // Throwing hand closed, guard hand nearly so.
    this.handsClip(out, 0.75, 1);
  }

  private dieClip(out: Pose): void {
    const dur = ONE_SHOT_DURATION.die!;
    const t = 1 - THREE.MathUtils.clamp(this.shotT / dur, 0, 1);
    const buckle = THREE.MathUtils.smoothstep(t, 0, 0.55);
    const fold = THREE.MathUtils.smoothstep(t, 0.25, 1);
    out.root.set(0, -(this.m.hipY - 0.30) * fold, -0.05 * fold);
    out.setEuler(BI.hips, 0.30 * buckle - 0.55 * fold, 0.12 * fold, 0.20 * fold);
    out.setEuler(BI.spine, 0.35 * buckle + 0.25 * fold, 0.10 * fold, -0.18 * fold);
    out.setEuler(BI.chest, 0.28 * buckle, 0, 0.12 * fold);
    out.setEuler(BI.neck, 0.35 * fold, 0, -0.22 * fold);
    out.setEuler(BI.head, 0.30 * fold, 0.15 * fold, 0);
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      out.setEuler(side === 0 ? BI.thighL : BI.thighR, 0.95 * buckle + 0.45 * fold, 0, sgn * 0.22 * fold);
      out.setEuler(side === 0 ? BI.shinL : BI.shinR, -(1.55 * buckle + 0.35 * fold), 0, 0);
      out.setEuler(side === 0 ? BI.footL : BI.footR, 0.35 * buckle, 0, 0);
      out.setEuler(side === 0 ? BI.clavicleL : BI.clavicleR, -0.15 * fold, 0, sgn * 0.12 * fold);
      out.setEuler(side === 0 ? BI.upperArmL : BI.upperArmR, -0.35 * buckle - 0.55 * fold, 0, sgn * -0.45 * fold);
      out.setEuler(side === 0 ? BI.forearmL : BI.forearmR, 0.60 + 0.55 * fold, 0, 0);
    }
    this.footPlant[0] = 0;
    this.footPlant[1] = 0;
  }

  /**
   * FINGERS. `grip` is 0 for a relaxed hand and 1 for a closed fist; the wheel
   * sits around 0.8, which wraps the fingers without driving the fingertips
   * through the palm.
   *
   * The bind pose already carries a natural curl (see `DIGIT_SPEC.curl` in
   * rig.ts), so 0 is a hand at rest and not a flat plank. The distal joint
   * closes further than the proximal, which is what makes a fist read as a
   * fist; the thumb closes last and across, over the fingers.
   *
   * Skipped entirely when the actor is not showing its hands: the pose limit
   * stops at the core 22 bones and the fingers stay in bind.
   */
  private handsClip(out: Pose, gripL: number, gripR: number): void {
    if (out.limit <= CORE_BONE_COUNT) return;
    const life = Math.sin(this.clock * 0.9 + this.seed * 5) * 0.02;
    for (let h = 0; h < 2; h++) {
      const digits = h === 0 ? DIGITS.L : DIGITS.R;
      const g = THREE.MathUtils.clamp(h === 0 ? gripL : gripR, 0, 1);
      // Fingers close INTO the palm. Every bone's local +Z swings its tip
      // toward the character's left, and the palms face inward, so the closing
      // direction is -Z on the left hand and +Z on the right. Curling on +X —
      // the sagittal channel every other bone in this rig uses — would flick
      // the fingers forward past the thumb instead.
      const inward = h === 0 ? -1 : 1;
      for (let d = 0; d < digits.length; d++) {
        const [prox, dist] = digits[d];
        if (d === 0) {
          // Thumb: less flexion than the fingers, and it closes over them last.
          out.setEuler(prox, 0, 0, inward * 0.34 * g);
          out.setEuler(dist, 0, 0, inward * 0.62 * g);
          continue;
        }
        // Little finger curls furthest, index least — a relaxed hand is a
        // cascade, not four identical hooks.
        const bias = 0.86 + d * 0.06;
        out.setEuler(prox, 0, 0, inward * (0.86 * g + life * (1 - g)) * bias);
        out.setEuler(dist, 0, 0, inward * (1.02 * g + life * 0.6 * (1 - g)) * bias);
      }
    }
  }

  /** Always-on layers: breathing, and a hint of life in the fingers/neck. */
  private additive(out: Pose): void {
    const br = Math.sin(this.clock * 1.15 + this.seed * 2.7);
    const br2 = Math.sin(this.clock * 1.15 + this.seed * 2.7 + 0.5);
    const rate = this.state === 'locomotion' ? 1 + this.smoothSpeed * 0.16 : 1;
    const amp = 0.011 * rate;
    out.addEuler(BI.spine, -br * amp, 0, 0);
    out.addEuler(BI.chest, -br2 * amp * 1.4, 0, 0);
    out.addEuler(BI.neck, br * amp * 0.8, 0, 0);
    out.addEuler(BI.clavicleL, br2 * amp * 0.9, 0, br2 * amp * 1.2);
    out.addEuler(BI.clavicleR, br2 * amp * 0.9, 0, -br2 * amp * 1.2);
  }

  /* ---------------- apply ---------------- */

  applyTo(rig: Rig): void {
    const q = this.pose.q;
    const n = this.pose.limit;
    for (let i = 0; i < n; i++) {
      const b = rig.bones[i];
      const r = rig.rest[i];
      const o = i * 4;
      // bone.local = rest * delta   (delta lives in the bone's rest frame)
      const ax = r.x, ay = r.y, az = r.z, aw = r.w;
      const bx = q[o], by = q[o + 1], bz = q[o + 2], bw = q[o + 3];
      b.quaternion.set(
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
      );
    }
    const hips = rig.bones[0];
    hips.position.copy(rig.restPos[0]).add(this.pose.root);
    if (this.pose.rootYaw !== 0) {
      _yawQ.setFromAxisAngle(_yAxis, this.pose.rootYaw);
      hips.quaternion.premultiply(_yawQ);
    }
    if (this.lookTarget && this.state !== 'ragdoll') {
      applyLookAt(rig, this.lookYaw, this.lookPitch);
    }
  }

  private updateLook(dt: number): void {
    let ty = 0;
    let tp = 0;
    if (this.lookTarget) {
      const head = this.rig.points.joint.head;
      const dx = this.lookTarget.x - head.x;
      const dy = this.lookTarget.y - head.y;
      const dz = this.lookTarget.z - head.z;
      const h = Math.hypot(dx, dz) || 1e-4;
      ty = THREE.MathUtils.clamp(Math.atan2(dx, dz), -1.35, 1.35) * this.lookWeight;
      tp = THREE.MathUtils.clamp(Math.atan2(dy, h), -0.55, 0.62) * this.lookWeight;
    }
    const k = 1 - Math.exp(-8 * dt);
    this.lookYaw += (ty - this.lookYaw) * k;
    this.lookPitch += (tp - this.lookPitch) * k;
  }

  /** Plant the feet on the real ground. Called by the actor at close range. */
  solveFootIk(rig: Rig, root: THREE.Object3D, phys: PhysicsWorld): void {
    solveFootIk(rig, root, phys, this.footPlant, this.ikState);
  }
}

const _yawQ = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}
