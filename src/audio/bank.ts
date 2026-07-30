/**
 * THE SFX BANK — every one-shot in the game, synthesised from nothing.
 *
 * There are no sound-effect samples in this project. Each renderer below
 * produces a Float32Array with pure DSP (src/audio/dsp.ts), deterministically
 * from an `Rng`, and the result is wrapped once into an `AudioBuffer`. A
 * one-shot at play time is therefore a single `AudioBufferSourceNode` into a
 * pooled panner chain — no per-shot graph building, no allocation storm.
 *
 * Because the renderers are pure they also run under `bun test`, which is how
 * the envelope times and spectra below are actually verified.
 */

import { Rng } from '../core/rng';
import {
  additive, applyEnvelope, biquad, brownNoise, clamp, envelopeAt, mixInto,
  normalise, onePoleLowpass, pinkNoise, sweep, whiteNoise,
} from './dsp';

export type SfxId =
  // vehicle impacts
  | 'impact_light' | 'impact_medium' | 'impact_heavy' | 'impact_glass'
  | 'scrape' | 'suspension_knock' | 'tyre_burst' | 'explosion'
  // props
  | 'prop_wood' | 'prop_metal' | 'prop_plastic' | 'prop_glass' | 'prop_broken'
  // characters
  | 'footstep' | 'footstep_wet' | 'footstep_gravel' | 'footstep_grass' | 'footstep_metal'
  | 'ped_yell' | 'ped_hit' | 'punch' | 'body_fall'
  // doors & interaction
  | 'door_open' | 'door_close' | 'car_door' | 'pickup' | 'interact'
  // vehicle incidental
  | 'horn' | 'horn_low' | 'dacia_cough' | 'spikes'
  // vehicle foley — the mechanical untidiness of a car held together with wire
  | 'gear_clunk' | 'handbrake' | 'body_rattle' | 'brake_squeal' | 'kerb_thump'
  | 'engine_stall' | 'exhaust_pop' | 'stone_ping'
  // people — the half-second noises a crowd is actually made of
  | 'ped_mutter' | 'ped_cough' | 'ped_laugh' | 'ped_whistle'
  // world
  | 'thunder' | 'tram_bell' | 'tram_screech' | 'crowd_gasp' | 'bird'
  | 'crowd_shout' | 'crowd_scream' | 'pigeon_flutter' | 'cloth_rustle'
  | 'construction_hammer' | 'dog_bark' | 'shop_bell' | 'church_bell'
  // ui / mission stings
  | 'star_up' | 'star_down' | 'mission_start' | 'mission_complete' | 'mission_failed'
  | 'activity_start' | 'activity_win' | 'radio_click' | 'radio_static';

export const SFX_IDS: SfxId[] = [
  'impact_light', 'impact_medium', 'impact_heavy', 'impact_glass',
  'scrape', 'suspension_knock', 'tyre_burst', 'explosion',
  'prop_wood', 'prop_metal', 'prop_plastic', 'prop_glass', 'prop_broken',
  'footstep', 'footstep_wet', 'footstep_gravel', 'footstep_grass', 'footstep_metal',
  'ped_yell', 'ped_hit', 'punch', 'body_fall',
  'door_open', 'door_close', 'car_door', 'pickup', 'interact',
  'horn', 'horn_low', 'dacia_cough', 'spikes',
  'gear_clunk', 'handbrake', 'body_rattle', 'brake_squeal', 'kerb_thump',
  'engine_stall', 'exhaust_pop', 'stone_ping',
  'ped_mutter', 'ped_cough', 'ped_laugh', 'ped_whistle',
  'thunder', 'tram_bell', 'tram_screech', 'crowd_gasp', 'bird',
  'crowd_shout', 'crowd_scream', 'pigeon_flutter', 'cloth_rustle',
  'construction_hammer', 'dog_bark', 'shop_bell', 'church_bell',
  'star_up', 'star_down', 'mission_start', 'mission_complete', 'mission_failed',
  'activity_start', 'activity_win', 'radio_click', 'radio_static',
];

/** How many pre-rendered variants each id gets, so repeats do not machine-gun. */
const VARIANTS: Partial<Record<SfxId, number>> = {
  impact_light: 3, impact_medium: 3, impact_heavy: 3, impact_glass: 3,
  footstep: 5, footstep_wet: 4, footstep_gravel: 4, footstep_grass: 3, footstep_metal: 3,
  prop_wood: 2, prop_metal: 2, prop_plastic: 2, prop_glass: 2,
  ped_yell: 3, ped_hit: 2, punch: 3, suspension_knock: 3, bird: 3,
  horn: 2, crowd_gasp: 2,
  gear_clunk: 3, body_rattle: 4, kerb_thump: 3, brake_squeal: 2,
  crowd_shout: 3, crowd_scream: 2, cloth_rustle: 4, construction_hammer: 2,
  dog_bark: 2, tram_screech: 2, pigeon_flutter: 2,
  // A pop that repeats identically reads as a sample, not as an engine, and
  // these fire in bursts of three or four.
  exhaust_pop: 5, stone_ping: 3,
  // People: the whole point of these is that no two are the same voice.
  ped_mutter: 5, ped_cough: 4, ped_laugh: 4, ped_whistle: 3,
};

/* ------------------------------------------------------------------ */
/* Renderers                                                           */
/* ------------------------------------------------------------------ */

function buf(sr: number, seconds: number): Float32Array {
  return new Float32Array(Math.max(1, Math.round(sr * seconds)));
}

/** Exponentially decaying noise burst through a bandpass. */
function noiseBurst(
  sr: number, rng: Rng, seconds: number, centreHz: number, q: number, tau: number, colour: 'white' | 'pink' | 'brown' = 'white',
): Float32Array {
  const b = buf(sr, seconds);
  if (colour === 'pink') pinkNoise(b, rng);
  else if (colour === 'brown') brownNoise(b, rng);
  else whiteNoise(b, rng);
  biquad(b, 'bandpass', centreHz, q, sr);
  for (let i = 0; i < b.length; i++) b[i] *= Math.exp(-(i / sr) / tau);
  return b;
}

/**
 * Inharmonic modal ring — the sound of struck metal / glass / wood.
 *
 * Every partial is an exponentially decaying sinusoid, and the obvious way to
 * write that is `sin(w*i) * exp(-t/tau)` per sample. That is also how this
 * started, and it made the bank the most expensive thing in the whole boot
 * sequence: `tram_bell` alone took 683 ms, because a 3-second bell with seven
 * partials is two million transcendental calls.
 *
 * A decaying sinusoid is the impulse response of a two-pole resonator, so it
 * satisfies an exact recurrence:
 *
 *     s[n] = 2·r·cos(w)·s[n-1] − r²·s[n-2],   s[0] = 0,  s[1] = r·sin(w)
 *
 * with r = exp(−1/(tau·sr)). Two multiplies and an add per sample, no `sin`, no
 * `exp`, and — because it is the closed form rather than an approximation of it
 * — sample-for-sample identical output. Since r < 1 the recurrence is strictly
 * decaying and cannot drift.
 */
function modes(
  sr: number, seconds: number, freqs: number[], taus: number[], amps: number[],
): Float32Array {
  const b = buf(sr, seconds);
  const n = b.length;
  for (let m = 0; m < freqs.length; m++) {
    const w = (2 * Math.PI * freqs[m]) / sr;
    const r = Math.exp(-1 / (taus[m] * sr));
    const a = amps[m];
    const c1 = 2 * r * Math.cos(w);
    const c2 = r * r;
    let s2 = 0;               // s[n-2]
    let s1 = r * Math.sin(w); // s[n-1]
    // s[0] is zero, so the loop starts at 1.
    for (let i = 1; i < n; i++) {
      b[i] += s1 * a;
      const s0 = c1 * s1 - c2 * s2;
      s2 = s1;
      s1 = s0;
    }
  }
  return b;
}

/* ---- vehicle impacts ---- */

