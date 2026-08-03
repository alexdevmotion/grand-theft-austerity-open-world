/**
 * CONTROLS — read from the live input map, never typed out.
 *
 * `KEY_ACTIONS` is module-private in `src/core/input.ts`, so the only honest way
 * to show the player what the game will really do is to ask the real `Input`
 * instance: synthesise a keydown for every candidate key, see which action (or
 * which movement axis) lights up, and let go. Rebind a key in `input.ts` and
 * this page changes with it. This is the same approach `src/ui/pauseMenu.ts`
 * takes — that file is not mine to edit and its probe is private, so the probe
 * is implemented here, grouped for the front-end's two-column layout rather
 * than as the pause menu's flat list.
 *
 * The one thing declared locally is the human label and the group per action,
 * and `ACTION_INFO` is typed `Record<ActionName, …>` — adding an action to
 * `ActionName` fails `tsc` until it appears here. The list cannot drift.
 */

import type { Input, ActionName } from '../../core/input';
import { glyph } from '../../core/keyHints';

// The full CONTROLS page still probes the live `Input`; the hint rows the
// loading curtain and the walkthrough use live in `src/core/keyHints.ts`.
export { glyph, hintRow, hintRows, hintKeys, type HintId, type HintRow } from '../../core/keyHints';

export type BindGroup = 'foot' | 'vehicle' | 'system';

export const GROUP_TITLES: Record<BindGroup, string> = {
  foot: 'PE JOS',
  vehicle: 'LA VOLAN',
  system: 'SISTEM',
};

interface ActionInfo {
  label: string;
  group: BindGroup;
}

/** Exhaustive by construction — a new `ActionName` breaks the build. */
const ACTION_INFO: Record<ActionName, ActionInfo | null> = {
  sprint: { label: 'Fugi', group: 'foot' },
  jump: { label: 'Sari', group: 'foot' },
  crouch: { label: 'Ghemuit', group: 'foot' },
  punch: { label: 'Lovește', group: 'foot' },
  aim: { label: 'Ochește', group: 'foot' },
  fire: { label: 'Trage', group: 'foot' },
  interact: { label: 'Interacționează / urcă în mașină', group: 'foot' },
  handbrake: { label: 'Frână de mână', group: 'vehicle' },
  horn: { label: 'Claxon', group: 'vehicle' },
  exitVehicle: { label: 'Coboară din mașină', group: 'vehicle' },
  radioNext: { label: 'Postul următor', group: 'vehicle' },
  lookBehind: { label: 'Privește în spate', group: 'vehicle' },
  cameraSwitch: { label: 'Schimbă camera', group: 'system' },
  map: { label: 'Hartă', group: 'system' },
  pause: { label: 'Pauză / meniu', group: 'system' },
  photoMode: { label: 'Mod foto', group: 'system' },
};

const ALL_ACTIONS = Object.keys(ACTION_INFO) as ActionName[];

/** Every key the probe tries. Anything bound outside this set is not a key. */
const PROBE_KEYS: readonly string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 26; i++) out.push(`Key${String.fromCharCode(65 + i)}`);
  for (let i = 0; i < 10; i++) out.push(`Digit${i}`);
  out.push(
    'Space', 'Enter', 'Tab', 'Escape', 'Backquote', 'Backspace',
    'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Comma', 'Period', 'Slash', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
  );
  return out;
})();

export interface BindingRow {
  label: string;
  keys: string[];
}

export type BindingGroups = Record<BindGroup, BindingRow[]>;

export interface ProbeHost {
  /** Set true around the synthetic events so the menu ignores its own keys. */
  probing: boolean;
}

/**
 * Ask the live `Input` what every key does. `host.probing` is raised for the
 * duration so the front-end's own capture-phase key handler ignores the storm
 * of synthetic events, exactly as the pause menu does.
 */
export function readBindings(input: Input, host: ProbeHost): BindingGroups {
  const wasEnabled = input.enabled;
  host.probing = true;
  input.enabled = true;

  const byAction = new Map<ActionName, string[]>();
  const byMove = new Map<string, string[]>();
  let handbrakeKeys: string[] = [];

  // Whatever is already held (a stuck key, the debug harness's forced actions)
  // must not be attributed to every key we try.
  const baseline = new Set<ActionName>(ALL_ACTIONS.filter((a) => input.action(a)));
  const baseHandbrake = input.handbrake;

  const record = (code: string): void => {
    for (const a of ALL_ACTIONS) {
      if (baseline.has(a) || !input.action(a)) continue;
      const list = byAction.get(a) ?? [];
      if (!list.includes(code)) list.push(code);
      byAction.set(a, list);
    }
    if (!baseHandbrake && input.handbrake && !handbrakeKeys.includes(code)) {
      handbrakeKeys = [...handbrakeKeys, code];
    }
  };

  for (const code of PROBE_KEYS) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
    record(code);
    // Movement is resolved inside Input.update(), not through the action map.
    input.update();
    const { moveX, moveY } = input.axes;
    if (moveY > 0.5) push(byMove, 'forward', code);
    else if (moveY < -0.5) push(byMove, 'back', code);
    if (moveX > 0.5) push(byMove, 'right', code);
    else if (moveX < -0.5) push(byMove, 'left', code);
    window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
  }

  for (const button of [0, 1, 2]) {
    window.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
    record(`Mouse${button}`);
    window.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
  }

  // Leave the axes as we found them.
  input.update();
  input.enabled = wasEnabled;
  host.probing = false;

  const out: BindingGroups = { foot: [], vehicle: [], system: [] };

  const move = (id: string, label: string, group: BindGroup): string[] => {
    const keys = byMove.get(id) ?? [];
    if (keys.length) out[group].push({ label, keys: keys.map(glyph) });
    return keys.map(glyph);
  };

  const fwd = move('forward', 'Înainte', 'foot');
  const back = move('back', 'Înapoi', 'foot');
  move('left', 'Stânga', 'foot');
  move('right', 'Dreapta', 'foot');
  out.foot.push({ label: 'Privește în jur', keys: ['MOUSE'] });

  // Throttle and steering are the same axes the walk keys drive — derived from
  // the probe, not invented, so a rebind moves both pages at once.
  if (fwd.length) out.vehicle.push({ label: 'Accelerează', keys: fwd });
  if (back.length) out.vehicle.push({ label: 'Frânează / marșarier', keys: back });
  const steer = [...(byMove.get('left') ?? []), ...(byMove.get('right') ?? [])].map(glyph);
  if (steer.length) out.vehicle.push({ label: 'Virează', keys: steer });

  for (const a of ALL_ACTIONS) {
    const info = ACTION_INFO[a];
    if (!info) continue;
    if (a === 'handbrake' && handbrakeKeys.length) continue;
    const keys = byAction.get(a);
    if (!keys?.length) continue;
    out[info.group].push({ label: info.label, keys: keys.map(glyph) });
  }
  if (handbrakeKeys.length) {
    out.vehicle.push({
      label: ACTION_INFO.handbrake?.label ?? 'Frână de mână',
      keys: handbrakeKeys.map(glyph),
    });
  }

  return out;
}

function push(map: Map<string, string[]>, id: string, code: string): void {
  const list = map.get(id) ?? [];
  if (!list.includes(code)) list.push(code);
  map.set(id, list);
}
