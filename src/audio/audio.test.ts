/**
 * Audio synthesis tests.
 *
 * Bun has no `OfflineAudioContext` (`'OfflineAudioContext' in globalThis` is
 * false), so instead of rendering through WebAudio we test the *models and
 * renderers themselves* — which is stronger, because every buffer in the game
 * comes out of exactly these pure functions (bank.ts) and every AudioParam the
 * WebAudio graph writes comes out of exactly these state functions
 * (engineModel.ts, sirenModel.ts). Spectra are measured with a Goertzel bin.
 */

import { describe, expect, test } from 'bun:test';
import { Rng } from '../core/rng';
import {
  additive, applyEnvelope, biquad, decayTimeTo, envelopeAt, goertzel,
  peak, rms, spectralCentroid, dbToGain, gainToDb,
} from './dsp';
import {
  ENGINE_SPECS, HARMONIC_ORDERS, engineState, selectGear, tyreState,
} from './engineModel';
import {
  SIREN_SPECS, dopplerFactor, ratioToCents, sirenFrequencyAt, sirenModeForStars,
} from './sirenModel';
import { SFX_IDS, renderSfx, renderRainLoop, renderCrowdLoop, renderTrafficLoop } from './bank';
import { CLIPS, VO_BUCKETS, assignedKeys, bucket, bucketsFor, FOLK_TRACK } from './clips';
import { DEFAULT_MIX } from './graph';

const SR = 44100;

/** Render the harmonic stack the WebAudio oscillators will produce. */
function renderEngineStack(fundamental: number, harmonics: number[], seconds = 0.5): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  additive(out, SR, HARMONIC_ORDERS.map((o, i) => [fundamental * o, harmonics[i]] as const));
  return out;
}

/* ------------------------------------------------------------------ */

