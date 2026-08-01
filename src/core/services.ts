/**
 * SERVICE CONTRACTS — the seam between subsystems.
 *
 * Each major system registers itself under a ServiceKey. Consumers resolve via
 * `ctx.get(Services.Traffic)` and only ever see the interface, never the
 * implementation. This is what allows the world, vehicle, AI, gameplay and UI
 * systems to be built independently and wired at the end.
 *
 * RULE FOR CONTRIBUTORS: never import a concrete system class across a
 * subsystem boundary. Import the interface from here.
 */

import type { Box3, Object3D, Quaternion, Vector3 } from 'three';
// Type-only, and deliberately circular: `engine.ts` imports `ServiceKey` from
// here. Interfaces that hand a callback the frame context need the context type,
// and `import type` is erased, so nothing circular survives to runtime.
import type { GameContext } from './engine';

/* ------------------------------------------------------------------ */
/* Key plumbing                                                        */
/* ------------------------------------------------------------------ */

export interface ServiceKey<T> {
  readonly id: string;
  /** Phantom type carrier — never read at runtime. */
  readonly __t?: T;
}

const key = <T>(id: string): ServiceKey<T> => ({ id });

/* ------------------------------------------------------------------ */
/* Shared value types                                                  */
/* ------------------------------------------------------------------ */

export type Faction = 'civilian' | 'police' | 'ministry' | 'builder' | 'player';

export interface Damageable {
  readonly health: number;
  readonly maxHealth: number;
  applyDamage(amount: number, source?: Faction, point?: Vector3): void;
}

export interface SpatialQuery {
  /** Nearest navigable road point to `p`, written into `out`. */
  snapToRoad(p: Vector3, out: Vector3): boolean;
  /** Ground height at (x, z); returns -Infinity when outside the world. */
  groundHeight(x: number, z: number): number;
  /** True when (x, z) is inside a building or blocked volume. */
  isBlocked(x: number, z: number): boolean;
}

/* ------------------------------------------------------------------ */
/* World / city                                                        */
/* ------------------------------------------------------------------ */

export type DistrictKind =
  | 'centruVechi'      // old town: narrow streets, terraces, neon
  | 'bulevard'         // wide communist boulevards, blocks of flats
  | 'glassCorporate'   // the reference frame: glass towers, plazas
  | 'guvern'           // government quarter, Palace of Parliament axis
  | 'cartier'          // residential panel blocks
  | 'industrial'       // depots, warehouses, cranes
  | 'parc';            // Cișmigiu-like green

export interface RoadNode {
  id: number;
  position: Vector3;
  links: number[];
  /** Lanes per direction. */
  lanes: number;
  isIntersection: boolean;
  hasTrafficLight: boolean;
}

export interface Landmark {
  id: string;
  name: string;
  position: Vector3;
  radius: number;
  /** Interior trigger volume, if enterable. */
  interior?: Box3;
}

/**
 * ONE BUILDING FOOTPRINT — the ground rectangle a mass stands on.
 *
 * The city already hashes every placed building for its `isBlocked` query;
 * this is that same table, read-only, in the terms a map needs. Without it a
 * city map can only draw streets over a district wash, which is why the map
 * read as flat: a real GTA map is mostly BLOCKS, and the streets are the gaps
 * between them.
 */
export interface Footprint {
  /** Centre. */
  x: number;
  z: number;
  /** Half-extents along the footprint's OWN axes (not world-axis-aligned). */
  hx: number;
  hz: number;
  /** Rotation about Y, radians. 0 for the grid-aligned plots. */
  rot: number;
  /** Metres above ground — lets a map shade tall masses differently. */
  height: number;
}

