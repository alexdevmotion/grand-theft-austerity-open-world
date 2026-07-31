/**
 * IS IT INSIDE OUT? — for every closed mesh the game generates.
 *
 * `src/characters/face/checks.ts` guards heads, because a head shipped inside
 * out and survived several reviews: a silhouette is winding-agnostic, and so is
 * a lit render when the shading normal is authored separately from the index
 * order. Nothing guarded the vehicles, the props or the interiors, which are
 * built by three different builders with three different conventions.
 *
 * METHOD. A merged buffer is a soup of hundreds of disjoint solids, and the
 * aggregate volume of a soup happily stays positive while one solid inside it
 * is reversed. So the geometry is first SPLIT INTO CONNECTED COMPONENTS by
 * welding coincident positions; each component is then tested for CLOSURE
 * (every directed edge appears exactly once and its opposite exactly once) and,
 * if closed, for POSITIVE ENCLOSED VOLUME by the divergence theorem. A closed
 * component with negative volume is a solid you can see the inside of and not
 * the outside — invisible under back-face culling, and impossible to spot in a
 * screenshot of a city with two million triangles in it.
 *
 * Open components (panels, decals, glass planes, wires) enclose nothing and are
 * counted but not judged.
 *
 * OWNER: truth-assertion agent. Pure geometry: no world, no browser, no GPU.
 */

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../core/rng';
import { VARIANTS, buildBody } from '../vehicles/bodies';
import { CLASS_MODELS } from '../vehicles/models';
import type { VehicleClass } from '../core/services';
import { DetailBuilder } from './city/builders';
import { PropBuilder } from './props/kit';
import * as furniture from './props/streetFurniture';
import * as barriers from './props/barriers';
import * as foliage from './props/foliage';
import { INTERIORS } from './interiors/defs';
import { fitBar, fitBlockHall, fitShop } from './interiors/ambient';
import { fitLobby } from './interiors/lobby';
import { fitRecorder } from './interiors/recorder';
import { fitStudio } from './interiors/studio';
import type { ShellSpec } from './interiors/shell';

/* ------------------------------------------------------------------ */
/* Connected-component analysis                                        */
/* ------------------------------------------------------------------ */

export interface Component {
  triangles: number;
  /** Watertight: every directed edge has exactly one opposite twin. */
  closed: boolean;
  /** Divergence-theorem volume. Positive means wound outward. */
  volume: number;
}

/** Weld tolerance, in units of 0.1 mm — the builders emit exact duplicates. */
const WELD = 1e4;

export function analyse(g: THREE.BufferGeometry): Component[] {
  const posAttr = g.getAttribute('position');
  if (!posAttr) return [];
  const P = posAttr.array as ArrayLike<number>;
  const index = g.getIndex();
  const corners = index ? index.count : posAttr.count;
  const triCount = Math.floor(corners / 3);
  const at = (t: number, j: number): number => (index ? index.getX(t * 3 + j) : t * 3 + j) * 3;

  // Weld coincident positions so a merged buffer of separate solids splits.
  const ids = new Map<string, number>();
  const vid = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let j = 0; j < 3; j++) {
      const b = at(t, j);
      const k = `${Math.round(P[b] * WELD)},${Math.round(P[b + 1] * WELD)},${Math.round(P[b + 2] * WELD)}`;
      let v = ids.get(k);
      if (v === undefined) { v = ids.size; ids.set(k, v); }
      vid[t * 3 + j] = v;
    }
  }

  const parent = new Int32Array(ids.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let t = 0; t < triCount; t++) {
    union(vid[t * 3], vid[t * 3 + 1]);
    union(vid[t * 3], vid[t * 3 + 2]);
  }

  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(vid[t * 3]);
    let list = groups.get(r);
    if (!list) groups.set(r, (list = []));
    list.push(t);
  }

  const out: Component[] = [];
  for (const tris of groups.values()) {
    const edges = new Map<number, number>();
    let vol = 0;
    for (const t of tris) {
      const a = at(t, 0), b = at(t, 1), c = at(t, 2);
      vol += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
        + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2])
        + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
      const v0 = vid[t * 3], v1 = vid[t * 3 + 1], v2 = vid[t * 3 + 2];
      for (const [x, y] of [[v0, v1], [v1, v2], [v2, v0]] as const) {
        const key = x * 0x100000 + y;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    let closed = true;
    for (const [key, count] of edges) {
      const x = Math.floor(key / 0x100000);
      const y = key - x * 0x100000;
      if (count !== 1 || (edges.get(y * 0x100000 + x) ?? 0) !== 1) { closed = false; break; }
    }
    out.push({ triangles: tris.length, closed, volume: vol / 6 });
  }
  return out;
}

