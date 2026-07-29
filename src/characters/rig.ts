/**
 * HUMANOID RIG — the skeleton every character in the game shares.
 *
 * 22 bones: pelvis, a three-link spine, neck + head, clavicles with full arms
 * (upper arm / forearm / hand) and legs (thigh / shin / foot / toe).
 *
 * CONVENTIONS (everything downstream depends on these)
 *   - Character space: feet on y = 0, character FACES +Z, character LEFT is +X.
 *     (This matches `rotation.y = atan2(dx, dz)` used by the player controller.)
 *   - Every bone's local +Y axis points along the bone toward its child. The
 *     rest frame is built so that, for EVERY bone:
 *         rotation about local +X  →  tip swings FORWARD (+Z)
 *         rotation about local +Y  →  twist along the bone
 *         rotation about local +Z  →  tip swings toward the character's RIGHT
 *     so `pitch` is authored with the same sign on both sides of the body and
 *     only lateral channels need mirroring.
 *   - Bind pose is a relaxed A-pose. Geometry is authored directly in this
 *     character space, so `SkinnedMesh.bind(skeleton, identity)` is correct.
 *   - Every build uses NOMINAL_HEIGHT. Per-character height is a uniform scale
 *     on the actor root, which keeps the geometry/skeleton caches tiny.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';

export const BONE_NAMES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'clavicleL', 'upperArmL', 'forearmL', 'handL',
  'clavicleR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Bone index — also the skinIndex written into the geometry. */
export const BI = BONE_NAMES.reduce((acc, n, i) => {
  acc[n] = i;
  return acc;
}, {} as Record<BoneName, number>);

export const BONE_COUNT = BONE_NAMES.length;

/** Every build is authored at this height and scaled per character. */
export const NOMINAL_HEIGHT = 1.75;

export const FRONT = new THREE.Vector3(0, 0, 1);
export const UP = new THREE.Vector3(0, 1, 0);

export type BodyType = 'slim' | 'average' | 'stocky' | 'heavy' | 'tall' | 'short';

export const BODY_TYPES: readonly BodyType[] = ['slim', 'average', 'stocky', 'heavy', 'tall', 'short'];

/* ------------------------------------------------------------------ */
/* Body metrics                                                        */
/* ------------------------------------------------------------------ */

export interface BodyMetrics {
  key: string;
  body: BodyType;
  female: boolean;
  height: number;

  /** Joint half-separations. */
  shoulderHalf: number;
  hipHalf: number;

  /** Segment lengths. */
  upperArmLen: number;
  forearmLen: number;
  handLen: number;

  /** Torso silhouette (half widths / depths, metres). */
  pelvisW: number; pelvisD: number;
  waistW: number; waistD: number;
  chestW: number; chestD: number;
  yokeW: number; yokeD: number;
  bellyPush: number;
  bustPush: number;

  /** Limb radii. */
  deltoidR: number; upperArmR: number; elbowR: number; forearmR: number; wristR: number;
  handW: number; handT: number;
  thighR: number; kneeR: number; calfR: number; ankleR: number;
  neckR: number;

  /** Head. */
  headW: number; headH: number; headD: number;
  footLen: number; footW: number; heelBack: number; ankleHeight: number;

  /** Key heights (metres, character space). */
  ankleY: number; kneeY: number; hipY: number;
  spineY: number; chestY: number; yokeY: number; neckY: number; headY: number; headTopY: number;
  shoulderY: number;
}

interface BodyMod {
  girth: number; shoulder: number; hip: number; leg: number; belly: number; chest: number;
}

