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
  parkedCar,
  planeTree,
  streetLamp,
  wasteBin,
} from './facades';
import { FacadeStyle } from './materials';
import {
  BAR,
  BLOCK_HALL,
  BROADCAST_MAST,
  BUILDERS_LOBBY,
  CORNER_SHOP,
  INTERIOR_VOIDS,
  RECORDER,
  STUDIO,
  onInteriorFootprint,
} from '../interiors/defs';
import {
  Finish,
  doorCentre,
  doorNormal,
  drawDoorReveal,
  floorSlab,
  innerHalf,
  shellBoxes,
  type RoomFinish,
  type ShellSpec,
} from '../interiors/shell';

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
  // The enterable buildings. Every one of these sits inside a block's building
  // line, so no carriageway or footway is affected — see `INTERIOR_VOIDS`.
  ...INTERIOR_VOIDS,
];

export interface LandmarkResult {
  id: string;
  name: string;
  position: THREE.Vector3;
  radius: number;
  boxes: Array<{ x: number; z: number; hx: number; hz: number; h: number }>;
  /**
   * WALKABLE RAISED SLABS — plaza decks and forecourts, in world-space rects.
   *
   * These are drawn a kerb-height above the road but sit inside
   * `LANDMARK_VOIDS`, so the block's kerb ring is skipped and nothing else ever
   * told the world they exist: they had no collider and `spatial.groundHeight`
   * returned the carriageway height for them. Everything standing on a plaza —
   * the player and every pedestrian — was a full kerb inside the stone.
   *
   * The city registers these as static boxes AND as analytic ground, so the
   * physics floor, the footing probe and the crowd all agree.
   */
  slabs: Array<{ x0: number; z0: number; x1: number; z1: number; top: number }>;
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

  /*
   * THE TOWER IS A SHELL, NOT A SOLID.
   *
   * It used to be registered as ONE cuboid spanning y 0..82 over the whole
   * 30 x 24 footprint, which made Act IV's climax — walking into the lobby —
   * impossible, and forced `src/gameplay/buildersHouse.ts` to find that
   * collider at runtime by matching its centre and half-extents within 0.75 m
   * and rebuild it as six boxes. Any tweak to `towerW`, `towerD` or `towerH`
   * silently missed the match and turned the finale into a wall.
   *
   * `shellBoxes` returns the same mass as four wall slabs with a 3.4 m slot in
   * the south elevation, split by a 0.5 m door post into two 1.45 m leaves:
   * a person walks through, a 1.52 m-wide Dacia cannot. Everything above the
   * lobby is still solid on all four sides at every height a vehicle can
   * reach, because the walls run the full height of the tower.
   *
   * `carveLobbyDoorway` and `LobbyInterior` in src/gameplay/buildersHouse.ts
   * are both dead weight now and can be deleted.
   */
  boxes.push(...shellBoxes(BUILDERS_LOBBY));

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
  const forecourt = { x0: cx - 40, z0: cz - 40, x1: cx + 34, z1: cz - towerD / 2 - 2, top: 0.17 };
  s.rect(cx - 40, cz - 40, cx + 34, cz - towerD / 2 - 2, 0.17,
    { kind: Surf.plaza, a: 0, b: 0, seed: 7 });

