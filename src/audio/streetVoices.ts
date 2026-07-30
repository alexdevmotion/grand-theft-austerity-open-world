/**
 * THE STREET TALKS BACK — diegetic voices at real world positions.
 *
 * The `streetOverheard` context in clipContexts.ts is explicitly not a voice in
 * the player's head. These are things that are *somewhere*: a transistor radio
 * on a newspaper kiosk, a shop doorway with the door propped open, a parked
 * Dacia with its window down. You walk past them and the joke arrives from the
 * left, gets louder, and goes behind you. That is the difference between a city
 * with people in it and a city with a soundtrack.
 *
 * Each emitter is:
 *
 *   folk loop ─┐
 *              ├─▶ speaker EQ ─▶ gain ─▶ panner ─▶ lowpass ─▶ music/voice bus
 *   VO source ─┘   (per-kind: kiosk = tinny, doorway = boxy, car = cone)
 *
 * Placement uses CityService only: a ring of candidate points around the
 * listener, keeping ones that are NOT inside geometry and that sit off the
 * carriageway (so the kiosk is on the pavement, not in lane two). Emitters are
 * recycled — moving one costs three AudioParam writes, not a graph rebuild.
 *
 * The folk bed is the reason the Fecioreasca recording is audible in ordinary
 * free roam on foot: walk any busy street and a kiosk radio is playing it.
 */

import * as THREE from 'three';
import type { CityService } from '../core/services';
import { Rng } from '../core/rng';
import { clamp, speakerCurve } from './dsp';

export type StreetEmitterKind = 'kiosk' | 'doorway' | 'parkedCar';

export const EMITTER_SPEAKER: Record<StreetEmitterKind, string> = {
  kiosk: 'RADIO DE CHIOȘC',
  doorway: 'DINTR-UN MAGAZIN',
  parkedCar: 'DINTR-O DACIE PARCATĂ',
};

interface EqSpec {
  hp: number;
  lp: number;
  presenceHz: number;
  presenceDb: number;
  drive: number;
  /** Panner reach. */
  refDistance: number;
  rolloff: number;
  maxDistance: number;
  /** How loud the music bed under this emitter sits. 0 = no music. */
  bed: number;
}

const EQ: Record<StreetEmitterKind, EqSpec> = {
  // A 20-lei transistor on top of the newspapers: no bass at all, all mids.
  // The kiosk carries the folk record in free roam, which is the whole reason
  // the beds exist, so it is the one emitter tuned to actually reach you: a
  // gentler rolloff and a hotter bed than a shop doorway gets.
  kiosk: { hp: 420, lp: 3400, presenceHz: 1600, presenceDb: 6, drive: 2.2, refDistance: 4.5, rolloff: 1.15, maxDistance: 55, bed: 0.78 },
  // Through an open shop door: boxier, further back, quieter.
  doorway: { hp: 260, lp: 2600, presenceHz: 900, presenceDb: 3, drive: 1.5, refDistance: 3, rolloff: 1.9, maxDistance: 32, bed: 0.3 },
  // A Dacia with the window down — the same cheap cone as the player's own car.
  parkedCar: { hp: 190, lp: 4300, presenceHz: 1750, presenceDb: 4, drive: 1.35, refDistance: 4, rolloff: 1.6, maxDistance: 46, bed: 0.42 },
};

export class StreetEmitter {
  readonly position = new THREE.Vector3();
  placed = false;
  /** Seconds until this emitter may speak again. */
  cooldown = 0;

  readonly input: GainNode;
  private ctx: AudioContext;
  private gain: GainNode;
  private panner: PannerNode;
  private bedGain: GainNode;
  private bedSource: AudioBufferSourceNode | null = null;

