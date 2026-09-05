import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { VehicleHandle } from '../../core/services';
import { SensorField, findLead } from './sensors';

function obstacle(kind: string, x: number, z: number, heading: number, speed = 0): VehicleHandle {
  return { id: kind, kind, position: new THREE.Vector3(x, 0, z),
    rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading), speed,
  } as VehicleHandle;
}

test('a sideways bus across the driving corridor is detected by its complete body', () => {
  const field = new SensorField();
  field.addVehicle(obstacle('bus', 4, 12, Math.PI / 2), false);
  const lead = findLead(field, 'self', 0, 0, 0, 2.2, 30, 1.5);
  expect(lead.obstacle?.id).toBe('bus');
  expect(lead.gap).toBeCloseTo(8.5, 5);
});

test('oncoming speed remains negative while adjacent parallel lanes remain clear', () => {
  const field = new SensorField();
  field.addVehicle(obstacle('sedan', 0, 20, Math.PI, 8), false);
  expect(findLead(field, 'self', 0, 0, 0, 2.2, 30, 1.5).speed).toBeCloseTo(-8);
  field.begin();
  field.addVehicle(obstacle('sedan', 3.5, 12, 0), false);
  expect(findLead(field, 'self', 0, 0, 0, 2.2, 30, 1.5).obstacle).toBeNull();
});
