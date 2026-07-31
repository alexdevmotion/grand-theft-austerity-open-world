/**
 * CROWD RIG — the body, and how a hundred of them get drawn.
 *
 * Every pedestrian is an articulated 16-joint skeleton solved on the CPU each
 * frame and emitted as instances into four shared InstancedMeshes (capsules,
 * boxes, heads, emissive bits). A hundred and twenty people therefore cost
 * seven draw calls, not seven hundred.
 *
 * This is a stand-in for the shared humanoid being built in `src/characters/`.
 * The seam is `RigSubject` + `PedAppearance` below: when the character agent
 * lands its rig, `CrowdRenderer.draw()` is the only thing that has to change —
 * the joint solver already produces the poses an animation state machine would
 * need, and `LocomotionState` maps 1:1 onto `poseOf()`.
 */

import * as THREE from 'three';
import { Palette } from '../../artDirection';

/* ------------------------------------------------------------------ */
/* appearance                                                          */
/* ------------------------------------------------------------------ */

export interface PedAppearance {
  /** Standing height in metres, 1.52 – 1.94. */
  height: number;
  /** Girth multiplier, 0.86 – 1.18. */
  build: number;
  skin: THREE.Color;
  hair: THREE.Color;
  /** Torso garment. */
  top: THREE.Color;
  /**
   * Upper-arm garment. ALWAYS cloth — a short sleeve still covers the
   * shoulder. Which forearm shows is `shortSleeve`, not this.
   */
  sleeve: THREE.Color;
  /** Short sleeve: the FOREARM is bare skin, the upper arm is not. */
  shortSleeve: boolean;
  legs: THREE.Color;
  shoes: THREE.Color;
  /** Hi-vis vest / sash / apron colour; null for none. */
  vest: THREE.Color | null;
  /** 0 none, 1 cap, 2 hard hat, 3 beanie, 4 long hair. */
  headwear: number;
  hatColor: THREE.Color;
  /** 0 none, 1 shoulder bag, 2 backpack, 3 shopping bag. */
  bag: number;
  bagColor: THREE.Color;
  /** Holding a lit phone. */
  phone: boolean;
  /** Holding a cigarette. */
  cigarette: boolean;
  /** Carrying a placard (protesters). */
  placard: THREE.Color | null;
}

/* ------------------------------------------------------------------ */
/* pose                                                                */
/* ------------------------------------------------------------------ */

export type PoseState =
  | 'idle' | 'walk' | 'jog' | 'sprint'
  | 'phone' | 'smoke' | 'talk' | 'gesture'
  | 'sit' | 'lean' | 'shop' | 'vendor' | 'wave'
  | 'flinch' | 'panic' | 'down';

export interface RigSubject {
  readonly pos: THREE.Vector3;
  readonly yaw: number;
  readonly tiltPitch: number;
  readonly tiltRoll: number;
  readonly app: PedAppearance;
  readonly pose: PoseState;
  readonly phase: number;
  readonly speed: number;
  readonly headYaw: number;
  readonly headPitch: number;
  readonly seed: number;
  readonly gesture: number;
}

/* joint indices */
const J_PELVIS = 0;
const J_CHEST = 1;
const J_NECK = 2;
const J_HEAD = 3;
const J_SHO_L = 4;
const J_ELB_L = 5;
const J_WRI_L = 6;
const J_SHO_R = 7;
const J_ELB_R = 8;
const J_WRI_R = 9;
const J_HIP_L = 10;
const J_KNE_L = 11;
const J_ANK_L = 12;
const J_HIP_R = 13;
const J_KNE_R = 14;
const J_ANK_R = 15;
const JOINT_COUNT = 16;

/** Solved joints in body-local space: x = right, y = up, z = forward. */
const joints = new Float32Array(JOINT_COUNT * 3);

interface Dims {
  thigh: number;
  shin: number;
  torso: number;
  neck: number;
  headR: number;
  shoW: number;
  hipW: number;
  upArm: number;
  foreArm: number;
  armR: number;
  legR: number;
  hipH: number;
}

const dims: Dims = {
  thigh: 0, shin: 0, torso: 0, neck: 0, headR: 0, shoW: 0,
  hipW: 0, upArm: 0, foreArm: 0, armR: 0, legR: 0, hipH: 0,
};

function measure(app: PedAppearance): Dims {
  const h = app.height;
  const b = app.build;
  dims.thigh = h * 0.246;
  dims.shin = h * 0.238;
  dims.hipH = h * 0.492;
  dims.torso = h * 0.286;
  dims.neck = h * 0.044;
  // Head width, not head height — a bobble-head is the classic tell of a
  // procedural crowd, so this stays deliberately small.
  dims.headR = h * 0.0665;
  dims.shoW = h * 0.116 * (0.92 + b * 0.12);
  dims.hipW = h * 0.066 * b;
  dims.upArm = h * 0.172;
  dims.foreArm = h * 0.162;
  dims.armR = h * 0.0305 * b;
  dims.legR = h * 0.0445 * b;
  return dims;
}

