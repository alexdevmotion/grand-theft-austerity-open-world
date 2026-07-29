/**
 * IK — analytic two-bone solving, ground foot planting, additive look-at, and
 * the verlet ragdoll.
 *
 * FOOT PLANTING is what stops characters skating over kerbs and stairs. Each
 * planted foot raycasts down against the real collision world; the pelvis drops
 * by the deepest correction, then each leg is re-solved analytically so the
 * ankle lands exactly on the surface, and the foot is tilted onto the surface
 * normal. Swing feet are left to the clip.
 *
 * RAGDOLL is a 16-particle verlet skeleton with distance constraints and cross
 * braces. It costs nothing next to a Rapier articulation, is deterministic, and
 * maps back onto the rig by aiming each bone down its particle chain.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { CG, groups, type PhysicsWorld } from '../physics/physics';
import { BI, type Rig } from './rig';

const RAY_MASK = groups(CG.SENSOR, CG.STATIC | CG.TERRAIN | CG.PROP);
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Look-at                                                             */
/* ------------------------------------------------------------------ */

/**
 * Additive head/eye tracking. Applied AFTER the base pose so any clip can be
 * looked away from. `yaw` is positive toward the character's left, `pitch`
 * positive when looking up.
 */
export function applyLookAt(rig: Rig, yaw: number, pitch: number): void {
  if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4) return;
  const share: Array<[number, number]> = [
    [BI.chest, 0.14],
    [BI.upperChest, 0.10],
    [BI.neck, 0.32],
    [BI.head, 0.44],
  ];
  for (const [bone, w] of share) {
    // Bone rest frame: +Y rotation turns left, +X rotation pitches forward.
    _q0.setFromAxisAngle(UP, yaw * w);
    _q1.setFromAxisAngle(RIGHT_AXIS, -pitch * w);
    rig.bones[bone].quaternion.multiply(_q0).multiply(_q1);
  }
}

const RIGHT_AXIS = new THREE.Vector3(1, 0, 0);

/* ------------------------------------------------------------------ */
/* Two-bone IK                                                         */
/* ------------------------------------------------------------------ */

/**
 * Analytic two-bone solve. Returns the new mid-joint world position for a
 * chain rooted at `hip` with segment lengths l1/l2 reaching `target`, with the
 * joint bending toward `pole`.
 */
export function solveTwoBone(
  hip: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  out: THREE.Vector3,
): void {
  _u.subVectors(target, hip);
  let d = _u.length();
  const maxD = (l1 + l2) * 0.999;
  if (d < 1e-4) {
    _u.set(0, -1, 0);
    d = 1e-4;
  } else {
    _u.divideScalar(d);
  }
  d = THREE.MathUtils.clamp(d, Math.abs(l1 - l2) + 1e-4, maxD);

  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const A = Math.acos(cosA);

  _fp.copy(pole).addScaledVector(_u, -pole.dot(_u));
  if (_fp.lengthSq() < 1e-8) {
    _fp.set(0, 0, 1).addScaledVector(_u, -_u.z);
    if (_fp.lengthSq() < 1e-8) _fp.set(1, 0, 0);
  }
  _fp.normalize();

  out.copy(hip)
    .addScaledVector(_u, Math.cos(A) * l1)
    .addScaledVector(_fp, Math.sin(A) * l1);
}

/**
 * World-space aim quaternion matching the rig's bone frame convention:
 * ex = dir x front, ey = dir, ez = ex x ey.
 */
function applyFront(dir: THREE.Vector3, front: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const ey = _ax.copy(dir).normalize();
  const ref = Math.abs(ey.dot(front)) > 0.985 ? UP : front;
  const ex = _ay.crossVectors(ey, ref);
  if (ex.lengthSq() < 1e-8) ex.set(1, 0, 0);
  ex.normalize();
  const ez = _az.crossVectors(ex, ey).normalize();
  _mat.makeBasis(ex, ey, ez);
  return out.setFromRotationMatrix(_mat);
}

const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const _mat = new THREE.Matrix4();

/* ------------------------------------------------------------------ */
/* Foot planting                                                       */
/* ------------------------------------------------------------------ */

export interface FootIkState {
  hipOffset: number;
  footY: [number, number];
  footNormal: [THREE.Vector3, THREE.Vector3];
  blend: [number, number];
}

const _hip = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _target = new THREE.Vector3();
const _newKnee = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _pw = new THREE.Quaternion();

/**
 * Plant both feet on the collision world.
 *
 * `root` must already have an up-to-date matrixWorld, and the pose must have
 * been applied to the bones. Mutates the thigh/shin/foot bone rotations and the
 * hips bone position.
 */
