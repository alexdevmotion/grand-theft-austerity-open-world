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
 *  Markers and prompts come from the interaction system that `game.ts`
 *  owns; this borrows it rather than running a second registry, because two
 *  registries would fight over the same `interact` press.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import {
  Services,
  type ActivityService,
  type CityService,
  type HudService,
  type PlayerService,
} from '../core/services';
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
import type { InteractionService } from '../core/services';
import { activityHud, resetActivityHud } from './hudState';

const START_PREFIX = 'act:start:';
const STEP_ID = 'act:step';
const SHOP_PREFIX = 'shop:';

/* ------------------------------------------------------------------ */
/* The shops                                                           */
/*                                                                     */
/* Anchored to story places rather than to absolute coordinates: each  */
/* one is snapped onto the kerb of the nearest road at boot, so the    */
/* city can move underneath them.                                      */
/* ------------------------------------------------------------------ */

interface FoodStall {
  id: string;
  name: string;
  /** What you actually buy. */
  item: string;
  cost: number;
  heal: number;
  x: number;
  z: number;
  /** Metres off the road centreline — which pavement it stands on. */
  side: number;
}

interface Garage {
  id: string;
  name: string;
  paint: string;
  x: number;
  z: number;
  side: number;
}

/** Health per leu is deliberately best at the shaorma and worst at the covrig. */
const FOOD_STALLS: FoodStall[] = [
  { id: 'covrigarie', name: 'Covrigărie «La Constructori»', item: 'Covrig cu susan', cost: 14, heal: 20, x: -46, z: 20, side: 9 },
  { id: 'shaormerie', name: 'Shaormerie non-stop «Victoriei»', item: 'Shaorma mare cu de toate', cost: 42, heal: 55, x: 276, z: -340, side: -9 },
  { id: 'bufet', name: 'Bufetul «Curtea Startup»', item: 'Mici cu muștar', cost: 34, heal: 42, x: -368, z: -74, side: 8 },
  { id: 'gogoserie', name: 'Gogoșerie Cișmigiu', item: 'Gogoși cu vișine', cost: 18, heal: 24, x: -460, z: 345, side: -8 },
  { id: 'antena', name: 'Grătarul «La Antenă»', item: 'Mici și o bere fără', cost: 38, heal: 48, x: 460, z: 184, side: 9 },
];

const GARAGES: Garage[] = [
  { id: 'service_nord', name: 'Service Auto «Dacia Frate»', paint: 'Vopsitorie «Fără Numere»', x: -46, z: -8, side: -7 },
  { id: 'service_sud', name: 'Service Auto «Piese la Negru»', paint: 'Vopsitorie «Culoare Nouă»', x: 276, z: -340, side: 7 },
];

/** Flat call-out fee, plus this much across the full damage range. */
const REPAIR_BASE = 160;
const REPAIR_SPAN = 1200;

/**
 * What the ramp charges, given the state of the car. Pure so the balance can
 * be pinned: repairing early has to stay cheaper than the tow fee you pay
 * when the same car finally dies under you (`PlayerSystem.checkWreck`), or
 * the correct play is always to write it off.
 *
 * Returns 0 for a car with nothing wrong with it — the garage refuses rather
 * than charging you a call-out fee for a shrug.
 */
export function repairPrice(health: number, maxHealth: number): number {
  const max = Math.max(1, maxHealth);
  const missing = 1 - Math.max(0, Math.min(max, health)) / max;
  if (missing < 0.02) return 0;
  return REPAIR_BASE + Math.round(missing * REPAIR_SPAN);
}
/** A paint job and a set of plates. The most expensive thing in free roam. */
const RESPRAY_COST = 780;
/** How many Crisis Stars new paint is worth. */
const RESPRAY_STARS = 2;

