/**
 * WORLD TRUTH — the cross-checks nothing else in this project can perform.
 *
 * Every assertion in this file compares TWO OR MORE INDEPENDENT ANSWERS to the
 * same question about the world. That is the entire point. Each of the
 * expensive bugs this codebase has shipped had the property that every
 * individual source of truth looked perfectly reasonable on its own, and only
 * the DISAGREEMENT between two of them was a defect:
 *
 *   ANALYTIC   `CityService.spatial` — closed-form ground height and blocking,
 *              from the occupancy mask, the kerb height and the slab table.
 *              Everything that places a character, a ped, a car or a spawn
 *              point reads it, and it never touches the world it describes.
 *   PHYSICS    the Rapier static colliders. What you actually stand on and
 *              bump into.
 *   VISUAL     the merged city geometry. What you actually see.
 *
 * A plaza was drawn and reported at deck height with NO COLLIDER, so physics
 * said "carriageway" and everyone stood inside the stone. The analytic height
 * ignored kerbs, so feet sank into the pavement. A lobby floor was built at one
 * Y and collided at another, so the player waded through it shin-deep. None of
 * those is visible in a screenshot — a character with his ankles in the
 * pavement reads as a character standing on the pavement — and none of them
 * fails any single-source check.
 *
 * The tests below are of two kinds:
 *
 *   INVARIANTS   assertions that hold today and must keep holding.
 *   RATCHETS     a measured budget for a defect that is REAL, LIVE AND
 *                UNFIXED, in a file this agent does not own. The budget stops
 *                it getting worse and makes it impossible to claim the world
 *                is consistent. Each one names the defect, the file and the
 *                fix. Drive the budget to 0 when you fix it.
 *
 * OWNER: truth-assertion agent. Uses only public seams.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { acceleratedRaycast, computeBoundsTree } from 'three-mesh-bvh';
import { Rng } from '../core/rng';
import { CG, PhysicsWorld, initRapier, probeGroups } from '../physics/physics';
import type { CitySystem } from './city';
import { INTERIORS } from './interiors/defs';
import { innerHalf } from './interiors/shell';

/* ------------------------------------------------------------------ */
/* Boot a real world, headless                                         */
/* ------------------------------------------------------------------ */

/** How far apart two answers about the floor may be before it is a bug. */
const TOL = 0.05;
/** Half-extent of the generated world, metres (WorldScale: 26 * 92 / 2). */
const HALF = 1196;

interface World {
  city: CitySystem;
  phys: PhysicsWorld;
  scene: THREE.Scene;
  /** The merged surface family plus the bedrock underlay — "the floor". */
  surface: THREE.Mesh[];
  /** Every drawn city mesh. */
  all: THREE.Mesh[];
  /** Raycast through geometry both ways, ignoring which way it faces. */
  ignoreWinding(): void;
  restoreMaterials(): void;
}

let W: World;

function stubBrowser(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = g;
  g.location = { search: '?q=high', href: 'http://localhost/' };
  if (!g.performance) g.performance = { now: () => Date.now() };
}

async function boot(): Promise<World> {
  stubBrowser();
  await initRapier();

  const scene = new THREE.Scene();
  const services = new Map<string, unknown>();
  const ctx = {
    scene,
    rng: new Rng('truth'),
    camera: new THREE.PerspectiveCamera(),
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
    provide: (k: { id: string }, v: unknown) => services.set(k.id, v),
    get: (k: { id: string }) => services.get(k.id),
    tryGet: (k: { id: string }) => services.get(k.id),
  } as unknown as Parameters<PhysicsWorld['init']>[0];

  const phys = new PhysicsWorld();
  await phys.init(ctx);

  const { CitySystem: City } = await import('./city');
  const city = new City();
  city.init(ctx);

  const { InteriorSystem } = await import('./interiors/interiorSystem');
  new InteriorSystem().init(ctx);

  phys.world.step();
  scene.updateMatrixWorld(true);

  (THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: unknown }).computeBoundsTree =
    computeBoundsTree;
  (THREE.Mesh.prototype as unknown as { raycast: unknown }).raycast = acceleratedRaycast;

  const all: THREE.Mesh[] = [];
  const surface: THREE.Mesh[] = [];
  const originals: THREE.Material[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    (m.geometry as unknown as { computeBoundsTree(): void }).computeBoundsTree();
    all.push(m);
    originals.push(m.material as THREE.Material);
    // `CitySystem.bake()` names the merged chunk meshes `<chunk>-<family>`.
    // The floor is the SURFACE family plus the bedrock underlay; DETAIL is
    // street furniture and cornices, which answer a different question.
    if (m.name.endsWith('surface') || m.name === 'ground-underlay') surface.push(m);
  });

  const doubleSided = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  return {
    city, phys, scene, all, surface,
    ignoreWinding() {
      for (const m of all) m.material = doubleSided;
      probeIgnoresWinding = true;
    },
    restoreMaterials() {
      all.forEach((m, i) => { m.material = originals[i]; });
      probeIgnoresWinding = false;
    },
  };
}

