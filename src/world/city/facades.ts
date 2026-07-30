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
  insetPolygon,
  lFootprint,
  rectFootprint,
  type DetailOpts,
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
  /*
   * LATE-AUTUMN FOLIAGE. Five leaf tones, not one: a crown built from a single
   * colour reads as a painted shape however good its silhouette is, because
   * real autumn foliage turns cluster by cluster. Gold and amber dominate,
   * rust marks the clusters that turned first, olive the ones that have not
   * turned at all, and pale is what a backlit cluster bleaches to.
   */
  /*
   * AUTHORED DARK ON PURPOSE. A turned plane leaf measures around 0.20-0.30
   * linear in red and under 0.05 in blue — it is a saturated, fairly DARK
   * surface whose brightness in the reference frame comes from the sun coming
   * THROUGH it, not from its albedo. Authored at the obvious "autumn gold"
   * value (0xd8a94f, i.e. 0.69 linear red) every crown in the city bleached to
   * cream under the key and the translucency had nothing left to add.
   */
  leaf: lin(0x8a5a1c),
  leafGold: lin(0xa06c20),
  leafRust: lin(0x74341a),
  leafPale: lin(0xa8843c),
  leafOlive: lin(0x4a5626),
  bark: PAL.trunkBark,
  barkPale: lin(0x5e4e40),
} as const;

/*
 * ROUGHNESS FOR THE DETAIL PASS. Cornices, parapets, kerbstones, steps and
 * bollards are weathered masonry sitting outdoors in a polluted city — they are
 * dusty, chalky and matte. Authored at 0.72 the stone details picked up a
 * specular sheen off a three-degree sun and every parapet in the city ran a
 * bright hot line along its top edge, which is what made the concrete read as
 * wet. Real weathered precast measures 0.85-0.95.
 */
