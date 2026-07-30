/**
 * THE SHELL — one description of an enterable building, used by three callers.
 *
 * An interior is only "real" when four separate things agree about it:
 *
 *   1. the COLLIDERS say the walls are solid and the doorway is a hole;
 *   2. the FLOOR says you stand at the interior level, not on the carriageway;
 *   3. the DRAWN interior walls sit exactly where the colliders are, so you
 *      never see a gap between what stops you and what you look at;
 *   4. the DOORWAY is wide enough for a person and too narrow for the Dacia —
 *      `docs/STORY.md`: "one pedestrian doorway the car cannot cross".
 *
 * Getting those four to agree by hand is exactly how the Builders House lobby
 * ended up being carved out of a finished collider at runtime by
 * `src/gameplay/buildersHouse.ts`, matching a cuboid by its centre within
 * 0.75 m and hoping the landmark never moved. So all four come from ONE spec
 * here: `shellBoxes()` for the physics and the block-out, `floorSlab()` for the
 * ground, `drawShellRoom()` for the geometry, `leafWidth()` for the promise
 * about the car.
 *
 * OWNER: interiors agent.
 */

import type { Rng } from '../../core/rng';
import type { DetailBuilder } from '../city/builders';
import { srgb } from '../../render/materials';

/** +z is north, matching the city's convention that 0 rad faces +Z. */
export type Side = 'north' | 'south' | 'east' | 'west';

export interface DoorGap {
  side: Side;
  /** Opening centre, offset from the footprint centre along the wall. */
  offset: number;
  /** Structural opening, mullion included. */
  width: number;
  /** Head height above the interior floor. */
  height: number;
  /**
   * Central door post. This is what keeps the car out of a wide entrance: a
   * 3.4 m glazed opening with a 0.5 m mullion is two 1.45 m leaves, which a
   * person walks through and a 1.52 m-wide Dacia 1300 cannot.
   */
  mullion: number;
}

export interface ShellSpec {
  id: string;
  /** Romanian display name — this is what the player reads on the map. */
  name: string;
  /** Footprint centre. */
  cx: number;
  cz: number;
  /** OUTER footprint size. */
  w: number;
  d: number;
  /** Wall thickness. Colliders and drawn walls both use it. */
  wallT: number;
  /**
   * Height of the solid mass. For a shop this is the whole four-storey
   * building; for Builders House it is the full 82 m tower. The shell is
   * hollow all the way up — there is no floor above the interior storey and
   * nothing that can reach one.
   */
  massH: number;
  /** Top of the interior floor slab. */
  floorY: number;
  /** Underside of the interior ceiling. */
  ceilingY: number;
  door: DoorGap;
  /** Streaming radius: the fitout is built and lit inside this. */
  streamRadius: number;
  /**
   * MULTIPLIER ON THE ROOM'S AMBIENT FILL, 1 by default.
   *
   * The light pool is six real point lights for the whole game, which is a
   * generous rig for a 12 m shop and nothing at all for a 44 m television
   * studio: from the gallery end, every fixture over the set is outside the
   * six nearest and the room goes black. Rather than pay for a bigger pool in
   * every frame of the game, a big or a deliberately bright room carries more
   * of its own bounce. Each interior gets its own material instance — same
   * program, one more draw call, and the fill becomes a per-room dial.
   */
  fill?: number;
}

/** The box shape `LandmarkResult.boxes` (and therefore the city) speaks. */
export interface ShellBox {
  x: number;
  z: number;
  hx: number;
  hz: number;
  h: number;
}

export interface ShellSlab {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  top: number;
}

/**
 * WIDEST CLEAR OPENING A CAR MUST NOT FIT THROUGH.
 *
 * A Dacia 1300 is 1.52 m across the body and about 1.70 m over the mirrors.
 * Every doorway in the game is held under this, with a margin, and
 * `interiors.test.ts` fails the build if one is not.
 */
export const MAX_LEAF = 1.45;