function set(i: number, x: number, y: number, z: number): void {
  joints[i * 3] = x;
  joints[i * 3 + 1] = y;
  joints[i * 3 + 2] = z;
}

/** Cheap deterministic per-ped noise so nobody moves in lockstep. */
function wob(seed: number, t: number, f: number): number {
  return Math.sin(t * f + seed * 2.399) * 0.5 + Math.sin(t * f * 1.618 + seed * 5.117) * 0.5;
}

/**
 * Solve the skeleton for one subject at time `t`. Writes into `joints`.
 * Returns the pelvis height used, so the caller can ground the figure.
 */
export function solvePose(s: RigSubject, t: number): void {
  const d = measure(s.app);
  const st = s.pose;
  const seed = s.seed;

  const moving = st === 'walk' || st === 'jog' || st === 'sprint' || st === 'panic';
  const running = st === 'jog' || st === 'sprint' || st === 'panic';

  /* ---- gait ---- */
  const swing = moving ? (running ? 0.86 : 0.52) * Math.min(1, 0.45 + s.speed * 0.16) : 0.03;
  const kneeAmp = moving ? (running ? 1.45 : 0.82) : 0.10;
  const th = s.phase;

  const thighL = swing * Math.sin(th);
  const thighR = swing * Math.sin(th + Math.PI);
  const kneeL = kneeAmp * Math.max(0, Math.sin(th + 2.25)) + 0.06;
  const kneeR = kneeAmp * Math.max(0, Math.sin(th + Math.PI + 2.25)) + 0.06;

  let lean = moving ? 0.045 + (running ? 0.14 : 0.03) : 0.015;
  let pelvisX = 0;
  let pelvisZ = 0;
  let pelvisYOff = 0;
  let twist = moving ? -0.11 * Math.sin(th) : 0;
  let roll = moving ? 0.035 * Math.sin(th) : 0.012 * wob(seed, t, 0.55);

  /* ---- arms, per pose ---- */
  // Positive shoulder angle swings the arm forward.
  let shoL = moving ? -swing * 0.78 * Math.sin(th) : 0.02;
  let shoR = moving ? -swing * 0.78 * Math.sin(th + Math.PI) : 0.02;
  let elbL = moving ? 0.30 + 0.34 * Math.max(0, -Math.sin(th)) : 0.16;
  let elbR = moving ? 0.30 + 0.34 * Math.max(0, -Math.sin(th + Math.PI)) : 0.16;
  // Outward flare of the upper arms (keeps them off the ribs).
  let flareL = 0.10 + s.app.build * 0.06;
  let flareR = flareL;
  let armFwdL = 0;
  let armFwdR = 0;

  let sit = 0;

  switch (st) {
    case 'idle':
      pelvisX = 0.012 * wob(seed, t, 0.42);
      shoL += 0.05 * wob(seed, t, 0.31);
      shoR += 0.05 * wob(seed + 3, t, 0.29);
      break;

    case 'phone': {
      // One hand up at chest height, head down into it.
      const hand = seed % 2 === 0 ? 0 : 1;
      const raise = 1.55 + 0.06 * wob(seed, t, 0.5);
      if (hand === 0) {
        shoR = 0.55;
        elbR = raise;
        flareR = -0.16;
        armFwdR = 0.1;
      } else {
        shoL = 0.55;
        elbL = raise;
        flareL = -0.16;
        armFwdL = 0.1;
      }
      pelvisX = 0.01 * wob(seed, t, 0.35);
      break;
    }

    case 'smoke': {
      // Hand travels to the mouth on a slow cycle, then drops.
      const c = (t * 0.26 + seed * 0.137) % 1;
      const lift = c < 0.34 ? smooth01(c / 0.34) : c < 0.5 ? 1 : 1 - smooth01((c - 0.5) / 0.28);
      const l = Math.max(0, Math.min(1, lift));
      shoR = 0.14 + l * 0.42;
      elbR = 0.24 + l * 1.72;
      flareR = 0.13 - l * 0.24;
      armFwdR = l * 0.06;
      shoL = -0.08;
      elbL = 0.30;
      break;
    }

    case 'talk':
    case 'gesture': {
      const g = s.gesture;
      const a = Math.sin(t * 2.1 + seed) * 0.5 + 0.5;
      const b = Math.sin(t * 1.35 + seed * 2.7) * 0.5 + 0.5;
      shoR = 0.16 + a * 0.5 * g;
      elbR = 0.55 + a * 1.05 * g;
      flareR = 0.16 + b * 0.30 * g;
      shoL = 0.08 + b * 0.32 * g;
      elbL = 0.44 + b * 0.72 * g;
      flareL = 0.14 + a * 0.22 * g;
      twist = 0.06 * Math.sin(t * 0.9 + seed);
      pelvisX = 0.016 * wob(seed, t, 0.5);
      break;
    }

    case 'shop':
      // Leaning in toward a window, hands loosely clasped.
      lean = 0.16;
      shoL = 0.30;
      shoR = 0.30;
      elbL = 1.05;
      elbR = 1.05;
      flareL = -0.10;
      flareR = -0.10;
      pelvisX = 0.01 * wob(seed, t, 0.3);
      break;

    case 'vendor':
      // Hands resting forward on a counter.
      shoL = 0.62;
      shoR = 0.62;
      elbL = 0.95;
      elbR = 0.95;
      flareL = 0.18;
      flareR = 0.18;
      lean = 0.10;
      break;

    case 'lean':
      // Shoulder against a wall, one leg crossed.
      roll = 0.14;
      pelvisX = 0.05;
      shoL = -0.12;
      shoR = 0.05;
      elbL = 0.20;
      elbR = 0.55;
      break;

    case 'wave':
      shoR = 1.55 + 0.12 * Math.sin(t * 7.0 + seed);
      elbR = 0.85 + 0.42 * Math.sin(t * 7.0 + seed);
      flareR = 0.42;
      break;

    case 'sit':
      sit = 1;
      lean = 0.10;
      shoL = 0.24;
      shoR = 0.24;
      elbL = 0.72;
      elbR = 0.72;
      flareL = 0.06;
      flareR = 0.06;
      break;

    case 'flinch':
      // Recoiling: weight back, arms up defensively.
      lean = -0.24;
      pelvisZ = -0.10;
      shoL = 0.92;
      shoR = 0.92;
      elbL = 1.62;
      elbR = 1.62;
      flareL = 0.34;
      flareR = 0.34;
      break;

    case 'panic':
      // Running with the arms high and loose.
      shoL = -swing * 0.5 * Math.sin(th) + 0.55;
      shoR = -swing * 0.5 * Math.sin(th + Math.PI) + 0.55;
      elbL = 1.25;
      elbR = 1.25;
      flareL = 0.30;
      flareR = 0.30;
      lean = 0.22;
      break;

    case 'down':
      // Handled by the caller's tilt; limbs go slack and splayed.
      lean = 0;
      shoL = -0.35 + 0.2 * Math.sin(seed);
      shoR = -0.35 + 0.2 * Math.cos(seed);
      elbL = 0.5;
      elbR = 0.35;
      flareL = 0.75;
      flareR = 0.62;
      break;

    default:
      break;
  }

  if (s.app.placard) {
    // Both hands up gripping a stick.
    shoL = 1.05;
    shoR = 1.15;
    elbL = 0.95;
    elbR = 0.75;
    flareL = 0.12;
    flareR = 0.12;
  }

  /* ---- legs (forward kinematics in the sagittal plane) ---- */
  let hipY = d.hipH;
  if (sit) hipY = d.hipH * 0.62;

  const bob = moving ? (running ? 0.055 : 0.028) * d.hipH : 0;
  hipY -= bob * (0.5 - 0.5 * Math.cos(th * 2));
  hipY += pelvisYOff;

  const legs: Array<{ hip: number; knee: number; sign: number; ji: number; jk: number; ja: number }> = [
    { hip: thighL, knee: kneeL, sign: -1, ji: J_HIP_L, jk: J_KNE_L, ja: J_ANK_L },
    { hip: thighR, knee: kneeR, sign: 1, ji: J_HIP_R, jk: J_KNE_R, ja: J_ANK_R },
  ];

  let lowestAnkle = Infinity;
  for (const L of legs) {
    let hipA = L.hip;
    let kneeA = L.knee;
    if (sit) {
      hipA = 1.42;
      kneeA = 1.55;
    }
    const hx = pelvisX + L.sign * d.hipW;
    const hy = hipY;
    const hz = pelvisZ;
    const kx = hx + L.sign * 0.012;
    const ky = hy - Math.cos(hipA) * d.thigh;
    const kz = hz + Math.sin(hipA) * d.thigh;
    const sa = hipA - kneeA;
    const ax = kx;
    const ay = ky - Math.cos(sa) * d.shin;
    const az = kz + Math.sin(sa) * d.shin;
    set(L.ji, hx, hy, hz);
    set(L.jk, kx, ky, kz);
    set(L.ja, ax, ay, az);
    if (ay < lowestAnkle) lowestAnkle = ay;
  }

  // Ground the figure: lift everything so the lower ankle sits at ankle height.
  const ankleClearance = d.legR * 1.15;
  const lift = sit ? 0 : ankleClearance - lowestAnkle;
  for (const L of legs) {
    joints[L.ji * 3 + 1] += lift;
    joints[L.jk * 3 + 1] += lift;
    joints[L.ja * 3 + 1] += lift;
  }
  hipY += lift;

  /* ---- spine ---- */
  const px = pelvisX;
  const pz = pelvisZ;
  set(J_PELVIS, px, hipY, pz);
  const chestY = hipY + Math.cos(lean) * d.torso;
  const chestZ = pz + Math.sin(lean) * d.torso;
  const chestX = px + Math.sin(roll) * d.torso * 0.35;
  set(J_CHEST, chestX, chestY, chestZ);

  const neckY = chestY + Math.cos(lean) * d.neck;
  const neckZ = chestZ + Math.sin(lean) * d.neck;
  set(J_NECK, chestX, neckY, neckZ);

  const hp = s.headPitch;
  set(
    J_HEAD,
    chestX + Math.sin(s.headYaw) * d.headR * 0.22,
    neckY + Math.cos(hp) * (d.headR * 1.02),
    neckZ + Math.sin(hp) * (d.headR * 1.02),
  );

  /* ---- arms ---- */
  const ct = Math.cos(twist);
  const stw = Math.sin(twist);
  const arms: Array<{
    sho: number; elb: number; flare: number; fwd: number; sign: number;
    js: number; je: number; jw: number;
  }> = [
    { sho: shoL, elb: elbL, flare: flareL, fwd: armFwdL, sign: -1, js: J_SHO_L, je: J_ELB_L, jw: J_WRI_L },
    { sho: shoR, elb: elbR, flare: flareR, fwd: armFwdR, sign: 1, js: J_SHO_R, je: J_ELB_R, jw: J_WRI_R },
  ];

  for (const A of arms) {
    const offX = A.sign * d.shoW;
    const sx = chestX + offX * ct;
    const sz = chestZ + offX * stw * -1;
    const sy = chestY - d.torso * 0.055;
    set(A.js, sx, sy, sz);

    // Upper arm: swing in the sagittal plane, flare outward.
    const fl = A.sign * A.flare;
    const ex = sx + Math.sin(fl) * d.upArm;
    const ey = sy - Math.cos(A.sho) * Math.cos(fl) * d.upArm;
    const ez = sz + Math.sin(A.sho) * d.upArm + A.fwd;
    set(A.je, ex, ey, ez);

    const fa = A.sho + A.elb;
    const wx = ex + Math.sin(fl) * d.foreArm * 0.35;
    const wy = ey - Math.cos(fa) * d.foreArm;
    const wz = ez + Math.sin(fa) * d.foreArm;
    set(A.jw, wx, wy, wz);
  }
}

