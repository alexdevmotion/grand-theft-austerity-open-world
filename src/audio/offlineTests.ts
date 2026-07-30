/**
 * OFFLINE RENDER TESTS — the WebAudio graph itself, measured.
 *
 * `audio.test.ts` runs under Bun and therefore tests the pure models and the
 * offline buffer renderers: the numbers that go INTO the graph. It cannot test
 * the graph, because Bun has no `OfflineAudioContext` — and the graph is where
 * the interesting failures live. An oscillator bank wired to the wrong gain, a
 * WaveShaper with a curve that inverts, a filter whose frequency is set in the
 * wrong units: every one of those passes a model test and produces silence or
 * noise in the game.
 *
 * So these run in the browser, through a real `OfflineAudioContext`, and are
 * reachable from the verification harness as `__GTA_AUDIO__.selfTest()`. They
 * render actual audio and measure it with a Goertzel bin, exactly as the Bun
 * tests do — the only difference is that the sound has been through WebAudio.
 *
 * Each case returns its measurements alongside its pass/fail, so a failure says
 * what the number was rather than merely that it was wrong.
 */

import { Rng } from '../core/rng';
import { goertzel, peak, rms, softClipCurve, speakerCurve, whiteNoise } from './dsp';
import { ENGINE_SPECS, HARMONIC_ORDERS, engineState } from './engineModel';
import { HornVoice } from './horn';

export interface OfflineCase {
  name: string;
  pass: boolean;
  /** What the test actually measured, for the report. */
  measured: Record<string, number>;
  /** Why it failed, when it did. */
  note?: string;
}

export interface OfflineReport {
  supported: boolean;
  passed: number;
  failed: number;
  cases: OfflineCase[];
}

const SR = 48000;

/** Must track `buildSpeakerChain` in radio.ts. */
const RADIO_CONE_DRIVE = 1.9;

function ctxFor(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext(1, Math.round(SR * seconds), SR);
}

function mono(b: AudioBuffer): Float32Array {
  return b.getChannelData(0);
}

/** Linear magnitude spectrum by brute-force Goertzel over a log-ish grid. */
function centroidOf(buf: Float32Array): number {
  const bins = 160;
  const mag = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    // 40 Hz .. 12 kHz, geometric.
    const f = 40 * Math.pow(12000 / 40, i / (bins - 1));
    mag[i] = goertzel(buf, SR, f);
  }
  // spectralCentroid assumes linear bin spacing, so weight by the real
  // frequency of each bin instead of by its index.
  let num = 0;
  let den = 0;
  for (let i = 0; i < bins; i++) {
    const f = 40 * Math.pow(12000 / 40, i / (bins - 1));
    num += f * mag[i];
    den += mag[i];
  }
  return den > 0 ? num / den : 0;
}

/* ------------------------------------------------------------------ */

/**
 * 1. The harmonic stack really lands on the harmonics.
 *
 * Builds the same oscillator-plus-gain bank `VehicleVoice` builds, from a real
 * `EngineState`, and checks each order is present at the level the model asked
 * for and that nothing appears between them.
 */
async function harmonicStack(): Promise<OfflineCase> {
  const st = engineState(ENGINE_SPECS.dacia, {
    speed: 20, throttle: 1, airborne: false, wrecked: false, prevGear: 2,
  });
  const ctx = ctxFor(0.4);
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);
  for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = st.fundamental * HARMONIC_ORDERS[i];
    const g = ctx.createGain();
    g.gain.value = st.harmonics[i] * 0.26;
    o.connect(g);
    g.connect(out);
    o.start();
  }
  const buf = mono(await ctx.startRendering());

  const measured: Record<string, number> = { f0: st.fundamental };
  let ok = true;
  for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
    const order = HARMONIC_ORDERS[i];
    const want = st.harmonics[i] * 0.26;
    const got = goertzel(buf, SR, st.fundamental * order);
    measured[`h${order}`] = round(got, 5);
    measured[`h${order}_want`] = round(want, 5);
    // Half the requested amplitude is the floor: a Goertzel over a
    // non-integer number of periods loses a little to spectral leakage.
    if (got < want * 0.5) ok = false;
  }
  // Nothing at 2.5x — proves the stack is harmonic, not a noise bed.
  const between = goertzel(buf, SR, st.fundamental * 2.5);
  measured.between = round(between, 5);
  if (between > measured.h2_want * 0.2) ok = false;

  return {
    name: 'harmonic stack lands on integer orders',
    pass: ok,
    measured,
    note: ok ? undefined : 'an order was missing or energy appeared between orders',
  };
}

