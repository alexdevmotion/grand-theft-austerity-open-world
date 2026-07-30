/**
 * Street construction: carriageways with camber and lane markings, raised
 * kerbs, paved footways, junction geometry, zebra crossings and stop bars,
 * tram permanent way, catenary masts and wires, gutter drains.
 *
 * Everything is written into the caller's per-chunk builders so the whole
 * network merges down to a handful of draw calls.
 */

import * as THREE from 'three';
import { WorldScale } from '../../artDirection';
import { PAL, srgb } from '../../render/materials';
import type { Rng } from '../../core/rng';
import type { DistrictKind } from '../../core/services';
import { DetailBuilder, FacadeBuilder, SurfaceBuilder, Surf } from './builders';
import {
  AXIS_X,
  AXIS_Z,
  HALF,
  LANES,
  ROAD_WIDTH,
  WALK_WIDTH,
  columnRank,
  hasTram,
  rowRank,
  type StreetRank,
} from './districts';
import {
  DetailColor,
  bollard,
  crowdBarrier,
  emi,
  planeTree,
  parkedCar,
  streetLamp,
  wasteBin,
} from './facades';
import {
  Cell,
  classSpec,
  pointInRing,
  type OsmCity,
  type OsmEdge,
} from './osm';

const { blockSize, gridBlocks } = WorldScale;

export const KERB_H = 0.17;
/** Crown height at the centreline of a carriageway. */
const CAMBER = 0.09;
const TRAM_GAUGE = 1.435;

export interface ChunkSink {
  surf(x: number, z: number): SurfaceBuilder;
  detail(x: number, z: number): DetailBuilder;
  facade(x: number, z: number): FacadeBuilder;
}

export interface BlockBounds {
  /** Outer edge of the pavement (kerb line). */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Building line — pavement inner edge. */
  bx0: number;
  bz0: number;
  bx1: number;
  bz1: number;
}

/** Directed lane centreline, published for the traffic agent. */
export interface LaneSegment {
  fromNode: number;
  toNode: number;
  /** Lane index, 0 = nearest the centreline. */
  lane: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  width: number;
}

export function nodeX(i: number): number {
  return -HALF + i * blockSize;
}
export function nodeZ(j: number): number {
  return -HALF + j * blockSize;
}

/** Block bounds accounting for the rank of each of the four bounding streets. */
export function blockBounds(i: number, j: number): BlockBounds {
  const rW = columnRank(i);
  const rE = columnRank(i + 1);
  const rN = rowRank(j);
  const rS = rowRank(j + 1);
  const x0 = nodeX(i) + ROAD_WIDTH[rW] / 2;
  const x1 = nodeX(i + 1) - ROAD_WIDTH[rE] / 2;
  const z0 = nodeZ(j) + ROAD_WIDTH[rN] / 2;
  const z1 = nodeZ(j + 1) - ROAD_WIDTH[rS] / 2;
  return {
    x0, z0, x1, z1,
    bx0: x0 + WALK_WIDTH[rW],
    bx1: x1 - WALK_WIDTH[rE],
    bz0: z0 + WALK_WIDTH[rN],
    bz1: z1 - WALK_WIDTH[rS],
  };
}

const STEEL = srgb(0x2a2830);
const RAIL = srgb(0x8b8580);
const MAST = srgb(0x39424a);
const WIRE = srgb(0x1a1a20);
const DRAIN = srgb(0x151318);
const SODIUM = PAL.sodiumLamp;

export interface RoadBuildOptions {
  sink: ChunkSink;
  rng: Rng;
  /** True when this world point is inside a landmark footprint (no road). */
  isVoid(x: number, z: number): boolean;
  districtAt(x: number, z: number): DistrictKind;
  /** Static collider registration for kerbs. */
  addKerbCollider(cx: number, cz: number, hx: number, hz: number, top: number): void;
  lanes: LaneSegment[];
  nodeId(i: number, j: number): number;
  /** Called for every road segment that survives so the graph can be pruned. */
  onSegment(ai: number, aj: number, bi: number, bj: number, alive: boolean): void;
  /** True where the imported real street layout takes over from the grid. */
  covered?(x: number, z: number): boolean;
}

