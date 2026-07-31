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
import { ATLAS_SIZE, HERO_APPEARANCE, SLOT, rollAppearance, slotSurface } from './wardrobe';
import { Rng } from '../core/rng';
import type { PedArchetype } from '../core/services';

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
/* 2b. THE BODY IS ONE BODY                                            */
/* ------------------------------------------------------------------ */

/**
 * Rasterise the front-view (XY) silhouette of a geometry into a bitmask.
 *
 * A playtest called the character "a mannequin", and the single most damning
 * sentence in it was that you could see daylight between his arms and his
 * torso. That is a claim about the SILHOUETTE and nothing else — not about
 * normals, not about weights — so it is checkable exactly the way the eye
 * checks it: flatten the mesh onto the view plane and look for holes.
 *
 * `cell` is the world size of one raster cell, so the numbers the tests below
 * assert are millimetres of real gap and not pixel counts.
 */
function silhouette(geo: THREE.BufferGeometry, n = 400): {
  grid: Uint8Array; n: number; cell: number; yOf(row: number): number;
} {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const idx = geo.getIndex()!;
  const x0 = -0.5, x1 = 0.5, y0 = 0, y1 = 2;
  const grid = new Uint8Array(n * n);
  const px = (x: number) => ((x - x0) / (x1 - x0)) * n;
  const py = (y: number) => ((y - y0) / (y1 - y0)) * n;

  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    const ax = px(pos.getX(i0)), ay = py(pos.getY(i0));
    const bx = px(pos.getX(i1)), by = py(pos.getY(i1));
    const cx = px(pos.getX(i2)), cy = py(pos.getY(i2));
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;
    const r0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const r1 = Math.min(n - 1, Math.ceil(Math.max(ay, by, cy)));
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const c1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx, cx)));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const qx = c + 0.5, qy = r + 0.5;
        const w0 = ((bx - qx) * (cy - qy) - (cx - qx) * (by - qy)) / det;
        const w1 = ((cx - qx) * (ay - qy) - (ax - qx) * (cy - qy)) / det;
        if (w0 >= -1e-6 && w1 >= -1e-6 && 1 - w0 - w1 >= -1e-6) grid[r * n + c] = 1;
      }
    }
  }
  return { grid, n, cell: (x1 - x0) / n, yOf: (row) => y0 + ((row + 0.5) / n) * (y1 - y0) };
}

/** Widest run of empty cells lying BETWEEN filled cells, over a band of rows. */
function widestHole(geo: THREE.BufferGeometry, yLo: number, yHi: number): number {
  const s = silhouette(geo);
  let worst = 0;
  for (let r = 0; r < s.n; r++) {
    const y = s.yOf(r);
    if (y < yLo || y > yHi) continue;
    let first = -1, last = -1;
    for (let c = 0; c < s.n; c++) if (s.grid[r * s.n + c]) { if (first < 0) first = c; last = c; }
    if (first < 0) continue;
    let run = 0;
    for (let c = first; c <= last; c++) {
      if (s.grid[r * s.n + c]) run = 0;
      else { run++; if (run * s.cell > worst) worst = run * s.cell; }
    }
  }
  return worst;
}

/**
 * DAYLIGHT THROUGH THE SHOULDER.
 *
 * The arm's first ring is buried inside the torso on purpose so the shoulder
 * reads as a joint rather than a pauldron — but "inside" was only ever asserted
 * on paper. In the shipped build the torso interpolated straight from the
 * armpit to the neck root across 176 mm with no ring in between, so at the
 * height where the deltoid actually starts the torso had already collapsed
 * narrower than the arm and the two silhouettes came apart. This measures
 * 137 mm of open sky on the hero at HEAD~1 and 0 mm now.
 *
 * The band is deliberately tight: below the armpit an A-pose has a legitimate
 * gap between the arm and the ribs, and asserting no hole there would be
 * asserting that the character has his elbows glued to his sides.
 */