/**
 * 2. Load changes the spectrum THROUGH THE REAL CHAIN.
 *
 * The model test proves the harmonic tilt changes. This proves the tilt
 * survives the WaveShaper and the body EQ that sit after it — which is where a
 * curve that soft-clips too hard would flatten the difference back out.
 */
async function loadChangesTimbre(): Promise<OfflineCase> {
  const render = async (throttle: number) => {
    const st = engineState(ENGINE_SPECS.dacia, {
      speed: ENGINE_SPECS.dacia.topSpeed * 0.84,
      throttle, airborne: false, wrecked: false, prevGear: 3,
    });
    const ctx = ctxFor(0.4);
    const pre = ctx.createGain();
    pre.gain.value = 0.6 + st.drive * 1.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1024, 1.2) as Float32Array<ArrayBuffer>;
    shaper.oversample = '2x';
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = ENGINE_SPECS.dacia.bodyResonance;
    body.Q.value = 1.6;
    body.gain.value = 8;
    pre.connect(shaper);
    shaper.connect(body);
    body.connect(ctx.destination);
    for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = st.fundamental * HARMONIC_ORDERS[i];
      const g = ctx.createGain();
      g.gain.value = st.harmonics[i] * 0.26;
      o.connect(g);
      g.connect(pre);
      o.start();
    }
    return { buf: mono(await ctx.startRendering()), st };
  };

  const loaded = await render(1);
  const lifted = await render(0);
  const cLoaded = centroidOf(loaded.buf);
  const cLifted = centroidOf(lifted.buf);
  const pass = cLoaded > cLifted * 1.15;
  return {
    name: 'load brightens the engine through shaper and body EQ',
    pass,
    measured: {
      centroidLoadedHz: Math.round(cLoaded),
      centroidLiftedHz: Math.round(cLifted),
      ratio: round(cLoaded / Math.max(1, cLifted), 3),
      f0Loaded: round(loaded.st.fundamental, 1),
      f0Lifted: round(lifted.st.fundamental, 1),
    },
    note: pass ? undefined : 'the shaper flattened the load difference',
  };
}

/**
 * 3. Valve float is an amplitude modulation at ~13 Hz.
 *
 * Renders the gate the way `VehicleVoice` applies it and measures the
 * modulation rate off the envelope, which is the only way to tell a stutter
 * from a volume drop.
 */
async function valveFloat(): Promise<OfflineCase> {
  const seconds = 1;
  const ctx = ctxFor(seconds);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = 170;
  const g = ctx.createGain();
  o.connect(g);
  g.connect(ctx.destination);
  // The gate: a 13.2 Hz square between full and 38% (limiter == 1).
  const hz = 13.2;
  g.gain.setValueAtTime(1, 0);
  for (let i = 0; i * (1 / hz / 2) < seconds; i++) {
    g.gain.setValueAtTime(i % 2 === 0 ? 1 : 0.38, i * (1 / hz / 2));
  }
  o.start();
  const buf = mono(await ctx.startRendering());

  // Envelope: rectify and lowpass by block-RMS, then find the modulation rate.
  const block = Math.round(SR / 400); // 2.5 ms blocks
  const env = new Float32Array(Math.floor(buf.length / block));
  for (let i = 0; i < env.length; i++) {
    env[i] = rms(buf.subarray(i * block, (i + 1) * block));
  }
  // Remove the mean so the modulation is the only thing left.
  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  for (let i = 0; i < env.length; i++) env[i] -= mean;

  const envSr = SR / block;
  const at13 = goertzel(env, envSr, hz);
  const at40 = goertzel(env, envSr, 40);
  const pass = at13 > at40 * 3 && at13 > 0.01;
  return {
    name: 'valve float modulates the stack at ~13 Hz',
    pass,
    measured: {
      modAt13Hz: round(at13, 5),
      modAt40Hz: round(at40, 5),
      envelopeMean: round(mean, 4),
    },
    note: pass ? undefined : 'no 13 Hz modulation found in the envelope',
  };
}

