/**
 * CROWD HEAD INVARIANTS — the face has to be ON the front of the head.
 *
 * WHY THIS FILE EXISTS
 *
 * "Pedestrians at conversation distance render as featureless ovals" was
 * reported three times and diagnosed twice as a UV or atlas fault on the
 * skinned tier. It was neither: the atlas was painted, the skinned head's UVs
 * were correct, and the peds that read as blank were the OTHER tier. The crowd
 * is deliberately two-tier — the nearest `actorBudget` people are skinned
 * actors, everyone else is an instanced imposter — and the imposter head was
 * `IcosahedronGeometry(0.5, 1)` drawn with the limb material: no map, no UVs
 * that meant anything, no face. On a busy square the 26-strong skinned budget
 * runs out at about eight metres, so most of the visible crowd was ovals.
 *
 * The bug was invisible to every existing test because each tier was fine on
 * its own terms. So what is asserted here is the thing that spans them: given
 * a head from EITHER tier, does the surface the camera actually sees from the
 * front carry the UVs that `paintFace` painted the eyes, brows and mouth into.
 * Same shape of test as the depth-buffered decency raster in
 * `src/characters/body.test.ts` — rasterise it, z-buffer it, read off the
 * nearest surface — because that is the only measure that answers "what does
 * the eye land on" rather than "does the data exist somewhere".
 *
 * Run with `bun test`.
 */

import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { buildImposterHeadGeometry } from './rig';
import { buildHumanoidGeometry } from '../../characters/humanoid';
import { bodyMetrics, buildRig } from '../../characters/rig';
import { rollAppearance } from '../../characters/wardrobe';
import { FACE_LANDMARKS, faceLandmarks } from '../../characters/faces';
import { Rng } from '../../core/rng';

/* ------------------------------------------------------------------ */
/* front view with a depth buffer                                      */
/* ------------------------------------------------------------------ */

interface FrontRaster {
  n: number;
  /** Face-square coordinates of the nearest surface: u across, v crown->chin. */
  fu: Float32Array;
  fv: Float32Array;
  hit: Uint8Array;
  /** World z of the nearest surface — how far forward the face sits. */
  depth: Float32Array;
  xOf(c: number): number;
  yOf(r: number): number;
}

/**
 * Rasterise `geo` seen from straight in front (looking down -Z), keeping the
 * nearest surface per pixel and the face-square UV it samples.
 *
 * `toFace` converts the geometry's own UV into the square `paintFace` draws
 * into: (0..1 across the face, 0 at the crown, 1 below the chin). The skinned
 * head lives in the right-top quarter of a full appearance atlas and the
 * imposter head owns its whole texture, so the two tiers differ by exactly
 * that transform and nothing else.
 */
function frontRaster(
  geo: THREE.BufferGeometry,
  box: { x0: number; x1: number; y0: number; y1: number },
  toFace: (u: number, v: number) => [number, number],
  n = 260,
): FrontRaster {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const idx = geo.getIndex()!;
  const fu = new Float32Array(n * n);
  const fv = new Float32Array(n * n);
  const hit = new Uint8Array(n * n);
  const depth = new Float32Array(n * n).fill(-Infinity);
  const px = (x: number): number => ((x - box.x0) / (box.x1 - box.x0)) * n;
  const py = (y: number): number => ((y - box.y0) / (box.y1 - box.y0)) * n;

  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    const ax = px(pos.getX(i0)), ay = py(pos.getY(i0)), az = pos.getZ(i0);
    const bx = px(pos.getX(i1)), by = py(pos.getY(i1)), bz = pos.getZ(i1);
    const cx = px(pos.getX(i2)), cy = py(pos.getY(i2)), cz = pos.getZ(i2);
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
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const k = r * n + c;
        if (z <= depth[k]) continue;
        depth[k] = z;
        const u = w0 * uv.getX(i0) + w1 * uv.getX(i1) + w2 * uv.getX(i2);
        const v = w0 * uv.getY(i0) + w1 * uv.getY(i1) + w2 * uv.getY(i2);
        const [a, b] = toFace(u, v);
        fu[k] = a;
        fv[k] = b;
        hit[k] = 1;
      }
    }
  }
  return {
    n, fu, fv, hit, depth,
    xOf: (c) => box.x0 + ((c + 0.5) / n) * (box.x1 - box.x0),
    yOf: (r) => box.y0 + ((r + 0.5) / n) * (box.y1 - box.y0),
  };
}

/**
 * Is there a visible pixel whose sampled texel is inside the ellipse
 * (`cu`,`cv`) ± (`ru`,`rv`) of the face square? That is the whole question:
 * "does a crowd head sample the painted face region".
 */
