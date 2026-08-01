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
import {
  Cell,
  pointInRing,
  polygonCentroid,
  type OsmCity,
  type OsmFootprint,
} from './osm';

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
  /** Rotation about Y. Real Bucharest plots sit at every angle. */
  rot?: number;
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
  // `w` is always the frontage and `d` always the depth — see BuildingSite.
  // The grid used to swap them for east/west-facing plots and leave rot at 0,
  // which is what put every detail pass on the wrong axis.
  const site: BuildingSite = {
    cx, cz,
    w: Math.abs(fx) > 0.5 ? d : w,
    d: Math.abs(fx) > 0.5 ? w : d,
    rot: Math.atan2(-fx, -fz),
    fx, fz, heroDist,
  };

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
  const forceStyle = pickStyle(opt.district, opt.rng);

  const built = buildBuilding(
    site, spec, opt.rng,
    opt.facade(cx, cz), opt.detail(cx, cz),
    { forceStyle },
  );
  opt.out.push({
    x: built.cx, z: built.cz, hx: built.hx, hz: built.hz, height: built.height, rot: site.rot,
  });
}

function pickStyle(district: DistrictKind, rng: Rng): number | undefined {
  let forceStyle: number | undefined;
  if (district === 'glassCorporate') {
    // The reference frame is precisely a dark glass tower standing against
    // warm travertine — a quarter that is 100% curtain wall has no such
    // contrast anywhere in it.
    const r = rng.next();
    if (r < 0.22) forceStyle = FacadeStyle.guvern;          // travertine slab
    else if (r < 0.40) forceStyle = FacadeStyle.interbelic; // older infill
  } else if (district === 'bulevard') {
    // Magheru's actual composition: interbelic dominates, communist infill is
    // common, and the other eras appear as interruptions.
    forceStyle = rng.weighted(
      [
        FacadeStyle.interbelic,
        FacadeStyle.bulevard,
        FacadeStyle.centruVechi,
        FacadeStyle.guvern,
        FacadeStyle.glassCorporate,
      ],
      [10, 5.5, 1.6, 1.0, 0.7],
    );
  } else if (district === 'centruVechi' && rng.bool(0.16)) {
    forceStyle = FacadeStyle.interbelic;   // an interwar infill on a lost plot
  } else if (district === 'cartier' && rng.bool(0.10)) {
    forceStyle = FacadeStyle.interbelic;   // the pre-war fringe the blocs ate
  }
  return forceStyle;
}

/* ------------------------------------------------------------------ */
/* THE REAL STREET WALL                                                */
/* ------------------------------------------------------------------ */

export interface OsmBuildOptions {
  city: OsmCity;
  rng: Rng;
  facade(x: number, z: number): FacadeBuilder;
  detail(x: number, z: number): DetailBuilder;
  districtAt(x: number, z: number): DistrictKind;
  out: PlacedBuilding[];
}

/**
 * Build the CURATED REAL FOOTPRINTS.
 *
 * Each one arrives as a world-space outline with a storey count off the
 * survey. The outline drives the massing and the parapet, the storey count
 * drives the height, and everything else — the grammar, the era mixing, the
 * balconies, the signage, the rooftop mess — is still the game's own.
 */
