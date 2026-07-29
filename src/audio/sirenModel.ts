/**
 * MINISTRY SIREN — pure model, no WebAudio.
 *
 * Two-tone European wail: the carrier alternates between a low and a high
 * plateau with a short glide between them, not a square jump (a square jump
 * clicks). At high Crisis Star counts it switches to a fast yelp — a
 * continuous sawtooth sweep — which is what makes 4-5 stars feel different
 * from 3 even before the pursuit count changes.
 *
 * Doppler is computed explicitly: the WebAudio PannerNode no longer implements
 * it (dopplerFactor was removed from the spec), so we shift the oscillator
 * detune ourselves from the radial component of the relative velocity.
 */

import { clamp } from './dsp';

export type SirenMode = 'twoTone' | 'wail' | 'yelp';

export interface SirenSpec {
  lowHz: number;
  highHz: number;
  /** Full cycle period, seconds. */
  periodSec: number;
  /** Glide fraction of a half-period spent sweeping between plateaus. */
  glide: number;
}

export const SIREN_SPECS: Record<SirenMode, SirenSpec> = {
  // Standard Ministry pursuit van: 660 / 880 Hz, ~1.6 s cycle.
  twoTone: { lowHz: 660, highHz: 880, periodSec: 1.6, glide: 0.35 },
  // Long American-style wail used for roadblocks and the helicopter.
  wail: { lowHz: 520, highHz: 1450, periodSec: 4.2, glide: 1.0 },
  // Maximum heat.
  yelp: { lowHz: 700, highHz: 1500, periodSec: 0.36, glide: 1.0 },
};

/** Speed of sound, m/s. */
export const SPEED_OF_SOUND = 343;

/**
 * Carrier frequency of the siren at time `t` seconds.
 * `twoTone` holds two plateaus with a smooth glide; `wail`/`yelp` are
 * continuous raised-cosine sweeps.
 */
export function sirenFrequencyAt(t: number, mode: SirenMode): number {
  const s = SIREN_SPECS[mode];
  const phase = ((t % s.periodSec) + s.periodSec) % s.periodSec / s.periodSec; // 0..1

  if (mode === 'twoTone') {
    const g = clamp(s.glide, 0.01, 1);
    // 0 .. 0.5 => low plateau then glide up; 0.5 .. 1 => high plateau then down.
    const half = phase < 0.5 ? phase * 2 : (phase - 0.5) * 2; // 0..1 within half
    const hold = 1 - g;
    let k: number;
    if (half < hold) k = 0;
    else k = smoothstep((half - hold) / g);
    return phase < 0.5
      ? s.lowHz + (s.highHz - s.lowHz) * k
      : s.highHz + (s.lowHz - s.highHz) * k;
  }

  // Raised cosine: continuous, no discontinuity at the wrap point.
  const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
  return s.lowHz + (s.highHz - s.lowHz) * k;
}

function smoothstep(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Doppler factor for a source moving with `sourceVel` relative to a listener
 * moving with `listenerVel`, along the unit vector from listener to source.
 *
 * f' = f * (c + v_listener_radial) / (c + v_source_radial)
 *
 * Returns a multiplier clamped to a musically sane range so that a physics
 * glitch cannot produce a 40 kHz oscillator.
 */
export function dopplerFactor(
  toSourceX: number, toSourceY: number, toSourceZ: number,
  sourceVx: number, sourceVy: number, sourceVz: number,
  listenerVx: number, listenerVy: number, listenerVz: number,
): number {
  const len = Math.hypot(toSourceX, toSourceY, toSourceZ);
  if (len < 1e-4) return 1;
  const nx = toSourceX / len, ny = toSourceY / len, nz = toSourceZ / len;
  // Positive when the listener closes on the source.
  const vl = listenerVx * nx + listenerVy * ny + listenerVz * nz;
  // Positive when the source moves away from the listener.
  const vs = sourceVx * nx + sourceVy * ny + sourceVz * nz;
  const f = (SPEED_OF_SOUND + vl) / Math.max(1, SPEED_OF_SOUND + vs);
  return clamp(f, 0.72, 1.4);
}

/** Convert a frequency multiplier to cents, for AudioParam `detune`. */
export function ratioToCents(ratio: number): number {
  return 1200 * Math.log2(Math.max(1e-6, ratio));
}

/** Which siren mode a given Crisis Star count uses. */
export function sirenModeForStars(stars: number): SirenMode {
  if (stars >= 5) return 'yelp';
  if (stars >= 4) return 'wail';
  return 'twoTone';
}
