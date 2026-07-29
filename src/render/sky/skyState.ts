/** Time-of-day and weather state for the sky.
 *
 *  The whole look is a blend between six authored keyframes indexed by solar
 *  elevation, so a single `timeOfDay` scrub carries the sky from a blue
 *  afternoon through the magenta-orange hero sunset into a starry night without
 *  any discontinuity. The `golden` keyframe IS the reference frame, and the
 *  solar model is fitted so that `timeOfDay === HERO_HOUR` lands exactly on
 *  `HeroSun.elevationDeg` / `HeroSun.azimuthDeg` — the hero shot never drifts.
 *
 *  Weather presets are multiplicative modifiers on top of the keyframe, so a
 *  storm at noon and a storm at dusk are both plausible.
 */

import { Color, ColorManagement, MathUtils } from 'three';
import { HeroSun, Palette } from '../../artDirection';
import type { WeatherPreset } from '../../core/services';

/**
 * COLOUR SPACE NOTE — read before touching any number below.
 *
 * three's ColorManagement is enabled, so `new Color(0xff7a3c)` already decodes
 * sRGB into the linear working space. `src/artDirection.ts` then calls
 * `.convertSRGBToLinear()` on top of that, so every Palette entry arrives
 * decoded twice: red survives (1.0 stays 1.0) but green collapses ~6x
 * (0.195 -> 0.031) and blue ~13x. The practical effect is that the whole sky
 * clips into one flat red channel with nothing in G or B to make a hue — which
 * is exactly the failure this sky started from.
 *
 * artDirection.ts is not this agent's file, and rather than fight the extra
 * decode every keyframe below is authored as a plain sRGB hex through `L()`,
 * which decodes exactly once. Nothing in this file reads a Palette colour as a
 * sky band any more — see the comment on GOLDEN for why that also had to change
 * for art reasons, not just colour-space ones.
 */

/** sRGB hex -> linear working space, correct whether or not CM is enabled. */
const L = (hex: number, mul = 1): Color => {
  const c = new Color(hex);
  if (!ColorManagement.enabled) c.convertSRGBToLinear();
  return c.multiplyScalar(mul);
};

/** Direct linear RGB — used for the tint multipliers, which are not colours
 *  you can express as an sRGB hex (they exceed 1 in places). */
const LIN = (r: number, g: number, b: number): Color => new Color(r, g, b);

export interface SkyKey {
  horizon: Color;
  low: Color;
  mid: Color;
  high: Color;
  zenith: Color;
  /** Multiplicative tint applied to the anti-solar half of the dome. */
  away: Color;
  /** Multiplicative tint applied to the solar half. Kills blue so the warm
   *  half reads coral/orange instead of collapsing into the same magenta. */
  toward: Color;
  sunCore: Color;
  sunHalo: Color;
  cloudLit: Color;
  cloudMid: Color;
  cloudCore: Color;
  groundHaze: Color;
  moon: Color;
  /** What the lighting rig should use as sky ambient / IBL tint. */
  ambient: Color;
  skyIntensity: number;
  sunIntensity: number;
  haze: number;
  stars: number;
  moonAmount: number;
  /** Directional light colour + relative strength for the lighting rig. */
  sunLight: Color;
  sunPower: number;
}

const KEY = (v: SkyKey): SkyKey => v;

/* ------------------------------------------------------------------ */
/* Keyframes, ordered from high sun to deep night                      */
/* ------------------------------------------------------------------ */

const DAY = KEY({
  horizon: L(0xcfd8f0, 1.15), low: L(0x9ab0e8, 0.98), mid: L(0x6a86dc, 0.78),
  high: L(0x4a68cc, 0.60), zenith: L(0x2a46a8, 0.45),
  away: LIN(0.92, 0.95, 1.06), toward: LIN(1.04, 1.0, 0.96),
  sunCore: L(0xfffaf0, 90), sunHalo: L(0xffe8c8, 0.85),
  cloudLit: L(0xffffff, 1.75), cloudMid: L(0xd8dcf0, 0.95), cloudCore: L(0x7a86b0, 0.48),
  groundHaze: L(0x8a94b8, 0.42), moon: L(0xcfd8ff, 1),
  ambient: L(0x9ab4e8, 1),
  skyIntensity: 1, sunIntensity: 1, haze: 0.5, stars: 0, moonAmount: 0,
  sunLight: L(0xfff2dd, 1), sunPower: 1.35,
});

