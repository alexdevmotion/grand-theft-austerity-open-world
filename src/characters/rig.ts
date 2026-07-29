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

/**
 * The body. Twenty-two bones, and their indices are FROZEN — `src/ai/**` reads
 * `BI.handR`, `BI.upperArmL` and friends, and the skinIndex attribute in every
 * cached geometry is these numbers. Anything new goes on the end.
 */
export const CORE_BONE_NAMES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'clavicleL', 'upperArmL', 'forearmL', 'handL',
  'clavicleR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
] as const;

/** Digits, thumb first. Two phalanges each — enough to curl and to oppose. */
export const DIGIT_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'] as const;
export type DigitName = (typeof DIGIT_NAMES)[number];

/**
 * HANDS. The stumps are gone: every character now carries a palm, four fingers
 * and an opposed thumb, each with a proximal and a distal segment, so a hand
 * can rest, point and — the reason this exists — close around a steering wheel.
 *
 * Twenty bones for two hands is deliberate restraint. Three phalanges per digit
 * is the anatomical answer and costs thirty; at the distances this game shows a
 * hand, the second knuckle carries the read and the third does not, and the
 * whole crowd pays for every bone in the rig.
 */
const HAND_BONE_NAMES = (['L', 'R'] as const).flatMap((side) =>
  DIGIT_NAMES.flatMap((d) => [`${d}0${side}`, `${d}1${side}`] as const),
);

export const BONE_NAMES = [...CORE_BONE_NAMES, ...HAND_BONE_NAMES] as const;

export type BoneName = (typeof BONE_NAMES)[number];

/** Bone index — also the skinIndex written into the geometry. */
export const BI = BONE_NAMES.reduce((acc, n, i) => {
  acc[n] = i;
  return acc;
}, {} as Record<BoneName, number>);

export const BONE_COUNT = BONE_NAMES.length;

/**
 * Bones a character that is not showing its hands has to evaluate. Poses stop
 * here for the crowd, leaving the fingers in their (already relaxed) bind pose
 * — so eighty pedestrians cost exactly what they cost before the hands landed.
 */
export const CORE_BONE_COUNT = CORE_BONE_NAMES.length;

/** [proximal, distal] bone indices per digit, per hand. */
export const DIGITS: Record<'L' | 'R', ReadonlyArray<readonly [number, number]>> = {
  L: DIGIT_NAMES.map((d) => [BI[`${d}0L` as BoneName], BI[`${d}1L` as BoneName]] as const),
  R: DIGIT_NAMES.map((d) => [BI[`${d}0R` as BoneName], BI[`${d}1R` as BoneName]] as const),
};

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

  /**
   * BIACROMIAL BREADTH — joint centre to joint centre.
   *
   * This was `0.0975 * H`: 341 mm across at 1.75 m, when an adult male measures
   * 400–460 mm. Numerically it is a 15% error; visually it is the difference
   * between a man and a bobblehead, because the eye judges head size against
   * shoulder span and nothing else. A correctly-proportioned head — and the head
   * IS correctly proportioned, `measureProportions` pins it at 1/7.5 — still
   * reads oversized when the frame under it is a coat hanger.
   *
   * 0.1143 * H puts it at 400 mm at nominal height, the bottom of the real
   * range, which is where a lean-but-solid man in his forties sits. `bodyMetrics`
   * is asserted against this in `face.test.ts`; the torso yoke and chest below
   * were widened with it so the deltoid still lands on the shoulder seam instead
   * of tearing away from a torso that stayed narrow.
   */
  const shoulderHalf = 0.1143 * H * m.shoulder * (female ? 0.90 : 1);
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
    // Chest and yoke track the wider shoulder joint. The yoke has to stay a
    // little proud of `shoulderHalf` or the deltoid ring — which starts buried
    // inside the torso by design, see `humanoid.ts` — surfaces outside it and
    // the arm reads as a pauldron bolted onto a narrow chest.
    // Chest and yoke track the wider shoulder joint. The yoke has to overlap
    // the deltoid from both sides — `humanoid.ts` buries the first deltoid ring
    // inside the torso on purpose, so the shoulder reads as a joint rather than
    // a pauldron — and `face.test.ts` asserts exactly that for every build.
    //
    // The yoke takes only a fraction of `girth`. Girth is a fat term: on the
    // 'heavy' build a full 1.36 pushed the yoke out past the deltoid entirely,
    // which sank the arms into a torso 611 mm across. The width across the top
    // of the shoulders is bone, and bone does not vary with waistline.
    chestW: 0.194 * g * m.chest,
    chestD: 0.122 * g * m.chest,
    yokeW: 0.212 * (0.35 + 0.65 * g) * m.shoulder,
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
  /** Per-hand frame the digits were authored in — the mesh builder reuses it. */
  hand: Record<'L' | 'R', { down: THREE.Vector3; palmN: THREE.Vector3; across: THREE.Vector3 }>;
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