interface Verdict {
  components: number;
  closed: number;
  insideOut: number;
  triangles: number;
}

function verdict(g: THREE.BufferGeometry | undefined | null): Verdict {
  const v: Verdict = { components: 0, closed: 0, insideOut: 0, triangles: 0 };
  if (!g) return v;
  for (const c of analyse(g)) {
    v.components++;
    v.triangles += c.triangles;
    if (!c.closed) continue;
    v.closed++;
    // A closed shell of zero volume is a degenerate sliver, not an error.
    if (c.volume < -1e-9) v.insideOut++;
  }
  return v;
}

/* ================================================================== */
/* 0. The analyser itself                                             */
/* ================================================================== */

describe('the analyser', () => {
  const opts = { color: [1, 1, 1] };

  test('separates disjoint solids instead of averaging them', () => {
    const b = new DetailBuilder();
    b.box(0, 1, 0, 2, 2, 2, 0, opts);
    b.box(20, 1, 0, 2, 2, 2, 0, opts);
    const cs = analyse(b.build());
    expect(cs.length).toBe(2);
    expect(cs.every((c) => c.closed)).toBe(true);
    expect(cs.every((c) => c.volume > 0)).toBe(true);
  });

  test('catches ONE reversed solid hiding among correct ones', () => {
    // The failure mode that a whole-mesh volume check cannot see.
    const good = new DetailBuilder();
    for (let i = 0; i < 5; i++) good.box(i * 20, 1, 0, 2, 2, 2, 0, opts);
    const g = good.build();
    const idx = Array.from(g.getIndex()!.array);
    // Reverse the winding of the last box only.
    for (let i = idx.length - 36; i < idx.length; i += 3) {
      const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t;
    }
    g.setIndex(idx);
    const v = verdict(g);
    expect(v.components).toBe(5);
    expect(v.closed).toBe(5);
    expect(v.insideOut).toBe(1);
    // ...while the aggregate volume is still comfortably positive, which is
    // exactly why the aggregate is not good enough.
    expect(analyse(g).reduce((s, c) => s + c.volume, 0)).toBeGreaterThan(0);
  });

  test('does not judge open surfaces', () => {
    const b = new DetailBuilder();
    b.plate([-1, 0, 0], [-1, 2, 0], [1, 2, 0], [1, 0, 0], opts);
    const v = verdict(b.build());
    expect(v.components).toBe(1);
    expect(v.closed).toBe(0);
    expect(v.insideOut).toBe(0);
  });
});

/* ================================================================== */
/* 1. VEHICLES — every class, every variant, hero and ambient          */
/* ================================================================== */

describe('vehicle bodywork', () => {
  const classes = Object.keys(CLASS_MODELS) as VehicleClass[];

  test('every class has at least one variant and a shell with volume', () => {
    expect(classes.length).toBeGreaterThan(5);
    for (const kind of classes) expect(VARIANTS[kind]).toBeGreaterThan(0);
  });

  for (const kind of Object.keys(CLASS_MODELS) as VehicleClass[]) {
    test(`${kind}: no closed part of any variant is inside out`, () => {
      const failures: string[] = [];
      let totalClosed = 0;
      for (let v = 0; v < VARIANTS[kind]; v++) {
        // Hero bodywork only differs from ambient on variant 0's paint and
        // dents; building it for every variant doubles the run for no coverage.
        for (const hero of v === 0 ? [false, true] : [false]) {
          const body = buildBody(kind, v, hero);
          for (const [part, geo] of [
            ['shell', body.shell], ['glass', body.glass], ['driver', body.driver],
          ] as const) {
            const r = verdict(geo);
            totalClosed += r.closed;
            if (r.insideOut > 0) {
              failures.push(
                `${kind}#${v}${hero ? ' hero' : ''}.${part}: ${r.insideOut}/${r.closed} closed parts reversed`,
              );
            }
          }
          for (const d of body.doors ?? []) {
            const r = verdict(d.geometry as THREE.BufferGeometry | undefined);
            totalClosed += r.closed;
            if (r.insideOut > 0) failures.push(`${kind}#${v} door: ${r.insideOut} reversed`);
          }
        }
      }
      expect(failures).toEqual([]);
      // A body that produced no closed solids at all would pass vacuously.
      expect(totalClosed).toBeGreaterThan(4);
    });
  }
});