beforeAll(async () => {
  W = await boot();
});

/* ------------------------------------------------------------------ */
/* The three probes                                                    */
/* ------------------------------------------------------------------ */

const DOWN = new THREE.Vector3(0, -1, 0);
const _ray = new THREE.Raycaster();
const _from = new THREE.Vector3();

/**
 * When false, a downward probe only accepts triangles that FACE UP — which is
 * what the renderer's back-face culling does, so it measures what you can see.
 * When true it accepts either orientation, which measures what was built.
 * The difference between the two answers is exactly the winding census.
 */
let probeIgnoresWinding = false;

/** Rapier: highest solid surface under `fromY` at (x, z). */
function physicsGround(x: number, z: number, fromY: number, reach: number): number | null {
  _from.set(x, fromY, z);
  const hit = W.phys.raycast(_from, DOWN, reach, probeGroups(CG.STATIC | CG.TERRAIN));
  return hit ? hit.point.y : null;
}

/** True when a BUILDING (CG.STATIC) collider stands at (x, z). */
function physicsBuildingAt(x: number, z: number): boolean {
  _from.set(x, 400, z);
  return W.phys.raycast(_from, DOWN, 800, probeGroups(CG.STATIC)) !== null;
}

/** three-mesh-bvh over the drawn meshes: highest floor-like surface. */
function visualGround(
  meshes: THREE.Mesh[], x: number, z: number, fromY: number, reach: number,
): number | null {
  _ray.set(_from.set(x, fromY, z), DOWN);
  _ray.near = 0;
  _ray.far = reach;
  let best: number | null = null;
  for (const h of _ray.intersectObjects(meshes, false)) {
    const n = h.face?.normal;
    // A vertical triangle is a wall, not a floor. `face.normal` is always the
    // GEOMETRIC normal (from the winding), never the shading normal, which is
    // why the sign of `n.y` is also the winding test.
    if (!n) continue;
    if (probeIgnoresWinding ? Math.abs(n.y) < 0.5 : n.y < 0.5) continue;
    if (best === null || h.point.y > best) best = h.point.y;
  }
  return best;
}

/** Deterministic sample of open (non-building) ground across the whole map. */
function openGround(seed: string, n: number): Array<{ x: number; z: number; a: number }> {
  const rng = new Rng(seed);
  const out: Array<{ x: number; z: number; a: number }> = [];
  for (let i = 0; i < n; i++) {
    const x = rng.range(-HALF, HALF);
    const z = rng.range(-HALF, HALF);
    if (W.city.spatial.isBlocked(x, z)) continue;
    const a = W.city.spatial.groundHeight(x, z);
    if (!Number.isFinite(a)) continue;
    out.push({ x, z, a });
  }
  return out;
}

function pct(vals: number[], f: number): number {
  if (!vals.length) return 0;
  const s = vals.slice().sort((p, q) => p - q);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
}

/* ================================================================== */
/* 1. The world was actually built                                     */
/* ================================================================== */

describe('the world exists', () => {
  test('city, colliders and drawn geometry are all present', () => {
    expect(W.city.roadNodes.length).toBeGreaterThan(100);
    expect(W.surface.length).toBeGreaterThan(4);
    let colliders = 0;
    W.phys.world.forEachCollider(() => { colliders++; });
    expect(colliders).toBeGreaterThan(1000);
  });
});