export interface CityService {
  readonly roadNodes: ReadonlyArray<RoadNode>;
  /**
   * Centre lines of permanent way that the city actually rendered. Traffic
   * may map trams to these corridors; road rank alone is never rail metadata.
   */
  readonly tramLines: ReadonlyArray<ReadonlyArray<Vector3>>;
  readonly landmarks: ReadonlyMap<string, Landmark>;
  districtAt(x: number, z: number): DistrictKind;
  /** Uniformly random point on a road, for spawning. */
  randomRoadPoint(out: Vector3): void;
  /** Nearest road node id to a world position. */
  nearestNode(p: Vector3): number;
  /** A* over the road graph. Returns node ids, empty when unreachable. */
  findPath(fromNode: number, toNode: number): number[];
  /**
   * Building footprints overlapping the world AABB, written into `out`, which
   * is grown and REUSED — entries past the return value are stale, so read
   * exactly `n` of them. Returns how many are live.
   *
   * Backed by the same coarse hash `spatial.isBlocked` walks, so a screen-sized
   * window is cheap and the whole city is linear in buildings. Meant for a map
   * repaint or a bake, NOT for a per-frame call.
   */
  blocksIn(x0: number, z0: number, x1: number, z1: number, out: Footprint[]): number;
  readonly spatial: SpatialQuery;
}

export interface StreamingService {
  /** Called each frame with the camera focus; loads/unloads chunks. */
  focus(p: Vector3): void;
  readonly loadedChunks: number;
  readonly pendingChunks: number;
}

/* ------------------------------------------------------------------ */
/* Vehicles                                                            */
/* ------------------------------------------------------------------ */

export type VehicleClass = 'dacia' | 'sedan' | 'hatch' | 'van' | 'truck' | 'bus' | 'police' | 'tram' | 'scooter';

export interface VehicleHandle extends Damageable {
  readonly id: string;
  readonly kind: VehicleClass;
  readonly object: Object3D;
  readonly position: Vector3;
  readonly rotation: Quaternion;
  /** Metres per second along the forward axis (signed). */
  readonly speed: number;
  readonly seats: number;
  readonly occupants: ReadonlyArray<string>;
  /** -1..1 */
  setControls(throttle: number, steer: number, handbrake: boolean): void;
  teleport(position: Vector3, headingRad: number): void;
  /** Flip upright and nudge back onto the road. */
  recover(): void;
  readonly isWrecked: boolean;
}

export interface VehicleService {
  spawn(kind: VehicleClass, position: Vector3, headingRad: number, opts?: { colorSeed?: number; faction?: Faction }): VehicleHandle;
  despawn(id: string): void;
  get(id: string): VehicleHandle | undefined;
  readonly all: ReadonlyArray<VehicleHandle>;
  /** Nearest vehicle within `radius` that has a free seat. */
  nearestEnterable(p: Vector3, radius: number): VehicleHandle | undefined;
}

export interface TrafficService {
  /** Ambient traffic density multiplier, 0..2. */
  density: number;
  readonly activeCount: number;
  /** Make all AI traffic yield/scatter — used during chases. */
  panic(centre: Vector3, radius: number, seconds: number): void;
}

/* ------------------------------------------------------------------ */
/* Characters / peds                                                   */
/* ------------------------------------------------------------------ */

export type PedArchetype =
  | 'civilian' | 'builder' | 'officeWorker' | 'protester'
  | 'police' | 'ministryAgent' | 'streetVendor' | 'tourist';

export type LocomotionState = 'idle' | 'walk' | 'jog' | 'sprint' | 'crouchIdle' | 'crouchWalk' | 'jump' | 'fall' | 'land' | 'sit' | 'drive' | 'ragdoll' | 'stagger' | 'punch' | 'die';

export interface CharacterHandle extends Damageable {
  readonly id: string;
  readonly archetype: PedArchetype;
  readonly object: Object3D;
  readonly position: Vector3;
  readonly faction: Faction;
  readonly state: LocomotionState;
  readonly isAlive: boolean;
  /** Move toward a world point this frame; the controller handles animation. */
  moveTo(target: Vector3, speed: number): void;
  lookAt(target: Vector3): void;
  playState(s: LocomotionState): void;
  ragdoll(impulse?: Vector3): void;
}