test.each(BODY_TYPES)('%s: no daylight between the arm and the torso', (body: BodyType) => {
  for (const female of [false, true]) {
    const rig = rigFor(body, female);
    const m = rig.metrics;
    for (const outer of ['none', 'jacket', 'puffer', 'coat'] as const) {
      const a = { ...rollAppearance(new Rng(`sh-${body}`), 'civilian'), outer, female, body };
      const geo = buildHumanoidGeometry(a, rig);
      const hole = widestHole(geo, m.shoulderY - 0.05, m.shoulderY + 0.06);
      // One raster cell is 2.5 mm; anything under a cell is quantisation.
      expect(hole).toBeLessThan(0.004);
    }
  }
});

test('the hero specifically has no daylight through either shoulder', () => {
  const rig = rigFor(HERO_APPEARANCE.body, HERO_APPEARANCE.female);
  const geo = buildHumanoidGeometry(HERO_APPEARANCE, rig);
  expect(widestHole(geo, rig.metrics.shoulderY - 0.05, rig.metrics.shoulderY + 0.06)).toBeLessThan(0.004);
});

/** Union-find over the index buffer: which surface component is each vertex in? */
function components(geo: THREE.BufferGeometry): Int32Array {
  const count = (geo.getAttribute('position') as THREE.BufferAttribute).count;
  const idx = geo.getIndex()!;
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  for (let t = 0; t < idx.count; t += 3) {
    const a = find(idx.getX(t)), b = find(idx.getX(t + 1)), c = find(idx.getX(t + 2));
    if (a !== b) parent[b] = a;
    if (find(a) !== c) parent[c] = find(a);
  }
  for (let i = 0; i < count; i++) parent[i] = find(i);
  return parent;
}

/**
 * ONE ARM, NOT TWO CAPSULES.
 *
 * The upper arm and the forearm used to be two independent tubes meeting at the
 * elbow. Independent tubes share no vertices, so they are two surfaces: the
 * normals crease against each other, the radii either side disagree, and the
 * sweep direction steps. The eye reads that as two objects long before it can
 * resolve an elbow, which is exactly what the playtest said.
 *
 * "Two surfaces" is not an aesthetic judgement, it is a graph property, so it
 * gets asserted as one: the shoulder, the elbow and the wrist must all be
 * reachable from each other through the triangle graph. This fails on HEAD~1
 * for every body type and every garment.
 */
test.each(BODY_TYPES)('%s: shoulder, elbow and wrist are one continuous surface', (body: BodyType) => {
  for (const shortSleeve of [false, true]) {
    const rig = rigFor(body, false);
    const a = { ...rollAppearance(new Rng(`el-${body}`), 'civilian'), outer: 'jacket' as const, shortSleeve, body };
    const geo = buildHumanoidGeometry(a, rig);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const comp = components(geo);

    const at = (p: THREE.Vector3, radius: number): Set<number> => {
      const out = new Set<number>();
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - p.x, dy = pos.getY(i) - p.y, dz = pos.getZ(i) - p.z;
        if (dx * dx + dy * dy + dz * dz < radius * radius) out.add(comp[i]);
      }
      return out;
    };

    for (const side of ['L', 'R'] as const) {
      const P = rig.points.joint;
      const shoulder = at(P[`upperArm${side}`], 0.09);
      const elbow = at(P[`forearm${side}`], 0.09);
      const wrist = at(P[`hand${side}`], 0.07);
      expect(elbow.size).toBeGreaterThan(0);
      // A short sleeve is a real edge in the world, so the sleeve is allowed to
      // be its own surface — but the SKIN running shoulder-side to wrist must
      // still be unbroken through the elbow.
      const throughElbow = [...elbow].filter((c) => wrist.has(c));
      expect(throughElbow.length).toBeGreaterThan(0);
      if (!shortSleeve) {
        const whole = [...shoulder].filter((c) => elbow.has(c) && wrist.has(c));
        expect(whole.length).toBeGreaterThan(0);
      }
    }
  }
});