function renderImpact(sr: number, rng: Rng, severity: number): Float32Array {
  // severity 0 = kerb tap, 1 = write-off.
  const dur = 0.35 + severity * 0.9;
  const out = buf(sr, dur);

  // 1. body boom — the mass of the car moving.
  const boom = buf(sr, 0.28 + severity * 0.22);
  sweep(boom, sr, 130 - severity * 40, 38, 1, true);
  applyEnvelope(boom, sr, { attack: 0.001, decay: 0.05 + severity * 0.06, sustain: 0, duration: boom.length / sr, release: 0.05 });
  mixInto(out, boom, 0, 0.55 + severity * 0.35);

  // 2. panel crunch — inharmonic sheet-metal modes, detuned per variant.
  const d = 1 + rng.range(-0.06, 0.06);
  const ring = modes(
    sr, 0.3 + severity * 0.3,
    [214 * d, 337 * d, 519 * d, 812 * d, 1223 * d, 1907 * d],
    [0.09, 0.07, 0.055, 0.04, 0.028, 0.018],
    [0.5, 0.42, 0.34, 0.26, 0.2, 0.13],
  );
  mixInto(out, ring, Math.round(sr * 0.002), 0.5 + severity * 0.3);

  // 3. the crunch itself — noise chopped by a fast random gate, which is what
  //    makes it read as "tearing metal" rather than "white noise burst".
  const cr = buf(sr, 0.16 + severity * 0.24);
  whiteNoise(cr, rng);
  biquad(cr, 'bandpass', 900 + severity * 700, 0.7, sr);
  let gate = 1;
  for (let i = 0; i < cr.length; i++) {
    if (i % Math.round(sr * 0.004) === 0) gate = 0.25 + rng.next() * 0.75;
    cr[i] *= gate * Math.exp(-(i / sr) / (0.035 + severity * 0.05));
  }
  mixInto(out, cr, 0, 0.6 + severity * 0.3);

  // 4. debris tail — sparse grains.
  const grains = Math.round(6 + severity * 26);
  for (let g = 0; g < grains; g++) {
    const at = Math.round(sr * rng.range(0.05, dur * 0.85));
    const gr = noiseBurst(sr, rng, 0.05, rng.range(1400, 5200), 5, 0.008);
    mixInto(out, gr, at, rng.range(0.05, 0.22) * (0.4 + severity));
  }

  return normalise(out, 0.9);
}

function renderGlass(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.85);
  // The initial shatter: dense high modes.
  const n = 26;
  for (let i = 0; i < n; i++) {
    const f = rng.range(2200, 8200);
    const tau = rng.range(0.012, 0.06);
    const m = modes(sr, 0.2, [f], [tau], [1]);
    mixInto(out, m, Math.round(sr * rng.range(0, 0.02)), rng.range(0.06, 0.2));
  }
  const burst = noiseBurst(sr, rng, 0.14, 4200, 0.8, 0.028);
  mixInto(out, burst, 0, 0.7);
  // Fragments hitting the road for the next half second.
  for (let i = 0; i < 34; i++) {
    const at = Math.round(sr * rng.range(0.04, 0.72));
    const tick = modes(sr, 0.07, [rng.range(3000, 9000), rng.range(1600, 4200)], [0.01, 0.008], [1, 0.5]);
    mixInto(out, tick, at, rng.range(0.03, 0.16));
  }
  return normalise(out, 0.85);
}

function renderScrape(sr: number, rng: Rng): Float32Array {
  // 1.2 s, designed to be looped while a car grinds along a wall.
  const out = buf(sr, 1.2);
  whiteNoise(out, rng);
  biquad(out, 'bandpass', 1700, 1.2, sr);
  biquad(out, 'peaking', 3400, 3, sr, 8);
  // Roughness: amplitude modulated by a fast irregular contour.
  let amp = 0.6;
  for (let i = 0; i < out.length; i++) {
    if (i % 64 === 0) amp += (rng.next() - 0.5) * 0.35;
    amp = clamp(amp, 0.15, 1);
    out[i] *= amp;
  }
  // Crossfade the ends so the loop does not click.
  const xf = Math.round(sr * 0.05);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    out[i] *= t;
    out[out.length - 1 - i] *= t;
  }
  return normalise(out, 0.7);
}

function renderSuspensionKnock(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.22);
  const thud = buf(sr, 0.12);
  sweep(thud, sr, 95, 42, 1, true);
  applyEnvelope(thud, sr, { attack: 0.0008, decay: 0.018, sustain: 0, duration: 0.12, release: 0.03 });
  mixInto(out, thud, 0, 0.9);
  const d = 1 + rng.range(-0.08, 0.08);
  mixInto(out, modes(sr, 0.16, [310 * d, 640 * d, 1180 * d], [0.02, 0.014, 0.009], [0.35, 0.22, 0.14]), 0, 0.8);
  mixInto(out, noiseBurst(sr, rng, 0.05, 2300, 2, 0.007), 0, 0.35);
  return normalise(out, 0.75);
}

function renderTyreBurst(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.1);
  const bang = noiseBurst(sr, rng, 0.14, 700, 0.6, 0.02);
  mixInto(out, bang, 0, 1);
  const thump = buf(sr, 0.2);
  sweep(thump, sr, 160, 45, 1, true);
  applyEnvelope(thump, sr, { attack: 0.001, decay: 0.03, sustain: 0, duration: 0.2, release: 0.05 });
  mixInto(out, thump, 0, 0.8);
  // Escaping air.
  const hiss = buf(sr, 0.95);
  whiteNoise(hiss, rng);
  biquad(hiss, 'highpass', 2600, 0.7, sr);
  for (let i = 0; i < hiss.length; i++) hiss[i] *= Math.exp(-(i / sr) / 0.32);
  mixInto(out, hiss, Math.round(sr * 0.02), 0.5);
  return normalise(out, 0.85);
}

function renderExplosion(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 2.4);
  const boom = buf(sr, 1.4);
  sweep(boom, sr, 110, 24, 1, true);
  applyEnvelope(boom, sr, { attack: 0.004, decay: 0.22, sustain: 0, duration: 1.4, release: 0.6 });
  mixInto(out, boom, 0, 1);
  const blast = buf(sr, 1.8);
  whiteNoise(blast, rng);
  biquad(blast, 'lowpass', 1800, 0.7, sr);
  for (let i = 0; i < blast.length; i++) blast[i] *= Math.exp(-(i / sr) / 0.34);
  mixInto(out, blast, 0, 0.85);
  // Crackle tail.
  for (let i = 0; i < 60; i++) {
    const at = Math.round(sr * rng.range(0.08, 2.0));
    mixInto(out, noiseBurst(sr, rng, 0.06, rng.range(900, 4800), 4, 0.01), at, rng.range(0.04, 0.2));
  }
  return normalise(out, 0.95);
}

/* ---- props ---- */

function renderPropWood(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.6);
  const d = 1 + rng.range(-0.1, 0.1);
  mixInto(out, modes(sr, 0.35, [180 * d, 420 * d, 690 * d, 1130 * d], [0.05, 0.035, 0.022, 0.014], [0.6, 0.45, 0.3, 0.2]), 0, 1);
  mixInto(out, noiseBurst(sr, rng, 0.1, 1500, 1, 0.012), 0, 0.7);
  for (let i = 0; i < 12; i++) {
    mixInto(out, noiseBurst(sr, rng, 0.05, rng.range(700, 3000), 6, 0.008), Math.round(sr * rng.range(0.03, 0.45)), rng.range(0.05, 0.2));
  }
  return normalise(out, 0.8);
}

function renderPropMetal(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.6);
  const d = 1 + rng.range(-0.05, 0.05);
  mixInto(out, modes(
    sr, 1.5,
    [148 * d, 393 * d, 712 * d, 1104 * d, 1683 * d, 2410 * d],
    [0.55, 0.42, 0.3, 0.22, 0.15, 0.1],
    [0.42, 0.5, 0.34, 0.26, 0.18, 0.12],
  ), 0, 1);
  mixInto(out, noiseBurst(sr, rng, 0.08, 2600, 1.4, 0.01), 0, 0.55);
  return normalise(out, 0.8);
}

function renderPropPlastic(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.5);
  const d = 1 + rng.range(-0.12, 0.12);
  mixInto(out, modes(sr, 0.28, [340 * d, 780 * d, 1290 * d], [0.03, 0.02, 0.012], [0.5, 0.4, 0.25]), 0, 1);
  mixInto(out, noiseBurst(sr, rng, 0.09, 2100, 0.9, 0.02), 0, 0.75);
  for (let i = 0; i < 8; i++) {
    mixInto(out, noiseBurst(sr, rng, 0.04, rng.range(900, 2600), 5, 0.006), Math.round(sr * rng.range(0.04, 0.36)), rng.range(0.05, 0.22));
  }
  return normalise(out, 0.75);
}

/* ---- characters ---- */

