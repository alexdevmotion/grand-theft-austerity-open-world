/**
 * ORIENTATION ASSERTIONS FOR EVERY GEOMETRY EMITTER IN THE CITY.
 *
 * `src/characters/face/checks.ts` guards heads, because a head once rendered
 * inside out and survived several reviews: a silhouette is winding-agnostic,
 * and so is a lit render whenever the shading normal is authored separately
 * from the index order. Nothing guarded the other 1.6 million triangles.
 *
 * TWO INDEPENDENT CHECKS, because neither alone is sufficient:
 *
 *   1. WINDING vs SHADING NORMAL. For every triangle, the geometric normal
 *      (cross(b-a, c-a)) must point the same way as the normal attribute the
 *      emitter authored. Where they disagree the triangle is back-facing to
 *      anyone looking at its lit side, and every city material is FrontSide,
 *      so it is culled and you see straight through it.
 *      BLIND SPOT: `quad()` derives its normal FROM the winding, so a wall
 *      built from a reversed footprint self-agrees while facing inward.
 *
 *   2. ENCLOSED VOLUME. For a closed (or planar-capped) shape, the divergence
 *      integral sum(a . (b x c)) / 6 is positive when the surface is wound
 *      outward and negative when it is inside out. This is what catches the
 *      case check 1 is blind to, and it is the exact shape of the head bug.
 *
 * OWNER: truth-assertion agent. Pure geometry, no world, no browser.
 */

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import {
  DetailBuilder, FacadeBuilder, Surf, SurfaceBuilder,
  type DetailOpts, type FacadeParams, type SurfParams, type Vec2,
  signedArea,
} from './builders';

/* ------------------------------------------------------------------ */
/* Measures                                                            */
/* ------------------------------------------------------------------ */

export interface Census {
  tris: number;
  /** Winding agrees with the authored shading normal. */
  agree: number;
  /** Winding opposes it — the triangle is drawn inside out. */
  disagree: number;
  degenerate: number;
}

/** Winding vs authored shading normal, per triangle. */
export function census(g: THREE.BufferGeometry): Census {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const idx = g.getIndex();
  const out: Census = { tris: 0, agree: 0, disagree: 0, degenerate: 0 };
  if (!pos || !nrm || !idx) return out;
  const P = pos.array as ArrayLike<number>;
  const N = nrm.array as ArrayLike<number>;
  const I = idx.array as ArrayLike<number>;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    out.tris++;
    if (Math.hypot(nx, ny, nz) < 1e-9) { out.degenerate++; continue; }
    const sx = N[a] + N[b] + N[c];
    const sy = N[a + 1] + N[b + 1] + N[c + 1];
    const sz = N[a + 2] + N[b + 2] + N[c + 2];
    const d = nx * sx + ny * sy + nz * sz;
    if (d > 0) out.agree++;
    else if (d < 0) out.disagree++;
    else out.degenerate++;
  }
  return out;
}

/**
 * Enclosed volume by the divergence theorem, about the origin.
 *
 * Positive for an outward-wound closed surface. An open surface whose boundary
 * lies in a plane THROUGH THE ORIGIN also integrates exactly, because the cone
 * from the origin over the missing cap has zero volume — which is why the
 * shapes below are all built with their open face on y = 0.
 */
export function signedVolume(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  if (!pos || !idx) return 0;
  const P = pos.array as ArrayLike<number>;
  const I = idx.array as ArrayLike<number>;
  let v = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const cx = P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1];
    const cy = P[b + 2] * P[c] - P[b] * P[c + 2];
    const cz = P[b] * P[c + 1] - P[b + 1] * P[c];
    v += P[a] * cx + P[a + 1] * cy + P[a + 2] * cz;
  }
  return v / 6;
}

/** Fraction of triangles whose geometric normal points away from `centre`. */
export function outwardFraction(g: THREE.BufferGeometry, centre: THREE.Vector3): number {
  const pos = g.getAttribute('position');
  const idx = g.getIndex();
  if (!pos || !idx) return 1;
  const P = pos.array as ArrayLike<number>;
  const I = idx.array as ArrayLike<number>;
  let outward = 0;
  let n = 0;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    const gx = (P[a] + P[b] + P[c]) / 3 - centre.x;
    const gy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3 - centre.y;
    const gz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - centre.z;
    n++;
    if (nx * gx + ny * gy + nz * gz > 0) outward++;
  }
  return n ? outward / n : 1;
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const SP: SurfParams = { kind: Surf.asphalt, a: 8, b: 2, seed: 1 };
const FP: FacadeParams = {
  style: 0, floorH: 3, bayW: 3, seed: 1, buildingH: 20, groundH: 4, lit: 0.5, tint: 0.3,
};
const DO: DetailOpts = { color: [1, 1, 1] };

