/**
 * Block subdivision — how a city block becomes plots, and plots become
 * buildings.
 *
 * Two grammars:
 *   PERIMETER  (bulevard, centruVechi, guvern, glassCorporate) — buildings sit
 *              on the building line and wrap the block, leaving a courtyard.
 *              This is what makes a street read as a street wall rather than a
 *              scatter of towers.
 *   FREESTANDING (cartier, industrial, parc) — slabs and sheds set back in
 *              open ground, the Romanian panel-block pattern.
 */

import type { Rng } from '../../core/rng';
import type { DistrictKind } from '../../core/services';
import type { DetailBuilder, FacadeBuilder } from './builders';
import { DISTRICTS } from './districts';
import { FacadeStyle } from './materials';
import { buildBuilding, type BuildingSite } from './facades';

export interface BlockRect {
  /** Building line — the pavement's inner edge. */
  bx0: number;
  bz0: number;
  bx1: number;
  bz1: number;
}

export interface PlacedBuilding {
  x: number;
  z: number;
  hx: number;
  hz: number;
  height: number;
}

export interface BlockBuildOptions {
  block: BlockRect;
  district: DistrictKind;
  rng: Rng;
  facade(x: number, z: number): FacadeBuilder;
  detail(x: number, z: number): DetailBuilder;
  /** Landmark footprints and other reserved ground. */
  isVoid(x: number, z: number): boolean;
  out: PlacedBuilding[];
  /** Distance from the hero crossroads, per building, drives detail budget. */
  heroX?: number;
  heroZ?: number;
}

const HERO_X = -46;
const HERO_Z = 46;

export function buildBlock(opt: BlockBuildOptions): void {
  const spec = DISTRICTS[opt.district];
  if (opt.district === 'parc') {
    parkPavilions(opt, spec.gap);
    return;
  }
  if (spec.freestanding) freestanding(opt);
  else perimeter(opt);
}

/* ------------------------------------------------------------------ */
/* Perimeter block                                                     */
/* ------------------------------------------------------------------ */

