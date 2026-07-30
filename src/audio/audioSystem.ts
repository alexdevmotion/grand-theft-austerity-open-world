/** Audio.
 *
 *  The whole audio layer for GRAND THEFT AUSTERITY. Everything except the
 *  imported *Ce Ne Enervează* voice clips and the Fecioreasca folk recording is
 *  synthesised with WebAudio — engines, tyres, impacts, sirens, footsteps,
 *  rain, wind, crowds, trams and the mission stings all come out of
 *  oscillators, noise and filters (src/audio/bank.ts, engineModel.ts).
 *
 *  Graph topology
 *  --------------
 *      one-shot pool ─┐
 *      siren voices  ─┤─▶ [sfx]
 *      police squawk ─┘
 *      vehicle voices ──▶ [vehicles]
 *      radio speech ────▶ [voice]
 *      folk bed / afterparty / house speaker ─▶ [music]
 *      8-layer city bed ─▶ [ambience]
 *
 *      every bus:  input ─▶ volume ─▶ duck ─▶ masterIn ─▶ limiter ─▶ master
 *                                          └─▶ analyser (metering tap)
 *
 *  Verification: `window.__GTA_AUDIO__` exposes per-bus RMS/peak/hold-peak and
 *  spectral centroid, plus the live engine/ambience/radio state, so every claim
 *  in the report is a measurement rather than an assertion.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Rng } from '../core/rng';
import {
  Services, type AudioService, type CityService, type DistrictKind, type VehicleHandle,
} from '../core/services';
import { SfxBank, renderEngineNoiseLoop, renderSquealLoop, toAudioBuffer, type SfxId } from './bank';
import { AudioGraph, BUS_NAMES, type BusName } from './graph';
import { clamp } from './dsp';
import { SlotPool, Spatialiser, type SpatialSlot } from './spatial';
import { VehicleVoice, type VehicleProbe } from './vehicleVoice';
import { SirenVoice } from './siren';
import { AmbienceBed } from './ambience';
import { Radio, STATIONS, STATION_LABELS, type StationId } from './radio';
import { sirenModeForStars } from './sirenModel';
import { CLIPS, bucketsFor, FOLK_TITLE } from './clips';
import type { EngineClass } from './engineModel';
import { VoiceDirector } from './voiceDirector';
import { EMITTER_SPEAKER, StreetVoices } from './streetVoices';
import { VOICE_CONTEXTS, type VoiceContext } from './clipContexts';

/** Maximum simultaneously synthesised engines. */
const MAX_ENGINE_VOICES = 6;
/** Maximum simultaneously synthesised sirens. */
const MAX_SIREN_VOICES = 3;
/** Pooled spatial slots for one-shots. */
const ONESHOT_SLOTS = 24;

interface VehicleInternals {
  throttle?: number;
  handbrakeInput?: boolean;
  wheelSlip?: number[];
  wheelContact?: boolean[];
  wheelCompression?: number[];
  siren?: number;
  airTime?: number;
}

interface Tracked {
  handle: VehicleHandle;
  prevPos: THREE.Vector3;
  velocity: THREE.Vector3;
  prevCompression: number[];
  knockCooldown: number;
  distance: number;
  /* ---- foley state ---- */
  /** Smoothed |d(compression)/dt| across the wheels — how hard the road works. */
  suspensionActivity: number;
  /** 0..1 how far off the carriageway this car is, refreshed at 10 Hz. */
  roughness: number;
  roughTimer: number;
  prevHandbrake: boolean;
  /** Seconds until the next body rattle burst is allowed. */
  rattleTimer: number;
  /** Set once the car is braking hard, so the stop gets one squeal, not fifty. */
  brakeArmed: boolean;
  prevSpeed: number;
  /** Yaw last frame, for the tram flange screech. */
  prevYaw: number;
  screechCooldown: number;
}

export interface AudioDebugApi {
  ready(): boolean;
  levels(): Record<string, { rms: number; peak: number; rmsDb: number; peakDb: number; holdPeakDb: number }>;
  centroid(bus?: BusName | 'master'): number;
  spectrum(bus?: BusName | 'master'): number[];
  resetPeaks(): void;
  state(): Record<string, unknown>;
  play(id: string, x?: number, y?: number, z?: number, volume?: number): void;
  say(bucketName: string, priority?: number): boolean;
  setStation(s: string): void;
  station(): string;
  nextStation(): string;
  stations(): string[];
  setMusic(track: string | null): void;
  setMasterVolume(v: number): void;
  setBusVolume(bus: string, v: number): void;
  /** Every voice clip played this session and how often. */
  clipUsage(): Array<{ key: string; phrase: string; buckets: string[]; plays: number }>;
  sfxIds(): string[];
  /** Force the bank/ambience/radio to finish loading; resolves when audible. */
  waitReady(timeoutMs?: number): Promise<boolean>;
  /**
   * Verification hooks. These exist so causality can be proved by measurement
   * — emit an event, watch the right bus rise — without needing to stage a
   * real five-star pursuit in the middle of the city.
   */
  emit(event: string, payload?: Record<string, unknown>): void;
  forceSiren(count: number, stars: number, seconds: number): void;
  setAmbience(district: string, hours: number, rain: number): void;
  clearAmbienceOverride(): void;
  /** Curated-line hooks: `clipContexts.ts` contexts, the street, the director. */
  context(name: string, priority?: number): boolean;
  contexts(): string[];
  voice(): Record<string, unknown>;
  streetVoices(): Array<Record<string, unknown>>;
  /** Force a street emitter to speak from a given world position, now. */
  sayStreet(index?: number): boolean;
  /** Move the street emitters next to the listener so a probe can hear them. */
  placeStreetAt(x: number, y: number, z: number): void;
  /** Live per-vehicle model readout: rpm, gear, load, tyre, brake. */
  vehicles(): Array<Record<string, unknown>>;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _zero = new THREE.Vector3();

/** Ground-height taps around a vehicle, in metres. Roughly a car footprint. */
const ROUGH_TAPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1.5, 0], [-1.5, 0], [0, 1.8], [0, -1.8],
];

export class AudioSystem implements System, AudioService {
  readonly name = 'audio';
  readonly order = 410;

  private _ctx: AudioContext | null = null;
  private _ready = false;
  private _building = false;
  private listener: THREE.Object3D | null = null;
  private ctx!: GameContext;
  private rng = new Rng('gta-audio');

  private g: AudioGraph | null = null;
  private bank: SfxBank | null = null;
  private spatial: Spatialiser | null = null;
  private oneShotPool: SlotPool | null = null;
  private ambience: AmbienceBed | null = null;
  private radio: Radio | null = null;
  private director: VoiceDirector | null = null;
  private street: StreetVoices | null = null;

  private engineVoices: VehicleVoice[] = [];
  private voiceByVehicle = new Map<string, VehicleVoice>();
  private sirenVoices: SirenVoice[] = [];
  private sirenSlots: SpatialSlot[] = [];
  private sirenPool: SlotPool | null = null;

  private bound = new Map<string, THREE.Object3D>();
  private tracked = new Map<string, Tracked>();
  private startedVehicles = new Set<string>();
  private suppressEngineUntil = new Map<string, number>();
  private reassignTimer = 0;

  private pendingOneShots: Array<{ id: string; pos?: THREE.Vector3; vol?: number }> = [];
  private cooldowns = new Map<string, number>();
  private stars = 0;
  private houseInstalled = false;
  private streetBedsInstalled = false;
  private ambienceOverride: { district: DistrictKind; hours: number; rain: number } | null = null;
  private ambienceFlavourTimer = 4;

  /* ---- the moments the curated lines hang off ---- */
  /** Metres driven since the last fuel gag. */
  private metresDriven = 0;
  /** Seconds the player has been standing on it. */
  private hardAccelFor = 0;
  /** Peds whose footfalls we are currently faking, and when the next one is. */
  private pedStepAt = new Map<string, number>();
  private pedStepScan = 0;
  /** Crowd headcount near the listener, drives the murmur. */
  private crowdNear = 0;
  private lastDistrict: DistrictKind | null = null;
  private kerbEventCooldown = 0;
  private nearMissCooldown = 0;