/** Clear width of the widest leaf of a doorway. */
export function leafWidth(door: DoorGap): number {
  return door.mullion > 0.01 ? (door.width - door.mullion) / 2 : door.width;
}

export function innerHalf(s: ShellSpec): { hx: number; hz: number } {
  return { hx: s.w / 2 - s.wallT, hz: s.d / 2 - s.wallT };
}

/** Unit outward normal of the wall the door is in. */
export function doorNormal(door: DoorGap): { x: number; z: number } {
  switch (door.side) {
    case 'north': return { x: 0, z: 1 };
    case 'south': return { x: 0, z: -1 };
    case 'east': return { x: 1, z: 0 };
    default: return { x: -1, z: 0 };
  }
}

/** World position of the doorway centre, in the plane of the wall. */
export function doorCentre(s: ShellSpec): { x: number; z: number } {
  const n = doorNormal(s.door);
  const alongX = n.x === 0;
  return {
    x: alongX ? s.cx + s.door.offset : s.cx + n.x * (s.w / 2),
    z: alongX ? s.cz + n.z * (s.d / 2) : s.cz + s.door.offset,
  };
}

/** A standing spot `dist` metres outside the door. */
export function doorOutside(s: ShellSpec, dist = 3.0): { x: number; z: number } {
  const c = doorCentre(s);
  const n = doorNormal(s.door);
  return { x: c.x + n.x * dist, z: c.z + n.z * dist };
}

/** A standing spot `dist` metres inside the door, clear of the reveal. */
export function doorInside(s: ShellSpec, dist = 3.0): { x: number; z: number } {
  const c = doorCentre(s);
  const n = doorNormal(s.door);
  return { x: c.x - n.x * dist, z: c.z - n.z * dist };
}

/**
 * Segments of a wall of length `len` (local coords, centred on 0) once the
 * doorway and its mullion have been taken out of it. Returned as [from, to]
 * pairs so both the collider and the drawn wall are cut identically.
 */
export function splitWall(len: number, door: DoorGap): Array<[number, number]> {
  const half = len / 2;
  const a = door.offset - door.width / 2;
  const b = door.offset + door.width / 2;
  const out: Array<[number, number]> = [];
  if (a > -half + 0.02) out.push([-half, a]);
  if (b < half - 0.02) out.push([b, half]);
  if (door.mullion > 0.01) {
    out.push([door.offset - door.mullion / 2, door.offset + door.mullion / 2]);
  }
  return out;
}

/**
 * The solid shell as ground-anchored boxes.
 *
 * Ground-anchored because that is the only shape the city's landmark contract
 * carries (`LandmarkResult.boxes` is `{x, z, hx, hz, h}` and is registered from
 * y = 0 to y = h). Four walls with a slot in one of them therefore replace the
 * single solid cuboid the tower used to be: the mass above the entrance storey
 * is still solid on all four sides at every height a vehicle can reach, and the
 * only way in is the doorway.
 */
export function shellBoxes(s: ShellSpec): ShellBox[] {
  const { cx, cz, w, d, wallT: t, massH: h, door } = s;
  const out: ShellBox[] = [];
  const push = (x: number, z: number, hx: number, hz: number): void => {
    if (hx < 0.01 || hz < 0.01) return;
    out.push({ x, z, hx, hz, h });
  };

  // A wall running along X, at world z, cut by the door if it is this side.
  const alongX = (z: number, cut: boolean): void => {
    if (!cut) {
      push(cx, z, w / 2, t / 2);
      return;
    }
    for (const [a, b] of splitWall(w, door)) {
      push(cx + (a + b) / 2, z, (b - a) / 2, t / 2);
    }
  };
  // A wall running along Z, at world x.
  const alongZ = (x: number, cut: boolean): void => {
    if (!cut) {
      push(x, cz, t / 2, d / 2);
      return;
    }
    for (const [a, b] of splitWall(d, door)) {
      push(x, cz + (a + b) / 2, t / 2, (b - a) / 2);
    }
  };

  alongX(cz + d / 2 - t / 2, door.side === 'north');
  alongX(cz - d / 2 + t / 2, door.side === 'south');
  alongZ(cx + w / 2 - t / 2, door.side === 'east');
  alongZ(cx - w / 2 + t / 2, door.side === 'west');
  return out;
}