export function buildOsmFootprints(opt: OsmBuildOptions): void {
  for (const fp of opt.city.footprints) {
    const district = opt.districtAt(fp.cx, fp.cz);
    const spec = DISTRICTS[district];
    const heroDist = Math.hypot(fp.cx - HERO_X, fp.cz - HERO_Z);

    // The OBB's long side is the frontage; the facing vector says which of its
    // two normals looks at the street, so rot must line +x up with that face.
    const facingIsLocalZ = Math.abs(fp.fx * Math.sin(fp.rot) + fp.fz * Math.cos(fp.rot)) > 0.5;
    const site: BuildingSite = {
      cx: fp.cx, cz: fp.cz,
      w: facingIsLocalZ ? fp.w : fp.d,
      d: facingIsLocalZ ? fp.d : fp.w,
      rot: Math.atan2(-fp.fx, -fp.fz),
      fx: fp.fx, fz: fp.fz,
      heroDist,
    };

    const built = buildBuilding(
      site, spec, opt.rng,
      opt.facade(fp.cx, fp.cz), opt.detail(fp.cx, fp.cz),
      {
        forceStyle: styleForOsmBuilding(fp.kind, fp.name, fp.levels, district, opt.rng),
        footprint: fp.ring,
        levels: fp.levels,
        osmKind: fp.kind,
        osmName: fp.name,
      },
    );
    const collider = fitOsmFootprintCollider(opt.city, fp, {
      x: built.cx, z: built.cz,
      hx: built.hx, hz: built.hz,
      height: built.height, rot: site.rot,
    });
    if (collider) opt.out.push(collider);
  }
}

/**
 * What the survey knows about a building that the district plan does not.
 * A church is not a bulevard block whatever street it stands on.
 */
export function styleForOsmBuilding(
  kind: string, name: string | null, levels: number, district: DistrictKind, rng: Rng,
): number | undefined {
  const identity = `${name ?? ''} ${kind}`
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Identity beats a generic OSM `building=yes` tag. These named institutions
  // and interwar hotels are among the silhouettes by which central Bucharest
  // is recognised; turning them into curtain wall because they happen to be
  // tall erased more city character than adding another thousand footprints.
  if (/biseric|catedral|capel|manastir|stavropoleos/.test(identity)) {
    return FacadeStyle.centruVechi;
  }
  if (/atene|palat|primari|muze|teatr|opera|universitat|bibliotec|minister|banca national/.test(identity)) {
    return FacadeStyle.guvern;
  }
  if (/ambasador|aro|patria|continental|capitol|lido|bristol|cismigiu|concordia|carpati|muntenia|venezia/.test(identity)) {
    return FacadeStyle.interbelic;
  }

  switch (kind) {
    case 'church': case 'cathedral': case 'chapel':
      return FacadeStyle.centruVechi;
    case 'industrial': case 'warehouse': case 'garages': case 'garage':
      return FacadeStyle.industrial;
    case 'office': case 'commercial': case 'retail': case 'hotel': {
      const modernIdentity = /afi|globalworth|green gate|business (park|center)|tower|plaza|sky ?tower/.test(identity);
      if (district === 'glassCorporate' && (levels >= 9 || modernIdentity)) {
        return FacadeStyle.glassCorporate;
      }
      return rng.bool(0.34) ? FacadeStyle.guvern : FacadeStyle.interbelic;
    }
    case 'public': case 'civic': case 'government': case 'university': case 'hospital':
      return FacadeStyle.guvern;
    case 'apartments': case 'dormitory':
      if (district === 'cartier') return FacadeStyle.cartier;
      if (district === 'centruVechi') return FacadeStyle.centruVechi;
      return rng.bool(0.72) ? FacadeStyle.interbelic : FacadeStyle.bulevard;
    default:
      return pickStyle(district, rng);
  }
}

/* ------------------------------------------------------------------ */
/* Conservative collision for real, often concave footprints          */
/* ------------------------------------------------------------------ */

/**
 * Fit a collision rectangle wholly INSIDE the visible OSM footprint.
 *
 * The façade follows the surveyed polygon, but gameplay collision is an OBB.
 * Using the polygon's full minimum-area bounding box for a concave or skewed
 * block puts solid corners where no wall was drawn. On Magheru and around
 * Piața Unirii some of those invented corners reached the carriageway, which
 * is exactly the reported "invisible object in the road". A smaller collider
 * is preferable to collision outside the thing the player can see.
 */
