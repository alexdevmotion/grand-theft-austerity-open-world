/**
 * Hand-authored landmarks.
 *
 * Two of these carry the whole game's identity and are modelled, not
 * generated:
 *   BUILDERS HOUSE — the reference frame's tower: dark mullioned curtain wall,
 *     a warm travertine core slab beside it, purple-lit interiors, political
 *     portrait screens, an external escape stair, and a barricaded forecourt.
 *   PALATUL PARLAMENTULUI — the pale monumental slab that closes the axis,
 *     stepped, colonnaded and floodlit.
 */

import * as THREE from 'three';
import { PAL, srgb } from '../../render/materials';
import type { Rng } from '../../core/rng';
import {
  DetailBuilder,
  FacadeBuilder,
  SurfaceBuilder,
  Surf,
  rectFootprint,
  type FacadeParams,
} from './builders';
import { BUILDERS, PARLIAMENT } from './districts';
import {
  DetailColor,
  bollard,
  crowdBarrier,
  emi,
  mediaScreen,
  planeTree,
  streetLamp,
} from './facades';
import { FacadeStyle } from './materials';

export interface LandmarkSink {
  surf(x: number, z: number): SurfaceBuilder;
  detail(x: number, z: number): DetailBuilder;
  facade(x: number, z: number): FacadeBuilder;
}