function renderFootstep(sr: number, rng: Rng, surface: 'concrete' | 'wet' | 'gravel' | 'grass' | 'metal'): Float32Array {
  const out = buf(sr, surface === 'wet' ? 0.24 : 0.16);
  // Heel transient.
  const heel = buf(sr, 0.05);
  whiteNoise(heel, rng);
  const heelHz = surface === 'metal' ? 2400 : surface === 'grass' ? 900 : 1500;
  biquad(heel, 'bandpass', heelHz * rng.range(0.9, 1.1), 1.1, sr);
  for (let i = 0; i < heel.length; i++) heel[i] *= Math.exp(-(i / sr) / 0.006);
  mixInto(out, heel, 0, surface === 'grass' ? 0.35 : 0.8);

  // Body thump: low energy the boot puts into the ground.
  const thump = buf(sr, 0.09);
  sweep(thump, sr, surface === 'metal' ? 210 : 140, 55, 1, true);
  applyEnvelope(thump, sr, { attack: 0.0006, decay: 0.012, sustain: 0, duration: 0.09, release: 0.03 });
  mixInto(out, thump, 0, surface === 'grass' ? 0.25 : 0.55);

  if (surface === 'metal') {
    mixInto(out, modes(sr, 0.14, [620, 1340, 2210], [0.05, 0.035, 0.02], [0.3, 0.22, 0.14]), 0, 0.7);
  }
  if (surface === 'gravel') {
    for (let i = 0; i < 10; i++) {
      mixInto(out, noiseBurst(sr, rng, 0.03, rng.range(1800, 6000), 6, 0.004), Math.round(sr * rng.range(0, 0.07)), rng.range(0.08, 0.3));
    }
  }
  if (surface === 'grass') {
    const rustle = buf(sr, 0.13);
    whiteNoise(rustle, rng);
    biquad(rustle, 'highpass', 2600, 0.7, sr);
    for (let i = 0; i < rustle.length; i++) rustle[i] *= Math.exp(-(i / sr) / 0.035);
    mixInto(out, rustle, 0, 0.5);
  }
  if (surface === 'wet') {
    // Splash: a bright, slightly longer tail with a downward pitched fizz.
    const splash = buf(sr, 0.2);
    whiteNoise(splash, rng);
    biquad(splash, 'highpass', 1600, 0.7, sr);
    biquad(splash, 'peaking', 3800, 2, sr, 6);
    for (let i = 0; i < splash.length; i++) splash[i] *= Math.exp(-(i / sr) / 0.045);
    mixInto(out, splash, Math.round(sr * 0.004), 0.75);
  }
  return normalise(out, 0.6);
}

/**
 * A vocal blip: glottal pulse train through three formants. Not words —
 * just enough vowel colour that a shout reads as a person, not a noise.
 */
function renderVocal(
  sr: number, rng: Rng, seconds: number, f0: number, bend: number,
  formants: [number, number, number], amp = 1,
): Float32Array {
  const out = buf(sr, seconds);
  const n = out.length;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = f0 * (1 + bend * t);
    phase += f / sr;
    if (phase >= 1) phase -= 1;
    // Rosenberg-ish glottal pulse.
    const p = phase < 0.4 ? 0.5 - 0.5 * Math.cos((Math.PI * phase) / 0.4)
      : phase < 0.56 ? Math.cos((Math.PI * (phase - 0.4)) / 0.32) : 0;
    out[i] = p * 2 - 0.4;
  }
  // Breath.
  const br = buf(sr, seconds);
  whiteNoise(br, rng);
  biquad(br, 'highpass', 2200, 0.7, sr);
  mixInto(out, br, 0, 0.08);

  const shaped = new Float32Array(n);
  for (let k = 0; k < 3; k++) {
    const band = out.slice();
    biquad(band, 'bandpass', formants[k], 7 - k * 1.5, sr);
    mixInto(shaped, band, 0, [1, 0.55, 0.3][k]);
  }
  applyEnvelope(shaped, sr, { attack: 0.02, decay: 0.12, sustain: 0.6, duration: seconds, release: seconds * 0.35 });
  return normalise(shaped, amp * 0.8);
}

function renderPunch(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.28);
  const thud = buf(sr, 0.14);
  sweep(thud, sr, 190, 58, 1, true);
  applyEnvelope(thud, sr, { attack: 0.001, decay: 0.02, sustain: 0, duration: 0.14, release: 0.04 });
  mixInto(out, thud, 0, 1);
  mixInto(out, noiseBurst(sr, rng, 0.08, 1200, 0.8, 0.012), 0, 0.55);
  return normalise(out, 0.75);
}

/* ---- doors & interaction ---- */

function renderDoor(sr: number, rng: Rng, closing: boolean, car: boolean): Float32Array {
  const out = buf(sr, closing ? 0.55 : 0.75);
  // Handle / latch click.
  mixInto(out, noiseBurst(sr, rng, 0.04, 3000, 3, 0.005), 0, 0.5);
  if (closing) {
    const thud = buf(sr, 0.3);
    sweep(thud, sr, car ? 150 : 110, car ? 52 : 40, 1, true);
    applyEnvelope(thud, sr, { attack: 0.001, decay: 0.035, sustain: 0, duration: 0.3, release: 0.1 });
    mixInto(out, thud, Math.round(sr * 0.02), 1);
    if (car) mixInto(out, modes(sr, 0.35, [230, 470, 910], [0.06, 0.04, 0.025], [0.3, 0.2, 0.12]), Math.round(sr * 0.02), 0.7);
  } else {
    // Hinge creak: bandpassed noise with a rising resonance.
    const creak = buf(sr, 0.6);
    whiteNoise(creak, rng);
    biquad(creak, 'bandpass', car ? 1300 : 900, 8, sr);
    let amp = 0;
    for (let i = 0; i < creak.length; i++) {
      const t = i / creak.length;
      if (i % 512 === 0) amp = 0.3 + rng.next() * 0.7;
      creak[i] *= amp * Math.sin(Math.PI * t);
    }
    mixInto(out, creak, Math.round(sr * 0.04), 0.6);
  }
  return normalise(out, 0.65);
}

/* ---- vehicle incidental ---- */

function renderHorn(sr: number, rng: Rng, low: boolean): Float32Array {
  const seconds = 0.55;
  const out = buf(sr, seconds);
  const f = low ? 285 : 400 * (1 + rng.range(-0.02, 0.02));
  // A car horn is two slightly detuned reeds rich in harmonics.
  const partials: [number, number][] = [];
  for (let h = 1; h <= 9; h++) {
    partials.push([f * h, 0.55 / Math.pow(h, 0.85)]);
    partials.push([f * 1.26 * h, 0.4 / Math.pow(h, 0.9)]);
  }
  additive(out, sr, partials);
  biquad(out, 'lowpass', 4200, 0.8, sr);
  biquad(out, 'peaking', 1900, 2, sr, 7);
  applyEnvelope(out, sr, { attack: 0.012, decay: 0.05, sustain: 0.92, duration: seconds, release: 0.05 });
  return normalise(out, 0.7);
}

/**
 * AN EXHAUST POP — unburnt fuel going off in a hot pipe on the overrun.
 *
 * Three ingredients, and getting the balance right is the difference between a
 * bang and a click:
 *  1. a very fast pressure step — a few milliseconds of low-frequency thump,
 *     which is the actual explosion;
 *  2. the pipe ringing at its own length (a Dacia's silencer is a metre of thin
 *     steel, so ~180 Hz with a short tail);
 *  3. a spit of broadband noise on top, which is what makes it read as coming
 *     out of a hole rather than from inside a box.
 */
function renderExhaustPop(sr: number, rng: Rng): Float32Array {
  const seconds = 0.26;
  const out = buf(sr, seconds);

  // 1. the bang.
  const thump = buf(sr, 0.09);
  sweep(thump, sr, rng.range(230, 340), 62, 1, true);
  applyEnvelope(thump, sr, {
    attack: 0.0008, decay: 0.012, sustain: 0, duration: 0.09, release: 0.03,
  });
  mixInto(out, thump, 0, 0.9);

  // 2. the pipe.
  const d = 1 + rng.range(-0.1, 0.1);
  mixInto(
    out,
    modes(sr, 0.2, [178 * d, 372 * d, 611 * d], [0.045, 0.03, 0.018], [0.5, 0.28, 0.15]),
    Math.round(sr * 0.003),
    0.55,
  );

  // 3. the spit.
  mixInto(out, noiseBurst(sr, rng, 0.06, rng.range(1400, 2600), 0.7, 0.009), 0, 0.5);
  return normalise(out, 0.72);
}

/** A chipping flicked up into a wheel arch. One millisecond of steel. */
function renderStonePing(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.13);
  const f = rng.range(1700, 3400);
  mixInto(
    out,
    modes(sr, 0.12, [f, f * 2.41, f * 3.87], [0.014, 0.009, 0.006], [0.6, 0.3, 0.16]),
    0,
    1,
  );
  mixInto(out, noiseBurst(sr, rng, 0.02, 4200, 1.2, 0.003), 0, 0.45);
  return normalise(out, 0.5);
}

/* ---- people ---- */

/**
 * The half-second noises a pavement is actually made of. Nobody in this game
 * says words to the player at close range — the *Ce Ne Enervează* clips do the
 * talking — but a crowd that only makes footsteps is a crowd of mannequins.
 *
 * All four are the same glottal-plus-formant machinery as `renderVocal`,
 * differing in pitch contour and formant set, because that is genuinely what
 * separates a laugh from a cough in a human throat.
 */
