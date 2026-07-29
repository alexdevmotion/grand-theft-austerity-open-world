/**
 * BODY INVARIANTS — footing, hands, and directional locomotion.
 *
 * These are the three things a player looks at first and the three that were
 * wrong: a character sunk into the pavement, mittens instead of hands, and a
 * backpedal that played as a spin. Each of them is checkable without a GPU, so
 * each of them is checked here.
 *
 * Run with `bun test`.
 */

import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { AnimationController, Pose } from './animation';
import { buildHumanoidGeometry } from './humanoid';
import {
  BI, BODY_TYPES, BONE_COUNT, CORE_BONE_COUNT, DIGITS,
  NOMINAL_HEIGHT, bodyMetrics, buildRig, type BodyType, type Rig,
} from './rig';
import { HERO_APPEARANCE, rollAppearance } from './wardrobe';
import { Rng } from '../core/rng';

const rigs = new Map<string, Rig>();
function rigFor(body: BodyType, female: boolean): Rig {
  const key = `${body}-${female}`;
  let r = rigs.get(key);
  if (!r) {
    r = buildRig(bodyMetrics(body, female));
    rigs.set(key, r);
  }
  return r;
}

/* ------------------------------------------------------------------ */
/* 1. FOOTING                                                          */
/* ------------------------------------------------------------------ */

/**
 * The whole footing contract in one number.
 *
 * Every mover in the game — the crowd (`src/ai/peds.ts` writes
 * `p.position.y = spatial.groundHeight(x, z)`) and now the player — places the
 * actor root ON the ground and trusts the mesh to have its soles at y = 0 in
 * character space. If that is not true, foot IK has nothing to correct toward
 * and the character floats or sinks by a constant.
 */
test.each(BODY_TYPES)('%s: the soles sit on y = 0 in character space', (body: BodyType) => {
  for (const female of [false, true]) {
    const rig = rigFor(body, female);
    const geo = buildHumanoidGeometry(rollAppearance(new Rng(`foot-${body}`), 'civilian'), rig);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;

    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < lowest) lowest = y;
      if (y > highest) highest = y;
    }

    // Soles on the ground plane: a shoe sole may bite a couple of millimetres
    // under it (that is the tread), never a centimetre, and must never float.
    expect(lowest).toBeLessThanOrEqual(0.004);
    expect(lowest).toBeGreaterThan(-0.02);
    // And the crown lands on the nominal height the actor scale is derived from.
    expect(highest).toBeGreaterThan(NOMINAL_HEIGHT - 0.06);
    expect(highest).toBeLessThan(NOMINAL_HEIGHT + 0.06);
  }
});

/**
 * The hero specifically. He is the one the camera lives behind, and his
 * collider is sized from `HERO_APPEARANCE.height`, so the mesh has to fill it.
 */
test('the hero fills the capsule his collider is sized from', () => {
  const rig = rigFor(HERO_APPEARANCE.body, HERO_APPEARANCE.female);
  const geo = buildHumanoidGeometry(HERO_APPEARANCE, rig);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < lowest) lowest = y;
    if (y > highest) highest = y;
  }
  const scale = HERO_APPEARANCE.height / NOMINAL_HEIGHT;
  // His soles are on the plane the player system now places him on.
  expect(lowest * scale).toBeGreaterThan(-0.02);
  expect(lowest * scale).toBeLessThanOrEqual(0.005);
  // The body geometry stops at the neck for a cast member — the landmark-fitted
  // head is a separate mesh parented to the head bone — so the crown is checked
  // through the rig, which is what the collider is sized against.
  expect(highest).toBeGreaterThan(rig.metrics.neckY);
  expect(rig.metrics.headTopY * scale).toBeCloseTo(HERO_APPEARANCE.height, 6);
});

/**
 * The ankle height the foot IK solves toward has to agree with where the mesh
 * actually puts the sole, or planting a foot drives it into the ground.
 */
