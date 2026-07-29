/**
 * Building articulation — the layer that turns a plot into architecture.
 *
 * A building is a stack of MASSES (street wall, setback shoulder, tower) each
 * extruded from a footprint through the facade grammar shader in materials.ts,
 * plus a DETAIL pass that hangs the things a shader cannot fake against the
 * sky: cornices, parapets, balcony slabs, entrance canopies, rooftop plant,
 * water tanks, aerials and the facade screens from the reference frame.
 *
 * Everything written here goes into the caller's per-chunk builders, so a
 * whole district still costs three draw calls.
 *
 * Triangle discipline: the shell is quads (a 60 m tower is ~10 triangles); all
 * of the cost is in the detail pass, which is therefore budgeted per building
 * and tapers with distance from the hero area.
 */

import * as THREE from 'three';
import { PAL, srgb } from '../../render/materials';
import type { Rng } from '../../core/rng';
import {
  DetailBuilder,
  FacadeBuilder,
  lFootprint,
  rectFootprint,
  type FacadeParams,
  type Vec2,
} from './builders';
import type { DistrictSpec } from './districts';
import { FacadeStyle } from './materials';

/* ------------------------------------------------------------------ */
/* Palette for the detail pass                                         */
/* ------------------------------------------------------------------ */

/** Decoded exactly once — see the colour-space note in `render/materials.ts`. */
const lin = srgb;

export const DetailColor = {
  stone: lin(0xd2c5b0),
  stoneDark: lin(0x8d8274),
  concrete: lin(0x726c76),
  concreteDark: lin(0x4a4650),
  metal: lin(0x3d434c),
  metalPale: lin(0x8d949c),
  alu: lin(0x9aa2ab),
  bitumen: lin(0x1b1820),
  rust: lin(0x6d4326),
  glassDark: lin(0x141a2c),
  awning: lin(0x7a2338),
  sodium: PAL.sodiumLamp,
  purple: PAL.builderPurple,
  magenta: PAL.builderMagenta,
  screen: PAL.screenBlue,
  neon: PAL.neonPink,
  leaf: PAL.leafAmber,
  leafOlive: PAL.leafOlive,
  bark: PAL.trunkBark,
} as const;

const MR = {
  stone: [0.0, 0.72] as [number, number],
  concrete: [0.0, 0.88] as [number, number],
  metal: [0.78, 0.38] as [number, number],
  paint: [0.1, 0.55] as [number, number],
  glass: [0.85, 0.09] as [number, number],
  rough: [0.0, 0.95] as [number, number],
};

/** Emissive triple scaled off a linear colour. */
export function emi(c: THREE.Color, gain: number): number[] {
  return [c.r * gain, c.g * gain, c.b * gain];
}

/* ------------------------------------------------------------------ */
/* Site description                                                    */
/* ------------------------------------------------------------------ */

export interface BuildingSite {
  cx: number;
  cz: number;
  /** Frontage (along the street) and depth (back from the street). */
  w: number;
  d: number;
  /** Rotation about Y so that +x is along the frontage. */
  rot: number;
  /** Unit vector from the plot centre toward the street it fronts. */
  fx: number;
  fz: number;
  /** Distance from the hero area — drives the detail budget. */
  heroDist: number;
}

export interface BuiltBuilding {
  height: number;
  /** Axis-aligned half extents used for the collider and blocking query. */
  hx: number;
  hz: number;
}

