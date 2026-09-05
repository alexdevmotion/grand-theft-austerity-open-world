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
export const TRAM_OFFSET = 1.435 / 2 + 1.2;

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
const RAIL_SAMPLES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;
const RAIL_CLEAR_SAMPLES = [0.08, 0.18, 0.28, 0.38, 0.5, 0.62, 0.72, 0.82, 0.92] as const;
/** Tram body half-width plus a small facade/prop breathing margin. */
const TRAM_SWEEP_HALF_WIDTH = 1.5;
/** Search tolerance while projecting a proposed junction bridge onto steel. */
const TRAM_JOIN_TRACK_TOLERANCE = 1.1;
/** Every resulting chord must remain on visibly continuous rendered steel. */
const TRAM_JOIN_CONTINUITY_TOLERANCE = 0.2;
/** Track following may interpolate a surveyed bend, but never cut across it. */
const TRAM_MIN_TANGENT_ALIGNMENT = Math.cos(THREE.MathUtils.degToRad(5));
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

/** Centre of one physical directional track, including bend connectors. */
type TrackSegment = RailSegment;

export interface TramPathPoint {
  /** Parameter on the road edge, used only to interpolate between rail probes. */
  readonly t: number;
  /** Exact centre of the selected rendered track. */
  readonly x: number;
  readonly z: number;
  /** Rail tangent oriented in this directed edge's direction of travel. */
  readonly ux: number;
  readonly uz: number;
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
  /** Exact sampled centreline of the selected physical track. */
  readonly tramPath: ReadonlyArray<TramPathPoint> | null;
  /** Straightest verified-rail continuation, never an ordinary road. */
  tramStraight: number;
  /** Exact physical-track bridge to `tramStraight`, including both mouths. */
  tramJoinPath: ReadonlyArray<TramPathPoint> | null;
}

const _tmp = new THREE.Vector3();
const _joinA = new THREE.Vector3();
const _joinB = new THREE.Vector3();
const _joinCorner = new THREE.Vector3();
const _nearest = new THREE.Vector3();

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

function renderedTrackSegments(lines: CityService['tramLines']): TrackSegment[] {
  const out: TrackSegment[] = [];
  for (const line of lines) {
    const runs: RailSegment[] = [];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;
      runs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, ux: dx / length, uz: dz / length });
    }
    for (const run of runs) {
      for (const side of [-1, 1]) {
        out.push({
          ax: run.ax + run.uz * side * TRAM_OFFSET,
          az: run.az - run.ux * side * TRAM_OFFSET,
          bx: run.bx + run.uz * side * TRAM_OFFSET,
          bz: run.bz - run.ux * side * TRAM_OFFSET,
          ux: run.ux,
          uz: run.uz,
        });
      }
    }
    // Offset straight runs do not meet at a bend. `roads.ts` renders this same
    // chord as steel, so traffic has a continuous physical track to follow.
    for (let i = 0; i + 1 < runs.length; i++) {
      const a = runs[i];
      const b = runs[i + 1];
      for (const side of [-1, 1]) {
        const ax = a.bx + a.uz * side * TRAM_OFFSET;
        const az = a.bz - a.ux * side * TRAM_OFFSET;
        const bx = b.ax + b.uz * side * TRAM_OFFSET;
        const bz = b.az - b.ux * side * TRAM_OFFSET;
        const dx = bx - ax;
        const dz = bz - az;
        const length = Math.hypot(dx, dz);
        if (length < 0.02) continue;
        out.push({ ax, az, bx, bz, ux: dx / length, uz: dz / length });
      }
    }
  }
  return out;
}

/** Squared distance to either physical track rendered around a rail centreline. */
function distanceToRailTrackSquared(
  x: number,
  z: number,
  tracks: ReadonlyArray<TrackSegment>,
): number {
  let best = Infinity;
  for (const track of tracks) {
    const dx = track.bx - track.ax;
    const dz = track.bz - track.az;
    const length2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - track.ax) * dx + (z - track.az) * dz) / length2));
    const ex = x - (track.ax + dx * t);
    const ez = z - (track.az + dz * t);
    best = Math.min(best, ex * ex + ez * ez);
  }
  return best;
}

/** True when a rendered track supports both this position and this heading. */
function trackSupportsPose(
  x: number,
  z: number,
  ux: number,
  uz: number,
  tracks: ReadonlyArray<TrackSegment>,
): boolean {
  const tolerance2 = TRAM_JOIN_CONTINUITY_TOLERANCE ** 2;
  for (const track of tracks) {
    if (Math.abs(ux * track.ux + uz * track.uz) < TRAM_MIN_TANGENT_ALIGNMENT) continue;
    const dx = track.bx - track.ax;
    const dz = track.bz - track.az;
    const length2 = dx * dx + dz * dz;
    const t = THREE.MathUtils.clamp(((x - track.ax) * dx + (z - track.az) * dz) / length2, 0, 1);
    const ex = x - (track.ax + dx * t);
    const ez = z - (track.az + dz * t);
    if (ex * ex + ez * ez <= tolerance2) return true;
  }
  return false;
}

