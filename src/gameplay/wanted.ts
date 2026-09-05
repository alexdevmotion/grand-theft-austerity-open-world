/** Political Instability — five Crisis Stars, and what happens when they win.
 *
 *  THE STARS were already here: heat, thresholds, decay, and a police system
 *  in `src/ai/police.ts` that turns each star into a different kind of
 *  pressure. What was missing is the other end of the arc.
 *
 *  UNTIL NOW THERE WAS NO WAY TO LOSE. Dying respawned you at the Builders
 *  House with full health, your money and your stars intact-then-cleared, and
 *  the six police cars simply gave up. A five-star chase and a quiet drive
 *  home had the same ending, which means the entire escalation ladder was
 *  decoration — nothing at the top of it could actually happen TO you.
 *
 *  So this file now owns three things:
 *
 *    ARREST      close the distance at one star or more and the Ministry
 *                takes you. On foot that is an inspector at arm's length; in
 *                a car it is being boxed in and stopped. The meter is
 *                visible and it drains, so it is a thing you can fight.
 *
 *    DETENTION   a real cost: an administrative fine, hours of your day, a
 *                release point chosen to be as far from your car as they can
 *                manage, and the escape XP you had banked for that chase
 *                taken back off you. You choose between paying and refusing,
 *                and refusing is cheaper in lei and much worse in everything
 *                else.
 *
 *    ȘPAGA       and the way out. An inspector standing in front of you at
 *                two stars will take money to see one star. It gets more
 *                expensive every time you do it, and roughly one time in
 *                seven he takes the money and books you anyway.
 *
 *  OWNER: wanted/police agent (stars, heat, decay) + consequence agent (the
 *  arrest loop below).
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Rng } from '../core/rng';
import {
  Services,
  type CharacterHandle,
  type PlayerService,
  type SearchReport,
  type WantedService,
} from '../core/services';
import { CONEXIUNI_DISCOUNT } from './progression';
import { num, t, tp } from '../core/i18n';
import type { CameraDirector } from './cameraSystem';

const STAR_THRESHOLDS = [0, 60, 160, 320, 560, 900];
const COOLDOWN_SECONDS = [0, 12, 18, 26, 36, 50];

/* ------------------------------------------------------------------ */
/* Arrest                                                              */
/* ------------------------------------------------------------------ */

/** An inspector this close to you on foot is a hand on your shoulder. */
const BUST_FOOT_RADIUS = 6.2;
/** A stopped patrol car this close on foot is two of them getting out. */
const BUST_FOOT_CAR_RADIUS = 7.5;
/** Boxed in: their car this close to yours, both of you barely moving. */
const BUST_CAR_RADIUS = 11.0;
/** Above this you are still driving, whatever is next to you. */
const BUST_OWN_SPEED = 3.6;
/** Above this THEY are still driving, and a moving car cannot arrest you. */
const BUST_UNIT_SPEED = 5.5;
/** Seconds of contact before the arrest lands. */
const BUST_FOOT_SECONDS = 1.45;
const BUST_CAR_SECONDS = 2.7;
/** The meter drains this much faster than it fills. Running works. */
const BUST_DECAY = 1.7;

/* ------------------------------------------------------------------ */
/* Detention                                                           */
/* ------------------------------------------------------------------ */

/** "Amendă administrativă", by the star you were taken at. */
const FINE_BY_STAR = [0, 420, 880, 1500, 2400, 3800];
/** In-game hours the Ministry keeps you, by whether you paid. */
const HOURS_PAID = 2;
const HOURS_HELD = 8;
/** How long the rap sheet stays up before it decides for you. */
const CHOICE_SECONDS = 8;
const GRAB_SECONDS = 2.2;
const RELEASE_SECONDS = 1.5;

/**
 * WHERE THEY PUT YOU DOWN.
 *
 * Two Ministry addresses, and which one you get is the point: pay and you are
 * released from the nearer one, refuse and they drive you to whichever is
 * FARTHER from where they picked you up. Either way your car is not there.
 */
export const RELEASE_POINTS = [
  { id: 'depozit', name: 'Depozitul Ministerului · Piața Victoriei', x: 276, z: -340 },
  { id: 'palat', name: 'Blocul de rețineri · Palatul Parlamentului', x: -92, z: -790 },
] as const;

/**
 * Which address you are let out of. Pure so the rule can be pinned by a test:
 * paying puts you at the nearer one, refusing puts you at whichever is
 * further from where you were picked up. Both are chosen at the moment of the
 * decision, so the punishment scales with where the chase actually ended.
 */
export function releasePointFor(
  caughtX: number,
  caughtZ: number,
  paid: boolean,
): (typeof RELEASE_POINTS)[number] {
  const [near, far] = RELEASE_POINTS;
  const dNear = (near.x - caughtX) ** 2 + (near.z - caughtZ) ** 2;
  const dFar = (far.x - caughtX) ** 2 + (far.z - caughtZ) ** 2;
  if (paid) return dNear <= dFar ? near : far;
  return dNear > dFar ? near : far;
}

