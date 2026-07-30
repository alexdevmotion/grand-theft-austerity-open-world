/**
 * CONTINUE — the last-session record behind the front-end's second menu row.
 *
 * WHY IT LIVES HERE AND WHAT IT HONESTLY IS
 * -----------------------------------------
 * There is no save system in the service seam: `MissionService` exposes
 * `start(id)` and a readonly `completed` set, `ProgressionService` exposes
 * `addXp`, `PlayerService` exposes `addLei`. None of them can be *restored*.
 * So CONTINUE does the most it can do without inventing state it cannot put
 * back: it remembers which act you were on (plus the acts you had finished, and
 * the level/lei you had reached, purely to describe the slot on screen), and on
 * resume it re-enters the world and restarts that act.
 *
 * The record is written by the menu system while you play — it polls the same
 * read-only service getters the HUD uses — so it never needs a hook that does
 * not exist. See the report accompanying this work: a real
 * `MissionService.restore(state)` is the missing piece.
 */

const STORAGE_KEY = 'gta.session.v1';

export interface SessionRecord {
  /** Campaign act id, or null when the player only free-roamed. */
  actId: string | null;
  /** Human act title as the mission system reported it. */
  actTitle: string;
  /** Act ids already finished, most recent last. */
  completed: string[];
  level: number;
  lei: number;
  /** Wall-clock ms when the record was written. */
  savedAt: number;
  /** Seconds of play in the session that wrote this record. */
  playSeconds: number;
}

export function emptySession(): SessionRecord {
  return {
    actId: null,
    actTitle: '',
    completed: [],
    level: 1,
    lei: 0,
    savedAt: 0,
    playSeconds: 0,
  };
}

/** Parse defensively: a corrupt or half-written slot must never break boot. */
export function parseSession(raw: string | null): SessionRecord | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Partial<SessionRecord>;
  if (typeof o.savedAt !== 'number' || !(o.savedAt > 0)) return null;
  return {
    actId: typeof o.actId === 'string' ? o.actId : null,
    actTitle: typeof o.actTitle === 'string' ? o.actTitle : '',
    completed: Array.isArray(o.completed) ? o.completed.filter((x): x is string => typeof x === 'string') : [],
    level: numOr(o.level, 1),
    lei: numOr(o.lei, 0),
    savedAt: o.savedAt,
    playSeconds: numOr(o.playSeconds, 0),
  };
}

export function loadSession(): SessionRecord | null {
  try {
    return parseSession(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveSession(r: SessionRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* private mode — the slot just does not survive the session */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** `true` when the record describes something worth resuming. */
export function isResumable(r: SessionRecord | null): r is SessionRecord {
  if (!r) return false;
  return !!r.actId || r.completed.length > 0 || r.playSeconds > 45 || r.level > 1;
}

/** "ACTUL II · NIVEL 3 · 12 MIN" — the yellow sub-label for the CONTINUE row. */
export function describeSession(r: SessionRecord | null, now = Date.now()): string {
  if (!isResumable(r)) return 'NICIUN PROGRES SALVAT';
  const bits: string[] = [];
  const act = actNumber(r.actId, r.completed);
  if (act > 0) bits.push(`ACTUL ${roman(act)}`);
  if (r.level > 1) bits.push(`NIVEL ${r.level}`);
  const mins = Math.floor(r.playSeconds / 60);
  if (mins >= 1) bits.push(`${mins} MIN`);
  const ago = agoLabel(now - r.savedAt);
  if (ago) bits.push(ago);
  return bits.join(' · ') || 'SESIUNE SALVATĂ';
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
  if (min < 2) return 'ACUM';
  if (min < 60) return `${Math.round(min)} MIN ÎN URMĂ`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} H ÎN URMĂ`;
  return `${Math.round(h / 24)} ZILE ÎN URMĂ`;
}

function numOr(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