test('the ankle sits one sole thickness above the ground', () => {
  for (const body of BODY_TYPES) {
    const rig = rigFor(body, false);
    const ankle = rig.points.joint.footL.y;
    expect(ankle).toBeCloseTo(rig.metrics.ankleY, 6);
    // A real ankle joint is 60-90 mm up from the floor.
    expect(ankle).toBeGreaterThan(0.055);
    expect(ankle).toBeLessThan(0.095);
  }
});

/* ------------------------------------------------------------------ */
/* 2. HANDS                                                            */
/* ------------------------------------------------------------------ */

test('the rig carries a full set of digits without moving any body bone', () => {
  // The body indices are load-bearing: `src/ai/**` reads BI.handR and friends,
  // and every cached geometry's skinIndex attribute is these numbers.
  expect(BI.hips).toBe(0);
  expect(BI.handL).toBe(9);
  expect(BI.handR).toBe(13);
  expect(BI.toeR).toBe(21);
  expect(CORE_BONE_COUNT).toBe(22);
  // Two phalanges for each of five digits on each of two hands.
  expect(BONE_COUNT).toBe(CORE_BONE_COUNT + 2 * 5 * 2);
  for (const side of ['L', 'R'] as const) {
    expect(DIGITS[side]).toHaveLength(5);
    for (const [prox, dist] of DIGITS[side]) {
      expect(prox).toBeGreaterThanOrEqual(CORE_BONE_COUNT);
      expect(dist).toBeGreaterThan(prox);
    }
  }
});

test.each(BODY_TYPES)('%s: hand proportions are a hand, not a mitten', (body: BodyType) => {
  const rig = rigFor(body, false);
  const m = rig.metrics;
  const P = rig.points.joint;

  for (const side of ['L', 'R'] as const) {
    const wrist = P[`hand${side}`];

    // -- overall length: wrist to the tip of the middle finger is the hand.
    const midTip = P[`middle1${side}`].clone()
      .addScaledVector(rig.points.dir[`middle1${side}`], rig.points.len[`middle1${side}`]);
    const reach = midTip.distanceTo(wrist);
    expect(reach).toBeGreaterThan(m.handLen * 0.90);
    expect(reach).toBeLessThan(m.handLen * 1.10);

    // -- palm is a little over half the hand; fingers are the rest. Anything
    //    outside this and you have either a paddle or a spider.
    const palm = P[`middle0${side}`].distanceTo(wrist);
    expect(palm / reach).toBeGreaterThan(0.48);
    expect(palm / reach).toBeLessThan(0.62);

    // -- the middle finger is the longest and the little finger the shortest.
    const fingerLen = (d: string): number =>
      P[`${d}0${side}`].distanceTo(P[`${d}1${side}`]) + rig.points.len[`${d}1${side}`];
    expect(fingerLen('middle')).toBeGreaterThan(fingerLen('index'));
    expect(fingerLen('middle')).toBeGreaterThan(fingerLen('ring'));
    expect(fingerLen('ring')).toBeGreaterThan(fingerLen('pinky'));

    // -- knuckles are spread across the palm and ordered, so the fingers cannot
    //    be co-located (which is exactly what a stump is).
    const across = rig.points.hand[side].across;
    const spread = ['index', 'middle', 'ring', 'pinky'].map((d) =>
      P[`${d}0${side}`].clone().sub(wrist).dot(across),
    );
    for (let i = 1; i < spread.length; i++) expect(spread[i]).toBeLessThan(spread[i - 1]);
    const knuckleSpan = spread[0] - spread[3];
    // Four fingers across a palm: roughly the palm's own width.
    expect(knuckleSpan).toBeGreaterThan(m.handW * 1.2);
    expect(knuckleSpan).toBeLessThan(m.handW * 2.2);

    // -- THE THUMB IS OPPOSED. It has to sit off the finger row, toward the
    //    palm, or it is a fifth finger and the hand cannot grip anything.
    const palmN = rig.points.hand[side].palmN;
    const thumbOut = P[`thumb0${side}`].clone().sub(wrist).dot(palmN);
    const indexOut = P[`index0${side}`].clone().sub(wrist).dot(palmN);
    expect(thumbOut).toBeGreaterThan(indexOut + m.handT * 0.25);
    // It also starts far lower down the palm than the fingers do.
    const alongThumb = P[`thumb0${side}`].distanceTo(wrist);
    expect(alongThumb).toBeLessThan(palm * 0.80);
    // And its tip swings across the palm, toward the fingers, not away.
    const thumbTip = P[`thumb1${side}`].clone()
      .addScaledVector(rig.points.dir[`thumb1${side}`], rig.points.len[`thumb1${side}`]);
    expect(thumbTip.clone().sub(wrist).dot(palmN)).toBeGreaterThan(thumbOut);
  }

  // Left and right are mirror images, not copies.
  expect(P.thumb0L.x).toBeCloseTo(-P.thumb0R.x, 4);
  expect(P.pinky1L.z).toBeCloseTo(P.pinky1R.z, 4);
});