export function solveFootIk(
  rig: Rig,
  root: THREE.Object3D,
  phys: PhysicsWorld,
  plant: readonly [number, number],
  state: FootIkState,
): void {
  const scale = root.scale.x || 1;
  const m = rig.metrics;
  const ankleH = m.ankleY * scale;

  _fwd.set(0, 0, 1).applyQuaternion(root.getWorldQuaternion(_pw)).normalize();

  /* -- probe the ground under each ankle -- */
  let drop = 0;
  let anyHit = false;
  for (let s = 0; s < 2; s++) {
    const footBone = s === 0 ? rig.byName.footL : rig.byName.footR;
    _ankle.setFromMatrixPosition(footBone.matrixWorld);
    _rayOrigin.set(_ankle.x, _ankle.y + 0.62 * scale, _ankle.z);
    const hit = phys.raycast(_rayOrigin, DOWN, 1.75 * scale, RAY_MASK);
    if (!hit) {
      state.blend[s] += (0 - state.blend[s]) * 0.25;
      continue;
    }
    anyHit = true;
    const want = hit.point.y + ankleH;
    state.footY[s] = want;
    state.footNormal[s].copy(hit.normal);
    if (state.footNormal[s].y < 0.2) state.footNormal[s].set(0, 1, 0);
    const target = state.blend[s] = state.blend[s] + (plant[s] - state.blend[s]) * 0.35;
    const delta = (want - _ankle.y) * target;
    if (delta < drop) drop = delta;
  }
  if (!anyHit) return;

  /* -- drop the pelvis so the lower foot can reach -- */
  const wantOffset = THREE.MathUtils.clamp(drop, -0.45 * scale, 0);
  state.hipOffset += (wantOffset - state.hipOffset) * 0.30;
  if (Math.abs(state.hipOffset) > 1e-4) {
    rig.bones[0].position.y += state.hipOffset / scale;
    rig.root.updateMatrixWorld(true);
  }

  /* -- re-solve each leg -- */
  for (let s = 0; s < 2; s++) {
    const w = state.blend[s];
    if (w < 0.02) continue;
    const thighB = s === 0 ? rig.byName.thighL : rig.byName.thighR;
    const shinB = s === 0 ? rig.byName.shinL : rig.byName.shinR;
    const footB = s === 0 ? rig.byName.footL : rig.byName.footR;

    _hip.setFromMatrixPosition(thighB.matrixWorld);
    _knee.setFromMatrixPosition(shinB.matrixWorld);
    _ankle.setFromMatrixPosition(footB.matrixWorld);

    const l1 = _hip.distanceTo(_knee);
    const l2 = _knee.distanceTo(_ankle);
    if (l1 < 1e-4 || l2 < 1e-4) continue;

    const targetY = _ankle.y + (state.footY[s] - _ankle.y) * w;
    _target.set(_ankle.x, targetY, _ankle.z);
    if (Math.abs(targetY - _ankle.y) < 0.0015) continue;

    // Knee pole: forward, biased by where the knee already is.
    _d.subVectors(_knee, _hip).addScaledVector(_fwd, 0.35).normalize();
    solveTwoBone(_hip, _target, l1, l2, _d, _newKnee);

    // thigh
    _a.subVectors(_newKnee, _hip).normalize();
    applyFront(_a, _fwd, _q0);
    thighB.parent!.getWorldQuaternion(_q3);
    thighB.quaternion.copy(_q3.invert()).multiply(_q0);

    // shin
    _b.subVectors(_target, _newKnee).normalize();
    applyFront(_b, _fwd, _q1);
    shinB.quaternion.copy(_q0).invert().multiply(_q1);

    // foot: tilt onto the ground normal, keeping the animated pose underneath
    _q2.setFromUnitVectors(UP, state.footNormal[s]);
    const footWorld = _q3.copy(_q1).multiply(footB.quaternion);
    const tilted = _q0.copy(_q2).multiply(footWorld);
    footWorld.slerp(tilted, w * 0.8);
    footB.quaternion.copy(_q1).invert().multiply(footWorld);
  }

  rig.root.updateMatrixWorld(true);
}

/* ------------------------------------------------------------------ */
/* Ragdoll                                                             */
/* ------------------------------------------------------------------ */

const P = {
  head: 0, neck: 1, chest: 2, hips: 3,
  shoulderL: 4, shoulderR: 5, elbowL: 6, elbowR: 7, handL: 8, handR: 9,
  hipL: 10, hipR: 11, kneeL: 12, kneeR: 13, footL: 14, footR: 15,
} as const;

const PARTICLE_COUNT = 16;

interface Link { a: number; b: number; len: number; stiff: number }