export function buildRoads(opt: RoadBuildOptions): void {
  const { sink, rng } = opt;
  const n = gridBlocks + 1;

  /*
   * WHERE THE REAL CITY IS, THE GRID STANDS ASIDE.
   *
   * `covered` is true inside the imported OSM extent. Two things still come
   * from the grid in there and only two: the N–S and E–W monumental axes. Casa
   * Constructorilor's forecourt, the Dacia's kerbside slot, the barricade and
   * the Parliament axis are all authored against those two centrelines, and the
   * survey has no boulevard on either of them (real Bucharest's Magheru and
   * Regina Elisabeta run close, which is exactly why the fit was chosen — but
   * "close" is not "at (-92, 0)"). Everything else the grid would have drawn is
   * replaced by the real street layout.
   */
  const covered = opt.covered ?? ((): boolean => false);
  const onAxis = (i: number | null, j: number | null): boolean =>
    (i !== null && columnRank(i) === 2) || (j !== null && rowRank(j) === 2);

  /* ---------------- junction patches ---------------- */
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = nodeX(i);
      const z = nodeZ(j);
      if (opt.isVoid(x, z)) continue;
      if (covered(x, z) && !onAxis(i, j)) continue;
      const wI = ROAD_WIDTH[columnRank(i)];
      const wJ = ROAD_WIDTH[rowRank(j)];
      const s = sink.surf(x, z);
      s.rect(x - wI / 2, z - wJ / 2, x + wI / 2, z + wJ / 2, 0, {
        kind: Surf.asphalt, a: wI / 2, b: 0, seed: (i * 31 + j) % 97,
      });
    }
  }

  /* ---------------- carriageways ---------------- */
  const seg = (
    ai: number, aj: number, bi: number, bj: number,
  ): void => {
    const ax = nodeX(ai);
    const az = nodeZ(aj);
    const bx = nodeX(bi);
    const bz = nodeZ(bj);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    if (opt.isVoid(mx, mz) || opt.isVoid(ax, az) || opt.isVoid(bx, bz)) {
      opt.onSegment(ai, aj, bi, bj, false);
      return;
    }
    const isVertical = ai === bi;
    if (covered(mx, mz) && !onAxis(isVertical ? ai : null, isVertical ? null : aj)) {
      // The real network carries the traffic here; the grid link would be a
      // phantom road through the middle of a Bucharest block.
      opt.onSegment(ai, aj, bi, bj, false);
      return;
    }
    opt.onSegment(ai, aj, bi, bj, true);

    const vertical = ai === bi;
    const rank: StreetRank = vertical ? columnRank(ai) : rowRank(aj);
    const width = ROAD_WIDTH[rank];
    const lanes = LANES[rank];

    // Trim back to the edge of each junction patch.
    let sx = ax;
    let sz = az;
    let ex = bx;
    let ez = bz;
    if (vertical) {
      sz += ROAD_WIDTH[rowRank(aj)] / 2;
      ez -= ROAD_WIDTH[rowRank(bj)] / 2;
    } else {
      sx += ROAD_WIDTH[columnRank(ai)] / 2;
      ex -= ROAD_WIDTH[columnRank(bi)] / 2;
    }

    const s = sink.surf(mx, mz);
    s.ribbon(sx, sz, ex, ez, width, 0, CAMBER, {
      kind: Surf.asphalt, a: width / 2, b: lanes, seed: (ai * 7 + aj * 13) % 89,
    }, rank === 0 ? 4 : 8);

    // Publish lane centrelines for traffic.
    const dx = ex - sx;
    const dz = ez - sz;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const laneW = 3.6;
    const from = opt.nodeId(ai, aj);
    const to = opt.nodeId(bi, bj);
    for (let l = 0; l < lanes; l++) {
      const off = (l + 0.5) * laneW;
      opt.lanes.push({
        fromNode: from, toNode: to, lane: l,
        ax: ax - px * off, az: az - pz * off,
        bx: bx - px * off, bz: bz - pz * off,
        width: laneW,
      });
      opt.lanes.push({
        fromNode: to, toNode: from, lane: l,
        ax: bx + px * off, az: bz + pz * off,
        bx: ax + px * off, bz: az + pz * off,
        width: laneW,
      });
    }

    /* ---- tram permanent way ---- */
    const tram = hasTram(vertical ? ai : null, vertical ? null : aj);
    if (tram) {
      const d = sink.detail(mx, mz);
      const bed = sink.surf(mx, mz);
      // Reserved central bed.
      bed.ribbon(sx, sz, ex, ez, TRAM_GAUGE * 2 + 1.6, 0.005, 0, {
        kind: Surf.tramBed, a: 0, b: 0, seed: 3,
      }, 2);
      for (const side of [-1, 1]) {
        for (const rgo of [-TRAM_GAUGE / 2, TRAM_GAUGE / 2]) {
          const off = side * (TRAM_GAUGE / 2 + 1.2) + rgo;
          const rx0 = sx + px * off;
          const rz0 = sz + pz * off;
          const rx1 = ex + px * off;
          const rz1 = ez + pz * off;
          d.box(
            (rx0 + rx1) / 2, 0.055, (rz0 + rz1) / 2,
            vertical ? 0.09 : Math.abs(rx1 - rx0),
            0.11,
            vertical ? Math.abs(rz1 - rz0) : 0.09,
            0,
            { color: RAIL, mr: [0.9, 0.16] },
          );
        }
      }
      // Catenary masts + wires along the kerb line.
      const spacing = 34;
      const count = Math.max(1, Math.floor(len / spacing));
      for (let k = 0; k <= count; k++) {
        const t = k / count;
        const cx = sx + dx * t;
        const cz = sz + dz * t;
        for (const side of [-1, 1]) {
          const mxp = cx + px * side * (width / 2 + 1.6);
          const mzp = cz + pz * side * (width / 2 + 1.6);
          buildCatenaryMast(sink.detail(mxp, mzp), mxp, mzp, -px * side, -pz * side, width / 2 + 1.6);
        }
      }
      // Contact wires strung the length of the segment.
      for (const off of [-TRAM_GAUGE / 2 - 1.2, TRAM_GAUGE / 2 + 1.2]) {
        const wx0 = sx + px * off;
        const wz0 = sz + pz * off;
        const wx1 = ex + px * off;
        const wz1 = ez + pz * off;
        sink.detail(mx, mz).box(
          (wx0 + wx1) / 2, 6.05, (wz0 + wz1) / 2,
          vertical ? 0.05 : Math.abs(wx1 - wx0), 0.05,
          vertical ? Math.abs(wz1 - wz0) : 0.05,
          0, { color: WIRE, mr: [0.6, 0.5] },
        );
      }
    }

    /* ---- zebra crossings + stop bars on the approaches ---- */
    if (rank >= 1) {
      const depth = rank === 2 ? 4.6 : 3.6;
      for (const end of [0, 1]) {
        const jx = end === 0 ? ax : bx;
        const jz = end === 0 ? az : bz;
        const jw = vertical ? ROAD_WIDTH[rowRank(end === 0 ? aj : bj)] : ROAD_WIDTH[columnRank(end === 0 ? ai : bi)];
        const dir = end === 0 ? 1 : -1;
        const cx = jx + ux * dir * (jw / 2 + depth / 2 + 0.4);
        const cz = jz + uz * dir * (jw / 2 + depth / 2 + 0.4);
        const zs = sink.surf(cx, cz);
        // The crossing runs kerb to kerb ACROSS the carriageway, so it has to
        // ride the road's camber along its run or it is swallowed by the crown.
        zs.ribbon(
          cx - px * (width / 2), cz - pz * (width / 2),
          cx + px * (width / 2), cz + pz * (width / 2),
          depth, 0.012, 0,
          { kind: Surf.zebra, a: 1.05, b: 0, seed: 1 }, 2, CAMBER,
        );
        // Stop bar just behind the crossing. It covers one direction of travel
        // only, running from the centreline out to the kerb, so it rides the
        // half of the crown between those two points.
        const sbx = cx + ux * dir * (depth / 2 + 0.55);
        const sbz = cz + uz * dir * (depth / 2 + 0.55);
        zs.ribbon(
          sbx, sbz, sbx - px * (width / 2 - 0.5), sbz - pz * (width / 2 - 0.5),
          0.45, 0.013, 0,
          { kind: Surf.zebra, a: 1e6, b: 0, seed: 1 }, 1,
          CAMBER, 0, -(width / 2 - 0.5) / (width / 2),
        );
      }
    }

    /* ---- gutter drains ---- */
    const drains = Math.max(1, Math.floor(len / 26));
    for (let k = 1; k <= drains; k++) {
      const t = (k - 0.5) / drains;
      const cx = sx + dx * t;
      const cz = sz + dz * t;
      for (const side of [-1, 1]) {
        const gx = cx + px * side * (width / 2 - 0.55);
        const gz = cz + pz * side * (width / 2 - 0.55);
        sink.detail(gx, gz).box(
          gx, 0.012, gz,
          vertical ? 0.5 : 0.9, 0.02, vertical ? 0.9 : 0.5, 0,
          { color: DRAIN, mr: [0.7, 0.45] },
        );
      }
    }
  };

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) seg(i, j, i + 1, j);
      if (j + 1 < n) seg(i, j, i, j + 1);
    }
  }

  /* ---------------- pavements, kerbs and block interiors ---------------- */
  for (let i = 0; i < gridBlocks; i++) {
    for (let j = 0; j < gridBlocks; j++) {
      const b = blockBounds(i, j);
      const cx = (b.x0 + b.x1) / 2;
      const cz = (b.z0 + b.z1) / 2;
      if (opt.isVoid(cx, cz)) continue;
      if (covered(cx, cz)) continue;
      const district = opt.districtAt(cx, cz);
      const s = sink.surf(cx, cz);
      const d = sink.detail(cx, cz);
      const seed = (i * 131 + j * 17) % 211;
      const paveKind = district === 'centruVechi' ? Surf.cobbles : Surf.paving;

      // Footway ring.
      const pv = { kind: paveKind, a: 0, b: 0, seed };
      s.rect(b.x0, b.z0, b.x1, b.bz0, KERB_H, pv);
      s.rect(b.x0, b.bz1, b.x1, b.z1, KERB_H, pv);
      s.rect(b.x0, b.bz0, b.bx0, b.bz1, KERB_H, pv);
      s.rect(b.bx1, b.bz0, b.x1, b.bz1, KERB_H, pv);

      // Kerb faces (outward-facing vertical strips).
      const kerbOpts = { color: new THREE.Color(0x5d5560).convertSRGBToLinear(), mr: [0.0, 0.6] as [number, number] };
      d.box((b.x0 + b.x1) / 2, KERB_H / 2, b.z0 + 0.06, b.x1 - b.x0, KERB_H, 0.12, 0, kerbOpts);
      d.box((b.x0 + b.x1) / 2, KERB_H / 2, b.z1 - 0.06, b.x1 - b.x0, KERB_H, 0.12, 0, kerbOpts);
      d.box(b.x0 + 0.06, KERB_H / 2, (b.z0 + b.z1) / 2, 0.12, KERB_H, b.z1 - b.z0, 0, kerbOpts);
      d.box(b.x1 - 0.06, KERB_H / 2, (b.z0 + b.z1) / 2, 0.12, KERB_H, b.z1 - b.z0, 0, kerbOpts);

      opt.addKerbCollider(cx, cz, (b.x1 - b.x0) / 2, (b.z1 - b.z0) / 2, KERB_H);

      // Block interior ground — what the buildings stand on.
      let interior: number = Surf.paving;
      if (district === 'parc') interior = Surf.grass;
      else if (district === 'cartier') interior = rng.bool(0.55) ? Surf.grass : Surf.gravel;
      else if (district === 'industrial') interior = Surf.gravel;
      else if (district === 'glassCorporate' || district === 'guvern') interior = Surf.plaza;
      else if (district === 'centruVechi') interior = Surf.cobbles;
      s.rect(b.bx0, b.bz0, b.bx1, b.bz1, KERB_H - 0.005, { kind: interior, a: 0, b: 0, seed: seed + 5 });

      dressBlock(sink, b, i, j, district, rng);
    }
  }
}

