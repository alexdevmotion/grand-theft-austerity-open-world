import { expect, test } from 'bun:test';
import { MODELS } from './models';
import { lin, type CarDesign } from './carkit';
import * as THREE from 'three';

test('vehicle paint round-trips sRGB without a second gamma conversion', () => {
  expect(lin(0x808080).r).toBeCloseTo(0.2158605, 6);
  expect(lin(0x808080).getHex()).toBe(0x808080);
});

test('ARO has a low engine bay, a tall passenger roof and four usable doors', () => {
  const model = MODELS.aro24;
  const build = model.build(0, false);
  const position = build.shell.attributes.position;
  let bonnetTop = 0;
  let roofTop = 0;
  for (let i = 0; i < position.count; i++) {
    const height = position.getY(i) + model.spec.rideHeight;
    if (position.getZ(i) > 1.4) bonnetTop = Math.max(bonnetTop, height);
    if (position.getZ(i) < 0.5) roofTop = Math.max(roofTop, height);
  }
  expect(bonnetTop).toBeGreaterThan(1.20);
  expect(bonnetTop).toBeLessThan(1.40);
  expect(roofTop).toBeGreaterThan(1.90);
  expect(build.doors?.map((door) => door.id).sort()).toEqual([
    'frontLeft', 'frontRight', 'rearLeft', 'rearRight',
  ]);
  for (const door of build.doors ?? []) {
    expect(door.shell.attributes.position.count).toBeGreaterThan(100);
    expect(door.glass.attributes.position.count).toBeGreaterThan(0);
    expect(door.maxAngle).toBeGreaterThan(0.8);
  }
});

test('every fleet model produces finite geometry within a bounded body budget', () => {
  for (const model of Object.values(MODELS)) {
    const build = model.build(0, false);
    expect(build.triangles).toBeLessThan(30000);
    const geometry = [build.shell, build.glass, ...build.doors?.flatMap((d) => [d.shell, d.glass]) ?? []];
    for (const geo of geometry) {
      const position = geo.attributes.position.array;
      expect(Array.from(position).every(Number.isFinite)).toBe(true);
    }
  }
});

test('fleet drivers, named doors and indicators use physical left at every heading', () => {
  const up = new THREE.Vector3(0, 1, 0);
  for (const [id, model] of Object.entries(MODELS)) {
    const build = model.build(0, false);
    if (build.driver && id !== 'scooter') {
      build.driver.computeBoundingBox();
      expect(build.driver.boundingBox!.getCenter(new THREE.Vector3()).x).toBeGreaterThan(0);
    }
    for (const heading of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.73, -2.4]) {
      const rotation = new THREE.Quaternion().setFromAxisAngle(up, heading);
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
      const right = forward.clone().cross(up);
      for (const door of build.doors ?? []) {
        const direction = door.id.endsWith('Left') ? -1 : 1;
        for (const point of [door.seat, door.board, door.hinge]) {
          expect(point.clone().applyQuaternion(rotation).dot(right) * direction).toBeGreaterThan(0);
        }
      }
    }
    for (const geometry of [build.shell, ...build.doors?.map(d => d.shell) ?? []]) {
      const lights = geometry.getAttribute('aLightB');
      const positions = geometry.getAttribute('position');
      if (!lights) continue;
      for (let i = 0; i < lights.count; i++) {
        if (lights.getX(i) > 0) expect(positions.getX(i)).toBeGreaterThan(0);
        if (lights.getY(i) > 0) expect(positions.getX(i)).toBeLessThan(0);
      }
    }
  }
});

test('Dacia steering wheel and illuminated instrument pack are in front of the left seat', () => {
  const model = MODELS.dacia1300;
  const d = model.spec as CarDesign;
  const geometry = model.build(0, false).shell;
  const position = geometry.getAttribute('position');
  const lights = geometry.getAttribute('aLightB');
  const wheelY = d.belt - .10 - d.rideHeight;
  const wheelZ = d.wsBase - .46;
  let leftWheelVertices = 0, rightWheelVertices = 0, instruments = 0;
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    if (Math.hypot(x - d.halfWidth * .42, y - wheelY, z - wheelZ) < .19) leftWheelVertices++;
    if (Math.hypot(x + d.halfWidth * .42, y - wheelY, z - wheelZ) < .19) rightWheelVertices++;
    if (lights.getZ(i) > 0) { expect(x).toBeGreaterThan(0); instruments++; }
  }
  expect(leftWheelVertices).toBeGreaterThan(300);
  expect(rightWheelVertices).toBeLessThan(30);
  expect(instruments).toBeGreaterThan(0);
});
