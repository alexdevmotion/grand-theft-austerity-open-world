/**
 * THE MINISTRY SIREN.
 *
 *   square osc (carrier)  ─▶ carrierGain ─┐
 *   square osc (× 1.5)    ─▶ fifthGain ───┤─▶ bandpass ─▶ shaper ─▶ gain ─▶ slot
 *                                         │
 *   AM tremolo LFO ───────────────────────┘  (via the gain params)
 *
 * The carrier follows `sirenFrequencyAt()` — a genuine two-tone with a glide,
 * turning into a wail then a yelp as Crisis Stars climb. Doppler is applied as
 * an oscillator detune from the radial relative velocity, because WebAudio no
 * longer does it for us.
 *
 * Nodes are built once per pooled siren and never torn down.
 */

import * as THREE from 'three';
import { clamp, softClipCurve } from './dsp';
import { dopplerFactor, ratioToCents, sirenFrequencyAt, type SirenMode } from './sirenModel';
import type { SpatialSlot } from './spatial';

export class SirenVoice {
  private ctx: AudioContext;
  private carrier: OscillatorNode;
  private fifth: OscillatorNode;
  private carrierGain: GainNode;
  private fifthGain: GainNode;
  private bp: BiquadFilterNode;
  private shaper: WaveShaperNode;
  readonly out: GainNode;

  slot: SpatialSlot | null = null;
  vehicleId = '';
  active = false;
  mode: SirenMode = 'twoTone';
  /** Per-siren phase offset so a convoy does not sound like one big siren. */
  private phase = 0;
  lastFreq = 0;

  constructor(ctx: AudioContext, destination: AudioNode, phase = 0) {
    this.ctx = ctx;
    this.phase = phase;

    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve(512, 2.4) as Float32Array<ArrayBuffer>;
    this.shaper.connect(this.out);

    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 1100;
    this.bp.Q.value = 0.9;
    this.bp.connect(this.shaper);

    this.carrier = ctx.createOscillator();
    this.carrier.type = 'square';
    this.carrier.frequency.value = 660;
    this.carrierGain = ctx.createGain();
    this.carrierGain.gain.value = 0.32;
    this.carrier.connect(this.carrierGain);
    this.carrierGain.connect(this.bp);
    this.carrier.start();

    this.fifth = ctx.createOscillator();
    this.fifth.type = 'square';
    this.fifth.frequency.value = 990;
    this.fifthGain = ctx.createGain();
    this.fifthGain.gain.value = 0.14;
    this.fifth.connect(this.fifthGain);
    this.fifthGain.connect(this.bp);
    this.fifth.start();
  }

  /**
   * @param level 0..1 overall loudness (0 silences the siren).
   */
  update(
    level: number,
    mode: SirenMode,
    sourcePos: THREE.Vector3,
    sourceVel: THREE.Vector3,
    listenerPos: THREE.Vector3,
    listenerVel: THREE.Vector3,
  ): void {
    const t = this.ctx.currentTime;
    this.mode = mode;

    if (level <= 0.001) {
      if (this.active) {
        this.out.gain.setTargetAtTime(0, t, 0.08);
        this.active = false;
      }
      return;
    }
    this.active = true;

    const f = sirenFrequencyAt(t + this.phase, mode);
    this.lastFreq = f;

    const dop = dopplerFactor(
      sourcePos.x - listenerPos.x, sourcePos.y - listenerPos.y, sourcePos.z - listenerPos.z,
      sourceVel.x, sourceVel.y, sourceVel.z,
      listenerVel.x, listenerVel.y, listenerVel.z,
    );
    const cents = ratioToCents(dop);

    this.carrier.frequency.setTargetAtTime(f, t, 0.012);
    this.fifth.frequency.setTargetAtTime(f * 1.5, t, 0.012);
    this.carrier.detune.setTargetAtTime(cents, t, 0.02);
    this.fifth.detune.setTargetAtTime(cents, t, 0.02);
    // The bandpass tracks the carrier so the tone stays present through the
    // sweep instead of ducking out at the extremes.
    this.bp.frequency.setTargetAtTime(clamp(f * 1.35, 300, 6000), t, 0.02);

    this.out.gain.setTargetAtTime(clamp(level, 0, 1) * 0.5, t, 0.05);
  }

  silence(): void {
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.active = false;
    this.vehicleId = '';
  }

  dispose(): void {
    try {
      this.carrier.stop();
      this.fifth.stop();
    } catch {
      /* already stopped */
    }
    this.out.disconnect();
  }
}