/* ------------------------------------------------------------------ */
/* THE REAL STREET LAYOUT                                              */
/* ------------------------------------------------------------------ */

export interface OsmStreetOptions {
  sink: ChunkSink;
  rng: Rng;
  city: OsmCity;
  districtAt(x: number, z: number): DistrictKind;
  /** Registers a walkable pavement slab: centre, half extents, rotation, top. */
  addWalkCollider(cx: number, cz: number, hx: number, hz: number, rot: number, top: number): void;
}

/** Camber on a real street. Flatter than the grid's — these curve as well. */
const OSM_CAMBER = 0.07;
/** Junction patch sits at the crown so the ribbons meet it cleanly. */
const PATCH_Y = 0.045;

/**
 * Lay Bucharest's actual streets.
 *
 * One pass per concern, in the order the eye reads them: the tarmac, the
 * junction patches that close the corners where two ribbons meet at an angle,
 * the kerbs, the footways, the tram permanent way, then the dressing.
 */
export function buildOsmStreets(opt: OsmStreetOptions): void {
  const { sink, rng, city } = opt;

  /* ---------------- junction patches ---------------- */
  for (const node of city.nodes) {
    if (!node.edges.length) continue;
    const r = node.patch + 0.7;
    const s = sink.surf(node.x, node.z);
    s.poly(regularPoly(node.x, node.z, r, 8), PATCH_Y, {
      kind: Surf.asphalt, a: r * 4, b: 0, seed: (node.edges[0] * 13) % 97,
    });
  }

  /* ---------------- carriageways, kerbs, footways ---------------- */
  for (let ei = 0; ei < city.edges.length; ei++) {
    const e = city.edges[ei];
    const a = city.nodes[e.a];
    const b = city.nodes[e.b];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) continue;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;

    // Trim back to the junction patches at each end.
    const ta = Math.min(a.patch * 0.85, len * 0.42);
    const tb = Math.min(b.patch * 0.85, len * 0.42);
    const sx = a.x + ux * ta;
    const sz = a.z + uz * ta;
    const ex = b.x - ux * tb;
    const ez = b.z - uz * tb;
    const run = len - ta - tb;
    if (run < 0.6) continue;

    const mx = (sx + ex) / 2;
    const mz = (sz + ez) / 2;
    const s = sink.surf(mx, mz);
    const d = sink.detail(mx, mz);
    const seed = (ei * 7) % 89;

    if (e.width > 0) {
      s.ribbon(sx, sz, ex, ez, e.width, 0, OSM_CAMBER, {
        kind: Surf.asphalt, a: e.width / 2, b: e.lanes, seed,
      }, Math.max(2, Math.min(6, Math.round(e.width / 5))));

      // Kerb faces: a vertical strip either side, 2 triangles each. A box per
      // segment would have cost six times as much for a face nobody sees the
      // back of.
      for (const side of [-1, 1]) {
        const ox = px * side * (e.width / 2);
        const oz = pz * side * (e.width / 2);
        d.quad(
          [sx + ox, 0, sz + oz], [ex + ox, 0, ez + oz],
          [ex + ox, KERB_H, ez + oz], [sx + ox, KERB_H, sz + oz],
          side > 0 ? KERB_OPTS : KERB_OPTS,
        );
      }
    }

    // Footways.
    const walk = e.walk;
    if (walk > 0.5) {
      for (const side of [-1, 1]) {
        const off = side * (e.width / 2 + walk / 2);
        const wx0 = sx + px * off;
        const wz0 = sz + pz * off;
        const wx1 = ex + px * off;
        const wz1 = ez + pz * off;
        const district = opt.districtAt(wx0, wz0);
        sink.surf(wx0, wz0).ribbon(
          wx0, wz0, wx1, wz1, walk, KERB_H, 0,
          {
            kind: district === 'centruVechi' ? Surf.cobbles : Surf.paving,
            a: 0, b: 0, seed,
          }, 1,
        );
        // Colliders only on the streets a vehicle can actually mount: 128 km of
        // imported kerb is twelve thousand static boxes, and the block
        // interiors already carry their own from `fillOsmGround`.
        if (run > 16 && e.rank >= 1) {
          opt.addWalkCollider(
            (wx0 + wx1) / 2, (wz0 + wz1) / 2,
            run / 2, walk / 2, Math.atan2(-uz, ux), KERB_H,
          );
        }
      }
    }

    dressOsmEdge(opt, e, sx, sz, ex, ez, ux, uz, px, pz, run, ei);
  }

  /* ---------------- tram permanent way ---------------- */
  for (const line of city.trams) {
    for (let i = 0; i + 1 < line.length; i++) {
      buildTramRun(sink, line[i], line[i + 1]);
    }
  }

  /* ---------------- parks and squares ---------------- */
  buildOsmGreen(opt);
}

