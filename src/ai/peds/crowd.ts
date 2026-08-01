/**
 * THE CROWD — one pedestrian, and the local steering that keeps a hundred of
 * them from walking through each other, through walls, or into traffic.
 *
 * A ped is always in exactly one MODE:
 *
 *   route     following the pavement graph toward the far end of an edge
 *   waitCross standing at a kerb waiting for a gap in the traffic
 *   anchored  standing somewhere doing something (see behaviours.ts)
 *   flee      running away from a point in a straight-ish line
 *   down      knocked over by a vehicle; ballistic, then still
 *   scripted  another system has taken the wheel via CharacterHandle.moveTo
 */

import * as THREE from 'three';
import type { Rng } from '../../core/rng';
import type {
  CharacterHandle,
  DistrictKind,
  Faction,
  LocomotionState,
  PedArchetype,
  SpatialQuery,
} from '../../core/services';
import { EdgeKind, PavementGraph, type PavEdge } from './navigation';
import { React, pickIdle, type IdleSpec } from './behaviours';
import type { PedAppearance, PoseState, RigSubject } from './rig';

export type PedMode = 'route' | 'waitCross' | 'anchored' | 'flee' | 'down' | 'scripted';

/** A dog on a lead — a small quadruped that trails its owner. */
export interface Dog {
  x: number;
  z: number;
  y: number;
  yaw: number;
  phase: number;
  colour: THREE.Color;
  size: number;
}

export interface VehicleSample {
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  id: string;
}

/** Upright crowd bodies are wider than their torsos once arms are included. */
const PED_MIN_SEPARATION = 0.74;
const PED_PAIR_CANDIDATE_RADIUS_SQ = 2.25;
const DEPENETRATION_PASSES = 6;

/** Uniform grid over the ped population, rebuilt each fixed step. */
export class CrowdGrid {
  private cells = new Map<number, Ped[]>();
  private cell = 3.2;
  private ordered: Ped[] = [];
  private pairA: Ped[] = [];
  private pairB: Ped[] = [];

  rebuild(peds: Ped[]): void {
    this.ordered.length = 0;
    for (const p of peds) {
      if (p.active) this.ordered.push(p);
    }
    // Pool order changes as pedestrians stream in and out. Stable id order
    // keeps both integration and the position solver replay-safe regardless
    // of that array order.
    this.ordered.sort(comparePedId);
    this.fillCells(this.ordered);
  }

  /** Integrate the prepared population, solve it globally, then publish transforms. */
  step(dt: number, env: CrowdEnv): void {
    for (const p of this.ordered) p.update(dt, env);
    this.resolvePrepared(env.spatial, env.playerPos, env.playerInVehicle);
    for (const p of this.ordered) p.syncAfterCrowdStep();
  }

  /** Stable, blocker-aware population solve run after every ped integrates. */
  resolve(
    peds: Ped[],
    spatial: SpatialQuery,
    playerPos: THREE.Vector3 | null,
    playerInVehicle: boolean,
  ): void {
    this.rebuild(peds);
    this.resolvePrepared(spatial, playerPos, playerInVehicle);
  }

  /** Resolve and expose a newly attached population before its caller returns. */
  publish(
    peds: Ped[],
    spatial: SpatialQuery,
    playerPos: THREE.Vector3 | null,
    playerInVehicle: boolean,
  ): void {
    this.resolve(peds, spatial, playerPos, playerInVehicle);
    for (const p of this.ordered) p.syncAfterCrowdStep();
  }

  private resolvePrepared(
    spatial: SpatialQuery,
    playerPos: THREE.Vector3 | null,
    playerInVehicle: boolean,
  ): void {
    for (let pass = 0; pass < DEPENETRATION_PASSES; pass++) {
      this.fillCells(this.ordered);
      this.pairA.length = 0;
      this.pairB.length = 0;
      for (const p of this.ordered) {
        if (p.mode === 'down') continue;
        this.forEachNear(p.position.x, p.position.z, (o) => {
          if (o.mode === 'down' || comparePedId(p, o) >= 0) return;
          const dx = p.position.x - o.position.x;
          const dz = p.position.z - o.position.z;
          if (dx * dx + dz * dz > PED_PAIR_CANDIDATE_RADIUS_SQ) return;
          this.pairA.push(p);
          this.pairB.push(o);
        });
      }

      let corrected = false;
      for (let i = 0; i < this.pairA.length; i++) {
        if (this.resolvePairRoots(this.pairA[i], this.pairB[i], spatial)) corrected = true;
      }
      if (playerPos && !playerInVehicle) {
        for (const p of this.ordered) {
          if (this.resolvePlayerRoot(p, playerPos, spatial)) corrected = true;
        }
      }
      if (!corrected) break;
    }
    this.fillCells(this.ordered);
  }