/* ================================================================== */
/* 2. PROBE-GROUP CANARY                                               */
/*                                                                     */
/* `src/physics/physics.ts` documents the disaster where every probe in */
/* the game was built with `groups(CG.SENSOR, ...)` and therefore       */
/* matched NOTHING, silently, for weeks. A ray that hits nothing looks  */
/* exactly like a ray over a hole. Nothing stopped it recurring except  */
/* a test that fires a real probe where there is definitely ground.     */
/* ================================================================== */

describe('probe groups', () => {
  test('probeGroups() is promiscuous in membership and selective in filter', () => {
    const g = probeGroups(CG.STATIC | CG.TERRAIN);
    // Membership must be 0xffff or the collider's own filter can reject us.
    expect(g >>> 16).toBe(0xffff);
    expect(g & 0xffff).toBe(CG.STATIC | CG.TERRAIN);
  });

  test('CANARY: a ground probe at a road point reports a hit', () => {
    const p = new THREE.Vector3();
    let hit = 0;
    for (let i = 0; i < 60; i++) {
      W.city.randomRoadPoint(p);
      if (W.phys.groundAt(p.x, p.z) !== null) hit++;
    }
    // Every road point is over the bedrock slab at the very least. If this
    // ever reads 0 again, the probes have been re-broken the same way.
    expect(hit).toBe(60);
  });

  test('CANARY: a SENSOR-membership probe matches nothing — the original bug', () => {
    // Reproduces the defect so the reason `probeGroups` exists cannot be lost.
    // A probe whose MEMBERSHIP is only CG.SENSOR fails the collider's own
    // filter test, because no solid collider lists SENSOR in its filter.
    const sensorProbe = ((CG.SENSOR & 0xffff) << 16) | ((CG.STATIC | CG.TERRAIN) & 0xffff);
    const p = new THREE.Vector3();
    let matched = 0;
    let ok = 0;
    for (let i = 0; i < 40; i++) {
      W.city.randomRoadPoint(p);
      _from.set(p.x, 60, p.z);
      if (W.phys.raycast(_from, DOWN, 200, sensorProbe)) matched++;
      if (W.phys.raycast(_from, DOWN, 200, probeGroups(CG.STATIC | CG.TERRAIN))) ok++;
    }
    expect(matched).toBe(0);
    expect(ok).toBe(40);
  });
});

/* ================================================================== */
/* 3. GROUND CONSISTENCY SWEEP                                         */
/* ================================================================== */

