import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import type { CityService, RoadNode } from '../../core/services';
import {
  TRAM_LANE,
  TRAM_OFFSET,
  TrafficGraph,
  laneSpawnRange,
  type LaneEdge,
} from './roadGraph';

function node(id: number, x: number, z: number, lanes: number, links: number[]): RoadNode {
  return {
    id,
    position: new THREE.Vector3(x, 0, z),
    links,
    lanes,
    isIntersection: links.length > 2,
    hasTrafficLight: false,
  };
}

function city(
  roadNodes: RoadNode[],
  tramLines: THREE.Vector3[][],
  isBlocked: (x: number, z: number) => boolean = () => false,
): CityService {
  return {
    roadNodes,
    tramLines,
    spatial: {
      snapToRoad: () => false,
      groundHeight: () => 0,
      isBlocked,
    },
  } as unknown as CityService;
}

interface PublishedTrack {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ux: number;
  uz: number;
}

/**
 * Reconstruct the two physical track centrelines emitted by `roads.ts`.
 *
 * These literals are deliberately independent of `TrafficGraph`: importing its
 * lane offset here made the old probe pass even when traffic and rendered steel
 * disagreed. Both permanent-way builders use a 1.2 m central gutter around the
 * 1.435 m standard gauge.
 */
function publishedTracks(
  lines: ReadonlyArray<ReadonlyArray<THREE.Vector3>>,
): PublishedTrack[] {
  const out: PublishedTrack[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trackOffset = 1.435 / 2 + 1.2;
    const runs: PublishedTrack[] = [];
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
      const rx = run.uz;
      const rz = -run.ux;
      for (const side of [-1, 1]) {
        const offset = side * trackOffset;
        out.push({
          ax: run.ax + rx * offset,
          az: run.az + rz * offset,
          bx: run.bx + rx * offset,
          bz: run.bz + rz * offset,
          ux: run.ux,
          uz: run.uz,
        });
      }
    }
    for (let i = 0; i + 1 < runs.length; i++) {
      const a = runs[i];
      const b = runs[i + 1];
      for (const side of [-1, 1]) {
        const ax = a.bx + a.uz * side * trackOffset;
        const az = a.bz - a.ux * side * trackOffset;
        const bx = b.ax + b.uz * side * trackOffset;
        const bz = b.az - b.ux * side * trackOffset;
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

function distanceToPublishedTrack(x: number, z: number, tracks: PublishedTrack[]): number {
  let best = Infinity;
  for (const track of tracks) {
    const dx = track.bx - track.ax;
    const dz = track.bz - track.az;
    const d2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - track.ax) * dx + (z - track.az) * dz) / d2));
    best = Math.min(best, Math.hypot(x - track.ax - dx * t, z - track.az - dz * t));
  }
  return best;
}

function nearestPublishedTrack(
  x: number,
  z: number,
  tracks: PublishedTrack[],
): { distance: number; tangentDot(ux: number, uz: number): number } {
  let bestDistance = Infinity;
  for (const track of tracks) {
    const dx = track.bx - track.ax;
    const dz = track.bz - track.az;
    const d2 = dx * dx + dz * dz;
    const t = Math.max(0, Math.min(1, ((x - track.ax) * dx + (z - track.az) * dz) / d2));
    const distance = Math.hypot(x - track.ax - dx * t, z - track.az - dz * t);
    if (distance < bestDistance) {
      bestDistance = distance;
    }
  }
  return {
    distance: bestDistance,
    // At crossings and shared bend endpoints the geometrically nearest piece
    // may not be the rail this path follows. Accept any physical piece inside
    // the same 20 cm positional tolerance used by the independent assertion.
    tangentDot: (ux, uz) => {
      let bestDot = 0;
      for (const track of tracks) {
        const dx = track.bx - track.ax;
        const dz = track.bz - track.az;
        const d2 = dx * dx + dz * dz;
        const t = Math.max(0, Math.min(1, ((x - track.ax) * dx + (z - track.az) * dz) / d2));
        const distance = Math.hypot(x - track.ax - dx * t, z - track.az - dz * t);
        if (distance <= 0.2 + 1e-4) {
          bestDot = Math.max(bestDot, Math.abs(ux * track.ux + uz * track.uz));
        }
      }
      return bestDot;
    },
  };
}

