/**
 * DSP PRIMITIVES — pure functions, no WebAudio.
 *
 * Everything here runs identically in the browser and under `bun test`, which
 * is the whole point: the synthesis *models* are testable numerically even
 * though Bun has no `OfflineAudioContext`. The WebAudio graph in the rest of
 * `src/audio/` only realises the numbers these functions produce.
 *
 * Determinism: all noise generators take an `Rng` (src/core/rng.ts). Never
 * `Math.random()` — the offline-rendered SFX bank must be byte-identical
 * between runs so screenshots and level measurements stay comparable.
 */

import { Rng } from '../core/rng';

/* ------------------------------------------------------------------ */
/* Levels                                                              */
/* ------------------------------------------------------------------ */

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(1e-9, Math.abs(g)));
}

export function rms(buf: Float32Array | number[]): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}

export function peak(buf: Float32Array | number[]): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > p) p = a;
  }
  return p;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/* ------------------------------------------------------------------ */
/* Spectral analysis                                                   */
/* ------------------------------------------------------------------ */

/**
 * Magnitude of a single frequency bin via the Goertzel algorithm.
 * O(n) per frequency — ideal for asserting "there is energy at 2*f0".
 * Returns a normalised magnitude (0..~0.5 for a unit-amplitude sine).
 */
export function goertzel(buf: Float32Array | number[], sampleRate: number, freq: number): number {
  const n = buf.length;
  const k = (freq * n) / sampleRate;
  const w = (2 * Math.PI * k) / n;
  const cosw = Math.cos(w);
  const coeff = 2 * cosw;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = buf[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * cosw;
  const imag = s2 * Math.sin(w);
  return (2 * Math.sqrt(real * real + imag * imag)) / n;
}

/**
 * Spectral centroid in Hz from a linear magnitude spectrum.
 * `mag[i]` corresponds to `i * sampleRate / (2 * mag.length)` Hz.
 */
export function spectralCentroid(mag: ArrayLike<number>, sampleRate: number): number {
  let num = 0;
  let den = 0;
  const binHz = sampleRate / (2 * mag.length);
  for (let i = 0; i < mag.length; i++) {
    const m = mag[i];
    if (m <= 0) continue;
    num += i * binHz * m;
    den += m;
  }
  return den > 0 ? num / den : 0;
}

/** Convert an AnalyserNode dB spectrum (-100..0) to linear magnitudes. */
export function dbSpectrumToLinear(db: ArrayLike<number>, out: Float32Array): Float32Array {
  for (let i = 0; i < db.length; i++) out[i] = Math.pow(10, db[i] / 20);
  return out;
}

/* ------------------------------------------------------------------ */
/* Noise generators (deterministic)                                    */
/* ------------------------------------------------------------------ */

export function whiteNoise(out: Float32Array, rng: Rng): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = rng.next() * 2 - 1;
  return out;
}

/** Paul Kellet's economy pink-noise filter. Roughly -3 dB/octave. */
export function pinkNoise(out: Float32Array, rng: Rng): Float32Array {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return normalise(out, 0.9);
}

/** Brown / red noise, -6 dB/octave. Good for distant traffic and rumble. */
export function brownNoise(out: Float32Array, rng: Rng): Float32Array {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng.next() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last;
  }
  return normalise(out, 0.9);
}

export function normalise(buf: Float32Array, target = 1): Float32Array {
  const p = peak(buf);
  if (p < 1e-9) return buf;
  const g = target / p;
  for (let i = 0; i < buf.length; i++) buf[i] *= g;
  return buf;
}

/* ------------------------------------------------------------------ */
/* Filters (in-place, for offline buffer synthesis)                    */
/* ------------------------------------------------------------------ */

export function onePoleLowpass(buf: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let y = 0;
  for (let i = 0; i < buf.length; i++) {
    y = buf[i] * (1 - a) + y * a;
    buf[i] = y;
  }
  return buf;
}

export function onePoleHighpass(buf: Float32Array, cutoffHz: number, sampleRate: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  let y = 0;
  let prev = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    y = a * (y + x - prev);
    prev = x;
    buf[i] = y;
  }
  return buf;
}

/** RBJ biquad, direct form I, applied in place. */
export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'notch';

export function biquad(
  buf: Float32Array,
  kind: BiquadKind,
  f0: number,
  q: number,
  sampleRate: number,
  gainDb = 0,
): Float32Array {
  const w0 = (2 * Math.PI * Math.min(f0, sampleRate * 0.49)) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(0.0001, q));
  const A = Math.pow(10, gainDb / 40);
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  switch (kind) {
    case 'lowpass':
      b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'bandpass':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1; b1 = -2 * cw; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
      break;
  }

  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    buf[i] = y;
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* Envelopes                                                           */
/* ------------------------------------------------------------------ */

