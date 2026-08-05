/**
 * SAVE / LOAD.
 *
 * WHAT IT USED TO BE
 * ------------------
 * Nothing. The front-end's CONTINUE row remembered which act you were on and,
 * on resume, restarted that act — level, XP, unlocks, money, where you were
 * standing and what time of day it was all evaporated on reload. The old
 * `src/ui/menu/session.ts` said so honestly in its header, because the seam
 * genuinely could not put any of it back: `MissionService` only had `start`,
 * `ProgressionService` only had `addXp`, `PlayerService` only had `addLei`.
 *
 * WHAT IT IS NOW
 * --------------
 * `MissionService.restore` and `ProgressionService.restore` were added to the
 * seam; money and position go back through the existing `addLei` / `teleport`,
 * which already do the right thing (`addLei` even re-fires `economy:changed`,
 * so the HUD updates itself). This system is the one place that knows the whole
 * shape, and it is deliberately the ONLY place that touches `localStorage` for
 * game state — settings live in their own slot, owned by the pause menu.
 *
 * WHAT IS SAVED
 *   completed acts + the act in progress · XP, level, unlocks, discovered
 *   landmarks · lei · player position and heading · time of day and weather
 *
 * WHAT IS NOT, AND WHY
 *   the objective you were on inside an act (an act is a chain of world side
 *   effects; replaying the act is honest, faking its middle is not), traffic,
 *   pedestrians and the vehicle you were driving (all ambient and respawned),
 *   and your Crisis Stars (a save that reloads you into a police chase is a
 *   save nobody wants).
 *
 * WHEN IT WRITES
 *   every 20 s of play, on every act completed, on every level-up, when the
 *   pause menu opens, and on `pagehide` — so closing the tab keeps your run.
 */

import * as THREE from 'three';
import type { GameContext, System } from './engine';
import { Services, type SaveRecord, type SaveService, type WeatherPreset } from './services';
import { tp } from './i18n';

/** Presets a save is allowed to name. Anything else falls back to the default,
 *  so a slot written by an older build cannot poke an unknown preset in. */
const PRESETS: readonly WeatherPreset[] = [
  'clearSunset', 'rain', 'stormRain', 'fogDusk', 'overcast', 'night',
];

function presetOr(v: string, d: WeatherPreset): WeatherPreset {
  return (PRESETS as readonly string[]).includes(v) ? (v as WeatherPreset) : d;
}

/** Slot key. Kept from the old CONTINUE record: its fields are a subset of
 *  this one, so an existing slot still loads, it just restores less. */
export const SAVE_KEY = 'gta.session.v1';

/** Seconds of play between automatic writes. */
const AUTOSAVE_SECONDS = 20;

export function emptySave(): SaveRecord {
  return {
    actId: null,
    actTitle: '',
    completed: [],
    level: 1,
    xp: 0,
    unlocks: [],
    discovered: [],
    lei: 0,
    pos: null,
    heading: 0,
    timeOfDay: 19.5,
    weather: 'clearSunset',
    savedAt: 0,
    playSeconds: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Serialisation — pure, DOM-free, and defensive                       */
/* ------------------------------------------------------------------ */

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function triple(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [x, y, z] = v;
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return [x as number, y as number, z as number];
}

/**
 * Parse a slot. A corrupt, truncated or older record must never break boot, so
 * every field is validated and defaulted individually rather than trusted as a
 * blob. `savedAt` is the one field that decides whether a record exists at all.
 */
export function parseSave(raw: string | null): SaveRecord | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.savedAt !== 'number' || !(o.savedAt > 0)) return null;

  const base = emptySave();
  return {
    actId: typeof o.actId === 'string' ? o.actId : null,
    actTitle: typeof o.actTitle === 'string' ? o.actTitle : '',
    completed: strings(o.completed),
    level: Math.max(1, Math.round(num(o.level, base.level))),
    xp: Math.max(0, num(o.xp, base.xp)),
    unlocks: strings(o.unlocks),
    discovered: strings(o.discovered),
    lei: Math.max(0, num(o.lei, base.lei)),
    pos: triple(o.pos),
    heading: num(o.heading, 0),
    timeOfDay: clampHours(num(o.timeOfDay, base.timeOfDay)),
    weather: typeof o.weather === 'string' ? o.weather : base.weather,
    savedAt: o.savedAt,
    playSeconds: Math.max(0, num(o.playSeconds, 0)),
  };
}

function clampHours(h: number): number {
  const v = h % 24;
  return v < 0 ? v + 24 : v;
}