describe('ground consistency', () => {
  /**
   * RATCHET — the analytic ground height vs the geometry that was built.
   *
   * Measured 2026-07: the analytic height is a step function of 0
   * (carriageway) or KERB_H = 0.17 (everything else), while the drawn and
   * collided road carries a 90 mm camber crown and the kerb edge is resolved
   * by a 2 m occupancy mask. So roughly one sample in ten is out by 9-23 cm —
   * the character is placed either floating over the crown or buried in the
   * kerb. Same family as the "sunken feet" bug, still live.
   */
  const P90_BUDGET = 0.12;   // 90th percentile of |visual - analytic|, metres
  const P99_BUDGET = 0.26;   // 99th percentile
  const HARD_BUDGET = 0.50;  // nothing may be further out than this

  test('analytic ground vs the drawn ground', () => {
    W.ignoreWinding();
    try {
      const d: number[] = [];
      const outliers: string[] = [];
      for (const s of openGround('ground-visual', 4000)) {
        const v = visualGround(W.surface, s.x, s.z, s.a + 3, 6);
        if (v === null) continue;
        const delta = Math.abs(v - s.a);
        d.push(delta);
        if (delta > 0.3 && outliers.length < 6) {
          outliers.push(`(${s.x.toFixed(0)},${s.z.toFixed(0)}) analytic=${s.a.toFixed(2)} drawn=${v.toFixed(2)}`);
        }
      }
      expect(d.length).toBeGreaterThan(2000);
      const p50 = pct(d, 0.5), p90 = pct(d, 0.9), p99 = pct(d, 0.99);
      const max = d.reduce((m, v) => Math.max(m, v), 0);
      console.log(
        `[ground] |visual-analytic| n=${d.length} p50=${p50.toFixed(3)} ` +
        `p90=${p90.toFixed(3)} p99=${p99.toFixed(3)} max=${max.toFixed(3)} ` +
        `over${TOL}m=${((d.filter((v) => v > TOL).length / d.length) * 100).toFixed(0)}% ` +
        `worst: ${outliers.join(' | ')}`,
      );
      // Half the world agrees to the centimetre. That half must not rot.
      expect(p50).toBeLessThanOrEqual(TOL);
      expect(p90).toBeLessThanOrEqual(P90_BUDGET);
      expect(p99).toBeLessThanOrEqual(P99_BUDGET);
      expect(max).toBeLessThanOrEqual(HARD_BUDGET);
    } finally {
      W.restoreMaterials();
    }
  });

  test('analytic ground vs the collided ground', () => {
    const d: number[] = [];
    let insideSomething = 0;
    for (const s of openGround('ground-physics', 4000)) {
      const ph = physicsGround(s.x, s.z, s.a + 3, 6);
      if (ph === null) continue;
      // A hit at exactly the ray origin means the probe STARTED inside a
      // collider — 3 m above the reported ground, at a point the analytic
      // blocking test calls open. Counted separately; see `building
      // footprints` below, which is where that defect is pinned down.
      if (Math.abs(ph - (s.a + 3)) < 1e-3) { insideSomething++; continue; }
      d.push(Math.abs(ph - s.a));
    }
    expect(d.length).toBeGreaterThan(2000);
    const p50 = pct(d, 0.5), p90 = pct(d, 0.9), p99 = pct(d, 0.99);
    console.log(
      `[ground] |physics-analytic| n=${d.length} p50=${p50.toFixed(3)} ` +
      `p90=${p90.toFixed(3)} p99=${p99.toFixed(3)} startedInsideACollider=${insideSomething}`,
    );
    // A probe 3 m over ground the blocking test calls open must not begin
    // inside a collider. This read 157 while `isInsideBuilding` mirrored every
    // rotated plot; see `building footprints` below.
    expect(insideSomething).toBe(0);
    expect(p50).toBeLessThanOrEqual(TOL);
    expect(p90).toBeLessThanOrEqual(P90_BUDGET + 0.07);
    expect(p99).toBeLessThanOrEqual(P99_BUDGET);
  });

  test('the collided ground and the drawn ground are the same ground', () => {
    W.ignoreWinding();
    try {
      const d: number[] = [];
      for (const s of openGround('ground-pv', 4000)) {
        const ph = physicsGround(s.x, s.z, s.a + 3, 6);
        const v = visualGround(W.surface, s.x, s.z, s.a + 3, 6);
        if (ph === null || v === null) continue;
        if (Math.abs(ph - (s.a + 3)) < 1e-3) continue; // started inside a building
        d.push(Math.abs(ph - v));
      }
      expect(d.length).toBeGreaterThan(2000);
      const p50 = pct(d, 0.5), p90 = pct(d, 0.9), p99 = pct(d, 0.99);
      console.log(
        `[ground] |physics-visual| n=${d.length} p50=${p50.toFixed(3)} ` +
        `p90=${p90.toFixed(3)} p99=${p99.toFixed(3)}`,
      );
      // What you stand on and what you see are built from the same rectangles,
      // so they must agree far more tightly than either agrees with the
      // analytic guess. A plaza with no collider shows up here as a fat p99.
      expect(p50).toBeLessThanOrEqual(P90_BUDGET);
      expect(p99).toBeLessThanOrEqual(P99_BUDGET + 0.06);
    } finally {
      W.restoreMaterials();
    }
  });

  test('open ground is not a hole', () => {
    W.ignoreWinding();
    try {
      let n = 0;
      let holes = 0;
      const examples: string[] = [];
      for (const s of openGround('ground-holes', 4000)) {
        n++;
        const v = visualGround(W.surface, s.x, s.z, s.a + 3, 6);
        // The bedrock underlay caps the world at -0.06; a probe that finds
        // nothing above it means no city surface was drawn here at all.
        if (v === null || v < -0.05) {
          holes++;
          if (examples.length < 5) {
            examples.push(`(${s.x.toFixed(0)}, ${s.z.toFixed(0)})@${s.a.toFixed(2)}`);
          }
        }
      }
      console.log(`[ground] undrawn ground ${holes}/${n} eg ${examples.join(' ')}`);
      // RATCHET, measured ~4%: outside the imported extent the generated grid
      // leaves unpaved block interiors that `groundHeight` still reports as
      // walkable pavement. Cosmetic today; must not spread.
      expect(holes / n).toBeLessThanOrEqual(0.08);
    } finally {
      W.restoreMaterials();
    }
  });
});

