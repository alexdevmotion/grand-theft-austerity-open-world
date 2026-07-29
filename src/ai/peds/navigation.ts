/**
 * PAVEMENT NAVIGATION GRAPH
 *
 * Peds do not walk on the road graph — they walk on the footways beside it.
 * This module derives a walkable graph from `CityService` alone, using only
 * the published `SpatialQuery` (`groundHeight` reads KERB_H on a footway and
 * 0 on a carriageway; `isBlocked` reads true inside a building). That means it
 * survives the city agent re-planning street widths, districts or landmarks
 * without a single edit here.
 *
 * Topology
 * --------
 *   corner node   one per (junction, quadrant) — the four kerb corners of a
 *                 crossroads, inset onto the footway.
 *   walk edge     the footway run down one side of one street segment. Two per
 *                 segment (one per block it serves).
 *   cross edge    a zebra hop over one carriageway at a junction. Peds must
 *                 wait at the kerb and check for traffic before taking one.
 *
 * A 26x26 block city yields ~2900 corners and ~5600 edges, built in a few ms.
 */

import * as THREE from 'three';
import { WorldScale } from '../../artDirection';
import type { Rng } from '../../core/rng';
import type { CityService, SpatialQuery } from '../../core/services';

const { blockSize, gridBlocks } = WorldScale;
const HALF = (gridBlocks * blockSize) / 2;
/** Junction grid is (gridBlocks + 1) squared. */
const N = gridBlocks + 1;

/** groundHeight returns the kerb top on a footway; anything above this is pavement. */
const PAVEMENT_Y = 0.08;

export const enum EdgeKind {
  Walk = 0,
  Cross = 1,
}

export interface PavNode {
  id: number;
  x: number;
  z: number;
  /** Junction grid coordinates this corner belongs to. */
  gi: number;
  gj: number;
  /** Quadrant, -1 or +1 on each axis. */
  sx: number;
  sz: number;
  edges: number[];
}

export interface PavEdge {
  id: number;
  a: number;
  b: number;
  kind: EdgeKind;
  length: number;
  /** Unit vector a -> b. */
  ux: number;
  uz: number;
  /** How far a ped may drift either side of the centreline. */
  halfWidth: number;
  /** Crossings only: half-width of the carriageway being crossed. */
  roadHalf: number;
}

/** A place a ped can loiter: a footway spot that is not on a walking line. */
export interface Anchor {
  x: number;
  z: number;
  /** Facing, radians (0 = +Z). Usually toward the building line or the street. */
  yaw: number;
  kind: 'shopfront' | 'kerb' | 'corner' | 'plaza';
  /** Nearest walk edge, for despawn/route hookup. */
  edge: number;
}

function nodeX(i: number): number {
  return -HALF + i * blockSize;
}
function nodeZ(j: number): number {
  return -HALF + j * blockSize;
}

export class PavementGraph {
  readonly nodes: PavNode[] = [];
  readonly edges: PavEdge[] = [];
  readonly anchors: Anchor[] = [];

  /** roadHalfX[i] = half-width of the N–S street on grid column i. */
  private roadHalfX = new Float32Array(N).fill(8);
  /** roadHalfZ[j] = half-width of the E–W street on grid row j. */
  private roadHalfZ = new Float32Array(N).fill(8);
  private walkInsetX = new Float32Array(N).fill(2.0);
  private walkInsetZ = new Float32Array(N).fill(2.0);

  /** corner[(i*N + j)*4 + q] -> node id, or -1. q = (sx>0?1:0)*2 + (sz>0?1:0). */
  private corner = new Int32Array(N * N * 4).fill(-1);

  /** Spatial hash of nodes, cell = blockSize. */
  private hash = new Map<number, number[]>();
  private static readonly CELL = 46;

  /** Edges keyed by cell, so spawning can find a nearby footway fast. */
  private edgeHash = new Map<number, number[]>();
  /** Loiter anchors keyed by cell. */
  private anchorHash = new Map<number, number[]>();