/** Observable result of one short-range player strike against the crowd. */
export interface PedMeleeHit {
  readonly targetId: string;
  /** Stable snapshot; callers may retain it for feedback and crime reporting. */
  readonly position: Vector3;
  readonly faction: Faction;
  /** Health actually removed, capped by what the target had left. */
  readonly damage: number;
  readonly fatal: boolean;
}

export interface PedService {
  spawn(archetype: PedArchetype, position: Vector3, headingRad: number): CharacterHandle;
  despawn(id: string): void;
  get(id: string): CharacterHandle | undefined;
  readonly all: ReadonlyArray<CharacterHandle>;
  /** Ambient crowd density multiplier, 0..2. */
  density: number;
  /** Peds flee from a point (gunshot, crash, siren). */
  scatter(centre: Vector3, radius: number): void;
  /** Damage at most one living pedestrian in a short, body-facing melee arc. */
  meleeStrike(origin: Vector3, forward: Vector3, damage: number): PedMeleeHit | null;
}

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

export interface PlayerService extends Damageable {
  readonly character: CharacterHandle;
  readonly position: Vector3;
  readonly inVehicle: VehicleHandle | null;
  readonly isOnFoot: boolean;
  enterVehicle(v: VehicleHandle): void;
  exitVehicle(): void;
  teleport(p: Vector3, headingRad?: number): void;
  respawn(): void;
  /** Money, in lei. */
  readonly lei: number;
  addLei(delta: number, reason: string): void;
}

export interface CameraService {
  readonly mode: 'thirdPerson' | 'vehicle' | 'aim' | 'cinematic' | 'photo';
  setMode(m: CameraService['mode']): void;
  /** Punch the camera for impacts. */
  shake(intensity: number, seconds: number): void;
  /** Temporarily frame a world point (cutscene beats). */
  focusOn(p: Vector3, seconds: number): void;
}

/* ------------------------------------------------------------------ */
/* Police / Political Instability                                      */
/* ------------------------------------------------------------------ */

/**
 * The Ministry's own belief about where you are, published by the pursuit
 * system once a tick. Every field is a fact `src/ai/police.ts` already has and
 * nobody else can compute: line of sight is resolved against real colliders,
 * and the cordon widens from the last sighting by how far you could have got.
 */
export interface SearchReport {
  /** Units actively pursuing. */
  pursuers: number;
  /** Where they believe you are. Null when nobody is looking. */
  lastKnown: Vector3 | null;
  /** Metres — how wide the cordon around `lastKnown` is right now. 0 when idle. */
  radius: number;
  /** True while a unit genuinely has eyes on you. */
  contact: boolean;
}

export interface WantedService {
  /** 0..5 "Crisis Stars". */
  readonly stars: number;
  /** Add heat; crosses star thresholds internally. */
  addHeat(amount: number, at?: Vector3): void;
  setStars(n: number): void;
  clear(): void;
  /** Seconds until heat begins to decay while hidden. */
  readonly cooldownRemaining: number;
  readonly pursuerCount: number;
  /**
   * Where the Ministry believes you are — the pursuit system's last sighting,
   * dead-reckoned for a moment after it loses you. Null when nobody is looking.
   * Live vector owned by this service: read it, never retain or mutate it.
   */
  readonly lastKnown: Vector3 | null;
  /** Metres. Radius of the search around `lastKnown`; 0 when nobody is looking. */
  readonly searchRadius: number;
  /** True while a Ministry unit actually has eyes on you, not merely near you. */
  readonly inContact: boolean;
  /**
   * PURSUIT SYSTEM ONLY. `src/ai/police.ts` owns pursuit and sight; the star
   * machine owns heat and decay. This is how the first tells the second what it
   * knows, and it replaces the reflective write into a private `_pursuers`
   * field that stood in for it while the contract was setter-less.
   */
  reportSearch(r: SearchReport): void;
}