/**
 * A NECK.
 *
 * The hero's popped collar used to top out 12 mm under his chin — 60 of the
 * 70 mm between the neck root and the jaw — so the head sat straight on the
 * jacket and the playtest reported that he had no neck. A turned-up collar
 * stops at the base of the ear. Measured on the SKIN texture column, because
 * what matters is how much bare neck is actually visible, not how many rings
 * the neck tube has.
 */
test('the hero has a visible neck between the collar and the jaw', () => {
  const rig = rigFor(HERO_APPEARANCE.body, HERO_APPEARANCE.female);
  const m = rig.metrics;
  const geo = buildHumanoidGeometry(HERO_APPEARANCE, rig);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;

  const chinY = m.headY - 0.010;
  let collarTop = -Infinity;
  let skinTop = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) < m.neckY - 0.02) continue;
    if (Math.abs(pos.getX(i)) > m.neckR * 2.2) continue;
    const u = uv.getX(i) * ATLAS_SIZE;
    if (u < 16) skinTop = Math.max(skinTop, pos.getY(i));          // SKIN column
    else if (u > 48 && u < 64) collarTop = Math.max(collarTop, pos.getY(i)); // OUTER
  }
  // The neck geometry has to reach the jaw...
  expect(skinTop).toBeGreaterThan(chinY);
  // ...and the collar has to leave a readable column of it uncovered. Twelve
  // millimetres is what "no neck" measured; a real turned-up collar leaves 30+.
  expect(chinY - collarTop).toBeGreaterThan(0.025);
  // And it must still be a popped collar, not a flat neckline.
  expect(collarTop).toBeGreaterThan(m.neckY + 0.020);
});

/* ------------------------------------------------------------------ */
/* 2c. EVERYONE IS DRESSED                                             */
/* ------------------------------------------------------------------ */

/**
 * Front view with a DEPTH BUFFER, recording which wardrobe slot wins each
 * pixel.
 *
 * `silhouette` above answers "is anything there". This answers "what does the
 * eye actually see there", and only the second question can decide whether a
 * garment covers a body part. A skirt is one wide tube hanging OUTSIDE two
 * bare legs: every area-, vertex- or coverage-based measure counts those legs
 * and concludes the thigh is bare, when in fact the skirt occludes them
 * completely. Z-buffer the thing and read off the nearest surface, exactly the
 * way the camera does.
 *
 * Returns -1 where nothing was drawn.
 */
function visibleSlots(geo: THREE.BufferGeometry, n = 300): {
  slot: Int8Array; n: number; xOf(c: number): number; yOf(r: number): number;
} {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const idx = geo.getIndex()!;
  const x0 = -0.6, x1 = 0.6, y0 = 0, y1 = 2;
  const slot = new Int8Array(n * n).fill(-1);
  const depth = new Float32Array(n * n).fill(-Infinity);
  const px = (x: number) => ((x - x0) / (x1 - x0)) * n;
  const py = (y: number) => ((y - y0) / (y1 - y0)) * n;

  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    const ax = px(pos.getX(i0)), ay = py(pos.getY(i0)), az = pos.getZ(i0);
    const bx = px(pos.getX(i1)), by = py(pos.getY(i1)), bz = pos.getZ(i1);
    const cx = px(pos.getX(i2)), cy = py(pos.getY(i2)), cz = pos.getZ(i2);
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;
    // The slot is constant per triangle; u is the column centre it was cut from.
    const s = Math.round((uv.getX(i0) * ATLAS_SIZE - 8) / 16);
    const r0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const r1 = Math.min(n - 1, Math.ceil(Math.max(ay, by, cy)));
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const c1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx, cx)));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const qx = c + 0.5, qy = r + 0.5;
        const w0 = ((bx - qx) * (cy - qy) - (cx - qx) * (by - qy)) / det;
        const w1 = ((cx - qx) * (ay - qy) - (ax - qx) * (cy - qy)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const k = r * n + c;
        if (z > depth[k]) { depth[k] = z; slot[k] = s; }
      }
    }
  }
  return { slot, n, xOf: (c) => x0 + ((c + 0.5) / n) * (x1 - x0), yOf: (r) => y0 + ((r + 0.5) / n) * (y1 - y0) };
}