  build(city: CityService, rng: Rng): void {
    const sp = city.spatial;
    this.measureStreets(city, sp);
    this.buildCorners(sp);
    this.buildEdges(city, sp);
    this.buildAnchors(sp, rng);
    this.buildHashes();
  }

  /* ---------------------------------------------------------------- */
  /* street metrics, probed rather than assumed                        */
  /* ---------------------------------------------------------------- */

  /**
   * Walk out perpendicular from a point on a carriageway until the ground
   * steps up onto a kerb; that offset is the road half-width. Keep walking
   * until the ground is blocked by a building; that span is the footway.
   */
  private probeSide(
    sp: SpatialQuery,
    px: number,
    pz: number,
    dx: number,
    dz: number,
  ): { kerb: number; walk: number } | null {
    let kerb = -1;
    for (let o = 1.5; o < 34; o += 0.35) {
      if (sp.groundHeight(px + dx * o, pz + dz * o) > PAVEMENT_Y) {
        kerb = o;
        break;
      }
    }
    if (kerb < 0) return null;
    let walk = 1.6;
    for (let o = kerb + 0.4; o < kerb + 13; o += 0.4) {
      const x = px + dx * o;
      const z = pz + dz * o;
      if (sp.isBlocked(x, z) || sp.groundHeight(x, z) <= PAVEMENT_Y) break;
      walk = o - kerb;
    }
    return { kerb, walk };
  }

  private measureStreets(city: CityService, sp: SpatialQuery): void {
    const linked = this.linkMap(city);

    // Columns: probe across a live vertical segment on this column.
    for (let i = 0; i < N; i++) {
      const acc: number[] = [];
      const walks: number[] = [];
      for (let j = 0; j < N - 1 && acc.length < 5; j++) {
        if (!linked.has(key2(i, j, i, j + 1))) continue;
        const px = nodeX(i);
        const pz = nodeZ(j) + blockSize * 0.5;
        for (const s of [1, -1]) {
          const r = this.probeSide(sp, px, pz, s, 0);
          if (r) {
            acc.push(r.kerb);
            walks.push(r.walk);
          }
        }
      }
      if (acc.length) {
        this.roadHalfX[i] = median(acc);
        this.walkInsetX[i] = clamp(median(walks) * 0.45, 1.3, 3.4);
      }
    }

    // Rows.
    for (let j = 0; j < N; j++) {
      const acc: number[] = [];
      const walks: number[] = [];
      for (let i = 0; i < N - 1 && acc.length < 5; i++) {
        if (!linked.has(key2(i, j, i + 1, j))) continue;
        const px = nodeX(i) + blockSize * 0.5;
        const pz = nodeZ(j);
        for (const s of [1, -1]) {
          const r = this.probeSide(sp, px, pz, 0, s);
          if (r) {
            acc.push(r.kerb);
            walks.push(r.walk);
          }
        }
      }
      if (acc.length) {
        this.roadHalfZ[j] = median(acc);
        this.walkInsetZ[j] = clamp(median(walks) * 0.45, 1.3, 3.4);
      }
    }
  }

  /** Set of "i,j -> i,j" segment keys that actually exist in the road graph. */
  private linked = new Set<number>();

  private linkMap(city: CityService): Set<number> {
    const set = new Set<number>();
    const grid = new Map<number, number>();
    for (const n of city.roadNodes) {
      const i = Math.round((n.position.x + HALF) / blockSize);
      const j = Math.round((n.position.z + HALF) / blockSize);
      grid.set(n.id, i * 1000 + j);
    }
    for (const n of city.roadNodes) {
      const a = grid.get(n.id);
      if (a === undefined) continue;
      const ai = Math.floor(a / 1000);
      const aj = a % 1000;
      for (const l of n.links) {
        const b = grid.get(l);
        if (b === undefined) continue;
        const bi = Math.floor(b / 1000);
        const bj = b % 1000;
        set.add(key2(ai, aj, bi, bj));
        set.add(key2(bi, bj, ai, aj));
      }
    }
    this.linked = set;
    return set;
  }