test('a grip closes the fingers and a rest pose does not', () => {
  const rig = rigFor('average', false);
  const anim = new AnimationController(rig, 3);
  anim.handDetail = true;

  const tipDistance = (grip: number): number => {
    // Drive the seated pose, which is where the wheel grip lives, then read the
    // fingertip's distance from the palm.
    anim.drive({ state: grip > 0 ? 'drive' : 'sit', speed: 0, grounded: true });
    for (let i = 0; i < 90; i++) anim.update(1 / 60);
    anim.applyTo(rig);
    rig.root.updateMatrixWorld(true);
    const palm = new THREE.Vector3().setFromMatrixPosition(rig.byName.handR.matrixWorld);
    // The FINGERTIP, not the last joint: rotating a knuckle barely moves the
    // joint above it, so measuring the joint measures nothing.
    const tip = new THREE.Vector3(0, rig.points.len.middle1R, 0)
      .applyMatrix4(rig.byName.middle1R.matrixWorld);
    return palm.distanceTo(tip);
  };

  const open = tipDistance(0);
  const closed = tipDistance(1);
  expect(closed).toBeLessThan(open * 0.92);
});

test('the crowd does not pay for fingers it never shows', () => {
  const rig = rigFor('average', false);
  const anim = new AnimationController(rig, 1);
  // Default: hands off, poses stop at the body.
  expect(anim.handDetail).toBe(false);
  const pose = new Pose();
  expect(pose.limit).toBe(BONE_COUNT);
  anim.handDetail = true;
  expect(anim.handDetail).toBe(true);
  anim.handDetail = false;
  expect(anim.handDetail).toBe(false);
  // With fingers off the finger bones are never written, so they hold bind.
  // Compared component-wise: `Quaternion.angleTo` is 2*acos(|dot|) and a bone
  // quaternion is only normalised to float precision, so it reports half a
  // milliradian of "rotation" against a copy of itself.
  const before = rig.byName.index0R.quaternion.clone();
  anim.drive({ state: 'drive', speed: 0, grounded: true });
  for (let i = 0; i < 30; i++) anim.update(1 / 60);
  anim.applyTo(rig);
  const after = rig.byName.index0R.quaternion;
  expect(after.x).toBeCloseTo(before.x, 9);
  expect(after.y).toBeCloseTo(before.y, 9);
  expect(after.z).toBeCloseTo(before.z, 9);
  expect(after.w).toBeCloseTo(before.w, 9);
});

/* ------------------------------------------------------------------ */
/* 3. DIRECTIONAL LOCOMOTION                                           */
/* ------------------------------------------------------------------ */

/**
 * Settle the controller on a drive and return the authored pose delta for one
 * bone, as the quaternion channels the clips actually write.
 */
function channels(
  rig: Rig, bone: number, d: { moveForward?: number; moveStrafe?: number; speed: number },
  frames = 120,
): { x: number; y: number; z: number } {
  const anim = new AnimationController(rig, 0);
  for (let i = 0; i < frames; i++) {
    anim.drive({ state: 'walk', grounded: true, ...d });
    anim.update(1 / 60);
  }
  const q = anim.pose.q;
  return { x: q[bone * 4], y: q[bone * 4 + 1], z: q[bone * 4 + 2] };
}

