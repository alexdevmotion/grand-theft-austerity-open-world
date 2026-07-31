/**
 * STREET PROPS BUILT BY facades.ts MUST WORK ON A STREET THAT IS NOT AXIS
 * ALIGNED.
 *
 * The generated grid only ever produced four directions, so several props in
 * this file picked their dimensions with `Math.abs(dirX) > 0.5 ? a : b` and
 * passed no rotation at all. That is silently correct on the grid and silently
 * WRONG on every imported street — Calea Victoriei alone swings through sixty
 * degrees — and the failure mode is not subtle once you look for it: a
 * roadworks barrier on a 45-degree street satisfied both branches of the test
 * and came out as a fan of 2.1 x 2.1 m horizontal plates strewn across the
 * carriageway.
 *
 * The check is geometric and cheap: build the prop along a diagonal, and
 * assert its point cloud is ELONGATED ALONG THE RUN. A prop built against the
 * world axes comes back square whatever direction it was asked for.
 *
 * OWNER: city agent. Pure geometry, no world, no browser.
 */

import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { DetailBuilder } from './builders';
import { bollard, crowdBarrier, parkedCar, streetLamp } from './facades';

/** Extent of a geometry's points along `(ax, az)` and across it. */
function spread(g: THREE.BufferGeometry, ax: number, az: number): { along: number; across: number } {
  const P = g.getAttribute('position').array as ArrayLike<number>;
  const l = Math.hypot(ax, az) || 1;
  const ux = ax / l;
  const uz = az / l;
  let a0 = Infinity; let a1 = -Infinity; let c0 = Infinity; let c1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const a = P[i] * ux + P[i + 2] * uz;
    const c = P[i] * -uz + P[i + 2] * ux;
    if (a < a0) a0 = a;
    if (a > a1) a1 = a;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
  }
  return { along: a1 - a0, across: c1 - c0 };
}

const build = (f: (d: DetailBuilder) => void): THREE.BufferGeometry => {
  const d = new DetailBuilder();
  f(d);
  return d.build();
};

describe('crowdBarrier follows the street it is placed on', () => {
  const DIRS: Array<[string, number, number]> = [
    ['east', 1, 0],
    ['north', 0, -1],
    ['diagonal', Math.SQRT1_2, Math.SQRT1_2],
    ['30 degrees', Math.cos(0.52), Math.sin(0.52)],
    ['unnormalised diagonal', 3, 3],
  ];

  for (const [name, dx, dz] of DIRS) {
    test(`${name}: a five-panel run is 10 m long and under 1 m wide`, () => {
      const g = build((d) => crowdBarrier(d, 0, 0, dx, dz, 5, new Rng(`barrier-${name}`)));
      const s = spread(g, dx, dz);
      // Five 2.1 m panels, plus the last panel's own width.
      expect(s.along).toBeGreaterThan(10);
      expect(s.along).toBeLessThan(12);
      // A barrier is a fence, not a floor. This is the assertion that failed:
      // on the diagonal the old build came back 2.1 m across.
      expect(s.across).toBeLessThan(1.0);
    });
  }

  test('it is not a chrome mirror', () => {
    // A horizontal rail is the one surface a three-degree sun hits square, so
    // showroom metalness put a clipping specular line across every roadworks
    // run in the city. Real barrier tube is dull hot-dip galvanising.
    const g = build((d) => crowdBarrier(d, 0, 0, 1, 0, 2, new Rng('mr')));
    const mr = g.getAttribute('aMR').array as ArrayLike<number>;
    for (let i = 0; i < mr.length; i += 2) {
      expect(mr[i]).toBeLessThanOrEqual(0.6);       // metalness
      expect(mr[i + 1]).toBeGreaterThanOrEqual(0.5); // roughness
    }
  });
});

describe('the other kerbside props', () => {
  test('streetLamp reaches out over the road it is told to light', () => {
    for (const [ix, iz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as Array<[number, number]>) {
      const g = build((d) => streetLamp(d, 0, 0, ix, iz, 8.4));
      const s = spread(g, ix, iz);
      // The gooseneck reaches 1.9 m plus a 0.95 m head, from a 0.31 m column.
      expect(s.along).toBeGreaterThan(2.2);
    }
  });

  test('bollard and parkedCar sit at the height they claim', () => {
    const b = build((d) => bollard(d, 0, 0));
    const P = b.getAttribute('position').array as ArrayLike<number>;
    let lo = Infinity; let hi = -Infinity;
    for (let i = 1; i < P.length; i += 3) { lo = Math.min(lo, P[i]); hi = Math.max(hi, P[i]); }
    expect(lo).toBeGreaterThanOrEqual(0.16);
    expect(hi).toBeLessThan(1.3);

    // A car placed on a diagonal street must be 4.35 m long along it, not
    // 4.35 m along world +x.
    const g = build((d) => parkedCar(d, 0, 0, Math.PI / 4, new Rng('car')));
    const s = spread(g, Math.SQRT1_2, -Math.SQRT1_2);
    expect(s.along).toBeGreaterThan(4.0);
    expect(s.across).toBeLessThan(2.4);
  });
});