  /*
   * ENTRANCE STEPS AND LANDING.
   *
   * These used to rise AWAY from the building — four treads whose top step was
   * the one furthest from the door — and they stopped 2.6 m short of a lobby
   * floor 23 cm above them. The landing is now a walkable slab at exactly
   * `LOBBY.floorY`, so the threshold is flush, and the two treads step down
   * from it to the forecourt.
   */
  const landingZ0 = cz - towerD / 2 - 2.6;
  const landingZ1 = cz - towerD / 2 + 0.2;
  const landing = {
    x0: cx - 6.2, z0: landingZ0, x1: cx + 6.2, z1: landingZ1, top: BUILDERS_LOBBY.floorY,
  };
  d.box(cx, BUILDERS_LOBBY.floorY - 0.09, (landingZ0 + landingZ1) / 2, 12.4, 0.18,
    landingZ1 - landingZ0, 0, { color: DetailColor.stone, mr: MR.stone });
  for (let i = 0; i < 2; i++) {
    const y = 0.17 + (BUILDERS_LOBBY.floorY - 0.17) * ((2 - i) / 3);
    d.box(cx, y - 0.09, landingZ0 - 0.45 - i * 0.9, 12.4 + i * 1.6, 0.18, 0.9, 0, {
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

  /* ---- the door itself: permanent geometry, always drawn ---- */
  openDoorway(d, BUILDERS_LOBBY, Finish.lobby);

  return {
    id: 'buildersHouse',
    name: 'Casa Constructorilor',
    position: new THREE.Vector3(cx, 0, cz - 30),
    radius: 55,
    boxes,
    slabs: [forecourt, landing, floorSlab(BUILDERS_LOBBY)],
  };
}

/* ------------------------------------------------------------------ */
/* Enterable shells                                                    */
/* ------------------------------------------------------------------ */

/**
 * THE DOOR, DRAWN ONCE, PERMANENTLY.
 *
 * The reveal, frame, threshold, door post and leaves go into the CITY's
 * geometry rather than into the streamed fitout, for two reasons: the doorway
 * has to read from further away than the room is worth building, and a hole in
 * a single-sided facade shows the sky through the building until something
 * opaque is standing in it. The dark back plate is that something — it sits
 * against the far inside wall, so from outside the opening reads as an unlit
 * interior and from inside it is just wall.
 */
function openDoorway(d: DetailBuilder, spec: ShellSpec, finish: RoomFinish): void {
  drawDoorReveal(d, spec, finish);
  const n = doorNormal(spec.door);
  const c = doorCentre(spec);
  const { hx, hz } = innerHalf(spec);
  const alongX = n.x === 0;
  const door = spec.door;

  // Dark plate on the far inside wall, so the opening reads as an unlit
  // interior from further away than the fitout is worth building.
  const depth = alongX ? hz * 2 : hx * 2;
  d.box(
    c.x - n.x * depth, spec.floorY + door.height * 0.5, c.z - n.z * depth,
    alongX ? door.width + 1.2 : 0.12,
    door.height + 0.6,
    alongX ? 0.12 : door.width + 1.2,
    0,
    { color: lin(0x0d0b12), mr: MR.rough },
  );

  /*
   * A PORTAL THAT STANDS PROUD OF THE WALL.
   *
   * The first pass lined the opening and stopped there, and from the forecourt
   * the entrance to Builders House was invisible: the facade grammar paints a
   * continuous curtain wall across the whole elevation, and a frame set flush
   * in it is a few dark pixels among a thousand mullions. A player cannot walk
   * through a door he cannot find.
   *
   * So the surround projects 0.45 m: two jamb pilasters, a head beam, a lit
   * soffit under it and a warm pool on the ground. That reads as an entrance
   * from the far side of the plaza, which is the whole job.
   */
  const proud = 0.45;
  const hHead = spec.floorY + door.height + 0.34;
  const pil = 0.55;
  const jambOff = door.width / 2 + pil / 2;
  const px = c.x + n.x * (proud / 2);
  const pz = c.z + n.z * (proud / 2);
  for (const sgn of [-1, 1]) {
    d.box(
      alongX ? c.x + sgn * jambOff : px,
      spec.floorY + (hHead - spec.floorY) / 2,
      alongX ? pz : c.z + sgn * jambOff,
      alongX ? pil : proud + 0.1, hHead - spec.floorY, alongX ? proud + 0.1 : pil,
      0, { color: DetailColor.alu, mr: MR.metal },
    );
  }
  d.box(
    alongX ? c.x : px, hHead + 0.2, alongX ? pz : c.z,
    alongX ? door.width + pil * 2 : proud + 0.1, 0.4, alongX ? proud + 0.1 : door.width + pil * 2,
    0, { color: DetailColor.alu, mr: MR.metal },
  );
  // Lit soffit under the head — the entrance light.
  d.box(
    alongX ? c.x : c.x + n.x * (proud * 0.62), hHead + 0.02, alongX ? c.z + n.z * (proud * 0.62) : c.z,
    alongX ? door.width + 0.5 : proud * 0.7, 0.08, alongX ? proud * 0.7 : door.width + 0.5,
    0, { color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 3.4) },
  );
  // And the pool it throws on the ground outside.
  d.box(
    c.x + n.x * 1.5, spec.floorY - 0.03, c.z + n.z * 1.5,
    alongX ? door.width + 1.6 : 3.4, 0.006, alongX ? 3.4 : door.width + 1.6,
    0, { color: DetailColor.sodium, mr: [0, 0.9], emissive: emi(DetailColor.sodium, 0.22) },
  );
}

/**
 * Facade, parapet, floor, colliders and door for one enterable building.
 *
 * This is the whole contract between an interior and the city: after this the
 * shell is solid everywhere except the doorway, the interior floor is real
 * ground, and `InteriorSystem` only has to furnish the room.
 */
function enterableShell(
  sink: LandmarkSink,
  spec: ShellSpec,
  params: FacadeParams,
  finish: RoomFinish,
  opts: { parapet?: number; plinth?: boolean } = {},
): { boxes: LandmarkResult['boxes']; slabs: LandmarkResult['slabs'] } {
  const f = sink.facade(spec.cx, spec.cz);
  const d = sink.detail(spec.cx, spec.cz);
  const fp = rectFootprint(spec.cx, spec.cz, spec.w, spec.d);
  f.extrude(fp, 0, spec.massH, 0, params);

  const p = opts.parapet ?? 0.9;
  d.ring(
    spec.cx - spec.w / 2 - 0.35, spec.cz - spec.d / 2 - 0.35,
    spec.cx + spec.w / 2 + 0.35, spec.cz + spec.d / 2 + 0.35,
    spec.massH - 0.3, 0.55, p, { color: DetailColor.stone, mr: MR.stone },
  );
  if (opts.plinth !== false) {
    d.ring(
      spec.cx - spec.w / 2 - 0.2, spec.cz - spec.d / 2 - 0.2,
      spec.cx + spec.w / 2 + 0.2, spec.cz + spec.d / 2 + 0.2,
      0.17, 0.35, 0.55, { color: DetailColor.stoneDark, mr: MR.stone },
    );
  }
  openDoorway(d, spec, finish);

  return { boxes: shellBoxes(spec), slabs: [floorSlab(spec)] };
}

/** An entrance canopy and a lit sign over a doorway, facing the street. */
function entranceCanopy(
  d: DetailBuilder, spec: ShellSpec, signColor: THREE.Color, signGain: number,
  width = 5.0,
): void {
  const n = doorNormal(spec.door);
  const c = doorCentre(spec);
  const alongX = n.x === 0;
  const y = spec.floorY + spec.door.height + 0.55;
  d.box(
    c.x + n.x * 0.9, y, c.z + n.z * 0.9,
    alongX ? width : 2.0, 0.22, alongX ? 2.0 : width,
    0, { color: DetailColor.alu, mr: MR.metal },
  );
  d.box(
    c.x + n.x * 0.9, y - 0.16, c.z + n.z * 0.9,
    alongX ? width - 0.6 : 1.6, 0.08, alongX ? 1.6 : width - 0.6,
    0, { color: signColor, mr: [0, 0.32], emissive: emi(signColor, 2.6) },
  );
  for (const s of [-1, 1]) {
    d.cyl(
      c.x + (alongX ? s * (width / 2 - 0.4) : n.x * 1.7),
      y - 1.1,
      c.z + (alongX ? n.z * 1.7 : s * (width / 2 - 0.4)),
      0.05, 0.05, 1.1, 5, { color: DetailColor.metalPale, mr: MR.metal }, false,
    );
  }
  // The sign board itself, standing above the canopy.
  d.box(
    c.x + n.x * 0.35, y + 1.15, c.z + n.z * 0.35,
    alongX ? width * 0.85 : 0.22, 1.5, alongX ? 0.22 : width * 0.85,
    0, { color: DetailColor.metal, mr: MR.metal },
  );
  d.box(
    c.x + n.x * 0.48, y + 1.15, c.z + n.z * 0.48,
    alongX ? width * 0.78 : 0.06, 1.2, alongX ? 0.06 : width * 0.78,
    0, { color: signColor, mr: [0, 0.3], emissive: emi(signColor, signGain) },
  );
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
  const forecourt = { x0: cx - W * 0.7, z0: cz + D / 2 + 8, x1: cx + W * 0.7, z1: cz + D / 2 + 120, top: 0.17 };
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
    slabs: [forecourt],
  };
}

/* ------------------------------------------------------------------ */
/* Lighter civic set-pieces                                            */
/* ------------------------------------------------------------------ */

/**
 * WHAT `CitySystem.generateLandmarks` ITERATES.
 *
 * The city calls `buildBuildersHouse`, `buildParliament` and then one
 * `buildPlaza` per entry in this table — that is the only hook a landmark
 * author has without editing `src/world/city.ts`, which belongs to the city
 * agent. So `kind` dispatches: a square still builds a square, and the
 * enterable buildings the interiors work needs (the Recorder, the broadcast
 * complex, the terrace of shops opposite Builders House) come through the same
 * door and get their colliders, floors and map entries for free.
 *
 * REQUESTED CHANGE (city agent): rename this to `LANDMARKS` and let it carry a
 * builder function per entry, so the dispatch below can go away.
 */
export type LandmarkKind = 'plaza' | 'recorder' | 'broadcast' | 'shop' | 'bar' | 'blockHall';

export interface PlazaSpec {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  kind?: LandmarkKind;
}

export const PLAZAS: PlazaSpec[] = [
  { id: 'piataVictoriei', name: 'Piața Victoriei', x: 276, z: -368, radius: 78 },
  { id: 'broadcastPlaza', name: 'Piața Transmisiunii', x: 460, z: 184, radius: 62, kind: 'broadcast' },
  { id: 'startupCourtyard', name: 'Curtea Startup', x: -368, z: -92, radius: 44 },
  { id: 'cismigiu', name: 'Parcul Cișmigiu', x: -460, z: 345, radius: 150 },
  { id: RECORDER.id, name: RECORDER.name, x: RECORDER.cx, z: RECORDER.cz, radius: 26, kind: 'recorder' },
  { id: CORNER_SHOP.id, name: CORNER_SHOP.name, x: CORNER_SHOP.cx, z: CORNER_SHOP.cz, radius: 12, kind: 'shop' },
  { id: BAR.id, name: BAR.name, x: BAR.cx, z: BAR.cz, radius: 12, kind: 'bar' },
  { id: BLOCK_HALL.id, name: BLOCK_HALL.name, x: BLOCK_HALL.cx, z: BLOCK_HALL.cz, radius: 10, kind: 'blockHall' },
];

/** A civic square, or — by `kind` — one of the enterable buildings. */
export function buildPlaza(sink: LandmarkSink, p: PlazaSpec, rng: Rng): LandmarkResult {
  switch (p.kind) {
    case 'recorder': return buildRecorderHouse(sink, p, rng);
    case 'broadcast': return buildBroadcastComplex(sink, p, rng);
    case 'shop': return buildShopBuilding(sink, p, CORNER_SHOP, rng);
    case 'bar': return buildShopBuilding(sink, p, BAR, rng);
    case 'blockHall': return buildShopBuilding(sink, p, BLOCK_HALL, rng);
    default: break;
  }
  const d = sink.detail(p.x, p.z);
  const s = sink.surf(p.x, p.z);
  const r = p.radius;

  const deck = { x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r, top: 0.175 };
  s.rect(p.x - r, p.z - r, p.x + r, p.z + r, 0.175, { kind: Surf.plaza, a: 0, b: 0, seed: 33 });

  // Anything laid out on a radius has to ask whether a building is standing
  // where the radius lands — see `onInteriorFootprint`.
  const lamps = 10;
  for (let i = 0; i < lamps; i++) {
    const a = (i / lamps) * Math.PI * 2;
    const lx = p.x + Math.cos(a) * r * 0.82;
    const lz = p.z + Math.sin(a) * r * 0.82;
    if (!onInteriorFootprint(lx, lz)) streetLamp(d, lx, lz, -Math.cos(a), -Math.sin(a), 8.6);
    const tx = p.x + Math.cos(a + 0.3) * r * 0.94;
    const tz = p.z + Math.sin(a + 0.3) * r * 0.94;
    if (!onInteriorFootprint(tx, tz)) planeTree(d, tx, tz, rng, 1.15);
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const bx = p.x + Math.cos(a) * r * 0.5;
    const bz = p.z + Math.sin(a) * r * 0.5;
    if (!onInteriorFootprint(bx, bz)) bollard(d, bx, bz);
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
    slabs: [deck],
  };
}

/* ------------------------------------------------------------------ */
/* THE RECORDER — Piața Victoriei                                      */
/* ------------------------------------------------------------------ */

/**
 * A three-storey interbelic block on the square, with the newsroom on the
 * ground floor and the red mark on the corner. Deliberately modest: an
 * independent newsroom that occupies a monument would be the wrong joke.
 */
function buildRecorderHouse(sink: LandmarkSink, p: PlazaSpec, rng: Rng): LandmarkResult {
  const spec = RECORDER;
  const d = sink.detail(spec.cx, spec.cz);
  const s = sink.surf(spec.cx, spec.cz);

  const params: FacadeParams = {
    style: FacadeStyle.interbelic,
    floorH: 4.2,
    bayW: 3.1,
    seed: 77,
    buildingH: spec.massH,
    groundH: spec.ceilingY + 0.5,
    lit: 0.86,
    tint: 0.55,
  };
  const shell = enterableShell(sink, spec, params, Finish.office, { parapet: 1.1 });

  // Paved apron on the entrance side, so the building meets the square.
  const ax0 = spec.cx - spec.w / 2 - 6;
  s.rect(ax0, spec.cz - spec.d / 2 - 3, spec.cx - spec.w / 2, spec.cz + spec.d / 2 + 3, 0.18,
    { kind: Surf.paving, a: 0, b: 0, seed: 19 });

  entranceCanopy(d, spec, lin(0xe12b32), 4.0, 5.4);
  // The mark, big, on the flank beside the door — this is the building's face.
  const mx = spec.cx - spec.w / 2 - 0.2;
  const my = spec.ceilingY + 2.6;
  const seg = 22;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    d.box(mx, my + Math.sin(a) * 1.5, spec.cz + 6.2 + Math.cos(a) * 1.5, 0.22, 0.34, 0.34, 0, {
      color: lin(0xe12b32), mr: [0, 0.4], emissive: emi(lin(0xe12b32), 2.4),
    });
  }
  d.box(mx, my, spec.cz + 6.2, 0.22, 1.3, 1.3, 0, {
    color: lin(0xe12b32), mr: [0, 0.4], emissive: emi(lin(0xe12b32), 2.4),
  });