export interface EnvelopeSpec {
  /** Attack time, seconds. */
  attack: number;
  /** Decay time constant, seconds (exponential toward `sustain`). */
  decay: number;
  /** Sustain level 0..1. */
  sustain: number;
  /** Total duration, seconds. Release runs over the last `release` seconds. */
  duration: number;
  release: number;
}

/** Amplitude of an ADSR-ish envelope at time `t` seconds. */
export function envelopeAt(t: number, e: EnvelopeSpec): number {
  if (t < 0 || t > e.duration) return 0;
  let a: number;
  if (t < e.attack) {
    a = e.attack <= 0 ? 1 : t / e.attack;
  } else {
    const td = t - e.attack;
    a = e.sustain + (1 - e.sustain) * Math.exp(-td / Math.max(1e-5, e.decay));
  }
  const relStart = e.duration - e.release;
  if (t > relStart && e.release > 0) {
    a *= 1 - (t - relStart) / e.release;
  }
  return clamp(a, 0, 1);
}

/** Time at which an exponential decay of time-constant `tau` falls to `frac`. */
export function decayTimeTo(tau: number, frac: number): number {
  return -tau * Math.log(clamp(frac, 1e-9, 1));
}

/* ------------------------------------------------------------------ */
/* Waveshaping                                                         */
/* ------------------------------------------------------------------ */

/** Soft-clip curve for a WaveShaperNode. `drive` >= 1. */
export function softClipCurve(samples: number, drive: number): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

/** Asymmetric curve — cheap "cheap car speaker cone" grit. */
export function speakerCurve(samples: number, drive: number): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const d = x >= 0 ? drive : drive * 1.45;
    curve[i] = Math.tanh(x * d) / Math.tanh(d * 1.2);
  }
  return curve;
}

/* ------------------------------------------------------------------ */
/* Small helpers used by the offline bank                              */
/* ------------------------------------------------------------------ */

/** Mix `src` into `dst` at sample offset `at` with gain `g`. */
export function mixInto(dst: Float32Array, src: Float32Array, at: number, g = 1): void {
  const n = Math.min(src.length, dst.length - at);
  for (let i = 0; i < n; i++) dst[at + i] += src[i] * g;
}

/** Apply an envelope over an entire buffer. */
export function applyEnvelope(buf: Float32Array, sampleRate: number, e: EnvelopeSpec): Float32Array {
  for (let i = 0; i < buf.length; i++) buf[i] *= envelopeAt(i / sampleRate, e);
  return buf;
}

/**
 * Additive sine bank; `partials` are [freqHz, amplitude, phase?].
 *
 * A pure sinusoid satisfies the two-term recurrence
 * `s[n] = 2·cos(w)·s[n-1] − s[n-2]`, so each partial costs one multiply and two
 * adds per sample instead of a `Math.sin` call. On the offline bank that is the
 * difference between a boot that renders in two seconds and one that renders in
 * four (this and `modes` were between them most of the cost).
 *
 * Unlike the decaying case in `modes`, this recurrence sits exactly on the unit
 * circle, so rounding error in `cos(w)` accumulates as a slow amplitude drift
 * over hundreds of thousands of samples. Re-seeding from `Math.sin` every 4096
 * samples bounds the error at a level far below the 24-bit noise floor while
 * still eliminating 99.95% of the transcendental calls.
 */
const RESYNC = 4096;

export function additive(
  out: Float32Array,
  sampleRate: number,
  partials: ReadonlyArray<readonly [number, number, number?]>,
): Float32Array {
  const n = out.length;
  for (const [f, a, ph] of partials) {
    const w = (2 * Math.PI * f) / sampleRate;
    const p0 = ph ?? 0;
    const c = 2 * Math.cos(w);
    let s2 = 0;
    let s1 = 0;
    for (let i = 0; i < n; i++) {
      if ((i & (RESYNC - 1)) === 0) {
        // Re-seed the pair from the closed form.
        s2 = Math.sin(w * (i - 1) + p0);
        s1 = Math.sin(w * i + p0);
      }
      out[i] += s1 * a;
      const s0 = c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
  }
  return out;
}

/** Linear frequency sweep, written (added) into `out`. */
export function sweep(
  out: Float32Array,
  sampleRate: number,
  f0: number,
  f1: number,
  amp: number,
  exponential = false,
): Float32Array {
  const n = out.length;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = exponential ? f0 * Math.pow(f1 / f0, t) : f0 + (f1 - f0) * t;
    phase += (2 * Math.PI * f) / sampleRate;
    out[i] += Math.sin(phase) * amp;
  }
  return out;
}