/**
 * The interior floor, as a walkable slab.
 *
 * The city registers slabs BOTH as a terrain collider and as analytic ground
 * (`CitySystem.slabTopAt`), which is what makes the floor agree with the
 * player's footing probe, with the pedestrian crowd and with anything that asks
 * `spatial.groundHeight`. Without it the lobby floor is scenery and the player
 * stands shin-deep in his own reception.
 */
export function floorSlab(s: ShellSpec): ShellSlab {
  const { hx, hz } = innerHalf(s);
  return {
    x0: s.cx - hx - 0.4,
    z0: s.cz - hz - 0.4,
    x1: s.cx + hx + 0.4,
    z1: s.cz + hz + 0.4,
    top: s.floorY,
  };
}

/** True when (x, z) is inside the interior volume, with a small tolerance. */
export function insideShell(s: ShellSpec, x: number, z: number, pad = 0.4): boolean {
  const { hx, hz } = innerHalf(s);
  return Math.abs(x - s.cx) < hx + pad && Math.abs(z - s.cz) < hz + pad;
}

/* ------------------------------------------------------------------ */
/* Drawn room                                                          */
/* ------------------------------------------------------------------ */

const lin = srgb;

export interface RoomFinish {
  /** Wall face colour + roughness. */
  wall: readonly [number, number];
  /** Floor colour + roughness. */
  floor: readonly [number, number];
  ceiling: readonly [number, number];
  skirting?: number;
  /** Colour of the drawn door frame. */
  frame?: number;
  /** Body tint of a glazed elevation. */
  glassTint?: number;
  /** Colour of the sunset the glass is supposed to be showing. */
  glassWarm?: number;
  /** 0..1 how strongly the glass reads as lit from outside. */
  glassGain?: number;
}

export const Finish = {
  office: {
    wall: [0x54505e, 0.94],
    floor: [0x2c2833, 0.86],
    ceiling: [0x6d6a76, 0.95],
    skirting: 0x2a2731,
    frame: 0x9aa2ab,
    glassTint: 0x241d3a,
    glassWarm: 0xff8a5a,
    glassGain: 0.6,
  },
  studio: {
    wall: [0x232028, 0.96],
    floor: [0x1a1820, 0.7],
    ceiling: [0x17151c, 0.98],
    skirting: 0x121016,
    frame: 0x8d949c,
  },
  lobby: {
    wall: [0x3b3644, 0.9],
    floor: [0x3a3440, 0.5],
    ceiling: [0x2d2936, 0.94],
    skirting: 0x211d29,
    frame: 0x9aa2ab,
    glassTint: 0x22183a,
    glassWarm: 0xff7a4a,
    glassGain: 0.8,
  },
  shop: {
    wall: [0x6f6a66, 0.95],
    floor: [0x8a8378, 0.62],
    ceiling: [0x7c7872, 0.95],
    skirting: 0x4a453f,
    frame: 0xb9b0a2,
    glassTint: 0x2a2440,
    glassWarm: 0xff9a5a,
    glassGain: 0.5,
  },
  bar: {
    wall: [0x4e392c, 0.92],
    floor: [0x3d2c22, 0.72],
    ceiling: [0x33241c, 0.96],
    skirting: 0x1a120f,
    frame: 0x6d5a3a,
    glassTint: 0x1e1830,
    glassWarm: 0xff8a4a,
    glassGain: 0.34,
  },
  hall: {
    wall: [0x6a6f5e, 0.96],
    floor: [0x4a4a50, 0.8],
    ceiling: [0x5c5a52, 0.96],
    skirting: 0x3a3830,
    frame: 0x8d949c,
    glassTint: 0x231d33,
    glassWarm: 0xff8a5a,
    glassGain: 0.3,
  },
} as const satisfies Record<string, RoomFinish>;

