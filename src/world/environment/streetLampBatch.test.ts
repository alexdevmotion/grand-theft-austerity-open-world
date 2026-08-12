import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { StreetLampBatch } from './streetLampBatch';

test('an addressable lamp batch hides one intact slot without disturbing its neighbour', () => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial();
  const batch = new StreetLampBatch(geometry, material, [
    { x: 2, z: 3, y0: 0.17, inwardX: 1, inwardZ: 0, height: 8.4 },
    { x: 20, z: 30, y0: 0.17, inwardX: 0, inwardZ: -1, height: 9.4 },
  ], 'test-lamps');

  expect(batch.count).toBe(2);
  expect(batch.isIntact(0)).toBe(true);
  expect(batch.isIntact(1)).toBe(true);

  batch.setIntactVisible(0, false);

  const hidden = new THREE.Matrix4();
  const neighbour = new THREE.Matrix4();
  batch.mesh.getMatrixAt(0, hidden);
  batch.mesh.getMatrixAt(1, neighbour);
  const hiddenScale = new THREE.Vector3();
  const neighbourPosition = new THREE.Vector3();
  neighbour.decompose(neighbourPosition, new THREE.Quaternion(), new THREE.Vector3());
  // Matrix4.decompose deliberately treats a singular zero matrix as unit
  // scale, so assert the actual instance columns the vertex shader receives.
  expect(hidden.elements.slice(0, 12)).toEqual(new Array(12).fill(0));
  expect(neighbourPosition.x).toBe(20);
  expect(neighbourPosition.y).toBeCloseTo(0.17, 6);
  expect(neighbourPosition.z).toBe(30);
  expect(batch.isIntact(0)).toBe(false);
  expect(batch.isIntact(1)).toBe(true);

  batch.setIntactVisible(0, true);
  batch.mesh.getMatrixAt(0, hidden);
  hidden.decompose(neighbourPosition, new THREE.Quaternion(), hiddenScale);
  expect(neighbourPosition.x).toBe(2);
  expect(neighbourPosition.y).toBeCloseTo(0.17, 6);
  expect(neighbourPosition.z).toBe(3);
  expect(hiddenScale.y).toBeCloseTo(1, 8);

  geometry.dispose();
  material.dispose();
});