/** The administrative fine, by the star you were taken at. */
export function fineFor(stars: number, connected: boolean): number {
  const s = Math.max(0, Math.min(5, Math.round(stars)));
  return Math.round(FINE_BY_STAR[s] * (connected ? CONEXIUNI_DISCOUNT : 1));
}

/**
 * What an inspector wants for one Crisis Star. Rises with the stars you are
 * carrying AND with how many times you have already done this — the joke only
 * works if it stops being the obvious answer after the second time.
 */
export function bribePrice(stars: number, bribesPaid: number, connected: boolean): number {
  const s = Math.max(0, Math.min(5, Math.round(stars)));
  return Math.round(
    BRIBE_BY_STAR[s] * (connected ? CONEXIUNI_DISCOUNT : 1) * Math.pow(BRIBE_INFLATION, Math.max(0, bribesPaid)),
  );
}

/* ------------------------------------------------------------------ */
/* Bribery                                                             */
/* ------------------------------------------------------------------ */

const BRIBE_ID = 'wanted:bribe';
/** What one Crisis Star costs, by how many you currently have. */
const BRIBE_BY_STAR = [0, 620, 1150, 1900, 2900, 4400];
/** How far an inspector will let you get before he is worth talking to. */
const BRIBE_RADIUS = 13;
/** Seconds before another inspector will take your money. */
const BRIBE_COOLDOWN = 13;
/** He takes it and books you anyway roughly this often. */
const BRIBE_BACKFIRE = 0.14;
/** Every successful bribe raises the going rate. Word gets around. */
const BRIBE_INFLATION = 1.28;

type Phase = 'grab' | 'choice' | 'release';

interface Detention {
  phase: Phase;
  t: number;
  /** Stars at the moment of arrest — everything is priced off this. */
  stars: number;
  fine: number;
  choice: 'pay' | 'refuse' | null;
  paid: number;
  hours: number;
  where: string;
  caughtAt: THREE.Vector3;
}

/** The economy half of `PlayerSystem`, which `PlayerService` does not carry. */
type PlayerExtras = PlayerService & {
  spend(amount: number, reason: string): boolean;
  chargeUpTo(amount: number, reason: string): number;
  heal(amount: number, reason?: string): number;
  release(p: THREE.Vector3, headingRad?: number, health?: number): void;
};

const _p = new THREE.Vector3();

export class WantedSystem implements System, WantedService {
  readonly name = 'wanted';
  readonly order = 210;

  private heat = 0;
  private _stars = 0;
  private cooldown = 0;
  /** Seconds since any Ministry unit last had eyes on the player. */
  private sinceSeen = 0;
  private ctx!: GameContext;
  private _pursuers = 0;

  /* ---- the Ministry's belief, published by the pursuit system ---- */
  /** Reused: `lastKnown` hands this out and it is read once a frame. */
  private readonly _lastKnown = new THREE.Vector3();
  private _searchRadius = 0;
  private _searchValid = false;
  private _contact = false;

  /* ---- arrest ---- */
  /** 0..1. At 1 the Ministry has you. */
  private bustMeter = 0;
  private detention: Detention | null = null;
  private inputWasEnabled = true;
  private _bustCount = 0;
  /** The "they are closing in" warning is a tutorial, so it fires once. */
  private taughtArrest = false;

  /* ---- bribery ---- */
  private bribeRng = new Rng('spaga');
  private bribeTarget: string | null = null;
  private bribeShownCost = -1;
  private bribeCooldown = 0;
  private bribesPaid = 0;

  /* ---- presentation ---- */
  private dom: BustDom | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  get stars(): number {
    return this._stars;
  }
  get cooldownRemaining(): number {
    return this.cooldown;
  }
  get pursuerCount(): number {
    return this._pursuers;
  }
  get lastKnown(): THREE.Vector3 | null {
    return this._searchValid ? this._lastKnown : null;
  }
  get searchRadius(): number {
    return this._searchValid ? this._searchRadius : 0;
  }
  get inContact(): boolean {
    return this._searchValid && this._contact;
  }

  /**
   * PUBLISHED BY `src/ai/police.ts`, ONCE A FIXED TICK.
   *
   * The star machine owns heat, thresholds and decay. It has no units, no
   * sight lines and no idea where the Ministry thinks you are — all of that
   * lives in the pursuit system. This is the seam between the two, and it
   * replaces a reflective write into this class's private `_pursuers` that
   * stood in for it while the contract had no setter.
   *
   * Stars gate it: with zero stars nobody is looking, so whatever the pursuit
   * system was mid-way through winding down is not something a map should draw.
   */
  reportSearch(r: SearchReport): void {
    this._pursuers = Math.max(0, r.pursuers | 0);
    const on = this._stars > 0 && r.lastKnown !== null && r.radius > 0;
    this._searchValid = on;
    this._contact = on && r.contact;
    if (!on) {
      this._searchRadius = 0;
      return;
    }
    this._lastKnown.copy(r.lastKnown!);
    this._searchRadius = r.radius;
  }

