/**
 * WHERE THE STORY HAPPENS.
 *
 * One table of world anchors, shared by the campaign, the cast and the side
 * activities. Everything here is authored in world metres against the city in
 * `src/world/city/districts.ts` — Builders House at (-46, 46), the plazas in
 * `PLAZAS` (src/world/city/landmarks.ts) — so if the city moves, this is the
 * only file that has to follow.
 *
 * Heights are deliberately absent: nothing here should hardcode a Y. Ask
 * `CityService.spatial.groundHeight(x, z)` at spawn time, which already knows
 * about kerbs and raised plaza decks.
 */

export interface Place {
  id: string;
  /** Romanian display name — this is what the player reads. */
  name: string;
  x: number;
  z: number;
  /** Facing, radians, for anything placed here (0 = +Z). */
  yaw?: number;
}

/* ------------------------------------------------------------------ */
/* Builders House                                                      */
/* ------------------------------------------------------------------ */

/** Tower footprint centre. Matches `BUILDERS` in world/city/districts.ts. */
export const BUILDERS_HOUSE = { x: -46, z: 46 } as const;

/** Tower shell, from `buildBuildersHouse`: 30 x 24 x 82. */
export const TOWER = {
  cx: BUILDERS_HOUSE.x,
  cz: BUILDERS_HOUSE.z,
  w: 30,
  d: 24,
  h: 82,
  /** Ground-floor clear height — the lobby storey. */
  groundH: 9.5,
} as const;

/** South face of the tower — the only elevation with a public entrance. */
export const TOWER_SOUTH_Z = TOWER.cz - TOWER.d / 2; // 34

/**
 * The lobby the finale happens in. `buildLobby(hero, -46, 46, 30, 24, 9, 1.4)`
 * builds the geometry; these numbers describe the volume a player can stand in
 * once `carveLobbyDoorway` has opened the shell.
 */
export const LOBBY = {
  cx: TOWER.cx,
  cz: TOWER.cz,
  /** Inner half-extents: footprint/2 minus the 1.4 m glass inset. */
  hx: TOWER.w / 2 - 1.4 - 0.35,
  hz: TOWER.d / 2 - 1.4 - 0.35,
  /** Top of the lobby floor plate (`buildLobby` draws it at y 0.3, 0.2 thick). */
  floorY: 0.4,
  ceilingY: 9.0,
} as const;

/** Pedestrian doorway cut through the south wall, centred on the steps. */
export const DOORWAY = {
  x: TOWER.cx,
  z: TOWER_SOUTH_Z,
  width: 3.4,
  height: 3.2,
} as const;

/** Just outside the doorway, on the top step. */
export const LOBBY_DOOR_OUTSIDE = { x: TOWER.cx, z: TOWER_SOUTH_Z - 3.2 };
/** Just inside, clear of the door reveal. */
export const LOBBY_DOOR_INSIDE = { x: TOWER.cx, z: TOWER_SOUTH_Z + 3.0 };
/** The reception desk — where the house is liberated. */
export const LOBBY_RECEPTION = { x: TOWER.cx, z: TOWER.cz + LOBBY.hz * 0.35 };

/** The barricaded forecourt in front of the tower. */
export const FORECOURT = {
  x0: TOWER.cx - 40, z0: TOWER.cz - 40,
  x1: TOWER.cx + 34, z1: TOWER_SOUTH_Z - 2,
} as const;

/* ------------------------------------------------------------------ */
/* Story places                                                        */
/* ------------------------------------------------------------------ */

export const PLACES = {
  /** Where the builders wait, and where every act is offered. */
  buildersForecourt: { id: 'buildersForecourt', name: 'Casa Constructorilor', x: -46, z: 20, yaw: 0 },
  /** The community server, in the lee of the escape stair. */
  serverRack: { id: 'serverRack', name: 'Serverul comunității', x: -62, z: 24, yaw: 0 },
  /** The Ministry's barricade across the forecourt (`crowdBarrier` at -72/30). */
  barricade: { id: 'barricade', name: 'Baricada Ministerului', x: -72, z: 30, yaw: 0 },
  /**
   * Kerbside slot the Dacia is parked in for Act 1. On the tarmac of the E–W
   * grand axis (centreline z = 0, 42 m wide), clear of the forecourt slab
   * which starts at z = 6.
   */
  daciaSlot: { id: 'daciaSlot', name: 'Dacia', x: -46, z: -8, yaw: Math.PI / 2 },
  /** Piața Victoriei — the Recorder operative's evidence drop. */
  recorderDrop: { id: 'recorderDrop', name: 'Piața Victoriei', x: 276, z: -340, yaw: Math.PI },
  /** Curtea Startup — Nicușor LAN's courtyard. */
  nicusorCourtyard: { id: 'nicusorCourtyard', name: 'Curtea Startup', x: -368, z: -74, yaw: Math.PI },
  /** Piața Transmisiunii — the broadcast mast. */
  broadcastSite: { id: 'broadcastSite', name: 'Piața Transmisiunii', x: 460, z: 184, yaw: 0 },
  /** The park, for activities that want green. */
  cismigiu: { id: 'cismigiu', name: 'Parcul Cișmigiu', x: -460, z: 345, yaw: 0 },
  /** The government axis — Georgescu's own back yard. */
  parliament: { id: 'parliament', name: 'Palatul Parlamentului', x: -92, z: -790, yaw: 0 },
} as const satisfies Record<string, Place>;

export type PlaceId = keyof typeof PLACES;

/** World half-extent, so nothing is ever authored outside the map. */
export const WORLD_HALF = 1196;

export function clampToWorld(v: number): number {
  return Math.max(-WORLD_HALF + 40, Math.min(WORLD_HALF - 40, v));
}