const KERB_OPTS = {
  color: new THREE.Color(0x5d5560).convertSRGBToLinear(),
  mr: [0.0, 0.6] as [number, number],
};

function regularPoly(cx: number, cz: number, r: number, n: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    out.push({ x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r });
  }
  return out;
}

/** Rails, bed and catenary along one straight run of a real tram line. */
function buildTramRun(sink: ChunkSink, a: { x: number; z: number }, b: { x: number; z: number }): void {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 2) return;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz;
  const pz = ux;
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const d = sink.detail(mx, mz);

  // The bed rides just above the carriageway crown; below it the tarmac's
  // camber swallows the rails in the middle of every street.
  sink.surf(mx, mz).ribbon(a.x, a.z, b.x, b.z, TRAM_GAUGE * 2 + 1.4, 0.1, 0, {
    kind: Surf.tramBed, a: 0, b: 0, seed: 3,
  }, 2);
  const rot = Math.atan2(-uz, ux);
  for (const side of [-1, 1]) {
    for (const rgo of [-TRAM_GAUGE / 2, TRAM_GAUGE / 2]) {
      const off = side * (TRAM_GAUGE / 2 + 1.1) + rgo;
      d.box(
        mx + px * off, 0.15, mz + pz * off,
        len, 0.1, 0.085, rot, { color: RAIL, mr: [0.9, 0.16] },
      );
    }
  }
}

/**
 * Lamps, trees, bins and parked cars along a real street.
 *
 * Pitch opens up with distance from the hero crossroads. 128 km of imported
 * street at a flat 30 m lamp pitch is nine thousand lamp posts and a quarter of
 * a million triangles spent on the half of the city that is never closer than
 * a kilometre to the camera.
 */
function dressOsmEdge(
  opt: OsmStreetOptions,
  e: OsmEdge,
  sx: number, sz: number, ex: number, ez: number,
  ux: number, uz: number, px: number, pz: number,
  run: number, ei: number,
): void {
  const { sink, rng } = opt;
  const spec = classSpec(e.cls);
  const mx = (sx + ex) / 2;
  const mz = (sz + ez) / 2;
  const heroDist = Math.hypot(mx + 46, mz - 46);
  const spread = 1 + Math.max(0, heroDist - 320) / 620;
  const district = opt.districtAt(mx, mz);

  /* ---- lamps ---- */
  const lampPitch = spec.lampPitch * spread;
  const lamps = Math.floor(run / lampPitch);
  const bothSides = e.rank >= 1;
  for (let i = 0; i < lamps; i++) {
    const t = (i + 0.5) * (run / Math.max(1, lamps));
    const cx = sx + ux * t;
    const cz = sz + uz * t;
    for (const side of bothSides ? [-1, 1] : [(ei % 2) * 2 - 1]) {
      const lx = cx + px * side * (e.width / 2 + 1.15);
      const lz = cz + pz * side * (e.width / 2 + 1.15);
      streetLamp(
        sink.detail(lx, lz), lx, lz, -px * side, -pz * side,
        e.rank === 2 ? 9.4 : e.rank === 1 ? 8.4 : 7.2,
      );
    }
  }

  /* ---- street trees, on the building-line side of the footway ---- */
  const tPitch = spec.treePitch * spread * (district === 'industrial' ? 2.2 : 1);
  if (tPitch > 0 && e.walk > 2.6) {
    const trees = Math.floor(run / tPitch);
    for (let i = 0; i < trees; i++) {
      if (!rng.bool(0.82)) continue;
      const t = (i + 0.5) * (run / Math.max(1, trees)) + rng.range(-1.4, 1.4);
      if (t < 3 || t > run - 3) continue;
      const cx = sx + ux * t;
      const cz = sz + uz * t;
      const side = rng.bool(0.5) ? 1 : -1;
      const tx = cx + px * side * (e.width / 2 + Math.min(2.4, e.walk * 0.55));
      const tz = cz + pz * side * (e.width / 2 + Math.min(2.4, e.walk * 0.55));
      const td = Math.hypot(tx + 46, tz - 46);
      const tlod: 0 | 1 | 2 = td < 260 ? 2 : td < 700 ? 1 : 0;
      planeTree(sink.detail(tx, tz), tx, tz, rng, 1.0, tlod);
    }
  }

  /* ---- bins and bollards ---- */
  if (e.rank >= 1 && run > 20 && rng.bool(0.22)) {
    const t = rng.range(4, run - 4);
    const side = rng.bool(0.5) ? 1 : -1;
    const bx = sx + ux * t + px * side * (e.width / 2 + 1.6);
    const bz = sz + uz * t + pz * side * (e.width / 2 + 1.6);
    wasteBin(sink.detail(bx, bz), bx, bz, rng);
  }
  if (e.rank === 2 && heroDist < 700) {
    const pitch = 9;
    const count = Math.floor(run / pitch);
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) * pitch;
      for (const side of [-1, 1]) {
        const bx = sx + ux * t + px * side * (e.width / 2 + 0.75);
        const bz = sz + uz * t + pz * side * (e.width / 2 + 0.75);
        bollard(sink.detail(bx, bz), bx, bz);
      }
    }
  }

  /* ---- parked cars in the gutter ---- */
  if (e.rank <= 1 && run > 20 && rng.bool(0.5)) {
    const slots = Math.floor(run / 7.0);
    const side = rng.bool(0.5) ? 1 : -1;
    for (let i = 0; i < slots; i++) {
      if (!rng.bool(heroDist < 700 ? 0.45 : 0.22)) continue;
      const t = (i + 0.5) * 7.0;
      if (t < 6 || t > run - 6) continue;
      const cx = sx + ux * t + px * side * (e.width / 2 - 2.0);
      const cz = sz + uz * t + pz * side * (e.width / 2 - 2.0);
      parkedCar(
        sink.detail(cx, cz), cx, cz,
        Math.atan2(ux, uz) + (side > 0 ? Math.PI : 0) + rng.range(-0.03, 0.03), rng,
      );
    }
  }

  /* ---- roadworks ---- */
  if (e.rank >= 1 && run > 30 && rng.bool(0.04)) {
    const t = rng.range(6, run - 20);
    const cx = sx + ux * t;
    const cz = sz + uz * t;
    crowdBarrier(sink.detail(cx, cz), cx, cz, ux, uz, 5, rng);
  }
}