  masterVolume = 0.8;

  get ready(): boolean {
    return this._ready;
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Audio, this);

    // Browsers require a gesture; unlock on first click/keypress.
    const unlock = () => {
      void this.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // Nobody else calls setListener, so bind the camera ourselves. A later
    // caller simply overrides it.
    this.listener = ctx.camera;

    this.subscribe(ctx);
    this.installDebugApi();
  }

  async unlock(): Promise<void> {
    if (this._ready || this._building) return;
    this._building = true;
    try {
      this._ctx = new AudioContext({ latencyHint: 'interactive' });
      await this._ctx.resume();

      const ac = this._ctx;
      this.g = new AudioGraph(ac);
      this.g.masterVolume = this.masterVolume = this.g.mix.master;

      this.spatial = new Spatialiser(ac);
      if (this.listener) this.spatial.bind(this.listener);

      this.oneShotPool = new SlotPool(ac, this.g.bus('sfx').input, ONESHOT_SLOTS);
      for (const s of this.oneShotPool.all) this.spatial.track(s);

      // Shared noise beds — one buffer for every engine and tyre in the city.
      const noise = toAudioBuffer(ac, renderEngineNoiseLoop(ac.sampleRate, this.rng.fork('engine-noise')));
      const squeal = toAudioBuffer(ac, renderSquealLoop(ac.sampleRate, this.rng.fork('squeal')));

      const vehBus = this.g.bus('vehicles').input;
      for (let i = 0; i < MAX_ENGINE_VOICES; i++) {
        this.engineVoices.push(new VehicleVoice(ac, `voice${i}`, noise, squeal, vehBus));
      }

      this.sirenPool = new SlotPool(ac, this.g.bus('sfx').input, MAX_SIREN_VOICES);
      for (let i = 0; i < MAX_SIREN_VOICES; i++) {
        const slot = this.sirenPool.all[i];
        slot.configure({ refDistance: 16, rolloff: 0.85, maxDistance: 420 });
        slot.active = true;
        slot.gain.gain.value = 1;
        this.spatial.track(slot);
        const sv = new SirenVoice(ac, slot.panner, i * 0.37);
        this.sirenVoices.push(sv);
        this.sirenSlots.push(slot);
      }

      this.ambience = new AmbienceBed(ac, this.g.bus('ambience').input);
      this.radio = new Radio(ac, this.g, this.ctx.events);

      // One mouth for the whole game. Everything that speaks — the car radio,
      // the facade screens, a kiosk on the pavement — books time through here,
      // which is what makes "never interrupt a line" enforceable at all.
      this.director = new VoiceDirector(
        ac,
        {
          load: (f) => this.radio!.clipLoader.load(f),
          cached: (f) => this.radio!.clipLoader.cached(f),
        },
        this.ctx.events,
        this.radio.voiceInput(),
      );
      this.radio.attachDirector(this.director);

      this.street = new StreetVoices(
        ac,
        this.g.bus('voice').input,
        this.g.bus('music').input,
      );

      this._ready = true;

      // Bank + folk track continue in the background; the game is already
      // making noise (ambience, engines) before they land.
      this.bank = new SfxBank(ac);
      void this.bank.build();
      void this.radio.preload();
    } catch (err) {
      console.error('[audio] unlock failed', err);
    } finally {
      this._building = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* AudioService                                                      */
  /* ---------------------------------------------------------------- */

  oneShot(id: string, position?: THREE.Vector3, volume?: number): void {
    if (!this._ready || !this.bank || !this.oneShotPool || !this.g) {
      // Before unlock: remember a couple so the first gesture is not silent.
      if (this.pendingOneShots.length < 8) {
        this.pendingOneShots.push({ id, pos: position?.clone(), vol: volume });
      }
      return;
    }
    this.playSfx(this.resolveSfxId(id, position), position, volume ?? 1);
  }

  bindEngine(vehicleId: string, obj: THREE.Object3D): void {
    this.bound.set(vehicleId, obj);
  }

  unbindEngine(vehicleId: string): void {
    this.bound.delete(vehicleId);
    const v = this.voiceByVehicle.get(vehicleId);
    if (v) {
      v.silence();
      this.voiceByVehicle.delete(vehicleId);
    }
    this.tracked.delete(vehicleId);
  }

  setMusic(track: string | null, fadeSeconds = 2): void {
    this.radio?.setMusic(track, fadeSeconds);
  }

  setListener(obj: THREE.Object3D): void {
    this.listener = obj;
    this.spatial?.bind(obj);
  }

  /* ---------------------------------------------------------------- */
  /* Event wiring                                                      */
  /* ---------------------------------------------------------------- */

  private subscribe(ctx: GameContext): void {
    const e = ctx.events;

    e.on('audio:oneShot', ({ id, position, volume }) => this.oneShot(id, position, volume));

    e.on('vehicle:collision', ({ vehicleId, impulse, position }) => {
      // Contact force magnitudes span ~1e4 (kerb scrape) to ~5e5 (head-on), so
      // grade them logarithmically.
      const sev = clamp((Math.log10(Math.max(1, impulse)) - 4.0) / 1.45, 0, 1);
      const v = ctx.tryGet(Services.Vehicles)?.get(vehicleId);
      const speed = Math.abs(v?.speed ?? 0);

      // A glancing blow at speed is a scrape, not a hit — the collision event
      // stream is the only signal we get for sustained contact, so a low
      // severity while still travelling fast is read as bodywork on masonry.
      const grazing = sev < 0.26 && speed > 7;
      // Three layers can land in the same millisecond, so each is trimmed to
      // keep the sum off the bus ceiling — measured worst case is -3.9 dBFS on
      // the SFX bus for a 5e5 N head-on.
      if (grazing) {
        this.playSfx('scrape', position, 0.32 + sev * 0.4, 0.85 + Math.min(0.5, speed / 40));
      } else {
        const id: SfxId = sev > 0.66 ? 'impact_heavy' : sev > 0.3 ? 'impact_medium' : 'impact_light';
        this.playSfx(id, position, 0.44 + sev * 0.40);
      }
      if (sev > 0.45) this.playSfx('impact_glass', position, 0.20 + sev * 0.30);
      if (sev > 0.2) this.playSfx('suspension_knock', position, 0.18 + sev * 0.28);

      const player = ctx.tryGet(Services.Player);
      if (player?.inVehicle?.id === vehicleId) {
        // clipContexts.ts splits these deliberately: a kerb tap gets "Băi, tu
        // ești prost?", a write-off gets "mă fac de râs, mă vede lumea".
        if (sev > 0.55 && this.cool('crashVoBig', 14)) {
          this.say('collisionMajor', 2.4);
        } else if (sev > 0.22 && this.cool('crashVo', 9)) {
          this.say('collisionMinor', 2);
        }
        // Panels let go on a real hit; the Dacia keeps doing it afterwards.
        if (sev > 0.3) this.playSfx('body_rattle', position, 0.3 + sev * 0.45);
      }
    });

    e.on('vehicle:destroyed', ({ vehicleId }) => {
      const v = ctx.tryGet(Services.Vehicles)?.get(vehicleId);
      this.playSfx('explosion', v?.position, 0.9);
      this.playSfx('tyre_burst', v?.position, 0.45);
      const player = ctx.tryGet(Services.Player);
      if (player?.inVehicle?.id === vehicleId || (v && this.near(v.position, 45))) {
        this.radio?.say('bigCrash', 3);
      }
    });

    e.on('prop:broken', ({ kind, position }) => {
      const id = propSfx(kind);
      this.playSfx(id, position, 0.85);
    });

    e.on('ped:killed', ({ position }) => {
      this.playSfx('body_fall', position, 0.8);
      if (this.cool('pedVo', 14)) this.radio?.say('pedHit', 2);
    });

    e.on('player:damaged', ({ amount }) => {
      if (amount > 12 && this.cool('hurtVo', 18)) this.radio?.say('playerHurt', 1.5);
    });

    e.on('player:died', () => {
      this.playSfx('mission_failed', undefined, 0.9);
      this.radio?.say('playerDied', 4);
    });

    e.on('player:enteredVehicle', ({ vehicleId }) => this.onEnterVehicle(vehicleId));
    e.on('player:exitedVehicle', ({ vehicleId }) => {
      const p = ctx.tryGet(Services.Player)?.position;
      const v = ctx.tryGet(Services.Vehicles)?.get(vehicleId);
      // A Dacia door does not click shut, it goes off like a skip lid and the
      // whole shell answers.
      this.playSfx('car_door', p, v?.kind === 'dacia' ? 0.85 : 0.7, v?.kind === 'dacia' ? 0.88 : 1);
      if (v?.kind === 'dacia') {
        window.setTimeout(() => this.playSfx('body_rattle', p, 0.3), 90);
      }
    });

    e.on('instability:changed', ({ stars, previous }) => {
      this.stars = stars;
      if (stars > previous) {
        this.playSfx('star_up', undefined, 0.75);
        // Five stars gets the apocalyptic material ("sfârșitul ciudat",
        // "Există Dumnezeu"); anything below gets the ANAF-penalty register.
        if (stars >= 5) this.say('starsMax', 3.2);
        else if (!this.say('starsUp', 3)) {
          const b = (`star${clamp(stars, 1, 5)}`) as 'star1' | 'star2' | 'star3' | 'star4' | 'star5';
          this.radio?.say(b, 3);
        }
      } else if (stars < previous) {
        this.playSfx('star_down', undefined, 0.6);
        if (stars === 0 && !this.say('escaped', 2.2)) this.radio?.say('starCleared', 2);
      }
    });

    e.on('instability:cleared', () => {
      this.stars = 0;
      this.playSfx('star_down', undefined, 0.6);
      if (!this.say('escaped', 2.2)) this.radio?.say('starCleared', 2);
    });

    e.on('economy:changed', ({ delta }) => {
      if (Math.abs(delta) < 40) return;
      this.playSfx('pickup', undefined, 0.5);
      if (this.cool('moneyVo', 26)) this.say('money', 1.6);
    });

    e.on('mission:advance', () => {
      this.playSfx('mission_start', undefined, 0.8);
      // "Vom trimite în luptă arma noastră cea mai bună: Georgian." — the
      // evidence courier is the person a mission brief is about.
      if (!this.say('recorder', 2.5)) this.radio?.say('missionStart', 2.5);
    });
    e.on('mission:complete', () => {
      this.playSfx('mission_complete', undefined, 0.85);
      this.radio?.say('missionComplete', 2.5);
    });
    e.on('mission:failed', () => {
      this.playSfx('mission_failed', undefined, 0.85);
      this.radio?.say('missionFailed', 2.5);
    });

    e.on('activity:started', () => {
      this.playSfx('activity_start', undefined, 0.7);
      this.radio?.say('activityStart', 1.5);
    });
    e.on('activity:finished', ({ score }) => {
      this.playSfx(score > 0 ? 'activity_win' : 'mission_failed', undefined, 0.75);
      this.radio?.say(score > 0 ? 'activityWin' : 'activityLose', 2);
    });

    e.on('weather:changed', ({ preset }) => {
      if (preset === 'rain' || preset === 'stormRain') {
        if (this.cool('rainVo', 60)) this.radio?.say('rain', 0.9);
        if (preset === 'stormRain') this.playSfx('thunder', undefined, 0.7);
      }
    });

    e.on('broadcast:hijacked', () => {
      // Act 3: the commentator takes the national address apart. "We're
      // winning too much. We can't take it anymore."
      this.radio?.setStation('enerveaza');
      this.say('broadcastWin', 5);
      this.say('georgescu', 4.6);
      this.radio?.say('broadcast', 4.4);
      this.playSfx('radio_static', undefined, 0.7);
    });

    // Police dispatch already writes its own subtitle; give it the squawk.
    e.on('radio:line', () => {
      this.playSfx('radio_click', undefined, 0.5);
      this.playSfx('radio_static', undefined, 0.28);
    });
  }

  private onEnterVehicle(vehicleId: string): void {
    const v = this.ctx.tryGet(Services.Vehicles)?.get(vehicleId);
    const dacia = v?.kind === 'dacia';
    this.playSfx('car_door', v?.position, dacia ? 0.85 : 0.7, dacia ? 0.88 : 1);
    if (!this._ready) return;
    const first = !this.startedVehicles.has(vehicleId);
    this.startedVehicles.add(vehicleId);
    // docs/STORY.md: "It coughs on first start and the radio comes on with it."
    if (first) {
      this.playSfx('dacia_cough', v?.position, dacia ? 0.9 : 0.5, dacia ? 1 : 1.6);
      this.suppressEngineUntil.set(vehicleId, (this._ctx?.currentTime ?? 0) + (dacia ? 1.25 : 0.6));
      if (dacia) {
        // The shell settles after the starter lets go.
        window.setTimeout(() => this.playSfx('body_rattle', v?.position, 0.34), 1300);
        // "Nu ne lansăm niciunde. Pare că ne vom târî și atât." — the curated
        // first-start lines are all about a country held together with wire.
        window.setTimeout(() => {
          if (!this.say('carFirstStart', 2.5)) this.radio?.say('daciaFirstStart', 2.5);
        }, 1700);
      }
    }
    this.radio?.powerOn();
    this.playSfx('radio_click', v?.position, 0.4);
  }

  /**
   * Book a curated line for a game moment. Everything reactive goes through
   * here rather than through `radio.say`, because these are the lines that were
   * chosen for the moment rather than for the station.
   */
  private say(context: VoiceContext, priority = 1): boolean {
    return this.director?.request(context, priority) ?? false;
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  /** Smoothed cost of this system's own update, ms/frame. */
  private _updateMs = 0;
  private _updateMsPeak = 0;

  update(dt: number, ctx: GameContext): void {
    if (!this._ready || !this.g || !this.spatial || !this.radio || !this.ambience) return;
    const t0 = performance.now();
    this.updateInner(dt, ctx);
    const cost = performance.now() - t0;
    this._updateMs += (cost - this._updateMs) * 0.05;
    if (cost > this._updateMsPeak) this._updateMsPeak = cost;
  }

  private updateInner(dt: number, ctx: GameContext): void {
    const g = this.g!;
    const spatial = this.spatial!;
    const radio = this.radio!;
    const ambience = this.ambience!;

    // Drain anything queued before unlock.
    if (this.pendingOneShots.length && this.bank?.size) {
      for (const p of this.pendingOneShots) this.oneShot(p.id, p.pos, p.vol);
      this.pendingOneShots.length = 0;
    }

    for (const [k, t] of this.cooldowns) {
      const n = t - dt;
      if (n <= 0) this.cooldowns.delete(k);
      else this.cooldowns.set(k, n);
    }

    const physics = ctx.tryGet(Services.Physics);
    spatial.update(dt, physics);
    this.oneShotPool?.reap(this._ctx!.currentTime);

    const player = ctx.tryGet(Services.Player);
    const weather = ctx.tryGet(Services.Weather);
    const city = ctx.tryGet(Services.City);
    const wanted = ctx.tryGet(Services.Wanted);
    this.stars = wanted?.stars ?? this.stars;

    const listenerPos = spatial.listenerPosition;
    const listenerVel = spatial.listenerVelocity;

    // --- radio station cycling (R) ---
    if (ctx.input.actionPressed('radioNext')) {
      radio.next();
      this.playSfx('radio_static', undefined, 0.5);
    }

    // --- vehicles ---
    this.updateVehicles(dt, ctx, listenerPos, listenerVel, weather?.wetness ?? 0, player?.inVehicle?.id ?? null);
    this.updateSirens(dt, ctx, listenerPos, listenerVel);
    this.driverMoments(dt, ctx, listenerPos);

    // --- people ---
    this.updatePeople(dt, ctx, listenerPos, !player?.inVehicle);

    // --- ambience ---
    const ov = this.ambienceOverride;
    const district: DistrictKind = ov ? ov.district
      : city && listenerPos ? city.districtAt(listenerPos.x, listenerPos.z)
      : 'bulevard';
    ambience.update({
      district,
      hours: ov ? ov.hours : weather?.timeOfDay ?? 12,
      rain: ov ? ov.rain : weather?.rainIntensity ?? 0,
      wetness: ov ? ov.rain : weather?.wetness ?? 0,
      inCabin: !!player?.inVehicle,
      stars: this.stars,
      speed: player?.inVehicle?.speed ?? 0,
      crowd: this.crowdNear,
    }, dt);
    this.ambienceFlavour(dt, district, listenerPos);
    this.districtVoice(district, listenerPos, city);

    // --- the jokes ---
    this.director?.update(dt);
    this.street?.update(
      dt, city, listenerPos, !player?.inVehicle,
      !!this.director?.speaking,
      (e) => {
        const ok = this.director?.requestStreet(e.input, EMITTER_SPEAKER[e.kind]) ?? false;
        if (ok && e.kind === 'doorway') this.playSfx('shop_bell', e.position, 0.4);
        return ok;
      },
    );
    // The kiosk radio drops its music under its own joke.
    this.street?.setBedDuck(this.director?.duck ?? 0);
    if (!this.streetBedsInstalled && this.street && radio.folk) {
      this.street.installBeds(radio.folk);
      this.streetBedsInstalled = true;
    }

    // --- radio ---
    const pv = player?.inVehicle ?? null;
    radio.update(dt, {
      inCabin: !!pv,
      vehiclePosition: pv ? pv.position : null,
      vehicleDistance: pv ? 0 : this.nearestPoweredVehicleDistance(ctx, listenerPos),
      powered: true,
    });

    if (!this.houseInstalled && city) this.tryInstallHouseSpeaker(city);

    // --- mixing ---
    this.applyDucking(dt);

    // --- metering (every frame, so no transient is missed) ---
    g.sample();
  }

  private updateVehicles(
    dt: number, ctx: GameContext,
    listenerPos: THREE.Vector3, listenerVel: THREE.Vector3,
    wetness: number, playerVehicleId: string | null,
  ): void {
    const vehicles = ctx.tryGet(Services.Vehicles);
    if (!vehicles) return;

    // Reassign voices at 10 Hz — the distance ordering does not change fast.
    this.reassignTimer -= dt;
    if (this.reassignTimer <= 0) {
      this.reassignTimer = 0.1;
      this.assignVoices(vehicles.all, listenerPos, playerVehicleId);
    }

    const now = this._ctx!.currentTime;
    for (const [id, voice] of this.voiceByVehicle) {
      const t = this.tracked.get(id);
      if (!t) {
        voice.silence();
        continue;
      }
      const h = t.handle;
      const internals = h as unknown as VehicleInternals;

      // Velocity by differencing — the handle does not expose linvel.
      if (dt > 1e-4) {
        _v.subVectors(h.position, t.prevPos).divideScalar(dt);
        if (_v.lengthSq() < 6400) t.velocity.copy(_v);
      }
      t.prevPos.copy(h.position);
      t.distance = h.position.distanceTo(listenerPos);

      const contact = internals.wheelContact;
      const grounded = contact && contact.length
        ? contact.reduce((n, c) => n + (c ? 1 : 0), 0) / contact.length
        : 1;
      const slipArr = internals.wheelSlip;
      let slip = 0;
      if (slipArr) for (const s of slipArr) if (s > slip) slip = s;

      const isPlayer = id === playerVehicleId;
      const suppressUntil = this.suppressEngineUntil.get(id) ?? 0;
      const suppressed = now < suppressUntil;

      // --- how hard the road is working the car -------------------------
      const comp0 = internals.wheelCompression;
      let activity = 0;
      if (comp0 && dt > 1e-4) {
        for (let i = 0; i < comp0.length; i++) {
          const prev = t.prevCompression[i] ?? comp0[i];
          activity += Math.abs(comp0[i] - prev);
        }
        activity /= Math.max(1, comp0.length) * dt;
      }
      t.suspensionActivity += (activity - t.suspensionActivity) * Math.min(1, dt * 6);

      // --- on the road, or on somebody's pavement? ----------------------
      t.roughTimer -= dt;
      if (t.roughTimer <= 0) {
        t.roughTimer = 0.1;
        t.roughness = this.roughnessAt(h.position);
      }

      const probe: VehicleProbe = {
        id,
        kind: h.kind as EngineClass,
        position: h.position,
        velocity: t.velocity,
        speed: suppressed ? 0 : h.speed,
        throttle: suppressed ? 0 : (internals.throttle ?? 0),
        handbrake: !!internals.handbrakeInput,
        slip,
        grounded,
        wrecked: h.isWrecked,
        airborne: (internals.airTime ?? 0) > 0.25,
        isPlayer,
        distance: suppressed ? 999 : t.distance,
        roughness: t.roughness,
        damage: clamp(1 - h.health / Math.max(1, h.maxHealth), 0, 1),
        suspensionActivity: t.suspensionActivity,
      };

      if (voice.kind !== probe.kind) voice.setKind(probe.kind);
      const gearChanged = voice.update(probe, wetness, listenerVel, listenerPos, dt);
      this.vehicleFoley(t, voice, probe, gearChanged, internals, dt);

      // Position the voice's slot.
      if (voice.slot) voice.slot.setPosition(h.position, this._ctx!);

      // --- suspension knocks, from the compression deltas ---
      t.knockCooldown = Math.max(0, t.knockCooldown - dt);
      const comp = internals.wheelCompression;
      if (comp && voice.lod <= 1 && t.knockCooldown === 0 && Math.abs(h.speed) > 1.5) {
        for (let i = 0; i < comp.length; i++) {
          const prev = t.prevCompression[i] ?? comp[i];
          const d = comp[i] - prev;
          if (d > 0.34) {
            // Off the carriageway the same spike is a kerb, not a pothole:
            // rubber slapping a hard edge rather than a damper bottoming out.
            const id: SfxId = t.roughness > 0.45 ? 'kerb_thump' : 'suspension_knock';
            this.playSfx(id, h.position, clamp(d * 1.4, 0.15, 0.7));
            t.knockCooldown = 0.14;
            break;
          }
        }
        for (let i = 0; i < comp.length; i++) t.prevCompression[i] = comp[i];
      } else if (comp) {
        for (let i = 0; i < comp.length; i++) t.prevCompression[i] = comp[i];
      }
    }
  }

  /**
   * The mechanical untidiness of a car that "e legată cu sârme, bate,
   * troncăne" — everything that is an event rather than a continuous note.
   *
   * All of it is LOD-gated on the voice, so a Dacia three streets away costs
   * nothing at all and the player's own car gets the full treatment.
   */
  private vehicleFoley(
    t: Tracked, voice: VehicleVoice, p: VehicleProbe,
    gearChanged: boolean, internals: VehicleInternals, dt: number,
  ): void {
    const h = t.handle;
    const speed = Math.abs(p.speed);
    const dacia = p.kind === 'dacia';

    // --- the gearbox ---
    // A shift is a hole in the note (VehicleVoice does that) plus a clunk from
    // a linkage with 40 years of slack in it (this).
    if (gearChanged && voice.lod <= 1) {
      this.playSfx('gear_clunk', h.position, dacia ? 0.5 : 0.3, 0.92 + this.rng.range(0, 0.16));
    }

    // --- the handbrake ---
    const hb = !!internals.handbrakeInput;
    if (hb !== t.prevHandbrake && voice.lod === 0) {
      // Pulling it ratchets; letting it off is one clean release.
      this.playSfx('handbrake', h.position, hb ? 0.45 : 0.28, hb ? 1 : 1.5);
    }
    t.prevHandbrake = hb;

    // --- the body ---
    // Rattle bursts on top of the continuous rattle bank, rate-limited by how
    // hard the shell is actually being shaken.
    t.rattleTimer -= dt;
    if (voice.lod === 0 && t.rattleTimer <= 0 && voice.rattleActivity > 0.42) {
      t.rattleTimer = this.rng.range(0.35, 1.4) / Math.max(0.4, voice.rattleActivity);
      this.playSfx('body_rattle', h.position, clamp(voice.rattleActivity * 0.34, 0.08, 0.4));
    }

    // --- the brakes ---
    // One squeal per stop: armed by braking hard from speed, fired when the
    // car actually comes to rest.
    if (voice.lod === 0) {
      const braking = Math.sign(p.throttle) === -Math.sign(p.speed) && Math.abs(p.throttle) > 0.5;
      if (braking && speed > 9) t.brakeArmed = true;
      if (t.brakeArmed && speed < 1.2 && t.prevSpeed >= 1.2) {
        t.brakeArmed = false;
        this.playSfx('brake_squeal', h.position, 0.34);
      }
      if (speed > 12) t.brakeArmed = t.brakeArmed && true;
    }
    t.prevSpeed = speed;

    // --- trams ---
    // A tram taking a curve screeches from the flange, not from the tyres —
    // it has none. Yaw rate is the whole signal.
    t.screechCooldown = Math.max(0, t.screechCooldown - dt);
    if (p.kind === 'tram' && speed > 2.5) {
      const yaw = Math.atan2(2 * (h.rotation.w * h.rotation.y), 1 - 2 * h.rotation.y * h.rotation.y);
      let d = yaw - t.prevYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      t.prevYaw = yaw;
      const yawRate = Math.abs(d) / Math.max(1e-4, dt);
      if (yawRate > 0.12 && t.screechCooldown === 0 && t.distance < 90) {
        t.screechCooldown = this.rng.range(2.4, 4.5);
        this.playSfx('tram_screech', h.position, clamp(yawRate * 1.6, 0.2, 0.6), 0.9 + this.rng.range(0, 0.3));
      }
    }
  }

  /**
   * 0 on tarmac, 1 up on the kerb or off the map edge.
   *
   * NOT from `snapToRoad`: that returns the nearest road *node* — a junction —
   * so its distance is "how far to the next crossroads", which reads 1.0 in
   * the middle of a perfectly good street. `groundHeight` is the real signal:
   * the city returns 0 on the carriageway and KERB_H (0.17) on the pavement,
   * so a step in ground height IS the kerb. Sampled at four points around the
   * car so a wheel hooked over the edge counts as half rough.
   */
  private roughnessAt(p: THREE.Vector3): number {
    const city = this.ctx.tryGet(Services.City);
    if (!city) return 0;
    let raised = 0;
    let n = 0;
    for (const [dx, dz] of ROUGH_TAPS) {
      const h = city.spatial.groundHeight(p.x + dx, p.z + dz);
      if (!Number.isFinite(h)) { raised += 1; n++; continue; }
      if (h > 0.05) raised++;
      n++;
    }
    return n ? raised / n : 0;
  }

  private assignVoices(
    all: ReadonlyArray<VehicleHandle>,
    listenerPos: THREE.Vector3,
    playerVehicleId: string | null,
  ): void {
    // Rank by distance, with the player's own car pinned first.
    // Ranking: the player's own car always wins a voice; anything a system has
    // explicitly bound via `bindEngine` (the vehicle system does this for every
    // occupied car) gets a 12 m handicap in its favour, so a driven car beats
    // an equidistant parked one for the last slot.
    const ranked: Array<{ h: VehicleHandle; d: number }> = [];
    for (const h of all) {
      let d = h.position.distanceTo(listenerPos);
      if (d > 130) continue;
      if (this.bound.has(h.id)) d -= 12;
      if (h.id === playerVehicleId) d = -1e6;
      ranked.push({ h, d });
    }
    ranked.sort((a, b) => a.d - b.d);
    const keep = ranked.slice(0, MAX_ENGINE_VOICES);
    const keepIds = new Set(keep.map((r) => r.h.id));

    // Release voices that fell off the list.
    for (const [id, voice] of [...this.voiceByVehicle]) {
      if (!keepIds.has(id)) {
        voice.silence();
        if (voice.slot) {
          voice.voiceGain.disconnect();
          voice.voiceGain.connect(this.g!.bus('vehicles').input);
          this.spatial!.untrack(voice.slot);
          voice.slot.release(this._ctx!);
          voice.slot = null;
        }
        this.voiceByVehicle.delete(id);
        this.tracked.delete(id);
      }
    }

    const free = this.engineVoices.filter((v) => ![...this.voiceByVehicle.values()].includes(v));
    for (const { h } of keep) {
      if (this.voiceByVehicle.has(h.id)) {
        const tr = this.tracked.get(h.id)!;
        tr.handle = h;
        continue;
      }
      const voice = free.pop();
      if (!voice) break;
      voice.setKind(h.kind as EngineClass);
      // Give the engine its own persistent panner.
      const s = this.acquireEngineSlot(h.id === playerVehicleId);
      if (s) {
        voice.voiceGain.disconnect();
        voice.voiceGain.connect(s.panner);
        voice.slot = s;
        this.spatial!.track(s);
      }
      this.voiceByVehicle.set(h.id, voice);
      this.tracked.set(h.id, {
        handle: h,
        prevPos: h.position.clone(),
        velocity: new THREE.Vector3(),
        prevCompression: [],
        knockCooldown: 0,
        distance: 0,
        suspensionActivity: 0,
        roughness: 0,
        roughTimer: 0,
        prevHandbrake: false,
        rattleTimer: 0,
        brakeArmed: false,
        prevSpeed: 0,
        prevYaw: 0,
        screechCooldown: 0,
      });
    }
  }

  private enginePool: SlotPool | null = null;

  private acquireEngineSlot(isPlayer: boolean): SpatialSlot | null {
    if (!this._ctx || !this.g) return null;
    if (!this.enginePool) {
      this.enginePool = new SlotPool(this._ctx, this.g.bus('vehicles').input, MAX_ENGINE_VOICES);
    }
    const s = this.enginePool.acquire({
      refDistance: isPlayer ? 40 : 7,
      rolloff: isPlayer ? 0.05 : 1.25,
      maxDistance: 160,
      noOcclusion: isPlayer,
    });
    // release() left a setTargetAtTime ramp running; cancel it or the reused
    // slot fades itself back to silence under the new vehicle.
    s.gain.gain.cancelScheduledValues(this._ctx.currentTime);
    s.gain.gain.setValueAtTime(1, this._ctx.currentTime);
    return s;
  }

  private sirenPrev = new Map<string, { p: THREE.Vector3; v: THREE.Vector3 }>();
  /** Verification hook: drive the sirens without needing a live pursuit. */
  private sirenOverride: { until: number; count: number; stars: number; t: number } | null = null;

  private updateSirens(dt: number, ctx: GameContext, listenerPos: THREE.Vector3, listenerVel: THREE.Vector3): void {
    const vehicles = ctx.tryGet(Services.Vehicles);
    if (!vehicles || !this._ctx) return;

    if (this.sirenOverride) {
      const o = this.sirenOverride;
      if (this._ctx.currentTime > o.until) {
        this.sirenOverride = null;
        for (const sv of this.sirenVoices) sv.silence();
      } else {
        // Synthetic pursuit: vans sweeping past the listener at 24 m/s so the
        // Doppler path is exercised as well as the two-tone itself.
        o.t += dt;
        const m = sirenModeForStars(o.stars);
        for (let i = 0; i < this.sirenVoices.length; i++) {
          const sv = this.sirenVoices[i];
          if (i >= o.count) {
            sv.silence();
            continue;
          }
          const z = ((o.t * 24 + i * 40) % 160) - 80;
          _v.set(listenerPos.x + 8 + i * 4, listenerPos.y, listenerPos.z + z);
          _v2.set(0, 0, 24);
          this.sirenSlots[i].setPosition(_v, this._ctx);
          sv.vehicleId = `override${i}`;
          sv.update(0.9, m, _v, _v2, listenerPos, listenerVel);
        }
        return;
      }
    }

    const mode = sirenModeForStars(this.stars);

    // Nearest police cars with the light bar on.
    const cands: Array<{ h: VehicleHandle; d: number }> = [];
    for (const h of vehicles.all) {
      const s = (h as unknown as VehicleInternals).siren ?? 0;
      if (s <= 0 || h.kind !== 'police') continue;
      const d = h.position.distanceTo(listenerPos);
      if (d > 340) continue;
      cands.push({ h, d });
    }
    cands.sort((a, b) => a.d - b.d);

    for (let i = 0; i < this.sirenVoices.length; i++) {
      const sv = this.sirenVoices[i];
      const slot = this.sirenSlots[i];
      const c = cands[i];
      if (!c) {
        sv.silence();
        continue;
      }
      // Sirens need their own velocity track: a pursuit van three streets away
      // has no engine voice, but its Doppler is the whole point.
      let prev = this.sirenPrev.get(c.h.id);
      if (!prev) {
        prev = { p: c.h.position.clone(), v: new THREE.Vector3() };
        this.sirenPrev.set(c.h.id, prev);
      } else if (dt > 1e-4) {
        _v.subVectors(c.h.position, prev.p).divideScalar(dt);
        if (_v.lengthSq() < 6400) prev.v.copy(_v);
        prev.p.copy(c.h.position);
      }
      slot.setPosition(c.h.position, this._ctx);
      sv.vehicleId = c.h.id;
      sv.update(0.9, mode, c.h.position, prev.v, listenerPos, listenerVel);
    }
    if (this.sirenPrev.size > 24) this.sirenPrev.clear();
  }

  /**
   * The three driving moments clipContexts.ts writes lines for but no event
   * exists to signal: standing on the throttle, covering ground (fuel), and
   * missing something by a hair. All three are read off the vehicle service
   * rather than from the bus, because the bus does not carry them.
   */
  private driverMoments(dt: number, ctx: GameContext, listenerPos: THREE.Vector3): void {
    this.nearMissCooldown = Math.max(0, this.nearMissCooldown - dt);
    this.kerbEventCooldown = Math.max(0, this.kerbEventCooldown - dt);

    const player = ctx.tryGet(Services.Player);
    const pv = player?.inVehicle;
    if (!pv) {
      this.hardAccelFor = 0;
      return;
    }
    const internals = pv as unknown as VehicleInternals;
    const speed = Math.abs(pv.speed);
    const throttle = internals.throttle ?? 0;

    // --- hard acceleration ---
    // "Încercăm să construim drone cu scame din buric" lands when the car is
    // being asked for everything it has and is plainly not going to give it.
    if (throttle > 0.85 && speed < 16) this.hardAccelFor += dt;
    else this.hardAccelFor = Math.max(0, this.hardAccelFor - dt * 2);
    if (this.hardAccelFor > 2.2 && this.cool('hardAccelVo', 40)) {
      this.hardAccelFor = 0;
      this.say('carHardAccel', 1.4);
    }

    // --- fuel ---
    // There is no fuel model to hang this on, so it hangs on distance covered:
    // ~2.5 km of Bucharest is a tank you have to think about at 20 RON a go.
    this.metresDriven += speed * dt;
    if (this.metresDriven > 2500) {
      this.metresDriven = 0;
      this.say('carFuel', 1.2);
    }

    // --- near miss ---
    // Something big went past close and fast, and you did not hit it.
    if (speed > 9 && this.nearMissCooldown === 0) {
      const vehicles = ctx.tryGet(Services.Vehicles);
      for (const other of vehicles?.all ?? []) {
        if (other.id === pv.id) continue;
        const d = other.position.distanceTo(pv.position);
        if (d > 3.4 || d < 0.2) continue;
        const closing = Math.abs(pv.speed) + Math.abs(other.speed);
        if (closing < 14) continue;
        this.nearMissCooldown = 45;
        this.playSfx('horn', other.position, 0.5);
        this.say('nearMiss', 1.5);
        break;
      }
    }

    // --- up on the pavement ---
    // A car arriving where people are standing is the loudest thing that can
    // happen to a crowd, and it is not the car you hear.
    const t = this.tracked.get(pv.id);
    if (t && t.roughness > 0.55 && speed > 6 && this.kerbEventCooldown === 0) {
      const peds = ctx.tryGet(Services.Peds);
      let near = 0;
      for (const c of peds?.all ?? []) {
        if (c.position.distanceTo(pv.position) < 16) near++;
        if (near >= 2) break;
      }
      if (near >= 1) {
        this.kerbEventCooldown = 7;
        _v.copy(pv.position);
        this.playSfx('crowd_scream', _v, 0.6);
        window.setTimeout(() => this.playSfx('crowd_shout', _v, 0.55), 220);
        if (this.rng.bool(0.6)) this.playSfx('pigeon_flutter', _v, 0.5);
        peds?.scatter(pv.position, 18);
      }
    }
    void listenerPos;
  }

  /**
   * People. The ped service does not expose its animation, so footfalls for
   * anyone other than the player are timed here from their locomotion state —
   * a 0.52 s stride at a walk, 0.34 s at a jog — for the nearest few only.
   * The rest of the crowd is the ambience bed, which is what a crowd is.
   */
  private updatePeople(dt: number, ctx: GameContext, listenerPos: THREE.Vector3, onFoot: boolean): void {
    const peds = ctx.tryGet(Services.Peds);
    if (!peds) return;
    const now = this._ctx!.currentTime;

    // Headcount at 5 Hz — it only feeds a crossfade.
    this.pedStepScan -= dt;
    if (this.pedStepScan > 0) return;
    this.pedStepScan = 0.2;

    let near = 0;
    const walkers: Array<{ id: string; pos: THREE.Vector3; jog: boolean; d: number }> = [];
    for (const c of peds.all) {
      const d = c.position.distanceTo(listenerPos);
      if (d < 22) near++;
      if (!onFoot || d > 11 || !c.isAlive) continue;
      const s = c.state;
      if (s !== 'walk' && s !== 'jog' && s !== 'sprint') continue;
      walkers.push({ id: c.id, pos: c.position, jog: s !== 'walk', d });
    }
    this.crowdNear = clamp(near / 12, 0, 1.4);

    walkers.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(3, walkers.length); i++) {
      const w = walkers[i];
      const at = this.pedStepAt.get(w.id) ?? 0;
      if (now < at) continue;
      this.pedStepAt.set(w.id, now + (w.jog ? 0.34 : 0.52) * this.rng.range(0.92, 1.08));
      const vol = clamp(0.26 * (1 - w.d / 11), 0.04, 0.26) * (w.jog ? 1.35 : 1);
      this.playSfx(this.footstepId(w.pos), w.pos, vol);
      // Clothing: the quiet half of a step, and the half that stops a crowd
      // sounding like a drum machine.
      if (this.rng.bool(0.5)) this.playSfx('cloth_rustle', w.pos, vol * 0.5);
    }
    if (this.pedStepAt.size > 64) this.pedStepAt.clear();
  }

  /**
   * Lines that belong to a place rather than to an event: the government
   * quarter and the Palace get the Georgescu material, because that is what
   * those buildings are for.
   */
  private districtVoice(district: DistrictKind, listenerPos: THREE.Vector3, city: CityService | undefined): void {
    if (district !== this.lastDistrict) {
      const previous = this.lastDistrict;
      this.lastDistrict = district;
      if (previous && district === 'guvern' && this.cool('guvernVo', 120)) {
        this.say('nicusor', 1.2);
      }
    }
    const lm = city?.landmarks.get('palatulParlamentului');
    if (lm && listenerPos.distanceTo(lm.position) < lm.radius + 90 && this.cool('palatVo', 180)) {
      this.say('georgescu', 1.3);
    }
  }

  /** Occasional positioned flavour on top of the looping bed. */
  private ambienceFlavour(dt: number, district: DistrictKind, listenerPos: THREE.Vector3): void {
    this.ambienceFlavourTimer -= dt;
    if (this.ambienceFlavourTimer > 0) return;
    this.ambienceFlavourTimer = this.rng.range(4, 11);
    const a = this.rng.range(0, Math.PI * 2);
    const r = this.rng.range(12, 40);
    _v2.set(listenerPos.x + Math.cos(a) * r, listenerPos.y + this.rng.range(-1, 4), listenerPos.z + Math.sin(a) * r);
    if (district === 'parc') {
      this.playSfx(this.rng.bool(0.72) ? 'bird' : 'dog_bark', _v2, this.rng.range(0.3, 0.6));
    } else if (district === 'bulevard' || district === 'cartier') {
      const roll = this.rng.next();
      if (roll < 0.3) this.playSfx('tram_bell', _v2, this.rng.range(0.2, 0.45));
      else if (roll < 0.55) this.playSfx('horn_low', _v2, this.rng.range(0.12, 0.3));
      else if (roll < 0.75) this.playSfx('pigeon_flutter', _v2, this.rng.range(0.15, 0.4));
      else if (roll < 0.9) this.playSfx('construction_hammer', _v2, this.rng.range(0.1, 0.3));
      else this.playSfx('dog_bark', _v2, this.rng.range(0.12, 0.32));
    } else if (district === 'centruVechi') {
      const roll = this.rng.next();
      if (roll < 0.4) this.playSfx('crowd_gasp', _v2, this.rng.range(0.2, 0.45));
      else if (roll < 0.7) this.playSfx('crowd_shout', _v2, this.rng.range(0.15, 0.35));
      else this.playSfx('shop_bell', _v2, this.rng.range(0.15, 0.35));
    } else if (district === 'industrial') {
      this.playSfx(this.rng.bool(0.5) ? 'prop_metal' : 'construction_hammer', _v2, this.rng.range(0.1, 0.28));
    } else if (district === 'guvern' || district === 'glassCorporate') {
      this.playSfx(this.rng.bool(0.5) ? 'pigeon_flutter' : 'construction_hammer', _v2, this.rng.range(0.1, 0.3));
    }
    // Five stars and the street is not murmuring any more, it is reacting.
    if (this.stars >= 4 && this.rng.bool(0.5)) {
      this.playSfx(this.rng.bool(0.5) ? 'crowd_scream' : 'crowd_shout', _v2, 0.42);
    }
  }

  /**
   * Keep the mix legible.
   *  - voice ducks music and ambience (broadcast-style, fast in / slow out)
   *  - sirens duck music and ambience
   *  - at high star counts, trim ambience and vehicles so the chase reads
   */
  private applyDucking(dt: number): void {
    if (!this.g || !this.radio) return;
    void dt;
    const voiceDuck = this.director?.duck ?? 0;
    let sirenLoad = 0;
    for (const sv of this.sirenVoices) if (sv.active) sirenLoad += 1;
    sirenLoad = clamp(sirenLoad / MAX_SIREN_VOICES, 0, 1);
    const starLoad = clamp(this.stars / 5, 0, 1);

    const ambienceDb = -8 * voiceDuck - 4 * sirenLoad - 3 * starLoad;
    const musicDb = -4 * voiceDuck - 5 * sirenLoad;
    const vehiclesDb = -2.5 * voiceDuck - 2.5 * sirenLoad * starLoad;
    const sfxDb = -1.5 * voiceDuck;

    this.g.duckBus('ambience', ambienceDb, 0.09);
    this.g.duckBus('music', musicDb, 0.09);
    this.g.duckBus('vehicles', vehiclesDb, 0.12);
    this.g.duckBus('sfx', sfxDb, 0.12);
  }

  /* ---------------------------------------------------------------- */
  /* One-shot playback                                                 */
  /* ---------------------------------------------------------------- */

  private playSfx(id: SfxId, position?: THREE.Vector3, volume = 1, rate = 1): void {
    if (!this._ready || !this.bank || !this.oneShotPool || !this._ctx) return;
    const buf = this.bank.get(id);
    if (!buf) return;
    const ac = this._ctx;
    const src = ac.createBufferSource();
    src.buffer = buf;
    if (rate !== 1) src.playbackRate.value = rate;

    const slot = this.oneShotPool.acquire({
      refDistance: position ? 5 : 200,
      rolloff: position ? 1.2 : 0,
      maxDistance: 260,
      noOcclusion: !position,
    });
    const p = position ?? this.spatial?.listenerPosition ?? _zero;
    slot.jumpTo(p, ac);
    slot.gain.gain.cancelScheduledValues(ac.currentTime);
    slot.gain.gain.setValueAtTime(clamp(volume, 0, 2), ac.currentTime);
    src.connect(slot.panner);
    slot.source = src;
    slot.releaseAt = ac.currentTime + buf.duration / rate + 0.05;
    src.start();
    src.onended = () => {
      try { src.disconnect(); } catch { /* already gone */ }
    };
  }

  /** Map the ids other systems emit onto the synthesised bank. */
  private resolveSfxId(id: string, position?: THREE.Vector3): SfxId {
    // The spike strip (ai/police.ts) is a rattle AND a blowout.
    if (id === 'spikes') this.playSfx('tyre_burst', position, 0.55);
    // A step is a boot AND a jacket. Half the time, so it does not turn into
    // a second metronome running alongside the first.
    if (id === 'footstep' && this.rng.bool(0.5)) {
      this.playSfx('cloth_rustle', position, 0.16);
    }
    if (this.bank?.has(id)) {
      if (id === 'footstep') return this.footstepId(position);
      return id as SfxId;
    }
    switch (id) {
      case 'footstep': return this.footstepId(position);
      case 'ped_yell': return 'ped_yell';
      case 'ped_hit': return 'ped_hit';
      case 'horn': return 'horn';
      case 'crash': return 'impact_medium';
      case 'glass': return 'impact_glass';
      case 'door': return 'door_open';
      case 'explosion': return 'explosion';
      default: return 'interact';
    }
  }

  /**
   * What is under this boot. Wet beats everything (a puddle is a puddle
   * wherever it is); then the surface, taken from the district and from how far
   * off the carriageway the step landed — pavement and road are both hard, but
   * the verge between them is not.
   */
  private footstepId(position?: THREE.Vector3): SfxId {
    const w = this.ctx.tryGet(Services.Weather);
    if ((w?.wetness ?? 0) > 0.28) return 'footstep_wet';
    const city = this.ctx.tryGet(Services.City);
    if (city && position) {
      const d = city.districtAt(position.x, position.z);
      if (d === 'parc') return 'footstep_grass';
      if (d === 'industrial') return 'footstep_gravel';
      // Pavement is concrete slabs, the carriageway is asphalt: the slab has a
      // harder, brighter heel. The kerb step is the only surface change a
      // pedestrian ever makes in this city, so it is worth hearing.
      if (city.spatial.groundHeight(position.x, position.z) > 0.05) return 'footstep_metal';
    }
    return 'footstep';
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  private cool(key: string, seconds: number): boolean {
    if (this.cooldowns.has(key)) return false;
    this.cooldowns.set(key, seconds);
    return true;
  }

  private near(p: THREE.Vector3, r: number): boolean {
    return !!this.spatial && p.distanceTo(this.spatial.listenerPosition) < r;
  }

  private nearestPoweredVehicleDistance(ctx: GameContext, listenerPos: THREE.Vector3): number {
    let best = 1e9;
    for (const id of this.startedVehicles) {
      const v = ctx.tryGet(Services.Vehicles)?.get(id);
      if (!v) continue;
      const d = v.position.distanceTo(listenerPos);
      if (d < best) best = d;
    }
    return best;
  }

  private tryInstallHouseSpeaker(city: CityService): void {
    const lm = city.landmarks.get('buildersHouse');
    if (!lm || !this.radio) return;
    // Waits for the folk buffer to finish decoding; retried each frame.
    this.houseInstalled = this.radio.installHouseSpeaker(lm.position);
  }

  /* ---------------------------------------------------------------- */
  /* Debug hook                                                        */
  /* ---------------------------------------------------------------- */

  private installDebugApi(): void {
    const api: AudioDebugApi = {
      ready: () => this._ready && !!this.bank?.complete,
      levels: () => this.g?.levels() ?? {},
      centroid: (bus = 'master') => this.g?.centroidOf(bus) ?? 0,
      spectrum: (bus = 'master') => Array.from(this.g?.spectrumOf(bus) ?? []),
      resetPeaks: () => this.g?.resetPeaks(),
      state: () => ({
        ready: this._ready,
        contextState: this._ctx?.state ?? 'none',
        sampleRate: this._ctx?.sampleRate ?? 0,
        bankBuffers: this.bank?.size ?? 0,
        bankComplete: !!this.bank?.complete,
        clipsLoaded: this.radio?.loadedClips ?? 0,
        clipsWarmed: this.radio?.warmed ?? 0,
        boundVehicles: this.bound.size,
        station: this.radio?.station ?? 'off',
        stationLabel: STATION_LABELS[this.radio?.station ?? 'off'],
        radioPowered: !!this.radio?.powered,
        nowPlaying: this.radio?.nowPlaying ?? '',
        lastClip: this.radio?.lastClipKey ?? '',
        duck: round(this.radio?.duck ?? 0),
        afterparty: !!this.radio?.afterparty,
        stars: this.stars,
        district: this.ambience?.district ?? '?',
        ambienceMix: this.ambience?.mix ?? {},
        engineVoices: [...this.voiceByVehicle.entries()].map(([id, v]) => ({
          id,
          kind: v.kind,
          lod: v.lod,
          gear: v.state?.gear ?? -1,
          rpm: Math.round(v.state?.rpm ?? 0),
          f0: round(v.state?.fundamental ?? 0, 2),
          overrun: round(v.state?.overrun ?? 0),
        })),
        sirens: this.sirenVoices.filter((s) => s.active).map((s) => ({
          vehicleId: s.vehicleId, mode: s.mode, hz: Math.round(s.lastFreq),
        })),
        oneShotSlots: this.oneShotPool?.activeCount ?? 0,
        occlusion: this.spatial?.occlusionStats ?? null,
        limiterReductionDb: round(this.g?.reductionDb ?? 0, 2),
        mix: this.g?.mix ?? {},
        updateMs: round(this._updateMs, 3),
        updateMsPeak: round(this._updateMsPeak, 3),
        houseSpeaker: !!this.radio?.houseSpeakerLive,
        streetBeds: this.street?.bedsLive ?? 0,
        crowdNear: round(this.crowdNear),
        voice: this.director?.stats() ?? {},
      }),
      play: (id, x, y, z, volume) => {
        const pos = x === undefined ? undefined : new THREE.Vector3(x, y ?? 0, z ?? 0);
        this.oneShot(id, pos, volume);
      },
      say: (b, priority = 3) => this.radio?.say(b as never, priority) ?? false,
      setStation: (s) => this.radio?.setStation(s as StationId),
      station: () => this.radio?.station ?? 'off',
      nextStation: () => this.radio?.next() ?? 'off',
      stations: () => [...STATIONS],
      setMusic: (t) => this.setMusic(t),
      setMasterVolume: (v) => {
        this.masterVolume = v;
        if (this.g) this.g.masterVolume = v;
      },
      setBusVolume: (bus, v) => {
        if (this.g && (BUS_NAMES as string[]).includes(bus)) this.g.setBusVolume(bus as BusName, v);
      },
      clipUsage: () => {
        const out: Array<{ key: string; phrase: string; buckets: string[]; plays: number }> = [];
        for (const [key, c] of CLIPS) {
          out.push({
            key,
            phrase: c.phrase,
            buckets: bucketsFor(key),
            plays: this.radio?.played.get(key) ?? 0,
          });
        }
        return out;
      },
      sfxIds: () => this.bank?.ids() ?? [],
      emit: (event, payload = {}) => {
        const p: Record<string, unknown> = { ...payload };
        // Accept [x,y,z] for any position field so the hook is usable from a
        // plain `eval` with no THREE in scope.
        for (const k of ['position', 'at', 'target']) {
          const v = p[k];
          if (Array.isArray(v) && v.length === 3) {
            p[k] = new THREE.Vector3(v[0] as number, v[1] as number, v[2] as number);
          }
        }
        this.ctx.events.emit(event as never, p as never);
      },
      forceSiren: (count, stars, seconds) => {
        if (!this._ctx) return;
        this.sirenOverride = {
          until: this._ctx.currentTime + seconds,
          count: clamp(count, 0, MAX_SIREN_VOICES),
          stars,
          t: 0,
        };
      },
      setAmbience: (district, hours, rain) => {
        this.ambienceOverride = { district: district as DistrictKind, hours, rain };
      },
      clearAmbienceOverride: () => {
        this.ambienceOverride = null;
      },
      context: (name, priority = 2) => this.say(name as VoiceContext, priority),
      contexts: () => Object.keys(VOICE_CONTEXTS),
      voice: () => this.director?.stats() ?? {},
      streetVoices: () => this.street?.stats() ?? [],
      sayStreet: (index = 0) => {
        const e = this.street?.emitters[index];
        if (!e) return false;
        return this.director?.requestStreet(e.input, EMITTER_SPEAKER[e.kind]) ?? false;
      },
      placeStreetAt: (x, y, z) => {
        const p = new THREE.Vector3(x, y, z);
        const offsets = [
          new THREE.Vector3(6, 0, 0), new THREE.Vector3(-5, 0, 4), new THREE.Vector3(0, 0, -6),
        ];
        this.street?.emitters.forEach((e, i) => e.moveTo(p.clone().add(offsets[i % 3])));
      },
      vehicles: () => [...this.voiceByVehicle.entries()].map(([id, v]) => {
        const t = this.tracked.get(id);
        return {
          id,
          kind: v.kind,
          isPlayer: this.ctx.tryGet(Services.Player)?.inVehicle?.id === id,
          speed: round(t?.handle.speed ?? 0, 2),
          lod: v.lod,
          gear: v.state?.gear ?? -1,
          rpm: Math.round(v.state?.rpm ?? 0),
          f0: round(v.state?.fundamental ?? 0, 2),
          drive: round(v.state?.drive ?? 0),
          overrun: round(v.state?.overrun ?? 0),
          exhaust: round(v.state?.exhaustLevel ?? 0),
          induction: round(v.state?.inductionLevel ?? 0),
          roll: round(v.tyre?.rollLevel ?? 0),
          squeal: round(v.tyre?.squealLevel ?? 0),
          brakeSqueal: round(v.tyre?.brakeSquealLevel ?? 0),
          rattle: round(v.rattleActivity ?? 0),
          roughness: round(t?.roughness ?? 0),
          distance: round(t?.distance ?? 0, 1),
        };
      }),
      waitReady: async (timeoutMs = 20000) => {
        const t0 = performance.now();
        while (performance.now() - t0 < timeoutMs) {
          if (this._ready && this.bank?.complete && (this.radio?.loadedClips ?? 0) > 0) return true;
          await new Promise((r) => setTimeout(r, 120));
        }
        return this._ready;
      },
    };
    (window as unknown as { __GTA_AUDIO__: AudioDebugApi }).__GTA_AUDIO__ = api;
    (window as unknown as { __GTA_FOLK__: string }).__GTA_FOLK__ = FOLK_TITLE;
  }

  dispose(): void {
    for (const v of this.engineVoices) v.dispose();
    for (const s of this.sirenVoices) s.dispose();
    this.ambience?.dispose();
    this.street?.dispose();
    this.director?.stop();
    this.radio?.dispose();
    void this._ctx?.close();
    this._ready = false;
  }
}

function propSfx(kind: string): SfxId {
  const k = kind.toLowerCase();
  if (k.includes('glass') || k.includes('window') || k.includes('sticla')) return 'prop_glass';
  if (k.includes('wood') || k.includes('crate') || k.includes('fence') || k.includes('bench')) return 'prop_wood';
  if (k.includes('bin') || k.includes('cone') || k.includes('plastic') || k.includes('barrier')) return 'prop_plastic';
  if (k.includes('pole') || k.includes('sign') || k.includes('lamp') || k.includes('metal') || k.includes('rail')) return 'prop_metal';
  return 'prop_broken';
}

function round(v: number, d = 3): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
