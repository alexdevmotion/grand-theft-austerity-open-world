/**
 * CONTINUE — the front-end's view of the save slot.
 *
 * WHAT CHANGED
 * ------------
 * This file used to *be* the save system, and it was honest about how little
 * that amounted to: it remembered which act you were on, and CONTINUE restarted
 * that act. Level, XP, unlocks, money, position and time of day all evaporated
 * on reload, because the service seam had no way to put them back.
 *
 * The seam has them now (`MissionService.restore`, `ProgressionService.restore`)
 * and the real save lives in `src/core/save.ts`, registered as a system and
 * published as `Services.Save`. This file is what it always should have been:
 * the *presentation* of that record — is there something to continue, and what
 * does the yellow sub-label under CONTINUE say.
 *
 * The record shape, the storage slot and the parsing are re-exported from the
 * core module under their old names so the front-end keeps compiling against
 * one vocabulary; there is exactly one implementation behind them.
 */

import {
  clearSave,
  emptySave,
  isResumable as isResumableSave,
  loadSave,
  parseSave,
  writeSave,
} from '../../core/save';
import type { SaveRecord } from '../../core/services';
import { t, tp } from '../../core/i18n';

/** The front-end's name for the save record. Same object, same slot. */
export type SessionRecord = SaveRecord;

export const emptySession = emptySave;
export const parseSession = parseSave;
export const loadSession = loadSave;
export const saveSession = writeSave;
export const clearSession = clearSave;

/** `true` when the record describes something worth resuming. */
export function isResumable(r: SessionRecord | null): r is SessionRecord {
  return isResumableSave(r);
}

/** "ACTUL II · NIVEL 3 · 12 MIN" — the yellow sub-label for the CONTINUE row. */
export function describeSession(r: SessionRecord | null, now = Date.now()): string {
  if (!isResumable(r)) return t('NICIUN PROGRES SALVAT');
  const bits: string[] = [];
  const act = actNumber(r.actId, r.completed);
  if (act > 0) bits.push(tp('ACTUL {n}', { n: roman(act) }));
  if (r.level > 1) bits.push(tp('NIVEL {n}', { n: r.level }));
  const mins = Math.floor(r.playSeconds / 60);
  if (mins >= 1) bits.push(tp('{n} MIN', { n: mins }));
  const ago = agoLabel(now - r.savedAt);
  if (ago) bits.push(ago);
  return bits.join(' · ') || t('SESIUNE SALVATĂ');
}

/** Act number from an id like `act3_termsheet`, else one past the completed run. */
export function actNumber(actId: string | null, completed: readonly string[]): number {
  const m = actId?.match(/act(\d)/);
  if (m) return Number(m[1]);
  let best = 0;
  for (const c of completed) {
    const k = c.match(/act(\d)/);
    if (k) best = Math.max(best, Number(k[1]));
  }
  return best > 0 ? Math.min(4, best + 1) : 0;
}

export function roman(n: number): string {
  return ['0', 'I', 'II', 'III', 'IV', 'V'][n] ?? String(n);
}

function agoLabel(ms: number): string {
  if (!(ms > 0)) return '';
  const min = ms / 60000;
  if (min < 2) return t('ACUM');
  if (min < 60) return tp('{n} MIN ÎN URMĂ', { n: Math.round(min) });
  const h = min / 60;
  if (h < 24) return tp('{n} H ÎN URMĂ', { n: Math.round(h) });
  return tp('{n} ZILE ÎN URMĂ', { n: Math.round(h / 24) });
}
