import { expect, test } from 'bun:test';
import { advanceOccupiedRecovery, type OccupiedRecoveryState } from './vehicleSystem';

function state(): OccupiedRecoveryState {
  return {
    stalledSeconds: 0,
    forwardStalledSeconds: 0,
    reverseStalledSeconds: 0,
    cooldown: 0,
  };
}

const grounded = (throttle: number, planarSpeed = 0.12) => ({
  occupied: true,
  groundedWheels: 4,
  wheelCount: 4,
  throttle,
  planarSpeed,
  dt: 0.5,
});

test('grounded occupied recovery waits for failed forward and reverse attempts', () => {
  const s = state();

  // Four seconds into the wall in drive is not enough: the player has not
  // demonstrated that reverse is also blocked.
  for (let i = 0; i < 8; i++) {
    expect(advanceOccupiedRecovery(s, grounded(1))).toBe(false);
  }
  expect(s.forwardStalledSeconds).toBe(4);
  expect(s.reverseStalledSeconds).toBe(0);

  // A tap is not evidence that reverse is blocked.  It must have a full second
  // to make progress before the detector is allowed to intervene.
  expect(advanceOccupiedRecovery(s, grounded(-1))).toBe(false);
  expect(advanceOccupiedRecovery(s, grounded(-1))).toBe(true);
  expect(s.cooldown).toBeGreaterThan(0);
});

test('ordinary queues and parked cars never arm grounded recovery', () => {
  const s = state();
  for (let i = 0; i < 20; i++) {
    expect(advanceOccupiedRecovery(s, grounded(0))).toBe(false);
  }
  expect(s.stalledSeconds).toBe(0);
  expect(s.forwardStalledSeconds).toBe(0);
  expect(s.reverseStalledSeconds).toBe(0);

  // A car that is actually moving clears the failed-attempt mask, even if it
  // later slows down at a junction.
  for (let i = 0; i < 8; i++) advanceOccupiedRecovery(s, grounded(1, 3));
  expect(s.stalledSeconds).toBe(0);
  expect(s.forwardStalledSeconds).toBe(0);
  expect(s.reverseStalledSeconds).toBe(0);
});

test('a driver can hold forward in a queue and then back away without teleporting', () => {
  const s = state();

  // Being boxed in by stopped traffic can look stuck for a long time.
  for (let i = 0; i < 10; i++) {
    expect(advanceOccupiedRecovery(s, grounded(1))).toBe(false);
  }

  // The first reverse sample is still stationary, then the gap opens and the
  // car moves.  Recovery must not steal that legitimate escape attempt.
  expect(advanceOccupiedRecovery(s, grounded(-1))).toBe(false);
  expect(advanceOccupiedRecovery(s, grounded(-1, 1.2))).toBe(false);
  expect(s.stalledSeconds).toBe(0);
  expect(s.forwardStalledSeconds).toBe(0);
  expect(s.reverseStalledSeconds).toBe(0);
  expect(s.cooldown).toBe(0);
});

test('a two-wheel grounded wedge still qualifies, while a stale attempt expires', () => {
  const s = state();
  for (let i = 0; i < 8; i++) {
    expect(advanceOccupiedRecovery(s, {
      ...grounded(1),
      groundedWheels: 2,
    })).toBe(false);
  }
  // A neutral pause is allowed to swap pedals, but a long pause expires the
  // mask so a later red light cannot combine with the old failed direction.
  for (let i = 0; i < 4; i++) advanceOccupiedRecovery(s, grounded(0));
  expect(s.stalledSeconds).toBe(0);
  expect(s.forwardStalledSeconds).toBe(0);
  expect(s.reverseStalledSeconds).toBe(0);
  for (let i = 0; i < 8; i++) {
    expect(advanceOccupiedRecovery(s, grounded(-1))).toBe(false);
  }
});

test('an unoccupied or airborne vehicle is left to the existing rescue path', () => {
  const s = state();
  for (let i = 0; i < 20; i++) {
    expect(advanceOccupiedRecovery(s, {
      ...grounded(i % 2 ? 1 : -1),
      occupied: false,
      groundedWheels: 0,
    })).toBe(false);
  }
  expect(s.stalledSeconds).toBe(0);
  expect(s.forwardStalledSeconds).toBe(0);
  expect(s.reverseStalledSeconds).toBe(0);
});
