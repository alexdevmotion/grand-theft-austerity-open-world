/**
 * District zoning and the per-district building grammar parameters.
 *
 * The map is authored (not noise-driven) so that the landmarks land in the
 * right places and the grand axis actually reads as a grand axis. Noise is
 * only used to soften the boundaries.
 */

import { WorldScale } from '../../artDirection';
import { fbm2D } from '../../core/rng';
import type { DistrictKind } from '../../core/services';
import { FacadeStyle } from './materials';

const { blockSize, gridBlocks } = WorldScale;
export const HALF = (gridBlocks * blockSize) / 2;

/* ------------------------------------------------------------------ */
/* The authored plan                                                   */
/* ------------------------------------------------------------------ */

/** The N–S monumental axis runs down this world X (grid column 12). */
export const AXIS_X = -HALF + 12 * blockSize; // -92
/** The E–W boulevard crossing it (grid row 13). */
export const AXIS_Z = -HALF + 13 * blockSize; // 0

/** Palatul Parlamentului terminates the axis at the north end. */
export const PARLIAMENT = { x: AXIS_X, z: -960, w: 276, d: 176 };
/** Builders House holds the SE corner of the main crossroads. */
export const BUILDERS = { x: -46, z: 46 };
/**
 * Cișmigiu.
 *
 * These bounds are no longer invented: they are the real park's outline off
 * the survey, projected through `OSM_FIT` (`Parcul Cișmigiu` spans
 * x -811..-518, z -277..55 in world metres). The zoning plan and the drawn
 * green space have to agree — while the authored rectangle sat 400 m away from
 * the real one, the generator was refusing to build on a "park" that was
 * ordinary city and covering the real park in courtyard gravel.
 */
export const PARK = { x0: -815, z0: -285, x1: -514, z1: 62 };

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  kind: DistrictKind;
}

/** Evaluated in order; first hit wins. */
const PLAN: Rect[] = [
  // Government quarter wrapping the Parliament and its forecourt.
  { x0: -700, z0: -1200, x1: 520, z1: -640, kind: 'guvern' },
  // The park.
  { x0: PARK.x0, z0: PARK.z0, x1: PARK.x1, z1: PARK.z1, kind: 'parc' },
  /*
   * Corporate pocket. DELIBERATELY SMALL — see the height note below. In the
   * Magheru photograph exactly one modern tower (the Coca-Cola-topped slab)
   * stands over the whole boulevard, and it reads as an INTRUSION into a
   * low-rise city. A 610x560 m corporate spine produced 137 towers and turned
   * the game into Manhattan; this is a sixth of that area, wrapped tight
   * around Builders House so the story landmark still has its quarter.
   */
  { x0: -175, z0: -70, x1: 70, z1: 165, kind: 'glassCorporate' },
  /*
   * LIPSCANI. Moved onto the real old town, which the survey puts at
   * x -535..58, z 155..426 — south-west of the crossroads, between Calea
   * Victoriei and Bulevardul Brătianu, exactly where it is in life. The
   * authored rectangle used to sit east of the corporate spine, which after
   * the import meant the stucco-and-cobbles grammar was being applied to
   * 1960s blocks off Calea Moșilor while the actual medieval core came out as
   * boulevard infill.
   */
  { x0: -545, z0: 145, x1: 70, z1: 435, kind: 'centruVechi' },
  // Grand boulevards fill the inner ring.
  { x0: -760, z0: -640, x1: 700, z1: 560, kind: 'bulevard' },
  // Industrial belt: the south-east corner and the east edge.
  { x0: 620, z0: 380, x1: 1250, z1: 1250, kind: 'industrial' },
  { x0: -1250, z0: 700, x1: -400, z1: 1250, kind: 'industrial' },
];

function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