/**
 * The house convention, stated at the top of builders.ts: footprints are given
 * CLOCKWISE viewed from above (+Y looking down), which is a NEGATIVE shoelace
 * area with this file's sign convention.
 */
const CW: Vec2[] = [{ x: -5, z: -5 }, { x: -5, z: 5 }, { x: 5, z: 5 }, { x: 5, z: -5 }];
const CW_NGON: Vec2[] = [
  { x: -5, z: -5 }, { x: -5, z: 5 }, { x: -1, z: 7 }, { x: 5, z: 5 }, { x: 7, z: -1 }, { x: 5, z: -5 },
];
const CCW: Vec2[] = CW.slice().reverse();

const surf = (f: (b: SurfaceBuilder) => void): THREE.BufferGeometry => {
  const b = new SurfaceBuilder(); f(b); return b.build();
};
const fac = (f: (b: FacadeBuilder) => void): THREE.BufferGeometry => {
  const b = new FacadeBuilder(); f(b); return b.build();
};
const det = (f: (b: DetailBuilder) => void): THREE.BufferGeometry => {
  const b = new DetailBuilder(); f(b); return b.build();
};

/* ================================================================== */
/* 0. The convention itself                                            */
/* ================================================================== */

test('the stated winding convention is what the code means by clockwise', () => {
  expect(signedArea(CW)).toBeLessThan(0);
  expect(signedArea(CCW)).toBeGreaterThan(0);
  expect(signedArea(CW_NGON)).toBeLessThan(0);
});

/* ================================================================== */
/* 1. Emitters that are correct — and must stay correct                */
/* ================================================================== */

describe('emitters whose winding matches their normals', () => {
  const cases: Array<[string, () => THREE.BufferGeometry]> = [
    ['SurfaceBuilder.rect', () => surf((b) => b.rect(-5, -5, 5, 5, 0, SP))],
    ['SurfaceBuilder.quad', () => surf((b) => b.quad(
      [-5, 0, -5], [-5, 0, 5], [5, 0, 5], [5, 0, -5], [0, 0, 0, 10, 10, 10, 10, 0], SP,
    ))],
    ['FacadeBuilder.extrude (CW footprint)', () => fac((b) => b.extrude(CW, 0, 12, 0, FP))],
    ['FacadeBuilder.cap (CW quad)', () => fac((b) => b.cap(CW, 12, FP))],
    ['DetailBuilder.box', () => det((b) => b.box(0, 1, 0, 2, 2, 2, 0, DO))],
    ['DetailBuilder.box (rotated)', () => det((b) => b.box(0, 1, 0, 3, 2, 1, 0.7, DO))],
    ['DetailBuilder.cyl', () => det((b) => b.cyl(0, 0, 0, 1, 1, 4, 10, DO))],
    ['DetailBuilder.cyl (tapered, uncapped)', () => det((b) => b.cyl(0, 0, 0, 1, 0.4, 4, 10, DO, false))],
    // FIXED (foliage pass): `tube` walked its ring pair the opposite way round
    // to `cyl`, so every branch, twig, catenary wire, handrail and bracket in
    // the city drew its inner wall — which shaded white against the low sun and
    // was most of why street trees read as sticks with white hairs on them.
    ['DetailBuilder.tube (vertical)', () => det((b) => b.tube(0, 0, 0, 0, 4, 0, 0.3, 8, DO))],
    ['DetailBuilder.tube (skew)', () => det((b) => b.tube(0, 0, 0, 2, 4, 1, 0.3, 8, DO))],
    ['DetailBuilder.blob', () => det((b) => b.blob(0, 0, 0, 2, 2, 2, DO, 0.2, 7, 2, 0.2, 8))],
    ['DetailBuilder.ring', () => det((b) => b.ring(-5, -5, 5, 5, 0, 0.5, 1, DO))],
    ['DetailBuilder.ringPoly (CW)', () => det((b) => b.ringPoly(CW, 0, 0.5, 1, DO))],
    ['DetailBuilder.ringPoly (CCW)', () => det((b) => b.ringPoly(CCW, 0, 0.5, 1, DO))],
    ['DetailBuilder.plate', () => det((b) => b.plate([-1, 0, 0], [-1, 2, 0], [1, 2, 0], [1, 0, 0], DO))],
    // Correct when fed the house convention. It has no call sites today; the
    // case is here so that whoever adds one gets the ordering from a test
    // rather than from a coin flip.
    ['SurfaceBuilder.tri (CW)', () => surf((b) => b.tri(CW[0], CW[1], CW[2], 0, SP))],
  ];

  for (const [name, build] of cases) {
    test(name, () => {
      const c = census(build());
      expect(c.tris).toBeGreaterThan(0);
      expect(c.degenerate).toBe(0);
      expect(`${name}: ${c.disagree}/${c.tris} inside out`).toBe(`${name}: 0/${c.tris} inside out`);
    });
  }
});