/* ================================================================== */
/* 4. BUILDINGS: the blocking test vs the colliders                    */
/* ================================================================== */

describe('building footprints', () => {
  /**
   * `spatial.isBlocked` must agree with the colliders it is a model of.
   *
   * IT DID NOT, AND THE DEFECT WAS A SIGN. `CitySystem.isInsideBuilding`
   * transformed the query point by R_y(-rot) — the collider's own
   * local-to-world map — where a point test needs the INVERSE, R_y(+rot).
   * Axis-aligned plots agreed and hid it; every plot at an angle, which since
   * the OpenStreetMap import is most of the ~2700 buildings, had an analytic
   * footprint that was the collider MIRRORED about its own axes.
   *
   * Measured before the fix: 3.5% of the map reported open with a solid
   * building standing on it and 3.4% reported blocked over open pavement — and
   * `isBlocked` is what peds, traffic and every spawn point use to decide where
   * NOT to put things. After the fix: 1 sample in 4000 and 0 in 4000, the one
   * being a point landing on a collider face to within floating point.
   *
   * These budgets are deliberately near zero. They are not a ratchet; they are
   * the invariant, and any drift means the two descriptions of the city have
   * come apart again.
   */
  const FALSE_OPEN_BUDGET = 0.002;
  const FALSE_BLOCKED_BUDGET = 0.002;

  test('isBlocked() agrees with the building colliders', () => {
    const rng = new Rng('footprints');
    let n = 0, falseOpen = 0, falseBlocked = 0;
    const examples: string[] = [];
    for (let i = 0; i < 4000; i++) {
      const x = rng.range(-HALF, HALF);
      const z = rng.range(-HALF, HALF);
      const said = W.city.spatial.isBlocked(x, z);
      const real = physicsBuildingAt(x, z);
      n++;
      if (!said && real) {
        falseOpen++;
        if (examples.length < 4) examples.push(`(${x.toFixed(0)},${z.toFixed(0)})`);
      } else if (said && !real) {
        falseBlocked++;
      }
    }
    console.log(
      `[footprints] n=${n} saysOpenButSolid=${falseOpen} (${((100 * falseOpen) / n).toFixed(1)}%) ` +
      `saysBlockedButEmpty=${falseBlocked} (${((100 * falseBlocked) / n).toFixed(1)}%) eg ${examples.join(' ')}`,
    );
    expect(falseOpen / n).toBeLessThanOrEqual(FALSE_OPEN_BUDGET);
    expect(falseBlocked / n).toBeLessThanOrEqual(FALSE_BLOCKED_BUDGET);
  });

  test('a rotated plot is tested with the INVERSE of the collider rotation', () => {
    // The sign error, in isolation, so that the fix cannot be undone by someone
    // "tidying" the trigonometry. A point offset along the plot's own local +x
    // must be inside; the mirrored offset, at the same distance, must not be —
    // and it is precisely the mirrored one the old code accepted.
    const rot = 0.6;                    // a plot skewed 34 degrees off the grid
    const hx = 12, hz = 3;              // long and thin, so the mirror shows
    const c = Math.cos(rot), s = Math.sin(rot);
    // Local (10, 0) mapped to world by the collider's R_y(-rot).
    const insideX = 10 * c, insideZ = 10 * s;
    // World -> local with the CORRECT inverse.
    const lx = insideX * c + insideZ * s;
    const lz = insideZ * c - insideX * s;
    expect(Math.abs(lx)).toBeLessThan(hx);
    expect(Math.abs(lz)).toBeLessThan(hz);
    // World -> local with the OLD, wrong transform: same point, now outside.
    const badX = insideX * c - insideZ * s;
    const badZ = insideX * s + insideZ * c;
    expect(Math.abs(badZ)).toBeGreaterThan(hz);
    expect(`old transform says inside: ${Math.abs(badX) < hx && Math.abs(badZ) < hz}`)
      .toBe('old transform says inside: false');
  });
});

/* ================================================================== */
/* 5. WINDING CENSUS OVER THE BAKED CITY                               */
/* ================================================================== */

