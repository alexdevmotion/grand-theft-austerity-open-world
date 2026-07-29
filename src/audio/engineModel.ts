/**
 * ENGINE MODEL — pure, no WebAudio.
 *
 * Turns (speed, throttle, vehicle class) into the full parameter set an
 * oscillator stack needs: gear, RPM, firing fundamental, per-harmonic gains,
 * induction/exhaust noise levels and filter cutoffs.
 *
 * The important design point: the harmonic *tilt* and the noise bands move
 * with load and RPM, so the note changes character, not just pitch. A car at
 * 3000 rpm on full throttle and the same car at 3000 rpm on the overrun
 * produce measurably different spectra (see engine.test.ts).
 */

import { clamp, lerp } from './dsp';

export type EngineClass =
  | 'dacia' | 'sedan' | 'hatch' | 'van' | 'truck' | 'bus' | 'police' | 'tram' | 'scooter';

export interface EngineSpec {
  /** Cylinders. Firing frequency of a 4-stroke = rpm/60 * cylinders/2. */
  cylinders: number;
  /**
   * Audible-order offset. A single-cylinder's true firing rate is subsonic
   * (a scooter at 1400 rpm fires 11.7 times a second), and what the ear
   * actually latches onto is a higher order of that series. Voicing that order
   * as the fundamental is what makes a scooter buzz instead of rumble.
   * 1 for every real multi-cylinder engine.
   */
  firingScale: number;
  idleRpm: number;
  maxRpm: number;
  /** Normalised speed (speed/topSpeed) at the TOP of each gear. */
  gearTops: number[];
  topSpeed: number;
  /** Overall level trim, linear. */
  trim: number;
  /** 0..1 — how rattly/detuned. The Dacia is the reference at 1. */
  rattle: number;
  /** Body resonance centre, Hz — the "boom" of the shell. */
  bodyResonance: number;
  /** Exhaust noise character: lower = deeper, boomier. */
  exhaustCutoff: number;
  /** Diesel-ish clatter amount 0..1 (adds odd/high harmonics + tick noise). */
  clatter: number;
}

export const ENGINE_SPECS: Record<EngineClass, EngineSpec> = {
  // Dacia 1300: 1.3 four, ~5200 rpm redline, boomy shell, rattly everything.
  dacia:   { cylinders: 4, firingScale: 1, idleRpm: 780,  maxRpm: 5200, gearTops: [0.17, 0.36, 0.62, 1.0],       topSpeed: 38, trim: 1.00, rattle: 1.00, bodyResonance: 132, exhaustCutoff: 420, clatter: 0.22 },
  sedan:   { cylinders: 4, firingScale: 1, idleRpm: 800,  maxRpm: 6200, gearTops: [0.15, 0.31, 0.50, 0.74, 1.0], topSpeed: 44, trim: 0.82, rattle: 0.25, bodyResonance: 165, exhaustCutoff: 520, clatter: 0.08 },
  hatch:   { cylinders: 4, firingScale: 1, idleRpm: 820,  maxRpm: 6400, gearTops: [0.16, 0.33, 0.53, 0.77, 1.0], topSpeed: 40, trim: 0.78, rattle: 0.35, bodyResonance: 178, exhaustCutoff: 560, clatter: 0.10 },
  van:     { cylinders: 4, firingScale: 1, idleRpm: 700,  maxRpm: 4400, gearTops: [0.14, 0.30, 0.52, 0.78, 1.0], topSpeed: 35, trim: 0.95, rattle: 0.45, bodyResonance: 108, exhaustCutoff: 340, clatter: 0.62 },
  truck:   { cylinders: 6, firingScale: 1, idleRpm: 600,  maxRpm: 2600, gearTops: [0.10, 0.21, 0.34, 0.50, 0.72, 1.0], topSpeed: 28, trim: 1.15, rattle: 0.40, bodyResonance: 78,  exhaustCutoff: 240, clatter: 0.85 },
  bus:     { cylinders: 6, firingScale: 1, idleRpm: 580,  maxRpm: 2400, gearTops: [0.12, 0.26, 0.44, 0.68, 1.0], topSpeed: 25, trim: 1.10, rattle: 0.35, bodyResonance: 72,  exhaustCutoff: 230, clatter: 0.80 },
  police:  { cylinders: 6, firingScale: 1, idleRpm: 760,  maxRpm: 6600, gearTops: [0.14, 0.29, 0.47, 0.70, 1.0], topSpeed: 50, trim: 0.90, rattle: 0.12, bodyResonance: 190, exhaustCutoff: 640, clatter: 0.05 },
  // Not combustion: an electric traction whine plus wheel-on-rail rumble, so
  // the "firing" series is voiced high up.
  tram:    { cylinders: 2, firingScale: 8, idleRpm: 300,  maxRpm: 2200, gearTops: [1.0],                          topSpeed: 17, trim: 0.85, rattle: 0.20, bodyResonance: 62,  exhaustCutoff: 180, clatter: 0.00 },
  // A 2-stroke single: true firing rate is 12-140 Hz, but the buzz you hear is
  // its 4th order.
  scooter: { cylinders: 1, firingScale: 4, idleRpm: 1400, maxRpm: 8200, gearTops: [0.42, 1.0],                    topSpeed: 8.5, trim: 0.42, rattle: 0.55, bodyResonance: 320, exhaustCutoff: 1100, clatter: 0.02 },
};