function nearestRailTrack(
  x: number,
  z: number,
  desiredUx: number,
  desiredUz: number,
  tracks: ReadonlyArray<TrackSegment>,
): { x: number; z: number; ux: number; uz: number; distance2: number } | null {
  let best: { x: number; z: number; ux: number; uz: number; distance2: number } | null = null;
  for (const track of tracks) {
    const alignment = track.ux * desiredUx + track.uz * desiredUz;
    if (Math.abs(alignment) < 0.55) continue;
    const direction = alignment >= 0 ? 1 : -1;
    const dx = track.bx - track.ax;
    const dz = track.bz - track.az;
    const length2 = dx * dx + dz * dz;
    const t = THREE.MathUtils.clamp(((x - track.ax) * dx + (z - track.az) * dz) / length2, 0, 1);
    const qx = track.ax + dx * t;
    const qz = track.az + dz * t;
    const distance2 = (x - qx) ** 2 + (z - qz) ** 2;
    if (!best || distance2 < best.distance2) {
      best = {
        x: qx,
        z: qz,
        ux: track.ux * direction,
        uz: track.uz * direction,
        distance2,
      };
    }
  }
  return best;
}

/** Exact selected physical track through a verified rail corridor. */
function matchingTramPath(
  ax: number, az: number, bx: number, bz: number,
  ux: number, uz: number, rx: number, rz: number,
  rails: ReadonlyArray<RailSegment>,
): { offset: number; path: TramPathPoint[] } | null {
  if (!rails.length) return null;
  const offsets: number[] = [];
  const path: TramPathPoint[] = [];
  const maxD2 = RAIL_MATCH_RADIUS * RAIL_MATCH_RADIUS;

  for (const t of RAIL_SAMPLES) {
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    let bestD2 = maxD2;
    let bestOffset: number | null = null;
    let bestRail: RailSegment | null = null;
    let bestX = 0;
    let bestZ = 0;
    for (const rail of rails) {
      const alignment = ux * rail.ux + uz * rail.uz;
      if (Math.abs(alignment) < RAIL_MIN_ALIGNMENT) continue;
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
      bestRail = rail;
      bestX = qx;
      bestZ = qz;
    }
    if (bestOffset === null || bestRail === null) return null;
    offsets.push(bestOffset);
    // `railSegments` inherits each OSM way's arbitrary source direction. Pick
    // the physical side whose normal is to the RIGHT of this directed traffic
    // edge, then orient the tangent the same way as travel.
    const direction = ux * bestRail.ux + uz * bestRail.uz >= 0 ? 1 : -1;
    path.push({
      t,
      x: bestX - bestRail.uz * direction * TRAM_OFFSET,
      z: bestZ + bestRail.ux * direction * TRAM_OFFSET,
      ux: bestRail.ux * direction,
      uz: bestRail.uz * direction,
    });
  }

  const centre = offsets.reduce((sum, n) => sum + n, 0) / offsets.length;
  if (offsets.some((n) => Math.abs(n - centre) > RAIL_MAX_WANDER)) return null;
  return { offset: centre, path };
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

/** Every driven chord must remain on steel and clear for the complete body. */
function tramPathIsClear(
  city: CityService,
  tracks: ReadonlyArray<TrackSegment>,
  path: ReadonlyArray<TramPathPoint>,
): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const rx = dz / length;
    const rz = -dx / length;
    const steps = Math.max(1, Math.ceil(length / 0.5));
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = a.x + dx * t;
      const z = a.z + dz * t;
      if (!trackSupportsPose(x, z, dx / length, dz / length, tracks)) return false;
      for (const sweep of [-TRAM_SWEEP_HALF_WIDTH, 0, TRAM_SWEEP_HALF_WIDTH]) {
        if (city.spatial.isBlocked(x + rx * sweep, z + rz * sweep)) return false;
      }
    }
  }
  return true;
}