/* ------------------------------------------------------------------ */
/* Parks, squares and the ground between the buildings                  */
/* ------------------------------------------------------------------ */

function buildOsmGreen(opt: OsmStreetOptions): void {
  const { sink, rng, city } = opt;

  for (const park of city.parks) {
    const c = park.ring.reduce(
      (acc, v) => ({ x: acc.x + v.x / park.ring.length, z: acc.z + v.z / park.ring.length }),
      { x: 0, z: 0 },
    );
    sink.surf(c.x, c.z).poly(park.ring, KERB_H - 0.012, {
      kind: Surf.grass, a: 0, b: 0, seed: Math.abs(Math.round(c.x + c.z)) % 211,
    });

    // Trees on a jittered lattice inside the outline.
    let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
    for (const v of park.ring) {
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
    }
    const pitch = 15;
    for (let x = x0 + pitch * 0.5; x < x1; x += pitch) {
      for (let z = z0 + pitch * 0.5; z < z1; z += pitch) {
        if (!rng.bool(0.55)) continue;
        const tx = x + rng.range(-4, 4);
        const tz = z + rng.range(-4, 4);
        if (!pointInRing(park.ring, tx, tz)) continue;
        if (city.mask.has(tx, tz, Cell.road)) continue;
        const td = Math.hypot(tx + 46, tz - 46);
        planeTree(sink.detail(tx, tz), tx, tz, rng, 1.15, td < 260 ? 2 : td < 700 ? 1 : 0);
      }
    }
  }

  /* ---- squares: a stone deck, lamps and a rim of trees ---- */
  for (const sq of city.squares) {
    const d = sink.detail(sq.x, sq.z);
    const lamps = Math.max(6, Math.round(sq.radius / 7));
    for (let i = 0; i < lamps; i++) {
      const a = (i / lamps) * Math.PI * 2;
      const lx = sq.x + Math.cos(a) * sq.radius * 0.94;
      const lz = sq.z + Math.sin(a) * sq.radius * 0.94;
      if (city.mask.has(lx, lz, Cell.road)) continue;
      streetLamp(sink.detail(lx, lz), lx, lz, -Math.cos(a), -Math.sin(a), 8.6);
      const tx = sq.x + Math.cos(a + 0.22) * sq.radius * 1.02;
      const tz = sq.z + Math.sin(a + 0.22) * sq.radius * 1.02;
      if (!city.mask.has(tx, tz, Cell.road) && !city.mask.has(tx, tz, Cell.built)) {
        planeTree(sink.detail(tx, tz), tx, tz, rng, 1.1, 1);
      }
    }
    /*
     * A square needs SOMETHING IN IT. Piața Revoluției came out as two hundred
     * metres of empty stone with a two-storey Ateneu standing on it, which is
     * the most desolate thing in the city — a real Bucharest square is a
     * monument, a rank of bollards keeping the cars off, benches, and a rim of
     * chestnuts. Cheap: about 300 triangles for the whole square.
     */
    const clear = !city.mask.has(sq.x, sq.z, Cell.road);
    if (sq.radius > 26 && clear) {
      d.box(sq.x, 0.6, sq.z, 5.6, 0.9, 5.6, 0, { color: DetailColor.stone, mr: [0, 0.7] });
      d.box(sq.x, 1.5, sq.z, 3.6, 1.1, 3.6, 0, { color: DetailColor.stoneDark, mr: [0, 0.7] });
      d.cyl(sq.x, 2.0, sq.z, 1.0, 0.7, sq.radius > 38 ? 11.5 : 7.5, 8, {
        color: DetailColor.stone, mr: [0, 0.62],
      });
    }
    // Bollard ring, and benches facing the middle.
    const ring = Math.max(10, Math.round(sq.radius / 2.6));
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2 + 0.11;
      const bx = sq.x + Math.cos(a) * sq.radius * 0.72;
      const bz = sq.z + Math.sin(a) * sq.radius * 0.72;
      if (city.mask.has(bx, bz, Cell.road)) continue;
      bollard(sink.detail(bx, bz), bx, bz);
    }
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5;
      const bx = sq.x + Math.cos(a) * sq.radius * 0.46;
      const bz = sq.z + Math.sin(a) * sq.radius * 0.46;
      if (city.mask.has(bx, bz, Cell.road)) continue;
      if (!rng.bool(0.7)) continue;
      const bd = sink.detail(bx, bz);
      const rot = -a;
      bd.box(bx, 0.42, bz, 1.9, 0.1, 0.52, rot, { color: DetailColor.stoneDark, mr: [0, 0.8] });
      bd.box(bx + Math.cos(a) * 0.24, 0.72, bz + Math.sin(a) * 0.24, 1.9, 0.5, 0.09, rot, {
        color: DetailColor.stoneDark, mr: [0, 0.8],
      });
      for (const s of [-0.8, 0.8]) {
        bd.box(
          bx - Math.sin(a) * s, 0.2, bz + Math.cos(a) * s,
          0.14, 0.4, 0.44, rot, { color: DetailColor.metal, mr: [0.7, 0.45] },
        );
      }
    }
  }
}