export function jointAt(index: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(joints[index * 3], joints[index * 3 + 1], joints[index * 3 + 2]);
}

function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/* ------------------------------------------------------------------ */
/* renderer                                                           */
/* ------------------------------------------------------------------ */

interface Pool {
  mesh: THREE.InstancedMesh;
  n: number;
  cap: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qRoot = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _basis = new THREE.Matrix4();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const _e = new THREE.Euler();

export interface CrowdRenderStats {
  drawn: number;
  instances: number;
  triangles: number;
}

export class CrowdRenderer {
  readonly root = new THREE.Group();

  private capsNear!: Pool;
  private capsFar!: Pool;
  private boxNear!: Pool;
  private boxFar!: Pool;
  private headNear!: Pool;
  private headFar!: Pool;
  private glow!: Pool;

  private near = true;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];

  /** Metres beyond which a ped stops casting shadows / loses detail. */
  shadowRadius = 42;
  lod1 = 46;
  lod2 = 110;

  readonly stats: CrowdRenderStats = { drawn: 0, instances: 0, triangles: 0 };

  constructor(scene: THREE.Object3D, maxPeds: number, castShadows: boolean) {
    this.root.name = 'peds';
    this.root.frustumCulled = false;
    scene.add(this.root);

    const capsule = new THREE.CapsuleGeometry(0.5, 1.0, 2, 6);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const head = new THREE.IcosahedronGeometry(0.5, 1);
    const glowGeo = new THREE.BoxGeometry(1, 1, 1);
    this.geos.push(capsule, box, head, glowGeo);

    const skinMat = () =>
      new THREE.MeshStandardMaterial({
        roughness: 0.78,
        metalness: 0.0,
        // The sky is the key light; a ped must never read as neutral grey.
        envMapIntensity: 1.15,
      });

    const bodyNear = skinMat();
    const bodyFar = skinMat();
    bodyFar.envMapIntensity = 1.05;
    this.mats.push(bodyNear, bodyFar);

    const glowMat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mats.push(glowMat);

    // Near pools carry the peds that are close enough for their shadow to
    // matter; far pools skip the shadow cascades entirely.
    const nearCap = Math.min(maxPeds, 44) * 17;
    const farCap = maxPeds * 15;

    this.capsNear = this.pool(capsule, bodyNear, nearCap, castShadows, 'peds-caps-near');
    this.boxNear = this.pool(box, bodyNear, Math.ceil(nearCap * 0.55), castShadows, 'peds-box-near');
    this.headNear = this.pool(head, bodyNear, Math.min(maxPeds, 44) * 2, castShadows, 'peds-head-near');
    this.capsFar = this.pool(capsule, bodyFar, farCap, false, 'peds-caps-far');
    this.boxFar = this.pool(box, bodyFar, Math.ceil(farCap * 0.4), false, 'peds-box-far');
    this.headFar = this.pool(head, bodyFar, maxPeds * 2, false, 'peds-head-far');
    this.glow = this.pool(glowGeo, glowMat, maxPeds * 2, false, 'peds-glow');
  }

