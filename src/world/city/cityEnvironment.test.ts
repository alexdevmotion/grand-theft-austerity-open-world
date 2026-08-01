/**
 * Focused invariants for the OSM/environment repair pass.
 * Pure geometry: no renderer, physics world or browser.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { Rng } from '../../core/rng';
import type { DistrictKind } from '../../core/services';
import {
  fitOsmFootprintCollider,
  styleForOsmBuilding,
  type PlacedBuilding,
} from './buildings';
import { DetailBuilder, FacadeBuilder, insetPolygon } from './builders';
import { DISTRICTS } from './districts';
import { buildBuilding, safeDetailRing, type BuildingSite } from './facades';
import { FacadeStyle } from './materials';
import {
  buildOsmCity,
  Cell,
  isSimpleRing,
  pointInRing,
  type OsmCity,
  type OsmFootprint,
} from './osm';

let city: OsmCity;

beforeAll(() => {
  city = buildOsmCity({ reserved: [], rng: new Rng('city-environment-test') });
});

function siteFor(fp: OsmFootprint): BuildingSite {
  const facingIsLocalZ = Math.abs(fp.fx * Math.sin(fp.rot) + fp.fz * Math.cos(fp.rot)) > 0.5;
  return {
    cx: fp.cx,
    cz: fp.cz,
    w: facingIsLocalZ ? fp.w : fp.d,
    d: facingIsLocalZ ? fp.d : fp.w,
    rot: Math.atan2(-fp.fx, -fp.fz),
    fx: fp.fx,
    fz: fp.fz,
    heroDist: 0,
  };
}

function wantedCollider(fp: OsmFootprint): PlacedBuilding {
  const rot = Math.atan2(-fp.fx, -fp.fz);
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  let u0 = Infinity; let u1 = -Infinity;
  let v0 = Infinity; let v1 = -Infinity;
  for (const p of fp.ring) {
    const dx = p.x - fp.cx;
    const dz = p.z - fp.cz;
    const u = dx * cs - dz * sn;
    const v = dx * sn + dz * cs;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const u = (u0 + u1) / 2;
  const v = (v0 + v1) / 2;
  return {
    x: fp.cx + u * cs + v * sn,
    z: fp.cz - u * sn + v * cs,
    hx: (u1 - u0) / 2,
    hz: (v1 - v0) / 2,
    height: Math.max(4, fp.levels * 3),
    rot,
  };
}

function colliderInside(fp: OsmFootprint, c: PlacedBuilding): boolean {
  const rot = c.rot ?? 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const nx = Math.max(1, Math.ceil(c.hx * 2));
  const nz = Math.max(1, Math.ceil(c.hz * 2));
  for (let ix = 0; ix <= nx; ix++) {
    const u = (ix / nx * 2 - 1) * c.hx;
    for (let iz = 0; iz <= nz; iz++) {
      const v = (iz / nz * 2 - 1) * c.hz;
      const x = c.x + u * cs + v * sn;
      const z = c.z - u * sn + v * cs;
      if (!pointInRing(fp.ring, x, z)) return false;
    }
  }
  return true;
}

describe('curated Bucharest footprints', () => {
  test('remain simple, carry central identities, and never occupy carriageway', () => {
    expect(city.footprints.length).toBeGreaterThan(650);
    expect(city.stats.clearanceAdjusted).toBeGreaterThan(0);
    expect(city.stats.sanitised).toBeGreaterThan(0);

    let minEdge = Infinity;
    for (const fp of city.footprints) {
      expect(isSimpleRing(fp.ring)).toBe(true);
      for (let i = 0; i < fp.ring.length; i++) {
        const a = fp.ring[i];
        const b = fp.ring[(i + 1) % fp.ring.length];
        minEdge = Math.min(minEdge, Math.hypot(a.x - b.x, a.z - b.z));
      }
    }
    expect(minEdge).toBeGreaterThan(0.14);

    let roadBuiltCells = 0;
    for (const v of city.mask.data) {
      if ((v & Cell.road) !== 0 && (v & Cell.built) !== 0) roadBuiltCells++;
    }
    expect(roadBuiltCells).toBe(0);

    for (const name of [
      'Ateneul Român',
      'Palatul Regal',
      'Primăria Municipiului București',
      'Hotel Ambasador',
    ]) {
      expect(city.footprints.some((fp) => fp.name === name)).toBe(true);
    }
  });

  test('fits conservative colliders inside the visible wall and off the road', () => {
    let fitted = 0;
    for (const fp of city.footprints) {
      const collider = fitOsmFootprintCollider(city, fp, wantedCollider(fp));
      if (!collider) continue;
      fitted++;
      expect(colliderInside(fp, collider)).toBe(true);
      expect(city.mask.rectHits(
        collider.x, collider.z, collider.hx * 2, collider.hz * 2, collider.rot ?? 0,
        Cell.road | Cell.reserved | Cell.square,
      )).toBe(false);
    }
    // The one exceptional needle footprint may remain visual-only; collision
    // must never be enlarged into invisible road geometry just to hit 100%.
    expect(fitted).toBeGreaterThanOrEqual(city.footprints.length - 2);
  });

  test('rejects optional façade bands whenever either offset ring crosses itself', () => {
    const bands: Array<[number, number]> = [
      [0, 0.34], [-0.14, 0.34], [-0.22, 0.42], [-0.30, 0.50],
      [-0.45, 0.60], [-0.55, 0.89], [-0.80, 1.14], [-1.05, 1.39],
    ];
    let accepted = 0;
    for (const fp of city.footprints) {
      for (const [offset, thickness] of bands) {
        const outer = safeDetailRing(fp.ring, offset, thickness);
        if (!outer) continue;
        accepted++;
        expect(isSimpleRing(outer)).toBe(true);
        expect(isSimpleRing(insetPolygon(outer, thickness))).toBe(true);
      }
    }
    expect(accepted).toBeGreaterThan(city.footprints.length * bands.length * 0.88);
  });
});

describe('OSM identity drives Bucharest architecture', () => {
  const style = (
    kind: string, name: string | null, levels: number, district: DistrictKind,
  ): number | undefined => styleForOsmBuilding(
    kind, name, levels, district, new Rng(`${kind}:${name}:${district}`),
  );

  test('does not turn historic Magheru blocks into glass or panel towers', () => {
    expect(style('apartments', 'Bl. ARO/Patria', 10, 'bulevard')).toBe(FacadeStyle.interbelic);
    expect(style('yes', 'Hotel Ambasador', 4, 'bulevard')).toBe(FacadeStyle.interbelic);
    expect(style('office', 'Tandem Office', 10, 'bulevard')).not.toBe(FacadeStyle.glassCorporate);
    expect(style('office', 'Green Gate', 11, 'glassCorporate')).toBe(FacadeStyle.glassCorporate);
    expect(style('apartments', 'Bl. 73-75', 9, 'cartier')).toBe(FacadeStyle.cartier);
    expect(style('church', 'Biserica Stavropoleos', 3, 'centruVechi')).toBe(FacadeStyle.centruVechi);
  });

  test('the Athenaeum gets a finite dome above its surveyed mass', () => {
    const fp = city.footprints.find((candidate) => candidate.name === 'Ateneul Român');
    expect(fp).toBeDefined();
    if (!fp) return;
    const f = new FacadeBuilder();
    const d = new DetailBuilder();
    const built = buildBuilding(
      siteFor(fp), DISTRICTS.bulevard, new Rng('athenaeum-geometry'), f, d,
      {
        footprint: fp.ring,
        levels: fp.levels,
        forceStyle: FacadeStyle.guvern,
        osmKind: fp.kind,
        osmName: fp.name,
      },
    );
    expect(d.pos.every(Number.isFinite)).toBe(true);
    expect(d.idx.every(Number.isInteger)).toBe(true);
    let top = -Infinity;
    for (let i = 1; i < d.pos.length; i += 3) top = Math.max(top, d.pos[i]);
    expect(top).toBeGreaterThan(built.height + 2);
  });
});
