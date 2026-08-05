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
  type MissionOffer,
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
  type Say,
  type Vec3Lite,
} from './missionState';
import { missionHud, resetMissionHud } from './hudState';
import { onLangChange, t, tp } from '../core/i18n';
// Type only: `CameraService` in the frozen seam has `focusOn` and nothing that
// can compose a shot. The camera system publishes the wider contract.
import type { CameraDirector, CinematicShot } from './cameraSystem';

const GIVER_ID = 'story:giver';
const OBJ_ID = 'story:objective';
const OPENING_TITLE = 'PROLOG — CASA SUB SIGILIU';
const OPENING_BRIEF =
  'Georgescu a închis Casa Builderilor. Ministerul confiscă ultimul server. ' +
  'Vorbește cu builderii de la intrare.';

const FORECOURT_BUILDERS: ReadonlyArray<readonly [number, number, number]> = [
  [-46, 20, 0], [-51.5, 22.5, 0.5], [-40.5, 22.8, -0.5],
];
const LOBBY_BUILDERS: ReadonlyArray<readonly [number, number, number]> = [
  [LOBBY.cx - 9.5, LOBBY.cz - 3.0, 0.9],
  [LOBBY.cx - 8.0, LOBBY.cz + 3.4, 1.5],
  [LOBBY.cx - 2.0, LOBBY.cz + 6.2, 3.0],
  [LOBBY.cx + 3.0, LOBBY.cz - 5.2, 2.2],
  [LOBBY.cx + 8.5, LOBBY.cz + 0.5, 4.3],
  [LOBBY.cx + 6.5, LOBBY.cz + 5.6, 3.6],
  [LOBBY.cx - 5.0, LOBBY.cz - 6.4, 0.2],
];

export interface PendingLine {
  at: number;
  speaker: string;
  text: string;
  ms: number;
}

/** Pure scheduling seam for authored subtitles; used by the runtime and tests. */
export function appendDialogue(
  existing: readonly PendingLine[],
  clock: number,
  say: readonly Say[],
  busyUntil = 0,
): PendingLine[] {
  if (say.length === 0) return [...existing];
  // `existing` contains only lines not yet emitted. `busyUntil` retains the
  // reservation of the line currently visible on the HUD after it was shifted
  // from that queue, preventing the next interaction from overwriting it.
  let base = existing.length === 0 ? busyUntil : Math.max(clock, busyUntil);
  for (const line of existing) {
    base = Math.max(base, line.at + line.ms / 1000 + 0.16);
  }
  return [
    ...existing,
    ...say.map((s) => ({
      at: base + (s.delayMs ?? 0) / 1000,
      speaker: s.speaker,
      text: s.text,
      ms: s.ms ?? 4000,
    })),
  ].sort((a, b) => a.at - b.at);
}