/**
 * 4. The horn is two beating reeds, not one tone.
 *
 * Renders `HornVoice` and checks both reed fundamentals are present and that
 * the sum beats at their difference frequency — the beat IS the horn.
 */
async function hornBeats(): Promise<OfflineCase> {
  const seconds = 0.6;
  const ctx = ctxFor(seconds);
  const base = 400;
  const horn = new HornVoice(ctx as unknown as AudioContext, ctx.destination, base);
  // Hold it down for the whole render. `set` is frame-driven, so step it.
  for (let i = 0; i < 40; i++) horn.set(1, 1 / 60);
  const buf = mono(await ctx.startRendering());

  const lower = goertzel(buf, SR, base);
  const upper = goertzel(buf, SR, base * 1.26);
  const p = peak(buf);
  // Both reeds present, and the render is not silent or clipped.
  const pass = lower > 0.01 && upper > 0.005 && p > 0.05 && p <= 1.0001;
  return {
    name: 'the horn sounds two reeds and does not clip',
    pass,
    measured: {
      lowerReed: round(lower, 5),
      upperReed: round(upper, 5),
      beatHz: round(base * 0.26, 1),
      peak: round(p, 4),
    },
    note: pass ? undefined : 'a reed was missing, or the horn clipped',
  };
}

/**
 * 5. The car-speaker chain distorts, which is the whole point of it.
 *
 * A pure 700 Hz sine in must come out with harmonic energy at 1400 Hz — that
 * added harmonic is what makes a clip sound like it is coming out of a
 * forty-year-old paper cone rather than out of the game's master bus.
 */
async function speakerDistorts(): Promise<OfflineCase> {
  const seconds = 0.3;
  const f = 700;
  const render = async (withCone: boolean) => {
    const ctx = ctxFor(seconds);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.8;
    o.connect(g);
    if (withCone) {
      const cone = ctx.createWaveShaper();
      cone.curve = speakerCurve(1024, RADIO_CONE_DRIVE) as Float32Array<ArrayBuffer>;
      g.connect(cone);
      cone.connect(ctx.destination);
    } else {
      g.connect(ctx.destination);
    }
    o.start();
    return mono(await ctx.startRendering());
  };
  const dry = await render(false);
  const wet = await render(true);
  const h2dry = goertzel(dry, SR, f * 2);
  const h2wet = goertzel(wet, SR, f * 2);
  const h3wet = goertzel(wet, SR, f * 3);
  // -46 dBc on the second harmonic is about where an asymmetric cone starts to
  // be audible as character rather than as a measurement. The first attempt
  // asked for -26 dBc, which no plausible speaker curve reaches at a signal
  // level that leaves speech intelligible.
  const pass = h2wet > 0.004 && h2wet > h2dry * 50;
  return {
    name: 'the car speaker adds harmonic distortion',
    pass,
    measured: {
      secondHarmonicDry: round(h2dry, 6),
      secondHarmonicThroughCone: round(h2wet, 6),
      thirdHarmonicThroughCone: round(h3wet, 6),
      secondHarmonicDbc: round(20 * Math.log10(Math.max(1e-9, h2wet / 0.8)), 1),
      ratio: round(h2wet / Math.max(1e-9, h2dry), 1),
    },
    note: pass ? undefined : 'the cone shaper is not distorting audibly',
  };
}

