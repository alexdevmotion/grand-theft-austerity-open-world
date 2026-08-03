/**
 * Front-end logic tests. Everything here is DOM-free on purpose: the parts of
 * the front-end that can silently be *wrong* are the boot gate (a title screen
 * over every automated capture), the loading-panel schedule, the CONTINUE slot
 * parsing and the settings maths — not the CSS.
 */

import { test, expect } from 'bun:test';
import {
  LOAD_PANELS,
  MENU_ITEMS,
  PANEL_SECONDS,
  CREDITS,
  LAUNCH_HINTS,
  panelAt,
  showsWalkthrough,
  stepSelection,
} from './panels';
import { hintRow, hintRows, type HintId } from '../../core/keyHints';
import {
  actNumber,
  describeSession,
  emptySession,
  isResumable,
  parseSession,
  roman,
} from './session';
import {
  QUALITIES,
  clamp,
  clamp01,
  sensLabel,
  stepQuality,
  storedQuality,
  SENS_MAX,
  SENS_MIN,
} from './settings';
import { frontEndGate, launchProgress, sensPct, worldHandoffPolicy } from './frontEnd';

/* ---- boot gate ---------------------------------------------------- */

test('automation never gets the front-end unless it asks for it', () => {
  expect(frontEndGate('?q=ultra', true).on).toBe(false);
  expect(frontEndGate('', true).on).toBe(false);
  expect(frontEndGate('?q=high&menu=1', true).on).toBe(true);
  expect(frontEndGate('?menu=on', true).on).toBe(true);
});

test('players get the front-end, and can still turn it off', () => {
  expect(frontEndGate('', false).on).toBe(true);
  expect(frontEndGate('?q=high', false).on).toBe(true);
  expect(frontEndGate('?nomenu', false).on).toBe(false);
  expect(frontEndGate('?menu=0', false).on).toBe(false);
  expect(frontEndGate('?shot=1', false).on).toBe(false);
});

test('the fading curtain can render the world but cannot start gameplay early', () => {
  expect(worldHandoffPolicy('under-curtain')).toEqual({ paused: false, inputEnabled: false });
  expect(worldHandoffPolicy('interactive')).toEqual({ paused: false, inputEnabled: true });
});

test('start progress is clamped and never moves backwards when milestones race', () => {
  expect(launchProgress(10, 32)).toBe(32);
  expect(launchProgress(78, 32)).toBe(78);
  expect(launchProgress(92, 120)).toBe(100);
  expect(launchProgress(-10, 8.6)).toBe(9);
});

/* ---- loading panels ----------------------------------------------- */

test('the loading screen covers all four acts, panel 01 first', () => {
  expect(LOAD_PANELS.length).toBe(4);
  expect(LOAD_PANELS[0].index).toBe('01');
  expect(LOAD_PANELS[0].act).toBe('THE HOUSE UNDER SIEGE');
  expect(LOAD_PANELS.map((p) => p.index)).toEqual(['01', '02', '03', '04']);
  for (const p of LOAD_PANELS) {
    expect(p.headline.length).toBeGreaterThan(10);
    expect(p.body.length).toBeGreaterThan(20);
    expect(p.status.length).toBeGreaterThan(5);
  }
});

test('panels advance once each and then hold on the last', () => {
  expect(panelAt(0)).toBe(0);
  expect(panelAt(PANEL_SECONDS - 0.01)).toBe(0);
  expect(panelAt(PANEL_SECONDS)).toBe(1);
  expect(panelAt(PANEL_SECONDS * 3.5)).toBe(3);
  // A slow load must not rewind to act I and spoil act IV twice.
  expect(panelAt(PANEL_SECONDS * 40)).toBe(3);
  expect(panelAt(-5)).toBe(0);
});

/* ---- controls the player is taught -------------------------------- */

test('the loading panels stay story — the keys moved to the launch curtain', () => {
  const rows = hintRows(LAUNCH_HINTS);
  expect(rows.length).toBe(LAUNCH_HINTS.length);
  const ids = rows.map((r) => r.id);
  for (const id of ['move', 'look', 'interact', 'drive', 'pause'] as HintId[]) {
    expect(ids).toContain(id);
  }
  for (const r of rows) expect(r.keys.length).toBeGreaterThan(0);
});

test('hints read the real key tables rather than a hand-written list', () => {
  expect(hintRow('move')?.keys).toEqual(['W', 'A', 'S', 'D']);
  expect(hintRow('sprint')?.keys).toEqual(['SHIFT']);
  expect(hintRow('interact')?.keys).toEqual(['E', 'F']);
  expect(hintRow('handbrake')?.keys).toEqual(['SPAȚIU']);
  expect(hintRow('map')?.keys).toEqual(['M']);
  expect(hintRow('look')?.keys).toEqual(['MOUSE']);
  expect(hintRow('punch')?.keys).toEqual(['CLIC ST.', 'Q']);
});

test('the walkthrough is for players with nothing to continue', () => {
  expect(showsWalkthrough('new', false)).toBe(true);
  expect(showsWalkthrough('new', true)).toBe(false);
  expect(showsWalkthrough('continue', false)).toBe(false);
  expect(showsWalkthrough('continue', true)).toBe(false);
});

