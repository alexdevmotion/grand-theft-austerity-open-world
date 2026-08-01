/**
 * Drivable lane network, derived from the CityService road graph.
 *
 * The city publishes its node graph plus the permanent-way centrelines it
 * actually rendered. `CitySystem.lanes` remains a concrete field, not part of
 * the service contract, so this module rebuilds all road-lane geometry and
 * maps rail corridors from the contract alone.
 *
 * Everything here is *derived*, never hardcoded to the city's internals:
 *
 *   lane count of a link  = min(lanes of its two end nodes)
 *   carriageway width     = f(lane count)          — same table the city uses
 *   junction trim         = half the width of the CROSSING street at that node
 *   lane centreline       = link centreline offset to the RIGHT of travel by
 *                           (lane + 0.5) * laneWidth
 *
 * The right-hand offset is what makes București drive on the right; it matches
 * the lane markings the city bakes into the road surface.
 */

import * as THREE from 'three';
import { WorldScale } from '../../artDirection';
import type { CityService } from '../../core/services';

const LANE_W = WorldScale.laneWidth;

/** Carriageway width by lanes-per-direction. Mirrors the city's road grammar. */
const WIDTH_BY_LANES: Record<number, number> = { 1: 16, 2: 26, 3: 42 };

/** Free-flow speed by street rank (lanes-1), metres per second. */
export const RANK_SPEED = [12.5, 16.5, 21.0];

/** Tram track centres sit either side of the reserved central bed. */
export const TRAM_OFFSET = 1.92;

/** Lane index used for a vehicle running on the tram permanent way. */
export const TRAM_LANE = -1;

/**
 * A road centreline may be a few metres away from the surveyed permanent way
 * (dual carriageways are commonly represented that way in OSM). It is only a
 * valid mapping when the rail stays parallel and at a nearly constant lateral
 * offset for the whole drivable part of the edge.
 */
const RAIL_MATCH_RADIUS = 4;
const RAIL_MIN_ALIGNMENT = 0.82;
const RAIL_MAX_WANDER = 0.9;
const RAIL_SAMPLES = [0.12, 0.31, 0.5, 0.69, 0.88] as const;
const RAIL_CLEAR_SAMPLES = [0.08, 0.18, 0.28, 0.38, 0.5, 0.62, 0.72, 0.82, 0.92] as const;
/** Tram body half-width plus a small facade/prop breathing margin. */
const TRAM_SWEEP_HALF_WIDTH = 1.5;
/** Maximum deviation of a join waypoint from a rendered track centre. */
const TRAM_JOIN_TRACK_TOLERANCE = 1.1;
/** Maximum deviation after including the tram body's lateral sweep. */
const TRAM_JOIN_SWEEP_TOLERANCE = 2.6;

interface RailSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ux: number;
  uz: number;
}

export interface LaneEdge {
  /** Index into `TrafficGraph.edges`. */
  readonly index: number;
  readonly from: number;
  readonly to: number;
  /** Unit direction of travel, world XZ. */
  readonly ux: number;
  readonly uz: number;
  /** Right-hand normal of travel (the side lanes are offset toward). */
  readonly rx: number;
  readonly rz: number;
  /** Node-centre to node-centre distance. */
  readonly span: number;
  /** Lanes per direction. */
  readonly lanes: number;
  /** 0 = side street, 1 = boulevard, 2 = the monumental axis. */
  readonly rank: 0 | 1 | 2;
  readonly speed: number;
  /** True when this edge runs mostly along world X. */
  readonly axisX: boolean;
  /** Carriageway entry point (edge of the `from` junction), on the centreline. */
  readonly ex: number;
  readonly ez: number;
  /** Carriageway exit point (edge of the `to` junction), on the centreline. */
  readonly xx: number;
  readonly xz: number;
  /** Drivable length between the two junction mouths. */
  readonly length: number;
  /** Half-width of the crossing street at `from` / `to`. */
  readonly trimFrom: number;
  readonly trimTo: number;
  /** Edge indices leaving `to`, excluding the U-turn back down this edge. */
  readonly next: number[];
  /** The one continuation that goes straight on, if any. */
  straight: number;
  /** True when the reserved tram bed runs down this street. */
  readonly tram: boolean;
  /** Signed shift from the road centre to the rendered rail centre. */
  readonly tramOffset: number;
  /** Straightest verified-rail continuation, never an ordinary road. */
  tramStraight: number;
}

const _tmp = new THREE.Vector3();
const _joinA = new THREE.Vector3();
const _joinB = new THREE.Vector3();
const _joinCorner = new THREE.Vector3();