const PARENT_CORE: Record<string, BoneName | null> = {
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

const PARENT = ((): Record<BoneName, BoneName | null> => {
  const out = { ...PARENT_CORE } as Record<BoneName, BoneName | null>;
  for (const side of ['L', 'R'] as const) {
    for (const d of DIGIT_NAMES) {
      out[`${d}0${side}` as BoneName] = `hand${side}` as BoneName;
      out[`${d}1${side}` as BoneName] = `${d}0${side}` as BoneName;
    }
  }
  return out;
})();

export function parentOf(n: BoneName): BoneName | null {
  return PARENT[n];
}

/* ------------------------------------------------------------------ */
/* Hand proportions                                                    */
/* ------------------------------------------------------------------ */

/**
 * Digit geometry as fractions of `handLen` (wrist to fingertip). Sourced from
 * standard adult hand anthropometry: the palm is a little over half the hand,
 * the middle finger is the longest, and the little finger is about four-fifths
 * of it. `spread` is the knuckle's offset across the palm in units of `handW`,
 * signed so that +1 is the thumb side.
 */
export const DIGIT_SPEC: Record<DigitName, {
  root: number; spread: number; lift: number; prox: number; dist: number; curl: number;
}> = {
  //        along palm    across       out of palm   segment lengths    bind curl
  thumb:  { root: 0.215, spread: 0.86, lift: 0.62, prox: 0.240, dist: 0.185, curl: 0.24 },
  index:  { root: 0.545, spread: 0.80, lift: 0.10, prox: 0.230, dist: 0.185, curl: 0.24 },
  middle: { root: 0.560, spread: 0.27, lift: 0.06, prox: 0.250, dist: 0.200, curl: 0.26 },
  ring:   { root: 0.545, spread: -0.27, lift: 0.02, prox: 0.230, dist: 0.185, curl: 0.30 },
  pinky:  { root: 0.505, spread: -0.80, lift: 0.00, prox: 0.180, dist: 0.145, curl: 0.34 },
};

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

  /* ---- digits ----
   * Built in the hand's own frame:
   *   down   — along the hand, wrist to fingertip
   *   palmN  — out of the PALM. The arms hang mid-pronated, so the palms face
   *            the thighs and `palmN` is medial. Fingers curl along it.
   *   across — from the little finger toward the thumb, which lands anterior
   *            for both hands, because that is where thumbs point.
   *
   * The bind pose is a RELAXED hand, not a flat one — every joint carries a
   * little curl — which is why a pedestrian that never touches a finger bone
   * still has hands that hang like hands. */
  const digitTip = {} as Record<BoneName, THREE.Vector3>;
  const digitFrames = {} as Record<'L' | 'R', { down: THREE.Vector3; palmN: THREE.Vector3; across: THREE.Vector3 }>;
  for (const s of [1, -1] as const) {
    const L = s > 0 ? 'L' : 'R';
    const wrist = joint[`hand${L}` as BoneName];
    const down = (s > 0 ? handDirL : handDirR).clone();
    const palmN = V(-s, 0, 0);
    palmN.addScaledVector(down, -palmN.dot(down)).normalize();
    const across = new THREE.Vector3().crossVectors(down, palmN).normalize();
    if (across.z < 0) across.negate();
    digitFrames[L] = { down, palmN, across };

    for (const d of DIGIT_NAMES) {
      const spec = DIGIT_SPEC[d];
      const knuckle = wrist.clone()
        .addScaledVector(down, m.handLen * spec.root)
        .addScaledVector(across, m.handW * spec.spread)
        .addScaledVector(palmN, m.handT * spec.lift);

      // Each phalanx points a little further round than the last: that is the
      // curl. The thumb also swings across the palm — it is OPPOSED, which is
      // the whole point of a thumb.
      const oppose = d === 'thumb' ? 0.70 : 0;
      const p0 = down.clone()
        .addScaledVector(palmN, Math.sin(spec.curl) + oppose * 0.35)
        .addScaledVector(across, oppose)
        .normalize();
      const p1 = down.clone()
        .addScaledVector(palmN, Math.sin(spec.curl * 2.1) + oppose * 0.55)
        .addScaledVector(across, oppose * 0.60)
        .normalize();

      const mid = knuckle.clone().addScaledVector(p0, m.handLen * spec.prox);
      const tip = mid.clone().addScaledVector(p1, m.handLen * spec.dist);
      joint[`${d}0${L}` as BoneName] = knuckle;
      joint[`${d}1${L}` as BoneName] = mid;
      digitTip[`${d}1${L}` as BoneName] = tip;
    }
  }
  const toeTipL = joint.toeL.clone().add(V(0, -m.ankleY * 0.30, m.footLen * 0.30));
  const toeTipR = joint.toeR.clone().add(V(0, -m.ankleY * 0.30, m.footLen * 0.30));

  const tip: Partial<Record<BoneName, THREE.Vector3>> = {
    ...digitTip,
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
  for (const L of ['L', 'R'] as const) {
    for (const d of DIGIT_NAMES) CHILD[`${d}0${L}` as BoneName] = `${d}1${L}` as BoneName;
  }

  const dir = {} as Record<BoneName, THREE.Vector3>;
  const len = {} as Record<BoneName, number>;
  for (const n of BONE_NAMES) {
    const c = CHILD[n];
    const target = c ? joint[c] : tip[n]!;
    const d = target.clone().sub(joint[n]);
    len[n] = d.length();
    dir[n] = len[n] > 1e-5 ? d.divideScalar(len[n]) : UP.clone();
  }

  return { joint, dir, len, handTipL, handTipR, toeTipL, toeTipR, hand: digitFrames };
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