const CHAIN: Array<[number, number, number]> = [
  [P.head, P.neck, 1], [P.neck, P.chest, 1], [P.chest, P.hips, 1],
  [P.neck, P.shoulderL, 1], [P.neck, P.shoulderR, 1],
  [P.shoulderL, P.elbowL, 1], [P.elbowL, P.handL, 1],
  [P.shoulderR, P.elbowR, 1], [P.elbowR, P.handR, 1],
  [P.hips, P.hipL, 1], [P.hips, P.hipR, 1],
  [P.hipL, P.kneeL, 1], [P.kneeL, P.footL, 1],
  [P.hipR, P.kneeR, 1], [P.kneeR, P.footR, 1],
  // braces keep the torso from folding flat
  [P.shoulderL, P.shoulderR, 0.85], [P.hipL, P.hipR, 0.85],
  [P.shoulderL, P.hips, 0.55], [P.shoulderR, P.hips, 0.55],
  [P.chest, P.shoulderL, 0.7], [P.chest, P.shoulderR, 0.7],
  [P.head, P.chest, 0.45],
  [P.hipL, P.chest, 0.4], [P.hipR, P.chest, 0.4],
  // soft limb limits (stop elbows/knees hyperextending through the body)
  [P.shoulderL, P.handL, 0.12], [P.shoulderR, P.handR, 0.12],
  [P.hipL, P.footL, 0.12], [P.hipR, P.footR, 0.12],
];

const BONE_OF: Array<[number, number, number]> = [
  // [bone, fromParticle, toParticle]
  [BI.hips, P.hips, P.chest],
  [BI.spine, P.hips, P.chest],
  [BI.chest, P.chest, P.neck],
  [BI.upperChest, P.chest, P.neck],
  [BI.neck, P.neck, P.head],
  [BI.head, P.neck, P.head],
  [BI.clavicleL, P.neck, P.shoulderL],
  [BI.upperArmL, P.shoulderL, P.elbowL],
  [BI.forearmL, P.elbowL, P.handL],
  [BI.handL, P.elbowL, P.handL],
  [BI.clavicleR, P.neck, P.shoulderR],
  [BI.upperArmR, P.shoulderR, P.elbowR],
  [BI.forearmR, P.elbowR, P.handR],
  [BI.handR, P.elbowR, P.handR],
  [BI.thighL, P.hipL, P.kneeL],
  [BI.shinL, P.kneeL, P.footL],
  [BI.thighR, P.hipR, P.kneeR],
  [BI.shinR, P.kneeR, P.footR],
];

const BONE_SOURCE: Array<[keyof typeof P, number]> = [
  ['head', BI.head], ['neck', BI.neck], ['chest', BI.chest], ['hips', BI.hips],
  ['shoulderL', BI.upperArmL], ['shoulderR', BI.upperArmR],
  ['elbowL', BI.forearmL], ['elbowR', BI.forearmR],
  ['handL', BI.handL], ['handR', BI.handR],
  ['hipL', BI.thighL], ['hipR', BI.thighR],
  ['kneeL', BI.shinL], ['kneeR', BI.shinR],
  ['footL', BI.footL], ['footR', BI.footR],
];

export class Ragdoll {
  private pos: THREE.Vector3[] = [];
  private prev: THREE.Vector3[] = [];
  private links: Link[] = [];
  private rig: Rig;
  private root: THREE.Object3D;
  private groundY = -Infinity;
  private groundAge = 99;
  private settled = 0;

  constructor(rig: Rig, root: THREE.Object3D, impulse?: THREE.Vector3) {
    this.rig = rig;
    this.root = root;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.pos.push(new THREE.Vector3());
      this.prev.push(new THREE.Vector3());
    }
    for (const [name, bone] of BONE_SOURCE) {
      const idx = P[name];
      this.pos[idx].setFromMatrixPosition(rig.bones[bone].matrixWorld);
    }
    // hand/foot tips sit past the last bone origin so limbs have real length
    const push = (i: number, from: number, s: number) => {
      _a.subVectors(this.pos[i], this.pos[from]).multiplyScalar(s);
      this.pos[i].add(_a);
    };
    push(P.handL, P.elbowL, 0.55);
    push(P.handR, P.elbowR, 0.55);
    push(P.footL, P.kneeL, 0.2);
    push(P.footR, P.kneeR, 0.2);
    push(P.head, P.neck, 0.75);