  constructor(
    ctx: AudioContext,
    readonly kind: StreetEmitterKind,
    voiceBus: AudioNode,
    musicBus: AudioNode,
  ) {
    this.ctx = ctx;
    const eq = EQ[kind];

    this.input = ctx.createGain();
    this.input.gain.value = 1;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = eq.hp;
    hp.Q.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = eq.lp;
    lp.Q.value = 0.7;
    const pres = ctx.createBiquadFilter();
    pres.type = 'peaking';
    pres.frequency.value = eq.presenceHz;
    pres.Q.value = 1.1;
    pres.gain.value = eq.presenceDb;
    const cone = ctx.createWaveShaper();
    cone.curve = speakerCurve(1024, eq.drive) as Float32Array<ArrayBuffer>;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0.9;

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = eq.refDistance;
    this.panner.rolloffFactor = eq.rolloff;
    this.panner.maxDistance = eq.maxDistance;

    this.input.connect(hp);
    hp.connect(lp);
    lp.connect(pres);
    pres.connect(cone);
    cone.connect(this.gain);
    this.gain.connect(this.panner);
    this.panner.connect(voiceBus);

    // The music bed takes the same EQ but its own gain, and lands on the music
    // bus so the mix can duck it independently of the joke on top of it.
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0;
    const bedPan = ctx.createPanner();
    bedPan.panningModel = 'equalpower';
    bedPan.distanceModel = 'inverse';
    bedPan.refDistance = eq.refDistance;
    bedPan.rolloffFactor = eq.rolloff;
    bedPan.maxDistance = eq.maxDistance;
    this.bedGain.connect(bedPan);
    bedPan.connect(musicBus);
    this.bedPanner = bedPan;
  }

  private bedPanner: PannerNode;

  /** Start the folk loop under this emitter. Idempotent. */
  installBed(folk: AudioBuffer, rng: Rng): void {
    if (this.bedSource || EQ[this.kind].bed <= 0) return;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = EQ[this.kind].hp;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = EQ[this.kind].lp;
    const cone = this.ctx.createWaveShaper();
    cone.curve = speakerCurve(512, EQ[this.kind].drive) as Float32Array<ArrayBuffer>;
    const s = this.ctx.createBufferSource();
    s.buffer = folk;
    s.loop = true;
    s.connect(hp);
    hp.connect(lp);
    lp.connect(cone);
    cone.connect(this.bedGain);
    // Different offsets so three kiosks are not a phase-locked chorus.
    s.start(0, rng.range(0, Math.max(1, folk.duration - 1)));
    this.bedSource = s;
    this.bedGain.gain.setTargetAtTime(EQ[this.kind].bed, this.ctx.currentTime, 1.5);
  }

  get hasBed(): boolean {
    return !!this.bedSource;
  }

  moveTo(p: THREE.Vector3): void {
    this.position.copy(p);
    this.placed = true;
    const t = this.ctx.currentTime;
    for (const pan of [this.panner, this.bedPanner]) {
      if (pan.positionX) {
        pan.positionX.setValueAtTime(p.x, t);
        pan.positionY.setValueAtTime(p.y, t);
        pan.positionZ.setValueAtTime(p.z, t);
      } else {
        (pan as unknown as { setPosition(x: number, y: number, z: number): void })
          .setPosition(p.x, p.y, p.z);
      }
    }
  }

  /** Fade the bed under a spoken line so the joke is legible. */
  setBedDuck(amount: number): void {
    if (!this.bedSource) return;
    this.bedGain.gain.setTargetAtTime(
      EQ[this.kind].bed * (1 - clamp(amount, 0, 1) * 0.75),
      this.ctx.currentTime,
      0.12,
    );
  }

  dispose(): void {
    try { this.bedSource?.stop(); } catch { /* already stopped */ }
    this.gain.disconnect();
    this.bedGain.disconnect();
  }
}

/**
 * Keeps a handful of emitters placed around the listener and decides when one
 * of them is allowed to say something.
 */
export class StreetVoices {
  readonly emitters: StreetEmitter[] = [];
  private rng: Rng;
  private replaceTimer = 0;
  private sayTimer: number;
  /** Metres beyond which an emitter is torn up and re-sited. */
  private static readonly KEEP_RADIUS = 95;
  /** How near the listener must be for an emitter to bother talking. */
  private static readonly TALK_RADIUS = 30;