/**
 * Geometric winding vs the authored shading normal, per triangle.
 *
 * This is the scene-scale version of `src/characters/face/checks.ts`. A
 * silhouette is winding-agnostic and so is a lit render when the shading
 * normal is authored separately from the index order — which is exactly how a
 * head came to render inside out. Where the two disagree the triangle is
 * BACK-FACING to anyone looking at its lit side; every city material is
 * `FrontSide`, so the triangle is culled and you see through it.
 */
function windingCensus(g: THREE.BufferGeometry): { tris: number; agree: number; disagree: number } {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const idx = g.getIndex();
  const out = { tris: 0, agree: 0, disagree: 0 };
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
    if (Math.hypot(nx, ny, nz) < 1e-9) continue;
    const sx = N[a] + N[b] + N[c];
    const sy = N[a + 1] + N[b + 1] + N[c + 1];
    const sz = N[a + 2] + N[b + 2] + N[c + 2];
    const d = nx * sx + ny * sy + nz * sz;
    if (d > 0) out.agree++;
    else if (d < 0) out.disagree++;
  }
  return out;
}

describe('winding', () => {
  /**
   * RATCHET, NOW CLOSED — the city's ground used to be wound inside out.
   *
   * The budgets below were 0.72 / 0.20 / 0.10, standing in for a measured,
   * live and unfixed defect: SURFACE 57 494 / 82 426 triangles wound against
   * their own shading normal, FACADE 9 617 / 53 972, DETAIL 123 049 /
   * 1 489 224. Every city material is `THREE.FrontSide`, so each of those
   * triangles was back-face culled from the side it was lit for — the
   * carriageways, crossings, stop bars, tram beds, park and square polygons
   * and every imported roof cap past a quadrilateral were not drawn at all,
   * and what showed through was the near-black bedrock underlay, which under a
   * three-degree sun reads as wet asphalt. That is why three separate reviews
   * called the ground the weakest surface in the game without anyone noticing
   * that most of the ground was not on screen.
   *
   * FIXED in src/world/city/builders.ts (`ribbon`'s index order, and
   * `triangulate()`'s handedness for both `poly` and `cap`); `tube` was fixed
   * earlier in the foliage pass. See `city/builders.test.ts` section 1, which
   * now asserts all five per-emitter.
   *
   * THE BUDGETS ARE NOW THE MEASURED RESIDUAL, not a tolerance. Surface is
   * exactly zero. The facade's single triangle and the detail pass's 674 are
   * degenerate slivers off `blob`'s jittered poles and off zero-length plot
   * edges — they enclose no area and shade nothing. Anything that pushes these
   * up is a new instance of the same bug class, which has now appeared five
   * times on this project; do not raise them to make a test pass.
   */
  const BUDGET: Record<string, number> = { surface: 0, facade: 0.0001, detail: 0.001 };

  test('city geometry faces the way its normals claim', () => {
    const fam = new Map<string, { tris: number; agree: number; disagree: number }>();
    for (const m of W.all) {
      if (m.name === 'ground-underlay') continue;
      const key = m.name.replace(/^chunk-\d+-\d+-/, '');
      const c = windingCensus(m.geometry);
      const acc = fam.get(key) ?? { tris: 0, agree: 0, disagree: 0 };
      acc.tris += c.tris; acc.agree += c.agree; acc.disagree += c.disagree;
      fam.set(key, acc);
    }
    expect(fam.size).toBeGreaterThanOrEqual(3);
    for (const [k, c] of fam) {
      const frac = c.disagree / Math.max(1, c.tris);
      console.log(`[winding] ${k}: ${c.disagree}/${c.tris} inside out (${(frac * 100).toFixed(1)}%)`);
      const budget = BUDGET[k];
      // A new material family with no budget is a new place for this to hide.
      expect(budget).toBeDefined();
      expect(frac).toBeLessThanOrEqual(budget!);
    }
  });

  test('the ground you can SEE is a subset of the ground that was BUILT', () => {
    // Two probes over the same points: one that respects back-face culling and
    // one that does not. Their difference is drawn geometry the player cannot
    // see. This is the assertion that makes an inside-out world impossible to
    // report as a healthy one, whatever the triangle counts say.
    const pts = openGround('winding-ground', 2500);
    let visible = 0;
    for (const s of pts) {
      const front = visualGround(W.surface, s.x, s.z, s.a + 3, 6);
      if (front !== null && front >= -0.05) visible++;
    }
    W.ignoreWinding();
    let built = 0;
    try {
      for (const s of pts) {
        const both = visualGround(W.surface, s.x, s.z, s.a + 3, 6);
        if (both !== null && both >= -0.05) built++;
      }
    } finally {
      W.restoreMaterials();
    }
    const hidden = built - visible;
    console.log(
      `[winding] ground built=${built}/${pts.length} visible=${visible}/${pts.length} culledAway=${hidden}`,
    );
    expect(built).toBeGreaterThanOrEqual(visible);
    // RATCHET: today roughly 44% of the ground that exists is culled away.
    expect(hidden / pts.length).toBeLessThanOrEqual(0.55);
  });
});