/* ------------------------------------------------------------------ */
/* Missions / activities / progression                                 */
/* ------------------------------------------------------------------ */

/** An act you can walk up to and start right now. */
export interface MissionOffer {
  id: string;
  title: string;
  /** Where the mission-giver marker stands, on the ground. */
  position: Vector3;
}

export interface MissionService {
  readonly currentId: string | null;
  readonly currentTitle: string;
  start(id: string): void;
  abandon(): void;
  readonly completed: ReadonlySet<string>;
  /**
   * The acts on offer, with the world position of their giver — so a map can
   * show "go here to start Act II" and not only the current objective. Empty
   * while an act is running and once the campaign is finished. Positions are
   * live vectors owned by the mission system; read, do not retain.
   */
  readonly offered: ReadonlyArray<MissionOffer>;
  /**
   * Put the campaign back where a save left it. `completed` replaces the whole
   * set (it is authoritative, not additive) and `currentId` re-enters that act
   * from its first objective — a mid-objective resume would need the objective
   * index and every world side effect it had already applied, which no save
   * format can honestly promise. Pass `null` to land in free roam with the next
   * act on offer.
   */
  restore(completed: readonly string[], currentId: string | null): void;
}

export interface ActivityService {
  /** Registered side activities in the world. */
  readonly available: ReadonlyArray<{ id: string; kind: string; position: Vector3; name: string }>;
  readonly activeId: string | null;
  start(id: string): void;
  abandon(): void;
}

export interface ProgressionService {
  readonly level: number;
  readonly xp: number;
  readonly unlocks: ReadonlySet<string>;
  /** Landmark ids the player has already been paid for finding. */
  readonly discovered: ReadonlySet<string>;
  addXp(amount: number, reason: string): void;
  has(unlock: string): boolean;
  /**
   * Set the whole curve at once, silently — a load is not a level-up, so this
   * must not fire `progression:levelUp` or throw five banners on screen. Level
   * and unlocks are recomputed from `xp` when they are not supplied.
   */
  restore(state: {
    xp: number;
    level?: number;
    unlocks?: readonly string[];
    discovered?: readonly string[];
  }): void;
}

/* ------------------------------------------------------------------ */
/* Interaction — world-space "press E" targets                         */
/* ------------------------------------------------------------------ */

export type InteractableKind = 'story' | 'activity' | 'world';

export interface InteractableSpec {
  id: string;
  /** Romanian, imperative: "Vorbește cu Nicușor". */
  label: string;
  position: Vector3;
  /** How close you must be. Default 3.4 m. */
  radius?: number;
  kind?: InteractableKind;
  /** Must be out of the car. Default true. */
  onFoot?: boolean;
  /** Must be *driving*. Default false. */
  inVehicle?: boolean;
  /** Minimum cosine between camera forward and the direction to the marker. */
  facing?: number;
  /** Trace the eye line and refuse when a wall is in the way. Default true. */
  requireLos?: boolean;
  /** Fire on entry instead of waiting for E. */
  auto?: boolean;
  /** No marker geometry, no prompt — a silent trigger volume. */
  silent?: boolean;
  /** Marker tint. Defaults by kind. */
  color?: number;
  onTrigger: (ctx: GameContext) => void;
}

/**
 * ONE registry of interactables for the whole game. There must be exactly one:
 * two would fight over the same `interact` press. That is why it is a service
 * and not a module singleton.
 */
export interface InteractionService {
  add(spec: InteractableSpec): void;
  remove(id: string): void;
  /** Drop every interactable whose id starts with `prefix`. */
  removeByPrefix(prefix: string): void;
  has(id: string): boolean;
  setEnabled(id: string, on: boolean): void;
  moveTo(id: string, p: Vector3): void;
  /** Fire one directly — the debug harness and the tests use this. */
  trigger(id: string): boolean;
  readonly count: number;
  ids(): string[];
  /** The label the player would see right now, or '' for none. */
  readonly focusLabel: string;
  readonly focusId: string;
}