/* ================================================================== */
/* 2. STREET PROPS                                                     */
/* ================================================================== */

describe('street props', () => {
  const build = (f: (b: PropBuilder, rng: Rng) => void): THREE.BufferGeometry => {
    const b = new PropBuilder();
    f(b, new Rng('props'));
    return b.build();
  };

  const cases: Array<[string, (b: PropBuilder, rng: Rng) => void]> = [
    ['bench', (b, r) => furniture.bench(b, 0, 0, 1, 0, r)],
    ['litterBin', (b, r) => furniture.litterBin(b, 0, 0, r)],
    ['stoneBollard', (b) => furniture.stoneBollard(b, 0, 0)],
    ['atm', (b) => furniture.atm(b, 0, 0, 1, 0)],
    ['phoneBox', (b) => furniture.phoneBox(b, 0, 0, 1, 0)],
    ['newsStand', (b, r) => furniture.newsStand(b, 0, 0, 1, 0, r)],
    ['utilityCabinet', (b, r) => furniture.utilityCabinet(b, 0, 0, 1, 0, r)],
    ['bicycle', (b, r) => furniture.bicycle(b, 0, 0, 0.4, r)],
    ['eScooter', (b, r) => furniture.eScooter(b, 0, 0, 0.4, r)],
    ['trafficCone', (b, r) => barriers.trafficCone(b, 0, 0, 0, r)],
    ['palletStack', (b, r) => barriers.palletStack(b, 0, 0, 0, 3, r)],
    ['skip', (b, r) => barriers.skip(b, 0, 0, 0, 0.3, r)],
    ['jerseyBarrier', (b, r) => barriers.jerseyBarrier(b, 0, 0, 0, 0, r)],
    ['warningLamp', (b) => barriers.warningLamp(b, 0, 0.6, 0)],
    ['planter', (b, r) => foliage.planter(b, 0, 0, r)],
    ['treeGrate', (b, r) => foliage.treeGrate(b, 0, 0, r)],
  ];

  for (const [name, f] of cases) {
    test(`${name} is solid, not hollow`, () => {
      const r = verdict(build(f));
      expect(r.triangles).toBeGreaterThan(0);
      expect(`${name}: ${r.insideOut} of ${r.closed} closed parts reversed`)
        .toBe(`${name}: 0 of ${r.closed} closed parts reversed`);
    });
  }

  test('the props kit covers at least the fixtures a street needs', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });
});

/* ================================================================== */
/* 3. INTERIOR FITOUTS                                                 */
/* ================================================================== */

describe('interior fitouts', () => {
  const spec = (id: string): ShellSpec => {
    const s = INTERIORS.find((x) => x.id === id);
    if (!s) throw new Error(`no such interior: ${id}`);
    return s;
  };

  const rooms: Array<[string, (b: DetailBuilder, s: ShellSpec, r: Rng) => unknown]> = [
    ['buildersLobby', (b, s, r) => fitLobby(b, s, r, 'sealed')],
    ['buildersLobby (liberated)', (b, s, r) => fitLobby(b, s, r, 'liberated')],
    ['recorderNewsroom', (b, s, r) => fitRecorder(b, s, r)],
    ['broadcastStudio', (b, s, r) => fitStudio(b, s, r, 'regime')],
    ['broadcastStudio (hijacked)', (b, s, r) => fitStudio(b, s, r, 'hijacked')],
    ['cornerShop', (b, s, r) => fitShop(b, s, r)],
    ['buildersBar', (b, s, r) => fitBar(b, s, r)],
    ['blockHall', (b, s, r) => fitBlockHall(b, s, r)],
  ];

  for (const [label, fit] of rooms) {
    test(`${label}: no closed piece of furniture is inside out`, () => {
      const id = label.split(' ')[0];
      const b = new DetailBuilder();
      fit(b, spec(id), new Rng(`fit-${label}`));
      const r = verdict(b.build());
      expect(r.triangles).toBeGreaterThan(50);
      expect(`${label}: ${r.insideOut} of ${r.closed} closed pieces reversed`)
        .toBe(`${label}: 0 of ${r.closed} closed pieces reversed`);
    });
  }
});

/* ================================================================== */
/* 4. THE PROP BUILDER'S OWN PRIMITIVES                                */
/*                                                                     */
/* `PropBuilder` is a SECOND, independent implementation of the same    */
/* primitives as `DetailBuilder` (box, cyl, tube, blob...), in          */
/* src/world/props/kit.ts. Two implementations of one convention is two */
/* chances to get it backwards, and the uncapped ones emit OPEN         */
/* components that the volume test above declines to judge — so they    */
/* are checked here by winding against the authored shading normal.     */
/* ================================================================== */

