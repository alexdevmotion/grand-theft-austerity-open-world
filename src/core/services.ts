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

export interface CityService {
  readonly roadNodes: ReadonlyArray<RoadNode>;
  readonly landmarks: ReadonlyMap<string, Landmark>;
  districtAt(x: number, z: number): DistrictKind;
  /** Uniformly random point on a road, for spawning. */
  randomRoadPoint(out: Vector3): void;
  /** Nearest road node id to a world position. */
  nearestNode(p: Vector3): number;
  /** A* over the road graph. Returns node ids, empty when unreachable. */
  findPath(fromNode: number, toNode: number): number[];
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

export interface PedService {
  spawn(archetype: PedArchetype, position: Vector3, headingRad: number): CharacterHandle;
  despawn(id: string): void;
  get(id: string): CharacterHandle | undefined;
  readonly all: ReadonlyArray<CharacterHandle>;
  /** Ambient crowd density multiplier, 0..2. */
  density: number;
  /** Peds flee from a point (gunshot, crash, siren). */
  scatter(centre: Vector3, radius: number): void;
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
}

/* ------------------------------------------------------------------ */
/* Missions / activities / progression                                 */
/* ------------------------------------------------------------------ */

export interface MissionService {
  readonly currentId: string | null;
  readonly currentTitle: string;
  start(id: string): void;
  abandon(): void;
  readonly completed: ReadonlySet<string>;
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
  addXp(amount: number, reason: string): void;
  has(unlock: string): boolean;
}

/* ------------------------------------------------------------------ */
/* Presentation                                                        */
/* ------------------------------------------------------------------ */

export interface HudService {
  setVisible(v: boolean): void;
  toast(text: string, kind?: 'info' | 'good' | 'bad', ms?: number): void;
  subtitle(speaker: string, text: string, ms?: number): void;
  missionCard(title: string, subtitle: string): void;
  setWaypoint(p: Vector3 | null): void;
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
  Hud: key<HudService>('hud'),
  Audio: key<AudioService>('audio'),
  Weather: key<WeatherService>('weather'),
  Render: key<RenderService>('render'),
} as const;