export function fitOsmFootprintCollider(
  city: OsmCity,
  fp: Pick<OsmFootprint, 'ring'>,
  wanted: PlacedBuilding,
): PlacedBuilding | null {
  const rot = wanted.rot ?? 0;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const localOf = (x: number, z: number): [number, number] => {
    const dx = x - wanted.x;
    const dz = z - wanted.z;
    return [dx * cs - dz * sn, dx * sn + dz * cs];
  };
  const worldOf = (u: number, v: number): [number, number] => [
    wanted.x + u * cs + v * sn,
    wanted.z - u * sn + v * cs,
  ];

  let u0 = Infinity; let u1 = -Infinity;
  let v0 = Infinity; let v1 = -Infinity;
  for (const p of fp.ring) {
    const [u, v] = localOf(p.x, p.z);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u);
    v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }

  const candidates: Array<[number, number]> = [[0, 0]];
  const centre = polygonCentroid(fp.ring);
  candidates.push(localOf(centre.x, centre.z));
  const nu = Math.max(2, Math.min(12, Math.ceil((u1 - u0) / 4)));
  const nv = Math.max(2, Math.min(12, Math.ceil((v1 - v0) / 4)));
  for (let iu = 1; iu < nu; iu++) {
    for (let iv = 1; iv < nv; iv++) {
      candidates.push([
        u0 + (iu / nu) * (u1 - u0),
        v0 + (iv / nv) * (v1 - v0),
      ]);
    }
  }
  candidates.sort((a, b) => a[0] ** 2 + a[1] ** 2 - (b[0] ** 2 + b[1] ** 2));

  const blocked = Cell.road | Cell.reserved | Cell.square;
  const fits = (cu: number, cv: number, hx: number, hz: number): boolean => {
    const [cx, cz] = worldOf(cu, cv);
    if (city.mask.rectHits(cx, cz, hx * 2, hz * 2, rot, blocked)) return false;
    // One-metre pitch is finer than the two-metre occupancy mask and catches
    // a re-entrant notch between otherwise valid corners.
    const nx = Math.max(1, Math.ceil((hx * 2) / 1));
    const nz = Math.max(1, Math.ceil((hz * 2) / 1));
    for (let ix = 0; ix <= nx; ix++) {
      const u = cu + (ix / nx * 2 - 1) * hx;
      for (let iz = 0; iz <= nz; iz++) {
        const v = cv + (iz / nz * 2 - 1) * hz;
        const [x, z] = worldOf(u, v);
        if (!pointInRing(fp.ring, x, z)) return false;
      }
    }
    return true;
  };

  let best: PlacedBuilding | null = null;
  let bestArea = 0;
  for (const [cu, cv] of candidates) {
    const roomX = Math.min(cu - u0, u1 - cu, wanted.hx) - 0.16;
    const roomZ = Math.min(cv - v0, v1 - cv, wanted.hz) - 0.16;
    if (roomX < 0.42 || roomZ < 0.42) continue;
    for (const scale of [0.96, 0.84, 0.72, 0.60, 0.48, 0.36, 0.26]) {
      const hx = roomX * scale;
      const hz = roomZ * scale;
      const area = hx * hz * 4;
      if (area <= bestArea || !fits(cu, cv, hx, hz)) continue;
      const [x, z] = worldOf(cu, cv);
      best = { x, z, hx, hz, height: wanted.height, rot };
      bestArea = area;
      // Smaller scales at this centre cannot improve the result.
      break;
    }
  }
  return best;
}

/**
 * INFILL ALONG THE REAL FRONTAGES.
 *
 * The curation kept 1,100 of Bucharest's 6,855 central footprints — landmarks,
 * monumental blocks and square frontages in full, the rest sampled. Sampled is
 * exactly right for a game, but built literally it leaves a city of detached
 * buildings with holes between them, and Bucharest's centre is a CONTINUOUS
 * STREET WALL. So every real street is walked and the gaps in its frontage are
 * filled with generated plots that take their storey count from the real
 * buildings nearest them — the layout is surveyed, the density is grammar.
 */