/* ---- menu row ----------------------------------------------------- */

test('the menu is the five rows the brief asks for', () => {
  expect(MENU_ITEMS.map((m) => m.id)).toEqual(['start', 'continue', 'controls', 'audio', 'credits']);
  expect(MENU_ITEMS[0].sub).toBe('THE LAST SERVER');
  expect(MENU_ITEMS.find((m) => m.id === 'audio')?.label).toBe('SETTINGS');
});

test('selection skips a CONTINUE with nothing to continue', () => {
  const flags = [true, false, true, true, true];
  expect(stepSelection(0, 1, flags)).toBe(2);
  expect(stepSelection(2, -1, flags)).toBe(0);
  expect(stepSelection(4, 1, flags)).toBe(0);
  expect(stepSelection(0, -1, flags)).toBe(4);
});

test('selection survives a row where nothing is selectable', () => {
  expect(stepSelection(1, 1, [false, false])).toBe(1);
  expect(stepSelection(0, 1, [])).toBe(0);
});

/* ---- credits ------------------------------------------------------ */

test('credits name the cast, the tech and the music', () => {
  const flat = CREDITS.flatMap((b) => [b.role, ...b.lines]).join(' | ');
  expect(flat).toContain('Bolojan-Agatinei');
  expect(flat).toContain('Nicușor LAN');
  expect(flat).toContain('three.js');
  expect(flat).toContain('© OpenStreetMap contributors');
  expect(flat).toContain('Dumitru Fărcaș');
});

/* ---- session / CONTINUE ------------------------------------------- */

test('a corrupt or empty save slot never breaks boot', () => {
  expect(parseSession(null)).toBeNull();
  expect(parseSession('')).toBeNull();
  expect(parseSession('{oops')).toBeNull();
  expect(parseSession('"a string"')).toBeNull();
  expect(parseSession('{}')).toBeNull();
  expect(parseSession('{"savedAt":0}')).toBeNull();
});

test('a partial save slot is filled in rather than trusted', () => {
  const r = parseSession('{"savedAt":1000,"completed":["act1_evacuare",7],"level":"x"}');
  expect(r).not.toBeNull();
  expect(r!.completed).toEqual(['act1_evacuare']);
  expect(r!.level).toBe(1);
  expect(r!.actId).toBeNull();
});

test('CONTINUE is offered only when there is something to continue', () => {
  expect(isResumable(null)).toBe(false);
  expect(isResumable(emptySession())).toBe(false);
  expect(isResumable({ ...emptySession(), savedAt: 1, actId: 'act2_bootstrap' })).toBe(true);
  expect(isResumable({ ...emptySession(), savedAt: 1, playSeconds: 300 })).toBe(true);
});

test('act numbers come from the id, or from what is finished', () => {
  expect(actNumber('act3_termsheet', [])).toBe(3);
  expect(actNumber(null, ['act1_evacuare', 'act2_bootstrap'])).toBe(3);
  expect(actNumber(null, [])).toBe(0);
  expect(actNumber(null, ['act4_giftshop'])).toBe(4);
  expect(roman(4)).toBe('IV');
});

test('the CONTINUE sub-label describes the slot', () => {
  const now = 10_000_000;
  expect(describeSession(null, now)).toBe('NICIUN PROGRES SALVAT');
  const label = describeSession(
    { ...emptySession(), savedAt: now - 3 * 60_000, actId: 'act2_bootstrap', level: 4, playSeconds: 725 },
    now,
  );
  expect(label).toContain('ACTUL II');
  expect(label).toContain('NIVEL 4');
  expect(label).toContain('12 MIN');
  expect(label).toContain('3 MIN ÎN URMĂ');
});

/* ---- settings maths ---------------------------------------------- */

test('quality steps without falling off either end', () => {
  expect(stepQuality('low', -1)).toBe('low');
  expect(stepQuality('low', 1)).toBe('medium');
  expect(stepQuality('ultra', 1)).toBe('ultra');
  expect(QUALITIES.length).toBe(4);
});

test('a main-menu quality choice is safe to restore before the next boot', () => {
  expect(storedQuality('{"quality":"low"}')).toBe('low');
  expect(storedQuality('{"quality":"ultra"}')).toBe('ultra');
  expect(storedQuality('{"quality":"potato"}')).toBeNull();
  expect(storedQuality('{oops')).toBeNull();
});

test('sensitivity is clamped and displayed the way the pause menu shows it', () => {
  expect(clamp(0, SENS_MIN, SENS_MAX)).toBe(SENS_MIN);
  expect(clamp(1, SENS_MIN, SENS_MAX)).toBe(SENS_MAX);
  expect(sensLabel(0.0022)).toBe('2.20');
  expect(clamp01(-2)).toBe(0);
  expect(clamp01(9)).toBe(1);
});

test('the sensitivity meter spans the whole legal range', () => {
  expect(sensPct(SENS_MIN)).toBe(0);
  expect(sensPct(SENS_MAX)).toBe(100);
  expect(sensPct(0.0004 + (0.0075 - 0.0004) / 2)).toBe(50);
});