    const imp = impulse ?? _a.set(0, 0, 0);
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      this.prev[i].copy(this.pos[i]).addScaledVector(imp, -1 / 60);
    }
    // Extra spin on the upper body so the fall is never symmetric.
    this.prev[P.head].addScaledVector(imp, -0.010);
    this.prev[P.shoulderL].addScaledVector(imp, -0.006);

    for (const [a, b, stiff] of CHAIN) {
      const len = this.pos[a].distanceTo(this.pos[b]);
      this.links.push({ a, b, len: len > 1e-4 ? len : 0.05, stiff });
    }
  }

  get hipsWorld(): THREE.Vector3 {
    return this.pos[P.hips];
  }

  update(dt: number, phys: PhysicsWorld | null): void {
    const step = Math.min(dt, 1 / 30);
    this.groundAge += step;
    if (phys && this.groundAge > 0.25) {
      this.groundAge = 0;
      const h = this.pos[P.hips];
      const hit = phys.raycast(_a.set(h.x, h.y + 1.2, h.z), DOWN, 6, RAY_MASK);
      if (hit) this.groundY = hit.point.y;
    }

    const g = -18 * step * step;
    const damp = 0.985;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const p = this.pos[i];
      const q = this.prev[i];
      const vx = (p.x - q.x) * damp;
      const vy = (p.y - q.y) * damp;
      const vz = (p.z - q.z) * damp;
      q.copy(p);
      p.x += vx;
      p.y += vy + g;
      p.z += vz;
    }

    for (let it = 0; it < 5; it++) {
      for (const l of this.links) {
        const a = this.pos[l.a];
        const b = this.pos[l.b];
        _a.subVectors(b, a);
        const d = _a.length();
        if (d < 1e-6) continue;
        // Soft limits only push apart when over-extended.
        if (l.stiff < 0.2 && d < l.len) continue;
        const diff = ((d - l.len) / d) * 0.5 * l.stiff;
        _a.multiplyScalar(diff);
        a.add(_a);
        b.sub(_a);
      }
      // ground
      if (this.groundY > -1e5) {
        const r = 0.075;
        for (let i = 0; i < PARTICLE_COUNT; i++) {
          const p = this.pos[i];
          const floor = this.groundY + r;
          if (p.y < floor) {
            p.y = floor;
            // friction
            const q = this.prev[i];
            q.x += (p.x - q.x) * 0.55;
            q.z += (p.z - q.z) * 0.55;
          }
        }
      }
    }

    let motion = 0;
    for (let i = 0; i < PARTICLE_COUNT; i++) motion += this.pos[i].distanceToSquared(this.prev[i]);
    this.settled = motion < 1e-5 ? this.settled + step : 0;
  }

  get isSettled(): boolean {
    return this.settled > 0.8;
  }

  /** Map the particle cloud back onto the bone hierarchy. */
  apply(): void {
    const rig = this.rig;
    // Body forward from the shoulder line and the spine.
    _a.subVectors(this.pos[P.shoulderL], this.pos[P.shoulderR]);
    _b.subVectors(this.pos[P.neck], this.pos[P.hips]);
    _fwd.crossVectors(_a, _b);
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, 1);
    _fwd.normalize();

    // Root the skeleton at the ragdoll hips.
    const hipsLocal = _d.copy(this.pos[P.hips]);
    this.root.worldToLocal(hipsLocal);
    rig.bones[0].position.copy(hipsLocal);

    const worldQ: THREE.Quaternion[] = [];
    for (let i = 0; i < rig.bones.length; i++) worldQ.push(rig.rest[i].clone());

    const rootQ = this.root.getWorldQuaternion(_pw).clone().invert();

    for (const [bone, from, to] of BONE_OF) {
      _c.subVectors(this.pos[to], this.pos[from]);
      if (_c.lengthSq() < 1e-8) continue;
      _c.normalize();
      applyFront(_c, _fwd, _q0);
      worldQ[bone].copy(_q0);
    }
    // Feet and toes have no particle chain of their own — carry the bind
    // relationship down from the shin so the corpse keeps its shoes on.
    worldQ[BI.footL].copy(worldQ[BI.shinL]).multiply(rig.rest[BI.footL]);
    worldQ[BI.footR].copy(worldQ[BI.shinR]).multiply(rig.rest[BI.footR]);
    worldQ[BI.toeL].copy(worldQ[BI.footL]).multiply(rig.rest[BI.toeL]);
    worldQ[BI.toeR].copy(worldQ[BI.footR]).multiply(rig.rest[BI.toeR]);

    // Convert world orientations to parent-relative locals, in hierarchy order.
    for (let i = 0; i < rig.bones.length; i++) {
      const bone = rig.bones[i];
      const parent = bone.parent;
      const isBone = parent && (parent as THREE.Bone).isBone === true;
      if (!isBone) {
        // hips: world -> object local
        bone.quaternion.copy(rootQ).multiply(worldQ[i]);
      } else {
        const pi = rig.bones.indexOf(parent as THREE.Bone);
        _q1.copy(worldQ[pi]).invert();
        bone.quaternion.copy(_q1).multiply(worldQ[i]);
      }
    }
    rig.root.updateMatrixWorld(true);
  }
}