const AFTERNOON = KEY({
  horizon: L(0xffbe8c, 1.45), low: L(0xf49aa6, 0.80), mid: L(0xb078c0, 0.58),
  high: L(0x6a62b0, 0.47), zenith: L(0x2c3a7a, 0.35),
  away: LIN(0.72, 0.88, 1.28), toward: LIN(1.16, 0.98, 0.70),
  sunCore: L(0xfff4e4, 70), sunHalo: L(0xffc890, 0.85),
  cloudLit: L(0xffd8b8, 1.55), cloudMid: L(0xc89ab8, 0.76), cloudCore: L(0x5a4c80, 0.35),
  groundHaze: L(0x6a5a80, 0.40), moon: L(0xcfd8ff, 1),
  ambient: L(0x8a7ab8, 1),
  skyIntensity: 1, sunIntensity: 1, haze: 0.78, stars: 0, moonAmount: 0,
  sunLight: L(0xffd9ac, 1), sunPower: 1.15,
});

/** THE HERO. Straight out of docs/reference/house-under-siege-duo.png.
 *
 *  THIS IS A HUE LADDER, NOT A VALUE RAMP. The reference dome spans about 120
 *  degrees of hue — hot orange rip at the horizon, coral above it, magenta
 *  bands, violet, deep indigo at the zenith — and roughly the full value range.
 *  The previous authoring took five tints of one Palette hue and only varied
 *  their brightness, which measured as a 22-degree hue arc of desaturated
 *  salmon across the whole sun-facing hemisphere. Every band below is therefore
 *  written as an explicit hex with its own hue, and NOT pulled from Palette:
 *  the Palette entries are the *appearance* of the sky's peak, and five
 *  multiples of one appearance can never be a ladder.
 *
 *  Hue targets (sRGB): horizon 24, low 350, mid 322, high 268, zenith 241.
 *  Saturation is kept at or above 0.60 all the way to the top of the dome —
 *  below ~0.4 the AgX tone map plus the grade's saturation:1.14 cannot recover
 *  a hue, it just makes pale pink paler.
 */
const GOLDEN = KEY({
  /* THE HOT ORANGE RIP. Authored bright — brighter than every other band by a
   * factor of four — because in the reference the horizon IS the brightest
   * part of the sky, and because the aerial-perspective fog now converges onto
   * this same function, so this value is also what makes the far end of a
   * boulevard glow. At 0.34 it was darker than the magenta above it and the
   * frame had no warm anchor anywhere.
   *
   * Note the hue: 0xff8a3c, not 0xff6a24. A deeper orange has a G/R ratio near
   * 0.14, which after AgX's chroma inset lands as a muddy brick red, not as
   * fire. The rip needs enough green to survive to something that reads as hot. */
  horizon: L(0xff7a30, 0.95),
  low: L(0xff6a72, 0.215),      // coral / salmon
  mid: L(0xd6508e, 0.138),      // magenta
  high: L(0x6a44b4, 0.086),     // violet
  zenith: L(0x241f66, 0.150),   // deep indigo
  /* The away tint is AZURE, not violet. Measured against the reference frame,
   * its sky's chromatic pixels sit 30% in azure (hue 210) and 21% in blue
   * (240) — the cold half of that sky is a steel blue, and the violet is only
   * a minority band. Tinting the anti-solar half violet put every cool pixel
   * in the game into the same 270-300 wedge as the magenta band, which is the
   * mechanism that collapsed the whole frame onto one hue. */
  away: LIN(0.48, 0.86, 1.62), toward: LIN(1.28, 0.90, 0.50),
  /* THE SUN. 42x white, and it is meant to be. The disc is the brightest thing
   * in the game by two orders of magnitude over a lit facade; that is what a
   * golden-hour sun is. Authored near-white and left to the airmass extinction
   * in skyBands.ts to redden it — at 3 degrees of elevation that extinction
   * takes this to roughly (21, 3.9, 0.35) linear, i.e. a white-hot core inside
   * a deep orange body, and it walks to 0xff3a10 as the sun touches the
   * horizon. Authoring the disc pre-reddened instead made it a fixed beige dot
   * at every hour of the day. */
  sunCore: L(0xffe6c4, 46.0),
  sunHalo: L(0xff9450, 0.62),
  /* CLOUD RAMP — three hues roughly 110 degrees apart, chained.
   *   core  deep blue-indigo   the shadowed base, colder than the sky
   *   mid   dusty rose         the body
   *   lit   amber              the rim, which must sit ABOVE the sky band it
   *                            is seen against or it cannot read as ignited
   * cloudLit used to be 0.34 against a mid band of 0.175 — less than 2x, and
   * after the rim gate and transmittance that arrived as a smudge. */
  cloudLit: L(0xffab5c, 0.60),
  cloudMid: L(0xbe6f80, 0.150),
  cloudCore: L(0x24487e, 0.132),
  groundHaze: L(0x241838, 0.26),
  moon: L(0xcfd8ff, 1),
  ambient: L(0x7a52b0, 1),
  skyIntensity: 1, sunIntensity: 1, haze: 1, stars: 0, moonAmount: 0,
  sunLight: Palette.sunLight.clone(), sunPower: 1.0,
});