test('walking backwards leans back, not forward', () => {
  const rig = rigFor('average', false);
  // Read the AUTHORED delta, not the composed bone quaternion: the latter is
  // `rest * delta` and the rest frame swamps the channel being measured.
  const fwd = channels(rig, BI.hips, { moveForward: 1, moveStrafe: 0, speed: 2.4 });
  const back = channels(rig, BI.hips, { moveForward: -1, moveStrafe: 0, speed: 2.4 });
  // Bone-space +X pitches the tip FORWARD (see rig.ts conventions).
  expect(fwd.x).toBeGreaterThan(0.002);
  expect(back.x).toBeLessThan(0);
  // The forward lean is not merely reduced, it is reversed.
  expect(Math.sign(back.x)).toBe(-Math.sign(fwd.x));
});

test('strafing abducts the hips instead of swinging them fore and aft', () => {
  const rig = rigFor('average', false);

  const sample = (moveStrafe: number): { roll: number; pitchSwing: number } => {
    const anim = new AnimationController(rig, 0);
    let maxRoll = 0;
    let maxPitch = 0;
    for (let i = 0; i < 240; i++) {
      anim.drive({ state: 'walk', grounded: true, speed: 2.4, moveForward: 0, moveStrafe });
      anim.update(1 / 60);
      if (i > 120) {
        const q = anim.pose.q;
        maxRoll = Math.max(maxRoll, Math.abs(q[BI.thighL * 4 + 2]));
        maxPitch = Math.max(maxPitch, Math.abs(q[BI.thighL * 4]));
      }
    }
    return { roll: maxRoll, pitchSwing: maxPitch };
  };

  const left = sample(1);
  const right = sample(-1);
  // A side-step is a LATERAL leg cycle: the roll channel has to carry it.
  expect(left.roll).toBeGreaterThan(0.05);
  expect(right.roll).toBeGreaterThan(0.05);
  // And it must not be smuggled through the sagittal channel — that is the
  // forward-walk clip being reused, which is what the bug report was about.
  expect(left.roll).toBeGreaterThan(left.pitchSwing);

  // Forward travel is the opposite: sagittal dominant.
  const ahead = channels(rig, BI.thighL, { moveForward: 1, moveStrafe: 0, speed: 2.4 });
  const across = channels(rig, BI.thighL, { moveForward: 0, moveStrafe: 1, speed: 2.4 });
  expect(Math.abs(ahead.x)).toBeGreaterThan(Math.abs(across.x));
});

test('an omitted travel vector behaves exactly like walking forward', () => {
  // The whole crowd drives without one. It must be bit-identical or eighty
  // pedestrians change gait the day the player system starts sending it.
  const a = rigFor('slim', false);
  const b = rigFor('slim', true);
  const runA = new AnimationController(a, 7);
  const runB = new AnimationController(b, 7);
  for (let i = 0; i < 100; i++) {
    runA.drive({ state: 'jog', speed: 4.4, grounded: true });
    runB.drive({ state: 'jog', speed: 4.4, grounded: true, moveForward: 1, moveStrafe: 0 });
    runA.update(1 / 60);
    runB.update(1 / 60);
  }
  for (let i = 0; i < BONE_COUNT * 4; i++) {
    expect(runA.pose.q[i]).toBeCloseTo(runB.pose.q[i], 6);
  }
});

test('the boarding pose travels from standing to seated', () => {
  const rig = rigFor('average', false);
  const anim = new AnimationController(rig, 0);
  anim.handDetail = true;

  const hipHeight = (sit: number): number => {
    for (let i = 0; i < 60; i++) {
      anim.drive({
        state: 'idle', speed: 0, grounded: true,
        board: { sit, reach: 0.4, side: 1, closing: false },
      });
      anim.update(1 / 60);
    }
    anim.applyTo(rig);
    rig.root.updateMatrixWorld(true);
    return new THREE.Vector3().setFromMatrixPosition(rig.byName.hips.matrixWorld).y;
  };

  const standing = hipHeight(0);
  const seated = hipHeight(1);
  // Sitting down drops the hips by most of the thigh's length.
  expect(standing - seated).toBeGreaterThan(0.25);
  expect(seated).toBeGreaterThan(0.30);
  expect(seated).toBeLessThan(0.60);
});
