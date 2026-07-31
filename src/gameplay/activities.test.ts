/**
 * ACTIVITY POINTS MUST LIE ON THE ROAD GRAPH.
 *
 * The failure this pins is the one the playtest found: "Cursă: Bulevardul
 * Magheru" authored its checkpoints on the 92 m planning grid, the shipped
 * city is an OSM import whose centrelines are not on that grid, and the start
 * marker ended up 33 m from anything drivable — inside a block, with a wedged
 * car and 115 seconds on the clock.
 *
 * The snap has to be to a SEGMENT and not to a node, because the graph
 * contains orphan nodes with no links: the nearest node to that start marker
 * is 0 m away and completely undrivable. That is the case `orphan node` below.
 */

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { RoadNode } from '../core/services';
import { ACTIVITIES } from '../content/activities';
import { distanceToRoad, repairPrice, snapToRoadGraph } from './activities';

function node(id: number, x: number, z: number, links: number[]): RoadNode {
  return {
    id,
    position: new THREE.Vector3(x, 0, z),
    links,
    lanes: 2,
    isIntersection: false,
    hasTrafficLight: false,
  };
}

/** A short L of road: (0,0) — (100,0) — (100,100). */
function lGraph(): RoadNode[] {
  return [
    node(0, 0, 0, [1]),
    node(1, 100, 0, [0, 2]),
    node(2, 100, 100, [1]),
  ];
}

describe('snapToRoadGraph', () => {
  test('a point beside a segment lands on the segment, not on an end node', () => {
    const s = snapToRoadGraph(lGraph(), 40, 12);
    expect(s.ok).toBe(true);
    expect(s.x).toBeCloseTo(40, 6);
    expect(s.z).toBeCloseTo(0, 6);
    expect(s.travel).toBeCloseTo(12, 6);
    expect(distanceToRoad(lGraph(), s.x, s.z)).toBeCloseTo(0, 6);
  });

  test('a point past the end of a segment clamps to the end', () => {
    const s = snapToRoadGraph(lGraph(), -40, 0);
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.z).toBeCloseTo(0, 6);
  });

  test('the corner picks whichever of the two segments is closer', () => {
    const s = snapToRoadGraph(lGraph(), 106, 60);
    expect(s.x).toBeCloseTo(100, 6);
    expect(s.z).toBeCloseTo(60, 6);
  });

  /**
   * THE BUG, IN ONE TEST. An orphan node sits exactly on the authored point;
   * `nearestNode` (and therefore `spatial.snapToRoad`) answers "0 m away, you
   * are already there" and the checkpoint stays inside the block.
   */
  test('orphan node: an unlinked node never wins', () => {
    const g = lGraph();
    g.push(node(3, 40, 40, [])); // an orphan sitting on the authored point
    const s = snapToRoadGraph(g, 40, 40);
    expect(s.ok).toBe(true);
    expect(s.z).toBeCloseTo(0, 6);
    expect(s.travel).toBeCloseTo(40, 6);
  });

  test('an empty graph is reported rather than guessed at', () => {
    const s = snapToRoadGraph([], 5, 5);
    expect(s.ok).toBe(false);
    expect(s.x).toBe(5);
  });

  test('snapping is idempotent — a snapped point does not move again', () => {
    const g = lGraph();
    const a = snapToRoadGraph(g, 40, 12);
    const b = snapToRoadGraph(g, a.x, a.z);
    expect(b.travel).toBeCloseTo(0, 6);
  });
});

describe('activity content', () => {
  test('every activity has a start and a sane clock', () => {
    for (const a of ACTIVITIES) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.z)).toBe(true);
      expect(a.limit).toBeGreaterThan(30);
      if (a.kind !== 'evade') expect(a.points.length).toBeGreaterThan(0);
    }
  });

  /**
   * Every point of every activity has to be SNAPPABLE — i.e. once the road
   * graph exists, the correction must be a correction and not a relocation to
   * another district. This is the property `assertOnRoad` enforces at boot
   * against the real graph; here it is pinned against a synthetic one so the
   * function itself cannot regress.
   */
  test('snapping puts every authored point exactly on the graph', () => {
    const g = lGraph();
    for (const a of ACTIVITIES) {
      for (const p of [{ x: a.x, z: a.z }, ...a.points]) {
        const s = snapToRoadGraph(g, p.x, p.z);
        expect(s.ok).toBe(true);
        expect(distanceToRoad(g, s.x, s.z)).toBeLessThan(1e-6);
      }
    }
  });
});

describe('repairPrice', () => {
  test('an undamaged car is refused rather than billed', () => {
    expect(repairPrice(100, 100)).toBe(0);
  });
  test('a wreck costs more than a scratch', () => {
    expect(repairPrice(10, 100)).toBeGreaterThan(repairPrice(90, 100));
  });
});