const DUSK = KEY({
  horizon: L(0xff6a26, 0.74),   // hue  18
  low: L(0xf04a6e, 0.165),      // hue 344
  mid: L(0xa03a96, 0.130),      // hue 307
  high: L(0x4e2f92, 0.125),     // hue 262
  zenith: L(0x1c1750, 0.150),   // hue 246
  away: LIN(0.46, 0.84, 1.58), toward: LIN(1.32, 0.92, 0.48),
  // Still authored near-white: the extinction is doing more work at this
  // elevation than at golden hour, and doubling up on the reddening is what
  // used to drive the disc to a hue with no green left in it at all.
  sunCore: L(0xffe0b8, 38.0), sunHalo: L(0xff7a34, 0.52),
  cloudLit: L(0xff9a4c, 0.52), cloudMid: L(0x9c5070, 0.130), cloudCore: L(0x1e3d68, 0.116),
  groundHaze: L(0x1e1630, 0.26), moon: L(0xcfd8ff, 1),
  ambient: L(0x6a4a8e, 1),
  skyIntensity: 1, sunIntensity: 1, haze: 1.05, stars: 0.16, moonAmount: 0.45,
  sunLight: L(0xff7a4a, 1), sunPower: 0.5,
});

const TWILIGHT = KEY({
  horizon: L(0xd4485e, 0.40),   // hue 350 — the last of the rip
  low: L(0x8c3570, 0.26),       // hue 313
  mid: L(0x452c6c, 0.19),       // hue 268
  high: L(0x1f1f52, 0.150), zenith: L(0x0e1130, 0.115),
  away: LIN(0.70, 0.84, 1.30), toward: LIN(1.18, 0.96, 0.72),
  sunCore: L(0xffa070, 6.0), sunHalo: L(0xc4527a, 0.32),
  cloudLit: L(0xc07890, 0.40), cloudMid: L(0x42346a, 0.17), cloudCore: L(0x101430, 0.10),
  groundHaze: L(0x1a1226, 0.26), moon: L(0xcfd8ff, 1),
  ambient: L(0x46386e, 1),
  skyIntensity: 1, sunIntensity: 1, haze: 0.9, stars: 0.62, moonAmount: 0.85,
  sunLight: L(0xa8608a, 1), sunPower: 0.12,
});

/** NIGHT.
 *
 *  A real city night sky is not black. Two things light it: a thin indigo
 *  Rayleigh floor that survives all night, and — far stronger over a capital —
 *  sodium SKYGLOW bouncing off the cloud base and haze, which reads as a dirty
 *  amber-brown band all the way round the horizon.
 *
 *  This matters far beyond the dome itself: LightingSystem's EnvProbe captures
 *  this shader into the PMREM that is the scene's ambient. When the night
 *  keyframe was authored at ~0.004 linear the probe integrated to essentially
 *  zero and every night street rendered as an unreadable black void with
 *  nothing but emissive windows in it. The bands below sit ~4x higher, and the
 *  lift is concentrated in the lower half of the dome, which is the part that
 *  actually irradiates an upward-facing road surface.
 */
const NIGHT = KEY({
  horizon: L(0xc07f42, 0.46),   // sodium skyglow, hue 30 — the warm anchor
  low: L(0x6a5a82, 0.30),       // glow fading into mauve
  mid: L(0x2a3670, 0.25),       // indigo
  high: L(0x16204e, 0.20), zenith: L(0x0d1230, 0.17),
  // Even at night the two halves must not be the same hue: the skyglow side is
  // sodium-warm, the away side is a cold blue.
  away: LIN(0.78, 0.90, 1.24), toward: LIN(1.14, 1.00, 0.82),
  sunCore: L(0xffd0a0, 0.0), sunHalo: L(0x3a3070, 0.20),
  // Cloud bases over a lit city catch the skyglow and go warm underneath.
  cloudLit: L(0xa07850, 0.44), cloudMid: L(0x2e3660, 0.19), cloudCore: L(0x0d1128, 0.11),
  groundHaze: L(0x2a2024, 0.44), moon: L(0xd6e0ff, 1),
  ambient: L(0x50466e, 1),
  skyIntensity: 1, sunIntensity: 0, haze: 0.80, stars: 1, moonAmount: 1,
  sunLight: L(0x8fa8ff, 1), sunPower: 0.05,
});