/** Fraction of the visible pixels in a window that are bare SKIN. */
function bareFraction(
  v: ReturnType<typeof visibleSlots>, yLo: number, yHi: number, xMax: number,
): number {
  let skin = 0, seen = 0;
  for (let r = 0; r < v.n; r++) {
    const y = v.yOf(r);
    if (y < yLo || y > yHi) continue;
    for (let c = 0; c < v.n; c++) {
      if (Math.abs(v.xOf(c)) > xMax) continue;
      const s = v.slot[r * v.n + c];
      if (s < 0) continue;
      seen++;
      if (s === SLOT.SKIN) skin++;
    }
  }
  return seen === 0 ? 0 : skin / seen;
}

/**
 * NOBODY WALKS THE STREET UNDRESSED.
 *
 * A playtest screenshot caught a pedestrian in a routine street framing
 * rendering bare from the shoulders to the ankles. The cause was not a wardrobe
 * slot rolling "none" and not an atlas UV landing on skin: `legs: 'skirt'` and
 * `legs: 'longSkirt'` HAD NO GEOMETRY. They only deleted the trouser tube and
 * replaced the leg with a bare `SLOT.SKIN` column, and the sole thing that ever
 * covered the gap was `OUTER_HEM`, which is keyed on `a.outer` and knows nothing
 * about the legs. A skirt-wearer in a jacket, a denim jacket or no outer garment
 * was therefore nude from the hip down. Measured before the fix: 2.3% of every
 * appearance rolled across all eight archetypes, and 100% of those were skirts.
 *
 * This is the assertion that stops the whole bug CLASS coming back silently,
 * so it is deliberately not a regression test for skirts: it sweeps every
 * archetype, both sexes, all six body types and many seeds, and asks the only
 * question that matters — is the torso covered, and is the thigh covered.
 *
 * The windows are narrow on purpose. `xMax` keeps the arms out of the torso
 * reading (they are legitimately bare for a short sleeve and they overlap the
 * torso in a front view), and the thigh band sits well above the knee so that
 * shorts, which legitimately bare the shin, are not counted as a failure.
 */
test('no generated appearance leaves the torso or the thighs bare', () => {
  const worst = { torso: 0, thigh: 0, who: '', whoThigh: '' };
  const PED_ARCHETYPES: PedArchetype[] = [
    'civilian', 'builder', 'officeWorker', 'protester',
    'police', 'ministryAgent', 'streetVendor', 'tourist',
  ];

  for (const archetype of PED_ARCHETYPES) {
    for (let seed = 0; seed < 24; seed++) {
      const rng = new Rng(`decency-${archetype}-${seed}`);
      for (let k = 0; k < 4; k++) {
        const a = rollAppearance(rng, archetype);
        const rig = rigFor(a.body, a.female);
        const m = rig.metrics;
        const geo = buildHumanoidGeometry(a, rig);
        const v = visibleSlots(geo);

        // Torso: hip to armpit, central column only.
        const torso = bareFraction(v, m.hipY + 0.03, m.yokeY - 0.02, 0.10);
        // Thigh: 30%-55% of the way from the hip to the knee. Above any hem a
        // skirt or a pair of shorts is entitled to have.
        const hipToKnee = m.hipY - m.kneeY;
        const thigh = bareFraction(v, m.hipY - hipToKnee * 0.55, m.hipY - hipToKnee * 0.30, 0.22);

        const who = `${archetype} ${a.body}/${a.female ? 'f' : 'm'} top=${a.top} outer=${a.outer} legs=${a.legs}`;
        if (torso > worst.torso) { worst.torso = torso; worst.who = who; }
        if (thigh > worst.thigh) { worst.thigh = thigh; worst.whoThigh = who; }
        geo.dispose();
      }
    }
  }

  // A torso is a garment end to end; nothing bare should reach the front of it.
  expect(`${(worst.torso * 100).toFixed(0)}% ${worst.who}`).toBe(`0% ${worst.who}`);
  // A thigh may show a sliver at the very edge of a flared skirt against the
  // silhouette, but it must never be the surface the eye lands on.
  expect(worst.thigh).toBeLessThan(0.10);
}, 60_000);