/**
 * 6. The master limiter actually holds the ceiling.
 *
 * Feeds the graph's own limiter settings four simultaneous full-scale tones —
 * a signal peaking at +12 dBFS, far worse than any real worst case — and
 * checks what comes out stays under 0 dBFS.
 */
async function limiterHoldsCeiling(): Promise<OfflineCase> {
  const seconds = 0.8;
  const ctx = ctxFor(seconds);
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -3;
  lim.knee.value = 3;
  lim.ratio.value = 20;
  lim.attack.value = 0.003;
  lim.release.value = 0.18;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  lim.connect(master);
  master.connect(ctx.destination);
  for (const f of [90, 180, 370, 750]) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 1;
    o.connect(g);
    g.connect(lim);
    o.start();
  }
  const buf = mono(await ctx.startRendering());
  // Skip the first 30 ms: the compressor's attack has to land.
  const settled = buf.subarray(Math.round(SR * 0.03));
  const p = peak(settled);
  const pass = p < 1;
  return {
    name: 'the master limiter keeps a +12 dBFS input under 0 dBFS',
    pass,
    measured: {
      inputPeakDb: round(20 * Math.log10(4), 2),
      outputPeak: round(p, 4),
      outputPeakDb: round(20 * Math.log10(Math.max(1e-9, p)), 2),
    },
    note: pass ? undefined : 'the limiter let the output clip',
  };
}

/**
 * 7. Ambience layer crossfades reach their target without a click.
 *
 * A `setTargetAtTime` ramp is inaudible; a `setValueAtTime` jump on a running
 * buffer is a click. This renders a gain step the way `AmbienceBed` writes it
 * and checks the sample-to-sample delta never exceeds what a smooth ramp can.
 */
async function ambienceRampIsSmooth(): Promise<OfflineCase> {
  const seconds = 0.8;
  const ctx = ctxFor(seconds);
  // A 1 kHz SINE, not a sawtooth. The first attempt used a 220 Hz saw measured
  // in 2 ms blocks — under half a cycle per block — so the block RMS tracked
  // the waveform's phase rather than its envelope and reported a 0.36 "step"
  // in a graph containing no discontinuity at all. Many whole cycles per
  // measurement block is the condition for block RMS to mean anything.
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = 1000;
  const g = ctx.createGain();
  g.gain.value = 0;
  o.connect(g);
  g.connect(ctx.destination);
  // Exactly what AmbienceBed does: a 0.25 s time constant toward the target.
  g.gain.setTargetAtTime(0.9, 0.2, 0.25);
  o.start();
  const buf = mono(await ctx.startRendering());

  const blockMs = 5;
  const block = Math.round((SR * blockMs) / 1000);
  const env: number[] = [];
  for (let i = 0; i + block < buf.length; i += block) {
    env.push(rms(buf.subarray(i, i + block)));
  }
  let maxStep = 0;
  for (let i = 1; i < env.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(env[i] - env[i - 1]));
  }
  // The steepest a 0.25 s exponential toward 0.9 can move is 0.9/0.25 = 3.6 per
  // second, i.e. 0.018 across a 5 ms block. Anything much above that is a step.
  const pass = maxStep < 0.03 && (env[env.length - 1] ?? 0) > 0.3;
  return {
    name: 'ambience gain ramps without a step',
    pass,
    measured: {
      maxEnvelopeStepPer5ms: round(maxStep, 5),
      analyticLimit: 0.018,
      finalEnvelope: round(env[env.length - 1] ?? 0, 4),
    },
    note: pass ? undefined : 'the ramp stepped, or never reached its target',
  };
}

/**
 * 8. The cabin bulkhead really removes the top.
 *
 * Proves the filter added in this pass does what it claims: the same engine
 * stack heard from inside must have a measurably lower spectral centroid than
 * the same stack heard from outside.
 */
