/** Story spine: the four-act Grand Theft Austerity campaign.
 *
 *  THE SHAPE OF IT
 *    `src/content/story.ts`      the acts, as data
 *    `src/gameplay/missionState` the pure state machine (index, timers, fail)
 *    this file                   the world half — waypoints, markers, cast,
 *                                stars, dialogue, rewards
 *
 *  The interaction registry (E prompts), the cast director (Nicușor, Alex, the
 *  builders) and Builders House used to hang off this class and be ticked by
 *  it, because `src/game.ts` was closed. They are registered systems now
 *  (orders 216, 217, 218) and this file reaches them through `Services` like
 *  every other consumer.
 *
 *  THE WORLD STAYS PLAYABLE WITH THE CAMPAIGN IDLE. With no mission running,
 *  the only thing the campaign puts on screen is a single mission-giver marker
 *  at the forecourt (or wherever the last act left you). Nothing forces the
 *  stars, nothing holds the waypoint, nothing blocks free roam.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import {
  Services,
  type CastService,
  type HudService,
  type InteractionService,
  type MissionService,
  type VehicleHandle,
} from '../core/services';
import { CAMPAIGN, CAMPAIGN_BY_ID } from '../content/story';
import {
  LOBBY,
  LOBBY_DOOR_INSIDE,
  LOBBY_RECEPTION,
  PLACES,
  TOWER,
} from '../content/places';
import {
  MissionRun,
  nextMission,
  type MissionDef,
  type ObjectiveDef,
  type Vec3Lite,
} from './missionState';
import { missionHud, resetMissionHud } from './hudState';

const GIVER_ID = 'story:giver';
const OBJ_ID = 'story:objective';

interface PendingLine {
  at: number;
  speaker: string;
  text: string;
  ms: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

export class MissionSystem implements System, MissionService {
  readonly name = 'missions';
  readonly order = 220;

  private _current: string | null = null;
  private _title = '';
  private _completed = new Set<string>();
  private ctx!: GameContext;

  private run: MissionRun | null = null;
  private lines: PendingLine[] = [];
  private lineClock = 0;
  private failBanner = 0;
  private lastFailedId: string | null = null;

  private daciaId: string | null = null;
  private partyOn = false;

  get currentId(): string | null {
    return this._current;
  }
  get currentTitle(): string {
    return this._title;
  }
  get completed(): ReadonlySet<string> {
    return this._completed;
  }

  /* ---------------------------------------------------------------- */
  /* init                                                              */
  /* ---------------------------------------------------------------- */

  /** The interaction registry. Registered at order 216, so it always exists. */
  private get interaction(): InteractionService {
    return this.ctx.get(Services.Interaction);
  }
  private get cast(): CastService {
    return this.ctx.get(Services.Cast);
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Missions, this);

    this.placeCast();
    this.offerNext();

    ctx.events.on('player:died', () => {
      if (this.run?.isRunning && (this.run.def.failOnDeath ?? true)) this.failRun('ai murit');
    });

    this.installDebugHook();
  }

  /* ---------------------------------------------------------------- */
  /* the cast                                                          */
  /* ---------------------------------------------------------------- */

  private placeCast(): void {
    // Allies, where the story puts them.
    this.cast.add({
      id: 'nicusor', name: 'Nicușor LAN', role: 'nicusor',
      x: PLACES.nicusorCourtyard.x, z: PLACES.nicusorCourtyard.z, yaw: Math.PI,
    });
    this.cast.add({
      id: 'alex', name: 'Alex Need-Aid', role: 'ally',
      x: PLACES.recorderDrop.x, z: PLACES.recorderDrop.z, yaw: Math.PI,
    });

    // Builders waiting outside their own front door.
    const forecourt: Array<[number, number, number]> = [
      [-46, 20, 0], [-51.5, 22.5, 0.5], [-40.5, 22.8, -0.5],
    ];
    forecourt.forEach(([x, z, yaw], i) => {
      this.cast.add({ id: `builder_out${i}`, name: 'Constructor', role: 'builder', x, z, yaw, parties: true });
    });

    // Builders waiting in silence in the dark lobby — the afterparty crowd.
    const inside: Array<[number, number, number]> = [
      [LOBBY.cx - 5.5, LOBBY.cz - 1.5, 0.4],
      [LOBBY.cx - 2.0, LOBBY.cz + 1.0, 3.0],
      [LOBBY.cx + 3.0, LOBBY.cz - 2.5, 2.2],
      [LOBBY.cx + 6.5, LOBBY.cz + 0.5, 3.6],
    ];
    inside.forEach(([x, z, yaw], i) => {
      this.cast.add({ id: `builder_in${i}`, name: 'Constructor', role: 'builder', x, z, yaw, parties: true });
    });
  }

  /* ---------------------------------------------------------------- */
  /* MissionService                                                    */
  /* ---------------------------------------------------------------- */

  /** The act on offer right now, or null when the campaign is finished. */
  get nextAct(): MissionDef | null {
    return nextMission(CAMPAIGN, this._completed);
  }

  start(id: string): void {
    const def = CAMPAIGN_BY_ID.get(id);
    if (!def) {
      console.warn(`[missions] unknown mission "${id}"`);
      return;
    }
    if (def.requires && !this._completed.has(def.requires)) {
      this.toast(`Mai întâi: ${CAMPAIGN_BY_ID.get(def.requires)?.title ?? def.requires}`, 'bad');
      return;
    }
    this.clearMarkers();
    this.run = new MissionRun(def);
    this._current = def.id;
    this._title = def.title;
    this.failBanner = 0;
    missionHud.failed = '';

    this.hud()?.missionCard(`ACTUL ${romanNumeral(def.act)} — ${def.title}`, def.brief);
    this.ctx.events.emit('ui:missionCard', { title: def.title, subtitle: def.brief });
    this.ctx.events.emit('mission:advance', { id: def.id });

    if (def.startStars !== undefined) this.ctx.tryGet(Services.Wanted)?.setStars(def.startStars);
    if (def.id === 'act1_evacuare') this.ensureDacia();

    this.enterObjective();
  }

  abandon(): void {
    if (!this.run) return;
    const id = this.run.def.id;
    this.run.fail('abandonat');
    this.lastFailedId = id;
    this.run = null;
    this._current = null;
    this._title = '';
    this.clearMarkers();
    resetMissionHud();
    this.ctx.events.emit('mission:failed', { id, reason: 'abandoned' });
    this.toast('Misiune abandonată', 'bad');
    this.offerNext(id);
  }

  /**
   * SAVE / LOAD. `completed` is authoritative — it replaces the set rather than
   * adding to it, so loading an early slot really does take unfinished acts
   * back off you. `currentId` re-enters that act from objective 1: an act is a
   * chain of world side effects (a spawned Dacia, a lowered barricade, a
   * hijacked broadcast) and replaying the beat you were on is honest, while
   * claiming to restore the middle of one would not be.
   */
  restore(completed: readonly string[], currentId: string | null): void {
    this.run = null;
    this._current = null;
    this._title = '';
    this.lastFailedId = null;
    this.failBanner = 0;
    this.clearMarkers();
    resetMissionHud();

    this._completed = new Set(completed.filter((id) => CAMPAIGN_BY_ID.has(id)));

    if (currentId && CAMPAIGN_BY_ID.has(currentId)) {
      // A saved act must not be blocked by its own `requires` gate: the save
      // already proves the player had reached it.
      const def = CAMPAIGN_BY_ID.get(currentId)!;
      if (def.requires) this._completed.add(def.requires);
      this.start(currentId);
    } else {
      this.offerNext();
    }
    this.ctx.events.emit('mission:restored', { completed: [...this._completed], currentId });
  }

  /** Restart the mission currently running, or the last one that failed. */
  restart(): void {
    const id = this._current ?? this.lastFailedId;
    if (!id) return;
    this.clearMarkers();
    this.run = null;
    this._current = null;
    this.start(id);
  }

  /* ---------------------------------------------------------------- */
  /* objectives                                                        */
  /* ---------------------------------------------------------------- */

  private enterObjective(): void {
    const run = this.run;
    if (!run) return;
    const o = run.objective;

    this.interaction.remove(OBJ_ID);
    this.lines.length = 0;
    this.lineClock = 0;

    if (o.stars !== undefined) this.ctx.tryGet(Services.Wanted)?.setStars(o.stars);

    const target = triggerPoint(o);
    if (target) {
      _v.set(target.x, this.groundAt(target.x, target.z), target.z);
      this.hud()?.setWaypoint(_v.clone());
      this.ctx.events.emit('objective:changed', {
        title: o.title,
        subtitle: o.hint,
        target: _v.clone(),
      });
    } else {
      this.hud()?.setWaypoint(null);
      this.ctx.events.emit('objective:changed', { title: o.title, subtitle: o.hint });
    }

    if (o.trigger.kind === 'interact') {
      const t = o.trigger;
      const p = new THREE.Vector3(t.at.x, this.groundAt(t.at.x, t.at.z), t.at.z);
      this.interaction.add({
        id: OBJ_ID,
        label: t.label,
        position: p,
        radius: t.radius ?? 3.6,
        kind: 'story',
        onFoot: o.onFoot ?? true,
        // The broadcast mast, the barricade and the lobby desk all sit against
        // solid geometry; a strict eye-line refuses them from the only angle
        // you can stand at, so story markers trust the radius instead.
        requireLos: false,
        onTrigger: () => this.satisfy(),
      });
    }

    for (const s of o.say ?? []) {
      this.lines.push({
        at: (s.delayMs ?? 0) / 1000,
        speaker: s.speaker,
        text: s.text,
        ms: s.ms ?? 4000,
      });
    }
    if (o.voice) {
      this.ctx.events.emit('audio:oneShot', { id: `voice:${o.voice}`, volume: 1 });
    }

    this.pushHud();
  }

  /** The current objective's trigger fired. */
  private satisfy(): void {
    const run = this.run;
    if (!run || !run.isRunning) return;
    const o = run.objective;
    if (o.hijack) this.ctx.events.emit('broadcast:hijacked', {});
    if (o.xp) this.ctx.tryGet(Services.Progression)?.addXp(o.xp, `obiectiv:${o.id}`);
    this.onObjectiveDone(o);

    const r = run.satisfy();
    if (r === 'complete') this.completeRun();
    else if (r === 'next') {
      this.toast('Obiectiv îndeplinit', 'good', 1800);
      this.enterObjective();
    }
  }

  /** Side effects that belong to a specific beat rather than to the machine. */
  private onObjectiveDone(o: ObjectiveDef): void {
    switch (o.id) {
      case 'server':
        this.ensureDacia();
        this.toast('Serverul comunității: în brațe', 'good');
        break;
      case 'evidence':
        this.toast('Stick cu dovezi: preluat', 'good');
        break;
      case 'credentials':
        this.toast('Acreditări de emisie: preluate', 'good');
        break;
      case 'barricade':
        this.toast('Baricada e jos', 'good');
        this.ctx.tryGet(Services.Peds)?.scatter(_v.set(PLACES.barricade.x, 0, PLACES.barricade.z), 30);
        break;
      case 'enter': {
        // Step him over the threshold. The shell has a real 3.4 m pedestrian
        // gap (see buildersHouse.ts), so this is a nudge through the door
        // rather than a teleport into a sealed box.
        this.ctx.tryGet(Services.Player)?.teleport(
          new THREE.Vector3(LOBBY_DOOR_INSIDE.x, LOBBY.floorY + 0.05, LOBBY_DOOR_INSIDE.z),
          0,
        );
        this.toast('Ești în holul Casei Constructorilor', 'good');
        break;
      }
      case 'liberate':
        this.liberate();
        break;
      default:
        break;
    }
  }

  /**
   * THE PAYOFF. Lights up, tricolour on, folk music, dancing builders — and
   * none of it before this exact interaction, which is what `docs/STORY.md`
   * asks for.
   */
  private liberate(): void {
    this.partyOn = true;
    this.ctx.tryGet(Services.BuildersHouse)?.liberate();
    this.cast.setParty(true);
    // The builders outside come in for the party.
    const seats: Array<[number, number]> = [
      [LOBBY.cx - 8, LOBBY.cz - 4], [LOBBY.cx + 8, LOBBY.cz - 4], [LOBBY.cx, LOBBY.cz - 6],
    ];
    seats.forEach(([x, z], i) => this.cast.moveTo(`builder_out${i}`, x, z, Math.PI));
    this.ctx.tryGet(Services.Wanted)?.clear();
    this.ctx.tryGet(Services.Audio)?.setMusic('afterparty', 1.5);
    this.ctx.tryGet(Services.Camera)?.shake(0.25, 0.5);
    this.ctx.events.emit('radio:line', { text: 'Casa Constructorilor e din nou deschisă. Muzica e a noastră.' });
  }

  private completeRun(): void {
    const run = this.run!;
    const def = run.def;
    this._completed.add(def.id);
    this.clearMarkers();

    this.ctx.tryGet(Services.Progression)?.addXp(def.rewardXp, `misiune:${def.id}`);
    this.ctx.tryGet(Services.Player)?.addLei(def.rewardLei, `misiune:${def.id}`);
    this.ctx.events.emit('mission:complete', { id: def.id });
    this.hud()?.missionCard(`${def.title} — REUȘIT`, `+${def.rewardXp} XP · +${def.rewardLei} lei`);

    this.run = null;
    this._current = null;
    this._title = '';
    resetMissionHud();
    this.offerNext();
  }

  private failRun(reason: string): void {
    const run = this.run;
    if (!run || !run.isRunning) return;
    const id = run.def.id;
    const title = run.def.title;
    run.fail(reason);
    this.lastFailedId = id;
    this.clearMarkers();
    this.ctx.events.emit('mission:failed', { id, reason });
    this.hud()?.missionCard(`${title} — EȘUAT`, reason);

    this.run = null;
    this._current = null;
    this._title = '';
    resetMissionHud();
    missionHud.failed = reason;
    this.failBanner = 6;
    // The giver comes straight back so the act can be replayed on the spot.
    this.offerNext(id);
  }

  /**
   * Put the "start this act" marker in the world. `retryId` re-offers a failed
   * act instead of advancing to the next one.
   */
  private offerNext(retryId?: string): void {
    this.interaction.remove(GIVER_ID);
    const def = retryId ? CAMPAIGN_BY_ID.get(retryId) : this.nextAct;
    if (!def) return; // campaign finished — leave the world alone
    const p = new THREE.Vector3(def.startAt.x, this.groundAt(def.startAt.x, def.startAt.z), def.startAt.z);
    this.interaction.add({
      id: GIVER_ID,
      label: retryId ? `Reia: ${def.title}` : `${def.startLabel} — Actul ${romanNumeral(def.act)}`,
      position: p,
      radius: 4.2,
      kind: 'story',
      onFoot: true,
      requireLos: false,
      onTrigger: () => this.start(def.id),
    });
  }

  private clearMarkers(): void {
    this.interaction.remove(OBJ_ID);
    this.interaction.remove(GIVER_ID);
    this.hud()?.setWaypoint(null);
    this.lines.length = 0;
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    if (this.failBanner > 0) {
      this.failBanner -= dt;
      if (this.failBanner <= 0) missionHud.failed = '';
    }

    const run = this.run;
    if (!run || !run.isRunning) return;

    // Dialogue, on the game clock so pausing pauses the conversation.
    this.lineClock += dt;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      if (this.lineClock < l.at) continue;
      this.lines.splice(i, 1);
      ctx.events.emit('ui:subtitle', { speaker: l.speaker, text: l.text, ms: l.ms });
    }

    if (run.tick(dt) === 'timeout') {
      this.failRun('timp expirat');
      return;
    }

    this.evaluate(dt, ctx);
    this.pushHud();
  }

  /** Ask the world whether the current objective's trigger has fired. */
  private evaluate(dt: number, ctx: GameContext): void {
    const run = this.run!;
    const o = run.objective;
    const player = ctx.tryGet(Services.Player);
    if (!player) return;

    const t = o.trigger;
    if (t.kind !== 'hold') {
      if (o.onFoot && !player.isOnFoot) return;
      if (o.inVehicle && player.isOnFoot) return;
    }

    const p = player.position;

    switch (t.kind) {
      case 'interact':
        // Driven by the interactable, not by proximity.
        break;
      case 'reach':
        if (planar(p, t.at) <= t.radius) this.satisfy();
        break;
      case 'board':
        if (player.inVehicle && planar(p, t.at) <= t.radius) this.satisfy();
        break;
      case 'flee':
        if (planar(p, t.from) >= t.distance) this.satisfy();
        break;
      case 'escape': {
        const stars = ctx.tryGet(Services.Wanted)?.stars ?? 0;
        if (stars === 0) this.satisfy();
        break;
      }
      case 'hold': {
        const inside = planar(p, t.at) <= t.radius;
        if (run.hold(dt, inside)) this.satisfy();
        break;
      }
      default:
        break;
    }
  }

  private pushHud(): void {
    const run = this.run;
    if (!run || !run.isRunning) {
      resetMissionHud();
      return;
    }
    const s = run.snapshot();
    missionHud.active = true;
    missionHud.title = run.def.title;
    missionHud.objective = s.objectiveTitle;
    missionHud.hint = s.objectiveHint;
    missionHud.timeLeft = s.timeLeft;
    missionHud.hold = s.holdProgress;
    missionHud.step = s.objectiveIndex + 1;
    missionHud.steps = run.def.objectives.length;
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  private hud(): HudService | undefined {
    return this.ctx.tryGet(Services.Hud);
  }

  private toast(text: string, kind: 'info' | 'good' | 'bad' = 'info', ms = 2600): void {
    this.hud()?.toast(text, kind, ms);
  }

  private groundAt(x: number, z: number): number {
    const g = this.ctx.tryGet(Services.City)?.spatial.groundHeight(x, z) ?? 0;
    return g > -1e5 ? g : 0;
  }

  /**
   * Park a Dacia at the kerb outside Builders House if there is not one there
   * already. Act 1 is "load it into the Dacia and drive out"; the act cannot
   * assume the player brought a car.
   */
  private ensureDacia(): VehicleHandle | null {
    const vehicles = this.ctx.tryGet(Services.Vehicles);
    if (!vehicles) return null;
    const existing = this.daciaId ? vehicles.get(this.daciaId) : undefined;
    if (existing && !existing.isWrecked) return existing;

    const slot = PLACES.daciaSlot;
    const near = vehicles.nearestEnterable(_v2.set(slot.x, 0, slot.z), 22);
    if (near) {
      this.daciaId = near.id;
      return near;
    }
    const y = this.groundAt(slot.x, slot.z) + 1.0;
    const v = vehicles.spawn('dacia', new THREE.Vector3(slot.x, y, slot.z), slot.yaw, { faction: 'player' });
    this.daciaId = v.id;
    return v;
  }

  /** Level 3's unlock: your Dacia, wherever you are standing. */
  callDacia(): boolean {
    const vehicles = this.ctx.tryGet(Services.Vehicles);
    const player = this.ctx.tryGet(Services.Player);
    const city = this.ctx.tryGet(Services.City);
    if (!vehicles || !player) return false;
    _v.copy(player.position);
    if (city) {
      const id = city.nearestNode(player.position);
      if (id >= 0) _v.copy(city.roadNodes[id].position);
    }
    _v.y = this.groundAt(_v.x, _v.z) + 1.0;
    const existing = this.daciaId ? vehicles.get(this.daciaId) : undefined;
    if (existing && !existing.isWrecked) {
      existing.teleport(_v.clone(), 0);
      existing.recover();
    } else {
      this.daciaId = vehicles.spawn('dacia', _v.clone(), 0, { faction: 'player' }).id;
    }
    this.toast('Dacia a sosit', 'good');
    return true;
  }

  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_STORY__: unknown }).__GTA_STORY__ = {
      acts: () => CAMPAIGN.map((m) => ({ id: m.id, act: m.act, title: m.title, objectives: m.objectives.length })),
      state: () => ({
        current: this._current,
        title: this._title,
        completed: [...this._completed],
        objective: this.run ? this.run.snapshot() : null,
        markers: this.interaction.ids(),
        focus: this.interaction.focusLabel,
        cast: this.cast.all,
        party: this.partyOn,
        lobbyLiberated: this.ctx.tryGet(Services.BuildersHouse)?.liberated ?? false,
        /** Act IV is unplayable if `passable` is false. Checked every boot. */
        doorway: this.ctx.tryGet(Services.BuildersHouse)?.doorway ?? {
          carved: false, passable: false, reason: 'buildersHouse system not registered', added: 0,
        },
        save: this.ctx.tryGet(Services.Save)?.peek() ?? null,
      }),
      start: (id: string) => this.start(id),
      abandon: () => this.abandon(),
      restart: () => this.restart(),
      restore: (completed: string[], currentId: string | null = null) =>
        this.restore(completed, currentId),
      /** Fire the current objective's trigger without walking there. */
      skip: () => this.satisfy(),
      /** Mark every act before `id` complete, so a later act can be played. */
      unlockTo: (id: string) => {
        for (const m of CAMPAIGN) {
          if (m.id === id) break;
          this._completed.add(m.id);
        }
        this.offerNext();
      },
      /** Press an interactable by id, or whatever is focused. */
      interact: (id?: string) =>
        this.interaction.trigger(id ?? this.interaction.focusId),
      callDacia: () => this.callDacia(),
      goTo: (place: string) => {
        const pl = (PLACES as Record<string, { x: number; z: number }>)[place];
        if (!pl) return false;
        this.ctx.tryGet(Services.Player)?.teleport(
          new THREE.Vector3(pl.x, this.groundAt(pl.x, pl.z) + 0.2, pl.z),
        );
        return true;
      },
      lobby: () => ({
        centre: [LOBBY.cx, LOBBY.floorY, LOBBY.cz],
        reception: [LOBBY_RECEPTION.x, LOBBY_RECEPTION.z],
        towerH: TOWER.h,
        doorway: this.ctx.tryGet(Services.BuildersHouse)?.doorway ?? null,
      }),
    };
  }

  dispose(): void {
    if (!this.ctx) return;
    this.clearMarkers();
  }
}

/* ------------------------------------------------------------------ */

function planar(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function triggerPoint(o: ObjectiveDef): Vec3Lite | null {
  const t = o.trigger;
  switch (t.kind) {
    case 'interact':
    case 'reach':
    case 'board':
    case 'hold':
      return t.at;
    default:
      return null;
  }
}

function romanNumeral(n: number): string {
  return ['0', 'I', 'II', 'III', 'IV', 'V'][n] ?? String(n);
}