/** Keyframes with the solar elevation (degrees) they are authored for. */
const STOPS: Array<{ elev: number; key: SkyKey }> = [
  { elev: 46, key: DAY },
  { elev: 18, key: AFTERNOON },
  { elev: HeroSun.elevationDeg, key: GOLDEN },
  { elev: -3.5, key: DUSK },
  { elev: -9.5, key: TWILIGHT },
  { elev: -20, key: NIGHT },
];

/* ------------------------------------------------------------------ */
/* Solar model                                                         */
/* ------------------------------------------------------------------ */

export const HERO_HOUR = 19.4;
const SUNRISE = 6.0;
const DAY_LENGTH = 13.75;

const HERO_FRAC = (HERO_HOUR - SUNRISE) / DAY_LENGTH;
const MAX_ELEV = HeroSun.elevationDeg / Math.sin(Math.PI * HERO_FRAC);
const AZ_SPAN = 185;
const AZ_START = HeroSun.azimuthDeg - AZ_SPAN * HERO_FRAC;

export interface SunAngles {
  elevationDeg: number;
  azimuthDeg: number;
}

/** Solar elevation/azimuth for an hour of the day. Exact at HERO_HOUR. */
export function sunAnglesForTime(hours: number, out: SunAngles): SunAngles {
  let h = ((hours % 24) + 24) % 24;
  // Night wraps past midnight; keep the parametric fraction continuous.
  if (h < SUNRISE) h += 24;
  const frac = (h - SUNRISE) / DAY_LENGTH;
  out.elevationDeg = MAX_ELEV * Math.sin(Math.PI * frac);
  out.azimuthDeg = AZ_START + AZ_SPAN * frac;
  return out;
}

/* ------------------------------------------------------------------ */
/* Keyframe blending                                                   */
/* ------------------------------------------------------------------ */

export function newKey(): SkyKey {
  return {
    horizon: new Color(), low: new Color(), mid: new Color(), high: new Color(),
    zenith: new Color(), away: new Color(), toward: new Color(),
    sunCore: new Color(), sunHalo: new Color(),
    cloudLit: new Color(), cloudMid: new Color(), cloudCore: new Color(),
    groundHaze: new Color(), moon: new Color(), ambient: new Color(),
        skyIntensity: 1, sunIntensity: 1, haze: 1, stars: 0, moonAmount: 0,
    sunLight: new Color(), sunPower: 1,
  };
}

const COLOR_FIELDS = [
  'horizon', 'low', 'mid', 'high', 'zenith', 'away', 'toward', 'sunCore', 'sunHalo',
  'cloudLit', 'cloudMid', 'cloudCore', 'groundHaze', 'moon', 'ambient', 'sunLight',
] as const;

const NUMBER_FIELDS = [
  'skyIntensity', 'sunIntensity', 'haze', 'stars', 'moonAmount', 'sunPower',
] as const;

export function lerpKey(out: SkyKey, a: SkyKey, b: SkyKey, t: number): SkyKey {
  for (const f of COLOR_FIELDS) out[f].copy(a[f]).lerp(b[f], t);
  for (const f of NUMBER_FIELDS) out[f] = MathUtils.lerp(a[f], b[f], t);
  return out;
}

export function copyKey(out: SkyKey, a: SkyKey): SkyKey {
  for (const f of COLOR_FIELDS) out[f].copy(a[f]);
  for (const f of NUMBER_FIELDS) out[f] = a[f];
  return out;
}

/** Blend the authored keyframes for a solar elevation, in degrees. */
export function keyForElevation(out: SkyKey, elevationDeg: number): SkyKey {
  if (elevationDeg >= STOPS[0].elev) return copyKey(out, STOPS[0].key);
  const last = STOPS[STOPS.length - 1];
  if (elevationDeg <= last.elev) return copyKey(out, last.key);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i];
    const b = STOPS[i + 1];
    if (elevationDeg <= a.elev && elevationDeg >= b.elev) {
      const t = (a.elev - elevationDeg) / (a.elev - b.elev);
      return lerpKey(out, a.key, b.key, MathUtils.smoothstep(t, 0, 1));
    }
  }
  return copyKey(out, last.key);
}

/* ------------------------------------------------------------------ */
/* Weather                                                             */
/* ------------------------------------------------------------------ */