  private pool(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    cap: number,
    cast: boolean,
    name: string,
  ): Pool {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, cap));
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const colors = new Float32Array(Math.max(1, cap) * 3).fill(1);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.root.add(mesh);
    return { mesh, n: 0, cap: Math.max(1, cap) };
  }

  setShadows(on: boolean): void {
    this.capsNear.mesh.castShadow = on;
    this.boxNear.mesh.castShadow = on;
    this.headNear.mesh.castShadow = on;
  }

  begin(): void {
    this.capsNear.n = 0;
    this.capsFar.n = 0;
    this.boxNear.n = 0;
    this.boxFar.n = 0;
    this.headNear.n = 0;
    this.headFar.n = 0;
    this.glow.n = 0;
    this.stats.drawn = 0;
    this.stats.instances = 0;
  }

  private push(p: Pool, color: THREE.Color): void {
    if (p.n >= p.cap) return;
    p.mesh.setMatrixAt(p.n, _m);
    const c = p.mesh.instanceColor!;
    c.setXYZ(p.n, color.r, color.g, color.b);
    p.n++;
    this.stats.instances++;
  }

  /** Capsule between two world points. */
  private limb(a: THREE.Vector3, b: THREE.Vector3, radius: number, color: THREE.Color): void {
    _mid.addVectors(a, b).multiplyScalar(0.5);
    _dir.subVectors(b, a);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);
    _q.setFromUnitVectors(UP, _dir);
    _scale.set(radius * 2, len * 0.5, radius * 2);
    _m.compose(_mid, _q, _scale);
    this.push(this.near ? this.capsNear : this.capsFar, color);
  }

  /**
   * An oriented slab between two points: wider than it is deep, and rolled so
   * its width follows the body's shoulders. A capsule torso reads as a pipe;
   * people are flat front-to-back and this is what makes them look dressed.
   */
  private slab(
    a: THREE.Vector3,
    b: THREE.Vector3,
    halfWidth: number,
    halfDepth: number,
    color: THREE.Color,
  ): void {
    _mid.addVectors(a, b).multiplyScalar(0.5);
    _up.subVectors(b, a);
    const len = _up.length();
    if (len < 1e-4) return;
    _up.divideScalar(len);
    // Project the body's forward axis into the plane normal to the spine.
    _fwd.copy(this.bodyFwd).addScaledVector(_up, -this.bodyFwd.dot(_up));
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, 1).addScaledVector(_up, -_up.z);
    _fwd.normalize();
    _right.copy(_up).cross(_fwd).normalize();
    _basis.makeBasis(_right, _up, _fwd);
    _basis.scale(_scale.set(halfWidth * 2, len, halfDepth * 2));
    _basis.setPosition(_mid);
    _m.copy(_basis);
    this.push(this.near ? this.boxNear : this.boxFar, color);
  }

  private cube(
    centre: THREE.Vector3,
    q: THREE.Quaternion,
    sx: number,
    sy: number,
    sz: number,
    color: THREE.Color,
  ): void {
    _scale.set(sx, sy, sz);
    _m.compose(centre, q, _scale);
    this.push(this.near ? this.boxNear : this.boxFar, color);
  }

  private sphere(centre: THREE.Vector3, q: THREE.Quaternion, d: number, color: THREE.Color): void {
    _scale.set(d, d * 1.16, d * 0.98);
    _m.compose(centre, q, _scale);
    this.push(this.near ? this.headNear : this.headFar, color);
  }

  private emissive(centre: THREE.Vector3, q: THREE.Quaternion, s: number, color: THREE.Color): void {
    _scale.set(s, s * 1.5, s * 0.3);
    _m.compose(centre, q, _scale);
    this.push(this.glow, color);
  }

  /* ---- world transform helpers ---- */

  private rootPos = new THREE.Vector3();
  private bodyFwd = new THREE.Vector3(0, 0, 1);

  private toWorld(j: number, out: THREE.Vector3): THREE.Vector3 {
    out.set(joints[j * 3], joints[j * 3 + 1], joints[j * 3 + 2]);
    out.applyQuaternion(_qRoot).add(this.rootPos);
    return out;
  }

  /**
   * Solve and emit one pedestrian. `distance` selects the level of detail.
   */
  draw(s: RigSubject, t: number, distance: number): void {
    solvePose(s, t);

    const app = s.app;
    this.rootPos.copy(s.pos);
    _e.set(s.tiltPitch, s.yaw, s.tiltRoll, 'YXZ');
    _qRoot.setFromEuler(_e);
    this.bodyFwd.set(0, 0, 1).applyQuaternion(_qRoot);
    this.near = distance < this.shadowRadius;
    const lod = distance < this.lod1 ? 0 : distance < this.lod2 ? 1 : 2;

    const d = measure(app);
    const legR = d.legR;
    const armR = d.armR;

    /* ---- legs ---- */
    if (lod < 2) {
      this.toWorld(J_HIP_L, _a);
      this.toWorld(J_KNE_L, _b);
      this.limb(_a, _b, legR, app.legs);
      this.toWorld(J_KNE_L, _a);
      this.toWorld(J_ANK_L, _b);
      this.limb(_a, _b, legR * 0.82, app.legs);
      this.toWorld(J_HIP_R, _a);
      this.toWorld(J_KNE_R, _b);
      this.limb(_a, _b, legR, app.legs);
      this.toWorld(J_KNE_R, _a);
      this.toWorld(J_ANK_R, _b);
      this.limb(_a, _b, legR * 0.82, app.legs);
    } else {
      this.toWorld(J_HIP_L, _a);
      this.toWorld(J_ANK_L, _b);
      this.limb(_a, _b, legR, app.legs);
      this.toWorld(J_HIP_R, _a);
      this.toWorld(J_ANK_R, _b);
      this.limb(_a, _b, legR, app.legs);
    }

    /* ---- arms ----
     *
     * The forearm used to be picked with `app.sleeve === app.top ? ... : skin`
     * — REFERENCE equality on two THREE.Colors — and `copyWardrobe` dressed a
     * short-sleeved ped by assigning `app.sleeve = app.skin`. Both halves of the
     * arm then drew in skin, so 29% of the crowd walked around with bare
     * shoulders. A t-shirt covers the shoulder; only the forearm is ever bare,
     * and which it is, is a flag and not an object identity. */
    const forearm = app.shortSleeve ? app.skin : app.sleeve;
    if (lod < 2) {
      this.toWorld(J_SHO_L, _a);
      this.toWorld(J_ELB_L, _b);
      this.limb(_a, _b, armR, app.sleeve);
      this.toWorld(J_ELB_L, _a);
      this.toWorld(J_WRI_L, _b);
      this.limb(_a, _b, armR * 0.86, forearm);
      this.toWorld(J_SHO_R, _a);
      this.toWorld(J_ELB_R, _b);
      this.limb(_a, _b, armR, app.sleeve);
      this.toWorld(J_ELB_R, _a);
      this.toWorld(J_WRI_R, _b);
      this.limb(_a, _b, armR * 0.86, forearm);
    } else {
      this.toWorld(J_SHO_L, _a);
      this.toWorld(J_WRI_L, _b);
      this.limb(_a, _b, armR, app.sleeve);
      this.toWorld(J_SHO_R, _a);
      this.toWorld(J_WRI_R, _b);
      this.limb(_a, _b, armR, app.sleeve);
    }

    /* ---- torso ---- */
    const torsoW = d.shoW * 0.86;
    const torsoD = d.shoW * 0.56 * (0.82 + app.build * 0.2);
    this.toWorld(J_PELVIS, _a);
    this.toWorld(J_CHEST, _b);
    // Hips are narrower than the chest, so the trunk goes out as two slabs.
    _mid.copy(_a).lerp(_b, 0.44);
    this.slab(_a, _mid, d.hipW * 1.62, torsoD * 0.92, app.legs);
    this.slab(_mid, _b, torsoW, torsoD, app.top);
    // Shoulder yoke fills the gap between the deltoids.
    this.toWorld(J_SHO_L, _a);
    this.toWorld(J_SHO_R, _b);
    this.limb(_a, _b, torsoD * 0.72, app.top);

    if (app.vest && lod < 2) {
      // Hi-vis tabard: a slightly larger, brighter shell over the chest.
      this.toWorld(J_PELVIS, _a);
      this.toWorld(J_CHEST, _b);
      _a.lerp(_b, 0.36);
      _b.lerp(_a, 0.06);
      this.slab(_a, _b, torsoW * 1.1, torsoD * 1.12, app.vest);
    }

    /* ---- head ---- */
    this.toWorld(J_NECK, _a);
    this.toWorld(J_HEAD, _b);
    if (lod < 1) this.limb(_a, _b, d.headR * 0.56, app.skin);
    _e.set(s.tiltPitch + s.headPitch * 0.6, s.yaw + s.headYaw, s.tiltRoll, 'YXZ');
    _q.setFromEuler(_e);
    this.sphere(_b, _q, d.headR * 2.02, app.skin);

    // Hair / headwear sits as a shell on the crown.
    if (app.headwear > 0 && lod < 2) {
      _mid.copy(_b);
      _mid.y += d.headR * 0.42;
      if (app.headwear === 1) {
        this.cube(_mid, _q, d.headR * 2.0, d.headR * 0.72, d.headR * 2.05, app.hatColor);
        // Peak.
        _dir.set(0, -d.headR * 0.22, d.headR * 1.35).applyQuaternion(_q).add(_mid);
        this.cube(_dir, _q, d.headR * 1.75, d.headR * 0.16, d.headR * 0.95, app.hatColor);
      } else if (app.headwear === 2) {
        this.sphere(_mid, _q, d.headR * 2.26, app.hatColor);
      } else if (app.headwear === 3) {
        this.sphere(_mid, _q, d.headR * 2.12, app.hatColor);
      } else {
        // Long hair: a shell plus a fall down the back of the neck.
        this.sphere(_mid, _q, d.headR * 2.2, app.hair);
        _dir.set(0, -d.headR * 1.25, -d.headR * 0.72).applyQuaternion(_q).add(_mid);
        this.cube(_dir, _q, d.headR * 1.7, d.headR * 1.9, d.headR * 0.7, app.hair);
      }
    } else if (lod < 2) {
      _mid.copy(_b);
      _mid.y += d.headR * 0.5;
      this.sphere(_mid, _q, d.headR * 1.94, app.hair);
    }

    /* ---- feet ---- */
    if (lod < 1) {
      _e.set(0, s.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      for (const ja of [J_ANK_L, J_ANK_R]) {
        this.toWorld(ja, _a);
        _dir.set(0, -legR * 0.5, d.shin * 0.16).applyQuaternion(_qRoot).add(_a);
        this.cube(_dir, _q, legR * 2.0, legR * 1.05, d.shin * 0.62, app.shoes);
      }
    }

    /* ---- carried things ---- */
    if (lod < 1) {
      if (app.bag === 1) {
        this.toWorld(J_CHEST, _a);
        _dir.set(d.shoW * 0.92, -d.torso * 0.42, 0).applyQuaternion(_qRoot).add(_a);
        _e.set(0, s.yaw, 0.18, 'YXZ');
        _q.setFromEuler(_e);
        this.cube(_dir, _q, 0.10, 0.24, 0.20, app.bagColor);
      } else if (app.bag === 2) {
        this.toWorld(J_CHEST, _a);
        _dir.set(0, -d.torso * 0.12, -d.shoW * 1.15).applyQuaternion(_qRoot).add(_a);
        _e.set(0, s.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        this.cube(_dir, _q, d.shoW * 1.5, d.torso * 0.86, 0.19, app.bagColor);
      } else if (app.bag === 3) {
        this.toWorld(J_WRI_L, _a);
        _dir.set(0, -0.17, 0).add(_a);
        _e.set(0, s.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        this.cube(_dir, _q, 0.20, 0.28, 0.13, app.bagColor);
      }

      if (app.placard) {
        this.toWorld(J_WRI_R, _a);
        _e.set(-0.22, s.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _dir.set(0, 0.42, 0).applyQuaternion(_q).add(_a);
        this.cube(_dir, _q, 0.045, 0.95, 0.045, POLE);
        _dir.set(0, 1.02, 0).applyQuaternion(_q).add(_a);
        this.cube(_dir, _q, 0.66, 0.46, 0.03, app.placard);
      }
    }

    /* ---- emissive detail: phone screens and cigarettes ---- */
    if (lod < 1 && app.phone && (s.pose === 'phone' || s.pose === 'idle')) {
      const useR = s.seed % 2 === 0;
      this.toWorld(useR ? J_WRI_R : J_WRI_L, _a);
      _e.set(-0.9, s.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _dir.set(0, 0.055, 0.02).applyQuaternion(_q).add(_a);
      this.emissive(_dir, _q, 0.062, PHONE_GLOW);
    }
    if (lod < 1 && app.cigarette && s.pose === 'smoke') {
      this.toWorld(J_WRI_R, _a);
      _e.set(0, s.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _dir.set(0, 0.05, 0.05).applyQuaternion(_q).add(_a);
      _col.copy(CIG_GLOW).multiplyScalar(0.7 + 0.3 * Math.sin(t * 1.7 + s.seed));
      _scale.set(0.022, 0.022, 0.022);
      _m.compose(_dir, _q, _scale);
      this.push(this.glow, _col);
    }

    this.stats.drawn++;
  }

  /**
   * A lit phone screen or a cigarette ember at a hand bone. These are the two
   * details that make a dusk crowd read as people rather than mannequins, and
   * the character wardrobe has no accessory slot for either.
   */
  handLight(p: THREE.Vector3, yaw: number, size: number, color: THREE.Color, flat: boolean): void {
    _e.set(flat ? -0.95 : 0, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    _scale.set(size, flat ? size * 1.55 : size, flat ? size * 0.14 : size);
    _m.compose(p, _q, _scale);
    this.push(this.glow, color);
  }

  /**
   * A dog on a lead. Same pools, seven instances, trotting gait — because a
   * street with someone walking a dog reads as a neighbourhood and a street
   * without one reads as a set.
   */
  drawDog(
    x: number,
    y: number,
    z: number,
    yaw: number,
    phase: number,
    size: number,
    colour: THREE.Color,
    distance: number,
  ): void {
    this.near = distance < this.shadowRadius;
    this.bodyFwd.set(Math.sin(yaw), 0, Math.cos(yaw));
    const bodyLen = 0.46 * size;
    const legLen = 0.30 * size;
    const r = 0.062 * size;
    const backY = y + legLen + r * 1.4;

    _e.set(0, yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    const fx = Math.sin(yaw);
    const fz = Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);

    // Body.
    _a.set(x - fx * bodyLen * 0.5, backY, z - fz * bodyLen * 0.5);
    _b.set(x + fx * bodyLen * 0.5, backY + 0.02 * size, z + fz * bodyLen * 0.5);
    this.limb(_a, _b, 0.10 * size, colour);

    // Head + muzzle.
    _mid.set(x + fx * (bodyLen * 0.62), backY + 0.09 * size, z + fz * (bodyLen * 0.62));
    this.sphere(_mid, _q, 0.19 * size, colour);
    _dir.set(0, -0.02 * size, 0.11 * size).applyQuaternion(_q).add(_mid);
    this.cube(_dir, _q, 0.08 * size, 0.07 * size, 0.12 * size, colour);

    // Tail.
    _a.set(x - fx * bodyLen * 0.52, backY + 0.03 * size, z - fz * bodyLen * 0.52);
    _b.set(
      x - fx * bodyLen * 0.78,
      backY + 0.16 * size + Math.sin(phase * 2.2) * 0.03 * size,
      z - fz * bodyLen * 0.78,
    );
    this.limb(_a, _b, r * 0.5, colour);

    // Four legs, diagonal pairs out of phase.
    const legs = [
      { fwd: 0.30, side: 0.55, ph: 0 },
      { fwd: 0.30, side: -0.55, ph: Math.PI },
      { fwd: -0.32, side: 0.55, ph: Math.PI },
      { fwd: -0.32, side: -0.55, ph: 0 },
    ];
    for (const L of legs) {
      const sw = Math.sin(phase + L.ph) * 0.24;
      const hx = x + fx * bodyLen * L.fwd + rx * 0.09 * size * L.side;
      const hz = z + fz * bodyLen * L.fwd + rz * 0.09 * size * L.side;
      _a.set(hx, backY - 0.03 * size, hz);
      _b.set(hx + fx * sw * legLen, y + r * 0.6, hz + fz * sw * legLen);
      this.limb(_a, _b, r, colour);
    }
  }

  end(): void {
    let tris = 0;
    for (const p of [
      this.capsNear, this.capsFar, this.boxNear, this.boxFar,
      this.headNear, this.headFar, this.glow,
    ]) {
      p.mesh.count = p.n;
      p.mesh.visible = p.n > 0;
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
      const idx = p.mesh.geometry.index;
      const perInstance = idx ? idx.count / 3 : p.mesh.geometry.attributes.position.count / 3;
      tris += perInstance * p.n;
    }
    this.stats.triangles = tris;
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.root.clear();
    this.root.removeFromParent();
  }
}

const POLE = new THREE.Color(0x6b5844).convertSRGBToLinear();
export const PHONE_GLOW = new THREE.Color(0x9fc4ff).multiplyScalar(2.4);
export const CIG_GLOW = new THREE.Color(Palette.sodiumLamp).multiplyScalar(4.0);
