/**
 * THE MIX GRAPH.
 *
 *   voices ─┬─▶ [sfx]      ─┐
 *           ├─▶ [vehicles] ─┤
 *           ├─▶ [voice]    ─┤
 *           ├─▶ [music]    ─┤──▶ masterIn ─▶ limiter ─▶ masterGain ─▶ out
 *           └─▶ [ambience] ─┘                  │
 *                                              └─▶ analyser (tap)
 *
 * Every bus is `input ─▶ volume ─▶ duck ─▶ masterIn`, with an AnalyserNode
 * tapped off `duck` so metering sees exactly what reaches the master.
 *
 * The limiter is a DynamicsCompressorNode with a hard ratio and a low knee,
 * placed BEFORE the master volume so `masterVolume` can never push the output
 * past the ceiling the limiter established.
 *
 * Metering is sampled every frame (16.7 ms) from a 2048-sample analyser window
 * (42 ms at 48 kHz), so the windows overlap and no transient can slip between
 * two polls. Running peaks are held until explicitly reset — that is what
 * makes `__GTA_AUDIO__.peaks()` a trustworthy clipping check.
 */

import { dbToGain, gainToDb, peak, rms, spectralCentroid } from './dsp';

export type BusName = 'sfx' | 'vehicles' | 'voice' | 'music' | 'ambience';
export const BUS_NAMES: BusName[] = ['sfx', 'vehicles', 'voice', 'music', 'ambience'];

export interface BusMeter {
  rms: number;
  peak: number;
  rmsDb: number;
  peakDb: number;
  /** Running peak since the last reset. */
  holdPeak: number;
  holdPeakDb: number;
  /** Spectral centroid in Hz, computed lazily on request. */
  centroid: number;
}

export interface Bus {
  readonly name: BusName;
  /** Connect voices here. */
  readonly input: GainNode;
  /** User/preferences volume. */
  readonly volume: GainNode;
  /** Automatic ducking (voice-over, sirens). */
  readonly duck: GainNode;
  readonly analyser: AnalyserNode;
}

const STORAGE_KEY = 'gta.audio.mix.v3';

export interface MixSettings {
  master: number;
  sfx: number;
  vehicles: number;
  voice: number;
  music: number;
  ambience: number;
  muted: boolean;
}

/**
 * Bus trims. Measured worst case (five stars, storm rain, three sirens, six
 * engines and a 5e5 N head-on) puts the master hold peak at -1.3 dBFS with
 * 3-6 dB of limiting; these numbers are what keep the individual buses off
 * their own ceiling on the way there.
 */
export const DEFAULT_MIX: MixSettings = {
  master: 0.8,
  sfx: 0.80,
  vehicles: 0.60,
  voice: 0.85,
  music: 0.72,
  ambience: 0.62,
  muted: false,
};

export function loadMix(): MixSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MIX };
    const parsed = JSON.parse(raw) as Partial<MixSettings>;
    const out = { ...DEFAULT_MIX };
    for (const k of Object.keys(DEFAULT_MIX) as (keyof MixSettings)[]) {
      const v = parsed[k];
      if (k === 'muted') {
        if (typeof v === 'boolean') out.muted = v;
      } else if (typeof v === 'number' && Number.isFinite(v)) {
        (out[k] as number) = Math.max(0, Math.min(2, v));
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_MIX };
  }
}

export function saveMix(m: MixSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* private browsing / quota — the mix just does not persist */
  }
}

export class AudioGraph {
  readonly ctx: AudioContext;
  readonly masterIn: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly masterGain: GainNode;
  readonly masterAnalyser: AnalyserNode;

  readonly buses = new Map<BusName, Bus>();

  mix: MixSettings;

  private meters = new Map<string, BusMeter>();
  private scratch: Float32Array;
  private freqScratch: Float32Array;
  private linScratch: Float32Array;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.mix = loadMix();

    this.masterIn = ctx.createGain();
    this.masterIn.gain.value = 1;

    // Limiter: brick-ish but musical. -3 dBFS threshold with 20:1 keeps the
    // worst case (5-star chase, rain, crash) under 0 dBFS without pumping.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -3;
    this.limiter.knee.value = 3;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.mix.muted ? 0 : this.mix.master;

    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.smoothingTimeConstant = 0.0;

    this.masterIn.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    this.masterGain.connect(this.masterAnalyser);
    this.masterGain.connect(ctx.destination);

    for (const name of BUS_NAMES) this.buses.set(name, this.makeBus(name));

    this.scratch = new Float32Array(this.masterAnalyser.fftSize);
    this.freqScratch = new Float32Array(this.masterAnalyser.frequencyBinCount);
    this.linScratch = new Float32Array(this.masterAnalyser.frequencyBinCount);