function railSegments(lines: CityService['tramLines']): RailSegment[] {
  const out: RailSegment[] = [];
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;
      out.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, ux: dx / length, uz: dz / length });
    }
  }
  return out;
}

/** Squared distance to either physical track rendered around a rail centreline. */
function distanceToRailTrackSquared(
  x: number,
  z: number,
  rails: ReadonlyArray<RailSegment>,
): number {
  let best = Infinity;
  for (const rail of rails) {
    const nx = rail.uz;
    const nz = -rail.ux;
    const dx = rail.bx - rail.ax;
    const dz = rail.bz - rail.az;
    const length2 = dx * dx + dz * dz;
    for (const side of [-1, 1]) {
      const ax = rail.ax + nx * side * TRAM_OFFSET;
      const az = rail.az + nz * side * TRAM_OFFSET;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / length2));
      const ex = x - (ax + dx * t);
      const ez = z - (az + dz * t);
      best = Math.min(best, ex * ex + ez * ez);
    }
  }
  return best;
}

/** Signed lateral offset of a verified rail corridor, or null for plain road. */
function matchingRailOffset(
  ax: number, az: number, bx: number, bz: number,
  ux: number, uz: number, rx: number, rz: number,
  rails: ReadonlyArray<RailSegment>,
): number | null {
  if (!rails.length) return null;
  const offsets: number[] = [];
  const maxD2 = RAIL_MATCH_RADIUS * RAIL_MATCH_RADIUS;

  for (const t of RAIL_SAMPLES) {
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    let bestD2 = maxD2;
    let bestOffset: number | null = null;
    for (const rail of rails) {
      if (Math.abs(ux * rail.ux + uz * rail.uz) < RAIL_MIN_ALIGNMENT) continue;
      const dx = rail.bx - rail.ax;
      const dz = rail.bz - rail.az;
      const d2 = dx * dx + dz * dz;
      const q = Math.max(0, Math.min(1, ((px - rail.ax) * dx + (pz - rail.az) * dz) / d2));
      const qx = rail.ax + dx * q;
      const qz = rail.az + dz * q;
      const ex = qx - px;
      const ez = qz - pz;
      const distance2 = ex * ex + ez * ez;
      if (distance2 > bestD2) continue;
      bestD2 = distance2;
      bestOffset = ex * rx + ez * rz;
    }
    if (bestOffset === null) return null;
    offsets.push(bestOffset);
  }

  const centre = offsets.reduce((sum, n) => sum + n, 0) / offsets.length;
  if (offsets.some((n) => Math.abs(n - centre) > RAIL_MAX_WANDER)) return null;
  return centre;
}

/** Both directional tracks and the body swept around them must be open world. */
function tramCorridorIsClear(
  city: CityService,
  ax: number, az: number, bx: number, bz: number,
  rx: number, rz: number,
  railOffset: number,
): boolean {
  for (const t of RAIL_CLEAR_SAMPLES) {
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    for (const track of [-TRAM_OFFSET, TRAM_OFFSET]) {
      for (const sweep of [-TRAM_SWEEP_HALF_WIDTH, 0, TRAM_SWEEP_HALF_WIDTH]) {
        const offset = railOffset + track + sweep;
        if (city.spatial.isBlocked(px + rx * offset, pz + rz * offset)) return false;
      }
    }
  }
  return true;
}

export interface LaneSpawnRange {
  min: number;
  max: number;
}

/**
 * Spawn with the complete body on this edge. Long buses and trams must not be
 * born with their nose already through a junction, facade or unverified rail.
 */
export function laneSpawnRange(edge: LaneEdge, halfLength: number): LaneSpawnRange | null {
  const clear = Math.max(0, halfLength) + 2;
  if (edge.length <= clear * 2) return null;
  const min = Math.max(0.1, clear / edge.length);
  const max = Math.min(0.9, 1 - clear / edge.length);
  return min < max ? { min, max } : null;
}

export class TrafficGraph {
  readonly edges: LaneEdge[] = [];
  /** Edge indices leaving each node. */
  readonly outOf: number[][] = [];
  /** Half-width of the widest street meeting each node (its junction radius). */
  readonly junctionRadius: number[] = [];
  readonly nodePos: THREE.Vector3[] = [];

  /** Coarse spatial index of edges, for spawn sampling. */
  private cell = 110;
  private grid = new Map<number, number[]>();
  /** from*STRIDE+to -> edge index. */
  private byPair = new Map<number, number>();
  private static readonly STRIDE = 1 << 16;

