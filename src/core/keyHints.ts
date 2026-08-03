/**
 * KEY HINTS — "which key does this, spelled the way a player reads it".
 *
 * Lives next to `input.ts` rather than in the menu because four different
 * places need the same answer and none of them can afford to guess: the launch
 * curtain after START, the first-run walkthrough, the contextual prompt that
 * appears next to a car, and the menu's full CONTROLS page.
 *
 * Everything here resolves through `MOVE_KEYS`, `HANDBRAKE_KEY` and
 * `keysForAction()` — the tables `Input` itself reads. Rebind a key in
 * `input.ts` and every hint in the game moves with it. Nothing is typed twice.
 */

import { HANDBRAKE_KEY, MOVE_KEYS, keysForAction, type ActionName } from './input';

const KEY_GLYPHS: Record<string, string> = {
  Space: 'SPAȚIU',
  Escape: 'ESC',
  Enter: 'ENTER',
  Tab: 'TAB',
  Backquote: '`',
  Backspace: '⌫',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT DR.',
  ControlLeft: 'CTRL',
  ControlRight: 'CTRL DR.',
  AltLeft: 'ALT',
  AltRight: 'ALT DR.',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Minus: '−',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Mouse: 'MOUSE',
  Mouse0: 'CLIC ST.',
  Mouse1: 'CLIC MIJ.',
  Mouse2: 'CLIC DR.',
};

/** `KeyE` → `E`, `ShiftLeft` → `SHIFT`, `Mouse0` → `CLIC ST.` */
export function glyph(code: string): string {
  return KEY_GLYPHS[code] ?? code.replace(/^(Key|Digit)/, '');
}

export type HintId =
  | 'move'
  | 'look'
  | 'sprint'
  | 'interact'
  | 'punch'
  | 'aim'
  | 'drive'
  | 'steer'
  | 'handbrake'
  | 'radioNext'
  | 'map'
  | 'pause'
  | 'photoMode';

export interface HintRow {
  readonly id: HintId;
  readonly label: string;
  readonly keys: readonly string[];
}

/** First binding per direction — WASD, not WASD plus four arrows. */
const primary = (codes: readonly string[]): string[] => (codes[0] ? [codes[0]] : []);
const forAction = (a: ActionName): string[] => primary(keysForAction(a));

const HINT_SOURCES: Record<HintId, { label: string; codes: () => string[] }> = {
  move: {
    label: 'Mergi',
    codes: () => [
      ...primary(MOVE_KEYS.forward),
      ...primary(MOVE_KEYS.left),
      ...primary(MOVE_KEYS.back),
      ...primary(MOVE_KEYS.right),
    ],
  },
  look: { label: 'Privește în jur', codes: () => ['Mouse'] },
  sprint: { label: 'Fugi', codes: () => forAction('sprint') },
  interact: { label: 'Urcă în mașină / interacționează', codes: () => keysForAction('interact') },
  punch: { label: 'Lovește', codes: () => ['Mouse0', ...forAction('punch')] },
  aim: { label: 'Ochește', codes: () => ['Mouse2'] },
  drive: {
    label: 'Accelerează / frânează',
    codes: () => [...primary(MOVE_KEYS.forward), ...primary(MOVE_KEYS.back)],
  },
  steer: {
    label: 'Virează',
    codes: () => [...primary(MOVE_KEYS.left), ...primary(MOVE_KEYS.right)],
  },
  handbrake: { label: 'Frână de mână', codes: () => [HANDBRAKE_KEY] },
  radioNext: { label: 'Postul următor', codes: () => forAction('radioNext') },
  map: { label: 'Hartă', codes: () => forAction('map') },
  pause: { label: 'Pauză / meniu', codes: () => forAction('pause') },
  photoMode: { label: 'Mod foto', codes: () => forAction('photoMode') },
};

/** `null` when nothing is bound to it any more — a hint is never invented. */
export function hintRow(id: HintId): HintRow | null {
  const src = HINT_SOURCES[id];
  const keys = src.codes().map(glyph);
  return keys.length ? { id, label: src.label, keys } : null;
}

export function hintRows(ids: readonly HintId[]): HintRow[] {
  return ids.map(hintRow).filter((r): r is HintRow => r !== null);
}

/** Just the keycaps for one hint, e.g. `['E', 'F']`. Empty when unbound. */
export function hintKeys(id: HintId): string[] {
  return hintRow(id)?.keys.slice() ?? [];
}
