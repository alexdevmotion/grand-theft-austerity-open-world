/** Camera-control invariants that do not require a DOM, WebGL, or physics world. */

import { expect, test } from 'bun:test';
import { movementRecenterYaw } from './cameraSystem';

function delta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

test('on-foot camera keeps a mouse orbit while idle', () => {
  const orbit = 1.8;
  expect(movementRecenterYaw(orbit, 0, false, 1 / 60)).toBeCloseTo(orbit, 12);
});

test('movement starts a smooth pan behind the character instead of a snap', () => {
  const orbit = 1.8;
  const first = movementRecenterYaw(orbit, 0, true, 1 / 60);

  expect(first).toBeLessThan(orbit);
  expect(first).toBeGreaterThan(0);
  expect(Math.abs(delta(first, orbit))).toBeLessThan(Math.abs(delta(0, orbit)));

  let yaw = orbit;
  for (let i = 0; i < 180; i++) yaw = movementRecenterYaw(yaw, 0, true, 1 / 60);
  expect(Math.abs(delta(yaw, 0))).toBeLessThan(0.01);
});
