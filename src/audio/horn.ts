/**
 * THE HORN — a held note, not a one-shot.
 *
 * `horn` is bound to H in src/core/input.ts and listed in the pause menu as
 * "Claxon", and until now pressing it did nothing at all. It cannot be the
 * pooled `horn` one-shot from the bank either: a horn is something you LEAN ON,
 * and retriggering a 0.55 s buffer while the key is down produces a stutter
 * that sounds like a fault rather than like a Bucharest junction.
 *
 * So it is a live voice:
 *
 *   two reed oscillator banks (saw, detuned ~6% apart) ─▶ reed mix
 *                                                          │
 *          band-limit LP 4.2k ─▶ presence peak 1.9k ─▶ horn shaper
 *                                                          │
 *                                 envelope gain ─▶ destination
 *
 * Two banks a whole quarter-tone-plus apart is not a mistake — a real twin-horn
 * car sounds two reeds deliberately detuned so the beating carries further than
 * either note alone. That beat is most of what makes a horn recognisable.
 *
 * The envelope matters as much as the tone. A reed takes ~18 ms to start
 * sounding and the air column keeps going for ~60 ms after the contact opens,
 * with a tiny pitch droop as the voltage sags on a 40-year-old wiring loom.
 */

import { clamp, softClipCurve } from './dsp';

/** Harmonic weights for one reed. A horn is a buzzing sheet, so it is rich. */
const REED_ORDERS = [1, 2, 3, 4, 5, 6, 7] as const;

export class HornVoice {
  /** 0..1 — how hard the horn is being pressed right now. */
  private level = 0;
  private ctx: AudioContext;
  private oscs: OscillatorNode[] = [];
  private gain: GainNode;
  /** Base frequency of the lower reed, Hz. */
  private baseHz = 0;

  constructor(ctx: AudioContext, destination: AudioNode, baseHz = 400) {
    this.ctx = ctx;
    this.baseHz = baseHz;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.8;

    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 1900;
    presence.Q.value = 2;
    presence.gain.value = 7;

    // A horn is driven well past linearity — the reed slaps its seat.
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1024, 2.4) as Float32Array<ArrayBuffer>;
    shaper.oversample = '2x';

    const mix = ctx.createGain();
    mix.gain.value = 0.5;

    mix.connect(lp);
    lp.connect(presence);
    presence.connect(shaper);
    shaper.connect(this.gain);
    this.gain.connect(destination);

    // Two reeds, 1.0 and 1.26 — a major third and a bit, which is the interval
    // most twin horns actually use.
    for (const ratio of [1, 1.26]) {
      for (const order of REED_ORDERS) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = baseHz * ratio * order;
        const g = ctx.createGain();
        g.gain.value = (ratio === 1 ? 0.55 : 0.42) / Math.pow(order, 0.85);
        o.connect(g);
        g.connect(mix);
        o.start();
        this.oscs.push(o);
      }
    }
  }

  /**
   * `amount` is 0 (released) or 1 (held). Called every frame; the envelope and
   * the voltage droop are handled here, so the caller only has to pass the key
   * state through.
   */
  set(amount: number, dt: number): void {
    const want = clamp(amount, 0, 1);
    const t = this.ctx.currentTime;
    // Asymmetric: reeds start faster than they stop.
    const rate = want > this.level ? 55 : 26;
    this.level += (want - this.level) * (1 - Math.exp(-rate * dt));
    if (this.level < 1e-4) this.level = 0;
    this.gain.gain.setTargetAtTime(this.level * 0.5, t, 0.006);

    // Voltage droop: a sustained press pulls the reed pitch down by a few
    // cents. This is the detail that stops a long press sounding synthetic.
    if (this.level > 0.01) {
      const droop = -this.level * 14;
      for (const o of this.oscs) o.detune.setTargetAtTime(droop, t, 0.18);
    }
  }

  get sounding(): boolean {
    return this.level > 0.01;
  }

  /** Retune for a different car — a van's horn is lower than a hatchback's. */
  setBase(hz: number): void {
    if (Math.abs(hz - this.baseHz) < 1) return;
    this.baseHz = hz;
    const t = this.ctx.currentTime;
    let i = 0;
    for (const ratio of [1, 1.26]) {
      for (const order of REED_ORDERS) {
        this.oscs[i++]?.frequency.setTargetAtTime(hz * ratio * order, t, 0.02);
      }
    }
  }

  dispose(): void {
    for (const o of this.oscs) {
      try { o.stop(); } catch { /* already stopped */ }
    }
    this.gain.disconnect();
  }
}

/** Horn pitch by vehicle class. A Dacia's is thin and flat; a bus blares. */
export function hornBaseHz(kind: string): number {
  switch (kind) {
    case 'dacia': return 372;
    case 'truck':
    case 'bus': return 232;
    case 'van': return 296;
    case 'police': return 452;
    case 'scooter': return 610;
    case 'tram': return 268;
    default: return 400;
  }
}
