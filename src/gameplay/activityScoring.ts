/**
 * HOW A SIDE ACTIVITY IS SCORED — pure arithmetic, no engine.
 *
 * Every activity resolves to one number, because one number is what
 * `activity:finished` carries and what `ProgressionSystem` turns into XP. The
 * rules each kind uses to get there are here so they can be tested, tuned and
 * compared without a browser (`activityScoring.test.ts`).
 *
 * DESIGN RULES
 *  - a completed run always scores more than an abandoned one
 *  - finishing faster always scores more, never less
 *  - a failed run scores exactly 0, so `score > 0` is a clean "did they win"
 *  - scores land in the low hundreds to low thousands, which is the range the
 *    level curve in `progression.ts` was built against
 */

export type ActivityKind = 'courier' | 'race' | 'evade' | 'photo';

export type Medal = 'none' | 'bronze' | 'silver' | 'gold';

/** Score floor for finishing at all, per kind. */
export const BASE_SCORE: Record<ActivityKind, number> = {
  courier: 150,
  race: 220,
  evade: 260,
  photo: 130,
};

/** Gold / silver / bronze thresholds, per kind. */
export const MEDALS: Record<ActivityKind, [number, number, number]> = {
  courier: [520, 380, 220],
  race: [760, 520, 300],
  evade: [820, 560, 330],
  photo: [460, 330, 190],
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * COURIER. Deliver a server / a coffee / a drive against the clock.
 * `deliveries` of `required` made, `secondsLeft` of `limit` remaining.
 */
export function courierScore(
  deliveries: number,
  required: number,
  secondsLeft: number,
  limit: number,
): number {
  if (required <= 0 || deliveries < required || secondsLeft <= 0) return 0;
  const spare = clamp01(secondsLeft / Math.max(1, limit));
  return Math.round(BASE_SCORE.courier + required * 60 + spare * 420);
}

/**
 * RACE. `elapsed` seconds over `checkpoints`, against a `par` time. Beating
 * par doubles the time component; twice par gives none of it.
 */
export function raceScore(elapsed: number, par: number, checkpoints: number): number {
  if (elapsed <= 0 || par <= 0 || checkpoints <= 0) return 0;
  const ratio = par / elapsed;                       // >1 = faster than par
  const pace = clamp01((ratio - 0.5) / 1.0);         // 0 at 2x par, 1 at par
  return Math.round(BASE_SCORE.race + checkpoints * 45 + pace * 520);
}

/**
 * EVADE THE MINISTRY. Survive `survived` of `target` seconds at up to
 * `peakStars`, then lose them. Escaping early still pays: the challenge is
 * "get away", not "get away slowly".
 */
export function evadeScore(survived: number, target: number, peakStars: number, escaped: boolean): number {
  if (!escaped || target <= 0) return 0;
  const held = clamp01(survived / target);
  return Math.round(BASE_SCORE.evade + held * 320 + Math.max(0, peakStars) * 95);
}

/**
 * PHOTO BOUNTY. `shots` of `required` Georgescu billboards, `secondsLeft` of
 * `limit`. Rushed shots are worth the same as careful ones; the clock is the
 * only pressure.
 */
export function photoScore(shots: number, required: number, secondsLeft: number, limit: number): number {
  if (required <= 0 || shots < required || secondsLeft <= 0) return 0;
  const spare = clamp01(secondsLeft / Math.max(1, limit));
  return Math.round(BASE_SCORE.photo + required * 55 + spare * 300);
}

/** Lei paid out for a score. Level 5's `payday` unlock multiplies this. */
export function leiReward(kind: ActivityKind, score: number, multiplier = 1): number {
  if (score <= 0) return 0;
  const rate = kind === 'evade' ? 1.5 : kind === 'race' ? 1.25 : 1.0;
  return Math.round(score * rate * multiplier);
}

export function medalFor(kind: ActivityKind, score: number): Medal {
  const [g, s, b] = MEDALS[kind];
  if (score >= g) return 'gold';
  if (score >= s) return 'silver';
  if (score >= b) return 'bronze';
  return score > 0 ? 'bronze' : 'none';
}

export const MEDAL_LABEL: Record<Medal, string> = {
  none: '—',
  bronze: 'BRONZ',
  silver: 'ARGINT',
  gold: 'AUR',
};