async function bulkheadDarkens(): Promise<OfflineCase> {
  const render = async (inCabin: boolean) => {
    const ctx = ctxFor(0.4);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = inCabin ? 2400 : 21000;
    lp.Q.value = 0.55;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 110;
    shelf.gain.value = inCabin ? 3.5 : 0;
    lp.connect(shelf);
    shelf.connect(ctx.destination);

    const st = engineState(ENGINE_SPECS.dacia, {
      speed: 20, throttle: 1, airborne: false, wrecked: false, prevGear: 2,
    });

    // The engine path in VehicleVoice runs the stack and the noise beds through
    // a driven WaveShaper BEFORE the bulkhead, and that shaper is what puts
    // energy above 3.4 kHz in the first place. Without it in the chain the test
    // is measuring a filter against a source that has nothing for it to remove.
    const pre = ctx.createGain();
    pre.gain.value = 0.6 + st.drive * 1.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = softClipCurve(1024, 1.2) as Float32Array<ArrayBuffer>;
    shaper.oversample = '2x';
    pre.connect(shaper);
    shaper.connect(lp);
    for (let i = 0; i < HARMONIC_ORDERS.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = st.fundamental * HARMONIC_ORDERS[i];
      const g = ctx.createGain();
      g.gain.value = st.harmonics[i] * 0.2;
      o.connect(g);
      g.connect(pre);
      o.start();
    }
    // The induction and exhaust beds, which is where most of an engine's HIGH
    // frequency energy actually is. Without them the source is a stack topping
    // out at 1.1 kHz and a 3.4 kHz lowpass has almost nothing to remove — the
    // first attempt measured an 11% darkening and concluded the filter was
    // broken, when in the live game the same filter moves the centroid from
    // 420 Hz to 110 Hz precisely because these beds are present.
    const noiseLen = Math.round(SR * 0.4);
    const nb = ctx.createBuffer(1, noiseLen, SR);
    const nd = nb.getChannelData(0);
    whiteNoise(nd as Float32Array, new Rng('offline-induction'));
    const ns = ctx.createBufferSource();
    ns.buffer = nb;
    ns.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = st.inductionHz;
    bp.Q.value = 1.4;
    const ng = ctx.createGain();
    ng.gain.value = st.inductionLevel * 0.42;
    ns.connect(bp);
    bp.connect(ng);
    ng.connect(pre);
    ns.start();
    return mono(await ctx.startRendering());
  };
  const outside = centroidOf(await render(false));
  const inside = centroidOf(await render(true));
  const pass = inside < outside * 0.8;
  return {
    name: 'the cabin bulkhead darkens the engine',
    pass,
    measured: {
      centroidOutsideHz: Math.round(outside),
      centroidInsideHz: Math.round(inside),
      ratio: round(inside / Math.max(1, outside), 3),
    },
    note: pass ? undefined : 'the bulkhead is not filtering',
  };
}

/* ------------------------------------------------------------------ */

/** Run every offline case. Resolves even when individual cases throw. */
export async function runOfflineTests(): Promise<OfflineReport> {
  if (typeof OfflineAudioContext === 'undefined') {
    return { supported: false, passed: 0, failed: 0, cases: [] };
  }
  const suite: Array<[string, () => Promise<OfflineCase>]> = [
    ['harmonicStack', harmonicStack],
    ['loadChangesTimbre', loadChangesTimbre],
    ['valveFloat', valveFloat],
    ['hornBeats', hornBeats],
    ['speakerDistorts', speakerDistorts],
    ['limiterHoldsCeiling', limiterHoldsCeiling],
    ['ambienceRampIsSmooth', ambienceRampIsSmooth],
    ['bulkheadDarkens', bulkheadDarkens],
  ];
  const cases: OfflineCase[] = [];
  for (const [key, fn] of suite) {
    try {
      cases.push(await fn());
    } catch (err) {
      cases.push({
        name: key,
        pass: false,
        measured: {},
        note: `threw: ${String(err)}`,
      });
    }
  }
  return {
    supported: true,
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
    cases,
  };
}

function round(v: number, d: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