/* ================================================================== */
/* 2. Closed shapes enclose a POSITIVE volume                          */
/* ================================================================== */

describe('closed generated meshes are wound outward', () => {
  test('DetailBuilder.box encloses exactly its own volume', () => {
    // Sitting on y = 0 so the divergence integral is exact about the origin.
    const g = det((b) => b.box(0, 1, 0, 3, 2, 4, 0, DO));
    expect(signedVolume(g)).toBeCloseTo(3 * 2 * 4, 4);
    expect(outwardFraction(g, new THREE.Vector3(0, 1, 0))).toBe(1);
  });

  test('DetailBuilder.blob encloses a positive volume with every face outward', () => {
    const g = det((b) => b.blob(0, 0, 0, 2, 3, 2, DO, 0, 7, 2, 0, 8));
    expect(signedVolume(g)).toBeGreaterThan(0);
    expect(outwardFraction(g, new THREE.Vector3(0, 0, 0))).toBe(1);
  });

  test('DetailBuilder.cyl encloses a positive volume', () => {
    const g = det((b) => b.cyl(0, 0, 0, 1.5, 1.5, 5, 16, DO));
    // Open at y = 0, which is the origin plane, so the integral is exact —
    // against the INSCRIBED 16-gon prism, not the ideal cylinder.
    const seg = 16;
    const prism = (seg * 1.5 * 1.5 * Math.sin((2 * Math.PI) / seg)) / 2 * 5;
    expect(signedVolume(g)).toBeGreaterThan(0);
    expect(signedVolume(g)).toBeCloseTo(prism, 4);
  });

  test('DetailBuilder.ring is four outward boxes, not four inward ones', () => {
    const g = det((b) => b.ring(-6, -6, 6, 6, 0, 0.5, 2, DO));
    expect(signedVolume(g)).toBeGreaterThan(0);
  });

  /**
   * THE CHECK THAT CATCHES WHAT THE WINDING CENSUS CANNOT.
   *
   * `FacadeBuilder.quad` computes the shading normal from its own winding, so
   * a building extruded from a REVERSED footprint has walls whose normals
   * agree with their triangles perfectly — and point into the room. The census
   * gives it a clean bill of health; the volume integral does not. This is
   * precisely how a head shipped inside out.
   */
  test('a reversed footprint passes the winding census and fails the volume test', () => {
    const good = fac((b) => b.extrude(CW, 0, 12, 0, FP));
    const bad = fac((b) => b.extrude(CCW, 0, 12, 0, FP));

    // Both are almost clean by the winding census...
    expect(census(good).disagree).toBe(0);
    expect(census(bad).disagree).toBeLessThanOrEqual(2); // only the roof cap shows

    // ...but only one of them is a building rather than a hole in the world.
    const volGood = signedVolume(good);
    const volBad = signedVolume(bad);
    expect(volGood).toBeGreaterThan(0);
    expect(volGood).toBeCloseTo(10 * 10 * 12, 3);
    expect(volBad).toBeLessThan(0);

    expect(outwardFraction(good, new THREE.Vector3(0, 6, 0))).toBe(1);
    expect(outwardFraction(bad, new THREE.Vector3(0, 6, 0))).toBe(0);
  });

  test('every extruded footprint the city can produce comes out solid', () => {
    // Rectangles, the L-plan and ragged imported n-gons, all given clockwise.
    const plans: Vec2[][] = [
      CW,
      CW_NGON,
      [{ x: -6, z: -4 }, { x: -6, z: 4 }, { x: 0, z: 4 }, { x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: -4 }],
      [{ x: -9, z: -2 }, { x: -7, z: 5 }, { x: 1, z: 6 }, { x: 8, z: 2 }, { x: 6, z: -5 }, { x: -2, z: -7 }],
    ];
    for (const plan of plans) {
      const g = fac((b) => b.extrude(plan, 0, 9, 0, FP));
      const v = signedVolume(g);
      expect(`${plan.length}-gon volume ${v > 0 ? 'positive' : 'NEGATIVE'}`)
        .toBe(`${plan.length}-gon volume positive`);
      // Walls only: exact, and independent of the roof cap, which past four
      // corners is ear-clipped and comes back inside out (see the quarantine).
      const walls = fac((b) => b.extrude(plan, 0, 9, 0, FP, { roof: false }));
      expect(signedVolume(walls)).toBeCloseTo((Math.abs(signedArea(plan)) * 9 * 2) / 3, 2);
    }
  });
});

