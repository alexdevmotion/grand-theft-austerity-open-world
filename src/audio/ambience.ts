/**
 * CITY AMBIENCE — a layered bed that follows you across Bucharest.
 *
 *   8 looping buffers ─▶ per-layer gain ─▶ cabin lowpass ─▶ ambience bus
 *
 * Every layer is a long procedurally rendered loop (bank.ts) with the tail
 * crossfaded into the head, so nothing ever clicks. The per-layer gains are
 * crossfaded against a district × time-of-day × weather mix table with a ~1.6 s
 * time constant: drive from the boulevards into the park and the bed audibly
 * turns from traffic-and-tram into leaves-and-birds without a seam.
 *
 * The cabin filter closes when the player is inside a vehicle — the city goes
 * muffled and the engine takes over, which is most of what "being in a car"
 * sounds like.
 */

import type { DistrictKind } from '../core/services';
import { Rng } from '../core/rng';
import { approach, clamp } from './dsp';
import {
  renderCrowdLoop, renderHvacLoop, renderIndustrialLoop, renderParkLoop,
  renderRainLoop, renderTrafficLoop, renderTramLoop, renderWindLoop, toAudioBuffer,
} from './bank';

export type AmbienceLayer =
  | 'traffic' | 'crowd' | 'tram' | 'wind' | 'rain' | 'industrial' | 'hvac' | 'park';

export const AMBIENCE_LAYERS: AmbienceLayer[] = [
  'traffic', 'crowd', 'tram', 'wind', 'rain', 'industrial', 'hvac', 'park',
];

type Mix = Partial<Record<AmbienceLayer, number>>;

/**
 * District character. These are *daytime, dry* base levels; time of day and
 * weather scale them afterwards.
 */
const DISTRICT_MIX: Record<DistrictKind, Mix> = {
  centruVechi:    { traffic: 0.34, crowd: 0.85, tram: 0.10, wind: 0.10, hvac: 0.05 },
  bulevard:       { traffic: 0.95, crowd: 0.34, tram: 0.42, wind: 0.24, hvac: 0.04 },
  glassCorporate: { traffic: 0.52, crowd: 0.40, tram: 0.16, wind: 0.44, hvac: 0.55 },
  guvern:         { traffic: 0.44, crowd: 0.22, tram: 0.12, wind: 0.38, hvac: 0.14 },
  cartier:        { traffic: 0.38, crowd: 0.44, tram: 0.26, wind: 0.20, hvac: 0.06 },
  industrial:     { traffic: 0.28, crowd: 0.06, tram: 0.20, wind: 0.34, industrial: 0.85 },
  parc:           { traffic: 0.16, crowd: 0.26, tram: 0.05, wind: 0.30, park: 0.90 },
};

export interface AmbienceInput {
  district: DistrictKind;
  /** Hours 0..24. */
  hours: number;
  /** 0..1 */
  rain: number;
  wetness: number;
  /** True when the listener is inside a vehicle. */
  inCabin: boolean;
  /** Crisis stars — the city gets tense and crowds get loud. */
  stars: number;
  /** Player speed, m/s — adds wind rush. */
  speed: number;
}

interface Layer {
  name: AmbienceLayer;
  src: AudioBufferSourceNode;
  gain: GainNode;
  target: number;
  current: number;
}

export class AmbienceBed {
  private ctx: AudioContext;
  private layers = new Map<AmbienceLayer, Layer>();
  private cabin: BiquadFilterNode;
  private out: GainNode;
  private cabinCutoff = 21000;

  /** Exposed for the debug hook. */
  readonly mix: Record<string, number> = {};
  district: DistrictKind = 'bulevard';

