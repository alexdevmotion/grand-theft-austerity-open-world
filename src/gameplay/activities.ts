/** Side activities — the reason to free-roam.
 *
 *  Ten repeatable, scored challenges in four kinds (`src/content/activities.ts`):
 *  courier runs against the clock, boulevard races, evade-the-Ministry
 *  challenges and photo bounties on Georgescu's propaganda screens.
 *
 *  Each one is a small state machine over an ordered list of world points.
 *  What differs between kinds is only how a point is *cleared* — drive through
 *  it, stand at it, or press E while looking at it — and how the run is
 *  scored. The scoring is pure and lives in `activityScoring.ts`, so the
 *  balance is testable without a browser.
 *
 *  Markers and prompts come from the interaction system that `MissionSystem`
 *  owns; this borrows it rather than running a second registry, because two
 *  registries would fight over the same `interact` press.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type ActivityService, type HudService } from '../core/services';
import { ACTIVITIES, ACTIVITIES_BY_ID, KIND_LABEL, type ActivityDef } from '../content/activities';
import {
  MEDAL_LABEL,
  courierScore,
  evadeScore,
  leiReward,
  medalFor,
  photoScore,
  raceScore,
} from './activityScoring';
import { sharedInteraction, type InteractionSystem } from './interaction';
import { activityHud, resetActivityHud } from './hudState';

const START_PREFIX = 'act:start:';
const STEP_ID = 'act:step';

interface Available {
  id: string;
  kind: string;
  position: THREE.Vector3;
  name: string;
}

interface Run {
  def: ActivityDef;
  step: number;
  elapsed: number;
  /** Evade: how long the stars have been up, and the highest reached. */
  survived: number;
  peakStars: number;
  hadStars: boolean;
}

const _v = new THREE.Vector3();

export class ActivitySystem implements System, ActivityService {
  readonly name = 'activities';
  readonly order = 230;

  private _available: Available[] = [];
  private _activeId: string | null = null;
  private ctx!: GameContext;
  private run: Run | null = null;
  private resultTimer = 0;
  /** Best score per activity, so a repeat has something to beat. */
  private best = new Map<string, number>();

  get available(): ReadonlyArray<Available> {
    return this._available;
  }
  get activeId(): string | null {
    return this._activeId;
  }
  /** Personal bests, for the HUD and the harness. */
  get records(): ReadonlyMap<string, number> {
    return this.best;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Activities, this);
    this.refreshAvailable();

    ctx.events.on('progression:levelUp', () => this.refreshAvailable());
    ctx.events.on('player:died', () => {
      if (this.run) this.finish(false, 'ai murit');
    });