  /** True from the moment they have you until they let you go. */
  get detained(): boolean {
    return this.detention !== null;
  }
  /** 0..1 — how close they are to taking you. The HUD ring reads this. */
  get arrestPressure(): number {
    return this.bustMeter;
  }
  get bustCount(): number {
    return this._bustCount;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Wanted, this);

    // DYING WHILE WANTED IS NOT A RESPAWN. They scrape you up and you wake up
    // in a corridor with a fine — which is the difference between a five-star
    // chase you can lose and one you can only survive or restart.
    ctx.events.on('player:died', ({ cause }) => {
      if (cause === 'retinut') return;
      if (this._stars >= 1 && !this.detention) this.beginDetention(false);
    });

    this.buildDom();
    this.installKeys();
    this.installDebugHook();
  }

  addHeat(amount: number, _at?: THREE.Vector3): void {
    if (amount <= 0) return;
    if (this.detention) return;
    this.heat += amount;
    this.cooldown = COOLDOWN_SECONDS[Math.min(5, this._stars + 1)];
    this.recomputeStars();
  }

  setStars(n: number): void {
    const clamped = THREE.MathUtils.clamp(Math.round(n), 0, 5);
    this.heat = STAR_THRESHOLDS[clamped];
    this.recomputeStars();
  }

  clear(): void {
    this.heat = 0;
    this.cooldown = 0;
    this.bustMeter = 0;
    this.recomputeStars();
    this.ctx.events.emit('instability:cleared', {});
  }

  private recomputeStars(): void {
    let s = 0;
    for (let i = 5; i >= 0; i--) {
      if (this.heat >= STAR_THRESHOLDS[i]) { s = i; break; }
    }
    if (s !== this._stars) {
      const previous = this._stars;
      this._stars = s;
      if (s === 0) {
        this.bustMeter = 0;
        // Nobody is looking any more. Drop the Ministry's belief in the same
        // frame the stars go out rather than waiting for the pursuit system's
        // next tick, so the map never leaves a search circle on a clean city.
        this._searchValid = false;
        this._searchRadius = 0;
        this._contact = false;
        this._pursuers = 0;
      }
      this.ctx.events.emit('instability:changed', { stars: s, previous });
    }
  }

  update(dt: number, ctx: GameContext): void {
    if (this.detention) {
      this.tickDetention(dt, ctx);
      this.paint();
      return;
    }

    this.tickArrest(dt, ctx);
    this.tickBribe(dt, ctx);
    this.paint();

    if (this._stars === 0) return;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    // Level 4's `cool_head` unlock (src/gameplay/progression.ts): the whole
    // point of it is that a chase you used to lose becomes one you can break,
    // so it moves the decay rate rather than anything cosmetic.
    const base = ctx.tryGet(Services.Progression)?.has('cool_head') ? 24 * 1.45 : 24;

    /*
     * HEAT ONLY FALLS WHILE YOU ARE NOT BEING WATCHED.
     *
     * This used to decay unconditionally, every frame you were not detained,
     * with no test of line of sight or distance. Measured: four stars, parked,
     * three pursuit vans closing to 42 m — stars went 4 -> 0 in twenty-two
     * seconds. There was nothing to escape from, because standing still WAS
     * the escape. That is the whole wanted system with its teeth pulled.
     *
     * Now the Ministry has to lose you first. While any unit can see you the
     * heat holds; once nobody can, it decays, and faster the further you get
     * from where they last had you.
     */
    const police = (window as unknown as { __GTA_POLICE__?: { stats(): { visible: boolean; lostFor: number } } }).__GTA_POLICE__;
    const seen = police?.stats().visible ?? false;
    const lostFor = police?.stats().lostFor ?? 999;

    if (seen) {
      // In contact: no decay at all. Break line of sight or get taken.
      this.sinceSeen = 0;
      return;
    }
    this.sinceSeen += dt;
    // A short grace after breaking contact so a corner does not instantly
    // clear you — they sweep the last known position first.
    if (this.sinceSeen < 4 && lostFor < 4) return;

    const awayBonus = Math.min(1.6, 1 + this.sinceSeen / 18);
    this.heat = Math.max(0, this.heat - dt * base * awayBonus);
    this.recomputeStars();
  }

  /**
   * The camera system restores `input.enabled` when its own shot ends, and
   * its update runs after this one. `lateUpdate` runs after every update, so
   * this is the only place that can hold the controls for the whole of a
   * sequence that outlives the shot on top of it.
   */
  lateUpdate(_dt: number, ctx: GameContext): void {
    if (this.detention) ctx.input.enabled = false;
  }

  /* ================================================================== *
   * ARREST                                                             *
   * ================================================================== */

  private tickArrest(dt: number, ctx: GameContext): void {
    if (this._stars < 1) {
      this.bustMeter = Math.max(0, this.bustMeter - dt * 3);
      return;
    }
    const player = ctx.tryGet(Services.Player);
    if (!player) return;

    const onFoot = player.isOnFoot;
    const closing = onFoot ? this.closingOnFoot(ctx, player) : this.closingInCar(ctx, player);

    if (closing) {
      const fill = onFoot ? BUST_FOOT_SECONDS : BUST_CAR_SECONDS;
      const before = this.bustMeter;
      this.bustMeter = Math.min(1, this.bustMeter + dt / fill);
      // Teach the mechanic ONCE. A meter nobody has seen before filling to
      // full and taking the player's money is a bug report, not a mechanic;
      // one line the first time it ever moves makes it a warning.
      if (before < 0.3 && this.bustMeter >= 0.3 && !this.taughtArrest) {
        this.taughtArrest = true;
        ctx.tryGet(Services.Hud)?.toast(
          onFoot ? 'Te încolțesc — FUGI' : 'Te blochează — nu opri',
          'bad',
          2600,
        );
      }
      if (this.bustMeter >= 1) this.beginDetention(true);
    } else {
      const fill = onFoot ? BUST_FOOT_SECONDS : BUST_CAR_SECONDS;
      this.bustMeter = Math.max(0, this.bustMeter - (dt / fill) * BUST_DECAY);
    }
  }

  /** An inspector within reach, or a patrol that has stopped beside you. */
  private closingOnFoot(ctx: GameContext, player: PlayerService): boolean {
    const p = player.position;

    const peds = ctx.tryGet(Services.Peds);
    if (peds) {
      for (const c of peds.all) {
        if (!c.isAlive) continue;
        if (!isMinistry(c)) continue;
        if (planar2(c.position, p) <= BUST_FOOT_RADIUS * BUST_FOOT_RADIUS) return true;
      }
    }

    const vehicles = ctx.tryGet(Services.Vehicles);
    if (vehicles) {
      for (const v of vehicles.all) {
        // Only `police` — ambient traffic runs vans too, and being arrested by
        // a courier van would be a bug rather than a joke.
        if (v.kind !== 'police' || v.isWrecked) continue;
        if (Math.abs(v.speed) > BUST_UNIT_SPEED) continue;
        if (planar2(v.position, p) <= BUST_FOOT_CAR_RADIUS * BUST_FOOT_CAR_RADIUS) return true;
      }
    }
    return false;
  }

  /** Boxed in: you have stopped, and so has one of theirs, right there. */
  private closingInCar(ctx: GameContext, player: PlayerService): boolean {
    const own = player.inVehicle;
    if (!own) return false;
    if (own.isWrecked) return true;
    if (Math.abs(own.speed) > BUST_OWN_SPEED) return false;

    const vehicles = ctx.tryGet(Services.Vehicles);
    if (!vehicles) return false;
    for (const v of vehicles.all) {
      if (v.id === own.id || v.kind !== 'police' || v.isWrecked) continue;
      if (Math.abs(v.speed) > BUST_UNIT_SPEED) continue;
      if (planar2(v.position, own.position) <= BUST_CAR_RADIUS * BUST_CAR_RADIUS) return true;
    }
    return false;
  }

  /* ================================================================== *
   * DETENTION                                                          *
   * ================================================================== */

  private beginDetention(announce: boolean): void {
    if (this.detention) return;
    const ctx = this.ctx;
    const player = ctx.tryGet(Services.Player) as PlayerExtras | undefined;
    if (!player) return;

    const stars = Math.max(1, this._stars);

    this._bustCount++;
    this.bustMeter = 0;
    this.detention = {
      phase: 'grab',
      t: 0,
      stars,
      fine: fineFor(stars, this.connected()),
      choice: null,
      paid: 0,
      hours: 0,
      where: '',
      caughtAt: player.position.clone(),
    };

    // The chase you LOST must not pay out the evade bonus for the chase you
    // were having. `ProgressionSystem` cannot tell the two apart from
    // `instability:changed` alone.
    (ctx.tryGet(Services.Progression) as unknown as { forfeitEscape?(): void } | undefined)
      ?.forfeitEscape?.();

    // Cancel any death in progress: he is not dying, he is being taken.
    player.release(player.position.clone(), 0, Math.max(12, player.health));

    // The offer dies with the arrest — `tickBribe` does not run during
    // detention, and the player is about to be a kilometre from the man it
    // was attached to.
    const it = ctx.tryGet(Services.Interaction);
    if (it) this.dropBribeMarker(it);

    this.inputWasEnabled = ctx.input.enabled;
    ctx.input.enabled = false;

    (ctx.tryGet(Services.Camera) as CameraDirector | undefined)?.climax('busted');
    ctx.tryGet(Services.Audio)?.setMusic(null, 0.6);
    ctx.events.emit('audio:oneShot', { id: 'mission_failed', volume: 0.9 });
    if (announce) ctx.events.emit('player:died', { cause: 'retinut' });

    this.showSheet();
  }

  private tickDetention(dt: number, ctx: GameContext): void {
    const d = this.detention!;
    d.t += dt;

    switch (d.phase) {
      case 'grab':
        if (d.t >= GRAB_SECONDS) {
          d.phase = 'choice';
          d.t = 0;
          this.paintSheet();
        }
        break;

      case 'choice': {
        if (d.choice === null && d.t >= CHOICE_SECONDS) {
          // Walk away and the Ministry decides for you: it takes the money if
          // you have it, and your day if you do not.
          const player = ctx.tryGet(Services.Player) as PlayerExtras | undefined;
          this.choose(player && player.lei >= d.fine ? 'pay' : 'refuse');
        }
        this.paintSheet();
        break;
      }

      case 'release':
        if (d.t >= RELEASE_SECONDS) this.endDetention(ctx);
        break;
    }
  }

  /** E pays, Space refuses. Called by the key handler and by the harness. */
  choose(what: 'pay' | 'refuse'): boolean {
    const d = this.detention;
    if (!d || d.phase !== 'choice' || d.choice !== null) return false;
    const ctx = this.ctx;
    const player = ctx.tryGet(Services.Player) as PlayerExtras | undefined;
    if (!player) return false;

    if (what === 'pay' && player.lei < d.fine) {
      this.flashSheet(t('Nu ai atât. Rămâi.'));
      return false;
    }

    d.choice = what;
    if (what === 'pay') {
      d.paid = player.chargeUpTo(d.fine, 'amendă:reținere');
      d.hours = HOURS_PAID;
    } else {
      // Refusing is not free — it is paid in time, in distance, and in the
      // "taxă de dosar" they take anyway if you are carrying anything.
      d.paid = player.chargeUpTo(Math.round(d.fine * 0.25), 'taxă:dosar');
      d.hours = HOURS_HELD;
    }

    // Where they drop you. Paying gets you the nearer address; refusing gets
    // you whichever one is further from where they picked you up.
    const pick = releasePointFor(d.caughtAt.x, d.caughtAt.z, what === 'pay');
    d.where = pick.name;

    // The day is gone.
    const weather = ctx.tryGet(Services.Weather);
    if (weather) weather.timeOfDay = (weather.timeOfDay + d.hours) % 24;

    // Out the back door, patched up by the duty medic, with nothing on the
    // record but the bill. `release` restores the health as it puts him down.
    _p.set(pick.x, 0, pick.z);
    const ground = ctx.tryGet(Services.City)?.spatial.groundHeight(pick.x, pick.z);
    _p.y = ground !== undefined && ground > -1e5 ? ground + 0.2 : 1.0;
    player.release(_p.clone(), 0, player.maxHealth);

    this.clear();
    d.phase = 'release';
    d.t = 0;
    this.paintSheet();
    ctx.events.emit('audio:oneShot', { id: 'interact', volume: 0.6 });
    return true;
  }

  private endDetention(ctx: GameContext): void {
    const d = this.detention;
    this.detention = null;
    ctx.input.enabled = this.inputWasEnabled;
    this.hideSheet();
    if (!d) return;
    ctx.tryGet(Services.Hud)?.toast(
      d.choice === 'pay'
        ? tp('Eliberat · −{paid} lei · {hours} ore pierdute', { paid: d.paid, hours: d.hours })
        : tp('Eliberat după {hours} ore · {where}', { hours: d.hours, where: t(d.where) }),
      'bad',
      5200,
    );
  }

  /* ================================================================== *
   * ȘPAGA                                                              *
   * ================================================================== */

  /** What one star costs right now, inflation and connections included. */
  bribeCost(): number {
    return bribePrice(this._stars, this.bribesPaid, this.connected());
  }

  private connected(): boolean {
    return this.ctx.tryGet(Services.Progression)?.has('conexiuni') ?? false;
  }

  /**
   * Hand an inspector money to lose a Crisis Star. This is the only sink in
   * the game that buys you out of a mechanic rather than into one, which is
   * why it is priced above what the same money buys anywhere else — and why
   * it does not always work.
   */
  bribe(): boolean {
    const ctx = this.ctx;
    const player = ctx.tryGet(Services.Player) as PlayerExtras | undefined;
    if (!player || this._stars < 1 || this.detention) return false;
    if (this.bribeCooldown > 0) {
      ctx.tryGet(Services.Hud)?.toast('Nu chiar acum. Se uită lumea.', 'info', 2000);
      return false;
    }

    const cost = this.bribeCost();
    if (!player.spend(cost, 'șpagă:inspector')) {
      ctx.tryGet(Services.Hud)?.toast(tp('Îți cere {cost} lei. Nu-i ai.', { cost }), 'bad', 3000);
      return false;
    }

    this.bribesPaid++;
    this.bribeCooldown = BRIBE_COOLDOWN;
    this.bribeShownCost = -1;

    if (this.bribeRng.next() < BRIBE_BACKFIRE) {
      // He counts it, pockets it, and reaches for the radio.
      this.addHeat(STAR_THRESHOLDS[Math.min(5, this._stars + 1)] - this.heat + 20);
      ctx.tryGet(Services.Hud)?.toast(
        tp('A luat banii și a raportat. −{cost} lei, +1 ★', { cost }),
        'bad',
        4200,
      );
      ctx.events.emit('audio:oneShot', { id: 'mission_failed', volume: 0.5 });
      return false;
    }

    const before = this._stars;
    this.setStars(before - 1);
    this.cooldown = COOLDOWN_SECONDS[Math.min(5, this._stars)];
    ctx.tryGet(Services.Hud)?.toast(
      tp('„Pentru dosar.” −{cost} lei · {before} → {after} ★', { cost, before, after: this._stars }),
      'good',
      3600,
    );
    ctx.events.emit('audio:oneShot', { id: 'pickup', volume: 0.55 });
    return true;
  }

  /**
   * Keep an offer on whichever inspector is nearest and in front of you. The
   * marker follows him as he walks, so it reads as a man you are talking to
   * rather than a shop that happens to be standing there.
   */
  private tickBribe(dt: number, ctx: GameContext): void {
    this.bribeCooldown = Math.max(0, this.bribeCooldown - dt);
    const it = ctx.tryGet(Services.Interaction);
    if (!it) return;

    const player = ctx.tryGet(Services.Player);
    const eligible = player !== undefined && player.isOnFoot && this._stars >= 1
      && !this.detention && this.bribeCooldown <= 0;
    if (!eligible) {
      this.dropBribeMarker(it);
      return;
    }

    const peds = ctx.tryGet(Services.Peds);
    if (!peds) return;
    let best: CharacterHandle | null = null;
    let bestD = BRIBE_RADIUS * BRIBE_RADIUS;
    for (const c of peds.all) {
      if (!c.isAlive || !isMinistry(c)) continue;
      const d = planar2(c.position, player.position);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best) {
      this.dropBribeMarker(it);
      return;
    }

    const cost = this.bribeCost();
    if (this.bribeTarget !== best.id || this.bribeShownCost !== cost || !it.has(BRIBE_ID)) {
      it.remove(BRIBE_ID);
      it.add({
        id: BRIBE_ID,
        label: tp('Dă șpagă inspectorului — {cost} lei', { cost: num(cost) }),
        position: best.position.clone(),
        radius: 4.6,
        kind: 'world',
        onFoot: true,
        requireLos: false,
        color: 0xffc94a,
        onTrigger: () => {
          this.bribe();
        },
      });
      this.bribeTarget = best.id;
      this.bribeShownCost = cost;
    } else {
      it.moveTo(BRIBE_ID, best.position);
    }
  }

  private dropBribeMarker(it: { remove(id: string): void }): void {
    if (this.bribeTarget === null) return;
    it.remove(BRIBE_ID);
    this.bribeTarget = null;
    this.bribeShownCost = -1;
  }

  /* ================================================================== *
   * PRESENTATION — the arrest meter and the rap sheet.                  *
   * ================================================================== */

  private buildDom(): void {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('ui-root');
    if (!host) return;

    const style = document.createElement('style');
    style.textContent = BUST_CSS;
    host.appendChild(style);

    const root = document.createElement('div');
    root.className = 'gta-bust';
    root.innerHTML =
      `<div class="bm"><i></i><span>${t('REȚINERE')}</span></div>` +
      '<div class="sheet"><div class="card">' +
      `<div class="hdr">${t('MINISTERUL DE-ACCELERĂRII NAȚIONALE')}</div>` +
      `<div class="ttl">${t('REȚINUT')}</div>` +
      '<div class="rows"></div>' +
      '<div class="opts"></div>' +
      '<div class="note"></div>' +
      '</div></div>';
    host.appendChild(root);

    this.dom = {
      root,
      meter: root.querySelector('.bm') as HTMLElement,
      meterFill: root.querySelector('.bm i') as HTMLElement,
      sheet: root.querySelector('.sheet') as HTMLElement,
      rows: root.querySelector('.rows') as HTMLElement,
      opts: root.querySelector('.opts') as HTMLElement,
      note: root.querySelector('.note') as HTMLElement,
    };
  }

  private paint(): void {
    const d = this.dom;
    if (!d) return;
    const show = this.bustMeter > 0.04;
    d.meter.classList.toggle('on', show);
    if (show) d.meterFill.style.width = `${(this.bustMeter * 100).toFixed(1)}%`;
  }

  private showSheet(): void {
    this.dom?.root.classList.add('busted');
    this.paintSheet();
  }

  private hideSheet(): void {
    this.dom?.root.classList.remove('busted', 'sheetOn');
  }

  private paintSheet(): void {
    const d = this.detention;
    const dom = this.dom;
    if (!d || !dom) return;

    dom.root.classList.toggle('sheetOn', d.phase !== 'grab');
    if (d.phase === 'grab') return;

    const stars = '★'.repeat(d.stars) + '☆'.repeat(5 - d.stars);
    dom.rows.innerHTML =
      row(t('Instabilitate politică'), `<b class="st">${stars}</b>`) +
      row(t('Amendă administrativă'), `<b>${num(d.fine)} lei</b>`) +
      row(t('Vehicul'), `<b>${t('rămâne unde l-ai lăsat')}</b>`) +
      (d.choice
        ? row(t('Ore de „lămuriri”'), `<b>${d.hours}</b>`) +
          row(t('Eliberare'), `<b>${t(d.where)}</b>`)
        : '');

    if (d.choice === null) {
      const left = Math.max(0, CHOICE_SECONDS - d.t);
      const player = this.ctx.tryGet(Services.Player);
      const canPay = (player?.lei ?? 0) >= d.fine;
      dom.opts.innerHTML =
        `<button class="${canPay ? '' : 'off'}"><kbd>E</kbd>${tp('Plătește amenda · {fine} lei', {
          fine: num(d.fine),
        })}</button>` +
        `<button><kbd>${t('SPAȚIU')}</kbd>${tp('Refuză · {hours} ore', { hours: HOURS_HELD })}</button>`;
      dom.note.textContent = canPay
        ? tp('Decizi în {left}s. Dacă nu decizi, plătesc ei din buzunarul tău.', {
            left: left.toFixed(0),
          })
        : tp('Nu ai {fine} lei. Decizi în {left}s.', { fine: num(d.fine), left: left.toFixed(0) });
    } else {
      dom.opts.innerHTML = '';
      dom.note.textContent = d.choice === 'pay'
        ? tp('Plătit {paid} lei. Ești liber. Găsește-ți mașina.', { paid: num(d.paid) })
        : tp('Reținut {hours} ore. Taxă de dosar: {paid} lei.', {
            hours: d.hours,
            paid: num(d.paid),
          });
    }
  }

  private flashSheet(text: string): void {
    const dom = this.dom;
    if (!dom) return;
    dom.note.textContent = text;
    dom.note.classList.remove('flash');
    void dom.note.offsetWidth;
    dom.note.classList.add('flash');
  }

  private installKeys(): void {
    if (typeof window === 'undefined') return;
    const h = (e: KeyboardEvent): void => {
      const d = this.detention;
      if (!d || d.phase !== 'choice' || d.choice !== null) return;
      if (e.code === 'KeyE' || e.code === 'KeyF' || e.code === 'Enter') this.choose('pay');
      else if (e.code === 'Space' || e.code === 'Escape') this.choose('refuse');
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    this.keyHandler = h;
    window.addEventListener('keydown', h, true);
  }

  /* ------------------------------------------------------------------ */

  private installDebugHook(): void {
    if (typeof window === 'undefined') return;
    (window as unknown as { __GTA_WANTED__: unknown }).__GTA_WANTED__ = {
      state: () => ({
        stars: this._stars,
        heat: Math.round(this.heat),
        cooldown: Math.round(this.cooldown * 10) / 10,
        arrestPressure: Math.round(this.bustMeter * 100) / 100,
        detained: this.detention !== null,
        phase: this.detention?.phase ?? null,
        choice: this.detention?.choice ?? null,
        fine: this.detention?.fine ?? 0,
        bustCount: this._bustCount,
        bribeCost: this.bribeCost(),
        bribesPaid: this.bribesPaid,
        bribeOffered: this.bribeTarget !== null,
        bribeCooldown: Math.round(this.bribeCooldown * 10) / 10,
      }),
      setStars: (n: number) => this.setStars(n),
      heat: (n: number) => this.addHeat(n),
      clear: () => this.clear(),
      /** Take the player now, without waiting for a patrol to catch up. */
      bust: () => {
        if (this._stars < 1) this.setStars(2);
        this.beginDetention(true);
        return true;
      },
      choose: (what: 'pay' | 'refuse') => this.choose(what),
      bribe: () => this.bribe(),
      /** Force the arrest meter, to look at the ring without a chase. */
      pressure: (v: number) => {
        this.bustMeter = THREE.MathUtils.clamp(v, 0, 1);
        this.paint();
        return this.bustMeter;
      },
    };
  }

  dispose(): void {
    if (this.keyHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.keyHandler, true);
    }
    this.keyHandler = null;
    this.dom?.root.remove();
    this.dom = null;
  }
}