export function loadSave(): SaveRecord | null {
  try {
    return parseSave(localStorage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

export function writeSave(r: SaveRecord): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(r));
  } catch {
    /* private mode / quota — the run just does not survive the tab */
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

/** `true` when the record describes something worth resuming. */
export function isResumable(r: SaveRecord | null): r is SaveRecord {
  if (!r) return false;
  return !!r.actId || r.completed.length > 0 || r.playSeconds > 45 || r.level > 1 || r.xp > 0;
}

/* ------------------------------------------------------------------ */
/* The system                                                          */
/* ------------------------------------------------------------------ */

const _p = new THREE.Vector3();

export class SaveSystem implements System, SaveService {
  readonly name = 'save';
  /** After everything it reads: player 200, progression 215, missions 220. */
  readonly order = 260;
  // Deliberately NOT `ticksWhenPaused`: a paused game accrues no play time and
  // has nothing new to write. The pause menu calls `save()` directly instead.

  private ctx!: GameContext;
  private clock = 0;
  private _playSeconds = 0;
  private slot: SaveRecord | null = null;
  private detach: Array<() => void> = [];
  /** Raised while `restore()` runs, so autosave cannot race the load. */
  private restoring = false;
  /**
   * HAS THE PLAYER ACTUALLY BEEN IN THE WORLD THIS SESSION?
   *
   * Nothing may write over a slot until they have. `_playSeconds` is seeded
   * from the loaded slot so play time accumulates across sessions, which means
   * a returning player sits on the title screen with `playSeconds = 1450` —
   * and any length-of-session guard would happily let `pagehide` overwrite
   * their level-5 run with the level-1 default state of a world they never
   * entered. Observed doing exactly that during verification. Set on the first
   * unpaused tick: the front-end holds the world paused until START/CONTINUE.
   */
  private entered = false;

  get playSeconds(): number {
    return this._playSeconds;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Save, this);

    this.slot = loadSave();
    this._playSeconds = this.slot?.playSeconds ?? 0;

    // The beats worth never losing.
    this.detach.push(ctx.events.on('mission:complete', () => this.save('act')));
    this.detach.push(ctx.events.on('progression:levelUp', () => this.save('nivel')));

    // Closing the tab is the most common way a run ends. `pagehide` is the
    // only event that fires reliably on mobile Safari and on tab discard;
    // `beforeunload` does not.
    if (typeof window !== 'undefined') {
      const onHide = (): void => {
        this.save('ieșire');
      };
      window.addEventListener('pagehide', onHide);
      this.detach.push(() => window.removeEventListener('pagehide', onHide));
    }

    this.installDebugHook();
  }

  /* ---------------------------------------------------------------- */

  capture(): SaveRecord {
    const ctx = this.ctx;
    const base = this.slot ?? emptySave();
    const missions = ctx.tryGet(Services.Missions);
    const prog = ctx.tryGet(Services.Progression);
    const player = ctx.tryGet(Services.Player);
    const weather = ctx.tryGet(Services.Weather);

    let pos: [number, number, number] | null = base.pos;
    let heading = base.heading;
    if (player) {
      // On foot the character is the truth; in a car, the car is — and either
      // way the save must put you back on the pavement, not inside a wreck.
      _p.copy(player.inVehicle ? player.inVehicle.position : player.position);
      pos = [_p.x, _p.y, _p.z];
      heading = player.character?.object?.rotation.y ?? heading;
    }

    return {
      actId: missions?.currentId ?? null,
      // Only meaningful alongside an act id; a stale title on a free-roam slot
      // is a lie the CONTINUE row would eventually print.
      actTitle: missions?.currentId ? missions.currentTitle : '',
      completed: missions ? [...missions.completed] : base.completed,
      level: prog?.level ?? base.level,
      xp: prog?.xp ?? base.xp,
      unlocks: prog ? [...prog.unlocks] : base.unlocks,
      discovered: prog ? [...prog.discovered] : base.discovered,
      lei: player?.lei ?? base.lei,
      pos,
      heading,
      timeOfDay: weather?.timeOfDay ?? base.timeOfDay,
      weather: weather?.preset ?? base.weather,
      savedAt: Date.now(),
      playSeconds: this._playSeconds,
    };
  }

  /**
   * `reason` is not decoration: it is in the `save:written` event and it is the
   * only thing that tells an autosave from the player pressing SALVEAZĂ. Only
   * the explicit one may write before the world has been entered.
   */
  save(reason = 'auto'): SaveRecord {
    if (!this.entered && reason !== 'manual') {
      // Refuse rather than throw: callers are pollers and unload handlers, and
      // a rejected save must look exactly like a save with nothing new in it.
      return this.slot ?? emptySave();
    }
    const rec = this.capture();
    this.slot = rec;
    writeSave(rec);
    this.ctx.events.emit('save:written', { reason, savedAt: rec.savedAt });
    return rec;
  }

  peek(): SaveRecord | null {
    return this.slot;
  }

  /**
   * BEST EFFORT, STAGE BY STAGE.
   *
   * A load touches five independent subsystems. If they are restored inside one
   * `try`, a throw anywhere — a mission id that no longer exists, a weather
   * preset that was renamed — silently costs the player everything after it,
   * and the caller sees only "resume failed". So each stage is isolated: one
   * broken stage loses one stage, the rest of the run comes back, and exactly
   * what failed is recorded on `__GTA_SAVE__.state().lastRestore` instead of
   * being inferred from a player saying "my money is gone".
   */
  restore(r: SaveRecord): void {
    const ctx = this.ctx;
    this.restoring = true;
    const failed: string[] = [];
    const stage = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        failed.push(name);
        console.error(`[save] restoring "${name}" failed:`, err);
      }
    };

    try {
      const player = ctx.tryGet(Services.Player);

      stage('progression', () => {
        ctx.tryGet(Services.Progression)?.restore({
          xp: r.xp,
          level: r.level,
          unlocks: r.unlocks,
          discovered: r.discovered,
        });
      });

      stage('lei', () => {
        if (!player) return;
        // `addLei` is the seam's only money verb and it re-fires
        // `economy:changed`, which is exactly what the HUD needs anyway.
        const delta = r.lei - player.lei;
        if (delta !== 0) player.addLei(delta, 'încărcare');
      });

      stage('weather', () => {
        const weather = ctx.tryGet(Services.Weather);
        if (!weather) return;
        weather.timeOfDay = r.timeOfDay;
        weather.set(presetOr(r.weather, 'clearSunset'), 0.1);
      });

      // Missions before position: `restore` re-enters the saved act, which
      // places markers and can move the player.
      stage('missions', () => {
        ctx.tryGet(Services.Missions)?.restore(r.completed, r.actId);
      });

      // …and the position last of all, for the same reason.
      stage('position', () => {
        if (!player || !r.pos) return;
        if (player.inVehicle) player.exitVehicle();
        player.teleport(new THREE.Vector3(r.pos[0], r.pos[1] + 0.25, r.pos[2]), r.heading);
      });

      // A load must never drop you into a chase you cannot see coming.
      stage('wanted', () => ctx.tryGet(Services.Wanted)?.clear());

      this.slot = r;
      this._playSeconds = r.playSeconds;
      this.clock = 0;
      // A restore IS entering the world — CONTINUE unpauses a frame later, and
      // the run must be saveable from that moment.
      this.entered = true;
      this.lastRestore = { savedAt: r.savedAt, failed };
      ctx.events.emit('save:restored', { savedAt: r.savedAt });
      if (failed.length) {
        ctx.tryGet(Services.Hud)?.toast(
          tp('Salvarea s-a încărcat parțial ({failed})', { failed: failed.join(', ') }), 'bad', 5200,
        );
      }
    } finally {
      this.restoring = false;
    }
  }

  /** What the last `restore()` managed, for the harness and for bug reports. */
  lastRestore: { savedAt: number; failed: string[] } | null = null;

  resume(): boolean {
    const r = loadSave();
    if (!isResumable(r)) return false;
    this.restore(r);
    return true;
  }

  clear(): void {
    clearSave();
    this.slot = null;
    this._playSeconds = 0;
    this.clock = 0;
  }

  /* ---------------------------------------------------------------- */

  update(dt: number): void {
    if (this.restoring) return;
    // `update` only runs unpaused, and every menu in the game pauses the world,
    // so reaching here at all means the player is in București.
    this.entered = true;
    this._playSeconds += dt;
    this.clock += dt;
    if (this.clock < AUTOSAVE_SECONDS) return;
    this.clock = 0;
    this.save('auto');
  }

  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_SAVE__: unknown }).__GTA_SAVE__ = {
      state: () => ({
        slot: this.slot,
        playSeconds: Math.round(this._playSeconds),
        lastRestore: this.lastRestore,
      }),
      capture: () => this.capture(),
      save: () => this.save('debug'),
      peek: () => loadSave(),
      resume: () => this.resume(),
      restore: (r: SaveRecord) => this.restore(r),
      clear: () => this.clear(),
    };
  }

  dispose(): void {
    for (const d of this.detach) d();
    this.detach.length = 0;
  }
}
