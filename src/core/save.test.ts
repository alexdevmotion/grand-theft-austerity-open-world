/**
 * SAVE SLOT tests. DOM-free on purpose: the part of a save system that can
 * silently ruin a player's run is the parser — a slot half-written by a tab
 * that was closed mid-`setItem`, or one written by a build with a different
 * field set, must never break boot and must never be trusted field-by-field.
 */

import { test, expect } from 'bun:test';
import { emptySave, isResumable, parseSave } from './save';

test('a corrupt, empty or timeless slot is simply "no save"', () => {
  expect(parseSave(null)).toBeNull();
  expect(parseSave('')).toBeNull();
  expect(parseSave('{oops')).toBeNull();
  expect(parseSave('"a string"')).toBeNull();
  expect(parseSave('[]')).toBeNull();
  expect(parseSave('{}')).toBeNull();
  expect(parseSave('{"savedAt":0}')).toBeNull();
  expect(parseSave('{"savedAt":"yesterday"}')).toBeNull();
});

test('every field is validated on its own, never trusted as a blob', () => {
  const r = parseSave(JSON.stringify({
    savedAt: 1000,
    completed: ['act1_evacuare', 7, null],
    unlocks: ['sprint_boost', {}],
    discovered: 'not an array',
    level: 'x',
    xp: -50,
    lei: Number.NaN,
    pos: [1, 2],
    heading: 'north',
    timeOfDay: 99,
    weather: 42,
  }))!;
  expect(r).not.toBeNull();
  expect(r.completed).toEqual(['act1_evacuare']);
  expect(r.unlocks).toEqual(['sprint_boost']);
  expect(r.discovered).toEqual([]);
  expect(r.level).toBe(1);
  expect(r.xp).toBe(0);
  expect(r.lei).toBe(0);
  // A malformed position must be dropped, not half-applied: teleporting the
  // player to (1, 2, undefined) is worse than leaving him where he spawned.
  expect(r.pos).toBeNull();
  expect(r.heading).toBe(0);
  expect(r.timeOfDay).toBe(3); // 99 h wraps into the day, it does not clamp to 24
  expect(r.weather).toBe('clearSunset');
});

test('a full slot round-trips unchanged', () => {
  const rec = {
    ...emptySave(),
    actId: 'act3_termsheet',
    actTitle: 'Term Sheet',
    completed: ['act1_evacuare', 'act2_bootstrap'],
    level: 4,
    xp: 2600,
    unlocks: ['sprint_boost', 'dacia_call', 'level_2', 'level_3', 'level_4'],
    discovered: ['buildersHouse', 'parliament'],
    lei: 8250,
    pos: [-46, 0.4, 34] as [number, number, number],
    heading: 1.25,
    timeOfDay: 21.5,
    weather: 'rain',
    savedAt: 1_700_000_000_000,
    playSeconds: 1830,
  };
  expect(parseSave(JSON.stringify(rec))).toEqual(rec);
});

test('an old CONTINUE record still loads, it just restores less', () => {
  // Exactly the shape the pre-save-system front-end wrote.
  const r = parseSave(JSON.stringify({
    actId: 'act2_bootstrap',
    actTitle: 'Bootstrap',
    completed: ['act1_evacuare'],
    level: 3,
    lei: 5000,
    savedAt: 1_700_000_000_000,
    playSeconds: 600,
  }))!;
  expect(r.actId).toBe('act2_bootstrap');
  expect(r.level).toBe(3);
  expect(r.lei).toBe(5000);
  expect(r.xp).toBe(0);
  expect(r.pos).toBeNull();
  expect(isResumable(r)).toBe(true);
});

test('CONTINUE is offered only when there is something to continue', () => {
  expect(isResumable(null)).toBe(false);
  expect(isResumable(emptySave())).toBe(false);
  expect(isResumable({ ...emptySave(), savedAt: 1, actId: 'act2_bootstrap' })).toBe(true);
  expect(isResumable({ ...emptySave(), savedAt: 1, completed: ['act1_evacuare'] })).toBe(true);
  expect(isResumable({ ...emptySave(), savedAt: 1, xp: 400 })).toBe(true);
  expect(isResumable({ ...emptySave(), savedAt: 1, playSeconds: 300 })).toBe(true);
  // Ten seconds of free roam with nothing earned is not a save worth offering.
  expect(isResumable({ ...emptySave(), savedAt: 1, playSeconds: 10 })).toBe(false);
});