export function buildOsmInfill(opt: OsmBuildOptions): void {
  const { city, rng } = opt;
  const blocking = Cell.road | Cell.built | Cell.green | Cell.reserved | Cell.square;

  for (const e of city.edges) {
    const a = city.nodes[e.a];
    const b = city.nodes[e.b];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 18) continue;
    // Density taper. Every metre of imported street wants a street wall, but
    // 128 km of it at full density is ten thousand buildings and four times
    // the triangle budget. Near the hero crossroads nothing is skipped; out at
    // the edge of the map only the through-routes keep a continuous frontage.
    const eHero = Math.hypot((a.x + b.x) / 2 - HERO_X, (a.z + b.z) / 2 - HERO_Z);
    if (e.rank === 0 && eHero > 700 && rng.bool(Math.min(0.55, (eHero - 700) / 900))) continue;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    // local +x along the street, local +z toward the left-hand kerb.
    const rotLeft = Math.atan2(-uz, ux);

    for (const side of [-1, 1]) {
      const district = opt.districtAt(
        (a.x + b.x) / 2 + px * side * 20, (a.z + b.z) / 2 + pz * side * 20,
      );
      const spec = DISTRICTS[district];
      if (district === 'parc') continue;
      // Building line: back of the pavement plus a small setback.
      const line = e.width / 2 + e.walk + 0.6;
      let t = rng.range(0, 8);
      let guard = 0;
      while (t < len - 8 && guard++ < 40) {
        const front = Math.min(
          rng.range(spec.frontage[0], spec.frontage[1]) * 0.78,
          len - t,
        );
        if (front < 9) break;
        // Half the district's usual gap rate. A perimeter street wall is meant
        // to be continuous; the gaps in the imported half of the city come from
        // the plots the survey already occupies, not from the grammar.
        if (rng.bool(spec.gap * 0.5)) { t += front; continue; }
        // On the left-hand side local +z already points away from the street;
        // on the right it has to be turned round.
        const siteRot = side > 0 ? rotLeft : rotLeft + Math.PI;
        const mid = t + front / 2;

        /*
         * SHRINK TO FIT, don't give up.
         *
         * The compressed map puts parallel streets 25 m apart where the real
         * ones are 40, so a full-depth plot routinely overlaps the carriageway
         * behind it. Rejecting the plot outright — which is what the first
         * version did — left 91% of the frontage empty and the imported half of
         * the city full of holes. Trying progressively shallower and narrower
         * plots fills the same frontage with the buildings that DO fit, which
         * is also how a real block behind a main road actually works.
         */
        const wantDepth = rng.range(spec.depth[0], spec.depth[1]) * 0.8;
        let placed = false;
        for (const [ds, fs] of [[1, 1], [0.66, 1], [0.42, 1], [0.42, 0.6]] as Array<[number, number]>) {
          const depth = wantDepth * ds;
          const wide = front * fs;
          if (depth < 5.5 || wide < 8) break;
          const cx = a.x + ux * mid + px * side * (line + depth / 2);
          const cz = a.z + uz * mid + pz * side * (line + depth / 2);
          if (city.mask.rectHits(cx, cz, wide, depth, siteRot, blocking)) continue;

          const levels = city.levelsNear(cx, cz);
          const heroDist = Math.hypot(cx - HERO_X, cz - HERO_Z);
          const site: BuildingSite = {
            cx, cz, w: wide, d: depth, rot: siteRot,
            fx: -Math.sin(siteRot), fz: -Math.cos(siteRot),
            heroDist,
          };
          const built = buildBuilding(
            site, spec, rng, opt.facade(cx, cz), opt.detail(cx, cz),
            {
              forceStyle: pickStyle(district, rng),
              levels: levels > 0 ? Math.round(levels) : undefined,
            },
          );
          city.mask.stampRect(cx, cz, wide, depth, siteRot, Cell.built);
          opt.out.push({
            x: built.cx, z: built.cz, hx: built.hx, hz: built.hz,
            height: built.height, rot: siteRot,
          });
          placed = true;
          break;
        }
        void placed;
        t += front + rng.range(0, 2.0);
      }
    }
  }
}