/**
 * THE GROUND BETWEEN THE BUILDINGS.
 *
 * The grid used to fill every block interior with one quad. The real city has
 * no block rectangles to fill — it has courtyards, forecourts, car parks and
 * the odd triangle of nothing, all bounded by streets that run at any angle. So
 * the fill is rasterised from the same occupancy mask everything else reads and
 * then greedily merged back into rectangles, which is the difference between a
 * few hundred quads and a hundred thousand.
 *
 * Without it the camera sees the bedrock underlay between the buildings and the
 * whole imported half of the city reads as a model floating over a black plane.
 */
export function fillOsmGround(
  sink: ChunkSink,
  city: OsmCity,
  districtAt: (x: number, z: number) => DistrictKind,
  rng: Rng,
  addCollider: (cx: number, cz: number, hx: number, hz: number, top: number) => void,
): { rects: number } {
  const CELL = 4;
  const n = Math.ceil((HALF * 2) / CELL);
  const at = (i: number, j: number): { x: number; z: number } => ({
    x: -HALF + (i + 0.5) * CELL,
    z: -HALF + (j + 0.5) * CELL,
  });

  // District lookup is two fractal-noise fields; at 4 m over the whole map
  // that is two million noise evaluations, so it is memoised per 16 m.
  const districtMemo = new Map<number, DistrictKind>();
  const districtCached = (x: number, z: number): DistrictKind => {
    const key = Math.floor(x / 16) * 100003 + Math.floor(z / 16);
    let v = districtMemo.get(key);
    if (v === undefined) districtMemo.set(key, (v = districtAt(x, z)));
    return v;
  };

  // 0 = nothing to draw, otherwise the surface kind + 1.
  const kindGrid = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const p = at(i, j);
      if (!city.covered(p.x, p.z)) continue;
      const m = city.mask.at(p.x, p.z);
      if (m & (Cell.road | Cell.walk)) continue;
      if (m & Cell.green) continue;          // drawn as a smooth polygon
      /*
       * BEHIND THE STREET WALL IS A COURTYARD, NOT A PLAZA.
       *
       * Paving everything that was not road turned the whole imported half of
       * the city into one continuous grey concrete field with buildings
       * standing about on it — the single worst thing about the first pass from
       * the air. What is actually back there is beaten gravel, parking, a
       * chestnut tree and some grass, so that is what it gets; stone is
       * reserved for the squares and the civic quarters that really are paved.
       */
      let kind: number = Surf.gravel;
      if (m & Cell.square) kind = Surf.plaza;
      else if (m & Cell.reserved) continue;  // the story owns this ground
      else {
        /*
         * Quantised to 24 m patches, NOT per cell: choosing per 4 m cell
         * speckles the courtyards, and speckle is death to the rectangle merge
         * below — it turned 3,000 quads into 45,000.
         *
         * HASHED, not `(i*7 + j*13) % 5`. That modulo is a lattice, and a
         * lattice of alternating grass and gravel over a whole city is a
         * CHECKERBOARD — from 260 m up it was the most obvious artefact in the
         * frame, a green-and-grey draughts board laid under Bulevardul Unirii.
         */
        const patch = patchHash(Math.floor(i / 6), Math.floor(j / 6)) % 5;
        const district = districtCached(p.x, p.z);
        if (district === 'parc') kind = Surf.grass;
        else if (district === 'cartier') kind = patch < 3 ? Surf.grass : Surf.gravel;
        else if (district === 'industrial') kind = Surf.gravel;
        else if (district === 'centruVechi') kind = patch < 3 ? Surf.cobbles : Surf.gravel;
        else if (district === 'guvern' || district === 'glassCorporate') kind = Surf.plaza;
        else kind = patch < 1 ? Surf.grass : patch < 4 ? Surf.gravel : Surf.paving;
      }
      kindGrid[j * n + i] = kind + 1;
    }
  }

  // Greedy rectangle merge: grow a run east, then extend it south while every
  // cell of the next row matches.
  let rects = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = kindGrid[j * n + i];
      if (!k) continue;
      let w = 1;
      while (i + w < n && kindGrid[j * n + i + w] === k) w++;
      let h = 1;
      outer: while (j + h < n) {
        for (let q = 0; q < w; q++) {
          if (kindGrid[(j + h) * n + i + q] !== k) break outer;
        }
        h++;
      }
      for (let r = 0; r < h; r++) kindGrid.fill(0, (j + r) * n + i, (j + r) * n + i + w);

      const x0 = -HALF + i * CELL;
      const z0 = -HALF + j * CELL;
      const x1 = x0 + w * CELL;
      const z1 = z0 + h * CELL;
      sink.surf((x0 + x1) / 2, (z0 + z1) / 2).rect(x0, z0, x1, z1, KERB_H - 0.006, {
        kind: k - 1, a: 0, b: 0, seed: (i * 131 + j * 17) % 211,
      });
      // Only the slabs a person could stand on are worth a collider.
      if (w * CELL >= 12 && h * CELL >= 12) {
        addCollider((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, KERB_H);
      }
      rects++;
      i += w - 1;
    }
  }
  void rng;
  return { rects };
}

/**
 * Footways, kerbs and dressing along the two AUTHORED axes.
 *
 * Their carriageways come from the grid, but their pavements used to come from
 * the block rings — and inside the imported extent there are no blocks left to
 * draw them. Without this the monumental axis is a 42 m strip of tarmac with
 * the bare ground either side, which is where Casa Constructorilor stands.
 */