function renderPedVocal(
  sr: number, rng: Rng, kind: 'mutter' | 'cough' | 'laugh' | 'whistle',
): Float32Array {
  // Half the population is pitched an octave down. The formants move with it,
  // otherwise a low voice sounds like a tall man's helium impression.
  const male = rng.bool(0.5);
  const f0 = male ? rng.range(88, 135) : rng.range(165, 235);
  const fScale = male ? 0.86 : 1.14;

  if (kind === 'whistle') {
    // Two notes of a wolf whistle, or a bored one-note summons. Almost pure
    // tone with a breath of noise, and a wide interval — that is the whole
    // gesture.
    const seconds = rng.range(0.4, 0.75);
    const out = buf(sr, seconds);
    const up = rng.bool(0.6);
    const base = rng.range(1150, 1900);
    let ph = 0;
    for (let i = 0; i < out.length; i++) {
      const t = i / out.length;
      // A whistle bends, holds, then falls away — a straight ramp sounds like a
      // synthesiser sweep and nothing like a mouth.
      const bend = up
        ? Math.pow(t, 0.55) * 0.62
        : t < 0.45 ? t * 0.9 : 0.4 - (t - 0.45) * 0.75;
      const f = base * (1 + bend);
      ph += (2 * Math.PI * f) / sr;
      out[i] = Math.sin(ph) * 0.8 + Math.sin(ph * 2) * 0.06;
      out[i] += (rng.next() * 2 - 1) * 0.03;
    }
    applyEnvelope(out, sr, {
      attack: 0.03, decay: 0.2, sustain: 0.85, duration: seconds, release: seconds * 0.3,
    });
    return normalise(out, 0.5);
  }

  if (kind === 'cough') {
    // A cough is a plosive: glottis slams shut, pressure builds, it lets go.
    const seconds = rng.range(0.22, 0.36);
    const out = buf(sr, seconds);
    const body = renderVocal(
      sr, rng, seconds * 0.75, f0 * 1.25, -0.5,
      [520 * fScale, 1180 * fScale, 2500 * fScale], 1,
    );
    // A hard front edge — that is the bark.
    for (let i = 0; i < body.length; i++) {
      body[i] *= Math.exp(-(i / sr) / 0.055);
    }
    mixInto(out, body, 0, 1);
    mixInto(out, noiseBurst(sr, rng, 0.09, rng.range(900, 1700), 0.6, 0.02), 0, 0.55);
    // The rasp on the tail.
    mixInto(out, noiseBurst(sr, rng, 0.12, 2600, 0.5, 0.05), Math.round(sr * 0.07), 0.16);
    return normalise(out, 0.62);
  }

  if (kind === 'laugh') {
    // Three to five glottal pulses on a falling pitch. The falling pitch is the
    // tell: a laugh that does not descend sounds like an alarm.
    const bursts = rng.int(3, 6);
    const seconds = 0.16 * bursts + 0.2;
    const out = buf(sr, seconds);
    for (let b = 0; b < bursts; b++) {
      const at = Math.round(sr * (0.03 + b * rng.range(0.13, 0.19)));
      const len = rng.range(0.07, 0.12);
      const blob = renderVocal(
        sr, rng, len, f0 * (1.35 - b * 0.09), -0.25,
        [700 * fScale, 1150 * fScale, 2700 * fScale], 1,
      );
      mixInto(out, blob, at, (1 - b * 0.13) * rng.range(0.7, 1));
    }
    return normalise(out, 0.6);
  }

  // Mutter: two or three unstressed syllables, low and going nowhere. This is
  // the "cine mai e ăsta" under the breath that a Bucharest pavement runs on.
  const syllables = rng.int(2, 4);
  const seconds = 0.19 * syllables + 0.12;
  const out = buf(sr, seconds);
  for (let s = 0; s < syllables; s++) {
    const at = Math.round(sr * (0.02 + s * rng.range(0.15, 0.22)));
    const blob = renderVocal(
      sr, rng, rng.range(0.1, 0.17), f0 * rng.range(0.9, 1.08), rng.range(-0.18, 0.1),
      [rng.range(430, 700) * fScale, rng.range(1000, 1450) * fScale, rng.range(2200, 2800) * fScale],
      1,
    );
    mixInto(out, blob, at, rng.range(0.55, 1));
  }
  // Mumbling is mumbling because the top is missing.
  biquad(out, 'lowpass', 2200, 0.7, sr);
  return normalise(out, 0.4);
}

/**
 * A church bell across the rooftops. Bucharest is full of them and they are the
 * one sound in the whole ambience that is unmistakably NOT traffic.
 *
 * A real bell is aggressively inharmonic — hum, prime, tierce (a minor third
 * above, which is why bells sound melancholy), quint and nominal — and the
 * partials decay at wildly different rates, the hum outlasting everything.
 */
function renderChurchBell(sr: number, rng: Rng): Float32Array {
  const seconds = 4.2;
  const f = 262 * rng.range(0.94, 1.06);
  const out = modes(
    sr, seconds,
    // hum (f/2), prime (f), tierce (1.19f — the minor third), quint, nominal, and two upper partials
    [f * 0.5, f, f * 1.19, f * 1.5, f * 2, f * 2.5, f * 3.36],
    [3.4, 1.9, 1.3, 0.85, 0.55, 0.3, 0.16],
    [0.5, 0.62, 0.4, 0.26, 0.3, 0.16, 0.1],
  );
  // The strike: a millisecond of the clapper on the bronze.
  mixInto(out, noiseBurst(sr, rng, 0.05, 3200, 0.8, 0.006), 0, 0.28);
  // Beating — no two sides of a cast bell are the same thickness, so every
  // partial is really a pair a fraction of a hertz apart.
  for (let i = 0; i < out.length; i++) {
    out[i] *= 0.88 + 0.12 * Math.sin((2 * Math.PI * 0.7 * i) / sr);
  }
  return normalise(out, 0.68);
}

/**
 * THE DACIA COUGH. docs/STORY.md: "It coughs on first start and the radio
 * comes on with it." Starter motor whine, two failed catches, then it fires.
 */
function renderDaciaCough(sr: number, rng: Rng): Float32Array {
  const seconds = 2.05;
  const out = buf(sr, seconds);

  // Starter motor: a ~13 Hz chug of a 220 Hz whine plus gear noise.
  const starterLen = Math.round(sr * 1.35);
  for (let i = 0; i < starterLen; i++) {
    const t = i / sr;
    const chug = 0.55 + 0.45 * Math.sin(2 * Math.PI * 12.5 * t);
    out[i] += Math.sin(2 * Math.PI * 218 * t) * 0.22 * chug;
    out[i] += Math.sin(2 * Math.PI * 436 * t) * 0.08 * chug;
    out[i] += (rng.next() * 2 - 1) * 0.10 * chug;
  }
  const grind = out.subarray(0, starterLen) as unknown as Float32Array;
  biquad(grind, 'bandpass', 620, 0.9, sr);

  // Two failed catches: the engine almost fires and dies.
  for (const [at, level] of [[0.42, 0.55], [0.88, 0.75]] as const) {
    const catchLen = Math.round(sr * 0.3);
    const c = new Float32Array(catchLen);
    let ph = 0;
    for (let i = 0; i < catchLen; i++) {
      const t = i / sr;
      // Fires up to ~1500 rpm then dies back.
      const rpm = 1500 * Math.sin(Math.PI * (i / catchLen)) + 300;
      const f = (rpm / 60) * 2;
      ph += (2 * Math.PI * f) / sr;
      c[i] = (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph)) * 0.4;
      c[i] += (rng.next() * 2 - 1) * 0.12;
      c[i] *= Math.sin(Math.PI * (i / catchLen));
      void t;
    }
    biquad(c, 'lowpass', 900, 0.8, sr);
    mixInto(out, c, Math.round(sr * at), level);
  }

  // The catch: rev flare up to ~2600 rpm, settling toward idle. The live
  // EngineVoice fades in underneath the tail of this buffer.
  const fireAt = Math.round(sr * 1.3);
  const fireLen = out.length - fireAt;
  const fire = new Float32Array(fireLen);
  let ph = 0;
  for (let i = 0; i < fireLen; i++) {
    const t = i / fireLen;
    const rpm = 780 + 1900 * Math.exp(-t * 4.5) * (1 - Math.exp(-t * 40));
    const f = (rpm / 60) * 2;
    ph += (2 * Math.PI * f) / sr;
    fire[i] = (Math.sin(ph) + 0.62 * Math.sin(2 * ph) + 0.34 * Math.sin(3 * ph) + 0.2 * Math.sin(4 * ph)) * 0.32;
    fire[i] += (rng.next() * 2 - 1) * 0.13 * (0.4 + 0.6 * Math.exp(-t * 3));
    // Fade out at the very end so the live voice takes over seamlessly.
    fire[i] *= Math.min(1, (1 - t) * 3.2);
  }
  biquad(fire, 'lowpass', 2600, 0.7, sr);
  mixInto(out, fire, fireAt, 1);

  return normalise(out, 0.8);
}

function renderSpikes(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.9);
  // The strip rattling out across the tarmac.
  for (let i = 0; i < 26; i++) {
    const at = Math.round(sr * rng.range(0, 0.35));
    mixInto(out, modes(sr, 0.12, [rng.range(1800, 5200), rng.range(3000, 8000)], [0.012, 0.008], [1, 0.5]), at, rng.range(0.08, 0.3));
  }
  mixInto(out, noiseBurst(sr, rng, 0.4, 3200, 0.8, 0.09), 0, 0.4);
  return normalise(out, 0.7);
}