/** Detail budget tiers by distance from the hero crossroads. */
function detailTier(heroDist: number): 0 | 1 | 2 {
  if (heroDist < 420) return 2;
  if (heroDist < 900) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export function buildBuilding(
  site: BuildingSite,
  spec: DistrictSpec,
  rng: Rng,
  f: FacadeBuilder,
  d: DetailBuilder,
  opts: { heightScale?: number; forceStyle?: number } = {},
): BuiltBuilding {
  const tier = detailTier(site.heroDist);
  const floorH = rng.range(spec.floorH[0], spec.floorH[1]);
  const bayW = rng.range(spec.bayW[0], spec.bayW[1]);
  const groundH = rng.range(spec.groundH[0], spec.groundH[1]);
  const style = opts.forceStyle ?? spec.style;

  // Height snapped to whole storeys so the grammar's floor lines meet the roof.
  const wanted = rng.range(spec.height[0], spec.height[1]) * (opts.heightScale ?? 1);
  const floors = Math.max(1, Math.round((wanted - groundH) / floorH));
  const h = groundH + floors * floorH;

  const seed = rng.range(0, 97);
  const p: FacadeParams = {
    style,
    floorH,
    bayW,
    seed,
    buildingH: h,
    groundH,
    lit: rng.range(spec.lit[0], spec.lit[1]),
    tint: rng.next(),
  };

  const { cx, cz, w, rot } = site;
  const dep = site.d;

  /* ---------------- massing ---------------- */

  // An L-plan on a fraction of plots breaks the "field of cuboids" read.
  const lPlan = style !== FacadeStyle.glassCorporate && rng.bool(0.26) && w > 18 && dep > 14;
  const base: Vec2[] = lPlan
    ? lFootprint(cx, cz, w, dep, w * rng.range(0.3, 0.45), dep * rng.range(0.3, 0.45))
    : rectFootprint(cx, cz, w, dep, rot);

  const setback = rng.bool(spec.setback) && h > groundH + floorH * 5;
  let topOfBase = h;

  if (setback) {
    // Street wall, then one or two setback masses above it.
    const shoulderFloors = Math.max(2, Math.round(floors * rng.range(0.35, 0.6)));
    topOfBase = groundH + shoulderFloors * floorH;
    f.extrude(base, 0, topOfBase, 0, p, { roof: true });
    corniceAndParapet(d, site, base, topOfBase, style, tier, rng, true);

    const inset1 = rng.range(2.4, 5.5);
    const t1 = shrink(base, inset1);
    const midFloors = floors - shoulderFloors;
    const twoStep = rng.bool(0.45) && midFloors > 6;
    if (twoStep) {
      const midTop = topOfBase + Math.round(midFloors * 0.55) * floorH;
      f.extrude(t1, topOfBase, midTop, topOfBase, p);
      corniceAndParapet(d, site, t1, midTop, style, tier, rng, false);
      const t2 = shrink(t1, rng.range(2.0, 4.0));
      f.extrude(t2, midTop, h, midTop, p);
      corniceAndParapet(d, site, t2, h, style, tier, rng, false);
      roofscape(d, t2, h, tier, rng, spec, site);
    } else {
      f.extrude(t1, topOfBase, h, topOfBase, p);
      corniceAndParapet(d, site, t1, h, style, tier, rng, false);
      roofscape(d, t1, h, tier, rng, spec, site);
    }
  } else {
    f.extrude(base, 0, h, 0, p);
    corniceAndParapet(d, site, base, h, style, tier, rng, true);
    roofscape(d, base, h, tier, rng, spec, site);
  }

  /* ---------------- street-level articulation ---------------- */

  if (tier >= 1) {
    entrance(d, site, groundH, style, rng);
    if (style === FacadeStyle.centruVechi && tier === 2) awnings(d, site, groundH, rng);
  }

  /* ---------------- balconies ---------------- */

  if (tier === 2 && (style === FacadeStyle.bulevard || style === FacadeStyle.cartier)) {
    balconies(d, site, groundH, floorH, Math.min(floors, 12), topOfBase, rng);
  }

  /* ---------------- facade screens (the reference's political portraits) ---- */

  if (style === FacadeStyle.glassCorporate && tier >= 1 && h > 40 && rng.bool(0.5)) {
    facadeScreen(d, site, groundH, h, rng);
  }

  const bounds = footprintBounds(base);
  return { height: h, hx: bounds.hx, hz: bounds.hz };
}

/* ------------------------------------------------------------------ */
/* Footprint helpers                                                   */
/* ------------------------------------------------------------------ */

function footprintBounds(fp: ReadonlyArray<Vec2>): { cx: number; cz: number; hx: number; hz: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const v of fp) {
    if (v.x < x0) x0 = v.x;
    if (v.x > x1) x1 = v.x;
    if (v.z < z0) z0 = v.z;
    if (v.z > z1) z1 = v.z;
  }
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
}

/** Uniform inward offset approximated by scaling about the centroid. */
function shrink(fp: ReadonlyArray<Vec2>, inset: number): Vec2[] {
  const b = footprintBounds(fp);
  const sx = Math.max(0.25, (b.hx - inset) / Math.max(b.hx, 0.001));
  const sz = Math.max(0.25, (b.hz - inset) / Math.max(b.hz, 0.001));
  return fp.map((v) => ({ x: b.cx + (v.x - b.cx) * sx, z: b.cz + (v.z - b.cz) * sz }));
}

