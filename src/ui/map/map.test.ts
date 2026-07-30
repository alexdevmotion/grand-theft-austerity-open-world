/** Map maths. Pure functions only — `bun test` has no canvas and no DOM. */

import { test, expect } from 'bun:test';
import {
  angleDelta,
  chamferRing,
  clampToRect,
  compassLetter,
  distanceToPolyline,
  fmtDistance,
  makeView,
  polylineLength,
  project,
  rangeForSpeed,
  routeAdvance,
  smoothPolyline,
  unproject,
  viewBounds,
  type MapView,
} from './mapMath';

function view(over: Partial<MapView> = {}): MapView {
  return { ...makeView(200, 200), scale: 1, ...over };
}

/* ------------------------------------------------------------------ */
/* projection                                                          */
/* ------------------------------------------------------------------ */

test('north is up and east is right with no rotation', () => {
  const v = view();
  const p = { x: 0, y: 0 };
  project(v, 0, -10, p); // 10 m north
  expect(p.x).toBeCloseTo(100, 6);
  expect(p.y).toBeCloseTo(90, 6);
  project(v, 10, 0, p); // 10 m east
  expect(p.x).toBeCloseTo(110, 6);
  expect(p.y).toBeCloseTo(100, 6);
});

test('rotating the view puts the heading at the top of the frame', () => {
  // Facing east: a point 10 m east must appear straight above the centre.
  const v = view({ rot: Math.PI / 2 });
  const p = { x: 0, y: 0 };
  project(v, 10, 0, p);
  expect(p.x).toBeCloseTo(100, 6);
  expect(p.y).toBeCloseTo(90, 6);
});

test('unproject inverts project at any rotation', () => {
  for (const rot of [0, 0.7, -2.1, Math.PI]) {
    const v = view({ rot, cx: 130, cz: -450, scale: 0.37, ox: 70, oy: 120 });
    const p = { x: 0, y: 0 };
    const w = { x: 0, z: 0 };
    for (const [x, z] of [[0, 0], [500, -200], [-321, 987]]) {
      project(v, x, z, p);
      unproject(v, p.x, p.y, w);
      expect(w.x).toBeCloseTo(x, 4);
      expect(w.z).toBeCloseTo(z, 4);
    }
  }
});

test('view bounds cover every corner of a rotated view', () => {
  const v = view({ rot: Math.PI / 4, scale: 0.5 });
  const b = viewBounds(v);
  const w = { x: 0, z: 0 };
  for (const [sx, sy] of [[0, 0], [200, 0], [0, 200], [200, 200], [100, 100]]) {
    unproject(v, sx, sy, w);
    expect(w.x).toBeGreaterThanOrEqual(b.x0);
    expect(w.x).toBeLessThanOrEqual(b.x1);
    expect(w.z).toBeGreaterThanOrEqual(b.z0);
    expect(w.z).toBeLessThanOrEqual(b.z1);
  }
});

/* ------------------------------------------------------------------ */
/* framing                                                             */
/* ------------------------------------------------------------------ */

test('the minimap opens up with speed and then flattens', () => {
  const still = rangeForSpeed(0);
  const town = rangeForSpeed(50);
  const fast = rangeForSpeed(130);
  const silly = rangeForSpeed(400);
  expect(still).toBeLessThan(town);
  expect(town).toBeLessThan(fast);
  expect(silly).toBeCloseTo(rangeForSpeed(135), 6); // clamped, never unbounded
  expect(still).toBeGreaterThan(40);
  expect(fast).toBeLessThan(300);
});

test('angleDelta always takes the short way round', () => {
  expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 9);
  expect(angleDelta(3.0, -3.0)).toBeCloseTo(0.2831853, 5);
  expect(Math.abs(angleDelta(-2.9, 2.9))).toBeLessThan(Math.PI);
});

test('compass letters follow the heading', () => {
  expect(compassLetter(0)).toBe('N');
  expect(compassLetter(Math.PI / 2)).toBe('E');
  expect(compassLetter(Math.PI)).toBe('S');
  expect(compassLetter(-Math.PI / 2)).toBe('V');
});

test('distances read in Romanian', () => {
  expect(fmtDistance(0)).toBe('0 m');
  expect(fmtDistance(834.2)).toBe('834 m');
  expect(fmtDistance(1420)).toBe('1,4 km');
  expect(fmtDistance(NaN)).toBe('—');
});

test('the chamfered frame is a closed six-point ring', () => {
  const ring = chamferRing(100, 60, 12);
  expect(ring.length).toBe(12);
  expect(ring[0]).toBe(12);
  expect(ring[1]).toBe(0);
  // A chamfer bigger than the box collapses to the half-extent, never inverts.
  const tiny = chamferRing(10, 10, 40);
  expect(tiny[0]).toBe(5);
});

test('off-frame points clamp to the edge and say so', () => {
  const out = { x: 0, y: 0 };
  expect(clampToRect({ x: 50, y: 50 }, 0, 0, 100, 100, out)).toBe(false);
  expect(clampToRect({ x: 400, y: -20 }, 0, 0, 100, 100, out)).toBe(true);
  expect(out.x).toBe(100);
  expect(out.y).toBe(0);
});

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

const LEG = [
  { x: 0, z: 0 },
  { x: 100, z: 0 },
  { x: 100, z: 100 },
  { x: 200, z: 100 },
];

test('route advance tracks the segment the player is on', () => {
  expect(routeAdvance(LEG, 0, 0)).toBe(1);
  expect(routeAdvance(LEG, 50, 2)).toBe(1);
  expect(routeAdvance(LEG, 100, 50)).toBe(2);
  expect(routeAdvance(LEG, 190, 100)).toBe(3);
});

test('route advance never rewinds past the end', () => {
  expect(routeAdvance(LEG, 9999, 9999)).toBeLessThanOrEqual(LEG.length - 1);
  expect(routeAdvance([{ x: 0, z: 0 }], 5, 5)).toBe(0);
});

test('polyline length is the sum of its legs', () => {
  expect(polylineLength(LEG)).toBeCloseTo(300, 6);
  expect(polylineLength(LEG, 2)).toBeCloseTo(100, 6);
  expect(polylineLength(LEG, 99)).toBe(0);
});

test('off-route detection measures to the segment, not the corners', () => {
  // Half way along a 100 m leg, 30 m to the side: the nearest *node* is 58 m
  // away, the nearest point on the line is 30. Only the second is honest.
  expect(distanceToPolyline(LEG, 50, 30)).toBeCloseTo(30, 6);
  expect(distanceToPolyline(LEG, 0, 0)).toBeCloseTo(0, 6);
  expect(distanceToPolyline([], 0, 0)).toBe(Infinity);
});

test('smoothing rounds corners without moving the ends', () => {
  const s = smoothPolyline(LEG, 0.25);
  expect(s[0]).toEqual(LEG[0]);
  expect(s[s.length - 1]).toEqual(LEG[LEG.length - 1]);
  expect(s.length).toBeGreaterThan(LEG.length);
  // Every smoothed point stays inside the original bounding box.
  for (const p of s) {
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(200);
    expect(p.z).toBeGreaterThanOrEqual(0);
    expect(p.z).toBeLessThanOrEqual(100);
  }
});

test('smoothing a degenerate route is a no-op', () => {
  expect(smoothPolyline([]).length).toBe(0);
  expect(smoothPolyline([{ x: 1, z: 2 }, { x: 3, z: 4 }]).length).toBe(2);
});