function windingDisagreements(g: THREE.BufferGeometry): { tris: number; bad: number } {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  const idx = g.getIndex();
  const out = { tris: 0, bad: 0 };
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
    const d = nx * (N[a] + N[b] + N[c]) + ny * (N[a + 1] + N[b + 1] + N[c + 1])
      + nz * (N[a + 2] + N[b + 2] + N[c + 2]);
    if (d < 0) out.bad++;
  }
  return out;
}

describe('PropBuilder primitives face the way their normals claim', () => {
  const opts = { color: new THREE.Color(0.5, 0.5, 0.5), mr: [0.6, 0] as [number, number] };
  const mk = (f: (b: PropBuilder) => void): THREE.BufferGeometry => {
    const b = new PropBuilder(); f(b); return b.build();
  };
  const cases: Array<[string, () => THREE.BufferGeometry]> = [
    ['box', () => mk((b) => b.box(0, 1, 0, 2, 2, 2, 0, opts))],
    ['box (rotated)', () => mk((b) => b.box(0, 1, 0, 3, 2, 1, 0.9, opts))],
    ['cyl', () => mk((b) => b.cyl(0, 0, 0, 0.6, 0.6, 3, 10, opts))],
    ['blob', () => mk((b) => b.blob(0, 0, 0, 1, 1, 1, opts, 0, 3, 2, 0, 8))],
  ];
  for (const [name, build] of cases) {
    test(name, () => {
      const r = windingDisagreements(build());
      expect(r.tris).toBeGreaterThan(0);
      expect(`PropBuilder.${name}: ${r.bad}/${r.tris} inside out`)
        .toBe(`PropBuilder.${name}: 0/${r.tris} inside out`);
    });
  }

  /**
   * QUARANTINE — `PropBuilder.tube` is inside out, exactly like
   * `DetailBuilder.tube`. Two independent implementations of the same
   * primitive, the same mistake in both, and between them they build every
   * tree branch, wire, handrail, bracket, bike frame and scaffold pole in the
   * city. The surrounding solids are open at both ends, so the volume test
   * above cannot see it; this is what does.
   *
   * FIX (src/world/props/kit.ts): the ring pair is walked the opposite way
   * round to `cyl`, which is correct — mirror `cyl`'s index order. Then delete
   * this test and move `tube` into the list above.
   */
  test('STILL BROKEN: PropBuilder.tube (branches, wires, handrails)', () => {
    for (const g of [
      mk((b) => b.tube(0, 0, 0, 0, 3, 0, 0.2, 8, opts)),
      mk((b) => b.tube(0, 0, 0, 2, 3, 1, 0.2, 8, opts)),
    ]) {
      const r = windingDisagreements(g);
      expect(`PropBuilder.tube: ${r.bad}/${r.tris}`).toBe(`PropBuilder.tube: ${r.tris}/${r.tris}`);
    }
  });

  /**
   * QUARANTINE — `panel` and `disc` emit BOTH faces, and both of them carry
   * the normal of the other one.
   *
   * The front quad is wound (a, b, c, d) with `right = up x forward`, whose
   * geometric normal is -forward, while every vertex is given +forward; the
   * back quad is the mirror of both. So neither face is culled — a sign is
   * visible from either side, which is why this never looked broken — but
   * every one of them is SHADED BY THE LIGHT BEHIND IT. Under a three-degree
   * sun that is the difference between a lit shopfront sign and a black one,
   * across every fascia, poster, road sign, number plate and lamp lens in the
   * city.
   *
   * FIX (src/world/props/kit.ts): swap the two normals, or reverse both index
   * orders. Then move these into the list above.
   */
  test('STILL BROKEN: PropBuilder.panel and .disc are lit from behind', () => {
    const panel = windingDisagreements(mk((b) => b.panel(0, 1, 0, 2, 1, 0, 1, opts)));
    expect(`panel: ${panel.bad}/${panel.tris}`).toBe(`panel: ${panel.tris}/${panel.tris}`);
    const disc = windingDisagreements(mk((b) => b.disc(0, 1, 0, 0.5, 0, 1, 12, opts)));
    expect(`disc: ${disc.bad}/${disc.tris}`).toBe(`disc: ${disc.tris}/${disc.tris}`);
  });
});