export interface LandmarkVoid {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const MR = {
  stone: [0.0, 0.7] as [number, number],
  metal: [0.8, 0.34] as [number, number],
  paint: [0.05, 0.5] as [number, number],
  glass: [0.9, 0.07] as [number, number],
  rough: [0.0, 0.92] as [number, number],
};

const lin = srgb;
const HAZARD_RED = lin(0xd9333a);
const HAZARD_WHITE = lin(0xe8e2d6);

/** Ground reserved by landmarks — the generic block grammar skips these. */
export const LANDMARK_VOIDS: LandmarkVoid[] = [
  {
    x0: PARLIAMENT.x - PARLIAMENT.w / 2 - 40,
    z0: PARLIAMENT.z - PARLIAMENT.d / 2 - 40,
    x1: PARLIAMENT.x + PARLIAMENT.w / 2 + 40,
    z1: PARLIAMENT.z + PARLIAMENT.d / 2 + 130,
  },
  { x0: BUILDERS.x - 46, z0: BUILDERS.z - 40, x1: BUILDERS.x + 40, z1: BUILDERS.z + 40 },
];

export interface LandmarkResult {
  id: string;
  name: string;
  position: THREE.Vector3;
  radius: number;
  boxes: Array<{ x: number; z: number; hx: number; hz: number; h: number }>;
}

/* ------------------------------------------------------------------ */
/* Builders House — the reference tower                                */
/* ------------------------------------------------------------------ */

export function buildBuildersHouse(sink: LandmarkSink, rng: Rng): LandmarkResult {
  const cx = BUILDERS.x;
  const cz = BUILDERS.z;
  const f = sink.facade(cx, cz);
  const d = sink.detail(cx, cz);
  const s = sink.surf(cx, cz);
  const boxes: LandmarkResult['boxes'] = [];

  const towerW = 30;
  const towerD = 24;
  const towerH = 82;
  const groundH = 9.5;
  const floorH = 4.0;

  const glass: FacadeParams = {
    style: FacadeStyle.glassCorporate,
    floorH,
    bayW: 1.72,
    seed: 11,
    buildingH: towerH,
    groundH,
    lit: 0.62,
    tint: 0.35,
  };

  /* ---- the glass tower ---- */
  const towerFp = rectFootprint(cx, cz, towerW, towerD);
  f.extrude(towerFp, 0, towerH, 0, glass);
  boxes.push({ x: cx, z: cz, hx: towerW / 2, hz: towerD / 2, h: towerH });

  // Aluminium coping + parapet.
  d.ring(cx - towerW / 2 - 0.5, cz - towerD / 2 - 0.5, cx + towerW / 2 + 0.5, cz + towerD / 2 + 0.5,
    towerH - 0.6, 0.7, 0.35, { color: DetailColor.alu, mr: MR.metal });
  d.ring(cx - towerW / 2, cz - towerD / 2, cx + towerW / 2, cz + towerD / 2,
    towerH, 0.36, 1.3, { color: DetailColor.alu, mr: MR.metal });

  // Roof plant + mast: the tower must not end in a clean line against the sky.
  d.box(cx - 5, towerH + 1.9, cz + 3, 7.5, 3.8, 6.5, 0, { color: DetailColor.concrete, mr: MR.rough });
  d.box(cx + 6.5, towerH + 1.1, cz - 4, 4.2, 2.2, 3.6, 0, { color: DetailColor.metalPale, mr: MR.metal });
  d.cyl(cx + 9, towerH, cz + 7, 0.14, 0.06, 13, 6, { color: DetailColor.metal, mr: MR.metal }, false);
  d.box(cx + 9, towerH + 13.2, cz + 7, 0.22, 0.22, 0.22, 0, {
    color: lin(0xff3040), mr: [0, 0.4], emissive: emi(lin(0xff3040), 6),
  });

  /* ---- warm travertine core slab on the west flank ---- */
  const stoneW = 11;
  const stoneD = 26;
  const stoneX = cx - towerW / 2 - stoneW / 2 + 1.2;
  const stone: FacadeParams = {
    style: FacadeStyle.guvern,
    floorH: 4.6,
    bayW: 5.4,
    seed: 41,
    buildingH: towerH * 0.86,
    groundH: 10,
    lit: 0.1,
    tint: 0.9,
  };
  const stoneFp = rectFootprint(stoneX, cz, stoneW, stoneD);
  f.extrude(stoneFp, 0, towerH * 0.86, 0, stone);
  boxes.push({ x: stoneX, z: cz, hx: stoneW / 2, hz: stoneD / 2, h: towerH * 0.86 });
  d.ring(stoneX - stoneW / 2, cz - stoneD / 2, stoneX + stoneW / 2, cz + stoneD / 2,
    towerH * 0.86, 0.4, 1.1, { color: DetailColor.stone, mr: MR.stone });
  // Deep reveal where stone meets glass — the reference's strongest edge.
  d.box(stoneX + stoneW / 2 + 0.15, towerH * 0.43, cz, 0.3, towerH * 0.86, stoneD, 0, {
    color: DetailColor.stoneDark, mr: MR.stone,
  });

  /* ---- podium: glazed lobby with a deep canopy ---- */
  d.box(cx, groundH + 0.2, cz - towerD / 2 - 2.2, towerW + 3, 0.4, 4.6, 0, {
    color: DetailColor.alu, mr: MR.metal,
  });
  d.box(cx, groundH - 0.15, cz - towerD / 2 - 2.2, towerW * 0.86, 0.09, 4.0, 0, {
    color: DetailColor.purple, mr: [0, 0.35], emissive: emi(DetailColor.purple, 3.2),
  });
  for (let i = -2; i <= 2; i++) {
    d.cyl(cx + i * 6.4, 0.17, cz - towerD / 2 - 4.0, 0.17, 0.15, groundH, 8, {
      color: DetailColor.alu, mr: MR.metal,
    });
  }

  /* ---- external escape stair on the west face (reference, left of tower) ---- */
  const stairX = stoneX - stoneW / 2 - 1.6;
  for (let fl = 1; fl <= 6; fl++) {
    const y = groundH + fl * 5.2;
    d.box(stairX, y, cz + rng.range(-1, 1), 3.4, 0.22, 9.5, 0, {
      color: DetailColor.metal, mr: MR.metal,
    });
    // Balustrade.
    for (const side of [-1, 1]) {
      d.box(stairX + side * 1.6, y + 0.55, cz, 0.06, 1.1, 9.5, 0, {
        color: DetailColor.metalPale, mr: MR.metal,
      });
    }
    d.box(stairX - 1.6, y + 1.1, cz, 0.09, 0.09, 9.5, 0, { color: DetailColor.metalPale, mr: MR.metal });
  }
  // Stair stringers.
  for (const zz of [cz - 4.6, cz + 4.6]) {
    d.box(stairX, groundH + 16, zz, 0.16, 32, 0.16, 0, { color: DetailColor.metal, mr: MR.metal });
  }

  /* ---- facade screens: the political portraits ---- */
  mediaScreen(d, cx + 3.5, 16, cz - towerD / 2 - 0.25, 10.5, 15, 0, -1, rng);
  mediaScreen(d, cx - 9.5, 34, cz - towerD / 2 - 0.25, 7.5, 11, 0, -1, rng);
  mediaScreen(d, cx + towerW / 2 + 0.25, 22, cz + 2, 9, 13, 1, 0, rng);

  /* ---- Romanian tricolour on a raking pole ---- */
  const flagX = cx + towerW / 2 + 1.2;
  d.cyl(flagX, groundH + 4, cz - 8, 0.1, 0.07, 9, 6, { color: DetailColor.metalPale, mr: MR.metal }, false);
  const bands = [PAL.roBlue, PAL.roYellow, PAL.roRed];
  for (let i = 0; i < 3; i++) {
    d.box(flagX + 2.4, groundH + 11.2, cz - 8 + (i - 1) * 1.45, 4.6, 3.0, 0.05, 0, {
      color: bands[i], mr: MR.paint,
    });
  }

  /* ---- forecourt: plaza, steps, barriers, hazard tape, pallets ---- */
  s.rect(cx - 40, cz - 40, cx + 34, cz - towerD / 2 - 2, 0.17,
    { kind: Surf.plaza, a: 0, b: 0, seed: 7 });
  // Entrance steps.
  for (let i = 0; i < 4; i++) {
    d.box(cx, 0.17 + 0.17 * i, cz - towerD / 2 - 3.0 - i * 0.45, towerW + 6 - i * 1.2, 0.18, 0.9, 0, {
      color: DetailColor.stone, mr: MR.stone,
    });
  }
  crowdBarrier(d, cx - 26, cz - 16, 1, 0, 12, rng);
  crowdBarrier(d, cx - 26, cz - 16, 0, 1, 6, rng);
  // Hazard tape strung between the barriers.
  d.box(cx - 13.4, 1.32, cz - 16, 25, 0.09, 0.02, 0, { color: HAZARD_RED, mr: MR.paint });
  d.box(cx - 13.4, 1.24, cz - 16, 25, 0.09, 0.02, 0, { color: HAZARD_WHITE, mr: MR.paint });
  // Stacked pallets and a builder's skip.
  for (let i = 0; i < 3; i++) {
    d.box(cx + 16, 0.3 + i * 0.16, cz - 12 + i * 0.1, 1.2, 0.14, 1.0, 0.2 * i, {
      color: lin(0x8a6b45), mr: MR.rough,
    });
  }
  d.box(cx + 21, 0.9, cz - 13, 3.6, 1.5, 2.0, 0.3, { color: DetailColor.rust, mr: [0.4, 0.7] });
  for (let i = 0; i < 7; i++) bollard(d, cx - 36 + i * 5.2, cz - 30);
  for (let i = 0; i < 4; i++) planeTree(d, cx - 34 + i * 9, cz - 36 + rng.range(-2, 2), rng, 1.1);
  streetLamp(d, cx - 30, cz - 24, 1, 0, 8.4);
  streetLamp(d, cx + 26, cz - 24, -1, 0, 8.4);

  return {
    id: 'buildersHouse',
    name: 'Casa Constructorilor',
    position: new THREE.Vector3(cx, 0, cz - 30),
    radius: 55,
    boxes,
  };
}

/* ------------------------------------------------------------------ */
/* Palatul Parlamentului                                               */
/* ------------------------------------------------------------------ */

export function buildParliament(sink: LandmarkSink, rng: Rng): LandmarkResult {
  const cx = PARLIAMENT.x;
  const cz = PARLIAMENT.z;
  const f = sink.facade(cx, cz);
  const d = sink.detail(cx, cz);
  const s = sink.surf(cx, cz);
  const boxes: LandmarkResult['boxes'] = [];

  const W = PARLIAMENT.w;
  const D = PARLIAMENT.d;

  const mk = (h: number, groundH: number): FacadeParams => ({
    style: FacadeStyle.guvern,
    floorH: 5.2,
    bayW: 5.0,
    seed: 3,
    buildingH: h,
    groundH,
    lit: 0.22,
    tint: 1.0,
  });

  /* ---- three-step stepped mass, wings low, centre high ---- */
  const tiers = [
    { w: W, d: D, h: 34 },
    { w: W * 0.66, d: D * 0.82, h: 52 },
    { w: W * 0.38, d: D * 0.62, h: 68 },
    { w: W * 0.17, d: D * 0.36, h: 80 },
  ];
  let prevTop = 0;
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const fp = rectFootprint(cx, cz, t.w, t.d);
    f.extrude(fp, prevTop, t.h, prevTop, mk(t.h, 12));
    // Heavy entablature + balustrade on every tier: this is the whole look.
    d.ring(cx - t.w / 2 - 1.6, cz - t.d / 2 - 1.6, cx + t.w / 2 + 1.6, cz + t.d / 2 + 1.6,
      t.h - 2.4, 2.0, 2.4, { color: DetailColor.stone, mr: MR.stone });
    d.ring(cx - t.w / 2 - 0.9, cz - t.d / 2 - 0.9, cx + t.w / 2 + 0.9, cz + t.d / 2 + 0.9,
      t.h, 1.3, 1.5, { color: lin(0xe6dcc8), mr: MR.stone });
    boxes.push({ x: cx, z: cz, hx: t.w / 2, hz: t.d / 2, h: t.h });
    prevTop = t.h;
  }