export interface EngineInput {
  /** Signed forward speed, m/s. */
  speed: number;
  /** -1..1. */
  throttle: number;
  /** True while the wheels are off the ground — the engine flares. */
  airborne: boolean;
  /** True once the vehicle is scrap: misfires and dies. */
  wrecked: boolean;
  /** Previous gear, for hysteresis. -1 for "no history". */
  prevGear: number;
}

export interface EngineState {
  gear: number;
  gearCount: number;
  rpm: number;
  /** 0..1 within the usable rev range. */
  rpmNorm: number;
  /** Firing frequency, Hz — the fundamental of the oscillator stack. */
  fundamental: number;
  /** Gains for harmonics 1,2,3,4,6,8 (index 0 == fundamental). */
  harmonics: number[];
  /** Detune in cents applied to the second (rattle) oscillator bank. */
  detuneCents: number;
  /** Induction (intake) bandpass centre, Hz, and its level. */
  inductionHz: number;
  inductionLevel: number;
  /** Exhaust noise lowpass cutoff, Hz, and its level. */
  exhaustHz: number;
  exhaustLevel: number;
  /** 0..1 — how much hard-edged waveshaping to apply. Load-dependent grit. */
  drive: number;
  /** 0..1 — overrun burble (throttle lifted at speed). */
  overrun: number;
  /** Overall voice gain before distance attenuation. */
  gain: number;
}

/** Harmonic numbers the stack synthesises. */
export const HARMONIC_ORDERS = [1, 2, 3, 4, 6, 8] as const;

/**
 * Gear selection with hysteresis: a gear is held until normalised speed passes
 * its top, and downshifts only below 88% of the gear below's top. Without the
 * hysteresis the note chatters between two gears at a cruise.
 */
export function selectGear(spec: EngineSpec, speedNorm: number, prevGear: number): number {
  const tops = spec.gearTops;
  let g = 0;
  while (g < tops.length - 1 && speedNorm > tops[g]) g++;
  if (prevGear >= 0 && prevGear < tops.length) {
    // Hold the previous gear if we have not dropped meaningfully below it.
    if (prevGear > g) {
      const downTo = (prevGear >= 1 ? tops[prevGear - 1] : 0) * 0.88;
      if (speedNorm > downTo) g = prevGear;
    }
  }
  return g;
}

