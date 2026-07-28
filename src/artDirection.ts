/**
 * ART DIRECTION — the single source of truth for the look of the game.
 *
 * Every value here is derived from the reference frame
 * `docs/reference/house-under-siege-duo.png`: a magenta-orange Bucharest
 * sunset, deep violet shadows, wet asphalt mirroring the sky, a dark glass
 * tower with warm travertine cladding, purple-lit interiors, political faces
 * on facade screens, and a battered yellow/purple Dacia 1300.
 *
 * Systems MUST pull colours from here rather than hardcoding hexes, so that a
 * single grade change re-tints the whole city coherently.
 */

import { Color } from 'three';

const c = (hex: number) => new Color(hex).convertSRGBToLinear();

export const Palette = {
  /** Sky gradient, bottom (horizon) to top (zenith). */
  skyHorizon: c(0xff7a3c),
  skyLowBand: c(0xff5f86),
  skyMidBand: c(0xd0569f),
  skyHighBand: c(0x6b4192),
  skyZenith: c(0x231a45),

  /** Sun disc + directional light tint. Low, warm, slightly pink. */
  sunCore: c(0xffd9a8),
  sunLight: c(0xff9c5a),
  /** Bounce/ambient coming off lit cloud deck — this is what fills shadows. */
  skyAmbient: c(0x6d4f9e),
  groundBounce: c(0x2a1c33),

  /** Clouds. */
  cloudLit: c(0xffa477),
  cloudMid: c(0xd2679c),
  cloudShadow: c(0x4a3670),

  /** Surfaces. */
  asphaltDry: c(0x1a1622),
  asphaltWet: c(0x0d0a14),
  sidewalkStone: c(0x4a4048),
  travertine: c(0xc9a882),
  concreteGrey: c(0x6a6470),
  glassTint: c(0x1b2340),
  glassSpecular: c(0xbfd4ff),

  /** Interior / signage emissives. */
  builderPurple: c(0x7b3fd4),
  builderMagenta: c(0xc04ad0),
  screenBlue: c(0x3a5cc8),
  sodiumLamp: c(0xffb14a),
  neonPink: c(0xff2f8e),
  scooterGreen: c(0x4ade50),

  /** Vehicles. */
  daciaYellow: c(0xd8c33a),
  daciaPurple: c(0x6b3fa0),
  daciaRust: c(0x7a4a2a),
  policeBlue: c(0x2b6cff),

  /** Romanian tricolour. */
  roBlue: c(0x002b7f),
  roYellow: c(0xfcd116),
  roRed: c(0xce1126),

  /** Foliage — late-autumn Bucharest. */
  leafAmber: c(0xb8823a),
  leafOlive: c(0x5d6a3a),
  trunkBark: c(0x3a2e28),
} as const;

/** Sun elevation/azimuth for the hero "golden hour" state. */
export const HeroSun = {
  /** Degrees above horizon. The reference sits just above sunset. */
  elevationDeg: 3.2,
  /** Degrees, 0 = +Z. Sun is low-left behind the tower in the reference. */
  azimuthDeg: 252,
  intensity: 4.6,
  ambientIntensity: 1.15,
} as const;

/** Post-processing grade constants. */
export const Grade = {
  exposure: 1.0,
  bloomIntensity: 0.62,
  bloomThreshold: 0.72,
  bloomSmoothing: 0.35,
  bloomRadius: 0.72,
  /** Shadows pushed toward violet, highlights toward warm orange. */
  liftRGB: [0.020, 0.008, 0.042] as [number, number, number],
  gainRGB: [1.055, 0.985, 0.955] as [number, number, number],
  gammaRGB: [1.0, 1.01, 1.03] as [number, number, number],
  saturation: 1.14,
  contrast: 1.08,
  vignetteDarkness: 0.52,
  vignetteOffset: 0.28,
  chromaticAberration: 0.00072,
  filmGrain: 0.028,
} as const;

/** Fog / aerial perspective. Heavy warm haze toward the sun, violet away. */
export const Atmosphere = {
  fogNear: 40,
  fogFar: 1150,
  fogColorNear: Palette.skyMidBand,
  fogColorFar: Palette.skyLowBand,
  fogDensity: 0.00085,
  /** Wet-street reflectivity 0..1 — the reference is fully rain-slicked. */
  wetness: 0.85,
} as const;

/** World scale constants shared by every system. */
export const WorldScale = {
  /** Metres per city block including road. */
  blockSize: 92,
  roadWidth: 16,
  sidewalkWidth: 4.5,
  laneWidth: 3.6,
  /** Grid is blocks x blocks; 26 => ~2.4km across. */
  gridBlocks: 26,
  get halfExtent() {
    return (this.gridBlocks * this.blockSize) / 2;
  },
} as const;