/* ---- world ---- */

function renderThunder(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 3.4);
  brownNoise(out, rng);
  biquad(out, 'lowpass', 260, 0.7, sr);
  // Multi-lobed contour — thunder rolls, it does not just decay.
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const env = Math.exp(-t / 1.5) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.9 * t + 1.3)) +
      0.35 * Math.exp(-Math.pow((t - 0.85) / 0.4, 2)) +
      0.25 * Math.exp(-Math.pow((t - 1.9) / 0.6, 2));
    out[i] *= env;
  }
  // The initial crack.
  mixInto(out, noiseBurst(sr, rng, 0.25, 900, 0.6, 0.05), 0, 0.45);
  return normalise(out, 0.9);
}

function renderTramBell(sr: number): Float32Array {
  const out = modes(
    sr, 1.6,
    [742, 1489, 2231, 3010, 4470],
    [0.55, 0.4, 0.28, 0.18, 0.11],
    [0.5, 0.35, 0.22, 0.14, 0.08],
  );
  applyEnvelope(out, sr, { attack: 0.002, decay: 0.4, sustain: 0.25, duration: 1.6, release: 0.5 });
  return normalise(out, 0.6);
}

function renderCrowdGasp(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.1);
  for (let i = 0; i < 9; i++) {
    const v = renderVocal(
      sr, rng, rng.range(0.35, 0.7), rng.range(105, 240), rng.range(-0.25, 0.3),
      [rng.range(560, 800), rng.range(1050, 1400), rng.range(2300, 2900)], 0.5,
    );
    mixInto(out, v, Math.round(sr * rng.range(0, 0.3)), rng.range(0.15, 0.4));
  }
  biquad(out, 'bandpass', 900, 0.6, sr);
  return normalise(out, 0.55);
}

function renderBird(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.5);
  const chirps = 2 + Math.floor(rng.next() * 3);
  for (let c = 0; c < chirps; c++) {
    const len = Math.round(sr * rng.range(0.03, 0.07));
    const ch = new Float32Array(len);
    sweep(ch, sr, rng.range(2600, 3600), rng.range(4200, 6400), 1, true);
    applyEnvelope(ch, sr, { attack: 0.004, decay: 0.02, sustain: 0.4, duration: len / sr, release: len / sr * 0.5 });
    mixInto(out, ch, Math.round(sr * (c * rng.range(0.07, 0.13))), rng.range(0.4, 0.9));
  }
  return normalise(out, 0.4);
}

/* ---- UI / mission stings ---- */

/**
 * Stings use a Romanian-flavoured minor scale (natural minor with a raised 4th
 * — the "Romanian minor" mode) so they sit with the folk track rather than
 * sounding like a generic arcade jingle.
 */
const ROMANIAN_MINOR = [0, 2, 3, 6, 7, 9, 10];

function note(semi: number, base = 196): number {
  return base * Math.pow(2, semi / 12);
}

function renderSting(sr: number, degrees: number[], up: boolean, bright: number, seconds = 0.9): Float32Array {
  const out = buf(sr, seconds);
  const step = 0.085;
  degrees.forEach((deg, i) => {
    const semi = ROMANIAN_MINOR[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
    const f = note(semi, 196 * (up ? 1 : 0.5));
    const len = Math.round(sr * (seconds - i * step));
    if (len <= 0) return;
    const v = new Float32Array(len);
    additive(v, sr, [
      [f, 0.5], [f * 2, 0.26 * bright], [f * 3, 0.14 * bright],
      [f * 4, 0.07 * bright], [f * 5.02, 0.04 * bright],
    ]);
    applyEnvelope(v, sr, { attack: 0.004, decay: 0.16, sustain: 0.12, duration: len / sr, release: (len / sr) * 0.6 });
    mixInto(out, v, Math.round(sr * i * step), 0.8);
  });
  return normalise(out, 0.62);
}

function renderRadioClick(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.09);
  mixInto(out, noiseBurst(sr, rng, 0.03, 2600, 4, 0.003), 0, 0.9);
  mixInto(out, modes(sr, 0.06, [430, 1240], [0.01, 0.006], [0.4, 0.2]), 0, 0.7);
  return normalise(out, 0.45);
}

function renderRadioStatic(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.7);
  whiteNoise(out, rng);
  biquad(out, 'bandpass', 1800, 0.55, sr);
  // Tuning sweep: a whistle wandering through the static.
  const wh = buf(sr, 0.7);
  sweep(wh, sr, 3400, 900, 1, true);
  for (let i = 0; i < wh.length; i++) wh[i] *= 0.14 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * (i / sr)));
  mixInto(out, wh, 0, 1);
  applyEnvelope(out, sr, { attack: 0.01, decay: 0.2, sustain: 0.55, duration: 0.7, release: 0.25 });
  return normalise(out, 0.5);
}

/* ---- vehicle foley: the Dacia "e legată cu sârme, bate, troncăne" ---- */

/**
 * Gearbox clunk. A worn linkage is two events a few milliseconds apart — the
 * lever hitting the gate, then the dog teeth engaging — plus a short body
 * shudder as the driveline takes up the slack.
 */
function renderGearClunk(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.26);
  const d = 1 + rng.range(-0.09, 0.09);
  // lever into the gate: hard, bright, tiny
  mixInto(out, noiseBurst(sr, rng, 0.035, 2600 * d, 3.5, 0.0035), 0, 0.75);
  mixInto(out, modes(sr, 0.1, [520 * d, 1180 * d, 2340 * d], [0.012, 0.008, 0.005], [0.4, 0.26, 0.16]), 0, 0.7);
  // dog teeth: a lower, duller knock ~14 ms later
  const at = Math.round(sr * rng.range(0.010, 0.020));
  mixInto(out, modes(sr, 0.16, [176 * d, 341 * d, 703 * d], [0.03, 0.02, 0.012], [0.55, 0.32, 0.18]), at, 0.85);
  // driveline take-up
  const shud = buf(sr, 0.13);
  sweep(shud, sr, 78, 44, 1, true);
  applyEnvelope(shud, sr, { attack: 0.002, decay: 0.03, sustain: 0, duration: 0.13, release: 0.05 });
  mixInto(out, shud, at, 0.5);
  return normalise(out, 0.55);
}

/** Handbrake: the ratchet pawl walking over its teeth, then the lever seating. */
function renderHandbrake(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.5);
  const teeth = 6 + Math.floor(rng.range(0, 3));
  for (let i = 0; i < teeth; i++) {
    const at = Math.round(sr * (0.02 + i * rng.range(0.028, 0.042)));
    mixInto(out, noiseBurst(sr, rng, 0.02, rng.range(3000, 4600), 5, 0.0022), at, 0.5 + i * 0.03);
    mixInto(out, modes(sr, 0.04, [1450, 2880], [0.004, 0.003], [0.3, 0.2]), at, 0.4);
  }
  // Cable tension + lever stop.
  const stop = Math.round(sr * (0.02 + teeth * 0.035 + 0.02));
  mixInto(out, modes(sr, 0.2, [190, 430, 880], [0.035, 0.02, 0.012], [0.5, 0.3, 0.18]), Math.min(stop, out.length - 1), 0.8);
  return normalise(out, 0.5);
}

/**
 * Body rattle — the "troncăne". Loose trim, a wire-tied bumper and a boot lid
 * with no gasket: a short burst of inharmonic taps with no single pitch. Played
 * repeatedly over rough road, so it must sit low and never draw attention.
 */
function renderBodyRattle(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.42);
  const taps = 5 + Math.floor(rng.range(0, 6));
  for (let i = 0; i < taps; i++) {
    const at = Math.round(sr * rng.range(0, 0.3));
    const f = rng.range(320, 1900);
    mixInto(out, modes(sr, 0.09, [f, f * 2.41, f * 3.77], [0.012, 0.008, 0.005], [0.4, 0.24, 0.13]), at, rng.range(0.25, 0.8));
    if (rng.bool(0.5)) mixInto(out, noiseBurst(sr, rng, 0.02, rng.range(2200, 5200), 6, 0.0025), at, rng.range(0.1, 0.35));
  }
  // A bit of sheet-metal boom under it, so it reads as a car and not a box of cutlery.
  const boom = buf(sr, 0.16);
  sweep(boom, sr, 132, 96, 1, true);
  applyEnvelope(boom, sr, { attack: 0.003, decay: 0.04, sustain: 0, duration: 0.16, release: 0.06 });
  mixInto(out, boom, 0, 0.28);
  return normalise(out, 0.42);
}

/** Brake squeal: a high, narrow pad resonance that swells and dies. */
function renderBrakeSqueal(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.85);
  const f = rng.range(2100, 2900);
  additive(out, sr, [[f, 0.5], [f * 1.997, 0.16], [f * 3.01, 0.06]]);
  // Beating between two nearly-equal pads makes the classic warble.
  additive(out, sr, [[f * 1.006, 0.4]]);
  const hiss = buf(sr, 0.85);
  whiteNoise(hiss, rng);
  biquad(hiss, 'bandpass', f * 0.62, 3, sr);
  mixInto(out, hiss, 0, 0.12);
  applyEnvelope(out, sr, { attack: 0.09, decay: 0.5, sustain: 0.5, duration: 0.85, release: 0.35 });
  return normalise(out, 0.35);
}

