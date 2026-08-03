/**
 * Contextual prompt priority. The failure this guards against is two prompts
 * fighting over one widget — standing beside a car in a crowd, or being told to
 * punch someone while sitting in a moving Dacia.
 */

import { test, expect } from 'bun:test';
import { VEHICLE_LABELS, contextPrompt } from './contextPrompt';
import type { VehicleClass } from '../core/services';

const none = { nearVehicle: null, seatedStopped: false, nearPerson: false } as const;

test('an empty pavement offers nothing', () => {
  expect(contextPrompt(none)).toBeNull();
});

test('a car you can get into names the car and the interact key', () => {
  const p = contextPrompt({ ...none, nearVehicle: 'dacia' });
  expect(p?.label).toBe('Urcă în Dacia');
  expect(p?.keys).toEqual(['E', 'F']);
  const bus = contextPrompt({ ...none, nearVehicle: 'bus' });
  expect(bus?.label).toBe('Urcă în autobuz');
  // A different vehicle is a different prompt, so the DOM is rewritten.
  expect(bus?.id).not.toBe(p?.id);
});

test('every vehicle class has a Romanian label', () => {
  const kinds: VehicleClass[] = [
    'dacia', 'sedan', 'hatch', 'van', 'truck', 'bus', 'police', 'tram', 'scooter',
  ];
  for (const k of kinds) {
    expect(VEHICLE_LABELS[k].length).toBeGreaterThan(3);
    expect(contextPrompt({ ...none, nearVehicle: k })?.label).toContain(VEHICLE_LABELS[k]);
  }
});

test('the car in front wins over the car you are sitting in and over the crowd', () => {
  const p = contextPrompt({ nearVehicle: 'van', seatedStopped: true, nearPerson: true });
  expect(p?.label).toBe('Urcă în furgonetă');
});

test('sitting still in a car offers the way out, ahead of any bystander', () => {
  const p = contextPrompt({ ...none, seatedStopped: true, nearPerson: true });
  expect(p?.label).toBe('Coboară din mașină');
  expect(p?.keys).toEqual(['E', 'F']);
});

test('a person within reach offers the punch, with both bound keys', () => {
  const p = contextPrompt({ ...none, nearPerson: true });
  expect(p?.label).toBe('Lovește');
  expect(p?.keys).toEqual(['CLIC ST.', 'Q']);
});