/* ------------------------------------------------------------------ */
/* Story cast                                                          */
/* ------------------------------------------------------------------ */

export type CastRole = 'nicusor' | 'ally' | 'builder';

export interface CastMemberSpec {
  id: string;
  name: string;
  role: CastRole;
  x: number;
  z: number;
  /** Facing, radians. */
  yaw: number;
  /** Dance at the afterparty. */
  parties?: boolean;
}

export interface CastService {
  add(spec: CastMemberSpec): void;
  moveTo(id: string, x: number, z: number, yaw?: number): void;
  /** Start (or stop) the afterparty. */
  setParty(on: boolean): void;
  readonly all: ReadonlyArray<{ id: string; name: string; x: number; z: number; built: boolean }>;
}

/* ------------------------------------------------------------------ */
/* Builders House — Act IV's interior                                  */
/* ------------------------------------------------------------------ */

/** Whether a player can actually walk through the lobby door. */
export interface DoorwayReport {
  /** The shell is open — built that way, or opened at runtime. */
  carved: boolean;
  /** A capsule-sized path really exists from the forecourt to the reception.
   *  This is the one that decides whether Act IV can be finished. */
  passable: boolean;
  reason: string;
  /** Replacement colliders the runtime fallback had to install. 0 is good. */
  added: number;
}

export interface BuildersHouseService {
  /** Lights up, tricolour on — Act IV's payoff. */
  liberate(): void;
  readonly liberated: boolean;
  readonly doorway: DoorwayReport;
}

/* ------------------------------------------------------------------ */
/* Interiors                                                           */
/*                                                                     */
/* Promoted here at the interiors owner's request (the note in         */
/* src/world/interiors/interiorSystem.ts). The id is unchanged, so     */
/* their `InteriorsServiceKey` and `Services.Interiors` are the same   */
/* registration — nothing has to be migrated in one go.                */
/* ------------------------------------------------------------------ */

export interface InteriorsService {
  /** Act IV: lights, tricolour, the room the afterparty happens in. */
  liberate(): void;
  /** Act III: every screen in the studio flips to the builders' broadcast. */
  hijack(): void;
  /** True when (x, z) is inside a named interior's clear volume. */
  isInside(id: string, x: number, z: number): boolean;
  /** Which interior the point is in, or null. */
  interiorAt(x: number, z: number): string | null;
  /** A standing spot just inside a doorway. */
  doorwayInside(id: string): { x: number; y: number; z: number } | null;
  readonly liberated: boolean;
  readonly hijacked: boolean;
}

/* ------------------------------------------------------------------ */
/* Saves                                                               */
/* ------------------------------------------------------------------ */

/** Everything a reload has to put back. Plain JSON — no class instances. */
export interface SaveRecord {
  /** Campaign act in progress, or null when only free-roaming. */
  actId: string | null;
  actTitle: string;
  /** Acts already finished. */
  completed: string[];
  level: number;
  xp: number;
  unlocks: string[];
  /** Landmark ids already discovered. */
  discovered: string[];
  lei: number;
  /** World position, or null when there was no player yet. */
  pos: [number, number, number] | null;
  /** Facing, radians. */
  heading: number;
  /** Hours 0..24. */
  timeOfDay: number;
  weather: string;
  /** Wall-clock ms when the record was written. */
  savedAt: number;
  /** Seconds of play accumulated across the sessions in this slot. */
  playSeconds: number;
}