/** A wheel dropping off (or climbing) a kerb: rubber slap then suspension. */
function renderKerbThump(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.4);
  const slap = buf(sr, 0.09);
  whiteNoise(slap, rng);
  biquad(slap, 'bandpass', rng.range(150, 260), 0.8, sr);
  for (let i = 0; i < slap.length; i++) slap[i] *= Math.exp(-(i / sr) / 0.011);
  mixInto(out, slap, 0, 0.9);
  const thud = buf(sr, 0.26);
  sweep(thud, sr, 88, 36, 1, true);
  applyEnvelope(thud, sr, { attack: 0.001, decay: 0.026, sustain: 0, duration: 0.26, release: 0.09 });
  mixInto(out, thud, Math.round(sr * 0.004), 1);
  mixInto(out, modes(sr, 0.2, [268, 517, 962], [0.03, 0.02, 0.012], [0.3, 0.2, 0.12]), Math.round(sr * 0.006), 0.6);
  return normalise(out, 0.8);
}

/** The engine giving up: the note drops, coughs twice and stops. */
function renderEngineStall(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.1);
  const die = buf(sr, 0.75);
  sweep(die, sr, 96, 22, 1, true);
  applyEnvelope(die, sr, { attack: 0.01, decay: 0.4, sustain: 0.35, duration: 0.75, release: 0.4 });
  mixInto(out, die, 0, 0.8);
  for (const at of [0.28, 0.52]) {
    mixInto(out, noiseBurst(sr, rng, 0.16, rng.range(180, 300), 1.1, 0.03), Math.round(sr * at), 0.55);
  }
  return normalise(out, 0.6);
}

/* ---- city & people ---- */

/** Tram flange screech: metal-on-metal on a tight curve. Long and horrible. */
function renderTramScreech(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.8);
  const f = rng.range(1250, 1750);
  // Stick-slip: the pitch wanders and the amplitude flutters.
  const n = out.length;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const wob = 1 + 0.045 * Math.sin(2 * Math.PI * 5.3 * t) + 0.02 * Math.sin(2 * Math.PI * 13.1 * t);
    phase += (2 * Math.PI * f * wob) / sr;
    const flutter = 0.6 + 0.4 * Math.abs(Math.sin(2 * Math.PI * 21 * t));
    out[i] = (Math.sin(phase) * 0.6 + Math.sin(phase * 2.004) * 0.25 + Math.sin(phase * 3.01) * 0.1) * flutter;
  }
  const grind = buf(sr, 1.8);
  whiteNoise(grind, rng);
  biquad(grind, 'bandpass', f * 0.55, 2.2, sr);
  mixInto(out, grind, 0, 0.22);
  applyEnvelope(out, sr, { attack: 0.16, decay: 0.9, sustain: 0.7, duration: 1.8, release: 0.7 });
  return normalise(out, 0.55);
}

/** One angry Romanian street shout. Not a word — the shape of one. */
function renderCrowdShout(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.62);
  // "Bă!" — a short hard onset then an open vowel falling away.
  mixInto(out, renderVocal(sr, rng, 0.2, rng.range(150, 210), 0.22, [640, 1180, 2500], 0.9), 0, 0.85);
  mixInto(out, renderVocal(sr, rng, 0.36, rng.range(130, 190), -0.24, [720, 1250, 2600], 1), Math.round(sr * 0.2), 1);
  return normalise(out, 0.75);
}

/** A scream — a car just came over the kerb at them. */
function renderCrowdScream(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.95);
  mixInto(out, renderVocal(sr, rng, 0.9, rng.range(320, 470), rng.range(0.3, 0.7), [900, 1900, 3100], 1), 0, 1);
  const breath = buf(sr, 0.3);
  whiteNoise(breath, rng);
  biquad(breath, 'bandpass', 2400, 1.1, sr);
  for (let i = 0; i < breath.length; i++) breath[i] *= Math.exp(-(i / sr) / 0.09);
  mixInto(out, breath, 0, 0.2);
  return normalise(out, 0.8);
}

/** Pigeons leaving in a hurry. */
function renderPigeonFlutter(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.2);
  const beats = 14 + Math.floor(rng.range(0, 8));
  for (let i = 0; i < beats; i++) {
    const t = i * rng.range(0.055, 0.085);
    if (t > 1.05) break;
    const w = buf(sr, 0.06);
    whiteNoise(w, rng);
    biquad(w, 'bandpass', rng.range(320, 900), 1.3, sr);
    for (let k = 0; k < w.length; k++) w[k] *= Math.sin((Math.PI * k) / w.length) ** 2;
    mixInto(out, w, Math.round(sr * t), rng.range(0.3, 0.8) * (1 - t / 1.4));
  }
  // A couple of alarmed coos.
  mixInto(out, renderVocal(sr, rng, 0.22, 430, -0.3, [560, 1100, 2000], 0.4), Math.round(sr * rng.range(0.1, 0.5)), 0.35);
  return normalise(out, 0.5);
}

/** Clothing rustle — the quiet half of a footstep. */
function renderClothRustle(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.18);
  whiteNoise(out, rng);
  biquad(out, 'bandpass', rng.range(2600, 4400), 0.8, sr);
  biquad(out, 'highpass', 1400, 0.7, sr);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    out[i] *= Math.exp(-t / 0.035) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 31 * t));
  }
  return normalise(out, 0.22);
}

/** Construction: a pneumatic hammer burst, or a scaffold pole dropped. */
function renderConstructionHammer(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 1.4);
  const hits = 8 + Math.floor(rng.range(0, 10));
  const period = rng.range(0.055, 0.085);
  for (let i = 0; i < hits; i++) {
    const at = Math.round(sr * (0.02 + i * period));
    if (at > out.length - 100) break;
    mixInto(out, noiseBurst(sr, rng, 0.05, rng.range(900, 1800), 1.4, 0.008), at, 0.7);
    mixInto(out, modes(sr, 0.09, [148, 372, 690], [0.014, 0.009, 0.006], [0.5, 0.3, 0.18]), at, 0.8);
  }
  return normalise(out, 0.6);
}

function renderDogBark(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.9);
  const barks = 2 + Math.floor(rng.range(0, 3));
  for (let i = 0; i < barks; i++) {
    const at = Math.round(sr * (i * rng.range(0.18, 0.3)));
    const b = renderVocal(sr, rng, 0.13, rng.range(230, 380), -0.45, [520, 1400, 2700], 1);
    mixInto(out, b, at, rng.range(0.6, 1));
  }
  return normalise(out, 0.62);
}