  // Satellite van at the kerb, mast up, plus the usual street kit.
  const vx = spec.cx - spec.w / 2 - 4.6;
  d.box(vx, 1.35, spec.cz - 6.5, 2.2, 2.1, 5.6, 0, { color: lin(0xdcd6c8), mr: [0.1, 0.55] });
  d.box(vx, 2.55, spec.cz - 7.8, 1.9, 0.5, 2.6, 0, { color: lin(0xdcd6c8), mr: [0.1, 0.55] });
  d.box(vx, 1.6, spec.cz - 9.4, 1.9, 1.0, 0.24, 0, { color: DetailColor.glassDark, mr: MR.glass });
  d.cyl(vx, 2.4, spec.cz - 5.4, 0.12, 0.09, 4.2, 6, { color: DetailColor.metalPale, mr: MR.metal }, false);
  d.cyl(vx, 6.6, spec.cz - 5.4, 0.9, 0.9, 0.14, 12, { color: lin(0xe4e0d6), mr: [0.2, 0.5] });
  d.box(vx, 1.5, spec.cz - 6.5, 2.24, 0.5, 3.0, 0, {
    color: lin(0xe12b32), mr: [0, 0.5], emissive: emi(lin(0xe12b32), 0.8),
  });

  parkedCar(d, spec.cx - spec.w / 2 - 4.6, spec.cz + 4.0, 0, rng);
  wasteBin(d, spec.cx - spec.w / 2 - 2.2, spec.cz + 9.0, rng);
  streetLamp(d, spec.cx - spec.w / 2 - 5.6, spec.cz - 2, 1, 0, 8.0);
  for (let i = 0; i < 3; i++) {
    planeTree(d, spec.cx - spec.w / 2 - 5.2, spec.cz - 9 + i * 9 + rng.range(-1, 1), rng, 1.0);
  }
  for (let i = 0; i < 5; i++) bollard(d, spec.cx - spec.w / 2 - 5.8, spec.cz - 8 + i * 4);
  // Bike hoops, because a newsroom in this city is thirty people and no car park.
  for (let i = 0; i < 3; i++) {
    const bx = spec.cx - spec.w / 2 - 2.6;
    const bz = spec.cz + 6.4 + i * 1.1;
    d.tube(bx - 0.35, 0.2, bz, bx - 0.35, 0.95, bz, 0.03, 5, { color: DetailColor.metal, mr: MR.metal });
    d.tube(bx + 0.35, 0.2, bz, bx + 0.35, 0.95, bz, 0.03, 5, { color: DetailColor.metal, mr: MR.metal });
    d.tube(bx - 0.35, 0.95, bz, bx + 0.35, 0.95, bz, 0.03, 5, { color: DetailColor.metal, mr: MR.metal });
  }