export function planDistrictAt(x: number, z: number): DistrictKind {
  // Wobble the sample point so district edges are not dead straight.
  const n = fbm2D(x * 0.0032 + 31, z * 0.0032 - 17, 3, 8231) - 0.5;
  const m = fbm2D(x * 0.0028 - 9, z * 0.0031 + 44, 3, 4477) - 0.5;
  const px = x + n * 120;
  const pz = z + m * 120;

  for (const r of PLAN) if (inRect(r, px, pz)) return r.kind;

  // Outer ring: mostly panel-block cartiere with pockets of green.
  const g = fbm2D(px * 0.0055 + 3, pz * 0.0055 + 8, 3, 1901);
  if (g > 0.70) return 'parc';
  return 'cartier';
}

/* ------------------------------------------------------------------ */
/* Grammar parameters per district                                     */
/* ------------------------------------------------------------------ */

/**
 * A rare promotion to landmark height.
 *
 * BUCHAREST IS A LOW CITY. Every reference frame says the same thing: the
 * University Square aerial is an unbroken carpet of 5-8 storey blocks running
 * to the horizon, and Magheru — the grandest boulevard in the country — is
 * overwhelmingly 6-10 storeys with ONE modern tower visible along its whole
 * length. Encoding that as a single wide `height` range cannot work: a range
 * broad enough to contain the occasional tower makes towers the median, which
 * is exactly how this city ended up reading as Manhattan (median 10 storeys,
 * 41% of all buildings above 11).
 *
 * So height is authored as two populations instead of one. `height` is the
 * ordinary street wall and stays low; `tower` is a small chance of promotion
 * to a genuinely tall mass. Rarity is what makes a tower read AS a tower.
 */
export interface TowerSpec {
  /** 0..1 chance an individual plot is promoted. */
  chance: number;
  height: [number, number];
}

export interface DistrictSpec {
  style: number;
  /** Storey height range. */
  floorH: [number, number];
  /** Bay pitch range. */
  bayW: [number, number];
  /** ORDINARY building height range — the street wall, not the exceptions. */
  height: [number, number];
  /** Rare landmark-height promotion, or null if the district never has one. */
  tower: TowerSpec | null;
  /** Ground floor height range. */
  groundH: [number, number];
  /** Fraction of windows lit at dusk. */
  lit: [number, number];
  /** 0..1 chance a plot is left as an open yard/courtyard. */
  gap: number;
  /** How deep a perimeter building runs back from the street. */
  depth: [number, number];
  /** Street frontage width per building. */
  frontage: [number, number];
  /** Chance of a setback tower above the street wall. */
  setback: number;
  /** Chance the roof gets heavy plant (bigger on commercial). */
  roofPlant: number;
  /** Freestanding slabs in green space instead of perimeter blocks. */
  freestanding: boolean;
}