  constructor(
    ctx: AudioContext,
    voiceBus: AudioNode,
    musicBus: AudioNode,
    seed = 'gta-street-voices',
  ) {
    this.rng = new Rng(seed);
    const kinds: StreetEmitterKind[] = ['kiosk', 'doorway', 'parkedCar'];
    for (const k of kinds) this.emitters.push(new StreetEmitter(ctx, k, voiceBus, musicBus));
    this.sayTimer = this.rng.range(6, 14);
  }

  installBeds(folk: AudioBuffer): void {
    for (const e of this.emitters) e.installBed(folk, this.rng.fork(e.kind));
  }

  get bedsLive(): number {
    let n = 0;
    for (const e of this.emitters) if (e.hasBed) n++;
    return n;
  }

  /**
   * Find a spot for an emitter: on the pavement (off the carriageway), not
   * inside a building, within earshot of where the player is walking.
   */
  private sitePoint(
    city: CityService, listener: THREE.Vector3, out: THREE.Vector3, near = false,
  ): boolean {
    for (let attempt = 0; attempt < 14; attempt++) {
      const a = this.rng.range(0, Math.PI * 2);
      // The kiosk sits close enough that walking a street puts you inside its
      // reach; the rest of the emitters can be further off.
      const r = near ? this.rng.range(7, 20) : this.rng.range(14, 46);
      const x = listener.x + Math.cos(a) * r;
      const z = listener.z + Math.sin(a) * r;
      if (city.spatial.isBlocked(x, z)) continue;
      const h = city.spatial.groundHeight(x, z);
      if (!Number.isFinite(h)) continue;
      // On the pavement, not in lane two: the city reports KERB_H off the
      // carriageway and 0 on it, which is the only reliable kerb test there is
      // (`snapToRoad` returns the nearest junction, not the nearest tarmac).
      if (h <= 0.05) continue;
      out.set(x, h + 1.2, z);
      return true;
    }
    return false;
  }

  /**
   * Per frame. `speak` is called when an emitter wants a line — it returns
   * true if the director actually took it, which is what arms the cooldown.
   */
  update(
    dt: number,
    city: CityService | undefined,
    listener: THREE.Vector3,
    onFoot: boolean,
    directorBusy: boolean,
    speak: (e: StreetEmitter) => boolean,
  ): void {
    for (const e of this.emitters) e.cooldown = Math.max(0, e.cooldown - dt);

    // --- placement ---
    this.replaceTimer -= dt;
    if (city && this.replaceTimer <= 0) {
      this.replaceTimer = 1.5;
      for (const e of this.emitters) {
        // The kiosk is re-sited far more eagerly than the others: it is the
        // source the folk record actually reaches the player from, so it has to
        // stay within earshot as you walk, not merely within 95 m.
        const keep = e.kind === 'kiosk' ? 34 : StreetVoices.KEEP_RADIUS;
        if (e.placed && e.position.distanceTo(listener) < keep) continue;
        if (this.sitePoint(city, listener, _site, e.kind === 'kiosk')) e.moveTo(_site);
      }
    }

    // --- speaking ---
    this.sayTimer -= dt;
    if (this.sayTimer > 0 || directorBusy) return;
    this.sayTimer = this.rng.range(9, 22);
    if (!onFoot) return; // in a car you have your own radio

    let best: StreetEmitter | null = null;
    let bestD = StreetVoices.TALK_RADIUS;
    for (const e of this.emitters) {
      if (!e.placed || e.cooldown > 0) continue;
      const d = e.position.distanceTo(listener);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (!best) return;
    if (speak(best)) best.cooldown = this.rng.range(28, 60);
    else this.sayTimer = 3;
  }

  setBedDuck(amount: number): void {
    for (const e of this.emitters) e.setBedDuck(amount);
  }

  stats(): Array<Record<string, unknown>> {
    return this.emitters.map((e) => ({
      kind: e.kind,
      placed: e.placed,
      bed: e.hasBed,
      pos: [round(e.position.x), round(e.position.y), round(e.position.z)],
      cooldown: round(e.cooldown),
    }));
  }

  dispose(): void {
    for (const e of this.emitters) e.dispose();
  }
}

const _site = new THREE.Vector3();

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