describe('dsp primitives', () => {
  test('dB <-> gain round trip', () => {
    for (const db of [-60, -20, -6, -3, 0]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 5);
    }
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
  });

  test('rms and peak of a unit sine', () => {
    const b = new Float32Array(SR);
    additive(b, SR, [[440, 1]]);
    expect(peak(b)).toBeCloseTo(1, 2);
    expect(rms(b)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  test('goertzel finds a tone and rejects its neighbours', () => {
    const b = new Float32Array(SR / 2);
    additive(b, SR, [[440, 1]]);
    expect(goertzel(b, SR, 440)).toBeGreaterThan(0.8);
    expect(goertzel(b, SR, 1320)).toBeLessThan(0.05);
  });

  test('spectral centroid rises with a brighter spectrum', () => {
    const dark = new Float32Array(512);
    const bright = new Float32Array(512);
    dark[10] = 1;
    bright[400] = 1;
    expect(spectralCentroid(bright, SR)).toBeGreaterThan(spectralCentroid(dark, SR) * 10);
  });

  test('biquad lowpass actually attenuates above cutoff', () => {
    const mk = (hz: number) => {
      const b = new Float32Array(SR / 4);
      additive(b, SR, [[hz, 1]]);
      biquad(b, 'lowpass', 500, 0.707, SR);
      return rms(b);
    };
    expect(mk(200)).toBeGreaterThan(0.6);
    expect(mk(5000)).toBeLessThan(0.02);
  });

  test('envelope hits its attack peak and reaches zero at the end', () => {
    const e = { attack: 0.02, decay: 0.1, sustain: 0.5, duration: 1, release: 0.2 };
    expect(envelopeAt(0, e)).toBe(0);
    expect(envelopeAt(0.02, e)).toBeCloseTo(1, 2);
    expect(envelopeAt(1, e)).toBeCloseTo(0, 5);
    // Sustain plateau before release.
    expect(envelopeAt(0.5, e)).toBeGreaterThan(0.45);
    expect(envelopeAt(0.5, e)).toBeLessThan(0.62);
  });

  test('decayTimeTo is the inverse of an exponential decay', () => {
    const t = decayTimeTo(0.1, 0.001);
    expect(Math.exp(-t / 0.1)).toBeCloseTo(0.001, 6);
  });
});

/* ------------------------------------------------------------------ */

describe('engine model', () => {
  const dacia = ENGINE_SPECS.dacia;

  test('the Dacia is a four with a 5200 rpm ceiling', () => {
    expect(dacia.cylinders).toBe(4);
    expect(dacia.maxRpm).toBe(5200);
    expect(dacia.gearTops.length).toBe(4);
  });

  test('firing frequency follows rpm x cylinders / 2', () => {
    const s = engineState(dacia, { speed: 0, throttle: 0, airborne: false, wrecked: false, prevGear: -1 });
    // idle 780 rpm, four-stroke four => 780/60*2 = 26 Hz
    expect(s.rpm).toBeCloseTo(780, 5);
    expect(s.fundamental).toBeCloseTo(26, 5);
    expect(s.fundamental).toBeCloseTo((s.rpm / 60) * (dacia.cylinders / 2) * dacia.firingScale, 6);
  });

  test('rpm rises within a gear and drops on the upshift', () => {
    let prev = -1;
    const samples: Array<{ v: number; gear: number; rpm: number }> = [];
    for (let v = 0; v <= 38; v += 0.5) {
      const s = engineState(dacia, { speed: v, throttle: 1, airborne: false, wrecked: false, prevGear: prev });
      prev = s.gear;
      samples.push({ v, gear: s.gear, rpm: s.rpm });
    }
    // Four gears are actually used.
    expect(new Set(samples.map((s) => s.gear)).size).toBe(4);
    // Every upshift is a measurable rpm drop.
    let shifts = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].gear > samples[i - 1].gear) {
        shifts++;
        expect(samples[i].rpm).toBeLessThan(samples[i - 1].rpm);
      } else {
        expect(samples[i].rpm).toBeGreaterThanOrEqual(samples[i - 1].rpm - 1);
      }
    }
    expect(shifts).toBe(3);
    // rpm never runs away past the redline.
    expect(Math.max(...samples.map((s) => s.rpm))).toBeLessThan(dacia.maxRpm * 1.12);
  });

  test('gear selection has hysteresis', () => {
    // Sitting just under the top of gear 1 while previously in gear 1 stays.
    const top = dacia.gearTops[0];
    expect(selectGear(dacia, top * 0.95, 1)).toBe(1);
    // Dropping well below sends it back down.
    expect(selectGear(dacia, top * 0.5, 1)).toBe(0);
  });

  test('load changes the SPECTRUM, not just the pitch', () => {
    const speed = 18;
    const loaded = engineState(dacia, { speed, throttle: 1, airborne: false, wrecked: false, prevGear: 2 });
    const lifted = engineState(dacia, { speed, throttle: 0, airborne: false, wrecked: false, prevGear: 2 });

    // Same gear, near-identical fundamental...
    expect(loaded.gear).toBe(lifted.gear);
    expect(Math.abs(loaded.fundamental - lifted.fundamental) / loaded.fundamental).toBeLessThan(0.12);

    // ...but a measurably brighter stack under load.
    const a = renderEngineStack(loaded.fundamental, loaded.harmonics);
    const b = renderEngineStack(lifted.fundamental, lifted.harmonics);
    // Measure the TOP of the stack (6th and 8th order) — the mid orders are
    // deliberately boosted on the overrun, which is a different colour, not a
    // brighter one.
    const upper = (buf: Float32Array, f0: number) =>
      [6, 8].reduce((s, o) => s + goertzel(buf, SR, f0 * o), 0);
    const lower = (buf: Float32Array, f0: number) => goertzel(buf, SR, f0);

    const loadedTilt = upper(a, loaded.fundamental) / lower(a, loaded.fundamental);
    const liftedTilt = upper(b, lifted.fundamental) / lower(b, lifted.fundamental);
    expect(loadedTilt).toBeGreaterThan(liftedTilt * 1.3);
  });

  test('harmonics are actually present at the right frequencies', () => {
    const s = engineState(dacia, { speed: 22, throttle: 0.8, airborne: false, wrecked: false, prevGear: 2 });
    const buf = renderEngineStack(s.fundamental, s.harmonics, 1);
    for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
      const f = s.fundamental * HARMONIC_ORDERS[i];
      const mag = goertzel(buf, SR, f);
      expect(mag).toBeGreaterThan(s.harmonics[i] * 0.7);
    }
    // Nothing at a non-harmonic frequency.
    expect(goertzel(buf, SR, s.fundamental * 2.5)).toBeLessThan(0.06);
  });

  test('overrun appears on lift at speed and not at a standstill', () => {
    const lift = engineState(dacia, { speed: 25, throttle: 0, airborne: false, wrecked: false, prevGear: 3 });
    const idle = engineState(dacia, { speed: 0, throttle: 0, airborne: false, wrecked: false, prevGear: 0 });
    expect(lift.overrun).toBeGreaterThan(0.8);
    expect(idle.overrun).toBe(0);
    // Overrun collapses the fundamental relative to the mid orders.
    expect(lift.harmonics[2] / lift.harmonics[0]).toBeGreaterThan(
      idle.harmonics[2] / idle.harmonics[0],
    );
  });

  test('standing on the throttle at rest still revs (clutch slip)', () => {
    const rest = engineState(dacia, { speed: 0, throttle: 0, airborne: false, wrecked: false, prevGear: -1 });
    const launch = engineState(dacia, { speed: 0, throttle: 1, airborne: false, wrecked: false, prevGear: -1 });
    expect(launch.rpm).toBeGreaterThan(rest.rpm * 1.6);
  });

  test('exhaust and induction beds open with load and revs', () => {
    const low = engineState(dacia, { speed: 0, throttle: 0, airborne: false, wrecked: false, prevGear: -1 });
    const high = engineState(dacia, { speed: 30, throttle: 1, airborne: false, wrecked: false, prevGear: 3 });
    expect(high.inductionLevel).toBeGreaterThan(low.inductionLevel);
    expect(high.inductionHz).toBeGreaterThan(low.inductionHz * 1.5);
    expect(high.exhaustHz).toBeGreaterThan(low.exhaustHz);
    expect(high.drive).toBeGreaterThan(low.drive);
  });

  test('every vehicle class produces a sane note', () => {
    for (const [kind, spec] of Object.entries(ENGINE_SPECS)) {
      for (const v of [0, spec.topSpeed * 0.5, spec.topSpeed]) {
        const s = engineState(spec, { speed: v, throttle: 0.7, airborne: false, wrecked: false, prevGear: -1 });
        expect(s.fundamental).toBeGreaterThan(4);
        expect(s.fundamental).toBeLessThan(700);
        expect(s.gain).toBeGreaterThan(0);
        expect(Number.isFinite(s.gain)).toBe(true);
        expect(kind.length).toBeGreaterThan(0);
      }
    }
  });

  test('a truck sits far below a scooter at full chat', () => {
    const flat = (k: keyof typeof ENGINE_SPECS) => engineState(ENGINE_SPECS[k], {
      speed: ENGINE_SPECS[k].topSpeed, throttle: 1, airborne: false, wrecked: false, prevGear: -1,
    });
    expect(flat('scooter').fundamental / flat('truck').fundamental).toBeGreaterThan(2);
    // And the single-cylinder is voiced at an audible order, not its 12 Hz
    // true firing rate.
    expect(flat('scooter').fundamental).toBeGreaterThan(120);
    expect(ENGINE_SPECS.scooter.firingScale).toBeGreaterThan(1);
  });
});