/** The bell over a shop door. */
function renderShopBell(sr: number, rng: Rng): Float32Array {
  const out = buf(sr, 0.9);
  const d = 1 + rng.range(-0.03, 0.03);
  mixInto(out, modes(
    sr, 0.85,
    [2180 * d, 3270 * d, 4890 * d, 6110 * d],
    [0.22, 0.16, 0.1, 0.07],
    [0.5, 0.35, 0.2, 0.12],
  ), 0, 1);
  mixInto(out, modes(sr, 0.5, [2210 * d, 3310 * d], [0.18, 0.12], [0.3, 0.2]), Math.round(sr * 0.09), 0.6);
  return normalise(out, 0.35);
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

/** Render one variant of one sfx id. Pure — used by the bank AND by tests. */
export function renderSfx(id: SfxId, sr: number, rng: Rng): Float32Array {
  switch (id) {
    case 'impact_light': return renderImpact(sr, rng, 0.1);
    case 'impact_medium': return renderImpact(sr, rng, 0.45);
    case 'impact_heavy': return renderImpact(sr, rng, 1);
    case 'impact_glass': return renderGlass(sr, rng);
    case 'prop_glass': return renderGlass(sr, rng);
    case 'scrape': return renderScrape(sr, rng);
    case 'suspension_knock': return renderSuspensionKnock(sr, rng);
    case 'tyre_burst': return renderTyreBurst(sr, rng);
    case 'explosion': return renderExplosion(sr, rng);
    case 'prop_wood': return renderPropWood(sr, rng);
    case 'prop_metal': return renderPropMetal(sr, rng);
    case 'prop_plastic': return renderPropPlastic(sr, rng);
    case 'prop_broken': return renderPropPlastic(sr, rng);
    case 'footstep': return renderFootstep(sr, rng, 'concrete');
    case 'footstep_wet': return renderFootstep(sr, rng, 'wet');
    case 'footstep_gravel': return renderFootstep(sr, rng, 'gravel');
    case 'footstep_grass': return renderFootstep(sr, rng, 'grass');
    case 'footstep_metal': return renderFootstep(sr, rng, 'metal');
    case 'ped_yell': return renderVocal(sr, rng, rng.range(0.4, 0.7), rng.range(120, 250), rng.range(0.15, 0.5), [700, 1220, 2600], 1);
    case 'ped_hit': {
      const out = buf(sr, 0.6);
      mixInto(out, renderPunch(sr, rng), 0, 1);
      mixInto(out, renderVocal(sr, rng, 0.35, 190, -0.35, [620, 1100, 2500], 0.8), Math.round(sr * 0.04), 0.8);
      return normalise(out, 0.85);
    }
    case 'punch': return renderPunch(sr, rng);
    case 'body_fall': {
      const out = buf(sr, 0.5);
      const thud = buf(sr, 0.3);
      sweep(thud, sr, 110, 40, 1, true);
      applyEnvelope(thud, sr, { attack: 0.002, decay: 0.04, sustain: 0, duration: 0.3, release: 0.12 });
      mixInto(out, thud, 0, 1);
      mixInto(out, noiseBurst(sr, rng, 0.18, 700, 0.7, 0.03), 0, 0.5);
      return normalise(out, 0.8);
    }
    case 'door_open': return renderDoor(sr, rng, false, false);
    case 'door_close': return renderDoor(sr, rng, true, false);
    case 'car_door': return renderDoor(sr, rng, true, true);
    case 'pickup': return renderSting(sr, [4, 7], true, 0.9, 0.5);
    case 'interact': return renderSting(sr, [2], true, 0.6, 0.3);
    case 'horn': return renderHorn(sr, rng, false);
    case 'horn_low': return renderHorn(sr, rng, true);
    case 'dacia_cough': return renderDaciaCough(sr, rng);
    case 'spikes': return renderSpikes(sr, rng);
    case 'gear_clunk': return renderGearClunk(sr, rng);
    case 'handbrake': return renderHandbrake(sr, rng);
    case 'body_rattle': return renderBodyRattle(sr, rng);
    case 'brake_squeal': return renderBrakeSqueal(sr, rng);
    case 'kerb_thump': return renderKerbThump(sr, rng);
    case 'engine_stall': return renderEngineStall(sr, rng);
    case 'exhaust_pop': return renderExhaustPop(sr, rng);
    case 'stone_ping': return renderStonePing(sr, rng);
    case 'ped_mutter': return renderPedVocal(sr, rng, 'mutter');
    case 'ped_cough': return renderPedVocal(sr, rng, 'cough');
    case 'ped_laugh': return renderPedVocal(sr, rng, 'laugh');
    case 'ped_whistle': return renderPedVocal(sr, rng, 'whistle');
    case 'church_bell': return renderChurchBell(sr, rng);
    case 'thunder': return renderThunder(sr, rng);
    case 'tram_bell': return renderTramBell(sr);
    case 'tram_screech': return renderTramScreech(sr, rng);
    case 'crowd_gasp': return renderCrowdGasp(sr, rng);
    case 'bird': return renderBird(sr, rng);
    case 'crowd_shout': return renderCrowdShout(sr, rng);
    case 'crowd_scream': return renderCrowdScream(sr, rng);
    case 'pigeon_flutter': return renderPigeonFlutter(sr, rng);
    case 'cloth_rustle': return renderClothRustle(sr, rng);
    case 'construction_hammer': return renderConstructionHammer(sr, rng);
    case 'dog_bark': return renderDogBark(sr, rng);
    case 'shop_bell': return renderShopBell(sr, rng);
    case 'star_up': return renderSting(sr, [0, 3, 6], true, 1.1, 1.1);
    case 'star_down': return renderSting(sr, [6, 3, 0], false, 0.7, 1.0);
    case 'mission_start': return renderSting(sr, [0, 4, 7], true, 1.0, 1.3);
    case 'mission_complete': return renderSting(sr, [0, 4, 7, 11], true, 1.2, 1.6);
    case 'mission_failed': return renderSting(sr, [3, 2, 0], false, 0.6, 1.5);
    case 'activity_start': return renderSting(sr, [0, 2], true, 0.8, 0.7);
    case 'activity_win': return renderSting(sr, [4, 7, 11], true, 1.15, 1.2);
    case 'radio_click': return renderRadioClick(sr, rng);
    case 'radio_static': return renderRadioStatic(sr, rng);
  }
}

/* ------------------------------------------------------------------ */
/* AudioBuffer bank                                                    */
/* ------------------------------------------------------------------ */

export class SfxBank {
  private map = new Map<SfxId, AudioBuffer[]>();
  private pickCursor = new Map<SfxId, number>();
  private rng: Rng;
  private built = 0;

  constructor(private ctx: AudioContext, seed = 'gta-sfx-bank') {
    this.rng = new Rng(seed);
  }

  get size(): number {
    return this.built;
  }

  get complete(): boolean {
    return this.map.size === SFX_IDS.length;
  }

  /**
   * Build the whole bank, yielding to the browser every few sounds so boot
   * never drops a frame. ~1.4 MB of Float32 in total.
   */
  async build(onProgress?: (done: number, total: number) => void): Promise<void> {
    const sr = this.ctx.sampleRate;
    for (let i = 0; i < SFX_IDS.length; i++) {
      const id = SFX_IDS[i];
      const n = VARIANTS[id] ?? 1;
      const list: AudioBuffer[] = [];
      for (let v = 0; v < n; v++) {
        const data = renderSfx(id, sr, this.rng.fork(`${id}:${v}`));
        const b = this.ctx.createBuffer(1, data.length, sr);
        b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
        list.push(b);
        this.built++;
      }
      this.map.set(id, list);
      onProgress?.(i + 1, SFX_IDS.length);
      if (i % 4 === 3) await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  has(id: string): boolean {
    return this.map.has(id as SfxId);
  }

  /** Round-robin through the variants so a repeated event never machine-guns. */
  get(id: SfxId): AudioBuffer | undefined {
    const list = this.map.get(id);
    if (!list || list.length === 0) return undefined;
    const c = (this.pickCursor.get(id) ?? 0) % list.length;
    this.pickCursor.set(id, c + 1);
    return list[c];
  }

  ids(): SfxId[] {
    return [...this.map.keys()];
  }
}

/* ------------------------------------------------------------------ */
/* Looping beds used by ambience & vehicles                            */
/* ------------------------------------------------------------------ */

/** A long seamless noise loop. Ambience layers all share these three. */
export function renderNoiseLoop(
  sr: number, seconds: number, colour: 'white' | 'pink' | 'brown', rng: Rng,
): Float32Array {
  const b = new Float32Array(Math.round(sr * seconds));
  if (colour === 'pink') pinkNoise(b, rng);
  else if (colour === 'brown') brownNoise(b, rng);
  else whiteNoise(b, rng);
  // Crossfade the tail into the head so the loop point is inaudible.
  const xf = Math.round(sr * 0.35);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    b[i] = b[i] * t + b[b.length - xf + i] * (1 - t);
  }
  return normalise(b, 0.85);
}

/** Distant-city bed: brown noise plus slow swells and passing-car whooshes. */
export function renderTrafficLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, seconds, 'brown', rng);
  onePoleLowpass(b, 520, sr);
  // Slow swells.
  for (let i = 0; i < b.length; i++) {
    const t = i / sr;
    b[i] *= 0.62 + 0.38 * Math.sin(2 * Math.PI * (t / seconds) * 3) * Math.sin(2 * Math.PI * (t / seconds) * 7);
  }
  // Individual vehicles going past: a filtered noise swell with a pitch fall.
  const passes = Math.round(seconds * 1.6);
  for (let p = 0; p < passes; p++) {
    const len = Math.round(sr * rng.range(0.9, 2.1));
    const at = Math.round(rng.range(0, b.length - len - 1));
    const w = new Float32Array(len);
    whiteNoise(w, rng);
    biquad(w, 'bandpass', rng.range(280, 700), 0.8, sr);
    for (let i = 0; i < len; i++) w[i] *= Math.sin((Math.PI * i) / len) ** 2;
    mixInto(b, w, at, rng.range(0.12, 0.4));
  }
  return normalise(b, 0.8);
}

/** Crowd murmur: many overlapping vocal blobs, band-limited to speech. */
export function renderCrowdLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = new Float32Array(Math.round(sr * seconds));
  const voices = Math.round(seconds * 7);
  for (let v = 0; v < voices; v++) {
    const len = Math.round(sr * rng.range(0.4, 1.4));
    const at = Math.round(rng.range(0, b.length - len - 1));
    const blob = renderVocal(
      sr, rng, len / sr, rng.range(95, 230), rng.range(-0.3, 0.3),
      [rng.range(480, 820), rng.range(1000, 1600), rng.range(2200, 3000)], 0.6,
    );
    mixInto(b, blob, at, rng.range(0.05, 0.22));
  }
  biquad(b, 'bandpass', 850, 0.5, sr);
  const xf = Math.round(sr * 0.4);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    b[i] = b[i] * t + b[b.length - xf + i] * (1 - t);
  }
  return normalise(b, 0.65);
}