  return {
    id: p.id,
    name: p.name,
    position: new THREE.Vector3(spec.cx - spec.w / 2 - 5, 0, spec.cz),
    radius: p.radius,
    boxes: shell.boxes,
    slabs: shell.slabs,
  };
}

/* ------------------------------------------------------------------ */
/* THE BROADCAST COMPLEX — Piața Transmisiunii                         */
/* ------------------------------------------------------------------ */

/**
 * The square, the mast the mission calls "la bază", and the studio behind it.
 *
 * The mast's four legs stand on a 5.2 m base with the CENTRE BAY LEFT CLEAR:
 * `PLACES.broadcastSite` is exactly there and Act III's interaction has a
 * 4.2 m radius, so anything solid in the middle would make the hijack
 * unreachable.
 */
function buildBroadcastComplex(sink: LandmarkSink, p: PlazaSpec, rng: Rng): LandmarkResult {
  const d = sink.detail(p.x, p.z);
  const s = sink.surf(p.x, p.z);
  const r = p.radius;
  const boxes: LandmarkResult['boxes'] = [];

  /* ---- the square ---- */
  const deck = { x0: p.x - r, z0: p.z - r, x1: p.x + r, z1: p.z + r, top: 0.175 };
  s.rect(p.x - r, p.z - r, p.x + r, p.z + r, 0.175, { kind: Surf.plaza, a: 0, b: 0, seed: 33 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const lx = p.x + Math.cos(a) * r * 0.84;
    const lz = p.z + Math.sin(a) * r * 0.84;
    if (!onInteriorFootprint(lx, lz)) streetLamp(d, lx, lz, -Math.cos(a), -Math.sin(a), 8.6);
    const tx = p.x + Math.cos(a + 0.3) * r * 0.95;
    const tz = p.z + Math.sin(a + 0.3) * r * 0.95;
    if (i % 2 === 0 && !onInteriorFootprint(tx, tz)) planeTree(d, tx, tz, rng, 1.1);
  }
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const bx = p.x + Math.cos(a) * r * 0.42;
    const bz = p.z + Math.sin(a) * r * 0.42;
    if (!onInteriorFootprint(bx, bz)) bollard(d, bx, bz);
  }

  /* ---- the mast ---- */
  const mx = BROADCAST_MAST.x;
  const mz = BROADCAST_MAST.z;
  const H = BROADCAST_MAST.height;
  const half = BROADCAST_MAST.spread / 2;
  const legAt = (t: number, i: number): [number, number] => {
    // Square base tapering to a quarter of its spread at the top.
    const spread = half * (1 - 0.75 * t);
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sz = i < 2 ? -1 : 1;
    return [mx + sx * spread, mz + sz * spread];
  };
  const steel = { color: DetailColor.metalPale, mr: MR.metal };
  const BAYS = 16;
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < BAYS; k++) {
      const t0 = k / BAYS;
      const t1 = (k + 1) / BAYS;
      const [ax, az] = legAt(t0, i);
      const [bx, bz] = legAt(t1, i);
      d.tube(ax, 0.2 + t0 * H, az, bx, 0.2 + t1 * H, bz, 0.13 - t0 * 0.06, 4, steel);
      // Horizontal ring + one diagonal per face per bay.
      const [cx2, cz2] = legAt(t1, (i + 1) % 4);
      d.tube(bx, 0.2 + t1 * H, bz, cx2, 0.2 + t1 * H, cz2, 0.055, 4, steel);
      const [dx2, dz2] = legAt(t0, (i + 1) % 4);
      d.tube(ax, 0.2 + t0 * H, az, dx2, 0.2 + t1 * H, dz2, 0.045, 4, steel);
    }
    // Foot pads, and a collider per leg — the centre bay stays walkable.
    const [fx, fz] = legAt(0, i);
    d.box(fx, 0.35, fz, 1.0, 0.7, 1.0, 0, { color: DetailColor.concrete, mr: MR.rough });
    boxes.push({ x: fx, z: fz, hx: 0.42, hz: 0.42, h: H * 0.9 });
  }
  // Microwave drums and panel antennas up the mast.
  for (const [t, rad] of [[0.42, 1.5], [0.58, 1.1], [0.74, 0.9]] as Array<[number, number]>) {
    d.cyl(mx + rad, 0.2 + t * H, mz, 0.95, 0.95, 0.22, 12, { color: lin(0xd8d2c4), mr: [0.2, 0.5] });
    d.box(mx - rad, 0.2 + t * H + 1.2, mz, 0.24, 1.8, 0.5, 0, { color: lin(0xdcd8d0), mr: [0.1, 0.6] });
  }
  // Aircraft warning lights.
  for (const t of [0.5, 0.78, 1.0]) {
    d.box(mx, 0.4 + t * H, mz, 0.3, 0.3, 0.3, 0, {
      color: lin(0xff3040), mr: [0, 0.4], emissive: emi(lin(0xff3040), 7),
    });
  }
  // Equipment cabin and cable ladder at the foot, clear of the trigger point.
  d.box(mx + 5.6, 1.35, mz + 1.2, 3.4, 2.4, 2.6, 0, { color: lin(0x9a958a), mr: [0.15, 0.8] });
  d.box(mx + 5.6, 2.62, mz + 1.2, 3.6, 0.2, 2.8, 0, { color: DetailColor.metalPale, mr: MR.metal });
  d.box(mx + 4.0, 1.2, mz + 1.2, 0.14, 1.9, 0.9, 0, { color: DetailColor.metal, mr: MR.metal });
  d.box(mx + 5.6, 0.9, mz - 0.2, 1.2, 0.5, 0.06, 0, {
    color: DetailColor.sodium, mr: [0, 0.35], emissive: emi(DetailColor.sodium, 2.2),
  });
  boxes.push({ x: mx + 5.6, z: mz + 1.2, hx: 1.7, hz: 1.3, h: 2.6 });
  for (let i = 0; i < 4; i++) {
    d.tube(mx + 4.0, 0.35, mz + 1.2 - 0.6 + i * 0.4, mx + half + 0.2, 0.35, mz + 0.4, 0.04, 4,
      { color: DetailColor.bitumen, mr: MR.rough });
  }
  // Floodlights aimed up the mast.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.7;
    const fx = mx + Math.cos(a) * 7.5;
    const fz = mz + Math.sin(a) * 7.5;
    d.box(fx, 0.55, fz, 0.8, 0.34, 0.55, a, { color: DetailColor.metal, mr: MR.metal });
    d.box(fx, 0.72, fz, 0.66, 0.06, 0.44, a, {
      color: DetailColor.sodium, mr: [0, 0.3], emissive: emi(DetailColor.sodium, 6),
    });
  }

  /* ---- the studio ---- */
  const spec = STUDIO;
  const params: FacadeParams = {
    style: FacadeStyle.industrial,
    floorH: 5.0,
    bayW: 6.2,
    seed: 91,
    buildingH: spec.massH,
    groundH: 9.4,
    lit: 0.28,
    tint: 0.35,
  };
  const shell = enterableShell(sink, spec, params, Finish.studio, { parapet: 0.7 });
  const sd = sink.detail(spec.cx, spec.cz);
  entranceCanopy(sd, spec, DetailColor.sodium, 3.2, 6.0);

  // Roof plant: air handling, dishes, a cable gantry back to the mast.
  sd.box(spec.cx - 8, spec.massH + 1.3, spec.cz + 6, 8.0, 2.6, 5.0, 0,
    { color: DetailColor.concrete, mr: MR.rough });
  sd.box(spec.cx + 6, spec.massH + 0.9, spec.cz - 4, 4.4, 1.8, 3.6, 0,
    { color: DetailColor.metalPale, mr: MR.metal });
  for (let i = 0; i < 3; i++) {
    const dx = spec.cx + 2 + i * 5;
    sd.cyl(dx, spec.massH + 0.4, spec.cz + 15, 1.6, 1.6, 0.3, 12, { color: lin(0xdedad0), mr: [0.2, 0.5] });
    sd.cyl(dx, spec.massH + 0.7, spec.cz + 15, 0.1, 0.1, 1.2, 6, { color: DetailColor.metal, mr: MR.metal }, false);
  }
  // Loading dock on the west flank.
  sd.box(spec.cx - spec.w / 2 - 1.6, 0.7, spec.cz - 8, 3.2, 1.0, 7.0, 0,
    { color: DetailColor.concrete, mr: MR.rough });
  sd.box(spec.cx - spec.w / 2 + 0.35, 2.4, spec.cz - 8, 0.4, 4.2, 5.0, 0,
    { color: DetailColor.rust, mr: [0.5, 0.7] });
  // Security line: fence, gate, a guard hut, and the state crest on the wall.
  for (let i = 0; i < 16; i++) {
    const fx = spec.cx - spec.w / 2 + i * 3.0;
    if (fx > spec.cx + spec.w / 2) break;
    sd.cyl(fx, 0.2, spec.cz + spec.d / 2 + 5.0, 0.07, 0.06, 2.4, 5, { color: DetailColor.metal, mr: MR.metal }, false);
    sd.box(fx + 1.5, 1.4, spec.cz + spec.d / 2 + 5.0, 3.0, 2.0, 0.05, 0,
      { color: DetailColor.metal, mr: [0.7, 0.6] });
  }
  sd.box(spec.cx + spec.w / 2 - 4, 1.3, spec.cz + spec.d / 2 + 6.4, 2.2, 2.4, 2.2, 0,
    { color: lin(0x9a958a), mr: [0.1, 0.8] });
  sd.box(spec.cx + spec.w / 2 - 4, 1.6, spec.cz + spec.d / 2 + 5.3, 1.6, 1.0, 0.1, 0,
    { color: DetailColor.glassDark, mr: MR.glass });
  boxes.push({ x: spec.cx + spec.w / 2 - 4, z: spec.cz + spec.d / 2 + 6.4, hx: 1.1, hz: 1.1, h: 2.6 });
  mediaScreen(sd, spec.cx - 6, 10.5, spec.cz + spec.d / 2 + 0.25, 9, 4.5, 0, 1, rng);

  return {
    id: p.id,
    name: p.name,
    position: new THREE.Vector3(p.x, 0, p.z),
    radius: p.radius,
    boxes: [...boxes, ...shell.boxes],
    slabs: [deck, ...shell.slabs],
  };
}