const BODY_MODS: Record<BodyType, BodyMod> = {
  slim: { girth: 0.85, shoulder: 0.95, hip: 0.93, leg: 1.02, belly: -0.008, chest: 0.95 },
  average: { girth: 1.00, shoulder: 1.00, hip: 1.00, leg: 1.00, belly: 0.000, chest: 1.00 },
  stocky: { girth: 1.17, shoulder: 1.10, hip: 1.06, leg: 0.96, belly: 0.014, chest: 1.11 },
  heavy: { girth: 1.36, shoulder: 1.06, hip: 1.15, leg: 0.93, belly: 0.062, chest: 1.13 },
  tall: { girth: 0.92, shoulder: 1.03, hip: 0.96, leg: 1.07, belly: 0.000, chest: 0.99 },
  short: { girth: 1.07, shoulder: 1.00, hip: 1.03, leg: 0.92, belly: 0.018, chest: 1.03 },
};

/** Deterministic body metrics for a (bodyType, sex) pair. */
export function bodyMetrics(body: BodyType, female: boolean): BodyMetrics {
  const m = BODY_MODS[body];
  const H = NOMINAL_HEIGHT;
  const g = m.girth * (female ? 0.93 : 1);
  const legF = m.leg * (female ? 1.012 : 1);

  const ankleY = 0.041 * H * legF;
  const kneeY = 0.286 * H * legF;
  const hipY = 0.530 * H * legF;
  // Torso is stretched/compressed so the crown always lands exactly on H.
  const ts = (H - hipY) / (H - 0.530 * H);
  const up = (frac: number) => hipY + (frac - 0.530) * H * ts;

  const shoulderHalf = 0.0975 * H * m.shoulder * (female ? 0.90 : 1);
  const hipHalf = 0.048 * H * m.hip;

  return {
    key: `${body}-${female ? 'f' : 'm'}`,
    body,
    female,
    height: H,

    shoulderHalf,
    hipHalf,

    upperArmLen: 0.186 * H,
    forearmLen: 0.148 * H,
    handLen: 0.098 * H * (female ? 0.93 : 1),

    pelvisW: 0.152 * g * m.hip * (female ? 1.06 : 1),
    pelvisD: 0.116 * g,
    waistW: 0.136 * g * (female ? 0.90 : 1),
    waistD: 0.101 * g,
    chestW: 0.176 * g * m.chest,
    chestD: 0.122 * g * m.chest,
    yokeW: 0.187 * g * m.shoulder,
    yokeD: 0.113 * g,
    bellyPush: m.belly * (female ? 0.55 : 1),
    bustPush: female ? 0.035 * g : 0,

    deltoidR: 0.055 * g * m.shoulder,
    upperArmR: 0.048 * g,
    elbowR: 0.042 * g,
    forearmR: 0.046 * g,
    wristR: 0.032 * g * (female ? 0.92 : 1),
    handW: 0.046 * g * (female ? 0.90 : 1),
    handT: 0.024 * g,

    thighR: 0.086 * g * m.hip,
    kneeR: 0.058 * g,
    calfR: 0.064 * g,
    ankleR: 0.041 * g,
    neckR: 0.050 * g * (female ? 0.90 : 1),

    headW: 0.0985 * (female ? 0.955 : 1),
    headH: 0.118,
    headD: 0.116 * (female ? 0.965 : 1),

    footLen: 0.152 * H * (female ? 0.93 : 1),
    footW: 0.048 * g,
    heelBack: 0.062,
    ankleHeight: ankleY,

    ankleY,
    kneeY,
    hipY,
    spineY: up(0.586),
    chestY: up(0.648),
    yokeY: up(0.722),
    neckY: up(0.816),
    headY: up(0.862),
    headTopY: H,
    shoulderY: up(0.796),
  };
}

/* ------------------------------------------------------------------ */
/* Rig construction                                                    */
/* ------------------------------------------------------------------ */

export interface RigPoints {
  /** Bind-pose world position of each bone's origin, in character space. */
  joint: Record<BoneName, THREE.Vector3>;
  /** Bind-pose direction each bone points (unit, character space). */
  dir: Record<BoneName, THREE.Vector3>;
  /** Length of each bone (to its primary child / tip). */
  len: Record<BoneName, number>;
  handTipL: THREE.Vector3;
  handTipR: THREE.Vector3;
  toeTipL: THREE.Vector3;
  toeTipR: THREE.Vector3;
}

