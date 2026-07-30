/**
 * WHERE THE ENTERABLE ROOMS ARE.
 *
 * One table, in world metres, shared by everything that has to agree about an
 * interior:
 *
 *   src/world/city/landmarks.ts  builds the shell, its colliders and its floor
 *   src/world/interiors/*        builds the fitout and the lights
 *   src/world/interiors/*.test   asserts the doorways stay pedestrian-only
 *
 * Placement rules these obey, so that the city keeps working around them:
 *   — every footprint sits INSIDE a block's building line (see `blockBounds`
 *     in city/roads.ts), never over a carriageway or a footway;
 *   — every footprint is covered by an entry in `LANDMARK_VOIDS` with a
 *     margin, so the generic block grammar does not grow a tower through it;
 *   — every door faces a street, a plaza or the forecourt the player arrives
 *     from, and none of them is wide enough for a car.
 *
 * OWNER: interiors agent.
 */

import { DOORWAY, LOBBY, TOWER, TOWER_SOUTH_Z } from '../../content/places';
import type { ShellSpec } from './shell';

/* ------------------------------------------------------------------ */
/* Builders House — the story's own front door                         */
/* ------------------------------------------------------------------ */

/**
 * The lobby of Builders House, inside the existing 30 x 24 x 82 tower.
 *
 * `DOORWAY.width` is 3.4 m, which is a car-sized hole; the 0.5 m central post
 * is what makes it two 1.45 m leaves and honours "the exterior shell blocks
 * the player and the Dacia; one pedestrian doorway the car cannot cross".
 */
export const BUILDERS_LOBBY: ShellSpec = {
  id: 'buildersLobby',
  name: 'Holul Casei Constructorilor',
  cx: TOWER.cx,
  cz: TOWER.cz,
  w: TOWER.w,
  d: TOWER.d,
  wallT: 1.0,
  massH: TOWER.h,
  floorY: LOBBY.floorY,
  ceilingY: LOBBY.ceilingY,
  door: {
    side: 'south',
    offset: DOORWAY.x - TOWER.cx,
    width: DOORWAY.width,
    height: DOORWAY.height,
    mullion: 0.5,
  },
  streamRadius: 78,
};

/** Kept as a named export so the shell and the story cannot drift apart. */
export const BUILDERS_DOOR_Z = TOWER_SOUTH_Z;

/* ------------------------------------------------------------------ */
/* The Recorder — Piața Victoriei                                      */
/* ------------------------------------------------------------------ */

/**
 * Alex Need-Aid's newsroom, in the block on the north-east side of Piața
 * Victoriei, one street back from where he waits with the evidence drive
 * (`PLACES.recorderDrop`, 276 / -340). Door on the west elevation, facing the
 * square, so the walk from the drop is a straight line.
 */
export const RECORDER: ShellSpec = {
  id: 'recorderNewsroom',
  name: 'Redacția Recorder',
  cx: 320,
  cz: -338,
  w: 22,
  d: 16,
  wallT: 0.7,
  massH: 13.6,
  floorY: 0.22,
  ceilingY: 3.9,
  door: { side: 'west', offset: 0, width: 2.6, height: 2.5, mullion: 0.36 },
  streamRadius: 70,
  fill: 1.0,
};

/* ------------------------------------------------------------------ */
/* The broadcast complex — Piața Transmisiunii                         */
/* ------------------------------------------------------------------ */

/**
 * Act III's hijack.
 *
 * The mission interacts at `PLACES.broadcastSite` (460 / 184), which the hint
 * calls "la bază" — the foot of the mast. The mast now exists, standing on the
 * square with its centre bay left clear so the trigger is reachable; the studio
 * it feeds is this building, in the block to the south-west, entered from the
 * square through a glazed lobby door.
 */
export const STUDIO: ShellSpec = {
  id: 'broadcastStudio',
  name: 'Studioul de Transmisiune',
  cx: 422,
  cz: 155,
  w: 46,
  d: 30,
  wallT: 0.9,
  massH: 15.5,
  floorY: 0.22,
  ceilingY: 8.6,
  door: { side: 'north', offset: 16, width: 2.8, height: 2.6, mullion: 0.4 },
  streamRadius: 88,
  fill: 3.2,
};

