/**
 * PER-FRAME NUMBERS THE HUD DRAWS.
 *
 * The event bus carries everything that *happens* — a mission advanced, an
 * activity finished, XP landed. It cannot carry a countdown, because a
 * countdown changes sixty times a second and the bus is not a polling
 * mechanism.
 *
 * `GameEvents` and `HudService` are both frozen (src/core/), so a new event or
 * a `HudService.setTimer` is not available. This is the alternative: a plain
 * data record written by the gameplay systems that own the numbers and read by
 * `src/ui/hud.ts`. No classes cross the seam, which is the part of the rule
 * that matters — nothing here couples the HUD to a mission implementation.
 */

export interface MissionHudState {
  active: boolean;
  title: string;
  objective: string;
  hint: string;
  /** Seconds remaining, or null when the objective is untimed. */
  timeLeft: number | null;
  /** 0..1 for "hold this position" objectives. */
  hold: number;
  /** 1-based objective number and total, for "2/4". */
  step: number;
  steps: number;
  /** Set for a few seconds after a failure so the HUD can say why. */
  failed: string;
}

export interface ActivityHudState {
  active: boolean;
  name: string;
  kind: string;
  /** Seconds remaining. */
  timeLeft: number;
  score: number;
  /** "3/5 livrări" — whatever the activity counts. */
  progress: string;
  /** Set briefly when an activity ends, for the result card. */
  result: string;
  resultGood: boolean;
}

export const missionHud: MissionHudState = {
  active: false,
  title: '',
  objective: '',
  hint: '',
  timeLeft: null,
  hold: 0,
  step: 0,
  steps: 0,
  failed: '',
};

export const activityHud: ActivityHudState = {
  active: false,
  name: '',
  kind: '',
  timeLeft: 0,
  score: 0,
  progress: '',
  result: '',
  resultGood: false,
};

export function resetMissionHud(): void {
  missionHud.active = false;
  missionHud.title = '';
  missionHud.objective = '';
  missionHud.hint = '';
  missionHud.timeLeft = null;
  missionHud.hold = 0;
  missionHud.step = 0;
  missionHud.steps = 0;
}

export function resetActivityHud(): void {
  activityHud.active = false;
  activityHud.name = '';
  activityHud.kind = '';
  activityHud.timeLeft = 0;
  activityHud.score = 0;
  activityHud.progress = '';
}
