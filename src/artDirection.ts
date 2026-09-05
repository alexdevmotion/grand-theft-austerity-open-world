/** Shared look for a weathered Bucharest at golden hour.
 * Surface colours stay recognisable under a warm sun and cool skylight.
 */
import { Color, ColorManagement } from 'three';

/** Hex values are sRGB; the renderer works in linear light. Decode once. */
const c = (hex: number) => {
  const color = new Color(hex);
  return ColorManagement.enabled ? color : color.convertSRGBToLinear();
};

export const Palette = {
  /** Sky gradient, bottom (horizon) to top (zenith). */
  skyHorizon: c(0xe6ae78),
  skyLowBand: c(0xc4aaa0),
  skyMidBand: c(0x899cac),
  skyHighBand: c(0x617c99),
  skyZenith: c(0x334d71),

  /** Sun disc + directional light tint. Low, warm, slightly pink. */
  sunCore: c(0xffd9a8),
  sunLight: c(0xffd1a0),
  /** Bounce/ambient coming off lit cloud deck — this is what fills shadows. */
  skyAmbient: c(0xa3b8d0),
  groundBounce: c(0x514b42),

  /** Clouds. */
  cloudLit: c(0xe5c3a0),
  cloudMid: c(0x999fa8),
  cloudShadow: c(0x556476),

  /** Surfaces. */
  asphaltDry: c(0x413e3a),
  asphaltWet: c(0x383735),
  sidewalkStone: c(0x74736c),
  travertine: c(0xb4a28a),
  concreteGrey: c(0x88877f),
  glassTint: c(0x27333e),
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

/** Restrained photographic grade; lighting carries the colour separation. */
export const Grade = {
  exposure: 1.0,
  /** AgX owns highlight compression; optional look-dev shoulders start neutral. */
  exposureKnee: 4.0,
  exposureRolloff: 0.0,
  contrastPivot: 0.18,
  shoulderKnee: 0.85,
  shoulderStrength: 0.0,
  toeDepth: 0.0,
  toeRange: 0.10,
  toeLift: 0.0,
  toeRGB: [0.06, 0.065, 0.07] as [number, number, number],
  shadowRGB: [0.97, 1.0, 1.035] as [number, number, number],
  highlightRGB: [1.035, 1.0, 0.975] as [number, number, number],
  splitStrength: 0.12,
  splitBalance: 2.2,
  chromaRolloff: 0.08,
  chromaKnee: 0.90,
  bloomIntensity: 0.22,
  bloomThreshold: 1.0,
  bloomSmoothing: 0.35,
  bloomRadius: 0.65,
  liftRGB: [0.001, 0.0012, 0.0014] as [number, number, number],
  gainRGB: [1.018, 1.0, 0.986] as [number, number, number],
  gammaRGB: [1.0, 1.0, 1.0] as [number, number, number],
  saturation: 0.98,
  contrast: 1.08,
  vignetteDarkness: 0.32,
  vignetteOffset: 0.24,
  chromaticAberration: 0.00018,
  filmGrain: 0.0015,
} as const;

/** Aerial perspective: warm horizon haze, cool distant shade. */
export const Atmosphere = {
  fogNear: 40,
  fogFar: 1150,
  fogColorNear: Palette.skyMidBand,
  fogColorFar: Palette.skyLowBand,
  fogDensity: 0.00085,
  /**
   * Residual clear-weather moisture, 0..1. Clear sunset streets keep a faint
   * sheen without turning paving into a mirror; rain/storm presets raise this
   * to 1 so their localized puddle masks can still produce strong reflections.
   */
  wetness: 0.12,
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
