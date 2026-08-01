/** Pure-geometry checks for the two tree builders used across the city. */

import { describe, expect, test } from 'bun:test';
import { Rng } from '../../core/rng';
import { DetailBuilder } from '../city/builders';
import { planeTree } from '../city/facades';
import { autumnTree } from './foliage';
import { PropBuilder } from './kit';

interface Bounds {
  minY: number;
  height: number;
  width: number;
}

function bounds(pos: ReadonlyArray<number>): Bounds {
  let x0 = Infinity; let x1 = -Infinity;
  let y0 = Infinity; let y1 = -Infinity;
  let z0 = Infinity; let z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    x0 = Math.min(x0, pos[i]); x1 = Math.max(x1, pos[i]);
    y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1]);
    z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2]);
  }
  return { minY: y0, height: y1 - y0, width: Math.max(x1 - x0, z1 - z0) };
}

function leafChromas(
  col: ReadonlyArray<number>,
  vertices: number,
  transAt: (vertex: number) => number,
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < vertices; i++) {
    if (transAt(i) <= 0.7) continue;
    const r = col[i * 3];
    const g = col[i * 3 + 1];
    const b = col[i * 3 + 2];
    const sum = r + g + b;
    out.add(`${(r / sum).toFixed(3)}:${(g / sum).toFixed(3)}:${(b / sum).toFixed(3)}`);
  }
  return out;
}

function expectGeometry(
  pos: ReadonlyArray<number>, idx: ReadonlyArray<number>, extra: ReadonlyArray<number>[],
): Bounds {
  expect(pos.length).toBeGreaterThan(0);
  expect(pos.every(Number.isFinite)).toBe(true);
  expect(idx.every(Number.isInteger)).toBe(true);
  const vertices = pos.length / 3;
  expect(Math.max(...idx)).toBeLessThan(vertices);
  for (const data of extra) expect(data.every(Number.isFinite)).toBe(true);
  const b = bounds(pos);
  expect(b.minY).toBeGreaterThanOrEqual(0.08);
  expect(b.minY).toBeLessThanOrEqual(0.2);
  expect(b.height).toBeGreaterThan(4);
  expect(b.height).toBeLessThan(14.5);
  expect(b.width).toBeGreaterThan(2.2);
  expect(b.width).toBeLessThan(8.5);
  return b;
}

interface LeafComponent {
  vertices: number;
  width: number;
}

/** Leaf blobs are intentionally emitted as disconnected primitives. Recover
 * those components from the merged index buffer so the near-shell test can
 * measure cluster granularity without coupling to a private builder counter. */
function leafComponents(props: PropBuilder): LeafComponent[] {
  const n = props.pos.length / 3;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== value) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  const join = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (let i = 0; i < props.idx.length; i += 3) {
    join(props.idx[i], props.idx[i + 1]);
    join(props.idx[i + 1], props.idx[i + 2]);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(i);
    else groups.set(root, [i]);
  }
  const out: LeafComponent[] = [];
  for (const group of groups.values()) {
    if (!group.every((i) => props.trans[i] > 0.7)) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const i of group) {
      x0 = Math.min(x0, props.pos[i * 3]);
      x1 = Math.max(x1, props.pos[i * 3]);
      z0 = Math.min(z0, props.pos[i * 3 + 2]);
      z1 = Math.max(z1, props.pos[i * 3 + 2]);
    }
    out.push({ vertices: group.length, width: Math.max(x1 - x0, z1 - z0) });
  }
  return out;
}

describe('late-autumn trees', () => {
  test('both builders emit grounded, finite, coherent crowns', () => {
    for (const seed of ['tree-a', 'tree-b', 'tree-c']) {
      const props = new PropBuilder();
      autumnTree(props, 0, 0, new Rng(seed), 1, 0.12, 2);
      expectGeometry(
        props.pos, props.idx,
        [props.nrm, props.col, props.mr, props.emis, props.trans, props.wind],
      );
      const propChromas = leafChromas(props.col, props.pos.length / 3, (i) => props.trans[i]);
      expect(propChromas.size).toBeGreaterThan(0);
      expect(propChromas.size).toBeLessThanOrEqual(3);

      const city = new DetailBuilder();
      planeTree(city, 0, 0, new Rng(seed), 1, 2);
      expectGeometry(city.pos, city.idx, [city.nrm, city.col, city.mr, city.emi, city.fol]);
      const cityChromas = leafChromas(city.col, city.pos.length / 3, (i) => city.fol[i * 2]);
      expect(cityChromas.size).toBeGreaterThan(0);
      expect(cityChromas.size).toBeLessThanOrEqual(3);
    }
  });

  test('LOD changes granularity without making the distant crown disappear', () => {
    const propTriangles: number[] = [];
    const cityTriangles: number[] = [];
    for (const lod of [0, 1, 2] as const) {
      const props = new PropBuilder();
      autumnTree(props, 0, 0, new Rng('lod-tree'), 1, 0.12, lod);
      propTriangles.push(props.triangles);
      expect(bounds(props.pos).width).toBeGreaterThan(2.2);

      const city = new DetailBuilder();
      planeTree(city, 0, 0, new Rng('lod-tree'), 1, lod);
      cityTriangles.push(city.triangles);
      expect(bounds(city.pos).width).toBeGreaterThan(2.2);
    }
    expect(propTriangles[0]).toBeLessThan(propTriangles[1]);
    expect(propTriangles[1]).toBeLessThan(propTriangles[2]);
    expect(cityTriangles[0]).toBeLessThan(cityTriangles[1]);
    expect(cityTriangles[1]).toBeLessThan(cityTriangles[2]);
  });

  test('near autumn crowns use finer clusters and keep a matte leaf response', () => {
    const near = new PropBuilder();
    autumnTree(near, 0, 0, new Rng('near-canopy'), 1, 0.2, 2);
    const mid = new PropBuilder();
    autumnTree(mid, 0, 0, new Rng('near-canopy'), 1, 0.2, 1);

    const nearLeaves = leafComponents(near).filter((c) => c.vertices >= 14);
    const midLeaves = leafComponents(mid).filter((c) => c.vertices >= 12);
    expect(nearLeaves.length).toBeGreaterThan(midLeaves.length);
    expect(Math.max(...nearLeaves.map((c) => c.width))).toBeLessThan(
      Math.max(...midLeaves.map((c) => c.width)),
    );

    const leafRoughness = near.trans
      .map((trans, i) => trans > 0.7 ? near.mr[i * 2 + 1] : null)
      .filter((value): value is number => value !== null);
    expect(leafRoughness.length).toBeGreaterThan(0);
    expect(new Set(leafRoughness)).toEqual(new Set([0.76]));
  });

  test('street-tree species produce materially different silhouettes', () => {
    const ratios: number[] = [];
    for (let i = 0; i < 18; i++) {
      const d = new DetailBuilder();
      planeTree(d, 0, 0, new Rng(`species-${i}`), 1, 1);
      const b = bounds(d.pos);
      ratios.push(b.height / b.width);
    }
    expect(Math.min(...ratios)).toBeLessThan(1.7);
    expect(Math.max(...ratios)).toBeGreaterThan(2.1);
  });
});