describe('explicit tram routing', () => {
  test('a wide rank-2 road without rendered rails is never tram-routable', () => {
    const graph = new TrafficGraph(city([
      node(0, 0, 0, 3, [1]),
      node(1, 100, 0, 3, [0]),
    ], []));

    expect(graph.edges[graph.edgeBetween(0, 1)].rank).toBe(2);
    expect(graph.edges[graph.edgeBetween(0, 1)].tram).toBe(false);
    expect(graph.edges[graph.edgeBetween(1, 0)].tram).toBe(false);
  });

  test('a rendered rail corridor through a facade is rejected in both directions', () => {
    const graph = new TrafficGraph(city([
      node(0, 0, 0, 2, [1]),
      node(1, 100, 0, 2, [0]),
    ], [[
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(100, 0, 0),
    ]], (x, z) => x >= 40 && x <= 60 && Math.abs(z) < 5));

    expect(graph.edges[graph.edgeBetween(0, 1)].tram).toBe(false);
    expect(graph.edges[graph.edgeBetween(1, 0)].tram).toBe(false);
  });

  test('rendered rail paths map both directions and choose the rail continuation', () => {
    const railZ = 1.25;
    const graph = new TrafficGraph(city([
      node(0, 0, 0, 3, [1]),
      node(1, 100, 0, 3, [0, 2, 3]),
      node(2, 195, 20, 3, [1]),
      // Geometrically straighter than the rail bend, but it has no track.
      node(3, 200, 0, 3, [1]),
    ], [[
      new THREE.Vector3(0, 0, railZ),
      new THREE.Vector3(100, 0, railZ),
      new THREE.Vector3(195, 0, 20 + railZ),
    ]]));

    const east = graph.edges[graph.edgeBetween(0, 1)];
    const bend = graph.edges[graph.edgeBetween(1, 2)];
    const west = graph.edges[graph.edgeBetween(1, 0)];
    const returnBend = graph.edges[graph.edgeBetween(2, 1)];
    const phantom = graph.edges[graph.edgeBetween(1, 3)];

    expect([east.tram, bend.tram, west.tram, returnBend.tram]).toEqual([
      true, true, true, true,
    ]);
    expect(phantom.tram).toBe(false);
    expect(east.tramStraight).toBe(bend.index);
    expect(returnBend.tramStraight).toBe(west.index);
    expect(east.tramOffset).toBeCloseTo(-railZ, 6);
    expect(west.tramOffset).toBeCloseTo(railZ, 6);

    const forward = graph.lanePoint(east, TRAM_LANE, 0.5, new THREE.Vector3());
    const reverse = graph.lanePoint(west, TRAM_LANE, 0.5, new THREE.Vector3());
    expect(forward.x).toBeCloseTo(50, 6);
    expect(forward.z).toBeCloseTo(railZ - TRAM_OFFSET, 6);
    expect(reverse.x).toBeCloseTo(50, 6);
    expect(reverse.z).toBeCloseTo(railZ + TRAM_OFFSET, 6);

    const range = laneSpawnRange(east, 7.7);
    expect(range).not.toBeNull();
    expect(range!.min * east.length).toBeCloseTo(9.7, 6);
    expect((1 - range!.max) * east.length).toBeCloseTo(9.7, 6);
    expect(laneSpawnRange({ ...east, length: 19 } as LaneEdge, 7.7)).toBeNull();

    // Recovery after a collision must search the permanent way, not snap a
    // tram onto the closer, geometrically straight ordinary road.
    const recovered = graph.nearestTramLane(150, 0, Math.PI / 2, []);
    expect(recovered).not.toBeNull();
    expect(graph.edges[recovered!.edge].tram).toBe(true);
    expect(recovered!.edge).not.toBe(phantom.index);
    expect(recovered!.lane).toBe(TRAM_LANE);
  });

  test('two rail edges separated by bare junction asphalt never form a tram route', () => {
    const graph = new TrafficGraph(city([
      node(0, 0, 0, 3, [1]),
      node(1, 100, 0, 3, [0, 2]),
      node(2, 200, 0, 3, [1]),
    ], [
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(80, 0, 0)],
      [new THREE.Vector3(120, 0, 0), new THREE.Vector3(200, 0, 0)],
    ]));

    const west = graph.edges[graph.edgeBetween(0, 1)];
    const east = graph.edges[graph.edgeBetween(1, 2)];
    expect([west.tram, east.tram]).toEqual([true, true]);
    expect(west.tramStraight).toBe(-1);
  });

  test('the built city maps a usable bidirectional network to its visible rails', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    if (!g.window) g.window = g;
    g.location = { search: '?q=low', href: 'http://localhost/' };

    const scene = new THREE.Scene();
    const services = new Map<string, unknown>();
    const ctx = {
      scene,
      camera: new THREE.PerspectiveCamera(),
      provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
      get: (key: { id: string }) => services.get(key.id),
      tryGet: (key: { id: string }) => services.get(key.id),
      events: { on: () => () => {}, off: () => {}, emit: () => {} },
    } as unknown as GameContext;

    const { CitySystem } = await import('../../world/city');
    const built = new CitySystem();
    built.init(ctx);
    const graph = new TrafficGraph(built);
    const rails = graph.edges.filter((edge) => edge.tram);
    const continuing = rails.filter((edge) => edge.tramStraight >= 0);
    const plainRank2 = graph.edges.filter((edge) => edge.rank === 2 && !edge.tram);
    const blocked: string[] = [];
    const blockedJoins: string[] = [];
    const bareJoins: string[] = [];
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    let longestJoin = 0;
    let furthestJoinFromTrack = 0;
    let furthestLaneFromTrack = 0;
    let worstLaneTangent = 1;
    const visibleTracks = publishedTracks(built.tramLines);
    const nearCasa = graph.edgesNear(-46, 20, 230, []);
    const casaTramSpawns = nearCasa.filter((index) => {
      const edge = graph.edges[index];
      return edge.tram && edge.tramStraight >= 0 && laneSpawnRange(edge, 7.7) !== null;
    });
    const casaRejectedRank2 = nearCasa.filter((index) => {
      const edge = graph.edges[index];
      return edge.rank === 2 && !edge.tram;
    });

    expect(built.tramLines.length).toBeGreaterThan(100);
    expect(rails.length).toBeGreaterThan(100);
    expect(continuing.length).toBeGreaterThan(80);
    expect(plainRank2.length).toBeGreaterThan(0);
    expect(casaTramSpawns.length).toBeGreaterThan(0);
    expect(casaRejectedRank2.length).toBeGreaterThan(0);
    for (const edge of rails) {
      const reverse = graph.edges[graph.edgeBetween(edge.to, edge.from)];
      expect(reverse?.tram).toBe(true);
      if (edge.tramStraight >= 0) {
        const next = graph.edges[edge.tramStraight];
        expect(next.tram).toBe(true);
        expect(edge.ux * next.ux + edge.uz * next.uz).toBeGreaterThanOrEqual(0.7);
        graph.laneExit(edge, TRAM_LANE, p);
        graph.laneEntry(next, TRAM_LANE, q);
        longestJoin = Math.max(longestJoin, p.distanceTo(q));
        let bareJoin = false;
        let joinTrackDistance = 0;
        const join = graph.laneJoinPath(edge, TRAM_LANE, next, TRAM_LANE);
        expect(join?.length).toBeGreaterThan(1);
        const joinPoints = join ?? [];
        for (let joinIndex = 0; joinIndex + 1 < joinPoints.length; joinIndex++) {
          const a = joinPoints[joinIndex];
          const b = joinPoints[joinIndex + 1];
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const length = Math.hypot(dx, dz);
          const steps = Math.max(1, Math.ceil(length));
          const rx = length > 0 ? dz / length : 0;
          const rz = length > 0 ? -dx / length : 0;
          for (let step = 0; step <= steps; step++) {
            const t = step / steps;
            const x = a.x + dx * t;
            const z = a.z + dz * t;
            if (built.spatial.isBlocked(x, z)) {
              blockedJoins.push(`${edge.index}->${next.index}@${t}`);
            }
            const centreDistance = distanceToPublishedTrack(x, z, visibleTracks);
            furthestJoinFromTrack = Math.max(furthestJoinFromTrack, centreDistance);
            joinTrackDistance = Math.max(joinTrackDistance, centreDistance);
            const leftDistance = distanceToPublishedTrack(
              x - rx * 1.5, z - rz * 1.5, visibleTracks,
            );
            const rightDistance = distanceToPublishedTrack(
              x + rx * 1.5, z + rz * 1.5, visibleTracks,
            );
            if (centreDistance > 1.1 || leftDistance > 2.6 || rightDistance > 2.6) {
              bareJoin = true;
            }
          }
        }
        if (bareJoin) {
          bareJoins.push(`${edge.index}->${next.index}:${joinTrackDistance.toFixed(1)}m`);
        }
      }
      const lanePath = graph.lanePath(edge, TRAM_LANE);
      expect(lanePath?.length).toBeGreaterThan(1);
      const lanePoints = lanePath ?? [];
      for (let laneIndex = 0; laneIndex + 1 < lanePoints.length; laneIndex++) {
        const a = lanePoints[laneIndex];
        const b = lanePoints[laneIndex + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-6) continue;
        const steps = Math.max(1, Math.ceil(length / 0.5));
        tangent.set(dx / length, 0, dz / length);
        for (let step = 0; step <= steps; step++) {
          const t = step / steps;
          p.set(a.x + dx * t, 0, a.z + dz * t);
          const physical = nearestPublishedTrack(p.x, p.z, visibleTracks);
          furthestLaneFromTrack = Math.max(furthestLaneFromTrack, physical.distance);
          const tangentDot = physical.tangentDot(tangent.x, tangent.z);
          worstLaneTangent = Math.min(worstLaneTangent, tangentDot);
          if (built.spatial.isBlocked(p.x, p.z)) {
            blocked.push(`${edge.from}->${edge.to}:${laneIndex}@${t}`);
          }
        }
      }
    }
    expect(blocked).toEqual([]);
    expect(blockedJoins).toEqual([]);
    expect(bareJoins).toEqual([]);
    expect(longestJoin).toBeLessThan(60);
    expect(furthestLaneFromTrack).toBeLessThanOrEqual(0.2);
    expect(furthestJoinFromTrack).toBeLessThanOrEqual(0.2);
    expect(worstLaneTangent).toBeGreaterThanOrEqual(Math.cos(THREE.MathUtils.degToRad(5)));

    console.info(
      `[tram-test] ${built.tramLines.length} rendered lines -> ${rails.length} directed rail edges, ` +
      `${continuing.length} with continuations; ${plainRank2.length} rank-2 road edges rejected; ` +
      `${casaTramSpawns.length} safe tram spawn edges near Casa; longest join ${longestJoin.toFixed(1)} m; ` +
      `max lane error ${furthestLaneFromTrack.toFixed(2)} m; ` +
      `worst tangent ${THREE.MathUtils.radToDeg(Math.acos(worstLaneTangent)).toFixed(1)} deg; ` +
      `max join-to-track error ${furthestJoinFromTrack.toFixed(2)} m`,
    );
  }, 30_000);
});