  constructor(ctx: AudioContext, destination: AudioNode, seed = 'gta-ambience') {
    this.ctx = ctx;
    const rng = new Rng(seed);
    const sr = ctx.sampleRate;

    this.out = ctx.createGain();
    this.out.gain.value = 1;

    this.cabin = ctx.createBiquadFilter();
    this.cabin.type = 'lowpass';
    this.cabin.frequency.value = 21000;
    this.cabin.Q.value = 0.6;
    this.cabin.connect(this.out);
    this.out.connect(destination);

    const build: Record<AmbienceLayer, () => Float32Array> = {
      traffic: () => renderTrafficLoop(sr, 9, rng.fork('traffic')),
      crowd: () => renderCrowdLoop(sr, 8, rng.fork('crowd')),
      tram: () => renderTramLoop(sr, 7, rng.fork('tram')),
      wind: () => renderWindLoop(sr, 11, rng.fork('wind')),
      rain: () => renderRainLoop(sr, 6, rng.fork('rain')),
      industrial: () => renderIndustrialLoop(sr, 10, rng.fork('industrial')),
      hvac: () => renderHvacLoop(sr, 6, rng.fork('hvac')),
      park: () => renderParkLoop(sr, 9, rng.fork('park')),
    };

    for (const name of AMBIENCE_LAYERS) {
      const b = toAudioBuffer(ctx, build[name]());
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain);
      gain.connect(this.cabin);
      src.start(0, rng.range(0, b.duration));
      this.layers.set(name, { name, src, gain, target: 0, current: 0 });
      this.mix[name] = 0;
    }
  }

  update(input: AmbienceInput, dt: number): void {
    this.district = input.district;
    const base = DISTRICT_MIX[input.district] ?? DISTRICT_MIX.bulevard;

    // Time of day: the city is quiet 01:00-05:00, busiest 08:00-19:00.
    const h = ((input.hours % 24) + 24) % 24;
    const dayness = clamp(
      h < 5 ? 0.18 : h < 8 ? 0.18 + (h - 5) / 3 * 0.72 : h < 19 ? 0.95 : h < 23 ? 0.95 - (h - 19) / 4 * 0.6 : 0.3,
      0.15, 1,
    );

    // Rain suppresses crowds and adds its own layer; wetness keeps a residual
    // hiss for a few minutes after the rain itself stops.
    const rain = clamp(input.rain, 0, 1);
    const wet = clamp(input.wetness, 0, 1);
    // Stars: crowd tension, more distant sirens in the traffic bed.
    const tension = clamp(input.stars / 5, 0, 1);
    const speedWind = clamp(Math.abs(input.speed) / 34, 0, 1);

    for (const name of AMBIENCE_LAYERS) {
      let v = base[name] ?? 0;
      switch (name) {
        case 'crowd':
          v *= dayness * (1 - rain * 0.65) * (1 + tension * 0.45);
          break;
        case 'traffic':
          v *= 0.45 + dayness * 0.55;
          v *= 1 + wet * 0.18; // wet tarmac hisses
          break;
        case 'tram':
          v *= 0.35 + dayness * 0.65;
          break;
        case 'wind':
          v = Math.max(v, 0.12) * (0.7 + rain * 0.5) + speedWind * 0.45;
          break;
        case 'rain':
          v = rain * 0.95 + wet * 0.1;
          break;
        case 'park':
          v *= dayness;
          v *= 1 - rain * 0.8;
          break;
        case 'industrial':
          v *= 0.6 + dayness * 0.4;
          break;
        case 'hvac':
          break;
      }
      const l = this.layers.get(name)!;
      l.target = clamp(v, 0, 1.2);
    }

    // Crossfade. 1.6 s time constant — audible as a change, never as a cut.
    const t = this.ctx.currentTime;
    for (const l of this.layers.values()) {
      l.current = approach(l.current, l.target, 0.65, dt);
      l.gain.gain.setTargetAtTime(l.current * 0.55, t, 0.25);
      this.mix[l.name] = Math.round(l.current * 1000) / 1000;
    }

    // Cabin muffling.
    const wantCutoff = input.inCabin ? 1250 : 21000;
    this.cabinCutoff = approach(this.cabinCutoff, wantCutoff, 4, dt);
    this.cabin.frequency.setTargetAtTime(this.cabinCutoff, t, 0.08);
  }

  /** Current summed target level — used by the debug hook and mix sanity. */
  get totalTarget(): number {
    let s = 0;
    for (const l of this.layers.values()) s += l.target;
    return s;
  }

  dispose(): void {
    for (const l of this.layers.values()) {
      try { l.src.stop(); } catch { /* already stopped */ }
    }
    this.out.disconnect();
  }
}