export interface Rig {
  metrics: BodyMetrics;
  points: RigPoints;
  bones: THREE.Bone[];
  byName: Record<BoneName, THREE.Bone>;
  /** Bind-pose local rotation of each bone (relative to its parent). */
  rest: THREE.Quaternion[];
  /** Bind-pose local position of each bone. */
  restPos: THREE.Vector3[];
  root: THREE.Bone;
  skeleton: THREE.Skeleton;
}

const PARENT: Record<BoneName, BoneName | null> = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  clavicleL: 'upperChest',
  upperArmL: 'clavicleL',
  forearmL: 'upperArmL',
  handL: 'forearmL',
  clavicleR: 'upperChest',
  upperArmR: 'clavicleR',
  forearmR: 'upperArmR',
  handR: 'forearmR',
  thighL: 'hips',
  shinL: 'thighL',
  footL: 'shinL',
  toeL: 'footL',
  thighR: 'hips',
  shinR: 'thighR',
  footR: 'shinR',
  toeR: 'footR',
};

export function parentOf(n: BoneName): BoneName | null {
  return PARENT[n];
}

/**
 * Rest orientation for a bone pointing along `dir`.
 *
 * ex = normalize(dir × FRONT) so that d/dθ about ex is +FRONT: a positive
 * rotation about the bone's local X always swings its tip forward.
 */