/** Rain: dense high-frequency patter over a hiss bed. */
export function renderRainLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, seconds, 'white', rng);
  biquad(b, 'highpass', 700, 0.7, sr);
  biquad(b, 'peaking', 4200, 1.2, sr, 5);
  // Individual drops on hard surfaces.
  const drops = Math.round(seconds * 260);
  for (let d = 0; d < drops; d++) {
    const at = Math.round(rng.range(0, b.length - 400));
    const len = 90;
    for (let i = 0; i < len; i++) {
      b[at + i] += (rng.next() * 2 - 1) * 0.5 * Math.exp(-i / 14);
    }
  }
  return normalise(b, 0.8);
}

/**
 * RAIN ON A TIN ROOF — the cabin's own rain layer.
 *
 * Rain outside and rain heard from inside a car are two completely different
 * sounds, and using the outdoor bed muffled by the cabin lowpass gets it
 * wrong in a way anybody who has sat out a downpour in a Dacia will notice.
 * Outside, rain is a dense high hiss. Inside, the hiss is gone (the glass
 * stops it) and what is left is individual drops striking a large, thin,
 * badly damped steel panel forty centimetres above your head: discrete
 * mid-frequency taps, each one ringing the roof pan.
 *
 * So this is built the opposite way round from `renderRainLoop`: mostly
 * transients, band-limited to the roof's own resonance, over almost no bed.
 */
export function renderRoofRainLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = new Float32Array(Math.round(sr * seconds));

  // The panel. Every drop excites the same modes, which is why rain on a roof
  // has a pitch and rain on a pavement does not.
  const roof = [absorbFreq(rng, 320), absorbFreq(rng, 540), absorbFreq(rng, 880)];

  const drops = Math.round(seconds * 900);
  for (let d = 0; d < drops; d++) {
    const at = Math.round(rng.range(0, b.length - 600));
    const amp = rng.range(0.05, 0.5);
    // A drop is an impulse; the panel does the rest. Rendering the modes
    // inline (rather than calling `modes` 5400 times) keeps this under a few
    // milliseconds, which matters because it runs during boot.
    for (let m = 0; m < 3; m++) {
      const w = (2 * Math.PI * roof[m]) / sr;
      const tau = [0.013, 0.009, 0.005][m];
      const g = amp * [1, 0.6, 0.32][m];
      const n = Math.round(sr * tau * 4);
      for (let i = 0; i < n && at + i < b.length; i++) {
        b[at + i] += Math.sin(w * i) * g * Math.exp(-(i / sr) / tau);
      }
    }
  }

  // A whisper of bed under it — water running down the glass.
  const bed = renderNoiseLoop(sr, seconds, 'pink', rng);
  biquad(bed, 'bandpass', 1400, 0.6, sr);
  mixInto(b, bed, 0, 0.1);

  const xf = Math.round(sr * 0.3);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    b[i] = b[i] * t + b[b.length - xf + i] * (1 - t);
  }
  return normalise(b, 0.8);
}

function absorbFreq(rng: Rng, base: number): number {
  return base * rng.range(0.93, 1.07);
}

/** Wind: brown noise through a wandering bandpass. */
export function renderWindLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, seconds, 'brown', rng);
  biquad(b, 'bandpass', 420, 0.45, sr);
  for (let i = 0; i < b.length; i++) {
    const t = i / sr;
    b[i] *= 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t / seconds) * 2 + 0.7)) *
      (0.6 + 0.4 * Math.sin(2 * Math.PI * (t / seconds) * 5));
  }
  return normalise(b, 0.75);
}

/** Tram / metro rumble under the street. */
export function renderTramLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, seconds, 'brown', rng);
  biquad(b, 'lowpass', 190, 0.9, sr);
  // Rail joints.
  const joints = Math.round(seconds * 3.4);
  for (let j = 0; j < joints; j++) {
    const at = Math.round(rng.range(0, b.length - sr * 0.2));
    mixInto(b, modes(sr, 0.18, [88, 174, 305], [0.05, 0.03, 0.02], [0.5, 0.3, 0.15]), at, rng.range(0.2, 0.5));
  }
  return normalise(b, 0.8);
}

/** Industrial: a 50 Hz-family drone plus far-off clanks. */
export function renderIndustrialLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = new Float32Array(Math.round(sr * seconds));
  additive(b, sr, [[49.5, 0.35], [99, 0.2], [148.5, 0.1], [ 200.5, 0.06]]);
  const hiss = renderNoiseLoop(sr, seconds, 'pink', rng);
  biquad(hiss, 'bandpass', 900, 0.5, sr);
  mixInto(b, hiss, 0, 0.22);
  const clanks = Math.round(seconds * 0.9);
  for (let c = 0; c < clanks; c++) {
    const at = Math.round(rng.range(0, b.length - sr * 1.5));
    const m = modes(sr, 1.2, [rng.range(180, 420), rng.range(500, 900), rng.range(1200, 2100)], [0.3, 0.2, 0.12], [0.4, 0.25, 0.15]);
    mixInto(b, m, at, rng.range(0.08, 0.22));
  }
  return normalise(b, 0.7);
}

/** Air-handling hiss for the glass corporate plazas. */
export function renderHvacLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, seconds, 'pink', rng);
  biquad(b, 'lowpass', 1400, 0.6, sr);
  biquad(b, 'peaking', 260, 1.5, sr, 6);
  return normalise(b, 0.6);
}

/** Park: leaves plus occasional birds. */
export function renderParkLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, seconds, 'white', rng);
  biquad(b, 'bandpass', 3200, 0.5, sr);
  for (let i = 0; i < b.length; i++) {
    const t = i / sr;
    b[i] *= 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t / seconds) * 3.5 + 1.1));
  }
  const birds = Math.round(seconds * 0.8);
  for (let i = 0; i < birds; i++) {
    mixInto(b, renderBird(sr, rng), Math.round(rng.range(0, b.length - sr * 0.6)), rng.range(0.25, 0.6));
  }
  return normalise(b, 0.55);
}

/**
 * Building site: a compressor droning, a pneumatic hammer in bursts, and a
 * scaffold pole going down every so often. Bucharest has one of these on
 * every third corner, so it gets its own layer rather than living inside the
 * industrial drone.
 */
export function renderConstructionLoop(sr: number, seconds: number, rng: Rng): Float32Array {
  const b = new Float32Array(Math.round(sr * seconds));
  // Diesel compressor: a low pulse train, not a pure tone.
  const puls = 11.7;
  for (let i = 0; i < b.length; i++) {
    const t = i / sr;
    const p = (t * puls) % 1;
    b[i] = (Math.exp(-p * 5) * 2 - 0.7) * 0.16;
  }
  onePoleLowpass(b, 240, sr);
  const hiss = renderNoiseLoop(sr, seconds, 'pink', rng);
  biquad(hiss, 'bandpass', 1600, 0.6, sr);
  mixInto(b, hiss, 0, 0.14);
  // Hammer bursts, well spaced.
  const bursts = Math.max(1, Math.round(seconds * 0.35));
  for (let i = 0; i < bursts; i++) {
    const h = renderConstructionHammer(sr, rng);
    const at = Math.round(rng.range(0, Math.max(1, b.length - h.length - 1)));
    mixInto(b, h, at, rng.range(0.25, 0.55));
  }
  // Dropped poles.
  for (let i = 0; i < Math.max(1, Math.round(seconds * 0.2)); i++) {
    const m = modes(sr, 1.6, [rng.range(160, 300), rng.range(620, 980), rng.range(1500, 2400)], [0.5, 0.34, 0.2], [0.4, 0.26, 0.14]);
    const at = Math.round(rng.range(0, Math.max(1, b.length - m.length - 1)));
    mixInto(b, m, at, rng.range(0.1, 0.28));
  }
  const xf = Math.round(sr * 0.4);
  for (let i = 0; i < xf; i++) {
    const t = i / xf;
    b[i] = b[i] * t + b[b.length - xf + i] * (1 - t);
  }
  return normalise(b, 0.6);
}

/** Engine noise beds: one white loop reused by every vehicle voice. */
export function renderEngineNoiseLoop(sr: number, rng: Rng): Float32Array {
  return renderNoiseLoop(sr, 3.1, 'white', rng);
}

/**
 * Tyre squeal bed: a resonant, slightly unstable band of noise. Pitched by
 * playbackRate at play time, so one buffer covers the whole squeal range.
 */
export function renderSquealLoop(sr: number, rng: Rng): Float32Array {
  const b = renderNoiseLoop(sr, 2.0, 'white', rng);
  biquad(b, 'bandpass', 900, 9, sr);
  biquad(b, 'peaking', 1800, 6, sr, 9);
  // Chatter: the stick-slip of a tyre letting go.
  for (let i = 0; i < b.length; i++) {
    const t = i / sr;
    b[i] *= 0.6 + 0.4 * Math.sin(2 * Math.PI * 33 * t) * Math.sin(2 * Math.PI * 7.5 * t);
  }
  return normalise(b, 0.8);
}

export function toAudioBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
  return b;
}

export { envelopeAt };