  private resolvePairRoots(a: Ped, b: Ped, spatial: SpatialQuery): boolean {
    let dx = a.position.x - b.position.x;
    let dz = a.position.z - b.position.z;
    const d = Math.hypot(dx, dz);
    if (d >= PED_MIN_SEPARATION) return false;
    if (d < 1e-6) {
      const angle = pairAngle(a.id, b.id);
      dx = Math.cos(angle);
      dz = Math.sin(angle);
    } else {
      dx /= d;
      dz /= d;
    }

    const targetDx = dx * PED_MIN_SEPARATION - (a.position.x - b.position.x);
    const targetDz = dz * PED_MIN_SEPARATION - (a.position.z - b.position.z);
    const aAnchored = a.mode === 'anchored';
    const bAnchored = b.mode === 'anchored';
    const aShare = aAnchored && !bAnchored ? 0 : !aAnchored && bAnchored ? 1 : 0.5;
    const bShare = 1 - aShare;

    for (const [aScale, bScale] of [[aShare, bShare], [1, 0], [0, 1]] as const) {
      const adx = targetDx * aScale;
      const adz = targetDz * aScale;
      const bdx = -targetDx * bScale;
      const bdz = -targetDz * bScale;
      if (
        !this.correctionIsSafe(a, adx, adz, spatial, true)
        || !this.correctionIsSafe(b, bdx, bdz, spatial, true)
      ) continue;
      a.position.x += adx;
      a.position.z += adz;
      b.position.x += bdx;
      b.position.z += bdz;
      if (aAnchored) {
        a.anchorX += adx;
        a.anchorZ += adz;
      }
      if (bAnchored) {
        b.anchorX += bdx;
        b.anchorZ += bdz;
      }
      return true;
    }
    return false;
  }

  private resolvePlayerRoot(p: Ped, player: THREE.Vector3, spatial: SpatialQuery): boolean {
    if (p.mode === 'down') return false;
    let nx = p.position.x - player.x;
    let nz = p.position.z - player.z;
    const d = Math.hypot(nx, nz);
    if (d >= React.playerSeparation) return false;
    if (d < 1e-6) {
      const angle = pairAngle(p.id, 'player');
      nx = Math.cos(angle);
      nz = Math.sin(angle);
    } else {
      nx /= d;
      nz /= d;
    }

    const base = Math.atan2(nz, nx);
    for (const offset of AVOIDANCE_FAN) {
      const angle = base + offset;
      const x = player.x + Math.cos(angle) * React.playerSeparation;
      const z = player.z + Math.sin(angle) * React.playerSeparation;
      const dx = x - p.position.x;
      const dz = z - p.position.z;
      if (!this.correctionIsSafe(p, dx, dz, spatial, false)) continue;
      p.position.x = x;
      p.position.z = z;
      nx = Math.cos(angle);
      nz = Math.sin(angle);
      const inward = p.vel.x * nx + p.vel.z * nz;
      if (inward < 0) {
        p.vel.x -= nx * inward;
        p.vel.z -= nz * inward;
      }
      return true;
    }
    return false;
  }

  private correctionIsSafe(
    p: Ped,
    dx: number,
    dz: number,
    spatial: SpatialQuery,
    moveAnchor: boolean,
  ): boolean {
    if (Math.abs(dx) + Math.abs(dz) < 1e-10) return true;
    const x = p.position.x + dx;
    const z = p.position.z + dz;
    if (!Number.isFinite(x) || !Number.isFinite(z) || spatial.isBlocked(x, z)) return false;
    if (!moveAnchor || p.mode !== 'anchored') return true;
    const anchorX = p.anchorX + dx;
    const anchorZ = p.anchorZ + dz;
    return Number.isFinite(anchorX)
      && Number.isFinite(anchorZ)
      && !spatial.isBlocked(anchorX, anchorZ);
  }

  private fillCells(peds: readonly Ped[]): void {
    this.cells.clear();
    for (const p of peds) {
      if (!p.active) continue;
      const k = this.key(p.pos.x, p.pos.z);
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(p);
    }
  }

  private key(x: number, z: number): number {
    return Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
  }

  forEachNear(x: number, z: number, fn: (p: Ped) => void): void {
    const i0 = Math.floor((x - this.cell) / this.cell);
    const j0 = Math.floor((z - this.cell) / this.cell);
    for (let i = i0; i <= i0 + 2; i++) {
      for (let j = j0; j <= j0 + 2; j++) {
        const list = this.cells.get(i * 100003 + j);
        if (!list) continue;
        for (const p of list) fn(p);
      }
    }
  }
}

/** Coarse grid over the vehicle population — same idea, bigger cells. */
export class VehicleGrid {
  private cells = new Map<number, VehicleSample[]>();
  private cell = 16;
  private pool: VehicleSample[] = [];
  private used = 0;

  begin(): void {
    this.cells.clear();
    this.used = 0;
  }

  add(x: number, z: number, vx: number, vz: number, speed: number, id: string): void {
    let s = this.pool[this.used];
    if (!s) this.pool[this.used] = s = { x: 0, z: 0, vx: 0, vz: 0, speed: 0, id: '' };
    s.x = x; s.z = z; s.vx = vx; s.vz = vz; s.speed = speed; s.id = id;
    this.used++;
    const k = Math.floor(x / this.cell) * 100003 + Math.floor(z / this.cell);
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push(s);
  }

  forEachNear(x: number, z: number, radius: number, fn: (v: VehicleSample) => void): void {
    const r = Math.max(1, Math.ceil(radius / this.cell));
    const i0 = Math.floor(x / this.cell);
    const j0 = Math.floor(z / this.cell);
    for (let i = i0 - r; i <= i0 + r; i++) {
      for (let j = j0 - r; j <= j0 + r; j++) {
        const list = this.cells.get(i * 100003 + j);
        if (!list) continue;
        for (const v of list) fn(v);
      }
    }
  }

  get count(): number {
    return this.used;
  }
}

