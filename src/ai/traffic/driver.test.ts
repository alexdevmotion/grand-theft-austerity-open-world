import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Driver, type ControllableVehicle } from './driver';

test('braking to a stop holds the car without leaking reverse throttle', () => {
  let controls = [0, 0, false] as [number, number, boolean];
  const car = {
    kind: 'dacia', position: new THREE.Vector3(), rotation: new THREE.Quaternion(), speed: 8,
    setControls: (throttle: number, steer: number, brake: boolean) => { controls = [throttle, steer, brake]; },
  };
  const driver = new Driver(car as ControllableVehicle);
  driver.sense(1 / 60);
  for (let i = 0; i < 30; i++) driver.drive(1 / 60, 0, 10, 0, 0);
  expect(controls[0]).toBeLessThan(-.5);
  car.speed = .2;
  driver.drive(1 / 60, 0, 10, 0, 0);
  expect(controls[0]).toBe(0);
  expect(controls[2]).toBe(true);
  car.speed = 0;
  driver.drive(1 / 60, 0, 10, 6, 0);
  expect(controls[0]).toBeGreaterThan(0);
  expect(controls[2]).toBe(false);
});