/* ------------------------------------------------------------------ */

interface BustDom {
  root: HTMLElement;
  meter: HTMLElement;
  meterFill: HTMLElement;
  sheet: HTMLElement;
  rows: HTMLElement;
  opts: HTMLElement;
  note: HTMLElement;
}

function isMinistry(c: CharacterHandle): boolean {
  return c.archetype === 'ministryAgent' || c.archetype === 'police'
    || c.faction === 'ministry' || c.faction === 'police';
}

/** Squared planar distance — no square roots in a per-frame proximity scan. */
function planar2(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function row(k: string, v: string): string {
  return `<div class="r"><span>${k}</span><i></i>${v}</div>`;
}

const BUST_CSS = `
.gta-bust{position:absolute;inset:0;pointer-events:none;z-index:38;}

.gta-bust .bm{position:absolute;left:50%;top:88px;transform:translateX(-50%) translateY(-6px);
  width:236px;opacity:0;transition:opacity .18s,transform .18s;}
.gta-bust .bm.on{opacity:1;transform:translateX(-50%) translateY(0);}
.gta-bust .bm span{display:block;margin-top:5px;text-align:center;
  font:800 10.5px/1 Inter,system-ui,sans-serif;letter-spacing:.34em;color:#ff8fb4;
  text-shadow:0 1px 5px #000;}
.gta-bust .bm::before{content:'';position:absolute;inset:0 0 auto 0;height:5px;
  background:rgba(10,4,18,.75);border:1px solid rgba(255,61,127,.45);border-radius:3px;}
.gta-bust .bm i{position:absolute;left:1px;top:1px;height:3px;width:0;border-radius:2px;
  background:linear-gradient(90deg,#ff3d7f,#ffb03a);box-shadow:0 0 10px #ff3d7f;}

/* The wash CREEPS IN over the arrest shot rather than replacing it: for the
   first two seconds you are watching the camera swing round onto you while
   the frame goes dark, and only then does the paperwork land. Slamming to
   full black immediately would throw away the one shot in the sequence. */
.gta-bust .sheet{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  background:radial-gradient(120% 100% at 50% 40%,rgba(30,6,30,.72),rgba(4,2,9,.96));
  opacity:0;transition:opacity .5s ease;}
.gta-bust.busted .sheet{opacity:.45;transition:opacity 2.05s cubic-bezier(.4,0,.9,.6);}
.gta-bust.busted.sheetOn .sheet{opacity:1;transition:opacity .45s ease;}

.gta-bust .card{width:min(560px,74vw);padding:26px 30px 24px;
  background:rgba(10,5,18,.9);border:1px solid rgba(255,61,127,.35);
  border-top:3px solid #ff3d7f;box-shadow:0 30px 90px rgba(0,0,0,.7);
  font-family:Inter,system-ui,sans-serif;color:#efe3ff;
  opacity:0;transform:translateY(14px) scale(.985);
  transition:opacity .45s ease,transform .45s cubic-bezier(.16,.84,.3,1);}
.gta-bust.sheetOn .card{opacity:1;transform:none;}
.gta-bust .hdr{font:800 10px/1 Inter,system-ui,sans-serif;letter-spacing:.28em;
  color:rgba(226,196,255,.62);text-transform:uppercase;}
.gta-bust .ttl{margin:8px 0 18px;font:900 46px/1 Inter,system-ui,sans-serif;letter-spacing:.1em;
  color:#fff;text-transform:uppercase;}
.gta-bust .r{display:flex;align-items:baseline;gap:8px;padding:6px 0;
  font:600 13px/1.3 Inter,system-ui,sans-serif;color:rgba(220,206,244,.78);}
.gta-bust .r i{flex:1;border-bottom:1px dotted rgba(255,255,255,.18);}
.gta-bust .r b{color:#fff;font-weight:800;font-variant-numeric:tabular-nums;}
.gta-bust .r b.st{color:#ff3d7f;letter-spacing:.12em;}
.gta-bust .opts{display:flex;flex-direction:column;gap:8px;margin-top:20px;}
.gta-bust .opts button{display:flex;align-items:center;gap:12px;width:100%;
  padding:11px 14px;background:rgba(255,61,127,.09);border:1px solid rgba(255,61,127,.4);
  border-radius:3px;font:700 14px/1 Inter,system-ui,sans-serif;color:#f8ecff;text-align:left;}
.gta-bust .opts button.off{opacity:.4;}
.gta-bust .opts kbd{display:inline-flex;align-items:center;justify-content:center;
  min-width:30px;height:24px;padding:0 8px;border-radius:3px;background:#f4eaff;color:#160a22;
  font:800 11px/1 Inter,system-ui,sans-serif;}
.gta-bust .note{margin-top:14px;font:600 12px/1.5 Inter,system-ui,sans-serif;
  color:rgba(214,196,244,.62);}
.gta-bust .note.flash{animation:gtaBustFlash .5s ease;}
@keyframes gtaBustFlash{0%,100%{color:rgba(214,196,244,.62);}30%{color:#ff5d95;}}
`;