/** The mast on the square. The trigger point stands between its legs. */
export const BROADCAST_MAST = { x: 460, z: 184, height: 74, spread: 5.2 } as const;

/* ------------------------------------------------------------------ */
/* Ambient interiors — the terrace opposite Builders House             */
/* ------------------------------------------------------------------ */

/*
 * All three sit on the north frontage of the block directly across the grand
 * axis from Builders House, on a 9.5 m footway the player crosses in the first
 * minute of the game. An enterable shop you can see from the spawn point is
 * worth more than six of them scattered across a 2.4 km city.
 */

export const CORNER_SHOP: ShellSpec = {
  id: 'cornerShop',
  name: 'Magazin Non-Stop',
  cx: -54,
  cz: -36.5,
  w: 15,
  d: 12,
  wallT: 0.55,
  massH: 16.5,
  floorY: 0.2,
  ceilingY: 3.3,
  door: { side: 'north', offset: 4.4, width: 1.35, height: 2.25, mullion: 0 },
  streamRadius: 44,
  fill: 1.5,
};

export const BAR: ShellSpec = {
  id: 'buildersBar',
  name: 'Barul Constructorilor',
  cx: -34,
  cz: -36.5,
  w: 16,
  d: 12,
  wallT: 0.55,
  massH: 16.5,
  floorY: 0.2,
  ceilingY: 3.4,
  door: { side: 'north', offset: -4.6, width: 1.3, height: 2.25, mullion: 0 },
  streamRadius: 44,
  fill: 1.1,
};

export const BLOCK_HALL: ShellSpec = {
  id: 'blockHall',
  name: 'Scara Blocului 12',
  cx: -19,
  cz: -36.5,
  w: 12,
  d: 12,
  wallT: 0.5,
  massH: 25,
  floorY: 0.2,
  ceilingY: 2.85,
  door: { side: 'north', offset: 0, width: 1.25, height: 2.2, mullion: 0 },
  streamRadius: 40,
  fill: 1.4,
};

/** Every enterable room in the game, in build order. */
export const INTERIORS: ShellSpec[] = [
  BUILDERS_LOBBY,
  RECORDER,
  STUDIO,
  CORNER_SHOP,
  BAR,
  BLOCK_HALL,
];

export const INTERIOR_BY_ID: ReadonlyMap<string, ShellSpec> = new Map(
  INTERIORS.map((s) => [s.id, s]),
);

/* ------------------------------------------------------------------ */
/* Furniture you cannot walk through                                   */
/* ------------------------------------------------------------------ */

/**
 * A solid piece of furniture, positioned relative to the room.
 *
 * `ax`/`az` are fractions of the room's inner half-extent (so a counter
 * against the back wall stays against it if the room resizes); `dx`/`dz` are
 * metres added on top. Height is measured up from the interior floor.
 */
export interface Blocker {
  ax?: number;
  az?: number;
  dx?: number;
  dz?: number;
  hx: number;
  hz: number;
  h: number;
}

/**
 * Only the big pieces. A chair you can walk through is invisible; a chair that
 * wedges the player into a corner of a 12 m room is a bug report.
 */
