/**
 * Walkthrough logic. What can silently be wrong here is the *order* of the
 * steps, a step that no player action can ever clear (so the guide stalls until
 * its patience runs out), and a step with no patience at all (so it nags
 * forever). None of that needs a DOM.
 */

import { test, expect } from 'bun:test';
import {
  WALK_STEPS,
  noSignals,
  stepCounter,
  stepOutcome,
  type StepId,
  type WalkSignals,
} from './walkthroughSteps';
import { hintRows } from '../core/keyHints';

test('the guide teaches in the order a player needs it', () => {
  expect(WALK_STEPS.map((s) => s.id)).toEqual([
    'look',
    'walk',
    'sprint',
    'interact',
    'vehicle',
    'drive',
    'map',
    'pause',
  ] as StepId[]);
});

test('every step names real keys, has copy, and has patience', () => {
  for (const step of WALK_STEPS) {
    expect(hintRows(step.hints).length).toBe(step.hints.length);
    expect(step.title.length).toBeGreaterThan(8);
    expect(step.body.length).toBeGreaterThan(8);
    // No patience means the step would never move on by itself.
    expect(step.seconds).toBeGreaterThan(10);
    expect(step.seconds).toBeLessThanOrEqual(90);
  }
});

test('a step nobody has acted on holds, and gives up when its patience runs out', () => {
  const step = WALK_STEPS[0];
  const fresh = noSignals();
  expect(stepOutcome(step, fresh, 0)).toBe('hold');
  expect(stepOutcome(step, fresh, step.seconds - 0.01)).toBe('hold');
  expect(stepOutcome(step, fresh, step.seconds)).toBe('timeout');
});

test('each step can actually be cleared by the thing it asks for', () => {
  const proof: Record<StepId, Partial<WalkSignals>> = {
    look: { lookedRadians: 2 },
    walk: { walkedMeters: 8 },
    sprint: { sprintSeconds: 1 },
    interact: { interacted: true },
    vehicle: { inVehicle: true },
    drive: { drivenMeters: 80 },
    map: { mapOpened: true },
    pause: { pausePressed: true },
  };
  for (const step of WALK_STEPS) {
    const s = { ...noSignals(), ...proof[step.id] };
    expect(stepOutcome(step, s, 0)).toBe('cleared');
    // And nothing clears on an untouched world.
    expect(step.done(noSignals())).toBe(false);
  }
});

test('doing the thing beats the clock — a late finish still earns the tick', () => {
  const drive = WALK_STEPS.find((s) => s.id === 'drive')!;
  const s = { ...noSignals(), drivenMeters: 500 };
  expect(stepOutcome(drive, s, drive.seconds + 10)).toBe('cleared');
});

test('the counter reads 1-based and never runs past the end', () => {
  expect(stepCounter(0)).toBe(`1/${WALK_STEPS.length}`);
  expect(stepCounter(WALK_STEPS.length - 1)).toBe(`${WALK_STEPS.length}/${WALK_STEPS.length}`);
  expect(stepCounter(99)).toBe(`${WALK_STEPS.length}/${WALK_STEPS.length}`);
});