export const DISTRICTS: Record<DistrictKind, DistrictSpec> = {
  glassCorporate: {
    style: FacadeStyle.glassCorporate,
    floorH: [3.7, 4.3],
    bayW: [1.55, 2.05],
    // Even inside the corporate pocket most plots are ordinary mid-rise infill;
    // the towers are the minority that makes the quarter read as a quarter.
    height: [20, 40],
    tower: { chance: 0.30, height: [58, 112] },
    groundH: [7.5, 12.0],
    lit: [0.16, 0.34],
    gap: 0.16,
    depth: [26, 44],
    frontage: [28, 52],
    setback: 0.55,
    roofPlant: 0.95,
    freestanding: false,
  },
  bulevard: {
    style: FacadeStyle.bulevard,
    floorH: [3.15, 3.6],
    bayW: [3.4, 4.6],
    // Magheru: overwhelmingly 6-10 storeys of interbelic and communist block.
    height: [20, 31],
    tower: { chance: 0.025, height: [36, 50] },
    groundH: [4.6, 6.2],
    lit: [0.14, 0.32],
    gap: 0.06,
    depth: [16, 26],
    frontage: [22, 46],
    setback: 0.22,
    roofPlant: 0.45,
    freestanding: false,
  },
  cartier: {
    style: FacadeStyle.cartier,
    floorH: [2.72, 2.95],
    bayW: [3.0, 3.6],
    // The cartiere are genuinely bimodal: streets of P+4 walk-ups with the
    // occasional P+8/P+10 lift block standing over them. One wide range blurs
    // the two into a uniform 12-storey wall, which no Romanian suburb is.
    height: [12, 24],
    tower: { chance: 0.12, height: [27, 33] },
    groundH: [3.0, 3.6],
    lit: [0.16, 0.38],
    gap: 0.18,
    depth: [12.5, 15.5],
    frontage: [46, 92],
    setback: 0.04,
    roofPlant: 0.35,
    freestanding: true,
  },
  centruVechi: {
    style: FacadeStyle.centruVechi,
    floorH: [3.3, 4.0],
    bayW: [3.0, 4.0],
    // Lipscani is 3-5 storeys of stucco. It was already the closest to right.
    height: [11, 22],
    tower: null,
    groundH: [4.2, 5.4],
    lit: [0.22, 0.46],
    gap: 0.05,
    depth: [12, 20],
    frontage: [10, 20],
    setback: 0.06,
    roofPlant: 0.2,
    freestanding: false,
  },
  guvern: {
    style: FacadeStyle.guvern,
    floorH: [4.6, 5.6],
    bayW: [4.6, 6.2],
    // Unirii's civic wall: ~8-10 storeys, but of very tall monumental floors.
    height: [24, 42],
    tower: { chance: 0.03, height: [46, 62] },
    groundH: [6.5, 9.0],
    lit: [0.10, 0.24],
    gap: 0.3,
    depth: [22, 34],
    frontage: [36, 68],
    setback: 0.15,
    roofPlant: 0.3,
    freestanding: false,
  },
  industrial: {
    style: FacadeStyle.industrial,
    floorH: [5.0, 7.0],
    bayW: [6.0, 9.0],
    height: [9, 21],
    tower: null,
    groundH: [5.0, 6.5],
    lit: [0.08, 0.20],
    gap: 0.34,
    depth: [30, 56],
    frontage: [34, 70],
    setback: 0.02,
    roofPlant: 0.55,
    freestanding: true,
  },
  parc: {
    style: FacadeStyle.plain,
    floorH: [3.2, 3.6],
    bayW: [3.0, 4.0],
    height: [5, 9],
    tower: null,
    groundH: [3.0, 3.6],
    lit: [0.3, 0.6],
    gap: 0.94,
    depth: [8, 12],
    frontage: [8, 14],
    setback: 0,
    roofPlant: 0,
    freestanding: true,
  },
};

/* ------------------------------------------------------------------ */
/* Street hierarchy                                                    */
/* ------------------------------------------------------------------ */

export type StreetRank = 0 | 1 | 2;

/** Rank of the N–S street on grid column `i`. */
export function columnRank(i: number): StreetRank {
  if (i === 12) return 2;
  if (i % 4 === 0) return 1;
  return 0;
}

/** Rank of the E–W street on grid row `j`. */
export function rowRank(j: number): StreetRank {
  if (j === 13) return 2;
  if (j % 4 === 0) return 1;
  return 0;
}

export const ROAD_WIDTH: Record<StreetRank, number> = { 0: 16, 1: 26, 2: 42 };
export const WALK_WIDTH: Record<StreetRank, number> = { 0: 4.6, 1: 6.4, 2: 9.5 };
export const LANES: Record<StreetRank, number> = { 0: 1, 1: 2, 2: 3 };
/** Streets with tram tracks: the axis plus every 8th column/row. */
export function hasTram(i: number | null, j: number | null): boolean {
  if (i !== null) return i === 12 || i === 4 || i === 20;
  if (j !== null) return j === 13 || j === 5 || j === 21;
  return false;
}