export function dressAuthoredAxes(
  sink: ChunkSink,
  rng: Rng,
  covered: (x: number, z: number) => boolean,
  isVoid: (x: number, z: number) => boolean,
  addWalkCollider: (cx: number, cz: number, hx: number, hz: number, rot: number, top: number) => void,
): void {
  const half = ROAD_WIDTH[2] / 2;
  const walk = WALK_WIDTH[2];
  const step = 46;
  for (const vertical of [true, false]) {
    for (let t = -HALF; t < HALF; t += step) {
      const cxA = vertical ? AXIS_X : t + step / 2;
      const czA = vertical ? t + step / 2 : AXIS_Z;
      if (!covered(cxA, czA)) continue;
      // Palatul Parlamentului stands ON the axis. Its forecourt is a landmark
      // void, and the grid already skips the carriageway there — laying the
      // pavement anyway would run two paved strips straight through it.
      if (isVoid(cxA, czA)) continue;
      for (const side of [-1, 1]) {
        const off = side * (half + walk / 2);
        const wx = vertical ? AXIS_X + off : cxA;
        const wz = vertical ? czA : AXIS_Z + off;
        const s = sink.surf(wx, wz);
        if (vertical) s.rect(wx - walk / 2, t, wx + walk / 2, t + step, KERB_H, PAVE);
        else s.rect(t, wz - walk / 2, t + step, wz + walk / 2, KERB_H, PAVE);
        addWalkCollider(
          wx, wz,
          vertical ? walk / 2 : step / 2,
          vertical ? step / 2 : walk / 2,
          0, KERB_H,
        );

        // Kerb face.
        const d = sink.detail(wx, wz);
        const kx = vertical ? AXIS_X + side * half : cxA;
        const kz = vertical ? czA : AXIS_Z + side * half;
        d.box(
          kx, KERB_H / 2, kz,
          vertical ? 0.12 : step, KERB_H, vertical ? step : 0.12, 0, KERB_OPTS,
        );

        const lx = vertical ? AXIS_X + side * (half + 1.15) : cxA;
        const lz = vertical ? czA : AXIS_Z + side * (half + 1.15);
        streetLamp(sink.detail(lx, lz), lx, lz, vertical ? -side : 0, vertical ? 0 : -side, 9.4);
        if (rng.bool(0.7)) {
          const tx = vertical ? AXIS_X + side * (half + 3.2) : cxA + rng.range(-14, 14);
          const tz = vertical ? czA + rng.range(-14, 14) : AXIS_Z + side * (half + 3.2);
          const td = Math.hypot(tx + 46, tz - 46);
          planeTree(sink.detail(tx, tz), tx, tz, rng, 1.05, td < 260 ? 2 : td < 700 ? 1 : 0);
        }
      }
    }
  }
}

const PAVE = { kind: Surf.paving, a: 0, b: 0, seed: 7 };