export function engineState(spec: EngineSpec, input: EngineInput): EngineState {
  const absSpeed = Math.abs(input.speed);
  const speedNorm = clamp(absSpeed / spec.topSpeed, 0, 1.15);
  const gear = selectGear(spec, speedNorm, input.prevGear);
  const tops = spec.gearTops;
  const lo = gear === 0 ? 0 : tops[gear - 1];
  const hi = tops[gear];
  const within = clamp((speedNorm - lo) / Math.max(1e-4, hi - lo), 0, 1.2);

  const throttle = clamp(input.throttle, -1, 1);
  const load = clamp(throttle, 0, 1);
  const braking = clamp(-throttle, 0, 1);

  // Base rev band inside the gear. First gear starts at idle; higher gears
  // drop back to ~34% of the band on the upshift, which is what makes an
  // upshift audible as a dip rather than a continuous ramp.
  const bandFloor = gear === 0 ? 0 : 0.34;
  let rpmNorm = clamp(bandFloor + (1 - bandFloor) * within, 0, 1.08);

  // Clutch slip: in first gear the engine revs ahead of the wheels until the
  // wheel-derived speed catches up and the clutch locks. Expressed as a max()
  // rather than a threshold so there is no cliff when the car starts rolling.
  if (gear === 0) rpmNorm = Math.max(rpmNorm, load * 0.62);
  if (input.airborne) rpmNorm = Math.max(rpmNorm, 0.55 + load * 0.45);

  // Load pulls a couple of hundred rpm; lifting lets it sag.
  rpmNorm = clamp(rpmNorm + load * 0.06 - braking * 0.03, 0, 1.1);

  const rpm = lerp(spec.idleRpm, spec.maxRpm, rpmNorm);
  // 4-stroke firing frequency, voiced at the audible order.
  const fundamental = (rpm / 60) * (spec.cylinders / 2) * spec.firingScale;

  // ---- harmonic tilt ------------------------------------------------
  //
  // Off load the stack is dominated by the fundamental and 2nd order (a soft
  // hum). Under load the upper orders come up hard — that is the "loading"
  // you hear. RPM also brightens the stack independently of throttle.
  const bright = clamp(load * 0.8 + rpmNorm * 0.32, 0, 1);
  const harmonics: number[] = [];
  for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
    const order = HARMONIC_ORDERS[i];
    // Base rolloff ~1/order^1.55 when unloaded, flattening to ~1/order^0.42
    // at full load. A flatter rolloff == a harsher, more "open" engine.
    const expo = lerp(1.55, 0.42, bright);
    let g = Math.pow(order, -expo);
    // Even orders dominate a four; a six emphasises the 3rd. Clatter (diesel)
    // pushes the odd orders up and adds an audible tick.
    if (spec.cylinders === 4 && (order === 2 || order === 4)) g *= 1.18;
    if (spec.cylinders === 6 && (order === 3 || order === 6)) g *= 1.22;
    if (order % 2 === 1) g *= lerp(1, 1.45, spec.clatter);
    harmonics.push(g);
  }
  // Overrun: lift at speed. Fundamental collapses, mid orders burble.
  const overrun = clamp((1 - load) * clamp((speedNorm - 0.12) * 3.4, 0, 1), 0, 1);
  if (overrun > 0) {
    harmonics[0] *= lerp(1, 0.42, overrun);
    harmonics[1] *= lerp(1, 0.62, overrun);
    harmonics[2] *= lerp(1, 1.25, overrun);
    harmonics[3] *= lerp(1, 1.35, overrun);
  }
  // A wreck misfires: drop the whole stack and detune hard.
  const wreckMul = input.wrecked ? 0.35 : 1;
  for (let i = 0; i < harmonics.length; i++) harmonics[i] *= wreckMul;

  // ---- noise beds ---------------------------------------------------
  const inductionHz = lerp(420, 2100, rpmNorm) * lerp(0.85, 1.15, load);
  const inductionLevel = clamp(0.06 + load * 0.34 * (0.35 + rpmNorm * 0.9), 0, 0.55);
  const exhaustHz = spec.exhaustCutoff * lerp(0.75, 2.6, rpmNorm);
  const exhaustLevel = clamp(
    0.09 + load * 0.30 + overrun * 0.26 + spec.clatter * 0.18 * rpmNorm,
    0,
    0.7,
  );

  const drive = clamp(load * 0.7 + rpmNorm * 0.45 + (input.wrecked ? 0.4 : 0), 0, 1);
  const detuneCents = spec.rattle * lerp(4, 22, 1 - rpmNorm) * (input.wrecked ? 2.4 : 1);

  // Total loudness rises with both revs and load, but never to zero at idle.
  const gain = spec.trim * clamp(0.24 + rpmNorm * 0.5 + load * 0.34, 0, 1.25);

  return {
    gear,
    gearCount: tops.length,
    rpm,
    rpmNorm,
    fundamental,
    harmonics,
    detuneCents,
    inductionHz,
    inductionLevel,
    exhaustHz,
    exhaustLevel,
    drive,
    overrun,
    gain,
  };
}

/* ------------------------------------------------------------------ */
/* Tyres                                                               */
/* ------------------------------------------------------------------ */

export interface TyreInput {
  speed: number;
  /** 0..1 road wetness (WeatherService.wetness). */
  wetness: number;
  /** Peak |lateral slip| across the wheels, m/s. */
  slip: number;
  handbrake: boolean;
  /** 0..1 fraction of wheels touching the ground. */
  grounded: number;
}

export interface TyreState {
  /** Broadband roll noise level. */
  rollLevel: number;
  /** Roll noise bandpass centre, Hz — rises with speed. */
  rollHz: number;
  /** Wet spray level and its (much higher) band. */
  sprayLevel: number;
  /** Squeal level and pitch. */
  squealLevel: number;
  squealHz: number;
}

export function tyreState(t: TyreInput): TyreState {
  const v = Math.abs(t.speed);
  const vn = Math.min(1, v / 34);
  const rollLevel = t.grounded * Math.min(0.55, Math.pow(vn, 0.8) * 0.5) * (1 + t.wetness * 0.55);
  const rollHz = 260 + vn * 900 + t.wetness * 420;
  const sprayLevel = t.wetness * t.grounded * Math.min(0.5, Math.pow(vn, 1.15) * 0.62);
  // Squeal only above a slip threshold, and it dies below walking pace.
  const slipN = Math.max(0, t.slip - 1.15) / 3.2;
  const speedGate = Math.min(1, Math.max(0, (v - 2.2) / 5));
  const hb = t.handbrake && v > 3 ? 0.55 : 0;
  const squealLevel = Math.min(0.85, (slipN + hb) * speedGate * t.grounded * (1 - t.wetness * 0.35));
  const squealHz = 780 + Math.min(1, slipN) * 620 + vn * 260;
  return { rollLevel, rollHz, sprayLevel, squealLevel, squealHz };
}