/* ================================================================== */
/* 6. INTERIORS                                                        */
/* ================================================================== */

describe('interiors', () => {
  /**
   * A room's floor must be SOLID AT THE HEIGHT IT ADVERTISES.
   *
   * Two distinct failures are separated here, because they read the same in a
   * screenshot and are completely different bugs:
   *
   *   BELOW  the collided floor sits lower than `floorY` (or is missing). The
   *          capsule is rested on `floorY` by the caller, then sinks — the
   *          shin-deep Builders House lobby. Never acceptable.
   *   ABOVE  the probe found something higher than `floorY`. Legitimate: the
   *          reception desk, the shop's fridge run and the studio's gallery
   *          platform are furniture colliders you stand ON. Only the fraction
   *          of the room they cover is asserted.
   */
  const CLEAR_FLOOR_FRACTION = 0.75;

  test('every interior has a floor you can stand on, at the height it claims', () => {
    W.ignoreWinding();
    const rows: string[] = [];
    const failures: string[] = [];
    try {
      for (const spec of INTERIORS) {
        const { hx, hz } = innerHalf(spec);
        const rng = new Rng(`floor-${spec.id}`);
        let miss = 0, below = 0, clear = 0, onFurniture = 0, visMiss = 0;
        let deepest = 0;
        const n = 160;
        for (let i = 0; i < n; i++) {
          const x = spec.cx + rng.range(-hx * 0.85, hx * 0.85);
          const z = spec.cz + rng.range(-hz * 0.85, hz * 0.85);
          const from = spec.floorY + 1.9;
          const ph = physicsGround(x, z, from, 2.6);
          const v = visualGround(W.all, x, z, from, 2.6);
          if (ph === null) miss++;
          else if (ph < spec.floorY - TOL) { below++; deepest = Math.max(deepest, spec.floorY - ph); }
          else if (ph <= spec.floorY + TOL) clear++;
          else onFurniture++;
          if (v === null) visMiss++;
        }
        rows.push(
          `[interior] ${spec.id} floorY=${spec.floorY} n=${n} noFloor=${miss} ` +
          `below=${below} (deepest ${deepest.toFixed(3)}) clear=${clear} onFurniture=${onFurniture} ` +
          `nothingDrawn=${visMiss}`,
        );
        if (miss > 0) failures.push(`${spec.id}: ${miss}/${n} samples have NO collided floor`);
        if (below > 0) {
          failures.push(`${spec.id}: ${below}/${n} samples collide BELOW floorY, deepest ${deepest.toFixed(3)} m`);
        }
        if ((clear + onFurniture) / n < CLEAR_FLOOR_FRACTION) {
          failures.push(`${spec.id}: only ${(((clear + onFurniture) / n) * 100).toFixed(0)}% standable`);
        }
      }
    } finally {
      W.restoreMaterials();
    }
    for (const r of rows) console.log(r);
    expect(failures).toEqual([]);
  });

  test('the analytic ground inside a room is the room floor, not the street', () => {
    // Anything that spawns a character reads `groundHeight`, not the interior
    // table. If they differ, the ped stands in the floor. This currently HOLDS
    // (the interior floors are registered as raised slabs) and must keep
    // holding — it is the assertion the shin-deep lobby would have failed.
    const off: string[] = [];
    for (const spec of INTERIORS) {
      const a = W.city.spatial.groundHeight(spec.cx, spec.cz);
      console.log(`[interior] ${spec.id} analytic=${a.toFixed(3)} floorY=${spec.floorY}`);
      if (Math.abs(a - spec.floorY) > TOL) off.push(`${spec.id}: analytic ${a.toFixed(3)} vs floorY ${spec.floorY}`);
    }
    expect(off).toEqual([]);
  });
});
