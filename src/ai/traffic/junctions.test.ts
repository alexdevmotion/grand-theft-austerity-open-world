import { expect, test } from 'bun:test';
import { JunctionControl } from './junctions';

test('each member of a platoon keeps conflicting traffic out until it clears', () => {
  const junctions = new JunctionControl([]);
  junctions.claim(1, 'front', 10);
  expect(junctions.mayEnter(1, 'rear', 10)).toBe(true);
  junctions.claim(1, 'rear', 10);
  junctions.release(1, 'rear');
  expect(junctions.mayEnter(1, 'crossing', 20)).toBe(false);
  junctions.release(1, 'front');
  expect(junctions.mayEnter(1, 'crossing', 20)).toBe(true);
});

test('an occupied junction remains reserved throughout a slow crossing', () => {
  const junctions = new JunctionControl([]);
  junctions.claim(1, 'bus', 10);
  for (let i = 0; i < 8; i++) {
    junctions.update(1);
    junctions.refresh(1, 'bus');
    expect(junctions.mayEnter(1, 'crossing', 20)).toBe(false);
  }
  junctions.forget('bus');
  expect(junctions.mayEnter(1, 'crossing', 20)).toBe(true);
  junctions.claim(1, 'gone', 10);
  junctions.update(6);
  expect(junctions.activeClaims).toBe(0);
});