/**
 * Floor, ceiling and the four inner wall faces, with the doorway cut out of
 * one of them and a lintel over it.
 *
 * These faces are what stops you seeing the whole city through a window: the
 * shell's own facade is drawn by the city's facade grammar and is
 * single-sided, so from inside it culls away and the camera looks straight out
 * at the skyline. The interior needs its own opaque skin.
 */
export function drawShellRoom(
  b: DetailBuilder,
  s: ShellSpec,
  f: RoomFinish,
  opts: { ceiling?: boolean; reveal?: boolean; glazed?: Side[] } = {},
): void {
  const { hx, hz } = innerHalf(s);
  const y0 = s.floorY;
  const y1 = s.ceilingY;
  const h = y1 - y0;
  const wallMat = { color: lin(f.wall[0]), mr: [0, f.wall[1]] as [number, number] };
  const floorMat = { color: lin(f.floor[0]), mr: [0.04, f.floor[1]] as [number, number] };
  const ceilMat = { color: lin(f.ceiling[0]), mr: [0, f.ceiling[1]] as [number, number] };
  const skirt = { color: lin(f.skirting ?? 0x1a1720), mr: [0, 0.8] as [number, number] };

  // Floor slab. Drawn 0.12 thick so the edge reads at a door threshold.
  b.box(s.cx, y0 - 0.06, s.cz, hx * 2, 0.12, hz * 2, 0, floorMat);
  if (opts.ceiling !== false) {
    b.box(s.cx, y1 + 0.09, s.cz, hx * 2, 0.18, hz * 2, 0, ceilMat);
  }

  const T = 0.14;
  const door = s.door;
  const glazed = opts.glazed ?? [];

  /*
   * A GLAZED ELEVATION.
   *
   * "Windows are light sources" and "you can see through the glass into lit
   * floors" are non-negotiable in `docs/VISUAL_TARGET.md`, and a room whose
   * street elevation is a slab of concrete breaks both — from inside there is
   * no sunset, from outside there is nothing to see into.
   *
   * The panels are still OPAQUE, because a transparent wall would put the
   * whole 2.4 km city behind the desk of a 12 m room. What sells them as glass
   * is that they are near-black, nearly smooth (so the sky probe lands on
   * them) and carry a low emissive tint of the sunset that is supposedly
   * outside — plus real aluminium mullions and a transom, which is what the
   * eye actually reads a curtain wall by.
   */
  const glassPanel = (
    cx2: number, cz2: number, alongX: boolean, from: number, to: number,
  ): void => {
    const span = to - from;
    if (span < 0.2) return;
    const mid = (from + to) / 2;
    const px = alongX ? mid : cx2;
    const pz = alongX ? cz2 : mid;
    const sx = alongX ? span : T;
    const sz = alongX ? T : span;
    const tint = lin(f.glassTint ?? 0x2a1c3d);
    const warm = lin(f.glassWarm ?? 0xff8a5a);
    const gain = f.glassGain ?? 0.5;
    // Spandrel below the transom.
    b.box(px, y0 + 0.55, pz, sx, 1.1, sz, 0, { color: lin(0x14121b), mr: [0.5, 0.35] });
    /*
     * The vision glass is banded, not flat. A single emissive value over a
     * three-metre pane reads as backlit paper; the sky it is standing in runs
     * from hot orange at the horizon to violet two storeys up, and the pane
     * has to do the same or the room's best surface is its least convincing.
     */
    const bands = 6;
    const top = h - 1.1;
    for (let k = 0; k < bands; k++) {
      const t = k / (bands - 1);
      const by = y0 + 1.1 + (k + 0.5) * (top / bands);
      // Warm and bright at the bottom, violet and dim toward the head.
      const g = gain * (1 - t * 0.72);
      b.box(px, by, pz, sx, top / bands - 0.02, sz, 0, {
        color: tint, mr: [0.88, 0.05],
        emissive: [
          (warm.r * (1 - t) + tint.r * t * 6) * g,
          (warm.g * (1 - t) * 0.66 + tint.g * t * 6) * g,
          (warm.b * (1 - t) * 0.4 + tint.b * t * 7) * g,
        ],
      });
    }
  };

  const glazedWall = (cx2: number, cz2: number, alongX: boolean, len: number, cut: boolean): void => {
    const half = len / 2;
    const base = alongX ? s.cx : s.cz;
    const pitch = 1.75;
    const n = Math.max(2, Math.round(len / pitch));
    for (let i = 0; i < n; i++) {
      const a = base - half + (i * len) / n;
      const c = base - half + ((i + 1) * len) / n;
      // Skip the bay the door is in — the reveal is drawn separately.
      if (cut) {
        const d0 = (alongX ? s.cx : s.cz) + door.offset - door.width / 2;
        const d1 = (alongX ? s.cx : s.cz) + door.offset + door.width / 2;
        if (c > d0 && a < d1) continue;
      }
      glassPanel(cx2, cz2, alongX, a, c);
    }
    // Mullions, transom and head — the frame is what the eye reads.
    for (let i = 0; i <= n; i++) {
      const a = base - half + (i * len) / n;
      const px = alongX ? a : cx2;
      const pz = alongX ? cz2 : a;
      b.box(px, y0 + h / 2, pz, alongX ? 0.11 : T + 0.02, h, alongX ? T + 0.02 : 0.11, 0,
        { color: lin(f.frame ?? 0x9aa2ab), mr: [0.8, 0.3] });
    }
    for (const ty of [y0 + 1.1, y0 + h - 0.08]) {
      b.box(
        alongX ? base : cx2, ty, alongX ? cz2 : base,
        alongX ? len : T + 0.02, 0.1, alongX ? T + 0.02 : len,
        0, { color: lin(f.frame ?? 0x9aa2ab), mr: [0.8, 0.3] },
      );
    }
  };

  const wallAlongX = (z: number, cut: boolean): void => {
    if (glazed.includes(z > s.cz ? 'north' : 'south')) {
      glazedWall(0, z, true, hx * 2, cut);
      return;
    }
    if (!cut) {
      b.box(s.cx, y0 + h / 2, z, hx * 2, h, T, 0, wallMat);
      b.box(s.cx, y0 + 0.09, z + (z > s.cz ? -0.06 : 0.06), hx * 2, 0.18, T, 0, skirt);
      return;
    }
    for (const [a, c] of splitWall(hx * 2, door)) {
      b.box(s.cx + (a + c) / 2, y0 + h / 2, z, c - a, h, T, 0, wallMat);
    }
    // Lintel over the opening.
    const lin0 = y0 + door.height;
    if (y1 - lin0 > 0.05) {
      b.box(s.cx + door.offset, (lin0 + y1) / 2, z, door.width, y1 - lin0, T, 0, wallMat);
    }
  };
  const wallAlongZ = (x: number, cut: boolean): void => {
    if (glazed.includes(x > s.cx ? 'east' : 'west')) {
      glazedWall(x, 0, false, hz * 2, cut);
      return;
    }
    if (!cut) {
      b.box(x, y0 + h / 2, s.cz, T, h, hz * 2, 0, wallMat);
      b.box(x + (x > s.cx ? -0.06 : 0.06), y0 + 0.09, s.cz, T, 0.18, hz * 2, 0, skirt);
      return;
    }
    for (const [a, c] of splitWall(hz * 2, door)) {
      b.box(x, y0 + h / 2, s.cz + (a + c) / 2, T, h, c - a, 0, wallMat);
    }
    const lin0 = y0 + door.height;
    if (y1 - lin0 > 0.05) {
      b.box(x, (lin0 + y1) / 2, s.cz + door.offset, T, y1 - lin0, door.width, 0, wallMat);
    }
  };

  wallAlongX(s.cz + hz, door.side === 'north');
  wallAlongX(s.cz - hz, door.side === 'south');
  wallAlongZ(s.cx + hx, door.side === 'east');
  wallAlongZ(s.cx - hx, door.side === 'west');

  // The reveal is normally drawn ONCE, into the city's permanent geometry, so
  // the door still reads when the fitout is streamed out. See `openDoorway` in
  // src/world/city/landmarks.ts.
  if (opts.reveal) drawDoorReveal(b, s, f);
}

