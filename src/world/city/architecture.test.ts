import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { articulatedExtrusion, hippedRoof } from './architecture';
import { DetailBuilder, FacadeBuilder, rectFootprint, type FacadeParams } from './builders';
import { buildBuilding } from './facades';
import { DISTRICTS } from './districts';
import { FacadeStyle } from './materials';

const params: FacadeParams = {
  style: FacadeStyle.bulevard, floorH: 3, groundH: 3, buildingH: 24,
  bayW: 3, seed: 11, tint: 0.5, lit: 0.3,
};
const make = (tier: 0 | 1 | 2) => {
  const facade = new FacadeBuilder(), detail = new DetailBuilder();
  const count = articulatedExtrusion(facade, detail, rectFootprint(0, 0, 18, 12),
    0, 24, 0, params, { tier, front: { x: 0, z: -1 } });
  return { facade, detail, count };
};
function mesh(g: THREE.BufferGeometry): THREE.Mesh {
  const result = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  result.updateMatrixWorld();
  return result;
}

test('street window is a real opening with glazing behind masonry and inward-facing jambs', () => {
  const { facade, detail } = make(2);
  const f = mesh(facade.build()), d = mesh(detail.build());
  const ray = new THREE.Raycaster(new THREE.Vector3(7.5, 4.56, -10), new THREE.Vector3(0, 0, 1));
  expect(ray.intersectObject(f)[0].point.z).toBeCloseTo(-5.76, 4);
  // The combined result still has no solid outer wall in front of the glass.
  expect(ray.intersectObjects([f, d])[0].point.z).toBeGreaterThan(-5.81);
  ray.ray.origin.x = 8.90;
  expect(ray.intersectObject(f)[0].point.z).toBeCloseTo(-6, 4);
  ray.ray.origin.set(7.5, 4.56, -5.9); ray.ray.direction.set(1, 0, 0);
  const jamb = ray.intersectObject(d)[0];
  expect(jamb).toBeDefined();
  expect(jamb.face!.normal.x).toBeLessThan(-0.99);
  f.geometry.dispose(); d.geometry.dispose();
});

test('shop glazing sits half a metre behind its threshold and keeps the original facade UVs', () => {
  const { facade } = make(2);
  const f = mesh(facade.build());
  const ray = new THREE.Raycaster(new THREE.Vector3(6, 1.4, -10), new THREE.Vector3(0, 0, 1));
  const hit = ray.intersectObject(f)[0];
  expect(hit.point.z).toBeCloseTo(-5.52, 4);
  expect(hit.uv!.y).toBeCloseTo(1.4, 5);
  f.geometry.dispose();
});

test('openings remain batched, deterministic and bounded in every baked city tier', () => {
  const counts: number[] = [];
  for (const tier of [0, 1, 2] as const) {
    const a = make(tier), b = make(tier);
    expect(a.count).toBeGreaterThan(0);
    expect(a.count).toBeLessThanOrEqual([12, 36, 72][tier]);
    expect(a.facade.pos).toEqual(b.facade.pos);
    expect(a.detail.idx).toEqual(b.detail.idx);
    const triangles = a.facade.triangles + a.detail.triangles;
    expect(triangles).toBeLessThan(2800);
    for (const g of [a.facade.build(), a.detail.build()]) {
      const p = g.getAttribute('position'), n = g.getAttribute('normal');
      const indices = g.index!;
      const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, indices.getX(i));
      for (let i = 0; i < indices.count; i += 3) {
        const cross = v(i + 1).sub(v(i)).cross(v(i + 2).sub(v(i)));
        expect(cross.lengthSq()).toBeGreaterThan(1e-12);
        expect(cross.dot(new THREE.Vector3().fromBufferAttribute(n, indices.getX(i)))).toBeGreaterThan(0);
      }
      g.dispose();
    }
    counts.push(triangles);
  }
  expect(counts[0]).toBeLessThan(counts[1]);
  expect(counts[1]).toBeLessThan(counts[2]);
});

test('historic roof changes the silhouette while concave courtyards stay open', () => {
  const d = new DetailBuilder();
  expect(hippedRoof(d, rectFootprint(0, 0, 18, 12), 15)).toBe(true);
  const g = d.build(); g.computeBoundingBox();
  expect(g.boundingBox!.max.y).toBeGreaterThan(17);
  expect(d.triangles).toBeLessThan(300);
  expect(hippedRoof(new DetailBuilder(), [{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 3, z: 3 }, { x: 10, z: 0 }], 15)).toBe(false);
  g.dispose();
});

test('apartment balconies form deep upper-storey stacks within a per-building budget', () => {
  const f = new FacadeBuilder(), d = new DetailBuilder();
  const building = buildBuilding({ cx: 0, cz: 0, w: 30, d: 12, rot: 0, fx: 0, fz: -1, heroDist: 0 },
    DISTRICTS.cartier, new Rng('stacked-balcony-proof'), f, d, { levels: 9, forceStyle: FacadeStyle.cartier });
  const highProjection = [];
  for (let i = 0; i < d.pos.length; i += 3) {
    if (d.pos[i + 2] < -7.4 && d.pos[i + 1] > building.height * 0.65) highProjection.push(d.pos[i + 1]);
  }
  expect(highProjection.length).toBeGreaterThan(24);
  expect(f.triangles + d.triangles).toBeLessThan(11000);
});


test('recessed windows rotate with surveyed street fronts', () => {
  const f = new FacadeBuilder(), d = new DetailBuilder(), angle = 0.71;
  const c = Math.cos(angle), s = Math.sin(angle);
  articulatedExtrusion(f, d, rectFootprint(21, -14, 18, 12, angle), 0, 24, 0, params,
    { tier: 2, front: { x: -s, z: -c } });
  const world = (x: number, y: number, z: number) => new THREE.Vector3(21 + x * c + z * s, y, -14 - x * s + z * c);
  const object = mesh(f.build());
  const ray = new THREE.Raycaster(world(7.5, 4.56, -10), new THREE.Vector3(s, 0, c));
  expect(ray.intersectObject(object)[0].point.distanceTo(world(7.5, 4.56, -5.76))).toBeLessThan(0.0001);
  object.geometry.dispose();
});
