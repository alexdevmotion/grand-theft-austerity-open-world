/**
 * THE FIRST-RUN WALKTHROUGH, AS DATA.
 *
 * One step at a time, in the order a player actually needs it: look, walk, run,
 * press E on the marker, get in a car, drive it, open the map, find the pause
 * menu. Each step names the keys it teaches (resolved from the real input
 * tables, never typed out) and the observable fact that proves the player did
 * it. Nothing here blocks: every step also has a patience, and when that runs
 * out the guide moves on rather than nagging.
 *
 * Kept separate from `walkthrough.ts` so the copy, the order and the completion
 * rules can be unit-tested without a DOM, a world or a player.
 */

import type { HintId } from '../core/keyHints';

export type StepId = 'look' | 'walk' | 'sprint' | 'interact' | 'vehicle' | 'drive' | 'map' | 'pause';

/** Everything the guide is allowed to know about what the player has done. */
export interface WalkSignals {
  /** Metres travelled on foot since the step began. */
  walkedMeters: number;
  /** Radians of camera look accumulated since the step began. */
  lookedRadians: number;
  /** Seconds spent sprinting since the step began. */
  sprintSeconds: number;
  /** `player:interact` fired — an E press that actually hit something. */
  interacted: boolean;
  inVehicle: boolean;
  /** Metres driven since the step began. */
  drivenMeters: number;
  mapOpened: boolean;
  pausePressed: boolean;
}

export interface WalkStep {
  readonly id: StepId;
  /** Keys shown as chips on the card. */
  readonly hints: readonly HintId[];
  /** The instruction, imperative, Romanian. */
  readonly title: string;
  /** One line of why, or where to look. */
  readonly body: string;
  /** Seconds before the guide gives up on this step and moves on. */
  readonly seconds: number;
  /** The observable fact that proves it was done. */
  readonly done: (s: WalkSignals) => boolean;
}

export const WALK_STEPS: readonly WalkStep[] = [
  {
    id: 'look',
    hints: ['look'],
    title: 'Mișcă mouse-ul ca să te uiți în jur',
    body: 'Clic o dată în fereastră dacă nu se mișcă nimic — jocul are nevoie de mouse.',
    seconds: 22,
    done: (s) => s.lookedRadians >= 2,
  },
  {
    id: 'walk',
    hints: ['move'],
    title: 'Mergi prin piață',
    body: 'Cele patru taste care te duc oriunde în București.',
    seconds: 28,
    done: (s) => s.walkedMeters >= 8,
  },
  {
    id: 'sprint',
    hints: ['sprint'],
    title: 'Ține SHIFT ca să alergi',
    body: 'Ministerul nu te așteaptă.',
    seconds: 22,
    done: (s) => s.sprintSeconds >= 1,
  },
  {
    id: 'interact',
    hints: ['interact'],
    title: 'Urmează marcajul auriu și apasă E',
    body: 'Diamantele violet sunt tot ce poți atinge: oameni, uși, obiective.',
    seconds: 55,
    done: (s) => s.interacted,
  },
  {
    id: 'vehicle',
    hints: ['interact'],
    title: 'Găsește o mașină și urcă la volan',
    body: 'Apasă E lângă ea. Dacia galbenă e a ta, restul se împrumută.',
    seconds: 70,
    done: (s) => s.inVehicle,
  },
  {
    id: 'drive',
    hints: ['drive', 'steer', 'handbrake'],
    title: 'Condu până la capătul bulevardului',
    body: 'Frâna de mână e pentru colțuri și pentru poliție.',
    seconds: 60,
    done: (s) => s.drivenMeters >= 80,
  },
  {
    id: 'map',
    hints: ['map'],
    title: 'Deschide harta',
    body: 'Tot orașul, cu obiectivul și activitățile pe el.',
    seconds: 28,
    done: (s) => s.mapOpened,
  },
  {
    id: 'pause',
    hints: ['pause'],
    title: 'Restul comenzilor sunt în meniul de pauză',
    body: 'Acolo găsești lista completă, setările și salvarea. Succes, constructor.',
    seconds: 24,
    done: (s) => s.pausePressed,
  },
];

/** Empty signals — the system resets to this at the start of every step. */
export function noSignals(): WalkSignals {
  return {
    walkedMeters: 0,
    lookedRadians: 0,
    sprintSeconds: 0,
    interacted: false,
    inVehicle: false,
    drivenMeters: 0,
    mapOpened: false,
    pausePressed: false,
  };
}

export type StepOutcome = 'hold' | 'cleared' | 'timeout';

/**
 * What should happen to the step on screen. `cleared` earns the tick and the
 * flash; `timeout` moves on quietly — a player fighting the police does not
 * need a lecture about the map.
 */
export function stepOutcome(step: WalkStep, s: WalkSignals, elapsed: number): StepOutcome {
  if (step.done(s)) return 'cleared';
  return elapsed >= step.seconds ? 'timeout' : 'hold';
}

/** `2/8` for the card's kicker. */
export function stepCounter(index: number, total = WALK_STEPS.length): string {
  return `${Math.min(index + 1, total)}/${total}`;
}