  /* ---- south portico: a real colonnade facing down the axis ---- */
  const porticoZ = cz + D / 2 + 5.5;
  const cols = 12;
  for (let i = 0; i < cols; i++) {
    const px = cx - W * 0.30 + (i / (cols - 1)) * W * 0.60;
    d.cyl(px, 4.0, porticoZ, 1.35, 1.2, 22, 10, { color: lin(0xe6dcc8), mr: MR.stone });
    // Capital + base.
    d.box(px, 26.6, porticoZ, 3.2, 1.2, 3.2, 0, { color: lin(0xefe6d2), mr: MR.stone });
    d.box(px, 4.0, porticoZ, 3.4, 0.9, 3.4, 0, { color: lin(0xe6dcc8), mr: MR.stone });
    // Floodlight at the base, aimed up the shaft.
    if (i % 2 === 0) {
      d.box(px, 3.7, porticoZ + 2.4, 0.7, 0.28, 0.5, 0, {
        color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 5.5),
      });
    }
  }
  // Architrave carried by the colonnade + the pediment above it.
  d.box(cx, 28.4, porticoZ, W * 0.66, 2.4, 4.4, 0, { color: lin(0xe6dcc8), mr: MR.stone });
  d.box(cx, 31.4, porticoZ, W * 0.62, 3.6, 3.6, 0, { color: lin(0xefe6d2), mr: MR.stone });
  d.box(cx, 34.2, porticoZ, W * 0.40, 2.2, 3.0, 0, { color: lin(0xefe6d2), mr: MR.stone });

  /* ---- monumental forecourt and its lamps ---- */
  s.rect(cx - W * 0.7, cz + D / 2 + 8, cx + W * 0.7, cz + D / 2 + 120, 0.17,
    { kind: Surf.plaza, a: 0, b: 0, seed: 21 });
  for (let i = 0; i < 5; i++) {
    d.box(cx, 0.17 + 0.2 * i, cz + D / 2 + 8.5 + i * 1.1, W * 0.62, 0.22, 2.2, 0, {
      color: lin(0xe0d6c2), mr: MR.stone,
    });
  }
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    for (const side of [-1, 1]) {
      const lx = cx + side * W * 0.55;
      const lz = cz + D / 2 + 26 + t * 88;
      streetLamp(d, lx, lz, -side, 0, 9.2);
      if (i % 2 === 0) planeTree(d, cx + side * W * 0.66, lz, rng, 1.25);
    }
  }
  for (let i = 0; i < 22; i++) {
    bollard(d, cx - W * 0.62 + (i / 21) * W * 1.24, cz + D / 2 + 16);
  }

  return {
    id: 'palatulParlamentului',
    name: 'Palatul Parlamentului',
    position: new THREE.Vector3(cx, 0, cz + D / 2 + 70),
    radius: 190,
    boxes,
  };
}

