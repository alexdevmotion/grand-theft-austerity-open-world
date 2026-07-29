/**
 * VEHICLE VOICE — one synthesised car.
 *
 * Graph (built once, recycled forever — nothing here allocates while driving):
 *
 *   sine osc x6  (orders 1,2,3,4,6,8) ─▶ per-order gain ─┐
 *   saw osc (detuned "rattle" bank)   ─▶ rattle gain ────┤
 *                                                        ├▶ shaper ─▶ body EQ ─┐
 *   noise loop ─▶ induction BP ─▶ induction gain ────────┤                     │
 *   noise loop ─▶ exhaust LP  ─▶ exhaust gain ───────────┘                     │
 *                                                                              │
 *   noise loop ─▶ roll BP   ─▶ roll gain ───────────────────────────────┐      │
 *   noise loop ─▶ spray HP  ─▶ spray gain ──────────────────────────────┤      │
 *   squeal loop ─▶ squeal BP ─▶ squeal gain ────────────────────────────┤      │
 *                                                                       ▼      ▼
 *                                                       voiceGain ◀─────┴──────┘
 *                                                            │
 *                                              panner ─▶ occlusion LP ─▶ vehicles bus
 *
 * The oscillators never stop. LOD mutes branches rather than tearing the graph
 * down, so a car driving past does not cost a graph rebuild.
 *
 * Doppler is explicit (WebAudio dropped it): the whole oscillator bank plus the
 * noise playback rates are detuned by the radial relative velocity, which is
 * what gives a pass-by its falling pitch.
 */

import * as THREE from 'three';
import { approach, clamp, softClipCurve } from './dsp';
import {
  ENGINE_SPECS, HARMONIC_ORDERS, engineState, tyreState,
  type EngineClass, type EngineSpec, type EngineState,
} from './engineModel';
import { dopplerFactor, ratioToCents } from './sirenModel';
import type { SpatialSlot } from './spatial';

/** What the audio system needs to know about a vehicle each frame. */
export interface VehicleProbe {
  id: string;
  kind: EngineClass;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  throttle: number;
  handbrake: boolean;
  /** Peak |lateral slip| across the wheels, m/s. */
  slip: number;
  /** 0..1 fraction of wheels on the ground. */
  grounded: number;
  wrecked: boolean;
  airborne: boolean;
  isPlayer: boolean;
  distance: number;
}

/** 0 = full synthesis, 3 = silent. */
export type VoiceLod = 0 | 1 | 2 | 3;

export function lodForDistance(d: number, isPlayer: boolean): VoiceLod {
  if (isPlayer) return 0;
  if (d < 26) return 0;
  if (d < 62) return 1;
  if (d < 115) return 2;
  return 3;
}

/** Harmonic count synthesised at each LOD. */
const LOD_HARMONICS: Record<VoiceLod, number> = { 0: 6, 1: 4, 2: 2, 3: 0 };

export class VehicleVoice {
  readonly id: string;
  kind: EngineClass = 'sedan';
  spec: EngineSpec = ENGINE_SPECS.sedan;

  private ctx: AudioContext;
  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private rattle: OscillatorNode;
  private rattleGain: GainNode;
  private shaper: WaveShaperNode;
  private preShaper: GainNode;
  private bodyEq: BiquadFilterNode;
  private engineGain: GainNode;

  private inductionSrc: AudioBufferSourceNode;
  private inductionBp: BiquadFilterNode;
  private inductionGain: GainNode;
  private exhaustSrc: AudioBufferSourceNode;
  private exhaustLp: BiquadFilterNode;
  private exhaustGain: GainNode;

  private rollSrc: AudioBufferSourceNode;
  private rollBp: BiquadFilterNode;
  private rollGain: GainNode;
  private spraySrc: AudioBufferSourceNode;
  private sprayHp: BiquadFilterNode;
  private sprayGain: GainNode;
  private squealSrc: AudioBufferSourceNode;
  private squealGain: GainNode;

  readonly voiceGain: GainNode;
  slot: SpatialSlot | null = null;

  /** Live state, exposed for the debug hook. */
  lod: VoiceLod = 3;
  state: EngineState | null = null;
  prevGear = -1;
  active = false;
  private smoothedThrottle = 0;
  private smoothedSlip = 0;
  private lastGearChange = 0;
  private curve: Float32Array;

  constructor(
    ctx: AudioContext,
    id: string,
    noise: AudioBuffer,
    squeal: AudioBuffer,
    destination: AudioNode,
  ) {
    this.ctx = ctx;
    this.id = id;

    this.voiceGain = ctx.createGain();
    this.voiceGain.gain.value = 0;
    this.voiceGain.connect(destination);

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 1;

    // Body resonance — the boom of the shell. Re-tuned per vehicle class.
    this.bodyEq = ctx.createBiquadFilter();
    this.bodyEq.type = 'peaking';
    this.bodyEq.frequency.value = 132;
    this.bodyEq.Q.value = 1.6;
    this.bodyEq.gain.value = 6;

    this.curve = softClipCurve(1024, 1.2);
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = this.curve as Float32Array<ArrayBuffer>;
    this.shaper.oversample = '2x';

    this.preShaper = ctx.createGain();
    this.preShaper.gain.value = 1;

    this.preShaper.connect(this.shaper);
    this.shaper.connect(this.bodyEq);
    this.bodyEq.connect(this.engineGain);
    this.engineGain.connect(this.voiceGain);

    // --- harmonic stack ---
    for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 60 * HARMONIC_ORDERS[i];
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      g.connect(this.preShaper);
      o.start();
      this.oscs.push(o);
      this.oscGains.push(g);
    }