/** The economy half of `PlayerSystem`, which `PlayerService` does not carry. */
type PlayerExtras = PlayerService & {
  spend(amount: number, reason: string): boolean;
  chargeUpTo(amount: number, reason: string): number;
  heal(amount: number, reason?: string): number;
};

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
    // `cause: 'retinut'` is the detention loop in `wanted.ts` announcing an
    // arrest through the one event every system already treats as "you lost".
    ctx.events.on('player:died', ({ cause }) => {
      if (this.run) this.finish(false, cause === 'retinut' ? 'te-a prins Ministerul' : 'ai murit');
    });

    this.placeShops();
    this.installDebugHook();
  }

  /* ================================================================== *
   * WHERE THE MONEY GOES.
   *
   * `addLei` had never once been called with a negative number, anywhere in
   * the game. Lei accumulated and nothing consumed them, which makes a
   * currency a score: there is no decision in a number that only goes up.
   *
   * These are the sinks, and every one of them is also a mechanic and also a
   * joke:
   *
   *   FOOD     the only way to heal outside a mission. A shaorma is 42 lei
   *            and 55 hit points, which is the cheapest health in the game
   *            and the reason you keep small money on you.
   *   REPAIR   a bill proportional to what you did to the car, so driving
   *            badly is now expensive BEFORE the wreck rather than only
   *            after it (`PlayerSystem.checkWreck` handles after).
   *   RESPRAY  the classic: new paint, new plates, two Crisis Stars gone. It
   *            is the most expensive thing in the free world on purpose —
   *            it has to be worse value than driving well.
   *
   * The fourth sink, bribing an inspector, lives in `wanted.ts` with the
   * stars it removes.
   * ================================================================== */

  private shopCooldown = new Map<string, number>();
  private shopsPlaced = false;

  private placeShops(): void {
    const it = this.interaction();
    // The interaction registry is a service now, so whether it exists at our
    // init depends on system order in `game.ts` — which is not ours to
    // depend on. Retried from `update` until it lands.
    if (!it) return;
    this.shopsPlaced = true;
    const p = new THREE.Vector3();

    for (const s of FOOD_STALLS) {
      this.roadside(s.x, s.z, s.side, p);
      it.add({
        id: `${SHOP_PREFIX}${s.id}`,
        label: `${s.name} — ${s.item}, ${s.cost} lei`,
        position: p.clone(),
        radius: 4.2,
        kind: 'world',
        onFoot: true,
        requireLos: false,
        color: 0xffb03a,
        onTrigger: () => this.eat(s),
      });
    }

    for (const g of GARAGES) {
      this.roadside(g.x, g.z, g.side, p);
      it.add({
        id: `${SHOP_PREFIX}${g.id}:repair`,
        label: `${g.name} — reparație`,
        position: p.clone(),
        radius: 7.5,
        kind: 'world',
        // You drive onto the ramp. Demanding you get out first is friction
        // for its own sake, and the thing being repaired is the car — so the
        // prompt only offers itself to someone sitting in one.
        onFoot: false,
        inVehicle: true,
        requireLos: false,
        color: 0x4ad6c4,
        onTrigger: () => this.repair(g),
      });
      // The paint booth is a separate bay a few metres along, so the two
      // services are two places rather than one ambiguous button.
      this.roadside(g.x, g.z, g.side + 8.5, p);
      it.add({
        id: `${SHOP_PREFIX}${g.id}:respray`,
        label: `${g.paint} — vopsitorie, ${RESPRAY_COST} lei`,
        position: p.clone(),
        radius: 6.5,
        kind: 'world',
        onFoot: false,
        inVehicle: true,
        requireLos: false,
        color: 0xff3d7f,
        onTrigger: () => this.respray(g),
      });
    }
  }

  /**
   * A point at the kerb near (x, z): the nearest road node, a few metres
   * along its first link so it is not in the junction box, then offset
   * sideways onto the pavement. Authoring absolute coordinates for shopfronts
   * would put them inside a building the first time the city regenerates.
   */
  private roadside(x: number, z: number, offset: number, out: THREE.Vector3): THREE.Vector3 {
    const city: CityService | undefined = this.ctx.tryGet(Services.City);
    if (!city) return out.set(x, this.groundAt(x, z), z);
    _v.set(x, 0, z);
    const id = city.nearestNode(_v);
    const node = id >= 0 ? city.roadNodes[id] : undefined;
    if (!node) return out.set(x, this.groundAt(x, z), z);

    let dx = 0;
    let dz = 1;
    const link = node.links.length ? city.roadNodes[node.links[0]] : undefined;
    if (link) {
      dx = link.position.x - node.position.x;
      dz = link.position.z - node.position.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
    }
    const px = node.position.x + dx * 7 - dz * offset;
    const pz = node.position.z + dz * 7 + dx * offset;
    return out.set(px, this.groundAt(px, pz), pz);
  }

  private cooled(id: string): boolean {
    return (this.shopCooldown.get(id) ?? 0) <= 0;
  }

  private eat(s: FoodStall): void {
    const player = this.ctx.tryGet(Services.Player) as PlayerExtras | undefined;
    if (!player) return;
    if (!this.cooled(s.id)) {
      this.toast('Mai lasă-l puțin să se facă', 'info', 1600);
      return;
    }
    if (player.health >= player.maxHealth) {
      this.toast('Nu ți-e foame', 'info', 1600);
      return;
    }
    if (!player.spend(s.cost, `mâncare:${s.id}`)) {
      this.toast(`Nu ai ${s.cost} lei`, 'bad');
      return;
    }
    const gained = player.heal(s.heal, s.item);
    this.shopCooldown.set(s.id, 12);
    this.toast(`${s.item} · −${s.cost} lei · +${Math.round(gained)} viață`, 'good', 2800);
    this.ctx.events.emit('audio:oneShot', { id: 'pickup', volume: 0.5 });
  }

  private repair(g: Garage): void {
    const player = this.ctx.tryGet(Services.Player) as PlayerExtras | undefined;
    const v = player?.inVehicle;
    if (!player || !v) return;
    const cost = repairPrice(v.health, v.maxHealth);
    if (cost === 0) {
      this.toast('Mașina n-are nimic. Deocamdată.', 'info', 2200);
      return;
    }
    if (!player.spend(cost, `reparație:${g.id}`)) {
      this.toast(`Reparația costă ${cost} lei. Nu-i ai.`, 'bad', 3200);
      return;
    }
    // `VehicleHandle` has no `repair()`, only `applyDamage`. Negative damage
    // is the whole repair, clamped to exactly the missing health so nothing
    // ends up above its maximum. (See the report: a real `repair()` on the
    // handle would also undo the body deformation, which this cannot.)
    v.applyDamage(-(v.maxHealth - v.health));
    v.recover();
    this.toast(`${g.name}: ca nouă · −${cost} lei`, 'good', 3200);
    this.ctx.events.emit('audio:oneShot', { id: 'pickup', volume: 0.6 });
  }

  private respray(g: Garage): void {
    const player = this.ctx.tryGet(Services.Player) as PlayerExtras | undefined;
    const wanted = this.ctx.tryGet(Services.Wanted);
    if (!player || !player.inVehicle || !wanted) return;
    if (!player.spend(RESPRAY_COST, `vopsitorie:${g.id}`)) {
      this.toast(`Vopsitoria cere ${RESPRAY_COST} lei înainte`, 'bad', 3200);
      return;
    }
    const before = wanted.stars;
    if (before <= RESPRAY_STARS) wanted.clear();
    else wanted.setStars(before - RESPRAY_STARS);
    this.toast(
      before > 0
        ? `Culoare nouă, numere noi · −${RESPRAY_COST} lei · ${before} → ${Math.max(0, before - RESPRAY_STARS)} ★`
        : `Culoare nouă · −${RESPRAY_COST} lei. Nimeni nu te căuta oricum.`,
      before > 0 ? 'good' : 'info',
      3600,
    );
    this.ctx.events.emit('audio:oneShot', { id: 'pickup', volume: 0.6 });
  }

  /* ---------------------------------------------------------------- */
  /* offer                                                             */
  /* ---------------------------------------------------------------- */

  /** The one interaction registry, from the seam — not a module singleton. */
  private interaction(): InteractionService | null {
    return this.ctx.tryGet(Services.Interaction) ?? null;
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

    if (!this.shopsPlaced) this.placeShops();

    // Stall cooldowns. Cheap enough to walk unconditionally — there are five.
    for (const [id, t] of this.shopCooldown) {
      if (t > 0) this.shopCooldown.set(id, t - dt);
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
      /** The sinks: where lei can actually be spent, and what they cost. */
      shops: () => {
        const it = this.interaction();
        const ids = new Set(it?.ids() ?? []);
        return [
          ...FOOD_STALLS.map((s) => ({
            id: `${SHOP_PREFIX}${s.id}`, kind: 'food', name: s.name,
            buys: s.item, cost: s.cost, heal: s.heal,
            placed: ids.has(`${SHOP_PREFIX}${s.id}`),
          })),
          ...GARAGES.flatMap((g) => [
            { id: `${SHOP_PREFIX}${g.id}:repair`, kind: 'repair', name: g.name, buys: 'reparație', cost: `${REPAIR_BASE}–${REPAIR_BASE + REPAIR_SPAN}`, heal: 0, placed: ids.has(`${SHOP_PREFIX}${g.id}:repair`) },
            { id: `${SHOP_PREFIX}${g.id}:respray`, kind: 'respray', name: g.paint, buys: `−${RESPRAY_STARS}★`, cost: RESPRAY_COST, heal: 0, placed: ids.has(`${SHOP_PREFIX}${g.id}:respray`) },
          ]),
        ];
      },
      /** Stand at a shop without walking there. */
      goToShop: (id: string) => {
        const short = id.replace(SHOP_PREFIX, '').split(':')[0];
        const s = FOOD_STALLS.find((f) => f.id === short);
        const g = GARAGES.find((x) => x.id === short);
        const a = s ?? g;
        if (!a) return false;
        this.roadside(a.x, a.z, a.side, _v);
        _v.y += 0.2;
        const player = this.ctx.tryGet(Services.Player);
        if (player?.inVehicle) player.inVehicle.teleport(_v.clone(), 0);
        else player?.teleport(_v.clone());
        return true;
      },
      /** Fire a shop directly. */
      use: (id: string) => this.interaction()?.trigger(id.startsWith(SHOP_PREFIX) ? id : SHOP_PREFIX + id) ?? false,
    };
  }
}