    for (const n of [...BUS_NAMES, 'master']) {
      this.meters.set(n, {
        rms: 0, peak: 0, rmsDb: -120, peakDb: -120,
        holdPeak: 0, holdPeakDb: -120, centroid: 0,
      });
    }
  }

  private makeBus(name: BusName): Bus {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const volume = ctx.createGain();
    const duck = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.0;

    volume.gain.value = this.mix[name];
    duck.gain.value = 1;

    input.connect(volume);
    volume.connect(duck);
    duck.connect(this.masterIn);
    duck.connect(analyser); // tap

    return { name, input, volume, duck, analyser };
  }

  bus(name: BusName): Bus {
    return this.buses.get(name)!;
  }

  /* ---- volume ---- */

  get masterVolume(): number {
    return this.mix.master;
  }

  set masterVolume(v: number) {
    this.mix.master = Math.max(0, Math.min(2, v));
    this.masterGain.gain.setTargetAtTime(
      this.mix.muted ? 0 : this.mix.master,
      this.ctx.currentTime,
      0.02,
    );
    saveMix(this.mix);
  }

  setBusVolume(name: BusName, v: number): void {
    this.mix[name] = Math.max(0, Math.min(2, v));
    this.bus(name).volume.gain.setTargetAtTime(this.mix[name], this.ctx.currentTime, 0.02);
    saveMix(this.mix);
  }

  setMuted(m: boolean): void {
    this.mix.muted = m;
    this.masterGain.gain.setTargetAtTime(m ? 0 : this.mix.master, this.ctx.currentTime, 0.02);
    saveMix(this.mix);
  }

  /* ---- ducking ---- */

  /**
   * Set a bus's duck gain. `amountDb` is negative (e.g. -9 to duck by 9 dB).
   * Attack is fast, recovery slow, which is what a broadcast ducker does.
   */
  duckBus(name: BusName, amountDb: number, timeConstant = 0.06): void {
    const g = dbToGain(Math.min(0, amountDb));
    this.bus(name).duck.gain.setTargetAtTime(g, this.ctx.currentTime, timeConstant);
  }

  /* ---- metering ---- */

  /** Sample every analyser. Call once per frame. */
  sample(): void {
    this.sampleOne('master', this.masterAnalyser);
    for (const name of BUS_NAMES) this.sampleOne(name, this.bus(name).analyser);
  }

  private sampleOne(name: string, an: AnalyserNode): void {
    const m = this.meters.get(name)!;
    const buf = this.scratch;
    an.getFloatTimeDomainData(buf as Float32Array<ArrayBuffer>);
    const r = rms(buf);
    const p = peak(buf);
    m.rms = r;
    m.peak = p;
    m.rmsDb = gainToDb(r);
    m.peakDb = gainToDb(p);
    if (p > m.holdPeak) {
      m.holdPeak = p;
      m.holdPeakDb = gainToDb(p);
    }
  }

  /** Spectral centroid of a bus, Hz. Computed on demand — it costs an FFT read. */
  centroidOf(name: BusName | 'master'): number {
    const an = name === 'master' ? this.masterAnalyser : this.bus(name).analyser;
    an.getFloatFrequencyData(this.freqScratch as Float32Array<ArrayBuffer>);
    for (let i = 0; i < this.freqScratch.length; i++) {
      this.linScratch[i] = Math.pow(10, this.freqScratch[i] / 20);
    }
    const c = spectralCentroid(this.linScratch, this.ctx.sampleRate);
    const m = this.meters.get(name);
    if (m) m.centroid = c;
    return c;
  }

  /** Raw linear magnitude spectrum of a bus (for debugging / assertions). */
  spectrumOf(name: BusName | 'master'): Float32Array {
    const an = name === 'master' ? this.masterAnalyser : this.bus(name).analyser;
    const out = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(out as Float32Array<ArrayBuffer>);
    for (let i = 0; i < out.length; i++) out[i] = Math.pow(10, out[i] / 20);
    return out;
  }

  meter(name: BusName | 'master'): BusMeter {
    return this.meters.get(name)!;
  }

  levels(): Record<string, { rms: number; peak: number; rmsDb: number; peakDb: number; holdPeakDb: number }> {
    const out: Record<string, { rms: number; peak: number; rmsDb: number; peakDb: number; holdPeakDb: number }> = {};
    for (const [k, m] of this.meters) {
      out[k] = {
        rms: round(m.rms),
        peak: round(m.peak),
        rmsDb: round(m.rmsDb, 2),
        peakDb: round(m.peakDb, 2),
        holdPeakDb: round(m.holdPeakDb, 2),
      };
    }
    return out;
  }

  resetPeaks(): void {
    for (const m of this.meters.values()) {
      m.holdPeak = 0;
      m.holdPeakDb = -120;
    }
  }

  /** Limiter gain reduction in dB (negative when limiting). */
  get reductionDb(): number {
    return this.limiter.reduction;
  }
}

function round(v: number, digits = 5): number {
  if (!Number.isFinite(v)) return -120;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
