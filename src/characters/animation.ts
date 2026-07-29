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
import type { LocomotionState } from '../core/services';
import type { PhysicsWorld } from '../physics/physics';
import { applyLookAt, solveFootIk, type FootIkState } from './ik';
import { BI, BONE_COUNT, type BodyMetrics, type Rig } from './rig';

/* ------------------------------------------------------------------ */
/* Pose                                                                */
/* ------------------------------------------------------------------ */

/** Per-bone rotation delta relative to the bind pose, plus a root offset. */
export class Pose {
  readonly q = new Float32Array(BONE_COUNT * 4);
  readonly root = new THREE.Vector3();
  /** Extra yaw applied to the whole body (staggering, drive lean). */
  rootYaw = 0;

  constructor() {
    this.identity();
  }

  identity(): void {
    const q = this.q;
    for (let i = 0; i < BONE_COUNT; i++) {
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
    for (let i = 0; i < BONE_COUNT; i++) {
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

const WALK_GAIT: Gait = {
  speed: 1.7, stride: 1.44, duty: 0.62,
  thighA: 0.42, thighBias: 0.03, kneeLoad: 0.30, kneeSwing: 1.04, kneeBase: 0.06,
  ankPush: 0.40, ankLift: 0.24, bob: 0.030, lateral: 0.022, hipRoll: 0.055,
  pelvisYaw: 0.10, chestYaw: 0.085, armA: 0.36, armBias: 0.02, elbow: 0.26, elbowSwing: 0.20,
  lean: 0.045, shoulderDrop: 0.04, headBob: 0.35,
};

const JOG_GAIT: Gait = {
  speed: 4.3, stride: 2.34, duty: 0.40,
  thighA: 0.62, thighBias: 0.06, kneeLoad: 0.46, kneeSwing: 1.62, kneeBase: 0.10,
  ankPush: 0.54, ankLift: 0.36, bob: 0.055, lateral: 0.015, hipRoll: 0.062,
  pelvisYaw: 0.14, chestYaw: 0.135, armA: 0.74, armBias: 0.10, elbow: 1.18, elbowSwing: 0.34,
  lean: 0.135, shoulderDrop: 0.02, headBob: 0.55,
};

const SPRINT_GAIT: Gait = {
  speed: 7.4, stride: 3.20, duty: 0.30,
  thighA: 0.88, thighBias: 0.10, kneeLoad: 0.52, kneeSwing: 2.10, kneeBase: 0.12,
  ankPush: 0.64, ankLift: 0.44, bob: 0.072, lateral: 0.010, hipRoll: 0.070,
  pelvisYaw: 0.18, chestYaw: 0.175, armA: 1.08, armBias: 0.16, elbow: 1.58, elbowSwing: 0.42,
  lean: 0.27, shoulderDrop: 0.0, headBob: 0.66,
};

const CROUCH_WALK_GAIT: Gait = {
  speed: 1.4, stride: 0.95, duty: 0.66,
  thighA: 0.30, thighBias: 0.86, kneeLoad: 0.22, kneeSwing: 0.62, kneeBase: 1.28,
  ankPush: 0.22, ankLift: 0.18, bob: 0.016, lateral: 0.020, hipRoll: 0.040,
  pelvisYaw: 0.07, chestYaw: 0.06, armA: 0.20, armBias: 0.42, elbow: 0.95, elbowSwing: 0.10,
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
}

type Internal =
  | 'locomotion' | 'crouch' | 'jump' | 'fall' | 'land'
  | 'sit' | 'drive' | 'stagger' | 'punch' | 'die' | 'ragdoll';

const ONE_SHOT_DURATION: Partial<Record<Internal, number>> = {
  land: 0.34,
  stagger: 0.72,
  punch: 0.46,
  die: 1.15,
};

const BLEND_IN: Record<Internal, number> = {
  locomotion: 0.17, crouch: 0.22, jump: 0.09, fall: 0.15, land: 0.07,
  sit: 0.34, drive: 0.30, stagger: 0.07, punch: 0.06, die: 0.11, ragdoll: 0.0,
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

  private lookTarget: THREE.Vector3 | null = null;
  private lookWeight = 1;
  private lookYaw = 0;
  private lookPitch = 0;

  private ikState: FootIkState;

  constructor(rig: Rig, seed = 0) {
    this.rig = rig;
    this.m = rig.metrics;
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
    this.request(d.state);
  }

  request(s: LocomotionState): void {
    this.requested = s;
    const want = internalOf(s);
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
    const stride = Math.max(0.4, this.gait.stride);
    this.phase = (this.phase + (this.speed / stride) * dt) % 1;
  }

  update(dt: number): void {
    if (dt <= 0) dt = 1 / 60;
    this.clock += dt;

    // Speed smoothing keeps the gait blend from chattering on stick noise.
    const k = 1 - Math.exp(-11 * dt);
    this.smoothSpeed += (this.speed - this.smoothSpeed) * k;
    this.lean += (this.turnRate - this.lean) * (1 - Math.exp(-7 * dt));

    this.selectGait();

    // Distance-driven phase — this is what stops foot skating.
    const stride = Math.max(0.45, this.gait.stride);
    const cadenceFloor = this.locoWeight > 0.02 && this.smoothSpeed > 0.15 ? 0.32 : 0;
    const rate = Math.max(cadenceFloor, this.smoothSpeed / stride);
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
      case 'stagger': this.staggerClip(out); break;
      case 'punch': this.punchClip(out); break;
      case 'die': this.dieClip(out); break;
      case 'ragdoll': break;
    }
    if (this.state !== 'ragdoll') this.additive(out);
  }

  /** Idle / walk / jog / sprint / crouch, all from one parameterised gait. */
  private gaitClip(out: Pose): void {
    const g = this.gait;
    const p = this.phase;
    const w = this.locoWeight;

    // Idle-only micro motion: slow weight shift onto alternating legs.
    const idleW = 1 - w;
    const shift = Math.sin(this.clock * 0.55 + this.seed * 4) * idleW;
    const sway = Math.sin(this.clock * 0.31 + this.seed * 9) * idleW;

    /* ---- legs ---- */
    for (let side = 0; side < 2; side++) {
      const lp = side === 0 ? p : (p + 0.5) % 1;
      const sgn = side === 0 ? 1 : -1;
      const thigh = side === 0 ? BI.thighL : BI.thighR;
      const shin = side === 0 ? BI.shinL : BI.shinR;
      const foot = side === 0 ? BI.footL : BI.footR;
      const toe = side === 0 ? BI.toeL : BI.toeR;

      const thighPitch = g.thighBias + g.thighA * Math.cos(TAU * lp) * w
        + idleW * (0.02 + shift * sgn * 0.03);
      const kneeFlex = g.kneeBase
        + (g.kneeLoad * lobe(lp, 0.14, 0.11) + g.kneeSwing * lobe(lp, 0.76, 0.135)) * w
        + idleW * (0.02 - shift * sgn * 0.05);
      const anklePitch =
        (-g.ankPush * lobe(lp, g.duty - 0.03, 0.075) + g.ankLift * lobe(lp, 0.86, 0.13)) * w
        - kneeFlex * 0.18 + thighPitch * 0.10;
      const toePitch = -g.ankPush * 0.9 * lobe(lp, g.duty - 0.01, 0.06) * w;

      // Stance/swing plant weight for foot IK.
      const planted = lp < g.duty ? 1 : 0;
      const edge = 0.06;
      const pw = planted
        ? THREE.MathUtils.smoothstep(Math.min(lp, g.duty - lp) / edge, 0, 1)
        : 0;
      this.footPlant[side] = w < 0.05 ? 1 : Math.max(pw, 1 - w);

      out.setEuler(thigh, thighPitch, sgn * 0.02 * w, sgn * (0.02 + g.hipRoll * 0.25 * Math.cos(TAU * lp) * w));
      out.setEuler(shin, -kneeFlex, 0, 0);
      out.setEuler(foot, anklePitch, 0, sgn * -0.015);
      out.setEuler(toe, toePitch, 0, 0);
    }

    /* ---- pelvis ---- */
    const bob = -g.bob * 0.5 * Math.cos(2 * TAU * p) * w;
    const lat = g.lateral * Math.cos(TAU * p) * w + idleW * shift * 0.016;
    out.root.set(lat, bob, 0);
    const pelvisYaw = -g.pelvisYaw * Math.cos(TAU * p) * w;
    const pelvisRoll = -g.hipRoll * Math.cos(TAU * p) * w + idleW * shift * 0.03;
    const leanIn = THREE.MathUtils.clamp(this.lean * 0.09, -0.16, 0.16) * Math.min(1, this.smoothSpeed / 3);
    out.setEuler(BI.hips, g.lean * 0.35, pelvisYaw, pelvisRoll + leanIn);

    /* ---- spine ---- */
    const chestYaw = g.chestYaw * Math.cos(TAU * p) * w;
    out.setEuler(BI.spine, g.lean * 0.30, chestYaw * 0.45, -pelvisRoll * 0.35 + idleW * sway * 0.012);
    out.setEuler(BI.chest, g.lean * 0.24, chestYaw * 0.55, -leanIn * 0.5);
    out.setEuler(BI.upperChest, g.lean * 0.14, chestYaw * 0.30, 0);

    /* ---- head stabilisation: cancel most of the pelvis motion ---- */
    const totalLean = g.lean * (0.35 + 0.30 + 0.24 + 0.14);
    out.setEuler(BI.neck, -totalLean * 0.55 - g.headBob * bob * 1.2, -chestYaw * 0.6, -pelvisRoll * 0.25);
    out.setEuler(BI.head, -totalLean * 0.35 + idleW * Math.sin(this.clock * 0.23 + this.seed) * 0.02, -chestYaw * 0.35, 0);

    /* ---- arms ---- */
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? 1 : -1;
      const clav = side === 0 ? BI.clavicleL : BI.clavicleR;
      const upper = side === 0 ? BI.upperArmL : BI.upperArmR;
      const fore = side === 0 ? BI.forearmL : BI.forearmR;
      const hand = side === 0 ? BI.handL : BI.handR;
      // Counter-phased to the same-side leg.
      const swing = -sgn * g.armA * Math.cos(TAU * p) * w;
      const armPitch = g.armBias + swing;
      const elbowFlex = g.elbow + g.elbowSwing * Math.max(0, sgn * Math.cos(TAU * p)) * w;
      // Arms tuck in as speed rises; they hang wide when idle.
      const tuck = -0.13 * w - 0.02;
      out.setEuler(clav, -g.shoulderDrop * 0.4 + swing * 0.10, 0, sgn * (g.shoulderDrop + idleW * shift * 0.02));
      out.setEuler(upper, armPitch, sgn * -0.10 * w, sgn * (tuck + Math.abs(swing) * 0.10));
      out.setEuler(fore, elbowFlex, sgn * 0.22 * w, sgn * 0.05);
      out.setEuler(hand, -0.04 + swing * 0.15, 0, sgn * 0.06);
    }
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
    for (let i = 0; i < BONE_COUNT; i++) {
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