  constructor(city: CityService) {
    const nodes = city.roadNodes;
    const rails = railSegments(city.tramLines);
    for (const n of nodes) {
      this.outOf.push([]);
      this.junctionRadius.push(8);
      this.nodePos.push(n.position);
    }

    // Pass 1: widths of every street meeting every node, so junction mouths can
    // be trimmed by the CROSSING street rather than by this one.
    const widthAt: Array<{ x: number; z: number }> = nodes.map(() => ({ x: 0, z: 0 }));
    for (let a = 0; a < nodes.length; a++) {
      for (const b of nodes[a].links) {
        const nb = nodes[b];
        if (!nb) continue;
        const lanes = Math.max(1, Math.min(3, Math.min(nodes[a].lanes, nb.lanes)));
        const w = WIDTH_BY_LANES[lanes] ?? 16;
        const dx = nb.position.x - nodes[a].position.x;
        const dz = nb.position.z - nodes[a].position.z;
        const axisX = Math.abs(dx) >= Math.abs(dz);
        for (const id of [a, b]) {
          const rec = widthAt[id];
          if (axisX) rec.x = Math.max(rec.x, w);
          else rec.z = Math.max(rec.z, w);
        }
      }
    }
    for (let a = 0; a < nodes.length; a++) {
      this.junctionRadius[a] = Math.max(8, Math.max(widthAt[a].x, widthAt[a].z) / 2);
    }

    // Pass 2: directed edges.
    for (let a = 0; a < nodes.length; a++) {
      for (const b of nodes[a].links) {
        const na = nodes[a];
        const nb = nodes[b];
        if (!nb) continue;
        const dx = nb.position.x - na.position.x;
        const dz = nb.position.z - na.position.z;
        const span = Math.hypot(dx, dz);
        if (span < 1e-3) continue;
        const ux = dx / span;
        const uz = dz / span;
        const axisX = Math.abs(dx) >= Math.abs(dz);
        const lanes = Math.max(1, Math.min(3, Math.min(na.lanes, nb.lanes)));
        const rank = (lanes - 1) as 0 | 1 | 2;
        // Trim by the width of the street that CROSSES at each end.
        const trimFrom = (axisX ? widthAt[a].z : widthAt[a].x) / 2 || WIDTH_BY_LANES[lanes] / 2;
        const trimTo = (axisX ? widthAt[b].z : widthAt[b].x) / 2 || WIDTH_BY_LANES[lanes] / 2;
        const length = Math.max(2, span - trimFrom - trimTo);
        const ex = na.position.x + ux * trimFrom;
        const ez = na.position.z + uz * trimFrom;
        const xx = nb.position.x - ux * trimTo;
        const xz = nb.position.z - uz * trimTo;
        const matchedRail = matchingRailOffset(ex, ez, xx, xz, ux, uz, uz, -ux, rails);
        const tramOffset = matchedRail !== null && tramCorridorIsClear(
          city, ex, ez, xx, xz, uz, -ux, matchedRail,
        ) ? matchedRail : null;
        const index = this.edges.length;
        const edge: LaneEdge = {
          index, from: a, to: b,
          ux, uz,
          rx: uz, rz: -ux,
          span, lanes, rank,
          speed: RANK_SPEED[rank],
          axisX,
          ex, ez, xx, xz,
          length, trimFrom, trimTo,
          next: [],
          straight: -1,
          tram: tramOffset !== null,
          tramOffset: tramOffset ?? 0,
          tramStraight: -1,
        };
        this.edges.push(edge);
        this.outOf[a].push(index);
        this.byPair.set(a * TrafficGraph.STRIDE + b, index);
      }
    }

    // Pass 3: continuations.
    for (const e of this.edges) {
      let bestDot = -2;
      let bestTramDot = -2;
      for (const nIdx of this.outOf[e.to]) {
        const n = this.edges[nIdx];
        if (n.to === e.from) continue; // never plan a U-turn
        e.next.push(nIdx);
        const dot = n.ux * e.ux + n.uz * e.uz;
        if (dot > bestDot) { bestDot = dot; e.straight = nIdx; }
        if (e.tram && n.tram && dot > bestTramDot && this.tramJoinIsClear(city, rails, e, n)) {
          bestTramDot = dot;
          e.tramStraight = nIdx;
        }
      }
      if (bestDot < 0.7) e.straight = -1;
      if (bestTramDot < 0.7) e.tramStraight = -1;
    }

    // Pass 4: spatial index for spawn sampling.
    for (const e of this.edges) {
      const steps = Math.max(1, Math.ceil(e.length / this.cell));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = e.ex + (e.xx - e.ex) * t;
        const z = e.ez + (e.xz - e.ez) * t;
        const key = this.key(x, z);
        let list = this.grid.get(key);
        if (!list) this.grid.set(key, (list = []));
        if (list[list.length - 1] !== e.index) list.push(e.index);
      }
    }
  }

  private key(x: number, z: number): number {
    return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
  }

  edgeBetween(from: number, to: number): number {
    return this.byPair.get(from * TrafficGraph.STRIDE + to) ?? -1;
  }

  /**
   * Every edge whose polyline passes within roughly `radius` of (x, z).
   *
   * De-duplicated with a version stamp rather than `Array.includes` — this runs
   * several times a second over a few hundred candidates, and the quadratic
   * version showed up in the profile.
   */
  edgesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    if (this.stamp.length !== this.edges.length) this.stamp = new Uint32Array(this.edges.length);
    this.stampVersion++;
    const v = this.stampVersion;
    const r = Math.ceil(radius / this.cell);
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(z / this.cell);
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const list = this.grid.get(i * 100003 + j);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const e = list[k];
          if (this.stamp[e] === v) continue;
          this.stamp[e] = v;
          out.push(e);
        }
      }
    }
    return out;
  }

  private stamp = new Uint32Array(0);
  private stampVersion = 0;

  /**
   * Lateral offset of a lane centre from the carriageway centreline.
   *
   * On a street with a tram the central reserve is not drivable, so the running
   * lanes are pushed outboard past it — otherwise the inside lane sits exactly
   * on the permanent way and every tram ploughs through the traffic beside it.
   */
  laneOffset(edge: LaneEdge, lane: number): number {
    if (lane === TRAM_LANE) return edge.tramOffset + TRAM_OFFSET;
    const base = (Math.min(lane, edge.lanes - 1) + 0.5) * LANE_W;
    return edge.tram ? base + TRAM_OFFSET + 2.6 + Math.max(0, edge.tramOffset) : base;
  }

  /** World point at parameter `t` (0..1) along a lane. */
  lanePoint(edge: LaneEdge, lane: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    const off = this.laneOffset(edge, lane);
    const x = edge.ex + (edge.xx - edge.ex) * t + edge.rx * off;
    const z = edge.ez + (edge.xz - edge.ez) * t + edge.rz * off;
    return out.set(x, 0, z);
  }

  laneEntry(edge: LaneEdge, lane: number, out: THREE.Vector3): THREE.Vector3 {
    return this.lanePoint(edge, lane, 0, out);
  }

  laneExit(edge: LaneEdge, lane: number, out: THREE.Vector3): THREE.Vector3 {
    return this.lanePoint(edge, lane, 1, out);
  }

  /**
   * Rounded corner point between the exit of `a` and the entry of `b`.
   *
   * Two lane lines crossing a junction meet at their mathematical intersection;
   * driving straight to it would clip the kerb, so the point is pulled back
   * toward the chord. What comes out is a believable racing line through the
   * junction without any spline machinery.
   */
  cornerPoint(a: LaneEdge, aLane: number, b: LaneEdge, bLane: number, out: THREE.Vector3): THREE.Vector3 {
    this.laneExit(a, aLane, _tmp);
    const px = _tmp.x;
    const pz = _tmp.z;
    this.laneEntry(b, bLane, out);
    const qx = out.x;
    const qz = out.z;
    // Solve  P + s*A = Q - t*B   =>   s*A + t*B = Q - P.
    // Degenerate (parallel) when the link carries straight on.
    const d = a.ux * b.uz - a.uz * b.ux;
    if (Math.abs(d) < 0.08) {
      return out.set((px + qx) * 0.5, 0, (pz + qz) * 0.5);
    }
    const rx = qx - px;
    const rz = qz - pz;
    const s = (rx * b.uz - rz * b.ux) / d;
    const ix = px + a.ux * s;
    const iz = pz + a.uz * s;
    // 45% of the way from the geometric corner to the chord midpoint.
    const mx = (px + qx) * 0.5;
    const mz = (pz + qz) * 0.5;
    return out.set(ix + (mx - ix) * 0.45, 0, iz + (mz - iz) * 0.45);
  }

  /** Turn severity between two consecutive edges, radians (0 = straight on). */
  turnAngle(a: LaneEdge, b: LaneEdge): number {
    const dot = Math.max(-1, Math.min(1, a.ux * b.ux + a.uz * b.uz));
    return Math.acos(dot);
  }

  /** The whole waypoint bridge must stay on rendered permanent way and clear buildings. */
  private tramJoinIsClear(
    city: CityService,
    rails: ReadonlyArray<RailSegment>,
    a: LaneEdge,
    b: LaneEdge,
  ): boolean {
    this.laneExit(a, TRAM_LANE, _joinA);
    this.laneEntry(b, TRAM_LANE, _joinB);
    if (_joinA.distanceTo(_joinB) >= 60) return false;
    this.cornerPoint(a, TRAM_LANE, b, TRAM_LANE, _joinCorner);
    for (const [p, q] of [[_joinA, _joinCorner], [_joinCorner, _joinB]] as const) {
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      const rx = dz / length;
      const rz = -dx / length;
      const steps = Math.max(1, Math.ceil(length));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        const x = p.x + dx * t;
        const z = p.z + dz * t;
        if (distanceToRailTrackSquared(x, z, rails) > TRAM_JOIN_TRACK_TOLERANCE ** 2) {
          return false;
        }
        for (const sweep of [-TRAM_SWEEP_HALF_WIDTH, TRAM_SWEEP_HALF_WIDTH]) {
          const sx = x + rx * sweep;
          const sz = z + rz * sweep;
          if (distanceToRailTrackSquared(sx, sz, rails) > TRAM_JOIN_SWEEP_TOLERANCE ** 2) {
            return false;
          }
        }
        for (const sweep of [-TRAM_SWEEP_HALF_WIDTH, 0, TRAM_SWEEP_HALF_WIDTH]) {
          if (city.spatial.isBlocked(x + rx * sweep, z + rz * sweep)) return false;
        }
      }
    }
    return true;
  }

  /** Distance from a node centre at which a vehicle must have stopped. */
  stopLine(edge: LaneEdge): number {
    return edge.trimTo + 1.4;
  }

  /**
   * Best (edge, lane) for a vehicle that has ended up somewhere unexpected —
   * shunted through a junction, flipped, or teleported by the vehicle system's
   * stuck rescue. Scored on lateral distance to the lane centre plus how well
   * the lane agrees with the direction the vehicle is already pointing, so a
   * re-anchored car does not immediately try to drive the wrong way.
   */
  nearestLane(
    x: number, z: number, heading: number, scratch: number[],
  ): { edge: number; lane: number } | null {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const cands = this.edgesNear(x, z, 90, scratch);
    let best: { edge: number; lane: number } | null = null;
    let bestScore = Infinity;
    for (const ei of cands) {
      const e = this.edges[ei];
      const align = e.ux * fx + e.uz * fz;
      if (align < -0.2) continue;
      const along = (x - e.ex) * e.ux + (z - e.ez) * e.uz;
      if (along < -14 || along > e.length + 14) continue;
      for (let l = 0; l < e.lanes; l++) {
        const off = this.laneOffset(e, l);
        const lx = e.ex + e.rx * off;
        const lz = e.ez + e.rz * off;
        const lat = Math.abs((x - lx) * e.rx + (z - lz) * e.rz);
        const score = lat + (1 - align) * 14;
        if (score < bestScore) { bestScore = score; best = { edge: ei, lane: l }; }
      }
    }
    return bestScore < 60 ? best : null;
  }

  /**
   * Rail-only recovery for a tram displaced by a collision or physics rescue.
   * Falling back to `nearestLane` here would put a derailed tram onto whichever
   * ordinary road happened to be closer, recreating the original defect.
   */
  nearestTramLane(
    x: number, z: number, heading: number, scratch: number[],
  ): { edge: number; lane: typeof TRAM_LANE } | null {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    const cands = this.edgesNear(x, z, 90, scratch);
    let best: { edge: number; lane: typeof TRAM_LANE } | null = null;
    let bestScore = Infinity;
    for (const ei of cands) {
      const e = this.edges[ei];
      if (!e.tram) continue;
      const align = e.ux * fx + e.uz * fz;
      if (align < -0.2) continue;
      const along = (x - e.ex) * e.ux + (z - e.ez) * e.uz;
      if (along < -14 || along > e.length + 14) continue;
      const off = this.laneOffset(e, TRAM_LANE);
      const lx = e.ex + e.rx * off;
      const lz = e.ez + e.rz * off;
      const lat = Math.abs((x - lx) * e.rx + (z - lz) * e.rz);
      const score = lat + (1 - align) * 14;
      if (score < bestScore) {
        bestScore = score;
        best = { edge: ei, lane: TRAM_LANE };
      }
    }
    return bestScore < 60 ? best : null;
  }
}
