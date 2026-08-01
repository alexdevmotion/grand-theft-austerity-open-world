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
import {
  CROWD_FACE_VARIANTS,
  buildImposterHeadGeometry,
  crowdFaceVariant,
  CrowdRenderer,
  type PedAppearance,
  type RigSubject,
} from './rig';
import { buildHumanoidGeometry } from '../../characters/humanoid';
import { bodyMetrics, buildRig } from '../../characters/rig';
import { rollAppearance } from '../../characters/wardrobe';
import { FACE_LANDMARKS, faceLandmarks } from '../../characters/faces';
import { Rng } from '../../core/rng';
import { makeAppearance } from './spawn';

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

/** Minimal canvas seam for exercising the renderer in Bun (which has no DOM). */
function fakeCanvasDocument(): Document {
  const gradient = { addColorStop: () => {} } as unknown as CanvasGradient;
  const context = new Proxy({
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    getImageData: (_x: number, _y: number, width: number, height: number) => {
      const w = Math.max(1, Math.ceil(width));
      const h = Math.max(1, Math.ceil(height));
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 200;
        data[i + 1] = 200;
        data[i + 2] = 200;
        data[i + 3] = 255;
      }
      return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
    },
    putImageData: () => {},
  } as Partial<CanvasRenderingContext2D>, {
    get(target, property) {
      const value = target[property as keyof typeof target];
      return value ?? (() => {});
    },
    set(target, property, value) {
      (target as Record<PropertyKey, unknown>)[property] = value;
      return true;
    },
  }) as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  return { createElement: () => canvas } as unknown as Document;
}

const testColour = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();
const TEST_IMPOSTER_APP: PedAppearance = {
  height: 1.76,
  build: 1,
  skin: testColour(0xb98a63),
  hair: testColour(0x2c1f18),
  top: testColour(0x2a3350),
  sleeve: testColour(0x2a3350),
  shortSleeve: false,
  legs: testColour(0x24283a),
  shoes: testColour(0x14121a),
  vest: null,
  headwear: 0,
  faceVariant: 0,
  hatColor: testColour(0xe8622a),
  bag: 0,
  bagColor: testColour(0x2a2230),
  phone: false,
  cigarette: false,
  placard: null,
};

function imposterSubject(headwear: number, x: number, seed = headwear): RigSubject {
  return {
    pos: new THREE.Vector3(x, 0, 0),
    yaw: 0,
    tiltPitch: 0,
    tiltRoll: 0,
    app: { ...TEST_IMPOSTER_APP, headwear, faceVariant: crowdFaceVariant(seed) },
    pose: 'idle',
    phase: 0,
    speed: 0,
    headYaw: 0,
    headPitch: 0,
    seed,
    gesture: 0.6,
  };
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

test('the live imposter tier preserves deterministic face identity in one draw call', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: fakeCanvasDocument(),
  });

  let renderer: CrowdRenderer | null = null;
  try {
    renderer = new CrowdRenderer(new THREE.Group(), CROWD_FACE_VARIANTS, false);
    renderer.begin();
    for (let seed = 0; seed < CROWD_FACE_VARIANTS; seed++) {
      renderer.draw(imposterSubject(0, seed * 2, seed), 0, 2);
    }
    renderer.end();

    const heads = renderer.root.getObjectByName('peds-head-near') as THREE.InstancedMesh;
    expect(heads.count).toBe(CROWD_FACE_VARIANTS);
    // Identity is a per-instance attribute on the single live head mesh: more
    // faces, no extra crowd draw calls.
    const variants = heads.geometry.getAttribute('crowdFaceVariant') as THREE.InstancedBufferAttribute;
    const actual = Array.from({ length: heads.count }, (_, i) => variants.getX(i));
    expect(actual).toEqual(
      Array.from({ length: heads.count }, (_, seed) => crowdFaceVariant(seed)),
    );
    expect(new Set(actual).size).toBe(CROWD_FACE_VARIANTS);

    // Exercise the exact material hook the renderer compiles. Without the UV
    // tile transform every instance samples tile zero despite carrying a
    // distinct attribute, recreating the same-face symptom.
    const material = heads.material as THREE.MeshStandardMaterial;
    const shader = {
      vertexShader: '#include <common>\n#include <uv_vertex>',
      fragmentShader: '',
      uniforms: {},
    };
    material.onBeforeCompile(shader as never, {} as never);
    expect(shader.vertexShader).toContain('attribute float crowdFaceVariant;');
    expect(shader.vertexShader).toContain('vMapUv = vec2(');
    expect(shader.vertexShader).toContain('clamp(vMapUv, 0.0, 1.0)');

    const atlas = material.map!.image as HTMLCanvasElement;
    expect(atlas.width / atlas.height).toBe(2);
  } finally {
    renderer?.dispose();
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete (globalThis as { document?: Document }).document;
  }
});