/* ------------------------------------------------------------------ */
/* The terrace opposite Builders House                                 */
/* ------------------------------------------------------------------ */

/**
 * A small enterable building on a street frontage: shopfront at the bottom,
 * flats above, a lit sign, and enough kerbside clutter that the door reads as
 * a door somebody uses rather than as a decal.
 */
function buildShopBuilding(
  sink: LandmarkSink, p: PlazaSpec, spec: ShellSpec, rng: Rng,
): LandmarkResult {
  const d = sink.detail(spec.cx, spec.cz);
  const isHall = spec.id === 'blockHall';
  const isBar = spec.id === 'buildersBar';

  const params: FacadeParams = {
    style: isHall ? FacadeStyle.cartier : FacadeStyle.interbelic,
    floorH: isHall ? 2.9 : 3.4,
    bayW: isHall ? 3.6 : 2.9,
    seed: isHall ? 53 : isBar ? 61 : 67,
    buildingH: spec.massH,
    groundH: spec.ceilingY + 0.4,
    lit: 0.72,
    tint: isBar ? 0.25 : 0.6,
  };
  const shell = enterableShell(sink, spec, params, isBar ? Finish.bar : Finish.shop, {
    parapet: isHall ? 0.5 : 1.0,
  });

  const front = spec.cz + spec.d / 2;
  const sign = isBar ? lin(0xff2f8e) : isHall ? DetailColor.sodium : lin(0xe12b32);

  // Shopfront: a deep fascia across the frontage and a lit sign band.
  d.box(spec.cx, spec.ceilingY + 0.55, front + 0.28, spec.w - 0.6, 0.9, 0.34, 0,
    { color: DetailColor.metal, mr: MR.metal });
  d.box(spec.cx, spec.ceilingY + 0.55, front + 0.46, spec.w - 1.2, 0.62, 0.06, 0,
    { color: sign, mr: [0, 0.3], emissive: emi(sign, 3.4) });
  // Awning over the door.
  const dx = spec.cx + spec.door.offset;
  if (!isHall) {
    d.box(dx, spec.door.height + 0.9, front + 0.95, 3.2, 0.1, 1.4, 0.16,
      { color: DetailColor.awning, mr: [0, 0.85] });
    for (const sgn of [-1, 1]) {
      d.tube(dx + sgn * 1.5, spec.door.height + 1.0, front + 0.1,
        dx + sgn * 1.5, spec.door.height + 0.75, front + 1.6, 0.02, 4,
        { color: DetailColor.metal, mr: MR.metal });
    }
  }
  // Warm spill on the pavement: the honest way to say "this door opens".
  d.box(dx, 0.176, front + 2.1, 3.4, 0.006, 3.0, 0, {
    color: DetailColor.sodium, mr: [0, 0.92], emissive: emi(DetailColor.sodium, 0.1),
  });

  if (spec.id === 'cornerShop') {
    // Crates, a gas bottle cage, and an ice-cream chest by the door.
    for (let i = 0; i < 3; i++) {
      d.box(spec.cx - 5.2, 0.34 + i * 0.3, front + 1.0, 0.7, 0.3, 0.5, 0.1 * i,
        { color: lin(0x6d5a3a), mr: MR.rough });
    }
    d.box(spec.cx - 3.4, 0.72, front + 1.0, 1.3, 1.1, 0.8, 0, { color: lin(0xdcd6c8), mr: [0.15, 0.5] });
    d.box(spec.cx - 3.4, 1.3, front + 1.0, 1.2, 0.06, 0.7, 0, { color: DetailColor.glassDark, mr: MR.glass });
    wasteBin(d, spec.cx + 6.0, front + 1.4, rng);
    d.box(spec.cx + 6.6, 0.85, front + 0.3, 0.7, 1.4, 0.12, 0, {
      color: DetailColor.screen, mr: [0, 0.4], emissive: emi(DetailColor.screen, 1.6),
    });
  } else if (isBar) {
    // Two pavement tables and an A-board.
    for (const tx of [spec.cx + 3.4, spec.cx + 5.8]) {
      d.cyl(tx, 0.17, front + 1.9, 0.24, 0.07, 0.7, 8, { color: DetailColor.metal, mr: MR.metal }, false);
      d.cyl(tx, 0.87, front + 1.9, 0.38, 0.38, 0.05, 10, { color: lin(0x7a5632), mr: [0, 0.7] });
      for (const sgn of [-1, 1]) {
        d.box(tx + sgn * 0.7, 0.62, front + 1.9, 0.42, 0.06, 0.42, 0, { color: lin(0x4a3526), mr: [0, 0.8] });
        d.box(tx + sgn * 0.78, 0.95, front + 1.9, 0.06, 0.6, 0.42, 0, { color: lin(0x4a3526), mr: [0, 0.8] });
      }
    }
    d.box(spec.cx - 5.6, 0.62, front + 1.6, 0.7, 0.9, 0.1, 0.35, { color: lin(0x2a2620), mr: MR.rough });
    d.box(spec.cx - 5.6, 0.62, front + 1.75, 0.6, 0.8, 0.02, 0.35, {
      color: lin(0xe8e2d6), mr: [0, 0.8], emissive: emi(lin(0xe8e2d6), 0.3),
    });
  } else {
    // A block entrance: a bare canopy on two props and a wall of buzzers.
    d.box(spec.cx, spec.door.height + 0.55, front + 0.9, 3.6, 0.18, 1.8, 0,
      { color: DetailColor.concrete, mr: MR.rough });
    for (const sgn of [-1, 1]) {
      d.cyl(spec.cx + sgn * 1.6, 0.17, front + 1.6, 0.09, 0.09, spec.door.height + 0.4, 6,
        { color: DetailColor.concrete, mr: MR.rough }, false);
    }
    d.box(spec.cx + 1.0, 1.35, front + 0.06, 0.34, 0.6, 0.08, 0, { color: DetailColor.metal, mr: MR.metal });
    d.box(spec.cx + 1.0, 1.35, front + 0.11, 0.26, 0.5, 0.02, 0, {
      color: DetailColor.sodium, mr: [0, 0.4], emissive: emi(DetailColor.sodium, 1.4),
    });
    wasteBin(d, spec.cx - 4.0, front + 1.6, rng);
  }

  return {
    id: p.id,
    name: p.name,
    position: new THREE.Vector3(spec.cx, 0, front + 3),
    radius: p.radius,
    boxes: shell.boxes,
    slabs: shell.slabs,
  };
}