export function aimQuaternion(dir: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  const ey = _a.copy(dir).normalize();
  const ref = Math.abs(ey.dot(FRONT)) > 0.985 ? UP : FRONT;
  const ex = _b.crossVectors(ey, ref).normalize();
  const ez = _c.crossVectors(ex, ey).normalize();
  _m.makeBasis(ex, ey, ez);
  return out.setFromRotationMatrix(_m);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Bind-pose joint positions for a body. */
export function rigPoints(m: BodyMetrics): RigPoints {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const joint = {} as Record<BoneName, THREE.Vector3>;

  joint.hips = V(0, m.hipY, 0);
  joint.spine = V(0, m.spineY, 0.002);
  joint.chest = V(0, m.chestY, 0.004);
  joint.upperChest = V(0, m.yokeY, 0.004);
  joint.neck = V(0, m.neckY, -0.008);
  joint.head = V(0, m.headY, 0.002);

  // Arms — relaxed A-pose, tangent controls how far they hang from the body.
  const spread = 0.255;
  const spread2 = 0.115;
  const upperDir = V(spread, -1, 0.02).normalize();
  const foreDir = V(spread2, -1, 0.045).normalize();

  for (const s of [1, -1] as const) {
    const L = s > 0 ? 'L' : 'R';
    const clav = V(s * 0.030, m.shoulderY + 0.030, 0.008);
    const shoulder = V(s * m.shoulderHalf, m.shoulderY, 0);
    const elbow = shoulder.clone().addScaledVector(V(s * upperDir.x, upperDir.y, upperDir.z), m.upperArmLen);
    const wrist = elbow.clone().addScaledVector(V(s * foreDir.x, foreDir.y, foreDir.z), m.forearmLen);
    joint[`clavicle${L}` as BoneName] = clav;
    joint[`upperArm${L}` as BoneName] = shoulder;
    joint[`forearm${L}` as BoneName] = elbow;
    joint[`hand${L}` as BoneName] = wrist;

    joint[`thigh${L}` as BoneName] = V(s * m.hipHalf, m.hipY, 0.004);
    joint[`shin${L}` as BoneName] = V(s * m.hipHalf * 0.93, m.kneeY, 0.012);
    joint[`foot${L}` as BoneName] = V(s * m.hipHalf * 0.90, m.ankleY, -0.016);
    joint[`toe${L}` as BoneName] = V(s * m.hipHalf * 0.90, m.ankleY * 0.52, m.footLen * 0.44);
  }

  const handDirL = joint.handL.clone().sub(joint.forearmL).normalize();
  const handDirR = joint.handR.clone().sub(joint.forearmR).normalize();
  const handTipL = joint.handL.clone().addScaledVector(handDirL, m.handLen);
  const handTipR = joint.handR.clone().addScaledVector(handDirR, m.handLen);
  const toeTipL = joint.toeL.clone().add(V(0, -m.ankleY * 0.30, m.footLen * 0.30));
  const toeTipR = joint.toeR.clone().add(V(0, -m.ankleY * 0.30, m.footLen * 0.30));

  const tip: Partial<Record<BoneName, THREE.Vector3>> = {
    head: V(0, m.headTopY, 0.002),
    handL: handTipL,
    handR: handTipR,
    toeL: toeTipL,
    toeR: toeTipR,
  };

  // Primary child of each bone, used for the bone direction.
  const CHILD: Partial<Record<BoneName, BoneName>> = {
    hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
    clavicleL: 'upperArmL', upperArmL: 'forearmL', forearmL: 'handL',
    clavicleR: 'upperArmR', upperArmR: 'forearmR', forearmR: 'handR',
    thighL: 'shinL', shinL: 'footL', footL: 'toeL',
    thighR: 'shinR', shinR: 'footR', footR: 'toeR',
  };

  const dir = {} as Record<BoneName, THREE.Vector3>;
  const len = {} as Record<BoneName, number>;
  for (const n of BONE_NAMES) {
    const c = CHILD[n];
    const target = c ? joint[c] : tip[n]!;
    const d = target.clone().sub(joint[n]);
    len[n] = d.length();
    dir[n] = len[n] > 1e-5 ? d.divideScalar(len[n]) : UP.clone();
  }

  return { joint, dir, len, handTipL, handTipR, toeTipL, toeTipR };
}

/** Bind-pose inverse matrices, cached per body key (shared across actors). */
const inverseCache = new Map<string, THREE.Matrix4[]>();

/**
 * Build a fresh bone hierarchy plus a Skeleton. Bones cannot be shared between
 * characters, but bind inverses can — they only depend on the body metrics.
 */
export function buildRig(m: BodyMetrics): Rig {
  const points = rigPoints(m);
  const bones: THREE.Bone[] = [];
  const byName = {} as Record<BoneName, THREE.Bone>;
  const rest: THREE.Quaternion[] = [];
  const restPos: THREE.Vector3[] = [];

  const worldQuat: THREE.Quaternion[] = [];

  for (let i = 0; i < BONE_COUNT; i++) {
    const n = BONE_NAMES[i];
    const bone = new THREE.Bone();
    bone.name = n;
    bones.push(bone);
    byName[n] = bone;

    const qw = aimQuaternion(points.dir[n]);
    worldQuat.push(qw);

    const p = PARENT[n];
    if (p === null) {
      bone.position.copy(points.joint[n]);
      bone.quaternion.copy(qw);
    } else {
      const pi = BI[p];
      const inv = worldQuat[pi].clone().invert();
      bone.position.copy(points.joint[n]).sub(points.joint[p]).applyQuaternion(inv);
      bone.quaternion.copy(inv).multiply(qw);
      bones[pi].add(bone);
    }
    rest.push(bone.quaternion.clone());
    restPos.push(bone.position.clone());
  }

  const root = bones[0];
  root.updateMatrixWorld(true);

  let inverses = inverseCache.get(m.key);
  if (!inverses) {
    inverses = bones.map((b) => b.matrixWorld.clone().invert());
    inverseCache.set(m.key, inverses);
  }
  const skeleton = new THREE.Skeleton(bones, inverses);

  return { metrics: m, points, bones, byName, rest, restPos, root, skeleton };
}

/** Reset every bone to its bind rotation. */
export function resetToRest(rig: Rig): void {
  for (let i = 0; i < BONE_COUNT; i++) {
    rig.bones[i].quaternion.copy(rig.rest[i]);
    rig.bones[i].position.copy(rig.restPos[i]);
  }
}