export interface WeatherLook {
  /** Coverage of the cirrus / alto / cumulus decks. */
  cover: [number, number, number];
  /** Multiplier on cloud brightness — storms crush it. */
  cloudDark: number;
  /** Crepuscular ray strength. */
  shafts: number;
  /** Multiplier on the whole dome. */
  skyMul: number;
  /** Multiplier on horizon haze and aerial perspective density. */
  hazeMul: number;
  /** 0..1 pull toward luminance — grey weather is desaturated weather. */
  desaturate: number;
  /** Aerial perspective density multiplier. */
  fogMul: number;
  /** Cloud drift speed multiplier. */
  wind: number;
  /** Lightning strikes per second (0 = none). */
  lightning: number;
  /** Forces night regardless of the clock. */
  forceNight: boolean;
}

const WEATHER: Record<WeatherPreset, WeatherLook> = {
  clearSunset: {
    cover: [0.44, 0.58, 0.46], cloudDark: 1.0, shafts: 0.62, skyMul: 1.0,
    hazeMul: 1.0, desaturate: 0, fogMul: 1.0, wind: 1.0, lightning: 0, forceNight: false,
  },
  overcast: {
    cover: [0.30, 0.88, 0.78], cloudDark: 0.42, shafts: 0.10, skyMul: 0.86,
    hazeMul: 1.35, desaturate: 0.45, fogMul: 1.7, wind: 1.3, lightning: 0, forceNight: false,
  },
  rain: {
    cover: [0.22, 0.92, 0.86], cloudDark: 0.30, shafts: 0.05, skyMul: 0.72,
    hazeMul: 1.6, desaturate: 0.55, fogMul: 2.3, wind: 1.7, lightning: 0, forceNight: false,
  },
  stormRain: {
    cover: [0.14, 0.99, 0.97], cloudDark: 0.15, shafts: 0.02, skyMul: 0.60,
    hazeMul: 1.9, desaturate: 0.62, fogMul: 3.1, wind: 2.4, lightning: 0.34, forceNight: false,
  },
  fogDusk: {
    cover: [0.48, 0.62, 0.50], cloudDark: 0.82, shafts: 0.30, skyMul: 0.92,
    hazeMul: 2.4, desaturate: 0.30, fogMul: 4.2, wind: 0.6, lightning: 0, forceNight: false,
  },
  night: {
    cover: [0.50, 0.52, 0.40], cloudDark: 0.85, shafts: 0.05, skyMul: 1.0,
    hazeMul: 1.0, desaturate: 0.12, fogMul: 1.2, wind: 0.8, lightning: 0, forceNight: true,
  },
};

export function weatherLook(p: WeatherPreset): WeatherLook {
  return WEATHER[p] ?? WEATHER.clearSunset;
}

export function lerpWeather(out: WeatherLook, a: WeatherLook, b: WeatherLook, t: number): WeatherLook {
  for (let i = 0; i < 3; i++) out.cover[i] = MathUtils.lerp(a.cover[i], b.cover[i], t);
  out.cloudDark = MathUtils.lerp(a.cloudDark, b.cloudDark, t);
  out.shafts = MathUtils.lerp(a.shafts, b.shafts, t);
  out.skyMul = MathUtils.lerp(a.skyMul, b.skyMul, t);
  out.hazeMul = MathUtils.lerp(a.hazeMul, b.hazeMul, t);
  out.desaturate = MathUtils.lerp(a.desaturate, b.desaturate, t);
  out.fogMul = MathUtils.lerp(a.fogMul, b.fogMul, t);
  out.wind = MathUtils.lerp(a.wind, b.wind, t);
  out.lightning = MathUtils.lerp(a.lightning, b.lightning, t);
  out.forceNight = t > 0.5 ? b.forceNight : a.forceNight;
  return out;
}

export function cloneWeather(a: WeatherLook): WeatherLook {
  return { ...a, cover: [...a.cover] as [number, number, number] };
}

const _lum = new Color();

/** Pull a keyframe toward grey — how overcast and storm skies actually read. */
export function desaturateKey(k: SkyKey, amount: number): void {
  if (amount <= 0.001) return;
  for (const f of COLOR_FIELDS) {
    if (f === 'away' || f === 'toward' || f === 'moon') continue;
    const c = k[f];
    const y = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    // Storm grey is still a cold violet grey, never neutral (art direction rule 1).
    _lum.setRGB(y * 0.94, y * 0.92, y * 1.12);
    c.lerp(_lum, amount);
  }
}

export function scaleKeyBrightness(k: SkyKey, mul: number): void {
  for (const f of COLOR_FIELDS) {
    if (f === 'away' || f === 'toward') continue;
    k[f].multiplyScalar(mul);
  }
}