export interface SaveService {
  /** Read the live world into a record without writing it anywhere. */
  capture(): SaveRecord;
  /** Capture and commit to storage. Returns what was written. */
  save(reason?: string): SaveRecord;
  /** The record in storage, or null when there is none / it is corrupt. */
  peek(): SaveRecord | null;
  /** Put a record back into the live world. */
  restore(r: SaveRecord): void;
  /** Load from storage and restore in one step. False when there was nothing. */
  resume(): boolean;
  /** Forget the slot — NEW GAME. */
  clear(): void;
  /** Seconds of play in this slot, including previous sessions. */
  readonly playSeconds: number;
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

export interface HudService {
  setVisible(v: boolean): void;
  /** Whether the HUD is on screen. The map mirrors it, so it has to be askable. */
  readonly visible: boolean;
  toast(text: string, kind?: 'info' | 'good' | 'bad', ms?: number): void;
  subtitle(speaker: string, text: string, ms?: number): void;
  missionCard(title: string, subtitle: string): void;
  setWaypoint(p: Vector3 | null): void;
  /**
   * The live waypoint, or null. The campaign, side activities and the player's
   * own map pin all write through `setWaypoint`; this is the single place to
   * read what they agreed on. Live vector owned by the HUD: read, do not
   * retain or mutate — call `setWaypoint` to change it.
   */
  readonly waypoint: Vector3 | null;
}

export interface AudioService {
  readonly ready: boolean;
  unlock(): Promise<void>;
  oneShot(id: string, position?: Vector3, volume?: number): void;
  /** Continuous engine note bound to a vehicle. */
  bindEngine(vehicleId: string, obj: Object3D): void;
  unbindEngine(vehicleId: string): void;
  setMusic(track: string | null, fadeSeconds?: number): void;
  setListener(obj: Object3D): void;
  masterVolume: number;
}

export type WeatherPreset = 'clearSunset' | 'rain' | 'stormRain' | 'fogDusk' | 'overcast' | 'night';

export interface WeatherService {
  readonly preset: WeatherPreset;
  set(p: WeatherPreset, transitionSeconds?: number): void;
  /** 0..1 — how wet surfaces currently are. Drives road reflectivity. */
  readonly wetness: number;
  /** 0..1 rain particle intensity. */
  readonly rainIntensity: number;
  /** Hours 0..24. */
  timeOfDay: number;
  /** Real seconds per in-game hour; 0 freezes the clock. */
  timeScale: number;
}

export interface RenderService {
  /** Rebuild the post chain — call after quality changes. */
  setQuality(q: 'low' | 'medium' | 'high' | 'ultra'): void;
  readonly quality: 'low' | 'medium' | 'high' | 'ultra';
  /** Frames per second, smoothed. */
  readonly fps: number;
  /** Toggle the whole post stack (for debugging). */
  postEnabled: boolean;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const Services = {
  /** The Rapier world wrapper. Registered by PhysicsWorld during init. */
  Physics: key<import('../physics/physics').PhysicsWorld>('physicsWorld'),
  City: key<CityService>('city'),
  Streaming: key<StreamingService>('streaming'),
  Vehicles: key<VehicleService>('vehicles'),
  Traffic: key<TrafficService>('traffic'),
  Peds: key<PedService>('peds'),
  Player: key<PlayerService>('player'),
  Camera: key<CameraService>('camera'),
  Wanted: key<WantedService>('wanted'),
  Missions: key<MissionService>('missions'),
  Activities: key<ActivityService>('activities'),
  Progression: key<ProgressionService>('progression'),
  Interaction: key<InteractionService>('interaction'),
  Cast: key<CastService>('cast'),
  BuildersHouse: key<BuildersHouseService>('buildersHouse'),
  /** Same id as `InteriorsServiceKey` in src/world/interiors — one registration. */
  Interiors: key<InteriorsService>('interiors'),
  Save: key<SaveService>('save'),
  Hud: key<HudService>('hud'),
  Audio: key<AudioService>('audio'),
  Weather: key<WeatherService>('weather'),
  Render: key<RenderService>('render'),
} as const;