/** Integer hash for courtyard surface choice — see the note at the call site. */
function patchHash(pi: number, pj: number): number {
  let h = Math.imul(pi | 0, 374761393) ^ Math.imul(pj | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Street dressing                                                     */
/* ------------------------------------------------------------------ */

/** Lamp pitch in metres, by street rank and how central the district is. */
function lampPitch(rank: StreetRank, district: DistrictKind): number {
  const central = district === 'glassCorporate' || district === 'guvern' || district === 'centruVechi';
  if (rank === 2) return 28;
  if (rank === 1) return central ? 34 : 48;
  return central ? 52 : 88;
}

function treePitch(district: DistrictKind): number {
  switch (district) {
    case 'parc': return 15;
    case 'bulevard': return 22;
    case 'glassCorporate': return 26;
    case 'centruVechi': return 30;
    case 'guvern': return 24;
    case 'cartier': return 44;
    default: return 0;
  }
}

/**
 * Furnish one block's pavement ring: sodium lamps, plane trees, bins,
 * bollards, and a run of parked cars in the gutter. This is the difference
 * between "kilometres of totally bare streets" and a city.
 */
function dressBlock(
  sink: ChunkSink,
  b: BlockBounds,
  i: number,
  j: number,
  district: DistrictKind,
  rng: Rng,
): void {
  // [kerb coordinate, walk inner coordinate, outward normal, axis, rank]
  const edges: Array<{
    /** Fixed coordinate of the kerb line. */
    k: number;
    /** Fixed coordinate of the building line. */
    inner: number;
    /** Outward (toward the carriageway) unit vector. */
    ox: number;
    oz: number;
    /** True when the run varies along X. */
    alongX: boolean;
    from: number;
    to: number;
    rank: StreetRank;
  }> = [
    { k: b.z0, inner: b.bz0, ox: 0, oz: -1, alongX: true, from: b.x0, to: b.x1, rank: rowRank(j) },
    { k: b.z1, inner: b.bz1, ox: 0, oz: 1, alongX: true, from: b.x0, to: b.x1, rank: rowRank(j + 1) },
    { k: b.x0, inner: b.bx0, ox: -1, oz: 0, alongX: false, from: b.z0, to: b.z1, rank: columnRank(i) },
    { k: b.x1, inner: b.bx1, ox: 1, oz: 0, alongX: false, from: b.z0, to: b.z1, rank: columnRank(i + 1) },
  ];

  const tPitch = treePitch(district);
  // At most one kerb per block gets parked cars, so the city does not turn
  // into a car park and the triangle budget survives.
  const parkEdge = rng.int(0, 6);

  for (let e = 0; e < edges.length; e++) {
    const ed = edges[e];
    const len = ed.to - ed.from;
    if (len < 10) continue;
    const at = (t: number): [number, number] =>
      ed.alongX ? [ed.from + t, ed.k] : [ed.k, ed.from + t];

    /* ---- lamps, standing 1.1 m in from the kerb, arm over the road ---- */
    const lp = lampPitch(ed.rank, district);
    const lamps = Math.max(1, Math.round(len / lp));
    for (let n = 0; n < lamps; n++) {
      const t = (n + 0.5) * (len / lamps);
      const [px, pz] = at(t);
      const lx = px - ed.ox * 1.15;
      const lz = pz - ed.oz * 1.15;
      streetLamp(sink.detail(lx, lz), lx, lz, ed.ox, ed.oz, ed.rank === 2 ? 9.4 : ed.rank === 1 ? 8.4 : 7.2);
    }

    /* ---- trees, on the building-line side of the footway ---- */
    if (tPitch > 0) {
      const trees = Math.max(0, Math.round(len / tPitch));
      for (let n = 0; n < trees; n++) {
        const t = (n + 0.5) * (len / Math.max(trees, 1)) + rng.range(-1.5, 1.5);
        if (t < 2 || t > len - 2) continue;
        if (!rng.bool(0.82)) continue;
        const [px, pz] = at(t);
        const inset = Math.min(2.6, Math.abs(ed.inner - ed.k) * 0.55);
        const tx = px - ed.ox * inset;
        const tz = pz - ed.oz * inset;
        /*
         * FOLIAGE LOD. Trees are baked into static chunk geometry, so the
         * only LOD available is a spatial one: full armature and canopy near
         * the hero crossroads where the camera actually lives, thinner
         * further out. The same tiering the buildings use (see detailTier),
         * and it is what pays for a real branching tree at all.
         */
        const td = Math.hypot(tx, tz);
        const tlod: 0 | 1 | 2 = td < 260 ? 2 : td < 700 ? 1 : 0;
        planeTree(sink.detail(tx, tz), tx, tz, rng, district === 'parc' ? 1.15 : 1.0, tlod);
      }
    }

    /* ---- bins and bollards ---- */
    if (rng.bool(0.3)) {
      const t = rng.range(4, Math.max(5, len - 4));
      const [px, pz] = at(t);
      wasteBin(sink.detail(px, pz), px - ed.ox * 1.5, pz - ed.oz * 1.5, rng);
    }
    if (ed.rank === 2 || (ed.rank === 1 && rng.bool(0.16))) {
      const pitch = 9;
      const count = Math.floor(len / pitch);
      for (let n = 0; n < count; n++) {
        const t = (n + 0.5) * pitch;
        if (t > len - 3) break;
        const [px, pz] = at(t);
        bollard(sink.detail(px, pz), px - ed.ox * 0.75, pz - ed.oz * 0.75);
      }
    }

    /* ---- roadworks: a barrier run on a few central blocks ---- */
    if (ed.rank >= 1 && rng.bool(0.06)) {
      const t = rng.range(6, Math.max(7, len - 20));
      const [px, pz] = at(t);
      crowdBarrier(
        sink.detail(px, pz),
        px - ed.ox * 1.4, pz - ed.oz * 1.4,
        ed.alongX ? 1 : 0, ed.alongX ? 0 : 1, 5, rng,
      );
    }

    /* ---- parked cars in the gutter ---- */
    if (e === parkEdge && ed.rank >= 1) {
      const slots = Math.floor(len / 7.0);
      for (let n = 0; n < slots; n++) {
        if (!rng.bool(0.42)) continue;
        const t = (n + 0.5) * 7.0;
        if (t < 6 || t > len - 6) continue;
        const [px, pz] = at(t);
        const cx = px + ed.ox * 2.1;
        const cz = pz + ed.oz * 2.1;
        const heading = ed.alongX ? 0 : Math.PI / 2;
        parkedCar(sink.detail(cx, cz), cx, cz, heading + rng.range(-0.03, 0.03), rng);
      }
    }
  }

  /* ---- park furniture: benches and a lit kiosk ---- */
  if (district === 'parc' && rng.bool(0.5)) {
    const px = rng.range(b.bx0 + 6, b.bx1 - 6);
    const pz = rng.range(b.bz0 + 6, b.bz1 - 6);
    const d = sink.detail(px, pz);
    d.box(px, 0.62, pz, 3.2, 2.6, 2.6, rng.range(0, 1.5), {
      color: DetailColor.stoneDark, mr: [0, 0.7],
    });
    d.box(px, 2.0, pz, 3.6, 0.18, 3.0, 0, { color: DetailColor.metal, mr: [0.7, 0.4] });
    d.box(px, 1.55, pz, 3.0, 0.9, 0.06, 0, {
      color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 2.4),
    });
  }
}

/** Trolleybus/tram mast: tapered column, bracket arm, insulator and lamp head. */
function buildCatenaryMast(
  d: DetailBuilder,
  x: number, z: number,
  inwardX: number, inwardZ: number,
  _reach: number,
): void {
  d.cyl(x, KERB_H, z, 0.16, 0.10, 8.6, 8, { color: MAST, mr: [0.65, 0.45] });
  // Base collar.
  d.cyl(x, KERB_H, z, 0.24, 0.20, 0.5, 8, { color: MAST, mr: [0.5, 0.6] });
  // Bracket arm reaching over the carriageway.
  const arm = 3.4;
  d.box(
    x + inwardX * arm * 0.5, 6.55, z + inwardZ * arm * 0.5,
    Math.abs(inwardX) > 0.5 ? arm : 0.09, 0.09,
    Math.abs(inwardZ) > 0.5 ? arm : 0.09, 0,
    { color: MAST, mr: [0.7, 0.4] },
  );
  // Diagonal stay.
  d.box(
    x + inwardX * arm * 0.28, 7.35, z + inwardZ * arm * 0.28,
    Math.abs(inwardX) > 0.5 ? arm * 0.6 : 0.06, 0.06,
    Math.abs(inwardZ) > 0.5 ? arm * 0.6 : 0.06, 0,
    { color: MAST, mr: [0.7, 0.4] },
  );
  // Sodium lamp head on a short gooseneck.
  d.box(
    x + inwardX * 1.9, 8.5, z + inwardZ * 1.9,
    Math.abs(inwardX) > 0.5 ? 2.0 : 0.08, 0.08,
    Math.abs(inwardZ) > 0.5 ? 2.0 : 0.08, 0,
    { color: MAST, mr: [0.7, 0.4] },
  );
  d.box(
    x + inwardX * 2.9, 8.36, z + inwardZ * 2.9,
    0.62, 0.16, 0.34, 0,
    { color: SODIUM, mr: [0.0, 0.35], emissive: [SODIUM.r * 5.5, SODIUM.g * 4.4, SODIUM.b * 2.6] },
  );
  d.box(
    x + inwardX * 2.9, 8.52, z + inwardZ * 2.9,
    0.7, 0.18, 0.42, 0,
    { color: MAST, mr: [0.6, 0.5] },
  );
}

/** Small helper used by landmarks to lay a plaza slab. */
export function plazaSlab(
  s: SurfaceBuilder, x0: number, z0: number, x1: number, z1: number, y: number, seed: number,
): void {
  s.rect(x0, z0, x1, z1, y, { kind: Surf.plaza, a: 0, b: 0, seed });
}

export type { FacadeBuilder };