/**
 * The reveal, threshold, frame and door leaves.
 *
 * The reveal matters more than it sounds: without it the doorway is a hole in
 * a 14 cm sheet and you can see the wall has no thickness the moment you stand
 * in it. This lines the full `wallT` of the opening.
 */
export function drawDoorReveal(b: DetailBuilder, s: ShellSpec, f: RoomFinish): void {
  const door = s.door;
  const n = doorNormal(door);
  const c = doorCentre(s);
  const frame = { color: lin(f.frame ?? 0x9aa2ab), mr: [0.72, 0.36] as [number, number] };
  const glass = {
    color: lin(0x11182b),
    mr: [0.82, 0.1] as [number, number],
    emissive: [0.012, 0.014, 0.03],
  };
  const alongX = n.x === 0;
  const t = s.wallT;
  const y0 = s.floorY;
  const hw = door.width / 2;

  // Jambs: line the two sides of the opening through the full wall thickness.
  for (const sgn of [-1, 1]) {
    const jx = alongX ? c.x + sgn * hw : c.x - n.x * t / 2;
    const jz = alongX ? c.z - n.z * t / 2 : c.z + sgn * hw;
    b.box(
      jx, y0 + door.height / 2, jz,
      alongX ? 0.12 : t, door.height, alongX ? t : 0.12,
      0, frame,
    );
  }
  // Head.
  b.box(
    alongX ? c.x : c.x - n.x * t / 2,
    y0 + door.height + 0.09,
    alongX ? c.z - n.z * t / 2 : c.z,
    alongX ? door.width : t, 0.18, alongX ? t : door.width,
    0, frame,
  );
  // Threshold plate.
  b.box(
    alongX ? c.x : c.x - n.x * t / 2,
    y0 + 0.015,
    alongX ? c.z - n.z * t / 2 : c.z,
    alongX ? door.width : t, 0.05, alongX ? t : door.width,
    0, frame,
  );
  // Central post, when there is one — this is the piece that keeps the car out.
  if (door.mullion > 0.01) {
    b.box(
      alongX ? c.x : c.x - n.x * t / 2,
      y0 + door.height / 2,
      alongX ? c.z - n.z * t / 2 : c.z,
      alongX ? door.mullion : t, door.height, alongX ? t : door.mullion,
      0, frame,
    );
    // Two glazed leaves, standing open against the jambs.
    const leaf = leafWidth(door) * 0.92;
    for (const sgn of [-1, 1]) {
      const off = sgn * (door.mullion / 2 + leafWidth(door) - leaf / 2);
      const lx = alongX ? c.x + off : c.x - n.x * (t / 2 + 0.42);
      const lz = alongX ? c.z - n.z * (t / 2 + 0.42) : c.z + off;
      b.box(
        lx, y0 + door.height / 2 - 0.06, lz,
        alongX ? 0.1 : leaf, door.height - 0.14, alongX ? leaf : 0.1,
        0, glass,
      );
    }
  }
}

/**
 * A pool of light lying on the floor. Cheap, and it is what makes a fitting
 * read as a fitting when the real point light lands on somebody else.
 */
export function lightPool(
  b: DetailBuilder,
  x: number, y: number, z: number,
  r: number, color: number, gain: number,
): void {
  const col = lin(color);
  b.box(x, y + 0.004, z, r * 2, 0.008, r * 2, 0, {
    color: col, mr: [0, 0.9], emissive: [col.r * gain, col.g * gain, col.b * gain],
  });
}

/** Scatter helper used by several fitouts — deterministic, seeded. */
export function jitter(rng: Rng, amount: number): number {
  return rng.range(-amount, amount);
}