export interface CrowdEnv {
  graph: PavementGraph;
  spatial: SpatialQuery;
  rng: Rng;
  /** Seconds since start, for animation phase. */
  time: number;
  hour: number;
  district(x: number, z: number): DistrictKind;
  playerPos: THREE.Vector3 | null;
  playerInVehicle: boolean;
  playerSpeed: number;
  vehicles: VehicleGrid;
  peds: CrowdGrid;
  /** Raised when a car actually flattens someone. */
  onKnockdown(p: Ped, fatal: boolean): void;
  /** Ambient alarm 0..1 — sirens, gunfire, wanted level. */
  tension: number;
}

let nextId = 1;

export class Ped implements CharacterHandle, RigSubject {
  readonly id: string;
  archetype: PedArchetype = 'civilian';
  faction: Faction = 'civilian';
  readonly object = new THREE.Object3D();
  readonly position = new THREE.Vector3();
  /** RigSubject alias — the same vector, never a copy. */
  readonly pos: THREE.Vector3;

  health = 100;
  readonly maxHealth = 100;
  state: LocomotionState = 'idle';

  active = false;
  app!: PedAppearance;
  appearance: unknown = null;
  seed = 0;

  /* pose / animation */
  pose: PoseState = 'idle';
  phase = 0;
  yaw = 0;
  tiltPitch = 0;
  tiltRoll = 0;
  headYaw = 0;
  headPitch = 0;
  gesture = 0.6;
  /** Body yaw rate, rad/s — feeds the rig's lean-into-turns. */
  turnRate = 0;
  /** World point the head should track, or null. */
  lookTarget: THREE.Vector3 | null = null;
  lookWeight = 0;

  /* locomotion */
  readonly vel = new THREE.Vector3();
  speed = 0;
  preferredSpeed = 1.3;
  maxSpeed = 1.3;
  private groundY = 0;

  /* navigation */
  mode: PedMode = 'route';
  edge = -1;
  fromNode = -1;
  toNode = -1;
  along = 0;
  lateral = 0;
  private lateralTarget = 0;

  /* behaviour */
  idle: IdleSpec | null = null;
  idleTimer = 0;
  anchorX = 0;
  anchorZ = 0;
  anchorYaw = 0;
  /** Ped this one is talking to. */
  partner: Ped | null = null;
  dog: Dog | null = null;
  jogger = false;

  /* reactions */
  alarm = 0;
  flinchTimer = 0;
  fleeTimer = 0;
  fleeX = 0;
  fleeZ = 0;
  downTimer = 0;
  lookTimer = 0;
  /** Impulse waiting to be handed to the character rig's ragdoll. */
  ragdollPending: THREE.Vector3 | null = null;
  /** True once the rig's own ragdoll sim owns this body's transform. */
  ragdolled = false;
  private crossWait = 0;
  private nextCross = -1;
  private repathTimer = 0;
  private scriptTarget: THREE.Vector3 | null = null;
  private scriptSpeed = 1.4;
  private scriptTimer = 0;

  constructor() {
    this.id = `ped${nextId++}`;
    this.pos = this.position;
    this.object.matrixAutoUpdate = false;
  }

  get isAlive(): boolean {
    return this.health > 0;
  }

  /* ---------------------------------------------------------------- */
  /* CharacterHandle                                                   */
  /* ---------------------------------------------------------------- */

  applyDamage(amount: number, _source?: Faction, _point?: THREE.Vector3): void {
    this.health = Math.max(0, this.health - amount);
    if (this.health <= 0 && this.mode !== 'down') this.knockDown(0, 0, 3);
    else this.startFlee(this.position.x - Math.cos(this.yaw), this.position.z - Math.sin(this.yaw));
  }

  moveTo(target: THREE.Vector3, speed: number): void {
    this.scriptTarget = (this.scriptTarget ?? new THREE.Vector3()).copy(target);
    this.scriptSpeed = speed;
    this.scriptTimer = 0.5;
    if (this.mode !== 'down') this.mode = 'scripted';
  }

  lookAt(target: THREE.Vector3): void {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const want = Math.atan2(dx, dz);
    this.headYaw = wrapPi(want - this.yaw) * 0.75;
    this.lookTimer = Math.max(this.lookTimer, 1.4);
  }

  playState(s: LocomotionState): void {
    this.state = s;
    if (s === 'ragdoll' || s === 'die') this.knockDown(0, 0, 2);
  }