export const BLOCKERS: Record<string, Blocker[]> = {
  buildersLobby: [
    // Reception counter — the finale interaction happens across it.
    { dx: 0, dz: 3.6, hx: 2.7, hz: 0.48, h: 1.15 },
    { dx: -7.6, dz: -4.4, hx: 0.38, hz: 0.38, h: 8.9 },
    { dx: 7.6, dz: -4.4, hx: 0.38, hz: 0.38, h: 8.9 },
    { dx: -7.6, dz: 4.4, hx: 0.38, hz: 0.38, h: 8.9 },
    { dx: 7.6, dz: 4.4, hx: 0.38, hz: 0.38, h: 8.9 },
    // The stair to the mezzanine, which is dressing rather than a route.
    { dx: 11.8, dz: -0.9, hx: 0.9, hz: 2.2, h: 1.3 },
  ],
  recorderNewsroom: [
    { dx: -7.1, dz: 2.4, hx: 1.45, hz: 0.48, h: 1.15 },
    { dx: 1.0, dz: 3.6, hx: 2.2, hz: 1.35, h: 0.8 },
    { dx: 1.0, dz: -3.6, hx: 2.2, hz: 1.35, h: 0.8 },
    { dx: 7.0, dz: 3.6, hx: 2.2, hz: 1.35, h: 0.8 },
    { dx: 7.0, dz: -3.6, hx: 2.2, hz: 1.35, h: 0.8 },
    { dx: 6.3, dz: -4.3, hx: 1.25, hz: 0.5, h: 0.85 },
    { dx: -4.5, dz: -6.1, hx: 1.55, hz: 0.36, h: 0.95 },
  ],
  broadcastStudio: [
    // Control gallery platform.
    { dx: 9.75, dz: -10.8, hx: 11.75, hz: 3.1, h: 1.25 },
    // Set riser and the address desk on it.
    { dx: -14.6, dz: 1.0, hx: 4.0, hz: 3.5, h: 0.22 },
    { dx: -14.6, dz: 1.0, hx: 1.95, hz: 0.7, h: 1.0 },
    // The takeover console.
    { dx: 2.0, dz: -6.3, hx: 0.82, hz: 0.48, h: 1.08 },
    // Cyclorama cove.
    { dx: -20.7, dz: 0, hx: 0.85, hz: 8.2, h: 0.7 },
  ],
  cornerShop: [
    { dx: -5.05, dz: -0.4, hx: 0.58, hz: 2.15, h: 1.05 },
    { dx: 2.3, dz: -4.95, hx: 2.9, hz: 0.4, h: 2.0 },
    { dx: -1.4, dz: -0.5, hx: 0.5, hz: 1.8, h: 1.75 },
    { dx: 2.0, dz: -0.5, hx: 0.5, hz: 1.8, h: 1.75 },
  ],
  buildersBar: [
    { dx: -0.7, dz: -4.35, hx: 3.9, hz: 0.36, h: 1.1 },
    { dx: -0.7, dz: -4.9, hx: 4.2, hz: 0.3, h: 2.4 },
    { dx: 6.55, dz: -4.05, hx: 0.5, hz: 0.36, h: 1.5 },
  ],
  blockHall: [
    { dx: 3.9, dz: -1.48, hx: 0.85, hz: 1.2, h: 1.5 },
  ],
};

/**
 * True when (x, z) stands on the footprint of an enterable building.
 *
 * Street dressing has to ask: a plaza's own lamp and tree rings are laid out
 * on a radius, and a radius does not know that a television studio is standing
 * on it. Piața Transmisiunii duly planted a plane tree in the middle of the
 * studio floor, foliage, trunk and all.
 */
export function onInteriorFootprint(x: number, z: number, pad = 1.5): boolean {
  for (const s of INTERIORS) {
    if (Math.abs(x - s.cx) < s.w / 2 + pad && Math.abs(z - s.cz) < s.d / 2 + pad) return true;
  }
  return false;
}

/**
 * Ground the generic block grammar must leave alone, as `LANDMARK_VOIDS`
 * rectangles. Generous: `buildBlock` tests a PLOT CENTRE against the void, so
 * a plot centred just outside a tight void still grows through the wall.
 */
export const INTERIOR_VOIDS = [
  // Recorder, inside block (16, 9).
  { x0: 299, z0: -352, x1: 341, z1: -325 },
  // Broadcast studio, inside block (17, 14).
  { x0: 391, z0: 138.6, x1: 451, z1: 171.4 },
  // The terrace opposite Builders House, inside block (12, 12).
  { x0: -64, z0: -50, x1: -11.5, z1: -29.4 },
];