/* ------------------------------------------------------------------ */
/* Cornice + parapet                                                   */
/* ------------------------------------------------------------------ */

function corniceAndParapet(
  d: DetailBuilder,
  site: BuildingSite,
  fp: ReadonlyArray<Vec2>,
  top: number,
  style: number,
  tier: 0 | 1 | 2,
  rng: Rng,
  isMain: boolean,
): void {
  const b = footprintBounds(fp);
  const x0 = b.cx - b.hx;
  const x1 = b.cx + b.hx;
  const z0 = b.cz - b.hz;
  const z1 = b.cz + b.hz;

  // Parapet: the single most valuable silhouette detail — every roof gets one.
  const parapetH = style === FacadeStyle.glassCorporate ? 1.0 : rng.range(0.85, 1.35);
  const parapetCol = style === FacadeStyle.glassCorporate
    ? DetailColor.alu
    : style === FacadeStyle.guvern
      ? DetailColor.stone
      : DetailColor.concrete;
  const parapetMR = style === FacadeStyle.glassCorporate ? MR.metal : MR.concrete;
  d.ring(x0, z0, x1, z1, top, 0.34, parapetH, { color: parapetCol, mr: parapetMR });

  if (tier === 0) return;

  // Projecting cornice below the parapet on masonry styles.
  if (style !== FacadeStyle.glassCorporate && style !== FacadeStyle.industrial) {
    const proj = style === FacadeStyle.guvern ? 1.05 : style === FacadeStyle.centruVechi ? 0.8 : 0.55;
    const ch = style === FacadeStyle.guvern ? 1.15 : 0.55;
    d.ring(
      x0 - proj, z0 - proj, x1 + proj, z1 + proj,
      top - ch, proj + 0.34, ch,
      { color: style === FacadeStyle.guvern ? DetailColor.stone : DetailColor.stoneDark, mr: MR.stone },
    );
    // Second, thinner band — reads as a moulding profile in raking sun.
    if (tier === 2 && (style === FacadeStyle.centruVechi || style === FacadeStyle.guvern)) {
      d.ring(
        x0 - proj * 0.55, z0 - proj * 0.55, x1 + proj * 0.55, z1 + proj * 0.55,
        top - ch - 0.42, proj * 0.55 + 0.3, 0.3,
        { color: DetailColor.stone, mr: MR.stone },
      );
    }
  }

  // Coping shadow line on the main mass of glass towers.
  if (isMain && style === FacadeStyle.glassCorporate && tier >= 1) {
    d.ring(x0 - 0.45, z0 - 0.45, x1 + 0.45, z1 + 0.45, top - 0.5, 0.6, 0.28, {
      color: DetailColor.metal, mr: MR.metal,
    });
  }
  void site;
}

/* ------------------------------------------------------------------ */
/* Roofscape                                                           */
/* ------------------------------------------------------------------ */