/** Mirror one directional path onto the other track of the double-track bed. */
function oppositeTramPath(path: ReadonlyArray<TramPathPoint>): TramPathPoint[] {
  return path.map((point) => ({
    ...point,
    x: point.x + point.uz * TRAM_OFFSET * 2,
    z: point.z - point.ux * TRAM_OFFSET * 2,
  }));
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
    const tracks = renderedTrackSegments(city.tramLines);
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
        const matchedRail = matchingTramPath(ex, ez, xx, xz, ux, uz, -uz, ux, rails);
        const tramPath = matchedRail !== null &&
          tramCorridorIsClear(city, ex, ez, xx, xz, -uz, ux, matchedRail.offset) &&
          tramPathIsClear(city, tracks, matchedRail.path) &&
          tramPathIsClear(city, tracks, oppositeTramPath(matchedRail.path))
          ? matchedRail
          : null;
        const index = this.edges.length;
        const edge: LaneEdge = {
          index, from: a, to: b,
          ux, uz,
          // In Y-up space, forward cross up points to the driver's right.
          rx: -uz, rz: ux,
          span, lanes, rank,
          speed: RANK_SPEED[rank],
          axisX,
          ex, ez, xx, xz,
          length, trimFrom, trimTo,
          next: [],
          straight: -1,
          tram: tramPath !== null,
          tramOffset: tramPath?.offset ?? 0,
          tramPath: tramPath?.path ?? null,
          tramStraight: -1,
          tramJoinPath: null,
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
        if (e.tram && n.tram && dot > bestTramDot) {
          const join = this.buildTramJoin(city, tracks, e, n);
          if (join) {
            bestTramDot = dot;
            e.tramStraight = nIdx;
            e.tramJoinPath = join;
          }
        }
      }
      if (bestDot < 0.7) e.straight = -1;
      if (bestTramDot < 0.7) {
        e.tramStraight = -1;
        e.tramJoinPath = null;
      }
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
    if (lane === TRAM_LANE && edge.tramPath?.length) {
      const path = edge.tramPath;
      const at = THREE.MathUtils.clamp(t, 0, 1);
      let i = 0;
      while (i + 1 < path.length && path[i + 1].t < at) i++;
      const a = path[i];
      const b = path[Math.min(path.length - 1, i + 1)];
      const span = Math.max(1e-6, b.t - a.t);
      const q = THREE.MathUtils.clamp((at - a.t) / span, 0, 1);
      return out.set(
        THREE.MathUtils.lerp(a.x, b.x, q),
        0,
        THREE.MathUtils.lerp(a.z, b.z, q),
      );
    }
    const off = this.laneOffset(edge, lane);
    const x = edge.ex + (edge.xx - edge.ex) * t + edge.rx * off;
    const z = edge.ez + (edge.xz - edge.ez) * t + edge.rz * off;
    return out.set(x, 0, z);
  }

  /** Sampled physical rail path, used by the tram agent as real waypoints. */
  lanePath(edge: LaneEdge, lane: number): ReadonlyArray<TramPathPoint> | null {
    return lane === TRAM_LANE ? edge.tramPath : null;
  }

  /** Exact physical-track bridge between consecutive tram edges. */
  laneJoinPath(
    a: LaneEdge,
    aLane: number,
    b: LaneEdge,
    bLane: number,
  ): ReadonlyArray<TramPathPoint> | null {
    return aLane === TRAM_LANE && bLane === TRAM_LANE && a.tramStraight === b.index
      ? a.tramJoinPath
      : null;
  }

  /** Unit tangent at a lane parameter. */
  laneTangent(edge: LaneEdge, lane: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    if (lane === TRAM_LANE && edge.tramPath?.length) {
      const path = edge.tramPath;
      const at = THREE.MathUtils.clamp(t, 0, 1);
      let i = 0;
      while (i + 1 < path.length && path[i + 1].t < at) i++;
      const a = path[i];
      const b = path[Math.min(path.length - 1, i + 1)];
      const ux = a.ux + b.ux;
      const uz = a.uz + b.uz;
      const length = Math.hypot(ux, uz) || 1;
      return out.set(ux / length, 0, uz / length);
    }
    return out.set(edge.ux, 0, edge.uz);
  }

  /** Closest point and tangent on the actual lane geometry. */
  closestLanePoint(
    edge: LaneEdge,
    lane: number,
    x: number,
    z: number,
    out: THREE.Vector3,
  ): { distance: number; heading: number } {
    const path = lane === TRAM_LANE ? edge.tramPath : null;
    if (path && path.length >= 2) {
      let bestDistance2 = Infinity;
      let bestHeading = Math.atan2(edge.ux, edge.uz);
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i];
        const b = path[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length2 = dx * dx + dz * dz;
        if (length2 < 1e-8) continue;
        const t = THREE.MathUtils.clamp(((x - a.x) * dx + (z - a.z) * dz) / length2, 0, 1);
        const qx = a.x + dx * t;
        const qz = a.z + dz * t;
        const distance2 = (x - qx) ** 2 + (z - qz) ** 2;
        if (distance2 < bestDistance2) {
          bestDistance2 = distance2;
          bestHeading = Math.atan2(dx, dz);
          out.set(qx, 0, qz);
        }
      }
      return { distance: Math.sqrt(bestDistance2), heading: bestHeading };
    }

    const off = this.laneOffset(edge, lane);
    const ax = edge.ex + edge.rx * off;
    const az = edge.ez + edge.rz * off;
    const along = THREE.MathUtils.clamp((x - ax) * edge.ux + (z - az) * edge.uz, 0, edge.length);
    out.set(ax + edge.ux * along, 0, az + edge.uz * along);
    return {
      distance: Math.hypot(x - out.x, z - out.z),
      heading: Math.atan2(edge.ux, edge.uz),
    };
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

  /** Build the whole junction bridge from exact rendered-track samples. */
  private buildTramJoin(
    city: CityService,
    tracks: ReadonlyArray<TrackSegment>,
    a: LaneEdge,
    b: LaneEdge,
  ): TramPathPoint[] | null {
    this.laneExit(a, TRAM_LANE, _joinA);
    this.laneEntry(b, TRAM_LANE, _joinB);
    if (_joinA.distanceTo(_joinB) >= 60) return null;
    this.cornerPoint(a, TRAM_LANE, b, TRAM_LANE, _joinCorner);
    const path: TramPathPoint[] = [];
    for (const [p, q] of [[_joinA, _joinCorner], [_joinCorner, _joinB]] as const) {
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const length = Math.hypot(dx, dz);
      if (length < 0.1) continue;
      const desiredUx = dx / length;
      const desiredUz = dz / length;
      const steps = Math.max(1, Math.ceil(length / 0.75));
      for (let step = 0; step <= steps; step++) {
        if (path.length && step === 0) continue;
        const t = step / steps;
        const x = p.x + dx * t;
        const z = p.z + dz * t;
        const track = nearestRailTrack(x, z, desiredUx, desiredUz, tracks);
        if (!track || track.distance2 > TRAM_JOIN_TRACK_TOLERANCE ** 2) return null;
        const rx = track.uz;
        const rz = -track.ux;
        for (const sweep of [-TRAM_SWEEP_HALF_WIDTH, TRAM_SWEEP_HALF_WIDTH]) {
          const sx = track.x + rx * sweep;
          const sz = track.z + rz * sweep;
          if (distanceToRailTrackSquared(sx, sz, tracks) > TRAM_JOIN_SWEEP_TOLERANCE ** 2) {
            return null;
          }
        }
        for (const sweep of [-TRAM_SWEEP_HALF_WIDTH, 0, TRAM_SWEEP_HALF_WIDTH]) {
          if (city.spatial.isBlocked(track.x + rx * sweep, track.z + rz * sweep)) return null;
        }
        const previous = path[path.length - 1];
        if (previous && Math.hypot(track.x - previous.x, track.z - previous.z) > 2) {
          // Nearest-track selection jumped across the double track or onto an
          // unrelated crossing. Retiring here is safer than a visible shunt.
          return null;
        }
        path.push({ t: 0, x: track.x, z: track.z, ux: track.ux, uz: track.uz });
      }
    }
    if (path.length < 2) return null;
    // Projecting individual samples is not enough at a flat rail crossing: one
    // sample can select the incoming track and the next the crossing track,
    // leaving the tram to cut diagonally across bare asphalt. Verify the
    // complete chord between every pair against the steel the city rendered.
    for (let i = 0; i + 1 < path.length; i++) {
      const aPoint = path[i];
      const bPoint = path[i + 1];
      for (const t of [0.25, 0.5, 0.75]) {
        const x = THREE.MathUtils.lerp(aPoint.x, bPoint.x, t);
        const z = THREE.MathUtils.lerp(aPoint.z, bPoint.z, t);
        const dx = bPoint.x - aPoint.x;
        const dz = bPoint.z - aPoint.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-6 || !trackSupportsPose(x, z, dx / length, dz / length, tracks)) return null;
      }
    }
    let total = 0;
    const cumulative = [0];
    for (let i = 1; i < path.length; i++) {
      total += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
      cumulative.push(total);
    }
    if (total < 0.1) return null;
    return path.map((p, i) => ({ ...p, t: cumulative[i] / total }));
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
      const pose = this.closestLanePoint(e, TRAM_LANE, x, z, _nearest);
      const tx = Math.sin(pose.heading);
      const tz = Math.cos(pose.heading);
      const align = tx * fx + tz * fz;
      if (align < -0.2) continue;
      const along = (x - e.ex) * e.ux + (z - e.ez) * e.uz;
      if (along < -14 || along > e.length + 14) continue;
      const score = pose.distance + (1 - align) * 14;
      if (score < bestScore) {
        bestScore = score;
        best = { edge: ei, lane: TRAM_LANE };
      }
    }
    return bestScore < 60 ? best : null;
  }
}
