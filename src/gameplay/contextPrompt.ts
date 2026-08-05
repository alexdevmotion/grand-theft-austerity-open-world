/**
 * CONTEXTUAL ACTION PROMPT — "what would happen if I pressed something, here".
 *
 * The interaction system already prints a keycap for anything in its registry:
 * Nicușor, the server, a doorway. Everything *else* the world offers was silent.
 * Stand next to a parked Dacia and nothing told you E gets you in; stand in
 * front of a builder and nothing named the punch. A player who never opened the
 * CONTROLS page had to guess.
 *
 * This is the decision half — pure, so the priority order is unit-tested rather
 * than eyeballed in a screenshot. `src/gameplay/interaction.ts` measures the
 * world, calls this, and draws whatever comes back into the prompt it already
 * owns. A registered interactable always wins: it is the one that actually
 * claims the E press.
 */

import { hintKeys } from '../core/keyHints';
import { t, tp } from '../core/i18n';
import type { VehicleClass } from '../core/services';

/** How close, on foot, before the "get in" prompt appears. */
export const VEHICLE_PROMPT_RANGE = 3.6;
/** Arm's reach — a crowd is not a prompt. */
export const PERSON_PROMPT_RANGE = 2.3;
/** Below this speed, sitting in a car, the "get out" prompt is useful. */
export const EXIT_PROMPT_SPEED = 1.6;

export const VEHICLE_LABELS: Record<VehicleClass, string> = {
  dacia: 'Dacia',
  sedan: 'mașină',
  hatch: 'mașină',
  van: 'furgonetă',
  truck: 'camion',
  bus: 'autobuz',
  police: 'mașina poliției',
  tram: 'tramvai',
  scooter: 'scuter',
};

export interface ContextState {
  /** Nearest enterable vehicle within `VEHICLE_PROMPT_RANGE`, on foot. */
  readonly nearVehicle: VehicleClass | null;
  /** Seated, and slow enough that stepping out is a sane suggestion. */
  readonly seatedStopped: boolean;
  /** A living pedestrian within `PERSON_PROMPT_RANGE`, roughly in front. */
  readonly nearPerson: boolean;
}

export interface ContextPromptView {
  /** Stable id, so the DOM is only rewritten when the prompt really changes. */
  readonly id: string;
  readonly keys: readonly string[];
  readonly label: string;
  readonly color: number;
}

const TEAL = 0x4ad6c4;
const GOLD = 0xffb020;

/**
 * One prompt at a time, in the order that matters: the car you are standing at,
 * then the car you are sitting in, then the person in front of you. Returns
 * `null` when the world has nothing to offer here.
 */
export function contextPrompt(s: ContextState): ContextPromptView | null {
  if (s.nearVehicle) {
    const keys = hintKeys('interact');
    if (keys.length) {
      return {
        id: `veh:${s.nearVehicle}`,
        keys,
        // The vehicle noun is translated separately from the sentence: English
        // wants "Get into the car", Romanian "Urcă în mașină", and only the
        // template knows where the article goes.
        label: tp('Urcă în {vehicle}', { vehicle: t(VEHICLE_LABELS[s.nearVehicle]) }),
        color: TEAL,
      };
    }
  }
  if (s.seatedStopped) {
    const keys = hintKeys('interact');
    if (keys.length) return { id: 'veh:exit', keys, label: t('Coboară din mașină'), color: TEAL };
  }
  if (s.nearPerson) {
    const keys = hintKeys('punch');
    if (keys.length) return { id: 'ped', keys, label: t('Lovește'), color: GOLD };
  }
  return null;
}