function perimeter(opt: BlockBuildOptions): void {
  const { block: b, rng } = opt;
  const spec = DISTRICTS[opt.district];
  const w = b.bx1 - b.bx0;
  const dpt = b.bz1 - b.bz0;
  if (w < 14 || dpt < 14) return;

  // Depth of the street wall on this block; clamped so opposite runs never
  // collide in a shallow block.
  const depth = Math.min(rng.range(spec.depth[0], spec.depth[1]), Math.min(w, dpt) * 0.42);

  // Four edges: [outward normal x, z, run axis]
  const edges: Array<{
    fx: number; fz: number;
    /** Start point of the run and its direction. */
    sx: number; sz: number; dx: number; dz: number; len: number;
  }> = [
    // North edge (faces -Z), runs along +X.
    { fx: 0, fz: -1, sx: b.bx0, sz: b.bz0, dx: 1, dz: 0, len: w },
    // South edge (faces +Z).
    { fx: 0, fz: 1, sx: b.bx0, sz: b.bz1, dx: 1, dz: 0, len: w },
    // West edge (faces -X), runs along +Z, inset by the N/S runs.
    { fx: -1, fz: 0, sx: b.bx0, sz: b.bz0 + depth, dx: 0, dz: 1, len: dpt - depth * 2 },
    // East edge (faces +X).
    { fx: 1, fz: 0, sx: b.bx1, sz: b.bz0 + depth, dx: 0, dz: 1, len: dpt - depth * 2 },
  ];

  for (const e of edges) {
    if (e.len < 12) continue;
    let t = 0;
    let guard = 0;
    while (t < e.len - 8 && guard++ < 24) {
      const front = Math.min(
        rng.range(spec.frontage[0], spec.frontage[1]),
        e.len - t,
      );
      if (front < 8) break;
      if (rng.bool(spec.gap)) {
        t += front;
        continue;
      }
      const mid = t + front / 2;
      // Plot centre: half a depth back from the building line.
      const cx = e.sx + e.dx * mid - e.fx * depth * 0.5;
      const cz = e.sz + e.dz * mid - e.fz * depth * 0.5;
      if (!opt.isVoid(cx, cz)) {
        emit(opt, cx, cz, e.dx !== 0 ? front : depth, e.dx !== 0 ? depth : front, e.fx, e.fz);
      }
      t += front + rng.range(0, 2.5);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Freestanding slabs                                                  */
/* ------------------------------------------------------------------ */

function freestanding(opt: BlockBuildOptions): void {
  const { block: b, rng } = opt;
  const spec = DISTRICTS[opt.district];
  const w = b.bx1 - b.bx0;
  const dpt = b.bz1 - b.bz0;
  if (w < 20 || dpt < 20) return;

  // Rows of slabs, alternating orientation per block so the cartiere do not
  // turn into a single repeated comb.
  const alongX = rng.bool(0.5);
  const slabDepth = rng.range(spec.depth[0], spec.depth[1]);
  const rowPitch = slabDepth + rng.range(14, 26);
  const across = alongX ? dpt : w;
  const runLen = alongX ? w : dpt;
  const rows = Math.max(1, Math.floor(across / rowPitch));
  if (rows < 1) return;

  for (let r = 0; r < rows; r++) {
    const acrossT = (r + 0.5) / rows;
    let t = rng.range(0, 10);
    let guard = 0;
    while (t < runLen - 16 && guard++ < 16) {
      const front = Math.min(rng.range(spec.frontage[0], spec.frontage[1]), runLen - t);
      if (front < 14) break;
      if (rng.bool(spec.gap)) {
        t += front * 0.6;
        continue;
      }
      const mid = t + front / 2;
      const cx = alongX ? b.bx0 + mid : b.bx0 + across * acrossT;
      const cz = alongX ? b.bz0 + across * acrossT : b.bz0 + mid;
      if (!opt.isVoid(cx, cz)) {
        // Face the nearest block edge.
        const fx = alongX ? 0 : (cx - (b.bx0 + b.bx1) / 2 > 0 ? 1 : -1);
        const fz = alongX ? (cz - (b.bz0 + b.bz1) / 2 > 0 ? 1 : -1) : 0;
        emit(
          opt, cx, cz,
          alongX ? front : slabDepth,
          alongX ? slabDepth : front,
          fx, fz,
        );
      }
      t += front + rng.range(8, 22);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Park pavilions                                                      */
/* ------------------------------------------------------------------ */

function parkPavilions(opt: BlockBuildOptions, gap: number): void {
  const { block: b, rng } = opt;
  if (rng.bool(gap)) return;
  const cx = rng.range(b.bx0 + 12, b.bx1 - 12);
  const cz = rng.range(b.bz0 + 12, b.bz1 - 12);
  if (opt.isVoid(cx, cz)) return;
  emit(opt, cx, cz, rng.range(8, 15), rng.range(7, 12), 0, 1);
}

/* ------------------------------------------------------------------ */

function emit(
  opt: BlockBuildOptions,
  cx: number, cz: number,
  w: number, d: number,
  fx: number, fz: number,
): void {
  const spec = DISTRICTS[opt.district];
  const heroDist = Math.hypot(cx - (opt.heroX ?? HERO_X), cz - (opt.heroZ ?? HERO_Z));
  const site: BuildingSite = { cx, cz, w, d, rot: 0, fx, fz, heroDist };

  /*
   * STYLE MIXING — the eras jammed against each other.
   *
   * This is not variety for its own sake. The defining character of central
   * Bucharest is COLLISION: a 1935 interbelic block abutting a 1975 concrete
   * one abutting a nineteenth-century stucco survivor abutting a glass insert
   * from 2008, all on the same fifty metres of frontage. A district rendered
   * in one style reads as a masterplan, and Bucharest has never had one that
   * survived contact with the next regime.
   */
  let forceStyle: number | undefined;
  if (opt.district === 'glassCorporate') {
    // The reference frame is precisely a dark glass tower standing against
    // warm travertine — a quarter that is 100% curtain wall has no such
    // contrast anywhere in it.
    const r = opt.rng.next();
    if (r < 0.22) forceStyle = FacadeStyle.guvern;          // travertine slab
    else if (r < 0.40) forceStyle = FacadeStyle.interbelic; // older infill
  } else if (opt.district === 'bulevard') {
    // Magheru's actual composition: interbelic dominates, communist infill is
    // common, and the other eras appear as interruptions.
    forceStyle = opt.rng.weighted(
      [
        FacadeStyle.interbelic,
        FacadeStyle.bulevard,
        FacadeStyle.centruVechi,
        FacadeStyle.guvern,
        FacadeStyle.glassCorporate,
      ],
      [10, 5.5, 1.6, 1.0, 0.7],
    );
  } else if (opt.district === 'centruVechi' && opt.rng.bool(0.16)) {
    forceStyle = FacadeStyle.interbelic;   // an interwar infill on a lost plot
  } else if (opt.district === 'cartier' && opt.rng.bool(0.10)) {
    forceStyle = FacadeStyle.interbelic;   // the pre-war fringe the blocs ate
  }

  const built = buildBuilding(
    site, spec, opt.rng,
    opt.facade(cx, cz), opt.detail(cx, cz),
    { forceStyle },
  );
  opt.out.push({ x: cx, z: cz, hx: built.hx, hz: built.hz, height: built.height });
}