test('the actual spawn path deterministically exercises the whole face atlas', () => {
  const sequence = (seed: string) => {
    const rng = new Rng(seed);
    return Array.from({ length: 96 }, () => makeAppearance('civilian', rng).faceVariant);
  };
  const first = sequence('crowd-face-spawn-contract');
  expect(first).toEqual(sequence('crowd-face-spawn-contract'));
  expect(new Set(first)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
});

test('dog heads never enter the human face material in either distance tier', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: fakeCanvasDocument(),
  });

  let renderer: CrowdRenderer | null = null;
  try {
    renderer = new CrowdRenderer(new THREE.Group(), 2, false);
    renderer.begin();
    const fur = new THREE.Color(0x4a3a2e).convertSRGBToLinear();
    renderer.drawDog(0, 0, 0, 0, 0, 1, fur, 2);
    renderer.drawDog(2, 0, 0, 0, 0, 1, fur, 80);
    renderer.end();

    const count = (name: string) => (renderer!.root.getObjectByName(name) as THREE.InstancedMesh).count;
    expect(count('peds-head-near')).toBe(0);
    expect(count('peds-head-far')).toBe(0);
    expect(count('peds-blob-near')).toBe(1);
    expect(count('peds-blob-far')).toBe(1);
  } finally {
    renderer?.dispose();
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete (globalThis as { document?: Document }).document;
  }
});

test('the shared crown pool retains dog heads at maximum pedestrian occupancy', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: fakeCanvasDocument(),
  });

  let renderer: CrowdRenderer | null = null;
  try {
    renderer = new CrowdRenderer(new THREE.Group(), 2, false);
    renderer.begin();
    const fur = testColour(0x4a3a2e);
    for (let i = 0; i < 2; i++) {
      renderer.draw(imposterSubject(0, i * 2), 0, 2);
      renderer.drawDog(i * 2, 0, 0, 0, 0, 1, fur, 2);
    }
    renderer.end();

    const crowns = renderer.root.getObjectByName('peds-blob-near') as THREE.InstancedMesh;
    // One hair cap, two palms and one dog head for each live pedestrian. The
    // pool must retain all four even at maximum occupancy.
    expect(crowns.count).toBe(8);
  } finally {
    renderer?.dispose();
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete (globalThis as { document?: Document }).document;
  }
});

test('imposter hair and helmet shells stay above the face midline in both distance tiers', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: fakeCanvasDocument(),
  });

  let renderer: CrowdRenderer | null = null;
  try {
    const variants = [0, 2, 3, 4];
    renderer = new CrowdRenderer(new THREE.Group(), variants.length * 2, false);
    renderer.begin();
    for (let i = 0; i < variants.length; i++) {
      renderer.draw(imposterSubject(variants[i], i * 2), 0, 2);
      renderer.draw(imposterSubject(variants[i], i * 2), 0, 80);
    }
    renderer.end();

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (const tier of ['near', 'far'] as const) {
      const heads = renderer.root.getObjectByName(`peds-head-${tier}`) as THREE.InstancedMesh;
      const shells = renderer.root.getObjectByName(`peds-blob-${tier}`) as THREE.InstancedMesh;
      expect(heads.count).toBe(variants.length);
      const partsPerFigure = tier === 'near' ? 3 : 1;
      expect(shells.count).toBe(variants.length * partsPerFigure);
      for (let i = 0; i < variants.length; i++) {
        heads.getMatrixAt(i, matrix);
        const faceMidlineY = matrix.elements[13];
        // At conversation distance two palms are emitted before the crown;
        // the far LOD omits them.
        shells.getMatrixAt(tier === 'near' ? i * 3 + 2 : i, matrix);
        matrix.decompose(position, rotation, scale);
        // The shared blob geometry is centred at zero with y extent +-0.5.
        const shellBottomY = position.y - scale.y * 0.5;
        expect(shellBottomY - faceMidlineY).toBeGreaterThan(0.01);
      }
    }
  } finally {
    renderer?.dispose();
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete (globalThis as { document?: Document }).document;
  }
});

test('conversation-distance imposters retain two anatomically defined hands', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: fakeCanvasDocument(),
  });

  let renderer: CrowdRenderer | null = null;
  try {
    renderer = new CrowdRenderer(new THREE.Group(), 1, false);
    renderer.begin();
    renderer.draw(imposterSubject(0, 17), 0, 2);
    renderer.end();

    const roundedParts = renderer.root.getObjectByName('peds-blob-near') as THREE.InstancedMesh;
    // One crown plus one palm at the end of each articulated arm. The prior
    // imposter stopped both forearms at the wrist and therefore emitted only
    // the crown: a mannequin silhouette whenever the skinned budget filled.
    expect(roundedParts.count).toBe(3);

    const left = new THREE.Vector3();
    const right = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    roundedParts.getMatrixAt(0, matrix);
    matrix.decompose(left, rotation, scale);
    expect(scale.y).toBeGreaterThan(scale.x);
    expect(scale.x).toBeGreaterThan(scale.z);
    roundedParts.getMatrixAt(1, matrix);
    matrix.decompose(right, rotation, scale);
    expect(left.x).toBeLessThan(17);
    expect(right.x).toBeGreaterThan(17);

    const colour = new THREE.Color();
    roundedParts.getColorAt(0, colour);
    expect(colour.r).toBeCloseTo(TEST_IMPOSTER_APP.skin.r, 5);
    expect(colour.g).toBeCloseTo(TEST_IMPOSTER_APP.skin.g, 5);
    expect(colour.b).toBeCloseTo(TEST_IMPOSTER_APP.skin.b, 5);
    roundedParts.getColorAt(1, colour);
    expect(colour.r).toBeCloseTo(TEST_IMPOSTER_APP.skin.r, 5);
    expect(colour.g).toBeCloseTo(TEST_IMPOSTER_APP.skin.g, 5);
    expect(colour.b).toBeCloseTo(TEST_IMPOSTER_APP.skin.b, 5);
  } finally {
    renderer?.dispose();
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else delete (globalThis as { document?: Document }).document;
  }
});