  ragdoll(impulse?: THREE.Vector3): void {
    this.knockDown(impulse?.x ?? 0, impulse?.z ?? 0, impulse ? impulse.length() : 3);
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  reset(
    archetype: PedArchetype,
    app: PedAppearance,
    x: number,
    z: number,
    yaw: number,
    speed: number,
    rng: Rng,
  ): void {
    this.archetype = archetype;
    this.app = app;
    this.faction = archetype === 'police' ? 'police' : archetype === 'ministryAgent' ? 'ministry' : archetype === 'builder' ? 'builder' : 'civilian';
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.health = 100;
    this.active = true;
    this.seed = rng.int(0, 1024);
    this.phase = rng.range(0, Math.PI * 2);
    this.preferredSpeed = speed;
    this.maxSpeed = speed;
    this.mode = 'route';
    this.edge = -1;
    this.idle = null;
    this.partner = null;
    this.dog = null;
    this.jogger = false;
    this.alarm = 0;
    this.flinchTimer = 0;
    this.fleeTimer = 0;
    this.downTimer = 0;
    this.tiltPitch = 0;
    this.tiltRoll = 0;
    this.headYaw = 0;
    this.headPitch = 0;
    this.lookTimer = 0;
    this.crossWait = 0;
    this.nextCross = -1;
    this.scriptTarget = null;
    this.ragdollPending = null;
    this.ragdolled = false;
    this.lookTarget = null;
    this.lookWeight = 0;
    this.turnRate = 0;
    this.gesture = rng.range(0.45, 1.0);
    this.lateralTarget = rng.range(-0.5, 0.5);
    this.lateral = this.lateralTarget;
    this.pose = 'idle';
    this.state = 'idle';
  }

  /** Put the ped on an edge, travelling from `fromNode`. */
  placeOnEdge(graph: PavementGraph, edgeId: number, fromNode: number, t: number): void {
    const e = graph.edges[edgeId];
    if (!e) return;
    this.edge = edgeId;
    this.fromNode = fromNode;
    this.toNode = graph.other(e, fromNode);
    this.along = t * e.length;
    this.mode = 'route';
    const na = graph.nodes[this.fromNode];
    const nb = graph.nodes[this.toNode];
    const ux = (nb.x - na.x) / e.length;
    const uz = (nb.z - na.z) / e.length;
    // Keep right — Romanian pavements, like the roads, run right-hand.
    const side = Math.abs(this.lateralTarget) * e.halfWidth;
    this.lateral = side;
    this.position.set(
      na.x + ux * this.along + uz * side,
      0,
      na.z + uz * this.along - ux * side,
    );
    this.yaw = Math.atan2(ux, uz);
  }

  /** Re-roll which side of the footway this person prefers. */
  lateralTargetRandomise(rng: Rng): void {
    this.lateralTarget = rng.range(-0.72, 0.72);
  }

  anchorAt(x: number, z: number, yaw: number, spec: IdleSpec): void {
    this.mode = 'anchored';
    this.anchorX = x;
    this.anchorZ = z;
    this.anchorYaw = yaw;
    this.idle = spec;
    this.idleTimer = spec.duration;
    this.position.x = x;
    this.position.z = z;
    this.yaw = yaw;
    this.pose = spec.pose;
  }

  /* ---------------------------------------------------------------- */
  /* reactions                                                         */
  /* ---------------------------------------------------------------- */

  startFlee(fromX: number, fromZ: number): void {
    if (this.mode === 'down') return;
    const dx = this.position.x - fromX;
    const dz = this.position.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    this.fleeX = dx / l;
    this.fleeZ = dz / l;
    this.fleeTimer = React.fleeSeconds;
    this.mode = 'flee';
    this.alarm = 1;
    this.partner = null;
  }

  knockDown(ix: number, iz: number, force: number): void {
    if (this.mode === 'down') return;
    this.mode = 'down';
    this.pose = 'down';
    this.state = 'ragdoll';
    this.downTimer = React.downSeconds;
    const l = Math.hypot(ix, iz) || 1;
    this.vel.set((ix / l) * force * 0.9, Math.min(4.6, 1.4 + force * 0.28), (iz / l) * force * 0.9);
    // Hand the real impulse to the character rig; it has a proper ragdoll.
    this.ragdollPending = new THREE.Vector3(
      (ix / l) * force * 1.6,
      1.8 + force * 0.35,
      (iz / l) * force * 1.6,
    );
    // Tumble away from the impact.
    this.tiltRoll = 0;
    this.tiltPitch = 0;
    this.tumbleDir = Math.abs(wrapPi(Math.atan2(ix, iz) - this.yaw)) < Math.PI / 2 ? -1 : 1;
    this.health = Math.max(0, this.health - 34 - force * 6);
  }

  private tumbleDir = 1;

  /* ---------------------------------------------------------------- */
  /* per-step                                                          */
  /* ---------------------------------------------------------------- */

  update(dt: number, env: CrowdEnv): void {
    if (!this.active) return;

    this.alarm = Math.max(0, this.alarm - dt * 0.35);
    this.lookTimer = Math.max(0, this.lookTimer - dt);

    if (this.mode === 'down') {
      this.updateDown(dt, env);
      return;
    }

    this.senseVehicles(dt, env);
    this.sensePlayer(dt, env);

    switch (this.mode) {
      case 'route': this.updateRoute(dt, env); break;
      case 'waitCross': this.updateWaitCross(dt, env); break;
      case 'anchored': this.updateAnchored(dt, env); break;
      case 'flee': this.updateFlee(dt, env); break;
      case 'scripted': this.updateScripted(dt, env); break;
    }

    this.steerAndIntegrate(dt, env);
    this.animate(dt, env);
  }

  /** Publish the final globally-solved root once per fixed crowd step. */
  syncAfterCrowdStep(): void {
    if (!this.ragdolled) this.syncObject();
  }

  /* ---- sensing ---- */

  private threatX = 0;
  private threatZ = 0;
  private threatWeight = 0;

  private senseVehicles(dt: number, env: CrowdEnv): void {
    this.threatWeight = 0;
    this.threatX = 0;
    this.threatZ = 0;
    const px = this.position.x;
    const pz = this.position.z;
    let hit: VehicleSample | null = null;
    let hitSpeed = 0;

    env.vehicles.forEachNear(px, pz, React.scatterRadius, (v) => {
      const dx = px - v.x;
      const dz = pz - v.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > React.scatterRadius * React.scatterRadius) return;
      const d = Math.sqrt(d2) || 0.001;

      // Decompose into the car's own frame. `along` is how far ahead of the
      // car we are; `miss` is how far the car's path passes to one side of us.
      // Distance alone is useless here: a car doing 60 down the far lane is
      // fifteen metres away and completely harmless, and if that makes people
      // run then the entire pavement is permanently sprinting.
      const moving = v.speed > 0.4;
      const along = moving ? dx * v.vx + dz * v.vz : 0;
      const miss = moving ? Math.abs(dx * v.vz - dz * v.vx) : d;

      // The car's actual footprint, not its origin: a saloon is four metres
      // long, and a point test lets cars drive through people untouched.
      const inFootprint = moving
        ? Math.abs(along) < React.carHalfLength && miss < React.carHalfWidth
        : d < React.hitRadius;

      if (inFootprint && v.speed > React.hitSpeed) {
        if (!hit || v.speed > hitSpeed) {
          hit = v;
          hitSpeed = v.speed;
        }
        return;
      }

      if (!moving) return;

      // On a collision course and fast: run for it.
      if (
        v.speed > React.scarySpeed
        && along > 0 && along < React.scatterRadius
        && miss < React.dangerCorridor
      ) {
        this.startFlee(v.x, v.z);
        return;
      }
      // Something passing close makes people shy away from the kerb.
      if (along > -React.carHalfLength && along < React.flinchRadius && miss < React.flinchCorridor) {
        const w = (1 - miss / React.flinchCorridor) * Math.min(1, v.speed / 9);
        this.threatX += (dx / d) * w;
        this.threatZ += (dz / d) * w;
        this.threatWeight += w;
        if (w > 0.55 && this.flinchTimer <= 0 && this.mode !== 'flee') {
          this.flinchTimer = React.flinchSeconds;
          this.alarm = Math.max(this.alarm, 0.8);
        }
      }
    });

    if (hit) {
      const v = hit as VehicleSample;
      this.knockDown(v.vx, v.vz, Math.min(9, v.speed * 0.55));
      env.onKnockdown(this, v.speed > 9 || this.health <= 0);
      return;
    }

    this.flinchTimer = Math.max(0, this.flinchTimer - dt);
    // Ambient tension (sirens, stars) makes the crowd jumpy.
    if (env.tension > 0.5 && this.alarm < env.tension * 0.6) this.alarm = env.tension * 0.6;
  }