describe('tyre model', () => {
  test('roll noise scales with speed and wetness', () => {
    const slow = tyreState({ speed: 4, wetness: 0, slip: 0, handbrake: false, grounded: 1 });
    const fast = tyreState({ speed: 30, wetness: 0, slip: 0, handbrake: false, grounded: 1 });
    const wet = tyreState({ speed: 30, wetness: 1, slip: 0, handbrake: false, grounded: 1 });
    expect(fast.rollLevel).toBeGreaterThan(slow.rollLevel * 2);
    expect(wet.rollLevel).toBeGreaterThan(fast.rollLevel);
    expect(wet.rollHz).toBeGreaterThan(fast.rollHz);
    expect(wet.sprayLevel).toBeGreaterThan(0.2);
    expect(fast.sprayLevel).toBe(0);
  });

  test('squeal needs slip AND speed', () => {
    expect(tyreState({ speed: 25, wetness: 0, slip: 0.4, handbrake: false, grounded: 1 }).squealLevel).toBe(0);
    expect(tyreState({ speed: 1, wetness: 0, slip: 4, handbrake: false, grounded: 1 }).squealLevel).toBe(0);
    const s = tyreState({ speed: 25, wetness: 0, slip: 4, handbrake: false, grounded: 1 });
    expect(s.squealLevel).toBeGreaterThan(0.4);
    expect(s.squealHz).toBeGreaterThan(900);
  });

  test('handbrake squeals on its own', () => {
    const hb = tyreState({ speed: 18, wetness: 0, slip: 0, handbrake: true, grounded: 1 });
    expect(hb.squealLevel).toBeGreaterThan(0.3);
  });

  test('airborne wheels make no tyre noise', () => {
    const air = tyreState({ speed: 25, wetness: 0.5, slip: 3, handbrake: true, grounded: 0 });
    expect(air.rollLevel).toBe(0);
    expect(air.sprayLevel).toBe(0);
    expect(air.squealLevel).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('siren', () => {
  test('two-tone holds two plateaus and glides between them', () => {
    const s = SIREN_SPECS.twoTone;
    const samples: number[] = [];
    for (let i = 0; i < 400; i++) samples.push(sirenFrequencyAt((i / 400) * s.periodSec, 'twoTone'));
    const lo = Math.min(...samples);
    const hi = Math.max(...samples);
    expect(lo).toBeCloseTo(s.lowHz, 1);
    expect(hi).toBeCloseTo(s.highHz, 1);
    // Plateaus: a good chunk of the cycle sits within 1 Hz of an endpoint.
    const atPlateau = samples.filter((f) => Math.abs(f - lo) < 1 || Math.abs(f - hi) < 1).length;
    expect(atPlateau / samples.length).toBeGreaterThan(0.55);
    // And the glide is continuous — no step bigger than 8 Hz per sample.
    for (let i = 1; i < samples.length; i++) {
      expect(Math.abs(samples[i] - samples[i - 1])).toBeLessThan(9);
    }
  });

  test('the sweep is periodic and continuous across the wrap', () => {
    for (const mode of ['wail', 'yelp'] as const) {
      const p = SIREN_SPECS[mode].periodSec;
      expect(sirenFrequencyAt(0, mode)).toBeCloseTo(sirenFrequencyAt(p, mode), 4);
      expect(sirenFrequencyAt(p * 0.999, mode)).toBeCloseTo(sirenFrequencyAt(0, mode), 0);
    }
  });

  test('yelp cycles more than ten times faster than a wail', () => {
    expect(SIREN_SPECS.wail.periodSec / SIREN_SPECS.yelp.periodSec).toBeGreaterThan(10);
  });

  test('star count escalates the siren mode', () => {
    expect(sirenModeForStars(1)).toBe('twoTone');
    expect(sirenModeForStars(3)).toBe('twoTone');
    expect(sirenModeForStars(4)).toBe('wail');
    expect(sirenModeForStars(5)).toBe('yelp');
  });

  test('doppler raises the pitch on approach and lowers it on departure', () => {
    // Source 30 m ahead on +Z, moving away at 30 m/s.
    const away = dopplerFactor(0, 0, 30, 0, 0, 30, 0, 0, 0);
    const toward = dopplerFactor(0, 0, 30, 0, 0, -30, 0, 0, 0);
    expect(away).toBeLessThan(1);
    expect(toward).toBeGreaterThan(1);
    expect(away).toBeCloseTo(343 / 373, 3);
    // A listener chasing the source also shifts it up.
    expect(dopplerFactor(0, 0, 30, 0, 0, 0, 0, 0, 30)).toBeGreaterThan(1);
    // Stationary everything => no shift.
    expect(dopplerFactor(0, 0, 30, 0, 0, 0, 0, 0, 0)).toBe(1);
    // Clamped against physics glitches.
    expect(dopplerFactor(0, 0, 1, 0, 0, -400, 0, 0, 0)).toBeLessThanOrEqual(1.4);
  });

  test('ratioToCents matches the equal-tempered definition', () => {
    expect(ratioToCents(2)).toBeCloseTo(1200, 6);
    expect(ratioToCents(1)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('synthesised SFX bank', () => {
  test('every id renders a finite, non-silent, non-clipping buffer', () => {
    for (const id of SFX_IDS) {
      const b = renderSfx(id, SR, new Rng(`test:${id}`));
      expect(b.length).toBeGreaterThan(SR * 0.05);
      const p = peak(b);
      const r = rms(b);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(0.05);
      expect(p).toBeLessThanOrEqual(1.0001);
      expect(r).toBeGreaterThan(0.002);
      for (let i = 0; i < b.length; i += 97) expect(Number.isNaN(b[i])).toBe(false);
    }
  });

  test('renderers are deterministic for a given seed', () => {
    const a = renderSfx('impact_heavy', SR, new Rng('seed-x'));
    const b = renderSfx('impact_heavy', SR, new Rng('seed-x'));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 313) expect(a[i]).toBe(b[i]);
  });

  test('impacts get longer and louder with severity', () => {
    const light = renderSfx('impact_light', SR, new Rng('a'));
    const heavy = renderSfx('impact_heavy', SR, new Rng('a'));
    expect(heavy.length).toBeGreaterThan(light.length * 2);
    // Both normalise to the same peak; severity shows up as duration and as
    // low-frequency mass (the body boom sweeps lower on a big hit).
    const head = (b: Float32Array) => rms(b.subarray(0, Math.round(SR * 0.15)));
    const energy = (b: Float32Array) => rms(b) ** 2 * b.length;
    expect(head(heavy)).toBeGreaterThan(head(light));
    expect(energy(heavy)).toBeGreaterThan(energy(light) * 1.4);
    // And a deeper body boom: more absolute energy in the 40-60 Hz band.
    const lowEnergy = (b: Float32Array) => (goertzel(b, SR, 42) + goertzel(b, SR, 60)) * b.length;
    expect(lowEnergy(heavy)).toBeGreaterThan(lowEnergy(light) * 1.4);
  });

  test('impact has a genuine transient — it peaks early and decays', () => {
    const b = renderSfx('impact_medium', SR, new Rng('t'));
    const head = rms(b.subarray(0, Math.round(SR * 0.03)));
    const tail = rms(b.subarray(Math.round(SR * 0.5)));
    expect(head).toBeGreaterThan(tail * 3);
  });

  test('glass is far brighter than a body impact', () => {
    const spec = (b: Float32Array) => {
      const mag = new Float32Array(256);
      for (let i = 0; i < mag.length; i++) mag[i] = goertzel(b, SR, (i + 1) * (SR / 2 / 256));
      return spectralCentroid(mag, SR);
    };
    const glass = spec(renderSfx('impact_glass', SR, new Rng('g')));
    const body = spec(renderSfx('impact_heavy', SR, new Rng('g')));
    expect(glass).toBeGreaterThan(body * 1.5);
  });

  test('the Dacia cough is a starter, two misfires and a catch', () => {
    const b = renderSfx('dacia_cough', SR, new Rng('cough'));
    expect(b.length / SR).toBeCloseTo(2.05, 1);
    const win = (t0: number, t1: number) => rms(b.subarray(Math.round(SR * t0), Math.round(SR * t1)));
    // Starter cranking from the start.
    expect(win(0.05, 0.35)).toBeGreaterThan(0.02);
    // Both failed catches are louder than the plain crank around them.
    expect(win(0.42, 0.62)).toBeGreaterThan(win(0.2, 0.35));
    expect(win(0.88, 1.1)).toBeGreaterThan(win(0.7, 0.85));
    // The catch is the loudest part of the whole buffer.
    expect(win(1.3, 1.6)).toBeGreaterThan(win(0.05, 1.25));
    // The very end fades out so the live engine voice can take over.
    expect(win(2.0, 2.05)).toBeLessThan(win(1.3, 1.6) * 0.35);
  });

  test('footsteps are short and the wet variant has a longer bright tail', () => {
    const dry = renderSfx('footstep', SR, new Rng('f'));
    const wet = renderSfx('footstep_wet', SR, new Rng('f'));
    expect(dry.length / SR).toBeLessThan(0.2);
    expect(wet.length).toBeGreaterThan(dry.length);
    const tail = (b: Float32Array) => rms(b.subarray(Math.round(b.length * 0.6)));
    expect(tail(wet)).toBeGreaterThan(tail(dry));
  });

  test('the horn is harmonic — energy on integer multiples of ~400 Hz', () => {
    const b = renderSfx('horn', SR, new Rng('h'));
    const f = 400;
    const fundamental = goertzel(b, SR, f);
    expect(fundamental).toBeGreaterThan(0.008);
    expect(goertzel(b, SR, f * 2)).toBeGreaterThan(0.004);
    expect(goertzel(b, SR, f * 3)).toBeGreaterThan(0.002);
    // Between the partials there is nothing.
    expect(goertzel(b, SR, f * 1.5)).toBeLessThan(fundamental * 0.6);
  });

  test('explosion is low-frequency dominant and long', () => {
    const b = renderSfx('explosion', SR, new Rng('e'));
    expect(b.length / SR).toBeGreaterThan(2);
    const low = goertzel(b, SR, 45);
    const high = goertzel(b, SR, 6000);
    expect(low).toBeGreaterThan(high * 5);
  });

  test('the scrape loop is seamless — both ends fade to silence', () => {
    const b = renderSfx('scrape', SR, new Rng('s'));
    const edge = Math.round(SR * 0.002);
    expect(Math.abs(b[0])).toBeLessThan(0.02);
    expect(Math.abs(b[b.length - 1])).toBeLessThan(0.02);
    expect(rms(b.subarray(0, edge))).toBeLessThan(rms(b) * 0.5);
  });

  test('the mission stings are pitched, not noise', () => {
    const b = renderSfx('mission_complete', SR, new Rng('m'));
    // Root of the Romanian-minor sting: G3 = 196 Hz.
    expect(goertzel(b, SR, 196)).toBeGreaterThan(0.01);
  });

  test('star_up rises and star_down falls', () => {
    const spec = (b: Float32Array, from: number, to: number) => {
      const seg = b.subarray(Math.round(b.length * from), Math.round(b.length * to));
      const mag = new Float32Array(128);
      for (let i = 0; i < mag.length; i++) mag[i] = goertzel(seg, SR, (i + 1) * 20);
      return spectralCentroid(mag, SR);
    };
    const up = renderSfx('star_up', SR, new Rng('u'));
    const down = renderSfx('star_down', SR, new Rng('d'));
    expect(spec(up, 0.5, 0.8)).toBeGreaterThan(spec(up, 0, 0.15));
    expect(spec(down, 0.5, 0.8)).toBeLessThan(spec(down, 0, 0.15));
  });
});

describe('ambience loops', () => {
  test('rain is high-frequency dominant, traffic is low', () => {
    const rain = renderRainLoop(SR, 1.5, new Rng('rain'));
    const traffic = renderTrafficLoop(SR, 1.5, new Rng('traffic'));
    const ratio = (b: Float32Array) => goertzel(b, SR, 4000) / Math.max(1e-6, goertzel(b, SR, 90));
    expect(ratio(rain)).toBeGreaterThan(ratio(traffic) * 20);
  });

  test('crowd sits in the speech band', () => {
    const c = renderCrowdLoop(SR, 2, new Rng('crowd'));
    const speech = goertzel(c, SR, 900);
    const sub = goertzel(c, SR, 60);
    const air = goertzel(c, SR, 9000);
    expect(speech).toBeGreaterThan(sub);
    expect(speech).toBeGreaterThan(air);
  });

  test('loops end where they began, so they do not click', () => {
    for (const mk of [renderRainLoop, renderTrafficLoop, renderCrowdLoop]) {
      const b = mk(SR, 2, new Rng('loop'));
      // A loop point clicks when the last and first samples differ a lot; the
      // crossfade in renderNoiseLoop keeps that below a tenth of full scale.
      expect(Math.abs(b[b.length - 1] - b[0])).toBeLessThan(0.35);
      expect(peak(b)).toBeLessThanOrEqual(1.0001);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Ce Ne Enervează clip assignment', () => {
  test('the manifest yields all 79 voice clips', () => {
    expect(CLIPS.size).toBe(79);
  });

  test('EVERY clip is used somewhere — nothing sits on disk unheard', () => {
    const assigned = assignedKeys();
    const unused = [...CLIPS.keys()].filter((k) => !assigned.has(k));
    expect(unused).toEqual([]);
  });

  test('every bucket entry resolves to a real manifest file', () => {
    for (const [name, keys] of Object.entries(VO_BUCKETS)) {
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) {
        expect(CLIPS.has(k), `${name} -> ${k}`).toBe(true);
      }
    }
  });

  test('every clip has a subtitle with real content', () => {
    for (const c of CLIPS.values()) {
      expect(c.text.length).toBeGreaterThan(1);
      expect(c.file.endsWith('.mp3')).toBe(true);
    }
  });

  test('the free-roam chatter pool is broad, not three token clips', () => {
    expect(bucket('idle').length).toBeGreaterThanOrEqual(30);
  });

  test('phrases are matched to context, not assigned at random', () => {
    const has = (b: Parameters<typeof bucket>[0], phrase: string) =>
      bucket(b).some((c) => c.phrase.includes(phrase));
    // "move along please" belongs with police pressure
    expect(has('police', 'circulati va rog')).toBe(true);
    expect(has('star2', 'circulati va rog')).toBe(true);
    // "we are catastrophes" belongs with crashes and failure
    expect(has('crash', 'suntem niste catastrofe')).toBe(true);
    expect(has('missionFailed', 'suntem niste catastrofe')).toBe(true);
    // "greetings patriots, wake up" is a station ident
    expect(has('stationIdent', 'salutare patrioti treziti va')).toBe(true);
    // "mici si bere" is idle chatter
    expect(has('idle', 'mici si bere')).toBe(true);
    // "Denmark was called Dacia" on the Dacia's first start
    expect(has('daciaFirstStart', 'danemarca se numea dacia')).toBe(true);
    // the puppet/marionette material belongs to the broadcast hijack
    expect(has('broadcast', 'marionete masonice')).toBe(true);
    expect(has('broadcast', 'globalist puppets')).toBe(true);
    // escalation reads as escalation
    expect(has('star1', 'ce este cu aceasta debandada')).toBe(true);
    expect(has('star5', 'aici nu se mai poate trai')).toBe(true);
  });

  test('the long "complete" cuts are marked long and used as show segments', () => {
    const longs = [...CLIPS.values()].filter((c) => c.long);
    expect(longs.length).toBe(3);
    for (const c of longs) expect(bucketsFor(c.key)).toContain('showSegment');
  });

  test('star buckets escalate monotonically and are all populated', () => {
    for (const b of ['star1', 'star2', 'star3', 'star4', 'star5'] as const) {
      expect(bucket(b).length).toBeGreaterThan(0);
    }
  });

  test('the folk track is the manifest music entry', () => {
    expect(FOLK_TRACK).toBe('audio/music/fecioreasca-de-pe-mures-dumitru-farcas.mp3');
  });
});

describe('mix defaults', () => {
  test('every bus starts audible and below unity headroom', () => {
    for (const [k, v] of Object.entries(DEFAULT_MIX)) {
      if (k === 'muted') {
        expect(v).toBe(false);
        continue;
      }
      expect(v as number).toBeGreaterThan(0.5);
      expect(v as number).toBeLessThanOrEqual(1);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('envelope timing of pre-rendered one-shots', () => {
  test('applyEnvelope silences the very end of a buffer', () => {
    const b = new Float32Array(SR);
    additive(b, SR, [[440, 1]]);
    applyEnvelope(b, SR, { attack: 0.01, decay: 0.1, sustain: 0.4, duration: 1, release: 0.2 });
    expect(Math.abs(b[b.length - 1])).toBeLessThan(1e-3);
    expect(rms(b.subarray(0, SR / 10))).toBeGreaterThan(rms(b.subarray(SR - SR / 10)));
  });

  test('suspension knock is under a quarter second', () => {
    const b = renderSfx('suspension_knock', SR, new Rng('k'));
    expect(b.length / SR).toBeLessThanOrEqual(0.25);
    expect(goertzel(b, SR, 60)).toBeGreaterThan(goertzel(b, SR, 4000));
  });

  test('thunder rolls for over three seconds and stays sub-300 Hz', () => {
    const b = renderSfx('thunder', SR, new Rng('th'));
    expect(b.length / SR).toBeGreaterThan(3);
    expect(goertzel(b, SR, 70)).toBeGreaterThan(goertzel(b, SR, 2000) * 5);
  });
});