    this.installDebugHook();
  }

  /* ---------------------------------------------------------------- */
  /* offer                                                             */
  /* ---------------------------------------------------------------- */

  private interaction(): InteractionSystem | null {
    return sharedInteraction();
  }

  private groundAt(x: number, z: number): number {
    const g = this.ctx.tryGet(Services.City)?.spatial.groundHeight(x, z) ?? 0;
    return g > -1e5 ? g : 0;
  }

  /** Rebuild the offer list — called at boot and on every level-up. */
  private refreshAvailable(): void {
    const prog = this.ctx.tryGet(Services.Progression);
    const it = this.interaction();
    it?.removeByPrefix(START_PREFIX);
    this._available = [];

    for (const def of ACTIVITIES) {
      if (def.requiresUnlock && !(prog?.has(def.requiresUnlock) ?? false)) continue;
      const p = new THREE.Vector3(def.x, this.groundAt(def.x, def.z), def.z);
      this._available.push({ id: def.id, kind: def.kind, position: p.clone(), name: def.name });
      it?.add({
        id: START_PREFIX + def.id,
        label: `${KIND_LABEL[def.kind]} — ${def.name}`,
        position: p,
        radius: 5.0,
        kind: 'activity',
        // Startable from the driver's seat: three of the four kinds want a car
        // and making you get out to accept them is pure friction.
        onFoot: false,
        requireLos: false,
        onTrigger: () => this.start(def.id),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /* run                                                               */
  /* ---------------------------------------------------------------- */

  start(id: string): void {
    const def = ACTIVITIES_BY_ID.get(id);
    if (!def) return;
    if (this.run) {
      this.toast('Termină provocarea curentă întâi', 'bad');
      return;
    }
    if (this.ctx.tryGet(Services.Missions)?.currentId) {
      this.toast('Nu în timpul unei misiuni', 'bad');
      return;
    }
    if (def.inVehicle && !this.ctx.tryGet(Services.Player)?.inVehicle) {
      this.toast('Ai nevoie de o mașină', 'bad');
      return;
    }

    this.run = { def, step: 0, elapsed: 0, survived: 0, peakStars: 0, hadStars: false };
    this._activeId = def.id;
    this.resultTimer = 0;
    activityHud.result = '';

    this.interaction()?.removeByPrefix(START_PREFIX);
    this.ctx.events.emit('activity:started', { id: def.id, kind: def.kind });
    this.hud()?.missionCard(`${KIND_LABEL[def.kind]} — ${def.name}`, def.blurb);

    if (def.kind === 'evade' && def.stars) {
      this.ctx.tryGet(Services.Wanted)?.setStars(def.stars);
    }
    this.enterStep();
    this.pushHud(this.run);
  }

  abandon(): void {
    if (!this.run) return;
    this.finish(false, 'abandonat');
  }

  private enterStep(): void {
    const run = this.run;
    if (!run) return;
    const it = this.interaction();
    it?.remove(STEP_ID);

    const pt = run.def.points[run.step];
    if (!pt) {
      this.hud()?.setWaypoint(null);
      return;
    }
    const p = new THREE.Vector3(pt.x, this.groundAt(pt.x, pt.z), pt.z);
    this.hud()?.setWaypoint(p.clone());

    // Photo bounties are the one kind you press a button for — and the only
    // one where WHERE YOU ARE LOOKING matters, which is exactly what the
    // interaction system's facing test already does.
    if (run.def.kind === 'photo') {
      it?.add({
        id: STEP_ID,
        label: `Fotografiază ${pt.label ?? 'ecranul'}`,
        position: p,
        radius: 9,
        kind: 'activity',
        onFoot: false,
        facing: 0.45,
        requireLos: false,
        onTrigger: () => this.clearStep(),
      });
    }
  }

  private clearStep(): void {
    const run = this.run;
    if (!run) return;
    run.step++;
    if (run.step >= run.def.points.length) {
      this.finish(true, '');
      return;
    }
    this.ctx.events.emit('audio:oneShot', { id: 'pickup', volume: 0.6 });
    this.toast(`${run.step}/${run.def.points.length}`, 'good', 1200);
    this.enterStep();
  }

  private finish(success: boolean, reason: string): void {
    const run = this.run;
    if (!run) return;
    const def = run.def;
    const score = success ? this.score(run) : 0;
    const prog = this.ctx.tryGet(Services.Progression);
    const mult = prog?.has('payday') ? 1.5 : 1;
    const lei = leiReward(def.kind, score, mult);
    const medal = medalFor(def.kind, score);
    const prev = this.best.get(def.id) ?? 0;

    this.interaction()?.remove(STEP_ID);
    this.hud()?.setWaypoint(null);
    this.run = null;
    this._activeId = null;

    if (score > 0) {
      this.ctx.tryGet(Services.Player)?.addLei(lei, `activitate:${def.id}`);
      if (score > prev) this.best.set(def.id, score);
      this.hud()?.missionCard(
        `${def.name} — ${MEDAL_LABEL[medal]}`,
        `${score} puncte · +${lei} lei${score > prev ? ' · record nou' : ''}`,
      );
      activityHud.result = `${def.name}: ${score} (${MEDAL_LABEL[medal]})`;
      activityHud.resultGood = true;
    } else {
      this.hud()?.missionCard(`${def.name} — EȘUAT`, reason || 'timp expirat');
      activityHud.result = `${def.name}: eșuat`;
      activityHud.resultGood = false;
    }
    this.resultTimer = 5;

    // `ProgressionSystem` already turns this score into XP.
    this.ctx.events.emit('activity:finished', {
      id: def.id, kind: def.kind, score, reward: lei,
    });

    // Repeatable: the start marker goes straight back.
    this.refreshAvailable();
    resetActivityHud();
  }

  private score(run: Run): number {
    const d = run.def;
    const left = Math.max(0, d.limit - run.elapsed);
    switch (d.kind) {
      case 'courier':
        return courierScore(run.step, Math.max(1, d.points.length - 1), left, d.limit);
      case 'race':
        return raceScore(run.elapsed, d.par ?? d.limit / 2, d.points.length);
      case 'evade':
        return evadeScore(run.survived, d.target ?? 60, run.peakStars, true);
      case 'photo':
        return photoScore(run.step, d.points.length, left, d.limit);
      default:
        return 0;
    }
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    if (this.resultTimer > 0) {
      this.resultTimer -= dt;
      if (this.resultTimer <= 0) activityHud.result = '';
    }

    const run = this.run;
    if (!run) return;

    run.elapsed += dt;
    if (run.elapsed >= run.def.limit) {
      this.finish(false, 'timp expirat');
      return;
    }

    const player = ctx.tryGet(Services.Player);
    if (!player) return;
    const p = player.position;

    if (run.def.kind === 'evade') {
      const stars = ctx.tryGet(Services.Wanted)?.stars ?? 0;
      run.peakStars = Math.max(run.peakStars, stars);
      if (stars > 0) {
        run.hadStars = true;
        run.survived += dt;
      } else if (run.hadStars && run.survived > 8) {
        this.finish(true, '');
        return;
      }
    } else {
      const pt = run.def.points[run.step];
      // Photo steps are cleared by the E press, not by walking into them.
      if (pt && run.def.kind !== 'photo') {
        const d = Math.hypot(p.x - pt.x, p.z - pt.z);
        const radius = run.def.kind === 'race' ? 16 : 9;
        const seated = !run.def.inVehicle || player.inVehicle !== null;
        if (d <= radius && seated) {
          this.clearStep();
          return;
        }
      }
    }

    this.pushHud(run);
  }

  private pushHud(run: Run): void {
    activityHud.active = true;
    activityHud.name = run.def.name;
    activityHud.kind = KIND_LABEL[run.def.kind];
    activityHud.timeLeft = Math.max(0, run.def.limit - run.elapsed);
    activityHud.score = this.score(run);
    activityHud.progress =
      run.def.kind === 'evade'
        ? `${Math.floor(run.survived)}s / ${run.def.target ?? 60}s`
        : `${run.step}/${run.def.points.length}`;
  }

  /* ---------------------------------------------------------------- */

  private hud(): HudService | undefined {
    return this.ctx.tryGet(Services.Hud);
  }

  private toast(text: string, kind: 'info' | 'good' | 'bad' = 'info', ms = 2400): void {
    this.hud()?.toast(text, kind, ms);
  }

  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_ACTIVITY__: unknown }).__GTA_ACTIVITY__ = {
      list: () => this._available.map((a) => ({
        id: a.id, kind: a.kind, name: a.name,
        at: [Math.round(a.position.x), Math.round(a.position.z)],
        best: this.best.get(a.id) ?? 0,
      })),
      state: () => (this.run
        ? {
          id: this.run.def.id,
          kind: this.run.def.kind,
          step: this.run.step,
          steps: this.run.def.points.length,
          elapsed: Math.round(this.run.elapsed * 10) / 10,
          left: Math.round((this.run.def.limit - this.run.elapsed) * 10) / 10,
          survived: Math.round(this.run.survived * 10) / 10,
          score: this.score(this.run),
        }
        : null),
      start: (id: string) => this.start(id),
      abandon: () => this.abandon(),
      /** Clear the current step without travelling to it. */
      step: () => this.clearStep(),
      /** Teleport to the current target. */
      goToStep: () => {
        const run = this.run;
        const pt = run?.def.points[run.step];
        if (!pt) return false;
        const player = this.ctx.tryGet(Services.Player);
        _v.set(pt.x, this.groundAt(pt.x, pt.z) + 0.2, pt.z);
        if (player?.inVehicle) player.inVehicle.teleport(_v.clone(), 0);
        else player?.teleport(_v.clone());
        return true;
      },
      records: () => Object.fromEntries(this.best),
    };
  }
}