    // --- rattle bank: a detuned saw for mechanical untidiness ---
    this.rattle = ctx.createOscillator();
    this.rattle.type = 'sawtooth';
    this.rattle.frequency.value = 60;
    this.rattleGain = ctx.createGain();
    this.rattleGain.gain.value = 0;
    this.rattle.connect(this.rattleGain);
    this.rattleGain.connect(this.preShaper);
    this.rattle.start();

    // --- induction ---
    this.inductionSrc = loopSource(ctx, noise, 1.0);
    this.inductionBp = ctx.createBiquadFilter();
    this.inductionBp.type = 'bandpass';
    this.inductionBp.frequency.value = 900;
    this.inductionBp.Q.value = 1.4;
    this.inductionGain = ctx.createGain();
    this.inductionGain.gain.value = 0;
    this.inductionSrc.connect(this.inductionBp);
    this.inductionBp.connect(this.inductionGain);
    this.inductionGain.connect(this.preShaper);

    // --- exhaust ---
    this.exhaustSrc = loopSource(ctx, noise, 0.83);
    this.exhaustLp = ctx.createBiquadFilter();
    this.exhaustLp.type = 'lowpass';
    this.exhaustLp.frequency.value = 500;
    this.exhaustLp.Q.value = 1.1;
    this.exhaustGain = ctx.createGain();
    this.exhaustGain.gain.value = 0;
    this.exhaustSrc.connect(this.exhaustLp);
    this.exhaustLp.connect(this.exhaustGain);
    this.exhaustGain.connect(this.preShaper);

    // --- tyres ---
    this.rollSrc = loopSource(ctx, noise, 1.17);
    this.rollBp = ctx.createBiquadFilter();
    this.rollBp.type = 'bandpass';
    this.rollBp.frequency.value = 400;
    this.rollBp.Q.value = 0.55;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    this.rollSrc.connect(this.rollBp);
    this.rollBp.connect(this.rollGain);
    this.rollGain.connect(this.voiceGain);

    this.spraySrc = loopSource(ctx, noise, 0.71);
    this.sprayHp = ctx.createBiquadFilter();
    this.sprayHp.type = 'highpass';
    this.sprayHp.frequency.value = 2200;
    this.sprayHp.Q.value = 0.7;
    this.sprayGain = ctx.createGain();
    this.sprayGain.gain.value = 0;
    this.spraySrc.connect(this.sprayHp);
    this.sprayHp.connect(this.sprayGain);
    this.sprayGain.connect(this.voiceGain);