/* ------------------------------------------------------------------ */
/* Lighter civic set-pieces                                            */
/* ------------------------------------------------------------------ */

export interface PlazaSpec {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
}

export const PLAZAS: PlazaSpec[] = [
  { id: 'piataVictoriei', name: 'Piața Victoriei', x: 276, z: -368, radius: 78 },
  { id: 'broadcastPlaza', name: 'Piața Transmisiunii', x: 460, z: 184, radius: 62 },
  { id: 'startupCourtyard', name: 'Curtea Startup', x: -368, z: -92, radius: 44 },
  { id: 'cismigiu', name: 'Parcul Cișmigiu', x: -460, z: 345, radius: 150 },
];

/** A civic square: stone slab, a ring of lamps, trees, bollards, a monument. */
export function buildPlaza(sink: LandmarkSink, p: PlazaSpec, rng: Rng): LandmarkResult {
  const d = sink.detail(p.x, p.z);
  const s = sink.surf(p.x, p.z);
  const r = p.radius;

  s.rect(p.x - r, p.z - r, p.x + r, p.z + r, 0.175, { kind: Surf.plaza, a: 0, b: 0, seed: 33 });

  const lamps = 10;
  for (let i = 0; i < lamps; i++) {
    const a = (i / lamps) * Math.PI * 2;
    const lx = p.x + Math.cos(a) * r * 0.82;
    const lz = p.z + Math.sin(a) * r * 0.82;
    streetLamp(d, lx, lz, -Math.cos(a), -Math.sin(a), 8.6);
    planeTree(d, p.x + Math.cos(a + 0.3) * r * 0.94, p.z + Math.sin(a + 0.3) * r * 0.94, rng, 1.15);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    bollard(d, p.x + Math.cos(a) * r * 0.5, p.z + Math.sin(a) * r * 0.5);
  }
  // Central monument: plinth, shaft, and an uplit crown.
  d.box(p.x, 0.6, p.z, 6.4, 0.9, 6.4, 0, { color: DetailColor.stone, mr: MR.stone });
  d.box(p.x, 1.6, p.z, 4.2, 1.2, 4.2, 0, { color: DetailColor.stoneDark, mr: MR.stone });
  d.cyl(p.x, 2.2, p.z, 1.5, 0.9, 14, 10, { color: lin(0xe0d6c2), mr: MR.stone });
  d.box(p.x, 16.9, p.z, 2.2, 1.6, 2.2, 0, {
    color: DetailColor.sodium, mr: [0.3, 0.4], emissive: emi(DetailColor.sodium, 1.6),
  });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    d.box(p.x + Math.cos(a) * 3.4, 1.35, p.z + Math.sin(a) * 3.4, 0.6, 0.24, 0.44, a, {
      color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 6),
    });
  }
  void rng;

  return {
    id: p.id,
    name: p.name,
    position: new THREE.Vector3(p.x, 0, p.z),
    radius: p.radius,
    boxes: [],
  };
}