function roofscape(
  d: DetailBuilder,
  fp: ReadonlyArray<Vec2>,
  top: number,
  tier: 0 | 1 | 2,
  rng: Rng,
  spec: DistrictSpec,
  site: BuildingSite,
): void {
  if (tier === 0) return;
  const b = footprintBounds(fp);
  const heavy = rng.bool(spec.roofPlant);

  // Lift shaft / stair head — the tallest thing on almost every roof.
  if (heavy || rng.bool(0.5)) {
    const sw = Math.min(b.hx * 1.0, rng.range(3.4, 6.2));
    const sd = Math.min(b.hz * 1.0, rng.range(3.0, 5.4));
    const sh = rng.range(2.6, 4.4);
    const ox = rng.range(-b.hx * 0.4, b.hx * 0.4);
    const oz = rng.range(-b.hz * 0.4, b.hz * 0.4);
    d.box(b.cx + ox, top + sh / 2, b.cz + oz, sw, sh, sd, 0, {
      color: DetailColor.concrete, mr: MR.concrete,
    });
  }

  if (!heavy && tier < 2) return;

  // Plant boxes: chillers, AHUs, ducting.
  const units = tier === 2 ? rng.int(2, 5) : rng.int(1, 3);
  for (let i = 0; i < units; i++) {
    const uw = rng.range(1.6, 3.6);
    const ud = rng.range(1.4, 3.0);
    const uh = rng.range(0.9, 2.1);
    const ox = rng.range(-b.hx * 0.72, b.hx * 0.72);
    const oz = rng.range(-b.hz * 0.72, b.hz * 0.72);
    d.box(b.cx + ox, top + uh / 2, b.cz + oz, uw, uh, ud, 0, {
      color: rng.bool(0.5) ? DetailColor.metalPale : DetailColor.metal,
      mr: MR.metal,
    });
  }

  // Water tank on legs — a Bucharest rooftop signature.
  if (tier === 2 && rng.bool(0.3)) {
    const tx = b.cx + rng.range(-b.hx * 0.5, b.hx * 0.5);
    const tz = b.cz + rng.range(-b.hz * 0.5, b.hz * 0.5);
    d.cyl(tx, top + 1.5, tz, 1.15, 1.15, 2.1, 6, { color: DetailColor.rust, mr: [0.4, 0.72] });
    d.box(tx, top + 0.75, tz, 1.7, 1.5, 1.7, 0, { color: DetailColor.metal, mr: MR.metal });
  }

  // Aerials and masts — thin, dark, and they carve the skyline against the sky.
  const masts = tier === 2 ? rng.int(1, 3) : 1;
  for (let i = 0; i < masts; i++) {
    const mx = b.cx + rng.range(-b.hx * 0.8, b.hx * 0.8);
    const mz = b.cz + rng.range(-b.hz * 0.8, b.hz * 0.8);
    const mh = rng.range(2.5, 8.5);
    d.cyl(mx, top, mz, 0.09, 0.045, mh, 5, { color: DetailColor.metal, mr: MR.metal }, false);
    if (rng.bool(0.4)) {
      // Cross-arm / dish.
      d.box(mx, top + mh * 0.72, mz, 1.5, 0.06, 0.06, rng.range(0, Math.PI), {
        color: DetailColor.metal, mr: MR.metal,
      });
    }
    // Red obstruction light on tall masts — a night-readable pin-prick.
    if (top + mh > 55) {
      d.box(mx, top + mh + 0.12, mz, 0.16, 0.16, 0.16, 0, {
        color: lin(0xff3040), mr: [0, 0.4], emissive: emi(lin(0xff3040), 5.0),
      });
    }
  }

  // Satellite dish clusters on residential slabs.
  if (spec.style === FacadeStyle.cartier && tier === 2 && rng.bool(0.5)) {
    for (let i = 0; i < rng.int(2, 4); i++) {
      d.cyl(
        b.cx + rng.range(-b.hx * 0.8, b.hx * 0.8), top + 0.35,
        b.cz + rng.range(-b.hz * 0.8, b.hz * 0.8),
        0.02, 0.42, 0.5, 5, { color: DetailColor.metalPale, mr: [0.2, 0.6] }, false,
      );
    }
  }
  void site;
}

/* ------------------------------------------------------------------ */
/* Street level                                                        */
/* ------------------------------------------------------------------ */

function entrance(
  d: DetailBuilder,
  site: BuildingSite,
  groundH: number,
  style: number,
  rng: Rng,
): void {
  // Push the canopy just proud of the street-facing wall.
  const along = { x: -site.fz, z: site.fx };
  const half = (Math.abs(site.fx) > 0.5 ? site.d : site.w) / 2;
  const off = rng.range(-0.25, 0.25) * (Math.abs(site.fx) > 0.5 ? site.w : site.d);
  const ex = site.cx + site.fx * half + along.x * off;
  const ez = site.cz + site.fz * half + along.z * off;

  const canopyY = Math.min(groundH - 0.6, 4.2);
  const proj = style === FocusGlass ? 3.2 : 2.0;
  const wide = style === FocusGlass ? 9.0 : 4.6;

  // Canopy slab.
  d.box(
    ex + site.fx * proj * 0.4, canopyY, ez + site.fz * proj * 0.4,
    Math.abs(site.fx) > 0.5 ? proj : wide, 0.26, Math.abs(site.fx) > 0.5 ? wide : proj, 0,
    { color: style === FocusGlass ? DetailColor.alu : DetailColor.stone, mr: style === FocusGlass ? MR.metal : MR.stone },
  );
  // Under-canopy light — reads as a lit doorway at dusk and at night.
  d.box(
    ex + site.fx * proj * 0.4, canopyY - 0.16, ez + site.fz * proj * 0.4,
    Math.abs(site.fx) > 0.5 ? proj * 0.7 : wide * 0.7, 0.05, Math.abs(site.fx) > 0.5 ? wide * 0.7 : proj * 0.7, 0,
    { color: DetailColor.sodium, mr: [0, 0.4], emissive: emi(DetailColor.sodium, 2.2) },
  );
  // Columns.
  for (const s of [-1, 1]) {
    d.cyl(
      ex + site.fx * proj * 0.78 + along.x * s * wide * 0.42,
      0, ez + site.fz * proj * 0.78 + along.z * s * wide * 0.42,
      0.14, 0.12, canopyY, 5, { color: DetailColor.metal, mr: MR.metal }, false,
    );
  }
  // Steps.
  d.box(
    ex + site.fx * 0.9, 0.12, ez + site.fz * 0.9,
    Math.abs(site.fx) > 0.5 ? 1.8 : wide * 0.8, 0.24, Math.abs(site.fx) > 0.5 ? wide * 0.8 : 1.8, 0,
    { color: DetailColor.stone, mr: MR.stone },
  );
}