    this.squealSrc = loopSource(ctx, squeal, 1);
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealSrc.connect(this.squealGain);
    this.squealGain.connect(this.voiceGain);
  }

  setKind(kind: EngineClass): void {
    this.kind = kind;
    this.spec = ENGINE_SPECS[kind] ?? ENGINE_SPECS.sedan;
    this.bodyEq.frequency.setValueAtTime(this.spec.bodyResonance, this.ctx.currentTime);
    this.bodyEq.gain.setValueAtTime(4 + this.spec.rattle * 4, this.ctx.currentTime);
    this.prevGear = -1;
  }

  /**
   * Update the whole voice. `wetness` is WeatherService.wetness.
   * Returns true if a gear change happened this frame (used for the upshift
   * chirp / suspension knock feedback).
   */
  update(p: VehicleProbe, wetness: number, listenerVel: THREE.Vector3, listenerPos: THREE.Vector3, dt: number): boolean {
    const t = this.ctx.currentTime;
    const lod = lodForDistance(p.distance, p.isPlayer);
    this.lod = lod;

    if (lod === 3) {
      if (this.active) {
        this.voiceGain.gain.setTargetAtTime(0, t, 0.08);
        this.active = false;
      }
      return false;
    }
    this.active = true;

    // Smooth the driver inputs — raw throttle is a step function and steps
    // make the engine note buzz.
    this.smoothedThrottle = approach(this.smoothedThrottle, p.throttle, 9, dt);
    this.smoothedSlip = approach(this.smoothedSlip, p.slip, 14, dt);

    const st = engineState(this.spec, {
      speed: p.speed,
      throttle: this.smoothedThrottle,
      airborne: p.airborne,
      wrecked: p.wrecked,
      prevGear: this.prevGear,
    });
    const gearChanged = st.gear !== this.prevGear && this.prevGear >= 0;
    this.prevGear = st.gear;
    if (gearChanged) this.lastGearChange = t;
    this.state = st;

    // ---- doppler ----
    const dx = p.position.x - listenerPos.x;
    const dy = p.position.y - listenerPos.y;
    const dz = p.position.z - listenerPos.z;
    const dop = p.isPlayer ? 1 : dopplerFactor(
      dx, dy, dz,
      p.velocity.x, p.velocity.y, p.velocity.z,
      listenerVel.x, listenerVel.y, listenerVel.z,
    );
    const cents = ratioToCents(dop);

    // ---- harmonic stack ----
    // 25 ms smoothing: fast enough to follow a throttle stab, slow enough to
    // avoid the zipper artefacts of per-frame setValueAtTime.
    const tc = 0.025;
    const nH = LOD_HARMONICS[lod];
    for (let i = 0; i < this.oscs.length; i++) {
      const on = i < nH;
      const f = clamp(st.fundamental * HARMONIC_ORDERS[i], 12, 12000);
      this.oscs[i].frequency.setTargetAtTime(f, t, tc);
      this.oscs[i].detune.setTargetAtTime(cents, t, tc);
      this.oscGains[i].gain.setTargetAtTime(on ? st.harmonics[i] * 0.26 : 0, t, tc);
    }

    // Rattle bank: only worth its node at LOD 0-1.
    this.rattle.frequency.setTargetAtTime(clamp(st.fundamental, 12, 4000), t, tc);
    this.rattle.detune.setTargetAtTime(cents + st.detuneCents, t, tc);
    this.rattleGain.gain.setTargetAtTime(lod <= 1 ? this.spec.rattle * 0.035 : 0, t, tc);

    // Load-dependent drive into the shaper: this is the "harder" character
    // under throttle, not just a louder one.
    this.preShaper.gain.setTargetAtTime(0.6 + st.drive * 1.5, t, tc);

    // ---- noise beds ----
    this.inductionBp.frequency.setTargetAtTime(clamp(st.inductionHz, 120, 9000), t, tc);
    this.inductionGain.gain.setTargetAtTime(lod === 0 ? st.inductionLevel * 0.42 : 0, t, tc);
    this.exhaustLp.frequency.setTargetAtTime(clamp(st.exhaustHz, 90, 9000), t, tc);
    this.exhaustGain.gain.setTargetAtTime(lod <= 1 ? st.exhaustLevel * 0.55 : st.exhaustLevel * 0.3, t, tc);
    this.inductionSrc.playbackRate.setTargetAtTime(dop, t, tc);
    this.exhaustSrc.playbackRate.setTargetAtTime(0.83 * dop, t, tc);

    // ---- tyres ----
    const ty = tyreState({
      speed: p.speed,
      wetness,
      slip: this.smoothedSlip,
      handbrake: p.handbrake,
      grounded: p.grounded,
    });
    this.rollBp.frequency.setTargetAtTime(clamp(ty.rollHz, 90, 6000), t, tc);
    this.rollGain.gain.setTargetAtTime(lod <= 1 ? ty.rollLevel * 0.42 : 0, t, tc);
    this.sprayGain.gain.setTargetAtTime(lod === 0 ? ty.sprayLevel * 0.38 : 0, t, tc);
    this.squealSrc.playbackRate.setTargetAtTime(clamp(ty.squealHz / 900, 0.5, 2.2), t, 0.05);
    this.squealGain.gain.setTargetAtTime(lod <= 1 ? ty.squealLevel * 0.32 : 0, t, 0.04);
    this.rollSrc.playbackRate.setTargetAtTime(1.17 * dop, t, tc);

    // ---- overall level ----
    // The player's own car sits closer and louder; everything else is
    // attenuated by the panner, so the voice gain only carries the model.
    const lodTrim = lod === 0 ? 1 : lod === 1 ? 0.85 : 0.55;
    const target = st.gain * lodTrim * (p.isPlayer ? 0.72 : 0.5);
    this.voiceGain.gain.setTargetAtTime(target, t, 0.05);

    return gearChanged && t - this.lastGearChange < dt * 2;
  }

  silence(): void {
    const t = this.ctx.currentTime;
    this.voiceGain.gain.setTargetAtTime(0, t, 0.05);
    this.active = false;
    this.state = null;
    this.prevGear = -1;
    this.smoothedThrottle = 0;
    this.smoothedSlip = 0;
  }

  dispose(): void {
    try {
      for (const o of this.oscs) o.stop();
      this.rattle.stop();
      this.inductionSrc.stop();
      this.exhaustSrc.stop();
      this.rollSrc.stop();
      this.spraySrc.stop();
      this.squealSrc.stop();
    } catch {
      /* already stopped */
    }
    this.voiceGain.disconnect();
  }
}

function loopSource(ctx: AudioContext, b: AudioBuffer, rate: number): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = b;
  s.loop = true;
  s.playbackRate.value = rate;
  // Start each source at a different offset so five cars do not phase-lock
  // into an obvious shared noise pattern.
  s.start(0, (rate * 7919) % b.duration);
  return s;
}