/** Reconcile the persistent finale beat without replaying its camera/audio. */
export function restoreFinaleState(
  completed: ReadonlySet<string>,
  house: Pick<import('../core/services').BuildersHouseService, 'seal' | 'liberate'> | undefined,
): boolean {
  const liberated = completed.has('act4_giftshop');
  if (liberated) house?.liberate();
  else house?.seal();
  return liberated;
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
  private lineBusyUntil = 0;
  private failBanner = 0;
  private lastFailedId: string | null = null;

  private daciaId: string | null = null;
  private partyOn = false;
  /** `offerNext`'s argument, kept so the giver can be relabelled on a language switch. */
  private offerRetryId: string | undefined;
  private offLang: (() => void) | null = null;

  get currentId(): string | null {
    return this._current;
  }
  get currentTitle(): string {
    return this._title;
  }
  get completed(): ReadonlySet<string> {
    return this._completed;
  }

  /**
   * The acts you can walk up to and start right now — exactly what `offerNext`
   * put a giver marker on, which today is one act (the next one, or a failed
   * one being re-offered) and is empty while an act is running or once the
   * campaign is over.
   *
   * The map needs this to draw "go here to start Act II". Before it existed the
   * only campaign mark on the map was the CURRENT objective, so with no mission
   * running the map had nothing at all to say about the story — the giver was
   * a world-space E prompt and nothing else, findable only by walking into it.
   */
  get offered(): ReadonlyArray<MissionOffer> {
    return this._offered;
  }
  private _offered: MissionOffer[] = [];

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

    // MenuSystem emits only after the curtain has fully cleared. Showing this
    // during boot used to put the story card underneath the title overlay,
    // leaving the playable opening with no premise or direction at all.
    ctx.events.on('game:started', ({ mode }) => {
      this.routeToOffer();
      if (mode !== 'new' || this._current || this._completed.size > 0) return;
      this.hud()?.missionCard(OPENING_TITLE, OPENING_BRIEF);
      this.enqueueDialogue([{
        speaker: 'ȘTIRI',
        text: 'Președintele Georgescu a ordonat evacuarea Casei Builderilor. Ministerul a sigilat intrarea în această dimineață.',
        delayMs: 180,
        ms: 6800,
      }]);
    });

    ctx.events.on('player:died', () => {
      if (this.run?.isRunning && (this.run.def.failOnDeath ?? true)) this.failRun('ai murit');
    });

    /*
     * THE GIVER LABEL IS COMPOSED, NOT LOOKED UP.
     *
     * "Vorbește cu builderii — Actul I" is built from an act's `startLabel`
     * and its number, so it is not a sentence the catalogue can contain and
     * `t()` at draw time cannot rescue it. It is composed once, here, in
     * whichever language was current at boot — and the language picker lives
     * on the title screen, i.e. AFTER this ran. Rebuilding the offer is the
     * honest fix: it re-labels the world prompt and the map entry together.
     */
    this.offLang = onLangChange(() => this.offerNext(this.offerRetryId));

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
    FORECOURT_BUILDERS.forEach(([x, z, yaw], i) => {
      this.cast.add({ id: `builder_out${i}`, name: 'Builder', role: 'builder', x, z, yaw, parties: true });
    });

    /*
     * BUILDERS WAITING IN SILENCE IN THE DARK LOBBY — the afterparty crowd.
     *
     * There were four, standing in a loose diagonal near the middle of the
     * room, and after liberation they stayed exactly where they were and
     * shuffled on the spot. A playtester who walked into the finale saw ONE
     * person: the rest were in the unlit half of a 28 x 22 m hall.
     *
     * Seven now, pushed out to the edges of the room while it is sealed — that
     * is what waiting in a condemned building looks like, and it leaves the
     * middle of the floor empty for the party to fill. `FINALE_RING` is where
     * they go when the lights come on.
     */
    LOBBY_BUILDERS.forEach(([x, z, yaw], i) => {
      this.cast.add({ id: `builder_in${i}`, name: 'Builder', role: 'builder', x, z, yaw, parties: true });
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
      this.toast(
        tp('Mai întâi: {title}', { title: t(CAMPAIGN_BY_ID.get(def.requires)?.title ?? def.requires) }),
        'bad',
      );
      return;
    }
    // Starting the act must not erase the prologue/news line the player just
    // received. New objective dialogue appends behind that active reservation;
    // explicit abandon/fail/restore/restart paths clear stale dialogue first.
    this.clearMarkers(false);
    this.run = new MissionRun(def);
    this._current = def.id;
    this._title = def.title;
    this.failBanner = 0;
    missionHud.failed = '';

    if (def.id === 'act4_giftshop') this.resetBuildersHouseOpening();

    this.hud()?.missionCard(
      tp('ACTUL {n} — {title}', { n: romanNumeral(def.act), title: t(def.title) }),
      def.brief,
    );
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
    if (id === 'act4_giftshop') this.resetBuildersHouseOpening();
    this.clearMarkers(true);
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
    this.clearMarkers(true);
    this.cancelFinalePan();
    resetMissionHud();

    this._completed = new Set(completed.filter((id) => CAMPAIGN_BY_ID.has(id)));
    this.partyOn = restoreFinaleState(
      this._completed,
      this.ctx.tryGet(Services.BuildersHouse),
    );
    if (this.partyOn) this.stageFinaleCast();
    else this.resetBuilderCast();
    this.cast.setParty(this.partyOn);
    // Restore the persistent bed, but none of the finale's one-shot camera,
    // shake, radio or subtitle presentation.
    this.ctx.tryGet(Services.Audio)?.setMusic(this.partyOn ? 'afterparty' : null, 0.8);

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
    this.clearMarkers(true);
    this.cancelFinalePan();
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

    // Travel calls/warnings belong when the beat begins. Interaction dialogue
    // marked `complete` waits for the actual E press in satisfy().
    if ((o.sayAt ?? 'enter') === 'enter') this.enqueueObjectiveDialogue(o);

    this.pushHud();
  }

  /** The current objective's trigger fired. */
  private satisfy(): void {
    const run = this.run;
    if (!run || !run.isRunning) return;
    const o = run.objective;
    if (o.sayAt === 'complete') this.enqueueObjectiveDialogue(o);
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
        this.ctx.tryGet(Services.BuildersHouse)?.unseal();
        break;
      case 'enter': {
        /*
         * Step him over the threshold. The shell has a real 3.4 m pedestrian
         * gap (see buildersHouse.ts), so this is a nudge through the door
         * rather than a teleport into a sealed box.
         *
         * NOT `LOBBY_DOOR_INSIDE` any more. Three metres inside a doorway is
         * a fine place to stand and a terrible place to be PUT: the chase
         * camera booms five metres back, so it ends up outside the building
         * looking at the back of the facade. The interiors system computes an
         * anchor with room for the boom and a facing that looks into the hall
         * (`entryAnchor`, world/interiors/shell.ts).
         *
         * REQUEST TO THE ARCHITECTURE OWNER: `entrySpot` deserves a place on
         * `InteriorsService` in src/core/services.ts next to `doorwayInside`.
         * Until it has one this narrows the service and falls back.
         */
        type WithEntry = { entrySpot?(id: string): { x: number; y: number; z: number; yaw: number } | null };
        const spot = (this.ctx.tryGet(Services.Interiors) as WithEntry | undefined)
          ?.entrySpot?.('buildersLobby');
        this.ctx.tryGet(Services.Player)?.teleport(
          new THREE.Vector3(
            spot?.x ?? LOBBY_DOOR_INSIDE.x,
            (spot?.y ?? LOBBY.floorY) + 0.05,
            spot?.z ?? LOBBY_DOOR_INSIDE.z,
          ),
          spot?.yaw ?? 0,
        );
        this.toast('Ești în holul Casei Builderilor', 'good');
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
   *
   * All four halves of that sentence now actually happen:
   *   LIGHTS   `InteriorsService.liberate()` rebuilds the room in its
   *            `liberated` state, which is where the pendants, the dance
   *            floor and the raised ambient fill live (interiors/lobby.ts).
   *   PEOPLE   every builder in the building — the seven who were waiting in
   *            the dark plus the ones off the forecourt — is walked onto the
   *            dance floor and set dancing, in a ring facing the decks, so
   *            the party is a crowd rather than the one man who happened to
   *            be standing in the light.
   *   MUSIC    the afterparty bed, which was the only part that worked.
   *   CAMERA   a slow interior pan, `FINALE_PAN`, played after the act card.
   */
  private liberate(): void {
    this.partyOn = true;
    this.ctx.tryGet(Services.BuildersHouse)?.liberate();

    this.stageFinaleCast();
    this.cast.setParty(true);

    this.ctx.tryGet(Services.Wanted)?.clear();
    this.ctx.tryGet(Services.Audio)?.setMusic('afterparty', 1.5);
    this.ctx.tryGet(Services.Camera)?.shake(0.25, 0.5);
    this.ctx.events.emit('radio:line', { text: 'Casa Builderilor e din nou deschisă. Muzica e a noastră.' });

    this.queueFinalePan();
  }

  private stageFinaleCast(): void {

    // A ring around the dance floor, everyone facing the decks on the
    // reception counter. The ring is authored in room-relative metres so it
    // follows the lobby if the tower ever moves.
    const dfx = LOBBY.cx;
    const dfz = LOBBY.cz - 1.6;
    const ring: Array<[number, number]> = [];
    const N = 10;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + 0.35;
      ring.push([dfx + Math.sin(a) * 5.2, dfz + Math.cos(a) * 3.9]);
    }
    const dancers = [
      ...['builder_in0', 'builder_in1', 'builder_in2', 'builder_in3', 'builder_in4', 'builder_in5', 'builder_in6'],
      ...['builder_out0', 'builder_out1', 'builder_out2'],
    ];
    dancers.forEach((id, i) => {
      const [x, z] = ring[i % ring.length];
      // Face the decks, so the crowd reads as an audience and not a queue.
      this.cast.moveTo(id, x, z, Math.atan2(LOBBY_RECEPTION.x - x, LOBBY_RECEPTION.z - z));
    });
  }

  private resetBuilderCast(): void {
    FORECOURT_BUILDERS.forEach(([x, z, yaw], i) => this.cast.moveTo(`builder_out${i}`, x, z, yaw));
    LOBBY_BUILDERS.forEach(([x, z, yaw], i) => this.cast.moveTo(`builder_in${i}`, x, z, yaw));
  }

  private resetBuildersHouseOpening(): void {
    this.partyOn = false;
    this.ctx.tryGet(Services.BuildersHouse)?.seal();
    this.resetBuilderCast();
    this.cast.setParty(false);
    this.ctx.tryGet(Services.Audio)?.setMusic(null, 0.8);
  }

  /* ---------------------------------------------------------------- */
  /* the finale pan                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * THE SLOW INTERIOR PAN `docs/STORY.md` PROMISES.
   *
   * Two shots, cut together, both held inside the room:
   *   1. a slow push up the hall onto the decks, the tricolour and the crowd;
   *   2. a slow crane back off the dance floor that gives up the whole hall.
   *
   * Timed to START AFTER the act's own closing card. `liberate()` runs from
   * the last objective of Act IV, so `completeRun()` — and with it the
   * camera's `act4_giftshop` climax — fires a frame later; opening with our
   * own shot would simply be replaced by it. Rather than fight over the
   * camera, the pan waits for the card to finish and then plays.
   *
   * `azimuthDeg` is fixed on both: the shot-picker's sweep looks for the
   * longest clear eye-line, and inside a room the clearest line is out
   * through the door.
   */
  private queueFinalePan(): void {
    const dfx = LOBBY.cx;
    const dfz = LOBBY.cz - 1.6;
    this.panClock = 0;
    this.panQueue = [
      {
        at: 5.4,
        shot: {
          target: new THREE.Vector3(LOBBY_RECEPTION.x, LOBBY.floorY, LOBBY_RECEPTION.z),
          duration: 6.5, distance: 12.5, height: 2.4, lookHeight: 1.7, fov: 44,
          azimuthDeg: 180, push: 5.0, rise: 0.5, rollDeg: -0.8,
          hold: true, priority: 4,
          subtitle: 'Builderii sunt acasă.',
        },
      },
      {
        at: 12.2,
        shot: {
          target: new THREE.Vector3(dfx, LOBBY.floorY, dfz),
          duration: 7.0, distance: 8.0, height: 2.2, lookHeight: 1.35, fov: 50,
          // From the north-west quarter, craning back and up off the crowd:
          // the reception desk is due north, and a shot that ends behind it
          // frames the party through a monitor and a counter edge.
          azimuthDeg: 325, push: -4.0, rise: 3.0, rollDeg: 1.0,
          hold: true, priority: 4,
          subtitle: 'Muzica e a noastră.',
        },
      },
    ];
  }

  private panQueue: Array<{ at: number; shot: CinematicShot }> = [];
  private panClock = 0;

  /** Runs whether or not a mission is still running — the act ends mid-pan. */
  private tickFinalePan(dt: number): void {
    if (this.panQueue.length === 0) return;
    this.panClock += dt;
    const cam = this.ctx.tryGet(Services.Camera) as CameraDirector | undefined;
    while (this.panQueue.length && this.panClock >= this.panQueue[0].at) {
      const next = this.panQueue.shift()!;
      // No camera director (headless, or a stubbed camera): drop the pan
      // rather than stall the queue.
      cam?.playShot?.(next.shot);
    }
  }

  private completeRun(): void {
    const run = this.run!;
    const def = run.def;
    this._completed.add(def.id);
    // The final interaction's answer is presentation state, not a marker.
    // Keep it alive after the run becomes null.
    this.clearMarkers(false);

    this.ctx.tryGet(Services.Progression)?.addXp(def.rewardXp, `misiune:${def.id}`);
    this.ctx.tryGet(Services.Player)?.addLei(def.rewardLei, `misiune:${def.id}`);
    this.ctx.events.emit('mission:complete', { id: def.id });
    this.hud()?.missionCard(
      tp('{title} — REUȘIT', { title: t(def.title) }),
      tp('+{xp} XP · +{lei} lei', { xp: def.rewardXp, lei: def.rewardLei }),
    );

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
    if (id === 'act4_giftshop') this.resetBuildersHouseOpening();
    this.clearMarkers(true);
    this.ctx.events.emit('mission:failed', { id, reason });
    this.hud()?.missionCard(tp('{title} — EȘUAT', { title: t(title) }), reason);

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
    this.offerRetryId = retryId;
    this.interaction.remove(GIVER_ID);
    this._offered.length = 0;
    const def = retryId ? CAMPAIGN_BY_ID.get(retryId) : this.nextAct;
    if (!def) return; // campaign finished — leave the world alone
    const p = new THREE.Vector3(def.startAt.x, this.groundAt(def.startAt.x, def.startAt.z), def.startAt.z);
    const label = retryId
      ? tp('Reia: {title}', { title: t(def.title) })
      : tp('{label} — Actul {n}', { label: t(def.startLabel), n: romanNumeral(def.act) });
    this.interaction.add({
      id: GIVER_ID,
      label,
      position: p,
      radius: 4.2,
      kind: 'story',
      onFoot: true,
      requireLos: false,
      onTrigger: () => this.start(def.id),
    });
    // Published for the map. Same position object the interactable got: the
    // giver never moves once placed, and a second copy could only drift.
    this._offered.push({ id: def.id, title: label, position: p });
    this.routeToOffer();
  }

  /** Keep an offered story act discoverable outside the full-screen map. */
  private routeToOffer(): void {
    const offer = this._offered[0];
    if (offer) this.hud()?.setWaypoint(offer.position);
  }

  private clearMarkers(clearDialogue = false): void {
    this.interaction.remove(OBJ_ID);
    this.interaction.remove(GIVER_ID);
    this._offered.length = 0;
    this.hud()?.setWaypoint(null);
    if (clearDialogue) this.clearDialogue();
  }

  private enqueueObjectiveDialogue(o: ObjectiveDef): void {
    this.enqueueDialogue(o.say ?? []);
    if (o.voice) {
      this.ctx.events.emit('audio:oneShot', { id: `voice:${o.voice}`, volume: 1 });
    }
  }

  /**
   * Append a coherent sequence to one game clock. Its first line begins only
   * after any line already queued has finished displaying, so a fast objective
   * transition cannot make two speakers overwrite the same subtitle slot.
   */
  private enqueueDialogue(say: readonly Say[]): void {
    if (say.length === 0) return;
    if (this.lines.length === 0 && this.lineClock >= this.lineBusyUntil) {
      this.lineClock = 0;
      this.lineBusyUntil = 0;
    }
    this.lines = appendDialogue(this.lines, this.lineClock, say, this.lineBusyUntil);
  }

  private clearDialogue(): void {
    this.lines.length = 0;
    this.lineClock = 0;
    this.lineBusyUntil = 0;
  }

  /** Abandon/restore/restart must not leave a finale pan queued. */
  private cancelFinalePan(): void {
    this.panQueue.length = 0;
    this.panClock = 0;
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    if (this.failBanner > 0) {
      this.failBanner -= dt;
      if (this.failBanner <= 0) missionHud.failed = '';
    }

    // Before the early-out: the finale pan outlives the act that started it.
    this.tickFinalePan(dt);

    // Completion dialogue also outlives the MissionRun it completed.
    this.tickDialogue(dt, ctx);

    const run = this.run;
    if (!run || !run.isRunning) return;

    if (run.tick(dt) === 'timeout') {
      this.failRun('timp expirat');
      return;
    }

    this.evaluate(dt, ctx);
    this.pushHud();
  }

  /** Dialogue follows the pause-aware game clock and preserves author order. */
  private tickDialogue(dt: number, ctx: GameContext): void {
    if (this.lines.length === 0 && this.lineClock >= this.lineBusyUntil) return;
    this.lineClock += dt;
    if (this.lineClock < this.lineBusyUntil) return;
    const next = this.lines[0];
    if (!next || this.lineClock < next.at) return;
    const l = this.lines.shift()!;
    this.lineBusyUntil = this.lineClock + l.ms / 1000 + 0.16;
    ctx.events.emit('ui:subtitle', { speaker: l.speaker, text: l.text, ms: l.ms });
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
        sealed: this.ctx.tryGet(Services.BuildersHouse)?.sealed ?? true,
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
      /**
       * Fire the Act IV payoff on the spot — lights, crowd, music, pan —
       * without playing three acts first. This is how the finale is verified.
       */
      finale: () => {
        this.liberate();
        return { party: this.partyOn, pan: this.panQueue.map((p) => p.at) };
      },
      /** Skip straight to the interior pan, for framing checks. */
      finalePan: () => {
        this.queueFinalePan();
        this.panClock = 5.39;
        return true;
      },
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
    this.offLang?.();
    this.offLang = null;
    if (!this.ctx) return;
    this.clearMarkers(true);
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