const FocusGlass = FacadeStyle.glassCorporate as number;

function awnings(d: DetailBuilder, site: BuildingSite, groundH: number, rng: Rng): void {
  const along = { x: -site.fz, z: site.fx };
  const half = (Math.abs(site.fx) > 0.5 ? site.d : site.w) / 2;
  const span = Math.abs(site.fx) > 0.5 ? site.d : site.w;
  const n = Math.max(1, Math.floor(span / 7));
  for (let i = 0; i < n; i++) {
    if (!rng.bool(0.55)) continue;
    const t = (i + 0.5) / n - 0.5;
    const ax = site.cx + site.fx * (half + 0.9) + along.x * t * span;
    const az = site.cz + site.fz * (half + 0.9) + along.z * t * span;
    d.box(
      ax, groundH - 1.3, az,
      Math.abs(site.fx) > 0.5 ? 1.8 : span / n * 0.8, 0.14,
      Math.abs(site.fx) > 0.5 ? span / n * 0.8 : 1.8, 0,
      { color: DetailColor.awning, mr: MR.paint },
    );
  }
}

function balconies(
  d: DetailBuilder,
  site: BuildingSite,
  groundH: number,
  floorH: number,
  floors: number,
  _topOfBase: number,
  rng: Rng,
): void {
  const along = { x: -site.fz, z: site.fx };
  const half = (Math.abs(site.fx) > 0.5 ? site.d : site.w) / 2;
  const span = Math.abs(site.fx) > 0.5 ? site.d : site.w;
  const bays = Math.max(1, Math.floor(span / 4.2));
  const proj = 1.25;
  let budget = 11;

  for (let fl = 1; fl < floors && budget > 0; fl += 1) {
    const y = groundH + fl * floorH;
    for (let b = 0; b < bays && budget > 0; b += 2) {
      if (!rng.bool(0.7)) continue;
      const t = (b + 0.5) / bays - 0.5;
      const bx = site.cx + site.fx * (half + proj / 2) + along.x * t * span;
      const bz = site.cz + site.fz * (half + proj / 2) + along.z * t * span;
      const bw = span / bays * 0.86;
      // Slab.
      d.box(
        bx, y + 0.09, bz,
        Math.abs(site.fx) > 0.5 ? proj : bw, 0.18, Math.abs(site.fx) > 0.5 ? bw : proj, 0,
        { color: DetailColor.concrete, mr: MR.concrete },
      );
      // Front panel — glazed-in loggia on some, open rail on others.
      const glazed = rng.bool(0.45);
      d.box(
        bx + site.fx * proj * 0.45, y + 0.6, bz + site.fz * proj * 0.45,
        Math.abs(site.fx) > 0.5 ? 0.1 : bw, 1.05, Math.abs(site.fx) > 0.5 ? bw : 0.1, 0,
        glazed
          ? { color: DetailColor.glassDark, mr: MR.glass }
          : { color: DetailColor.concreteDark, mr: MR.concrete },
      );
      budget--;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Facade screens                                                      */
/* ------------------------------------------------------------------ */

/**
 * A wall-mounted media screen. The reference frame has two enormous political
 * portraits on the tower's curtain wall; this emits the housing plus an
 * emissive plate whose colour is driven by the screens material set up in
 * city.ts (see `createScreenMaterial`).
 */
function facadeScreen(
  d: DetailBuilder,
  site: BuildingSite,
  groundH: number,
  h: number,
  rng: Rng,
): void {
  const along = { x: -site.fz, z: site.fx };
  const half = (Math.abs(site.fx) > 0.5 ? site.d : site.w) / 2;
  const span = Math.abs(site.fx) > 0.5 ? site.d : site.w;
  const sw = Math.min(span * 0.42, rng.range(7, 12));
  const sh = sw * rng.range(1.25, 1.7);
  const y = groundH + rng.range(4, Math.max(6, (h - groundH) * 0.42));
  const t = rng.range(-0.28, 0.28);
  const sx = site.cx + site.fx * (half + 0.22) + along.x * t * span;
  const sz = site.cz + site.fz * (half + 0.22) + along.z * t * span;
  mediaScreen(d, sx, y, sz, sw, sh, site.fx, site.fz, rng);
}

/**
 * A wall-mounted media screen showing an enormous political portrait: dark
 * bezel, a lit ground, a head-and-shoulders block in flesh tone and a caption
 * bar. Crude in isolation, unmistakable at facade scale, which is exactly how
 * it reads in the reference frame.
 */
export function mediaScreen(
  d: DetailBuilder,
  x: number, y: number, z: number,
  w: number, h: number,
  /** Outward normal of the wall the screen is mounted on. */
  nx: number, nz: number,
  rng: Rng,
): void {
  const facesX = Math.abs(nx) > 0.5;
  const sx = facesX ? 0.22 : w;
  const sz = facesX ? w : 0.22;
  const tint = rng.bool(0.5) ? DetailColor.screen : DetailColor.purple;

  // Housing sits behind; every emissive layer is stepped forward along the
  // wall normal, or the housing swallows the picture entirely.
  const at = (out: number): [number, number] => [x + nx * out, z + nz * out];

  const [hx, hz] = at(0);
  d.box(hx, y + h / 2, hz, sx + 0.6, h + 0.6, sz + 0.6, 0, {
    color: DetailColor.metal, mr: MR.metal,
  });
  const [fx, fz] = at(0.36);
  d.box(fx, y + h / 2, fz, sx, h, sz, 0, {
    color: tint, mr: [0, 0.3], emissive: emi(tint, 0.55),
  });
  const [cx, cz] = at(0.5);
  // Hair, head, shoulders, caption: a head-and-shoulders portrait at facade scale.
  d.box(cx, y + h * 0.74, cz, sx * 0.34, h * 0.10, sz * 0.34, 0, {
    color: lin(0x2c2530), mr: [0, 0.5], emissive: emi(lin(0x413848), 0.6),
  });
  d.box(cx, y + h * 0.62, cz, sx * 0.30, h * 0.20, sz * 0.30, 0, {
    color: lin(0xd9b79b), mr: [0, 0.4], emissive: emi(lin(0xd9b79b), 1.15),
  });
  d.box(cx, y + h * 0.36, cz, sx * 0.62, h * 0.28, sz * 0.62, 0, {
    color: lin(0x241d33), mr: [0, 0.4], emissive: emi(lin(0x3d3157), 0.8),
  });
  d.box(cx, y + h * 0.10, cz, sx * 0.9, h * 0.07, sz * 0.9, 0, {
    color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 2.0),
  });
}

/* ------------------------------------------------------------------ */
/* Shared small-object builders used by roads/landmarks                */
/* ------------------------------------------------------------------ */

/**
 * Tall sodium street lamp with a raked gooseneck head.
 * Budgeted at ~58 triangles: there are several thousand of these in the city.
 */
export function streetLamp(
  d: DetailBuilder,
  x: number, z: number,
  inwardX: number, inwardZ: number,
  height: number,
  y0 = 0.17,
): void {
  const alongX = Math.abs(inwardX) > 0.5;
  d.cyl(x, y0, z, 0.155, 0.085, height, 5, { color: DetailColor.metal, mr: MR.metal }, false);
  const reach = 1.9;
  // Single raked arm — cheaper than an arc and reads the same in silhouette.
  d.box(
    x + inwardX * reach * 0.5, y0 + height + 0.34, z + inwardZ * reach * 0.5,
    alongX ? reach : 0.1, 0.62, alongX ? 0.1 : reach,
    0, { color: DetailColor.metal, mr: MR.metal },
  );
  const hx = x + inwardX * reach;
  const hz = z + inwardZ * reach;
  const hy = y0 + height + 0.6;
  d.box(hx, hy + 0.11, hz, alongX ? 0.95 : 0.42, 0.18, alongX ? 0.42 : 0.95, 0, {
    color: DetailColor.metalPale, mr: MR.metal,
  });
  d.box(hx, hy - 0.03, hz, alongX ? 0.86 : 0.36, 0.1, alongX ? 0.36 : 0.86, 0, {
    color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 7.0),
  });
}

/**
 * A parked car at the kerb — boxy 1970s Dacia 1300 proportions, mismatched
 * panels and a chrome bumper, exactly like the hero car in the reference.
 * Static dressing only; the vehicle system owns anything that drives.
 * ~110 triangles.
 */
export function parkedCar(
  d: DetailBuilder,
  x: number, z: number,
  headingRad: number,
  rng: Rng,
): void {
  const body = rng.weighted(
    [PAL.daciaYellow, lin(0x9aa3ad), lin(0x6d2f33), lin(0x2f4a6d), lin(0x8d8b7a), PAL.daciaPurple],
    [3, 2, 1.4, 1.6, 1.2, 0.8],
  );
  const beat = rng.bool(0.3);
  const panel = beat ? PAL.daciaPurple : body;
  const bodyMR: [number, number] = [0.35, rng.range(0.28, 0.55)];
  const L = 4.35;
  const W = 1.62;

  // Lower body.
  d.box(x, 0.72, z, L, 0.72, W, headingRad, { color: body, mr: bodyMR });
  // One mismatched wing/door panel.
  if (beat) {
    d.box(
      x + Math.cos(headingRad) * -0.9, 0.74, z - Math.sin(headingRad) * -0.9,
      1.5, 0.68, W + 0.03, headingRad, { color: panel, mr: [0.25, 0.62] },
    );
  }
  // Greenhouse, set back from the nose — the boxy Dacia profile.
  d.box(x - Math.cos(headingRad) * 0.18, 1.36, z + Math.sin(headingRad) * 0.18,
    L * 0.5, 0.62, W * 0.92, headingRad, { color: DetailColor.glassDark, mr: MR.glass });
  // Roof.
  d.box(x - Math.cos(headingRad) * 0.18, 1.68, z + Math.sin(headingRad) * 0.18,
    L * 0.5, 0.06, W * 0.94, headingRad, { color: body, mr: bodyMR });
  // Chrome bumpers.
  for (const s of [1, -1]) {
    d.box(
      x + Math.cos(headingRad) * s * L * 0.49, 0.56, z - Math.sin(headingRad) * s * L * 0.49,
      0.14, 0.17, W * 0.98, headingRad, { color: lin(0xb9c0c6), mr: [0.95, 0.2] },
    );
  }
  // Headlight band — two round lamps read as one bar at parked-car distance.
  d.box(
    x + Math.cos(headingRad) * L * 0.47, 0.86, z - Math.sin(headingRad) * L * 0.47,
    0.09, 0.24, W * 0.86, headingRad, { color: lin(0xd8dce0), mr: [0.6, 0.12] },
  );
  // Wheels, as one slab per side (the inboard faces are never visible).
  for (const sx of [0.32, -0.32]) {
    const wx = x + Math.cos(headingRad) * L * sx;
    const wz = z - Math.sin(headingRad) * L * sx;
    d.box(wx, 0.31, wz, 0.62, 0.6, W + 0.12, headingRad, { color: lin(0x18161c), mr: [0.1, 0.85] });
  }
}

/**
 * Autumn plane tree — the CITY's mass street tree. There are thousands of
 * these, so it is budgeted at ~90 triangles and every one of them has to earn
 * its place in the silhouette.
 *
 * WHAT WAS WRONG. The previous crown was three stacked six-sided frusta. A
 * six-sided frustum seen from the side is a hexagon with a hard straight edge,
 * and three of them stacked is one big hexagon: against a bright magenta sky
 * every street tree in Bucharest rendered as an enormous flat dark plate on a
 * stick. That is the single worst object in the game, and no amount of colour
 * or translucency work can fix it, because the failure is the SILHOUETTE.
 *
 * WHAT FIXES IT. A crown has to be made of several small overlapping masses,
 * not one large one, so its outline is ragged at every scale and the sky shows
 * through it. Five 10-sided cluster hulls at 0.7-1.2 m, hung off a short
 * branch armature at different heights and offsets, cost about the same as the
 * three frusta did and read as a thinning autumn canopy instead of a kite.
 */
export function planeTree(d: DetailBuilder, x: number, z: number, rng: Rng, scale = 1): void {
  // A mature Bucharest plane tree: 7-10 m tall over a 2.4-3.2 m clear trunk,
  // crown 4-6 m across. Checked against a 1.8 m person and a 7-9 m lamp head.
  const h = rng.range(7.0, 10.0) * scale;
  const trunkH = rng.range(2.4, 3.2) * scale;
  const trunkR = 0.16 * scale;
  const bark = { color: DetailColor.bark, mr: MR.rough };
  d.cyl(x, 0.17, z, trunkR * 1.5, trunkR * 0.85, trunkH, 5, bark, false);

  const crownY = 0.17 + trunkH;
  const crownH = h - trunkH;
  const r = rng.range(1.9, 2.7) * scale;

  // Three stub limbs. Cheap, but they are what stops the crown floating.
  const lean = rng.range(0, Math.PI * 2);
  const arms: Array<[number, number, number]> = [];
  for (let i = 0; i < 3; i++) {
    const a = lean + (i / 3) * Math.PI * 2;
    const ax = x + Math.cos(a) * r * 0.45;
    const az = z + Math.sin(a) * r * 0.45;
    const ay = crownY + crownH * rng.range(0.25, 0.45);
    d.cyl(ax, crownY - 0.3, az, trunkR * 0.5, trunkR * 0.3, ay - crownY + 0.3, 4, bark, false);
    arms.push([ax, ay, az]);
  }

  // Late autumn: some clusters have already gone, so the crown is see-through.
  const thin = rng.range(0.0, 0.45);
  const warm = rng.bool(0.72);
  for (let i = 0; i < 5; i++) {
    if (rng.next() < thin) continue;
    const [ax, ay, az] = arms[i % 3];
    const cr = rng.range(0.62, 1.05) * scale;
    const cx = ax + rng.range(-r * 0.45, r * 0.45);
    const cz = az + rng.range(-r * 0.45, r * 0.45);
    const cy = ay + rng.range(-0.3, crownH * 0.42);
    const leaf = warm
      ? (rng.bool(0.5) ? DetailColor.leaf : lin(0xc0913f))
      : DetailColor.leafOlive;
    // A 10-sided double frustum: round enough that its outline never reads as
    // a polygon, and it still only costs 20 triangles.
    const o = { color: leaf, mr: MR.rough };
    d.cyl(cx, cy - cr * 0.55, cz, cr * 0.22, cr, cr * 0.55, 10, o, false);
    d.cyl(cx, cy, cz, cr, cr * 0.24, cr * 0.62, 10, o, false);
  }
}

/** Concrete anti-ram bollard, as in the reference foreground. ~18 triangles. */
export function bollard(d: DetailBuilder, x: number, z: number): void {
  d.cyl(x, 0.17, z, 0.24, 0.19, 1.0, 6, { color: DetailColor.stone, mr: MR.stone });
}

/** Mesh crowd-control barrier — a run of `n` panels. */
export function crowdBarrier(
  d: DetailBuilder,
  x: number, z: number,
  dirX: number, dirZ: number,
  n: number,
  rng: Rng,
): void {
  const panel = 2.1;
  const col = { color: DetailColor.metalPale, mr: MR.metal };
  for (let i = 0; i < n; i++) {
    const px = x + dirX * panel * i;
    const pz = z + dirZ * panel * i;
    const lean = rng.range(-0.05, 0.05);
    // Top and bottom rails.
    for (const y of [1.06, 0.42]) {
      d.box(
        px + dirX * panel * 0.5, y + 0.17, pz + dirZ * panel * 0.5,
        Math.abs(dirX) > 0.5 ? panel : 0.05, 0.05, Math.abs(dirZ) > 0.5 ? panel : 0.05, lean, col,
      );
    }
    // Verticals.
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      d.box(px + dirX * panel * t, 0.17 + 0.74, pz + dirZ * panel * t, 0.045, 0.72, 0.045, lean, col);
    }
    // Feet.
    d.box(px, 0.19, pz, 0.5, 0.06, 0.5, lean, col);
  }
}

/** Litter bin. ~18 triangles. */
export function wasteBin(d: DetailBuilder, x: number, z: number, rng: Rng): void {
  d.cyl(x, 0.17, z, 0.28, 0.34, 0.96, 6, {
    color: rng.bool(0.5) ? DetailColor.metal : lin(0x2f4a34), mr: [0.4, 0.6],
  });
}