/* ================================================================== */
/* 3. QUARANTINE — emitters that are inside out TODAY                  */
/* ================================================================== */

/**
 * THE CITY'S GROUND, ITS PARKS, ITS IMPORTED ROOFS AND EVERY TUBE ARE DRAWN
 * INSIDE OUT, AND HAVE BEEN SINCE THEY WERE WRITTEN.
 *
 * Measured on the baked city and confirmed in the running game by reading
 * `__GTA_CITY__.root` directly: SURFACE 57 494 / 82 426 triangles wound
 * against their own shading normal, FACADE 9 617 / 53 972, DETAIL
 * 123 049 / 1 489 224. All three city materials are `THREE.FrontSide`
 * (`createCityMaterials` sets no `side`), so every one of those triangles is
 * back-face culled from the side it is lit for. The carriageways, zebra
 * crossings, stop bars, tram beds, park and square polygons, junction patches
 * emitted as triangles, the roof cap of every imported footprint with more
 * than four corners, and every branch, bracket and handrail are NOT DRAWN AT
 * ALL. What shows through is the bedrock underlay — near-black, and under a
 * three-degree sun indistinguishable from wet asphalt, which is why no
 * screenshot review ever caught it.
 *
 * WHY: all five emit their index triples in the opposite order to the
 * convention stated at the top of builders.ts.
 *
 *   ribbon  `idx.push(i0, i3, i2, i0, i2, i1)` where i1 is +1 across the width
 *           and i3 is +1 along the run. cross(run, leftPerp) is (0, -1, 0), so
 *           the quad faces DOWN while every vertex normal is pushed as
 *           (0, 1, 0).  FIX: `idx.push(i0, i1, i2, i0, i2, i3)`.
 *   poly    and
 *   cap     both go through `triangulate()`, whose docstring promises "winding
 *           is preserved, so callers keep control of which way the face
 *           points". IT IS NOT. `THREE.ShapeUtils.triangulateShape` returns
 *           positively-handed triples for BOTH input windings — measured — and
 *           a positively-handed triple in (x, z) faces DOWN. `cap`'s <= 4
 *           vertex fan path preserves the input winding and is correct; only
 *           the ear-clipped path past four corners is wrong, which is exactly
 *           the imported footprints.  FIX: emit `t[0], t[2], t[1]` from
 *           `triangulate()`, in `triangulate()` itself so both callers get it.
 *   tube    FIXED in the foliage pass — see the winding note in builders.ts.
 *           It now emits `i0, i3, i1, i0, i2, i3` and has moved into section 1.
 *
 * These assertions FAIL THE MOMENT THE DEFECT IS FIXED. That is deliberate:
 * when you fix an emitter, delete its entry here and move the case up into
 * section 1, and lower the matching budget in `world/worldTruth.test.ts`.
 *
 * builders.ts belongs to the city agent, so this agent measured it rather than
 * changing it.
 */
describe('KNOWN INSIDE OUT (quarantine — shrink this list, never grow it)', () => {
  const broken: Array<[string, () => THREE.BufferGeometry]> = [
    ['SurfaceBuilder.ribbon (every carriageway and marking)',
      () => surf((b) => b.ribbon(0, 0, 0, 60, 16, 0, 0.09, SP, 4))],
    ['SurfaceBuilder.ribbon (run-cambered crossings)',
      () => surf((b) => b.ribbon(0, 0, 60, 0, 8, 0, 0.02, SP, 4, 0.09, -1, 1))],
    ['SurfaceBuilder.poly (parks, squares, real outlines)',
      () => surf((b) => b.poly(CW, 0, SP))],
    ['SurfaceBuilder.poly (CCW input — normalised to the same wrong handedness)',
      () => surf((b) => b.poly(CCW, 0, SP))],
    ['FacadeBuilder.cap (imported footprints with > 4 corners)',
      () => fac((b) => b.cap(CW_NGON, 12, FP))],
  ];

  for (const [name, build] of broken) {
    test(`STILL BROKEN: ${name}`, () => {
      const c = census(build());
      expect(c.tris).toBeGreaterThan(0);
      // If this now reads 0, the emitter has been FIXED. Move it to section 1.
      expect(`${name} inside out: ${c.disagree}/${c.tris}`)
        .toBe(`${name} inside out: ${c.tris}/${c.tris}`);
    });
  }

  test('the whole quarantine list, as one number', () => {
    let tris = 0;
    let bad = 0;
    for (const [, build] of broken) {
      const c = census(build());
      tris += c.tris;
      bad += c.disagree;
    }
    console.log(`[builders] quarantined emitters: ${bad}/${tris} triangles inside out`);
    expect(bad).toBe(tris);
  });
});
