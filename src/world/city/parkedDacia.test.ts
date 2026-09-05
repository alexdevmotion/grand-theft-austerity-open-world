import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { DetailBuilder } from './builders';
import { parkedCar } from './facades';
import { appendParkedDacia, parkedDaciaTemplate } from './parkedDacia';

function rayMesh(g: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial()); m.updateMatrixWorld(); return m;
}

test('parked Dacia is a cached detailed silhouette within the merged-city budget', () => {
  const g = parkedDaciaTemplate();
  expect(parkedDaciaTemplate()).toBe(g);
  expect(g.index!.count / 3).toBeGreaterThan(1500);
  expect(g.index!.count / 3).toBeLessThanOrEqual(2500);
  expect(g.getAttribute('position').count).toBeLessThan(g.index!.count * 0.65);
  expect(g.boundingBox!.min.y).toBeCloseTo(0.01, 5);
  expect(g.boundingBox!.max.y).toBeGreaterThan(1.42);
  expect(g.boundingBox!.max.y).toBeLessThan(1.45);
  // The bonnet and boot remain below the glass, not a rectangular van cabin.
  const m = rayMesh(g);
  for (const z of [-1.8, 1.7]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(0, 3, z), new THREE.Vector3(0, -1, 0)).intersectObject(m)[0];
    expect(hit.point.y).toBeLessThan(1);
  }
  // Both windscreen and backlight have measurable rake.
  for (const front of [true, false]) {
    const sign = front ? 1 : -1;
    const probe = (y: number) => new THREE.Raycaster(new THREE.Vector3(0, y, sign * 3), new THREE.Vector3(0, 0, -sign)).intersectObject(m)[0].point.z;
    expect((probe(1.05) - probe(1.3)) * sign).toBeGreaterThan(0.20);
  }
});

test('all four tyres and exposed hubcaps occupy distinct wheel arches', () => {
  const m = rayMesh(parkedDaciaTemplate());
  for (const z of [-1.12, 1.32]) for (const side of [-1, 1]) {
    const hit = new THREE.Raycaster(new THREE.Vector3(side * 2, 0.31, z), new THREE.Vector3(-side, 0, 0)).intersectObject(m)[0];
    expect(hit).toBeDefined();
    expect(hit.point.x * side).toBeGreaterThan(0.82);
    expect(hit.face!.normal.x * side).toBeGreaterThan(0.4);
  }
});

test('batched transform preserves winding, finite normals and replaces paint tags', () => {
  const d = new DetailBuilder();
  const body = new THREE.Color(0.3, 0.25, 0.18), panel = new THREE.Color(0.12, 0.14, 0.16);
  appendParkedDacia(d, 21, -7, 0.71, body, panel, 0.51);
  const g = d.build(), p = g.getAttribute('position'), n = g.getAttribute('normal');
  const index = g.index!;
  expect(d.col.some((v, i) => i % 3 === 0 && v === body.r)).toBe(true);
  expect(d.col.some((v, i) => i % 3 === 0 && v === panel.r)).toBe(true);
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, index.getX(i));
  for (let i = 0; i < index.count; i += 3) {
    const normal = new THREE.Vector3().fromBufferAttribute(n, index.getX(i));
    const area = v(i + 1).sub(v(i)).cross(v(i + 2).sub(v(i)));
    expect(area.lengthSq()).toBeGreaterThan(1e-12);
    expect(area.dot(normal)).toBeGreaterThan(0);
    expect(normal.length()).toBeCloseTo(1, 4);
  }
  g.dispose();
});

test('replacing the parked representation preserves its blocker and random stream', () => {
  const d = new DetailBuilder(), rng = new Rng('parked-contract');
  parkedCar(d, 3, 8, 0.6, rng);
  expect(d.collisionBoxes).toHaveLength(1);
  const box = d.collisionBoxes[0];
  expect(box.kind).toBe('parked-car');
  expect(box.position.toArray()).toEqual([3, 0.86, 8]);
  expect(box.halfExtents.toArray()).toEqual([4.35 / 2, 0.86, 1.62 / 2]);
  expect(box.rotationY).toBe(0.6);
  const control = new Rng('parked-contract');
  control.next(); control.next(); control.next();
  expect(rng.next()).toBe(control.next());
});


test('tyre contact and collision bottom follow road, pavement and raised plaza heights', () => {
  for (const groundY of [0, 0.025, 0.17, 0.175, 0.18]) {
    const d = new DetailBuilder();
    parkedCar(d, 3, 8, 0.6, new Rng('grounded-car'), groundY);
    const g = d.build();
    g.computeBoundingBox();
    expect(g.boundingBox!.min.y).toBeCloseTo(groundY, 5);
    const box = d.collisionBoxes[0];
    expect(box.position.y - box.halfExtents.y).toBeCloseTo(groundY, 5);
    expect(g.boundingBox!.max.y - groundY).toBeCloseTo(parkedDaciaTemplate().boundingBox!.max.y - 0.01, 5);
    g.dispose();
  }
});

test('the seeded street fleet uses faded paint and only rare muted donor panels', () => {
  const c = parkedDaciaTemplate().getAttribute('color');
  let bodyVertex = -1, panelVertex = -1;
  for (let i = 0; i < c.count; i++) {
    if (c.getX(i) === 1 && c.getZ(i) === 1) bodyVertex = i;
    if (c.getY(i) === 1 && c.getZ(i) === 1) panelVertex = i;
  }
  let mismatches = 0;
  const paintColors = new Set<string>();
  for (let i = 0; i < 128; i++) {
    const d = new DetailBuilder();
    parkedCar(d, 0, 0, 0, new Rng(`fleet-${i}`));
    const body = new THREE.Color().fromArray(d.col, bodyVertex * 3);
    const panel = new THREE.Color().fromArray(d.col, panelVertex * 3);
    paintColors.add(body.getHexString());
    if (!body.equals(panel)) {
      mismatches++;
      expect(panel.getHexString()).toBe('91978d');
    }
  }
  expect([...paintColors].sort()).toEqual(['c5bd9e', '87969b', '85554e', '536b77', 'bebdb2', 'a4aa92'].sort());
  expect(mismatches).toBeGreaterThan(0);
  expect(mismatches).toBeLessThan(16);
});