const MR = {
  stone: [0.0, 0.86] as [number, number],
  concrete: [0.0, 0.92] as [number, number],
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

/**
 * A plot, ALWAYS DESCRIBED IN ITS OWN FRAME.
 *
 * `rot` puts local +x along the street frontage and local +z into the plot,
 * away from the street, so `w` is always the frontage and `d` is always the
 * depth whichever way the building happens to point. Every detail pass below
 * builds in that frame and hands `rot` to the box builder.
 *
 * IT DID NOT USED TO WORK THIS WAY, and that was a bug worth writing down. The
 * grid only ever produced plots facing one of four directions, so the passes
 * picked their dimensions with `Math.abs(site.fx) > 0.5 ? d : w` — and picked
 * the wrong one: an east-facing plot measured its distance to the front wall
 * with its FRONTAGE, so its balconies, canopy and neon hung five to ten metres
 * out in mid-air over the pavement. Real Bucharest streets run at every angle,
 * which forced the frame to be explicit, which is what surfaced it.
 */
export interface BuildingSite {
  cx: number;
  cz: number;
  /** Frontage (along local +x) and depth (along local +z, away from street). */
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

/** Point at local (lx, lz) of a site, in world space. */
function local(site: BuildingSite, lx: number, lz: number): [number, number] {
  const c = Math.cos(site.rot);
  const s = Math.sin(site.rot);
  return [site.cx + lx * c + lz * s, site.cz - lx * s + lz * c];
}

/** Extent of a footprint in the site's own frame. */
function localBounds(
  fp: ReadonlyArray<Vec2>, site: BuildingSite,
): { u0: number; u1: number; v0: number; v1: number } {
  const c = Math.cos(site.rot);
  const s = Math.sin(site.rot);
  let u0 = Infinity; let u1 = -Infinity; let v0 = Infinity; let v1 = -Infinity;
  for (const p of fp) {
    const ox = p.x - site.cx;
    const oz = p.z - site.cz;
    const u = ox * c - oz * s;
    const v = ox * s + oz * c;
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  return { u0, u1, v0, v1 };
}

export interface BuiltBuilding {
  height: number;
  /**
   * Half extents IN THE BUILDING'S OWN FRAME, with the world-space centre of
   * that box. The collider and the blocking query both rotate by `site.rot`;
   * using a world AABB on a skewed plot inflates it by up to 40% and pushes an
   * invisible wall out into the street.
   */
  hx: number;
  hz: number;
  cx: number;
  cz: number;
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
  opts: {
    heightScale?: number;
    forceStyle?: number;
    /**
     * A REAL OSM OUTLINE, in world space, clockwise from above.
     *
     * When present it replaces the generated rectangle: the walls, the roof cap
     * and the parapet all follow Bucharest's actual block shape, while
     * everything else still comes out of the grammar.
     */
    footprint?: ReadonlyArray<Vec2>;
    /** Storeys from the survey. Overrides the district's height populations. */
    levels?: number;
  } = {},
): BuiltBuilding {
  const tier = detailTier(site.heroDist);
  const floorH = rng.range(spec.floorH[0], spec.floorH[1]);
  const bayW = rng.range(spec.bayW[0], spec.bayW[1]);
  const groundH = rng.range(spec.groundH[0], spec.groundH[1]);
  const style = opts.forceStyle ?? spec.style;

  // Height snapped to whole storeys so the grammar's floor lines meet the roof.
  // Two populations, never one wide range — see TowerSpec in districts.ts.
  let floors: number;
  if (opts.levels !== undefined && opts.levels > 0) {
    // The survey knows. `building:levels` counts the storeys ABOVE ground, and
    // the ground floor of a Bucharest block is taller than the rest.
    floors = Math.max(1, Math.round(opts.levels) - 1);
  } else {
    const isTower = spec.tower !== null && rng.bool(spec.tower.chance);
    const range = isTower ? spec.tower!.height : spec.height;
    const wanted = rng.range(range[0], range[1]) * (opts.heightScale ?? 1);
    floors = Math.max(1, Math.round((wanted - groundH) / floorH));
  }

  /*
   * SLENDERNESS CAP.
   *
   * A storey count from the survey lands on whatever plan the survey gives it,
   * and the compressed map plus a plot squeezed to fit between two streets can
   * leave an eight-metre footprint carrying twelve floors. Those came out as
   * pencil towers standing over the boulevards — the most obviously wrong thing
   * in the first aerial pass, because nothing in Bucharest looks like that.
   * Real slender blocks bottom out around 1:5.
   */
  const slim = Math.max(4, Math.min(site.w, site.d));
  const maxH = Math.max(11, slim * 5.0);
  if (groundH + floors * floorH > maxH) {
    floors = Math.max(1, Math.floor((maxH - groundH) / floorH));
  }
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
  // A real outline already has a shape of its own and never wants one.
  const lPlan = !opts.footprint
    && style !== FacadeStyle.glassCorporate && rng.bool(0.26) && w > 18 && dep > 14;
  const base: Vec2[] = opts.footprint
    ? (opts.footprint as Vec2[])
    : lPlan
      ? lFootprint(cx, cz, w, dep, w * rng.range(0.3, 0.45), dep * rng.range(0.3, 0.45), rot)
      : rectFootprint(cx, cz, w, dep, rot);

  const setback = !opts.footprint && rng.bool(spec.setback) && h > groundH + floorH * 5;
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
  if (tier === 2 && style === FacadeStyle.interbelic) {
    continuousBalconies(d, site, groundH, floorH, Math.min(floors, 10), rng);
  }

  /* ---------------- facade signage ---------------- */

  /*
   * Signage is a huge part of what makes the reference photograph read as
   * Bucharest and not as any other European capital: vertical neon down the
   * facades, painted hoardings across every blank flank, and boards on the
   * roofs. It is rationed by style so that the old town and the boulevards
   * carry most of it, which is where it actually is.
   */
  if (tier >= 1 && h > groundH + floorH * 3) {
    const vChance = style === FacadeStyle.centruVechi ? 0.15
      : style === FacadeStyle.bulevard ? 0.13
        : style === FacadeStyle.cartier ? 0.04 : 0.03;
    if (rng.bool(vChance)) verticalSign(d, site, groundH, h, rng);

    const wChance = style === FacadeStyle.bulevard ? 0.10
      : style === FacadeStyle.cartier ? 0.07
        : style === FacadeStyle.industrial ? 0.10 : 0.03;
    if (rng.bool(wChance)) wallBillboard(d, site, groundH, h, rng);
  }

  /* ---------------- facade screens (the reference's political portraits) ---- */

  if (style === FacadeStyle.glassCorporate && tier >= 1 && h > 40 && rng.bool(0.5)) {
    facadeScreen(d, site, groundH, h, rng);
  }

  const lb = localBounds(base, site);
  const [wcx, wcz] = local(site, (lb.u0 + lb.u1) / 2, (lb.v0 + lb.v1) / 2);
  return {
    height: h,
    hx: (lb.u1 - lb.u0) / 2,
    hz: (lb.v1 - lb.v0) / 2,
    cx: wcx,
    cz: wcz,
  };
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
  // Bands FOLLOW THE FOOTPRINT. An axis-aligned ring was fine while every
  // building was a world-aligned box; on a plot that sits at 30 degrees to the
  // grid — which is most of Calea Victoriei — it floats off two corners and
  // buries itself in the other two.
  const parapetH = style === FacadeStyle.glassCorporate ? 1.0 : rng.range(0.85, 1.35);
  const parapetCol = style === FacadeStyle.glassCorporate
    ? DetailColor.alu
    : style === FacadeStyle.guvern
      ? DetailColor.stone
      : DetailColor.concrete;
  const parapetMR = style === FacadeStyle.glassCorporate ? MR.metal : MR.concrete;
  d.ringPoly(fp, top, 0.34, parapetH, { color: parapetCol, mr: parapetMR });

  if (tier === 0) return;

  // Projecting cornice below the parapet on masonry styles.
  if (style !== FacadeStyle.glassCorporate && style !== FacadeStyle.industrial) {
    const proj = style === FacadeStyle.guvern ? 1.05 : style === FacadeStyle.centruVechi ? 0.8 : 0.55;
    const ch = style === FacadeStyle.guvern ? 1.15 : 0.55;
    d.ringPoly(
      insetPolygon(fp, -proj), top - ch, proj + 0.34, ch,
      { color: style === FacadeStyle.guvern ? DetailColor.stone : DetailColor.stoneDark, mr: MR.stone },
    );
    // Second, thinner band — reads as a moulding profile in raking sun.
    if (tier === 2 && (style === FacadeStyle.centruVechi || style === FacadeStyle.guvern)) {
      d.ringPoly(
        insetPolygon(fp, -proj * 0.55), top - ch - 0.42, proj * 0.55 + 0.3, 0.3,
        { color: DetailColor.stone, mr: MR.stone },
      );
    }
  }

  // Coping shadow line on the main mass of glass towers.
  if (isMain && style === FacadeStyle.glassCorporate && tier >= 1) {
    d.ringPoly(insetPolygon(fp, -0.45), top - 0.5, 0.6, 0.28, {
      color: DetailColor.metal, mr: MR.metal,
    });
  }
  void site;
}

/* ------------------------------------------------------------------ */
/* Roofscape                                                           */
/* ------------------------------------------------------------------ */

/**
 * A satellite dish on a short pole. ~16 triangles.
 *
 * These are not garnish. In the Magheru photograph the dishes are the single
 * most repeated object in the whole frame — every parapet, every balcony, every
 * roof, in profusion — and a Bucharest roof without them reads as any city's
 * roof. Cheap enough to afford on every building in the city.
 */
function satelliteDish(d: DetailBuilder, x: number, y: number, z: number, rng: Rng): void {
  const r = rng.range(0.28, 0.48);
  d.cyl(x, y, z, 0.035, 0.035, rng.range(0.35, 0.75), 4,
    { color: DetailColor.metal, mr: MR.metal }, false);
  // The dish itself: a shallow cone, tilted by opening the cylinder's radii.
  d.cyl(x, y + 0.5, z, 0.03, r, r * 0.55, 6,
    { color: DetailColor.metalPale, mr: [0.2, 0.62] }, false);
  void rng;
}

/** Brick or precast flue stack. ~12 triangles. */
function chimneyStack(d: DetailBuilder, x: number, y: number, z: number, rng: Rng): void {
  const h = rng.range(0.9, 2.4);
  d.box(x, y + h / 2, z, rng.range(0.5, 1.1), h, rng.range(0.5, 0.9), 0, {
    color: rng.bool(0.4) ? DetailColor.rust : DetailColor.concreteDark, mr: MR.concrete,
  });
}

/**
 * A rooftop advertising hoarding on an open steel scaffold.
 *
 * THE MAGHERU SIGNATURE. The reference photograph's strongest single element is
 * the Coca-Cola hoarding standing clear of a parapet on an exposed steel frame,
 * and there are four more like it in the same frame. It is what makes a
 * Bucharest roofline read as Bucharest rather than as generic roof plant, and
 * because it stands ABOVE the parapet it is the one rooftop object that is
 * legible from street level and from the air alike.
 *
 * ~90 triangles, so it is rationed by tier and by chance.
 */
function rooftopHoarding(
  d: DetailBuilder,
  /** LOCAL bounds of the roof, in the site's frame. */
  b: { cx: number; cz: number; hx: number; hz: number },
  top: number,
  rng: Rng,
  tier: 0 | 1 | 2,
  site: BuildingSite,
): void {
  // Face the long axis of the roof so the board presents to the street.
  const alongX = b.hx >= b.hz;
  const w = Math.min((alongX ? b.hx : b.hz) * 1.85, rng.range(7, 16));
  const h = w * rng.range(0.28, 0.42);
  const stand = rng.range(1.6, 3.4);      // clear height above the roof
  const y = top + stand + h / 2;
  // Sit it over one edge of the roof, as the real ones do.
  const side = rng.bool(0.5) ? 1 : -1;
  const pu = b.cx + (alongX ? 0 : side * b.hx * 0.6);
  const pv = b.cz + (alongX ? side * b.hz * 0.6 : 0);
  const rot = site.rot;
  const w2 = (lx: number, lz: number): [number, number] => local(site, lx, lz);
  const [px, pz] = w2(pu, pv);

  const sx = alongX ? w : 0.28;
  const sz = alongX ? 0.28 : w;

  // Backing panel, then the printed face stepped forward so it is never
  // z-fighting with its own backing.
  d.box(px, y, pz, sx, h, sz, rot, { color: DetailColor.metal, mr: MR.metal });
  /*
   * Advertising is SATURATED and it is the only pure hue on a Bucharest
   * roofline — everything else up there is grey, rust and bitumen. Held
   * emissive so the boards still read after the sun has gone.
   */
  const ink = rng.weighted(
    [lin(0xd8232a), lin(0x1a4fa0), lin(0x159a4c), lin(0xe8a013), lin(0xd0d4d8)],
    [3, 2, 1.6, 2, 1.2],
  );
  const face = alongX ? [w * 0.94, h * 0.86, 0.1] : [0.1, h * 0.86, w * 0.94];
  const [fx, fz] = w2(pu + (alongX ? 0 : side * 0.2), pv + (alongX ? side * 0.2 : 0));
  d.box(fx, y, fz, face[0], face[1], face[2], rot,
    { color: ink, mr: [0, 0.62], emissive: emi(ink, 0.5) });

  if (tier >= 1) {
    // Lettering: three pale blocks across the board. At rooftop distance a word
    // IS three light blocks, and that is all the eye asks of it.
    for (let i = 0; i < 3; i++) {
      const t = (i - 1) * w * 0.26;
      const lw = w * 0.17;
      const [lx, lz] = w2(
        pu + (alongX ? t : side * 0.28), pv + (alongX ? side * 0.28 : t),
      );
      d.box(
        lx, y + h * 0.06, lz,
        alongX ? lw : 0.06, h * 0.3, alongX ? 0.06 : lw, rot,
        { color: lin(0xf2ece0), mr: [0, 0.5], emissive: emi(lin(0xf2ece0), 0.9) },
      );
    }
  }

  // The scaffold: raking legs down to the roof, left deliberately open.
  const legs = tier === 0 ? 2 : 4;
  for (let i = 0; i < legs; i++) {
    const t = (i / Math.max(1, legs - 1) - 0.5) * w * 0.82;
    const [lx, lz] = w2(pu + (alongX ? t : 0), pv + (alongX ? 0 : t));
    d.tube(lx, top, lz, lx, y + h / 2, lz, 0.075, 3,
      { color: DetailColor.metal, mr: MR.metal });
    if (tier >= 1) {
      // Back stay, which is what makes it read as a frame and not a wall.
      const [bx, bz] = w2(
        pu - (alongX ? 0 : side * 2.2), pv - (alongX ? side * 2.2 : 0),
      );
      d.tube(lx, top, lz, bx, y - h * 0.3, bz, 0.05, 3,
        { color: DetailColor.metal, mr: MR.metal });
    }
  }
}

/**
 * EVERY ROOF IN THIS CITY IS SEEN. The boulevards are wide, the buildings are
 * now low, and the game has both an elevated camera and a street camera looking
 * up — so a bare roof slab is visible from almost anywhere. The reference is
 * emphatic on this: Bucharest's roofline is a mess of dishes, aerials, tanks,
 * flues, AC boxes and advertising scaffolds, and that mess is a large part of
 * what the city looks like.
 *
 * Clutter therefore runs at EVERY tier, including the far field, where it is
 * the difference between a skyline of blank boxes and a skyline of buildings.
 * The far tier is budgeted at roughly 50 triangles a roof.
 */
function roofscape(
  d: DetailBuilder,
  fp: ReadonlyArray<Vec2>,
  top: number,
  tier: 0 | 1 | 2,
  rng: Rng,
  spec: DistrictSpec,
  site: BuildingSite,
): void {
  // Scatter IN THE BUILDING'S OWN FRAME. Against the world axes a skewed roof
  // gets its plant thrown over the parapet and hanging in the street.
  const lb = localBounds(fp, site);
  const b = {
    cx: (lb.u0 + lb.u1) / 2, cz: (lb.v0 + lb.v1) / 2,
    hx: (lb.u1 - lb.u0) / 2, hz: (lb.v1 - lb.v0) / 2,
  };
  const heavy = rng.bool(spec.roofPlant);
  let ru = 0;
  let rv = 0;
  const pick = (k: number): void => {
    ru = b.cx + rng.range(-b.hx * k, b.hx * k);
    rv = b.cz + rng.range(-b.hz * k, b.hz * k);
  };
  const rx = (k: number): number => { pick(k); return local(site, ru, rv)[0]; };
  const rz = (_k: number): number => local(site, ru, rv)[1];

  // Lift shaft / stair head — the tallest thing on almost every roof.
  if (heavy || rng.bool(0.6)) {
    const sw = Math.min(b.hx * 1.0, rng.range(3.4, 6.2));
    const sd = Math.min(b.hz * 1.0, rng.range(3.0, 5.4));
    const sh = rng.range(2.6, 4.4);
    d.box(rx(0.4), top + sh / 2, rz(0.4), sw, sh, sd, site.rot, {
      color: DetailColor.concrete, mr: MR.concrete,
    });
  }

  // Advertising hoarding. Commonest on the boulevards, as in the reference.
  const adChance = spec.style === FacadeStyle.bulevard ? 0.20
    : spec.style === FacadeStyle.cartier ? 0.10
      : spec.style === FacadeStyle.centruVechi ? 0.08
        : spec.style === FacadeStyle.industrial ? 0.14 : 0.05;
  if (b.hx > 6 && b.hz > 5 && rng.bool(adChance)) {
    rooftopHoarding(d, b, top, rng, tier, site);
  }

  /*
   * DISHES ON EVERYTHING. Not a cartier special case any more — the reference
   * has them thick on interbelic boulevard blocks and old-town roofs too.
   */
  const dishes = spec.style === FacadeStyle.glassCorporate ? 0
    : tier === 2 ? rng.int(2, 7) : tier === 1 ? rng.int(1, 5) : rng.int(0, 3);
  for (let i = 0; i < dishes; i++) satelliteDish(d, rx(0.86), top, rz(0.86), rng);

  // Flue stacks — masonry buildings all have them.
  if (spec.style !== FacadeStyle.glassCorporate) {
    const flues = tier === 0 ? rng.int(0, 2) : rng.int(1, 4);
    for (let i = 0; i < flues; i++) chimneyStack(d, rx(0.8), top, rz(0.8), rng);
  }

  // Plant boxes: chillers, AHUs, ducting.
  const units = tier === 2 ? rng.int(2, 6) : tier === 1 ? rng.int(1, 4) : rng.int(0, 2);
  for (let i = 0; i < units; i++) {
    const uh = rng.range(0.9, 2.1);
    d.box(rx(0.72), top + uh / 2, rz(0.72), rng.range(1.6, 3.6), uh, rng.range(1.4, 3.0), site.rot, {
      color: rng.bool(0.5) ? DetailColor.metalPale : DetailColor.metal,
      mr: MR.metal,
    });
  }

  // Water tank on legs — a Bucharest rooftop signature.
  if (tier >= 1 && rng.bool(0.34)) {
    const tx = rx(0.5);
    const tz = rz(0.5);
    d.cyl(tx, top + 1.5, tz, 1.15, 1.15, 2.1, 6, { color: DetailColor.rust, mr: [0.4, 0.72] });
    d.box(tx, top + 0.75, tz, 1.7, 1.5, 1.7, 0, { color: DetailColor.metal, mr: MR.metal });
  }

  // Aerials and masts — thin, dark, and they carve the skyline against the sky.
  const masts = tier === 2 ? rng.int(1, 4) : tier === 1 ? rng.int(1, 3) : rng.int(0, 2);
  for (let i = 0; i < masts; i++) {
    const mx = rx(0.8);
    const mz = rz(0.8);
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
  // Push the canopy just proud of the street-facing wall. The wall is at local
  // z = -d/2 and the street is further out still.
  const front = -site.d / 2;
  const u = rng.range(-0.25, 0.25) * site.w;

  const canopyY = Math.min(groundH - 0.6, 4.2);
  const proj = style === FocusGlass ? 3.2 : 2.0;
  const wide = style === FocusGlass ? 9.0 : 4.6;
  const rot = site.rot;

  // Canopy slab.
  const [cx1, cz1] = local(site, u, front - proj * 0.4);
  d.box(
    cx1, canopyY, cz1, wide, 0.26, proj, rot,
    { color: style === FocusGlass ? DetailColor.alu : DetailColor.stone, mr: style === FocusGlass ? MR.metal : MR.stone },
  );
  // Under-canopy light — reads as a lit doorway at dusk and at night.
  d.box(
    cx1, canopyY - 0.16, cz1, wide * 0.7, 0.05, proj * 0.7, rot,
    { color: DetailColor.sodium, mr: [0, 0.4], emissive: emi(DetailColor.sodium, 2.2) },
  );
  // Columns.
  for (const s of [-1, 1]) {
    const [px, pz] = local(site, u + s * wide * 0.42, front - proj * 0.78);
    d.cyl(px, 0, pz, 0.14, 0.12, canopyY, 5, { color: DetailColor.metal, mr: MR.metal }, false);
  }
  // Steps.
  const [sx1, sz1] = local(site, u, front - 0.9);
  d.box(sx1, 0.12, sz1, wide * 0.8, 0.24, 1.8, rot, {
    color: DetailColor.stone, mr: MR.stone,
  });
}

const FocusGlass = FacadeStyle.glassCorporate as number;

function awnings(d: DetailBuilder, site: BuildingSite, groundH: number, rng: Rng): void {
  const span = site.w;
  const front = -site.d / 2;
  const n = Math.max(1, Math.floor(span / 7));
  for (let i = 0; i < n; i++) {
    if (!rng.bool(0.55)) continue;
    const t = (i + 0.5) / n - 0.5;
    const [ax, az] = local(site, t * span, front - 0.9);
    d.box(
      ax, groundH - 1.3, az,
      (span / n) * 0.8, 0.14, 1.8, site.rot,
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
  const span = site.w;
  const front = -site.d / 2;
  const bays = Math.max(1, Math.floor(span / 4.2));
  const proj = 1.25;
  let budget = 11;

  for (let fl = 1; fl < floors && budget > 0; fl += 1) {
    const y = groundH + fl * floorH;
    for (let b = 0; b < bays && budget > 0; b += 2) {
      if (!rng.bool(0.7)) continue;
      const t = (b + 0.5) / bays - 0.5;
      const bw = (span / bays) * 0.86;
      // Slab.
      const [bx, bz] = local(site, t * span, front - proj / 2);
      d.box(bx, y + 0.09, bz, bw, 0.18, proj, site.rot, {
        color: DetailColor.concrete, mr: MR.concrete,
      });
      // Front panel — glazed-in loggia on some, open rail on others.
      const glazed = rng.bool(0.45);
      const [px, pz] = local(site, t * span, front - proj * 0.95);
      d.box(
        px, y + 0.6, pz, bw, 1.05, 0.1, site.rot,
        glazed
          ? { color: DetailColor.glassDark, mr: MR.glass }
          : { color: DetailColor.concreteDark, mr: MR.concrete },
      );
      budget--;
    }
  }
}

/**
 * CONTINUOUS BALCONY BANDS — the interbelic signature in silhouette.
 *
 * The shader draws the recess and the parapet as relief, which shades
 * correctly but has no outline: seen along the elevation, or against the sky at
 * a corner, a relief balcony is still a flat wall. These are the real
 * projecting slabs, running the FULL width of the frontage rather than one per
 * bay — that unbroken horizontal line, repeated up the building, is what makes
 * Magheru's blocks read as 1930s modernism instead of as punched masonry.
 *
 * ~24 triangles per banded floor, hero-area buildings only.
 */
function continuousBalconies(
  d: DetailBuilder,
  site: BuildingSite,
  groundH: number,
  floorH: number,
  floors: number,
  rng: Rng,
): void {
  const front = -site.d / 2;
  const proj = rng.range(0.95, 1.45);
  // Balconies stop short of the vertical corner pier, as they really do.
  const runLen = site.w * 0.88;

  for (let fl = 1; fl < floors; fl++) {
    // The shader picks banded floors from the same kind of hash; an exact
    // match is not needed, only that roughly half the floors carry one and
    // that the slab lines up with a floor line.
    if (!rng.bool(0.55)) continue;
    const y = groundH + fl * floorH + 0.30;
    // Slab.
    const [cx, cz] = local(site, 0, front - proj / 2);
    d.box(cx, y, cz, runLen, 0.20, proj, site.rot, {
      color: DetailColor.stone, mr: MR.stone,
    });
    // Solid rendered parapet closing its front — never an open rail on these.
    const [px, pz] = local(site, 0, front - proj * 0.94);
    d.box(px, y + 0.52, pz, runLen, 0.86, 0.12, site.rot, {
      color: DetailColor.stone, mr: MR.stone,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Vertical facade signage                                             */
/* ------------------------------------------------------------------ */

/**
 * A VERTICAL NEON SIGN running down the face of a building.
 *
 * "TEATRUL NOTTARA" in the reference photograph — a tall narrow box standing
 * proud of the facade with the name reading top-to-bottom, one letter per cell.
 * Bucharest is full of them (theatres, cinemas, hotels, pharmacies) and they
 * are one of the few things in the city that is bright, vertical and man-made
 * against an otherwise horizontal weathered wall. They also read from a long
 * way down a boulevard, which is exactly the shot this game keeps taking.
 *
 * The letters are not glyphs, they are lit cells with a dark bar across them —
 * at the distance a sign like this is ever seen, that is indistinguishable from
 * type, and it costs 12 triangles a letter instead of an atlas lookup.
 */
function verticalSign(
  d: DetailBuilder,
  site: BuildingSite,
  groundH: number,
  h: number,
  rng: Rng,
): void {
  const span = site.w;
  const front = -site.d / 2;

  // Hung near one end of the frontage, as they always are — they mark a
  // doorway, not the middle of an elevation.
  const t = (rng.bool(0.5) ? 1 : -1) * rng.range(0.28, 0.42);
  const cells = rng.int(5, 10);
  const cell = rng.range(0.78, 1.05);
  const sh = cells * cell;
  // Top of the sign sits below the cornice; bottom clears the shopfront.
  const yTop = Math.min(h - 1.6, groundH + 1.2 + sh);
  const yBot = yTop - sh;
  if (yBot < groundH * 0.6) return;

  const u = t * span;
  const [bx, bz] = local(site, u, front - 0.30);
  const w = cell * 0.86;

  // Dark carcass, standing off the wall on brackets.
  d.box(bx, (yTop + yBot) / 2, bz, w, sh, 0.5, site.rot, {
    color: DetailColor.metal, mr: MR.metal,
  });
  const [wx, wz] = local(site, u, front);
  for (const yy of [yBot + sh * 0.12, yTop - sh * 0.12]) {
    d.tube(wx, yy, wz, bx, yy, bz, 0.05, 3, { color: DetailColor.metal, mr: MR.metal });
  }

  // The lit face, one cell per letter.
  const tube = rng.weighted(
    [DetailColor.neon, DetailColor.sodium, lin(0xff3a2a), lin(0x46d0ff)],
    [3, 2.2, 2, 1],
  );
  const [fx1, fz1] = local(site, u, front - 0.58);
  const [fx2, fz2] = local(site, u, front - 0.63);
  for (let i = 0; i < cells; i++) {
    const cy = yBot + (i + 0.5) * cell;
    d.box(fx1, cy, fz1, w * 0.9, cell * 0.82, 0.06, site.rot,
      { color: tube, mr: [0, 0.35], emissive: emi(tube, 2.6) });
    // A dark bar through each cell so it reads as a letter, not a lamp.
    d.box(fx2, cy, fz2, w * 0.5, cell * 0.16, 0.05, site.rot,
      { color: lin(0x120e18), mr: [0, 0.6] });
  }
}

/**
 * A large painted hoarding flat against a blank party wall — the "MedLife"
 * board in the reference, which is close to twenty metres across and is the
 * brightest thing on that side of the street. Bucharest hangs these on every
 * exposed flank left over when its neighbour was demolished.
 */
function wallBillboard(
  d: DetailBuilder,
  site: BuildingSite,
  groundH: number,
  h: number,
  rng: Rng,
): void {
  const span = site.w;
  const front = -site.d / 2;
  const bw = span * rng.range(0.55, 0.86);
  const bh = Math.min(bw * rng.range(0.3, 0.5), (h - groundH) * 0.7);
  if (bh < 2.2) return;
  const y = groundH + rng.range(1.0, Math.max(1.2, (h - groundH) - bh - 0.8)) + bh / 2;
  const u = rng.range(-0.16, 0.16) * span;

  const ink = rng.weighted(
    [lin(0x1e3f96), lin(0xc41f2c), lin(0x0f7a4a), lin(0xe0a417), lin(0x2b2438)],
    [3, 2.4, 1.6, 1.6, 1],
  );
  const [bx, bz] = local(site, u, front - 0.14);
  d.box(bx, y, bz, bw, bh, 0.14, site.rot,
    { color: ink, mr: [0, 0.7], emissive: emi(ink, 0.22) });
  // A pale word block and a logo mark, which is all a board reads as at range.
  const [wx, wz] = local(site, u, front - 0.24);
  d.box(wx, y, wz, bw * 0.6, bh * 0.26, 0.05, site.rot,
    { color: lin(0xf4f0e6), mr: [0, 0.6], emissive: emi(lin(0xf4f0e6), 0.5) });
  const [lx, lz] = local(site, u - bw * 0.34, front - 0.24);
  d.box(lx, y + bh * 0.02, lz, bw * 0.14, bh * 0.42, 0.05, site.rot,
    { color: lin(0xf4f0e6), mr: [0, 0.6], emissive: emi(lin(0xf4f0e6), 0.5) });
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
  const span = site.w;
  const sw = Math.min(span * 0.42, rng.range(7, 12));
  const sh = sw * rng.range(1.25, 1.7);
  const y = groundH + rng.range(4, Math.max(6, (h - groundH) * 0.42));
  const [sx, sz] = local(site, rng.range(-0.28, 0.28) * span, -site.d / 2 - 0.22);
  mediaScreen(d, sx, y, sz, sw, sh, site.fx, site.fz, rng, site.rot);
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
  /** Rotation of the wall; defaults to the axis-aligned case. */
  rot?: number,
): void {
  const r = rot ?? Math.atan2(-nx, -nz);
  const sx = w;
  const sz = 0.22;
  const tint = rng.bool(0.5) ? DetailColor.screen : DetailColor.purple;

  // Housing sits behind; every emissive layer is stepped forward along the
  // wall normal, or the housing swallows the picture entirely.
  const at = (out: number): [number, number] => [x + nx * out, z + nz * out];

  const [hx, hz] = at(0);
  d.box(hx, y + h / 2, hz, sx + 0.6, h + 0.6, sz + 0.6, r, {
    color: DetailColor.metal, mr: MR.metal,
  });
  const [fx, fz] = at(0.36);
  d.box(fx, y + h / 2, fz, sx, h, sz, r, {
    color: tint, mr: [0, 0.3], emissive: emi(tint, 0.55),
  });
  const [cx, cz] = at(0.5);
  // Hair, head, shoulders, caption: a head-and-shoulders portrait at facade scale.
  d.box(cx, y + h * 0.74, cz, sx * 0.34, h * 0.10, sz * 0.34, r, {
    color: lin(0x2c2530), mr: [0, 0.5], emissive: emi(lin(0x413848), 0.6),
  });
  d.box(cx, y + h * 0.62, cz, sx * 0.30, h * 0.20, sz * 0.30, r, {
    color: lin(0xd9b79b), mr: [0, 0.4], emissive: emi(lin(0xd9b79b), 1.15),
  });
  d.box(cx, y + h * 0.36, cz, sx * 0.62, h * 0.28, sz * 0.62, r, {
    color: lin(0x241d33), mr: [0, 0.4], emissive: emi(lin(0x3d3157), 0.8),
  });
  d.box(cx, y + h * 0.10, cz, sx * 0.9, h * 0.07, sz * 0.9, r, {
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

/* ------------------------------------------------------------------ */
/* Street trees                                                        */
/* ------------------------------------------------------------------ */

/** Metalness/roughness for foliage. Leaves are waxy, not chalk. */
const LEAF_MR: [number, number] = [0.0, 0.66];
/**
 * Radians of normal scatter on a leaf cluster.
 *
 * Some scatter is essential: a lobe whose normals all agree is a smooth ball
 * that goes uniformly dark the moment the sun is behind it. But past about a
 * third of a radian adjacent facets shade to wildly different values and the
 * lobe stops reading as one soft mass — every facet becomes a separate flat
 * chip, and a crown of chips looks like folded paper, which is the failure
 * this was pushed to 0.62 chasing and then caused.
 */
const LEAF_NJITTER = 0.34;

/**
 * A leaf cluster's material. `trans` is the sub-surface term that makes a
 * backlit crown glow; the tiny emissive is a FLOOR so a crown in full shadow
 * holds a dim olive instead of going to zero. It is deliberately small — the
 * look comes from `trans`, not from self-illumination.
 */
function leafOpt(c: THREE.Color, trans: number, wind: number): DetailOpts {
  return {
    color: c,
    mr: LEAF_MR,
    emissive: [c.r * 0.06, c.g * 0.06, c.b * 0.06],
    trans,
    wind,
  };
}

/** The five autumn tones, weighted so gold and amber dominate. */
const LEAF_TONES = [
  DetailColor.leafGold, DetailColor.leaf, DetailColor.leafPale,
  DetailColor.leafRust, DetailColor.leafOlive,
];
const LEAF_WEIGHTS = [4, 3.4, 2.2, 1.8, 1.4];

/**
 * Autumn street tree — the CITY's mass foliage. There are several thousand of
 * these and they appear in essentially every street-level frame, so they cost
 * more realism than any other single object in the game.
 *
 * WHAT WAS WRONG, TWICE OVER.
 *   SILHOUETTE. The crown was a stack of 10-sided frusta: a bipyramid, which
 *   from the low camera this game uses projects as a hard-edged rhombus. Every
 *   street tree in Bucharest rendered as an angular slab floating on a stick.
 *   SHADING. The leaf material was opaque at roughness 0.95 with no
 *   sub-surface term. The sun sits three degrees above the horizon, so every
 *   crown is backlit; an opaque crown under that key is a black hole punched
 *   in a magenta sky. A real backlit autumn canopy is the brightest amber in
 *   the reference frame.
 *
 * WHAT FIXES IT.
 *   1. A REAL ARMATURE. Tapered trunk with a root flare, three orders of
 *      branch (limb, secondary, twig) whose bare tips fringe the outline.
 *   2. MANY SMALL MASSES, never one big one. Clusters are 0.4-0.9 m across in
 *      absolute metres — not a fraction of the crown, or a park tree grows
 *      two-metre cabbages — hung on branch ENDS. The outline is then ragged at
 *      every scale and the sky shows through it.
 *   3. TRANSLUCENCY (DetailOpts.trans) so backlit clusters glow amber, plus
 *      per-cluster colour so the crown is a mosaic of tones.
 *   4. WIND (DetailOpts.wind), largest at the tips, zero at the trunk.
 *   5. SPECIES AND THINNING. Broad plane, columnar poplar, small ornamental,
 *      and every one of them can be half bare — it is late autumn.
 *
 * Budget: ~330 triangles at lod 2, ~170 at lod 1, ~80 at lod 0.
 */
export function planeTree(
  d: DetailBuilder,
  x: number, z: number,
  rng: Rng,
  scale = 1,
  /** 2 = near the hero area, 1 = mid city, 0 = far field. */
  lod: 0 | 1 | 2 = 2,
): void {
  /*
   * SCALE, cross-checked against the two things always in frame beside a tree:
   * a 1.8 m person reaches about a third of the way up the clear trunk, and
   * the 7.2-9.4 m lamp heads sit level with the top of an average crown.
   */
  const species = rng.weighted([0, 1, 2], [5, 2, 2]) as 0 | 1 | 2;
  let h: number;
  let trunkH: number;
  let crownR: number;
  let trunkR: number;
  if (species === 1) {
    // Columnar poplar — tall, narrow, and the thing that breaks up a whole
    // avenue of identical round crowns.
    h = rng.range(11.0, 15.0) * scale;
    trunkH = rng.range(2.0, 2.8) * scale;
    crownR = rng.range(1.15, 1.7) * scale;
    trunkR = 0.145 * scale;
  } else if (species === 2) {
    // Young / ornamental — a third of a street's trees are recent plantings.
    h = rng.range(4.6, 6.6) * scale;
    trunkH = rng.range(1.8, 2.4) * scale;
    crownR = rng.range(1.3, 1.9) * scale;
    trunkR = 0.085 * scale;
  } else {
    // Mature plane / linden: 8-11 m over a 2.4-3.4 m clear trunk, crown 5-6 m
    // ACROSS. Not 6 m in radius — that is what made them read as awnings.
    h = rng.range(8.0, 11.0) * scale;
    trunkH = rng.range(2.4, 3.4) * scale;
    // Crown 4-5.4 m ACROSS. Wider than this and the lobe budget cannot close
    // it, so the crown reads as a lace of separate balls instead of a mass.
    crownR = rng.range(2.0, 2.7) * scale;
    trunkR = 0.165 * scale;
  }

  // Bark: a pure-albedo trunk backlit at three degrees goes to black, so it
  // carries a small emissive floor and keeps a dark umber.
  const bark: DetailOpts = {
    color: rng.bool(0.35) ? DetailColor.barkPale : DetailColor.bark,
    mr: [0, 0.9],
    emissive: [DetailColor.bark.r * 0.06, DetailColor.bark.g * 0.06, DetailColor.bark.b * 0.06],
  };
  const limbOpt: DetailOpts = { ...bark, wind: 0.006 * scale };
  const secOpt: DetailOpts = { ...bark, wind: 0.018 * scale };
  const twigOpt: DetailOpts = { ...bark, wind: 0.036 * scale };

  const y0 = 0.17;
  // Root flare, then a tapering trunk. Both are read constantly at ped height.
  d.cyl(x, y0 - 0.04, z, trunkR * 2.0, trunkR * 1.4, 0.3, 6, bark, false);
  d.cyl(x, y0 + 0.24, z, trunkR * 1.4, trunkR * 0.82, trunkH - 0.24, 6, bark, false);

  const crownY = y0 + trunkH;
  const crownH = h - trunkH;

  /*
   * BRANCHING. The armature is what you see THROUGH the canopy and where it
   * has thinned, and it is what stops a crown floating off its trunk. It is
   * deliberately kept cheap — its job is structure, not mass.
   */
  const nLimb = lod === 2 ? 4 + rng.int(0, 2) : lod === 1 ? 3 + rng.int(0, 2) : 3;
  const lean = rng.range(0, Math.PI * 2);
  // A poplar's limbs rise steeply and reach barely at all; a plane's spread.
  const reachK = species === 1 ? 0.30 : 0.58;
  const riseK = species === 1 ? 0.66 : 0.40;

  for (let i = 0; i < nLimb; i++) {
    const a = lean + (i / nLimb) * Math.PI * 2 + rng.range(-0.34, 0.34);
    const reach = crownR * reachK * rng.range(0.72, 1.12);
    const rise = crownH * riseK * rng.range(0.7, 1.25);
    const lx = x + Math.cos(a) * reach;
    const lz = z + Math.sin(a) * reach;
    const ly = crownY + rise;
    d.tube(x, crownY - 0.3, z, lx, ly, lz, trunkR * 0.52, 4, limbOpt);
    if (lod === 0) continue;

    const nSec = lod === 2 ? 2 : 1;
    for (let j = 0; j < nSec; j++) {
      const a2 = a + rng.range(-0.9, 0.9);
      const sx = lx + Math.cos(a2) * crownR * rng.range(0.26, 0.52) * (species === 1 ? 0.5 : 1);
      const sz = lz + Math.sin(a2) * crownR * rng.range(0.26, 0.52) * (species === 1 ? 0.5 : 1);
      const sy = ly + crownH * rng.range(0.14, 0.34);
      d.tube(lx, ly, lz, sx, sy, sz, trunkR * 0.27, 3, secOpt);
      // Bare twigs beyond the last leaf: the fringe that keeps the crown from
      // closing into a hard edge where it meets the sky.
      if (lod === 2 && rng.bool(0.7)) {
        const a3 = a2 + rng.range(-1.2, 1.2);
        d.tube(sx, sy, sz,
          sx + Math.cos(a3) * crownR * rng.range(0.14, 0.28) * (species === 1 ? 0.5 : 1),
          sy + crownH * rng.range(0.06, 0.18),
          sz + Math.sin(a3) * crownR * rng.range(0.14, 0.28) * (species === 1 ? 0.5 : 1),
          trunkR * 0.13, 3, twigOpt);
      }
    }
  }
  // The leader, so the crown has a top and not a hole.
  d.tube(x, crownY - 0.3, z,
    x + rng.range(-0.3, 0.3) * scale, crownY + crownH * rng.range(0.6, 0.82), z + rng.range(-0.3, 0.3) * scale,
    trunkR * 0.44, 4, limbOpt);

  /*
   * THE CANOPY — a SHELL OF OVERLAPPING LOBES, not beads on branch tips.
   *
   * Hanging one small cluster per branch tip is the obvious construction and
   * it is wrong: the offsets between tips are larger than the clusters, so
   * the crown never closes and every tree reads as popcorn threaded on wire.
   * A crown is a MASS. Lobes are placed on a squashed ellipsoid shell at
   * 0.42 x the crown radius each, spaced closer than their own diameter, so
   * they merge into one body whose outline is a chain of arcs — ragged at
   * every scale, and never the smooth ellipse a single hull would give.
   *
   * Late autumn then punches holes in it: `thin` drops whole lobes, which is
   * how a real canopy thins (it does not shrink uniformly), and one tree in
   * nine is a bare skeleton. That is what guarantees sky through the crown.
   */
  const thin = rng.range(0.10, 0.44);
  const bare = rng.bool(0.10);
  const amberBias = rng.range(0.62, 0.98);
  const rings: 1 | 2 = lod === 0 ? 1 : 2;
  // Lobes are a fixed physical size, so a bigger crown needs MORE of them to
  // close, not bigger ones. Roughly area-proportional.
  const lobeK = 0.55 + 0.45 * Math.pow(scale, 2.4);
  const nLobe = bare
    ? rng.int(2, 5)
    : Math.round((lod === 2 ? 24 + rng.int(0, 7) : lod === 1 ? 10 : 5) * lobeK);
  // A >1 m six-sided lobe reads as a hexagon; eight segments costs 8 more
  // triangles and buys a lobe that never shows a straight edge close up.
  const lobeSeg = lod === 2 ? 8 : 6;
  // Vertical squash: a plane's crown is wider than it is tall, a poplar's is
  // a tall narrow spindle.
  const crownHalfH = species === 1 ? crownH * 0.46 : crownH * 0.40;
  const crownMidY = crownY + crownH * (species === 1 ? 0.5 : 0.44);
  /*
   * LOBE SIZE IS CAPPED IN ABSOLUTE METRES. A six-sided blob shows its facets
   * the moment it is more than about a metre across at street distance, and a
   * lobe proportional to the crown grew 3 m hexagonal cabbages on the park
   * trees (scale 1.3). A leaf cluster is roughly the same physical size on
   * every tree; it is the NUMBER of them that changes.
   */
  // Capped at 0.78 m radius. A 1.9 m lobe is bigger than a real leaf cluster
  // and, three metres from a third-person camera, reads as folded card; 1.5 m
  // is about the largest that still passes as foliage at arm's length.
  const lobeR = Math.min(crownR * (species === 1 ? 0.62 : 0.38), 0.78);
  // Golden-angle spiral: the cheapest way to get points that are evenly
  // spread over a sphere without clumping or banding.
  const GOLD = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < nLobe; i++) {
    if (rng.next() < thin) continue;
    const t = (i + 0.5) / nLobe;
    const cy = 1 - 2 * t;                       // -1 .. 1 up the shell
    const sr = Math.sqrt(Math.max(0, 1 - cy * cy));
    const ang = i * GOLD + rng.range(-0.4, 0.4);
    // Sit lobes between 0.52 and 1.0 of the shell radius so the crown has an
    // interior as well as a surface, and jitter every one of them.
    const shell = rng.range(0.52, 1.0);
    const lx = x + Math.cos(ang) * sr * crownR * shell * rng.range(0.85, 1.1);
    const lz = z + Math.sin(ang) * sr * crownR * shell * rng.range(0.85, 1.1);
    const ly = crownMidY + cy * crownHalfH * shell * rng.range(0.85, 1.1);

    const tone = rng.next() < amberBias
      ? rng.weighted(LEAF_TONES, LEAF_WEIGHTS)
      : DetailColor.leafOlive;
    // Lobes deep inside the crown are shaded by the ones outside them; the
    // shader cannot know that, so it is authored. Without it a crown is one
    // flat value and reads as a cut-out however good its outline is.
    const depth = 0.62 + 0.38 * shell;
    const c = tone.clone().multiplyScalar(depth);
    // Wind grows up the crown; the fork barely moves, the top tips do.
    const wind = (0.045 + 0.10 * Math.max(0, (ly - crownY) / Math.max(crownH, 0.5))) * shell;
    const r = lobeR * rng.range(0.78, 1.22);
    d.blob(
      lx, ly, lz,
      r, r * rng.range(0.66, 0.92), r * rng.range(0.84, 1.16),
      leafOpt(c, rng.range(0.7, 1.0) * (0.55 + 0.45 * shell), wind),
      // Position jitter roughens the outline. Past ~0.6 it starts collapsing
      // vertices toward the centre, which produces thin degenerate wedges —
      // the origami-chip look — rather than a lumpier mass.
      0.55, 1 + ((i * 7919 + Math.round(x * 13 + z * 7) * 104729) >>> 0), rings, LEAF_NJITTER,
      lobeSeg,
    );
  }

  /*
   * THE FRINGE. The main lobes give the crown its mass; on their own the
   * outline is a chain of metre-wide arcs, which from three metres away — the
   * distance a third-person camera actually spends its life at — reads as
   * folded paper. A ring of half-size lobes pushed just outside the shell
   * breaks that outline at a finer scale for 12 triangles each, which is the
   * cheapest silhouette detail available anywhere in this tree.
   */
  if (lod === 2 && !bare) {
    const nFringe = 5 + rng.int(0, 4);
    for (let i = 0; i < nFringe; i++) {
      const a = rng.range(0, Math.PI * 2);
      const cy = rng.range(-0.75, 0.9);
      const sr = Math.sqrt(Math.max(0, 1 - cy * cy));
      const fr = lobeR * rng.range(0.36, 0.56);
      const fx = x + Math.cos(a) * sr * crownR * rng.range(0.95, 1.18);
      const fz = z + Math.sin(a) * sr * crownR * rng.range(0.95, 1.18);
      const fy = crownMidY + cy * crownHalfH * rng.range(0.95, 1.15);
      const tone = rng.weighted(LEAF_TONES, LEAF_WEIGHTS);
      d.blob(
        fx, fy, fz, fr, fr * rng.range(0.7, 1.0), fr,
        leafOpt(tone, rng.range(0.85, 1.0), 0.14 + 0.05 * rng.next()),
        0.62, 1 + ((i * 22691 + Math.round(x * 31 + z * 17) * 6353) >>> 0), 1, LEAF_NJITTER,
      );
    }
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
