/**
 * Street construction: carriageways with camber and lane markings, raised
 * kerbs, paved footways, junction geometry, zebra crossings and stop bars,
 * tram permanent way, catenary masts and wires, gutter drains.
 *
 * Everything is written into the caller's per-chunk builders so the whole
 * network merges down to a handful of draw calls.
 */

import * as THREE from 'three';
import { Palette, WorldScale } from '../../artDirection';
import type { Rng } from '../../core/rng';
import type { DistrictKind } from '../../core/services';
import { DetailBuilder, FacadeBuilder, SurfaceBuilder, Surf } from './builders';
import {
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

const STEEL = new THREE.Color(0x2a2830).convertSRGBToLinear();
const RAIL = new THREE.Color(0x6e6a68).convertSRGBToLinear();
const MAST = new THREE.Color(0x39424a).convertSRGBToLinear();
const WIRE = new THREE.Color(0x1a1a20).convertSRGBToLinear();
const DRAIN = new THREE.Color(0x151318).convertSRGBToLinear();
const SODIUM = Palette.sodiumLamp;

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
}

export function buildRoads(opt: RoadBuildOptions): void {
  const { sink, rng } = opt;
  const n = gridBlocks + 1;

  /* ---------------- junction patches ---------------- */
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = nodeX(i);
      const z = nodeZ(j);
      if (opt.isVoid(x, z)) continue;
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
        zs.ribbon(
          cx - px * (width / 2), cz - pz * (width / 2),
          cx + px * (width / 2), cz + pz * (width / 2),
          depth, 0.012, 0,
          { kind: Surf.zebra, a: 1.05, b: 0, seed: 1 }, 2,
        );
        // Stop bar just behind the crossing.
        const sbx = cx + ux * dir * (depth / 2 + 0.55);
        const sbz = cz + uz * dir * (depth / 2 + 0.55);
        zs.ribbon(
          sbx, sbz, sbx - px * (width / 2 - 0.5), sbz - pz * (width / 2 - 0.5),
          0.45, 0.013, 0,
          { kind: Surf.zebra, a: 1e6, b: 0, seed: 1 }, 1,
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
        planeTree(sink.detail(tx, tz), tx, tz, rng, district === 'parc' ? 1.3 : 1.0);
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