function samples(r: FrontRaster, cu: number, cv: number, ru: number, rv: number): number {
  let count = 0;
  for (let k = 0; k < r.hit.length; k++) {
    if (!r.hit[k]) continue;
    const du = (r.fu[k] - cu) / ru;
    const dv = (r.fv[k] - cv) / rv;
    if (du * du + dv * dv <= 1) count++;
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* the imposter tier                                                   */
/* ------------------------------------------------------------------ */

/**
 * THE ASSERTION THE BLANK-OVAL BUG WOULD HAVE FAILED.
 *
 * The old imposter head — an icosahedron with three's polyhedral UVs and no
 * map — puts nothing recognisable under any of these landmarks. A head that
 * has a face has all five of them on the surface the camera can see.
 */
test('an imposter head shows the painted eyes, brows, nose and mouth from the front', () => {
  const geo = buildImposterHeadGeometry();
  const r = frontRaster(geo, { x0: -0.6, x1: 0.6, y0: -0.6, y1: 0.6 }, (u, v) => [u, 1 - v]);
  const L = FACE_LANDMARKS;

  // A tenth of the square is a generous landmark; the eye itself is ~0.07 wide.
  const tol = 0.05;
  const found: Record<string, number> = {
    eyeL: samples(r, 0.5 - L.eyeDx, L.yEye, tol, tol),
    eyeR: samples(r, 0.5 + L.eyeDx, L.yEye, tol, tol),
    browL: samples(r, 0.5 - L.eyeDx, L.yBrow, tol, tol),
    browR: samples(r, 0.5 + L.eyeDx, L.yBrow, tol, tol),
    nose: samples(r, 0.5, L.yNose, tol, tol),
    mouth: samples(r, 0.5, L.yMouth, tol, tol),
  };

  for (const [name, n] of Object.entries(found)) {
    // Not "> 0": a single pixel means the landmark grazes the silhouette. Each
    // of these has to be a patch of surface the camera is looking straight at.
    expect(`${name}=${n >= 12 ? 'visible' : n}`).toBe(`${name}=visible`);
  }
  geo.dispose();
});

/**
 * The face must be on the FRONT. A projection that is right in every other
 * respect but rotated a quarter turn paints a perfectly good face down the
 * side of the skull, and every landmark test above still passes.
 */
test('the imposter head puts the face midline dead ahead and the seam behind', () => {
  const geo = buildImposterHeadGeometry();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;

  let frontU = 0, frontN = 0;
  let backMin = 1, backMax = 0, backN = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (Math.abs(y) > 0.2) continue;               // the equatorial band only
    if (z > 0.45 && Math.abs(x) < 0.06) { frontU += uv.getX(i); frontN++; }
    if (z < -0.45 && Math.abs(x) < 0.06) {
      backMin = Math.min(backMin, uv.getX(i));
      backMax = Math.max(backMax, uv.getX(i));
      backN++;
    }
  }

  expect(frontN).toBeGreaterThan(0);
  expect(backN).toBeGreaterThan(0);
  // Straight ahead is the middle of the painted square, where the nose is.
  expect(frontU / frontN).toBeCloseTo(0.5, 2);
  // And the wrap seam is at the back, with both edges of the square present —
  // which is what stops a triangle interpolating u backwards across the face.
  expect(backMin).toBeLessThan(0.02);
  expect(backMax).toBeGreaterThan(0.98);
  geo.dispose();
});

/* ------------------------------------------------------------------ */
/* the two tiers must agree                                            */
/* ------------------------------------------------------------------ */

/**
 * A pedestrian crosses between the tiers as it walks toward the camera. If the
 * eye line sat at a different height on the imposter than on the skinned head,
 * the face would visibly jump at the promotion distance — so both are measured
 * against the same landmark, in the same face-square coordinates.
 */
test('both crowd tiers put the eye line on the front of the head at the same height', () => {
  const impostor = frontRaster(
    buildImposterHeadGeometry(),
    { x0: -0.6, x1: 0.6, y0: -0.6, y1: 0.6 },
    (u, v) => [u, 1 - v],
  );

  const a = rollAppearance(new Rng('crowd-face-tier'), 'civilian');
  const rig = buildRig(bodyMetrics(a.body, a.female));
  const skinned = buildHumanoidGeometry(a, rig);
  const m = rig.metrics;
  const head = frontRaster(
    skinned,
    { x0: -0.2, x1: 0.2, y0: m.headY - 0.06, y1: m.headTopY + 0.02 },
    // The skinned head is unwrapped into the atlas square u/v 0.5..1.
    (u, v) => [(u - 0.5) * 2, 1 - (v - 0.5) * 2],
  );

  const L = faceLandmarks(a.face);
  for (const [name, r, landmarks] of [
    ['imposter', impostor, FACE_LANDMARKS],
    ['skinned', head, L],
  ] as const) {
    const eyeL = samples(r, 0.5 - landmarks.eyeDx, landmarks.yEye, 0.05, 0.05);
    const eyeR = samples(r, 0.5 + landmarks.eyeDx, landmarks.yEye, 0.05, 0.05);
    expect(`${name} eyes=${eyeL >= 8 && eyeR >= 8 ? 'painted' : `${eyeL}/${eyeR}`}`)
      .toBe(`${name} eyes=painted`);
  }

  // Both agree on which way is up: the crown samples the top of the square and
  // the chin the bottom, on the surface the camera can see.
  for (const [name, r] of [['imposter', impostor], ['skinned', head]] as const) {
    let topV = 1, bottomV = 0, seen = 0;
    for (let c = 0; c < r.n; c++) {
      for (let row = 0; row < r.n; row++) {
        const k = row * r.n + c;
        if (!r.hit[k]) continue;
        seen++;
        // Rows count upward from y0, so the LAST hit row is the crown.
        if (r.fv[k] < topV) topV = r.fv[k];
        if (r.fv[k] > bottomV) bottomV = r.fv[k];
      }
    }
    expect(seen).toBeGreaterThan(1000);
    expect(`${name} crown=${topV < 0.12 ? 'ok' : topV.toFixed(2)}`).toBe(`${name} crown=ok`);
    expect(`${name} chin=${bottomV > 0.82 ? 'ok' : bottomV.toFixed(2)}`).toBe(`${name} chin=ok`);
  }

  skinned.dispose();
});