/**
 * HE MUST NOT BE A CUT-OUT.
 *
 * The other half of the mannequin report was that the player renders as a
 * near-black silhouette in open sunset light. Measured in-engine: his torso
 * came back at luma 15/255 backlit on the plaza while a pedestrian in a nearly
 * identical navy suit read at 22 and the pavement at 113. Swapping his material
 * for plain grey lit him perfectly, so the fault was never the lighting rig —
 * it was that his garment colours sat at 1-3% linear reflectance, below coal.
 *
 * This pins the floor. It is a colour-space assertion, so it is exact and it
 * does not need a GPU: sRGB decoded to linear, no light involved.
 */
test('no garment is darker than real dyed cloth', () => {
  const linear = (srgb8: number): number => {
    const c = srgb8 / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const brightestLinear = (hex: number): number =>
    Math.max(linear((hex >> 16) & 0xff), linear((hex >> 8) & 0xff), linear(hex & 0xff));

  // The hero is the one the camera is always pointed at, so he is checked by
  // name and not merely through a roll.
  for (const slot of ['top', 'outer', 'legs', 'shoes', 'detail'] as const) {
    expect(brightestLinear(HERO_APPEARANCE.colors[slot])).toBeGreaterThan(0.020);
  }
  // And nobody in the crowd is allowed to be a hole in the frame either.
  const rng = new Rng('albedo');
  for (let i = 0; i < 200; i++) {
    const a = rollAppearance(rng, i % 2 ? 'civilian' : 'officeWorker');
    for (const slot of ['top', 'outer', 'legs', 'shoes'] as const) {
      expect(brightestLinear(a.colors[slot])).toBeGreaterThan(0.020);
    }
  }
});

/**
 * ...AND CLOTH HAS TO HAVE A SPECULAR LOBE.
 *
 * The albedo floor above is the smaller half of why the player rendered as a
 * cut-out. The pedestrian he was losing to wears almost exactly his colour; the
 * difference was that a `suit` sets roughness 0.66 while his `jacket` sat on
 * the 0.86 default, and at 0.86 there is no grazing sheen. Diffuse off 1-3%
 * albedo is nothing, so with the sun behind him nothing at all came back.
 *
 * Every garment column therefore has to stay inside the range real cloth
 * occupies. The lower bound matters too: a jacket at 0.3 is a bin liner.
 */
test('every garment keeps a specular response', () => {
  const rng = new Rng('sheen');
  const looks = [HERO_APPEARANCE, ...Array.from({ length: 60 }, (_, i) =>
    rollAppearance(rng, (['civilian', 'builder', 'officeWorker'] as const)[i % 3]))];
  for (const a of looks) {
    const surface = slotSurface(a);
    for (const [, s] of surface) {
      expect(s.roughness).toBeGreaterThan(0.30);
      expect(s.roughness).toBeLessThan(0.96);
      // Cloth is a dielectric. Metalness above a trace turns diffuse OFF, which
      // is the other way to make a character go black.
      expect(s.metalness).toBeLessThan(0.30);
    }
    // Specifically the outer garment, which is most of the silhouette.
    if (a.outer !== 'none') expect(surface.get(SLOT.OUTER)!.roughness).toBeLessThan(0.86);
  }
  // And the hero's own jacket, by name.
  expect(slotSurface(HERO_APPEARANCE).get(SLOT.OUTER)!.roughness).toBeLessThan(0.76);
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