  private sensePlayer(dt: number, env: CrowdEnv): void {
    this.lookWeight = Math.max(0, this.lookWeight - dt * 1.1);
    if (this.lookWeight <= 0) this.lookTarget = null;

    // A conversation partner is the default thing to look at.
    if (this.partner && this.partner.active && this.mode === 'anchored') {
      this.lookTarget = this.partner.position;
      this.lookWeight = 0.55;
    }

    const p = env.playerPos;
    if (!p) return;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > React.noticeRadius * React.noticeRadius) return;
    // Turn the head toward the player — the single cheapest thing that makes a
    // crowd feel aware of you.
    const want = wrapPi(Math.atan2(dx, dz) - this.yaw);
    if (Math.abs(want) < 2.0) {
      this.headYaw += (want * 0.8 - this.headYaw) * 0.08;
      this.lookTimer = 0.6;
      this.lookTarget = p;
      // Someone barrelling toward you gets more attention than a passer-by.
      this.lookWeight = Math.min(1, 0.55 + (1 - Math.sqrt(d2) / React.noticeRadius) * 0.6);
    }
  }

  /* ---- modes ---- */

  private target = new THREE.Vector3();
  private hasTarget = false;

  private updateRoute(dt: number, env: CrowdEnv): void {
    const g = env.graph;
    const e = g.edges[this.edge];
    if (!e) {
      this.rejoin(env);
      return;
    }
    const na = g.nodes[this.fromNode];
    const nb = g.nodes[this.toNode];
    const ux = (nb.x - na.x) / e.length;
    const uz = (nb.z - na.z) / e.length;

    // Re-derive progress from the real position so avoidance never desyncs.
    this.along = clamp((this.position.x - na.x) * ux + (this.position.z - na.z) * uz, -2, e.length + 2);

    // Drift toward the preferred side of the footway.
    const want = e.kind === EdgeKind.Cross ? 0 : this.lateralTarget * e.halfWidth;
    this.lateral += (want - this.lateral) * Math.min(1, dt * 1.4);

    const look = Math.min(e.length, this.along + 2.4);
    this.target.set(
      na.x + ux * look + uz * this.lateral,
      0,
      na.z + uz * look - ux * this.lateral,
    );
    this.hasTarget = true;
    this.maxSpeed = this.preferredSpeed * (e.kind === EdgeKind.Cross ? 1.25 : 1);
    this.pose = this.jogger ? 'jog' : 'walk';

    if (this.along >= e.length - 0.7) {
      this.arriveAtNode(env);
    }
  }

  private arriveAtNode(env: CrowdEnv): void {
    const g = env.graph;
    const node = this.toNode;
    const hx = Math.sin(this.yaw);
    const hz = Math.cos(this.yaw);

    // A chance to stop and do something instead of walking forever.
    if (!this.jogger && env.rng.bool(0.14)) {
      const anchor = this.findAnchorNear(env, g.nodes[node].x, g.nodes[node].z);
      if (anchor) return;
    }

    const next = g.nextEdge(node, this.edge, hx, hz, env.rng);
    if (next < 0) {
      // Dead end: turn around.
      const e = g.edges[this.edge];
      if (!e) {
        this.rejoin(env);
        return;
      }
      const tmp = this.fromNode;
      this.fromNode = this.toNode;
      this.toNode = tmp;
      this.along = 0;
      this.lateralTarget = -this.lateralTarget;
      return;
    }
    const ne = g.edges[next];
    if (ne.kind === EdgeKind.Cross) {
      this.nextCross = next;
      this.mode = 'waitCross';
      this.crossWait = env.rng.range(0.3, 1.6);
      this.pose = 'idle';
      const other = g.other(ne, node);
      this.yaw = Math.atan2(g.nodes[other].x - g.nodes[node].x, g.nodes[other].z - g.nodes[node].z);
      return;
    }
    this.edge = next;
    this.fromNode = node;
    this.toNode = g.other(ne, node);
    this.along = 0;
    if (env.rng.bool(0.35)) this.lateralTarget = env.rng.range(-0.62, 0.62);
  }

  private updateWaitCross(dt: number, env: CrowdEnv): void {
    const g = env.graph;
    const e = g.edges[this.nextCross];
    if (!e) {
      this.rejoin(env);
      return;
    }
    this.hasTarget = false;
    this.pose = this.alarm > 0.4 ? 'idle' : 'idle';
    this.crossWait -= dt;

    // Look up and down the road while waiting.
    this.headYaw = Math.sin(env.time * 0.9 + this.seed) * 0.85;

    if (this.crossWait > 0) return;
    if (!this.crossingIsClear(env, e)) {
      this.crossWait = 0.35;
      return;
    }
    this.edge = this.nextCross;
    this.fromNode = this.toNode;
    this.toNode = g.other(e, this.fromNode);
    this.along = 0;
    this.lateral = 0;
    this.mode = 'route';
    this.nextCross = -1;
  }

  private crossingIsClear(env: CrowdEnv, e: PavEdge): boolean {
    const g = env.graph;
    const a = g.nodes[e.a];
    const b = g.nodes[e.b];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    let clear = true;
    const reach = 8 + e.roadHalf * 2.2;
    env.vehicles.forEachNear(mx, mz, reach + 12, (v) => {
      if (!clear) return;
      if (v.speed < 1.0) return;
      const dx = mx - v.x;
      const dz = mz - v.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 12) return;
      // (vx, vz) is a unit heading, so this is simply "is the crossing ahead".
      const along = dx * v.vx + dz * v.vz;
      if (along <= 0) return;
      const miss = Math.abs(dx * v.vz - dz * v.vx);
      if (miss > e.roadHalf + 4) return;
      const ttc = along / Math.max(1, v.speed);
      if (ttc < 3.4) clear = false;
    });
    return clear;
  }

  private updateAnchored(dt: number, env: CrowdEnv): void {
    this.hasTarget = false;
    const spec = this.idle;
    this.idleTimer -= dt;

    if (this.flinchTimer > 0) this.pose = 'flinch';
    else if (spec) this.pose = spec.pose;

    // Drift back onto the anchor if a crowd has shoved us off it.
    const dx = this.anchorX - this.position.x;
    const dz = this.anchorZ - this.position.z;
    if (dx * dx + dz * dz > 0.36) {
      this.target.set(this.anchorX, 0, this.anchorZ);
      this.hasTarget = true;
      this.maxSpeed = 0.7;
      this.pose = 'walk';
    }

    // Face the conversation, or the anchor's own facing.
    let wantYaw = this.anchorYaw;
    if (this.partner && this.partner.active) {
      wantYaw = Math.atan2(
        this.partner.position.x - this.position.x,
        this.partner.position.z - this.position.z,
      );
    }
    this.yaw = dampAngle(this.yaw, wantYaw, 5, dt);

    if (this.idleTimer <= 0) this.rejoin(env);
  }

  private updateFlee(dt: number, env: CrowdEnv): void {
    this.fleeTimer -= dt;
    this.pose = 'panic';
    this.maxSpeed = this.preferredSpeed * 2.5 + 1.2;
    this.state = 'sprint';
    // Steer the flee direction along the pavement rather than into a wall.
    const sp = env.spatial;
    let fx = this.fleeX;
    let fz = this.fleeZ;
    const ahead = 2.6;
    if (sp.isBlocked(this.position.x + fx * ahead, this.position.z + fz * ahead)) {
      for (const a of [0.7, -0.7, 1.5, -1.5, 2.4, -2.4]) {
        const nx = fx * Math.cos(a) - fz * Math.sin(a);
        const nz = fx * Math.sin(a) + fz * Math.cos(a);
        if (!sp.isBlocked(this.position.x + nx * ahead, this.position.z + nz * ahead)) {
          fx = nx;
          fz = nz;
          break;
        }
      }
      this.fleeX = fx;
      this.fleeZ = fz;
    }
    this.target.set(this.position.x + fx * 6, 0, this.position.z + fz * 6);
    this.hasTarget = true;
    this.headYaw *= 0.9;
    if (this.fleeTimer <= 0) this.rejoin(env);
  }

  private updateScripted(dt: number, env: CrowdEnv): void {
    this.scriptTimer -= dt;
    if (!this.scriptTarget || this.scriptTimer <= 0) {
      this.rejoin(env);
      return;
    }
    this.target.copy(this.scriptTarget);
    this.hasTarget = true;
    this.maxSpeed = this.scriptSpeed;
    this.pose = this.scriptSpeed > 2.6 ? 'jog' : 'walk';
  }

  private updateDown(dt: number, env: CrowdEnv): void {
    this.downTimer -= dt;
    this.pose = 'down';
    this.state = this.health > 0 ? 'ragdoll' : 'die';
    if (this.ragdolled) {
      // The character rig's ragdoll owns the transform; we only keep time.
      this.speed = 0;
      return;
    }
    this.vel.y -= 17 * dt;
    this.position.addScaledVector(this.vel, dt);
    const g = env.spatial.groundHeight(this.position.x, this.position.z);
    const floor = g === -Infinity ? 0 : g;
    // Tumble onto the ground, then stay there.
    const target = (Math.PI / 2) * this.tumbleDir;
    this.tiltPitch += (target - this.tiltPitch) * Math.min(1, dt * 4.5);
    if (this.position.y <= floor + 0.02) {
      this.position.y = floor;
      this.vel.x *= 0.72;
      this.vel.z *= 0.72;
      this.vel.y = 0;
      if (this.vel.lengthSq() < 0.02) this.vel.set(0, 0, 0);
    }
    this.speed = 0;
    this.pose = 'down';
    this.state = this.health > 0 ? 'ragdoll' : 'die';
    this.headYaw *= 0.94;
  }

  /** Fall back onto the nearest walk edge and start routing again. */
  private rejoin(env: CrowdEnv): void {
    const g = env.graph;
    this.idle = null;
    this.partner = null;
    const node = g.nearestNode(this.position.x, this.position.z);
    if (node < 0) {
      this.mode = 'route';
      this.edge = -1;
      return;
    }
    const n = g.nodes[node];
    let pick = -1;
    for (const id of n.edges) {
      if (g.edges[id].kind === EdgeKind.Walk) {
        pick = id;
        break;
      }
    }
    if (pick < 0) pick = n.edges[0] ?? -1;
    if (pick < 0) {
      this.mode = 'route';
      return;
    }
    this.edge = pick;
    this.fromNode = node;
    this.toNode = g.other(g.edges[pick], node);
    this.along = 0;
    this.mode = 'route';
    this.pose = 'walk';
  }

  private static readonly anchorBuf: number[] = [];

  private findAnchorNear(env: CrowdEnv, x: number, z: number): boolean {
    const g = env.graph;
    const buf = Ped.anchorBuf;
    g.anchorsNear(x, z, 26, buf);
    if (!buf.length) return false;
    const a = g.anchors[buf[env.rng.int(0, buf.length)]];
    if (!a) return false;
    const spec = pickIdle(this.archetype, env.district(a.x, a.z), a.kind === 'shopfront', env.rng);
    this.anchorAt(a.x, a.z, a.yaw, spec);
    return true;
  }

  /* ---- steering ---- */

  private steerAndIntegrate(dt: number, env: CrowdEnv): void {
    let dx = 0;
    let dz = 0;
    if (this.hasTarget) {
      dx = this.target.x - this.position.x;
      dz = this.target.z - this.position.z;
      const l = Math.hypot(dx, dz);
      if (l > 0.001) {
        dx /= l;
        dz /= l;
      }
    }

    /* separation + queueing */
    let sx = 0;
    let sz = 0;
    let queueCap = this.maxSpeed;
    const px = this.position.x;
    const pz = this.position.z;
    env.peds.forEachNear(px, pz, (o) => {
      if (o === this || !o.active) return;
      const ox = px - o.position.x;
      const oz = pz - o.position.z;
      const d2 = ox * ox + oz * oz;
      if (d2 > 2.25 || d2 < 1e-5) return;
      const d = Math.sqrt(d2);
      const w = (1 - d / 1.5) ** 2;
      sx += (ox / d) * w;
      sz += (oz / d) * w;
      // Someone directly ahead and slower: fall in behind rather than clip.
      if (this.hasTarget) {
        const fwd = (-ox / d) * dx + (-oz / d) * dz;
        if (fwd > 0.72 && d < 1.25) queueCap = Math.min(queueCap, Math.max(0.15, o.speed * 0.92));
      }
    });

    /* the player is an obstacle too */
    if (env.playerPos && !env.playerInVehicle) {
      const ox = px - env.playerPos.x;
      const oz = pz - env.playerPos.z;
      const d2 = ox * ox + oz * oz;
      if (d2 < 2.9 && d2 > 1e-5) {
        const d = Math.sqrt(d2);
        const w = (1 - d / 1.7) ** 2 * 2.2;
        sx += (ox / d) * w;
        sz += (oz / d) * w;
      }
    }

    /* step away from traffic */
    if (this.threatWeight > 0) {
      sx += this.threatX * 2.6;
      sz += this.threatZ * 2.6;
    }

    let vx = dx * 1.0 + sx * 0.85;
    let vz = dz * 1.0 + sz * 0.85;

    /* never walk into a building */
    const probe = 1.15;
    const pl = Math.hypot(vx, vz);
    if (pl > 0.01) {
      const nx = vx / pl;
      const nz = vz / pl;
      if (env.spatial.isBlocked(px + nx * probe, pz + nz * probe)) {
        let found = false;
        for (const a of [0.6, -0.6, 1.2, -1.2, 2.0, -2.0]) {
          const cx = nx * Math.cos(a) - nz * Math.sin(a);
          const cz = nx * Math.sin(a) + nz * Math.cos(a);
          if (!env.spatial.isBlocked(px + cx * probe, pz + cz * probe)) {
            vx = cx;
            vz = cz;
            found = true;
            break;
          }
        }
        if (!found) {
          vx = -nx;
          vz = -nz;
        }
      }
    }

    const speedCap = Math.min(queueCap, this.flinchTimer > 0 ? this.maxSpeed * 0.25 : this.maxSpeed);
    const ml = Math.hypot(vx, vz);
    let wantX = 0;
    let wantZ = 0;
    if (ml > 0.001) {
      wantX = (vx / ml) * speedCap;
      wantZ = (vz / ml) * speedCap;
    }

    const accel = this.mode === 'flee' ? 12 : 6.5;
    const k = Math.min(1, dt * accel);
    this.vel.x += (wantX - this.vel.x) * k;
    this.vel.z += (wantZ - this.vel.z) * k;

    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.z * dt;
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    /* ground + kerb steps */
    const g = env.spatial.groundHeight(this.position.x, this.position.z);
    const floor = g === -Infinity ? 0 : g;
    this.groundY += (floor - this.groundY) * Math.min(1, dt * 9);
    this.position.y = this.groundY;

    /* face the way we are going */
    const prevYaw = this.yaw;
    if (this.speed > 0.16 && this.mode !== 'anchored') {
      this.yaw = dampAngle(this.yaw, Math.atan2(this.vel.x, this.vel.z), this.mode === 'flee' ? 9 : 6, dt);
    }
    this.turnRate = dt > 1e-5 ? wrapPi(this.yaw - prevYaw) / dt : 0;
  }

  private syncObject(): void {
    this.object.position.copy(this.position);
    this.object.rotation.y = this.yaw;
    this.object.updateMatrix();
  }

  /* ---- animation bookkeeping ---- */

  private animate(dt: number, env: CrowdEnv): void {
    // Someone standing at an anchor is constantly nudged a few centimetres by
    // the people around them; without a higher threshold their idle pose
    // flickers into a walk cycle every time a passer-by brushes past.
    const moving = this.speed > (this.mode === 'anchored' ? 0.62 : 0.22);
    if (moving) {
      // Lock the gait to distance travelled so the feet do not skate.
      const stride = this.app.height * (this.speed > 3.0 ? 1.62 : 1.12);
      this.phase += (this.speed / stride) * Math.PI * 2 * dt;
      if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;
      if (this.mode !== 'flee') {
        this.pose = this.speed > 3.2 ? 'sprint' : this.speed > 2.1 ? 'jog' : 'walk';
        this.state = this.speed > 3.2 ? 'sprint' : this.speed > 2.1 ? 'jog' : 'walk';
      }
    } else {
      this.phase += dt * 0.6;
      if (this.mode === 'route' || this.mode === 'scripted') this.pose = 'idle';
      this.state = this.pose === 'sit' ? 'sit' : 'idle';
    }

    if (this.flinchTimer > 0 && this.mode !== 'flee' && this.mode !== 'down') this.pose = 'flinch';

    /* head */
    if (this.lookTimer <= 0) {
      const drift = Math.sin(env.time * 0.31 + this.seed * 1.7) * 0.34;
      this.headYaw += (drift - this.headYaw) * Math.min(1, dt * 1.6);
    }
    const wantPitch = this.pose === 'phone' ? 0.42 : this.pose === 'shop' ? 0.12 : this.alarm > 0.5 ? -0.12 : 0.02;
    this.headPitch += (wantPitch - this.headPitch) * Math.min(1, dt * 3);

    /* dog */
    if (this.dog) this.updateDog(dt, env);
  }

  private updateDog(dt: number, env: CrowdEnv): void {
    const d = this.dog!;
    // Trail behind and to the side of the owner, on a springy lead.
    const bx = this.position.x - Math.sin(this.yaw) * 1.05 + Math.cos(this.yaw) * 0.55;
    const bz = this.position.z - Math.cos(this.yaw) * 1.05 - Math.sin(this.yaw) * 0.55;
    const wanderX = Math.sin(env.time * 1.3 + this.seed) * 0.28;
    const wanderZ = Math.cos(env.time * 1.1 + this.seed * 2.1) * 0.28;
    const tx = bx + wanderX;
    const tz = bz + wanderZ;
    const dx = tx - d.x;
    const dz = tz - d.z;
    const k = Math.min(1, dt * 4.2);
    d.x += dx * k;
    d.z += dz * k;
    const sp = Math.hypot(dx, dz) * 4.2;
    d.phase += dt * (2.5 + sp * 3.4);
    if (Math.hypot(dx, dz) > 0.05) d.yaw = dampAngle(d.yaw, Math.atan2(dx, dz), 7, dt);
    const g = env.spatial.groundHeight(d.x, d.z);
    d.y = g === -Infinity ? 0 : g;
  }
}

/* ------------------------------------------------------------------ */

export function wrapPi(a: number): number {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + wrapPi(target - current) * (1 - Math.exp(-lambda * dt));
}

function comparePedId(a: Ped, b: Ped): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Stable escape direction for the otherwise directionless coincident case. */
function pairAngle(a: string, b: string): number {
  let h = 2166136261;
  for (const id of [a, b]) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 124; // `|` separator without allocating a joined key.
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) / 0x100000000) * Math.PI * 2;
}

const AVOIDANCE_FAN = [0, 0.55, -0.55, 1.1, -1.1, 1.65, -1.65, Math.PI] as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