  private hasStreetAlongZ(i: number, j: number): boolean {
    return this.linked.has(key2(i, j, i, j + 1)) || this.linked.has(key2(i, j, i, j - 1));
  }
  private hasStreetAlongX(i: number, j: number): boolean {
    return this.linked.has(key2(i, j, i + 1, j)) || this.linked.has(key2(i, j, i - 1, j));
  }

  /* ---------------------------------------------------------------- */
  /* corners                                                           */
  /* ---------------------------------------------------------------- */

  private buildCorners(sp: SpatialQuery): void {
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        if (!this.hasStreetAlongX(i, j) && !this.hasStreetAlongZ(i, j)) continue;
        const bx = nodeX(i);
        const bz = nodeZ(j);
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const insetBase = Math.max(this.walkInsetX[i], this.walkInsetZ[j]);
            let placed = -1;
            for (const extra of [0, 0.9, 1.9, 3.0]) {
              const x = bx + sx * (this.roadHalfX[i] + insetBase + extra);
              const z = bz + sz * (this.roadHalfZ[j] + insetBase + extra);
              if (sp.groundHeight(x, z) <= PAVEMENT_Y) continue;
              if (sp.isBlocked(x, z)) continue;
              this.nodes.push({
                id: this.nodes.length,
                x,
                z,
                gi: i,
                gj: j,
                sx,
                sz,
                edges: [],
              });
              placed = this.nodes.length - 1;
              break;
            }
            if (placed >= 0) {
              this.corner[((i * N + j) * 4) + quad(sx, sz)] = placed;
            }
          }
        }
      }
    }
  }

  private cornerId(i: number, j: number, sx: number, sz: number): number {
    if (i < 0 || j < 0 || i >= N || j >= N) return -1;
    return this.corner[((i * N + j) * 4) + quad(sx, sz)];
  }

  /* ---------------------------------------------------------------- */
  /* edges                                                             */
  /* ---------------------------------------------------------------- */

  private addEdge(a: number, b: number, kind: EdgeKind, halfWidth: number, roadHalf: number): void {
    if (a < 0 || b < 0 || a === b) return;
    const na = this.nodes[a];
    const nb = this.nodes[b];
    const dx = nb.x - na.x;
    const dz = nb.z - na.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const id = this.edges.length;
    this.edges.push({
      id,
      a,
      b,
      kind,
      length: len,
      ux: dx / len,
      uz: dz / len,
      halfWidth,
      roadHalf,
    });
    na.edges.push(id);
    nb.edges.push(id);
  }

  /** Reject a run that clips a building — the city grows out over footways. */
  private runIsClear(sp: SpatialQuery, ax: number, az: number, bx: number, bz: number): boolean {
    const steps = 7;
    let bad = 0;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (sp.isBlocked(x, z) || sp.groundHeight(x, z) <= PAVEMENT_Y) bad++;
    }
    return bad <= 1;
  }

  private buildEdges(city: CityService, sp: SpatialQuery): void {
    void city;
    /* ---- footway runs beside each surviving street segment ---- */
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        // Segment east.
        if (i + 1 < N && this.linked.has(key2(i, j, i + 1, j))) {
          for (const sz of [-1, 1]) {
            const a = this.cornerId(i, j, 1, sz);
            const b = this.cornerId(i + 1, j, -1, sz);
            if (a < 0 || b < 0) continue;
            if (!this.runIsClear(sp, this.nodes[a].x, this.nodes[a].z, this.nodes[b].x, this.nodes[b].z)) continue;
            this.addEdge(a, b, EdgeKind.Walk, this.walkInsetZ[j] * 0.72, 0);
          }
        }
        // Segment south.
        if (j + 1 < N && this.linked.has(key2(i, j, i, j + 1))) {
          for (const sx of [-1, 1]) {
            const a = this.cornerId(i, j, sx, 1);
            const b = this.cornerId(i, j + 1, sx, -1);
            if (a < 0 || b < 0) continue;
            if (!this.runIsClear(sp, this.nodes[a].x, this.nodes[a].z, this.nodes[b].x, this.nodes[b].z)) continue;
            this.addEdge(a, b, EdgeKind.Walk, this.walkInsetX[i] * 0.72, 0);
          }
        }
      }
    }

    /* ---- zebra hops across each carriageway ---- */
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        // Crossing the N–S street (travel along X) — needs that street to exist.
        if (this.hasStreetAlongZ(i, j)) {
          for (const sz of [-1, 1]) {
            this.addEdge(
              this.cornerId(i, j, -1, sz),
              this.cornerId(i, j, 1, sz),
              EdgeKind.Cross,
              1.5,
              this.roadHalfX[i],
            );
          }
        }
        // Crossing the E–W street (travel along Z).
        if (this.hasStreetAlongX(i, j)) {
          for (const sx of [-1, 1]) {
            this.addEdge(
              this.cornerId(i, j, sx, -1),
              this.cornerId(i, j, sx, 1),
              EdgeKind.Cross,
              1.5,
              this.roadHalfZ[j],
            );
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* loiter anchors                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Places standing spots off the walking line: against shopfronts (window
   * shopping, vendors), at the kerb (waiting, smoking) and on corners. Idle
   * peds occupy these so the crowd is not a conveyor of walkers.
   */
  private buildAnchors(sp: SpatialQuery, rng: Rng): void {
    for (const e of this.edges) {
      if (e.kind !== EdgeKind.Walk) continue;
      if (e.length < 24) continue;
      const na = this.nodes[e.a];
      const count = e.length > 70 ? 3 : 2;
      for (let k = 0; k < count; k++) {
        if (!rng.bool(0.62)) continue;
        const t = (k + 0.5) / count + rng.range(-0.16, 0.16);
        const cx = na.x + e.ux * e.length * t;
        const cz = na.z + e.uz * e.length * t;
        // Perpendicular: negative side is the building line, positive the kerb
        // (or vice versa) — probe both and keep whichever is walkable.
        const px = -e.uz;
        const pz = e.ux;
        const side = rng.bool() ? 1 : -1;
        for (const s of [side, -side]) {
          const off = e.halfWidth * rng.range(0.75, 1.0) * s;
          const x = cx + px * off;
          const z = cz + pz * off;
          if (sp.isBlocked(x, z) || sp.groundHeight(x, z) <= PAVEMENT_Y) continue;
          // Face the way that has something to look at.
          const buildingSide = sp.isBlocked(cx + px * (e.halfWidth + 2.6) * s, cz + pz * (e.halfWidth + 2.6) * s);
          const yaw = buildingSide
            ? Math.atan2(px * s, pz * s)
            : Math.atan2(-px * s, -pz * s);
          this.anchors.push({
            x,
            z,
            yaw,
            kind: buildingSide ? 'shopfront' : 'kerb',
            edge: e.id,
          });
          break;
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* spatial lookup                                                    */
  /* ---------------------------------------------------------------- */

  private buildHashes(): void {
    const c = PavementGraph.CELL;
    for (const n of this.nodes) {
      const k = cellKey(Math.floor(n.x / c), Math.floor(n.z / c));
      let list = this.hash.get(k);
      if (!list) this.hash.set(k, (list = []));
      list.push(n.id);
    }
    for (const e of this.edges) {
      if (e.kind !== EdgeKind.Walk) continue;
      const na = this.nodes[e.a];
      const nb = this.nodes[e.b];
      const steps = Math.max(1, Math.ceil(e.length / c));
      const seen = new Set<number>();
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const k = cellKey(
          Math.floor((na.x + (nb.x - na.x) * t) / c),
          Math.floor((na.z + (nb.z - na.z) * t) / c),
        );
        if (seen.has(k)) continue;
        seen.add(k);
        let list = this.edgeHash.get(k);
        if (!list) this.edgeHash.set(k, (list = []));
        list.push(e.id);
      }
    }
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
      const k = cellKey(Math.floor(a.x / c), Math.floor(a.z / c));
      let list = this.anchorHash.get(k);
      if (!list) this.anchorHash.set(k, (list = []));
      list.push(i);
    }
  }

  /**
   * Loiter anchors near a point. Sampling the global anchor list at random
   * finds nothing: there are three thousand of them spread over 2.4 km, so the
   * chance that any of a handful of random picks lands within twenty metres is
   * effectively zero, and every idle behaviour silently never fires.
   */
  anchorsNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const c = PavementGraph.CELL;
    const i0 = Math.floor((x - radius) / c);
    const i1 = Math.floor((x + radius) / c);
    const j0 = Math.floor((z - radius) / c);
    const j1 = Math.floor((z + radius) / c);
    const r2 = radius * radius;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.anchorHash.get(cellKey(i, j));
        if (!list) continue;
        for (const id of list) {
          const a = this.anchors[id];
          if ((a.x - x) ** 2 + (a.z - z) ** 2 <= r2) out.push(id);
        }
      }
    }
    return out;
  }

  /** Walk edges whose footprint touches the cells around (x, z). */
  edgesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const c = PavementGraph.CELL;
    const i0 = Math.floor((x - radius) / c);
    const i1 = Math.floor((x + radius) / c);
    const j0 = Math.floor((z - radius) / c);
    const j1 = Math.floor((z + radius) / c);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.edgeHash.get(cellKey(i, j));
        if (!list) continue;
        for (const id of list) out.push(id);
      }
    }
    return out;
  }

  nearestNode(x: number, z: number): number {
    const c = PavementGraph.CELL;
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 2 && best < 0; r++) {
      const i0 = Math.floor(x / c) - r;
      const j0 = Math.floor(z / c) - r;
      for (let i = i0; i <= i0 + r * 2; i++) {
        for (let j = j0; j <= j0 + r * 2; j++) {
          const list = this.hash.get(cellKey(i, j));
          if (!list) continue;
          for (const id of list) {
            const n = this.nodes[id];
            const d = (n.x - x) ** 2 + (n.z - z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = id;
            }
          }
        }
      }
    }
    return best;
  }

  pointOnEdge(edge: PavEdge, t: number, lateral: number, out: THREE.Vector3): void {
    const na = this.nodes[edge.a];
    const d = t * edge.length;
    out.set(
      na.x + edge.ux * d - edge.uz * lateral,
      0,
      na.z + edge.uz * d + edge.ux * lateral,
    );
  }

  other(edge: PavEdge, node: number): number {
    return edge.a === node ? edge.b : edge.a;
  }

  /**
   * Wander: pick the next edge out of `node`, biased to keep going the same
   * way and to stay off the road. Returns -1 at a dead end.
   */
  nextEdge(node: number, fromEdge: number, hx: number, hz: number, rng: Rng): number {
    const n = this.nodes[node];
    if (!n || n.edges.length === 0) return -1;
    let total = 0;
    const weights: number[] = [];
    for (const id of n.edges) {
      const e = this.edges[id];
      const sign = e.a === node ? 1 : -1;
      const dot = (e.ux * sign) * hx + (e.uz * sign) * hz;
      let w = 0.16 + Math.max(0, dot) ** 2 * 2.4;
      if (e.kind === EdgeKind.Cross) w *= 0.22;
      if (id === fromEdge) w *= 0.03;
      weights.push(w);
      total += w;
    }
    let r = rng.next() * total;
    for (let k = 0; k < n.edges.length; k++) {
      r -= weights[k];
      if (r <= 0) return n.edges[k];
    }
    return n.edges[n.edges.length - 1];
  }

  get stats() {
    let walk = 0;
    let cross = 0;
    for (const e of this.edges) (e.kind === EdgeKind.Walk ? walk++ : cross++);
    return { nodes: this.nodes.length, walk, cross, anchors: this.anchors.length };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function quad(sx: number, sz: number): number {
  return (sx > 0 ? 2 : 0) + (sz > 0 ? 1 : 0);
}

function key2(ai: number, aj: number, bi: number, bj: number): number {
  return ((ai * 64 + aj) * 4096) + (bi * 64 + bj);
}

function cellKey(i: number, j: number): number {
  return i * 100003 + j;
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
