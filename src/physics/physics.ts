/** Rapier physics wrapper. One world, deterministic fixed step, with helpers
 *  for the shapes the game actually needs: static city colliders, dynamic
 *  vehicles, kinematic character controllers, and debris. */

import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services } from '../core/services';

export type Rapier = typeof RAPIER;

/** Collision groups. Rapier packs (membership << 16) | filter. */
export const CG = {
  STATIC: 0x0001,
  TERRAIN: 0x0002,
  VEHICLE: 0x0004,
  CHARACTER: 0x0008,
  PLAYER: 0x0010,
  PROP: 0x0020,
  DEBRIS: 0x0040,
  SENSOR: 0x0080,
  WHEEL_RAY: 0x0100,
} as const;

export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/**
 * INTERACTION GROUPS FOR A READ-ONLY PROBE. Use this for every ray and shape
 * cast; only `filter` — what you actually want to hit — should decide anything.
 *
 * Rapier tests interaction groups BOTH WAYS: a query sees a collider only when
 * the query's membership appears in the collider's filter AND the collider's
 * membership appears in the query's filter. Probes in this codebase were built
 * as `groups(CG.SENSOR, ...)`, and not one solid collider lists SENSOR in its
 * filter (`ALL_SOLID` below does not include it) — so the first half of that
 * test failed every time and the probes matched NOTHING AT ALL. Silently:
 * a ray that hits nothing looks exactly like a ray over a hole.
 *
 * What that cost: the player's footing ray never fired, so his soles were
 * placed from the city's analytic footway height alone and he stood inside any
 * step, kerb or crate he climbed; foot IK (`src/characters/ik.ts`) planted on
 * air for the whole crowd; and the capsule could never be settled back out of
 * the ground it had sunk into, because the query that would have found the
 * ground came back empty.
 */
export function probeGroups(filter: number): number {
  return groups(0xffff, filter);
}

const ALL_SOLID = CG.STATIC | CG.TERRAIN | CG.VEHICLE | CG.CHARACTER | CG.PLAYER | CG.PROP | CG.DEBRIS;

export const GROUP = {
  staticWorld: groups(CG.STATIC, ALL_SOLID),
  terrain: groups(CG.TERRAIN, ALL_SOLID),
  vehicle: groups(CG.VEHICLE, ALL_SOLID | CG.SENSOR),
  character: groups(CG.CHARACTER, ALL_SOLID | CG.SENSOR),
  player: groups(CG.PLAYER, ALL_SOLID | CG.SENSOR),
  prop: groups(CG.PROP, ALL_SOLID),
  // Fallen poles and other substantial debris remain part of the world: they
  // settle on terrain/props and can be pushed by vehicles and characters.
  debris: groups(
    CG.DEBRIS,
    CG.STATIC | CG.TERRAIN | CG.VEHICLE | CG.CHARACTER | CG.PLAYER | CG.PROP,
  ),
  sensor: groups(CG.SENSOR, CG.PLAYER | CG.VEHICLE | CG.CHARACTER),
} as const;

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  colliderHandle: number;
  bodyHandle: number | null;
}

/**
 * THE GAP A CHARACTER CAPSULE KEEPS UNDER ITSELF.
 *
 * Rapier's kinematic controller is constructed with an "offset" — the distance
 * it tries to hold between the character collider and the world. That offset is
 * also the amount by which the character is allowed to be WRONG: the controller
 * sweeps from wherever the collider currently is and never pushes it back out
 * of anything it is already inside, so an offset of 0.06 m is 0.06 m of licence
 * to float and, once a landing has driven the capsule in, an unbounded amount
 * of licence to sink. `PhysicsWorld.capsuleRest` is what closes that loop; this
 * is the clearance it settles to.
 *
 * Small enough that the soles read as touching (2 cm at a 1.8 m stature is a
 * shoe sole), large enough that the contact solver is not asked to resolve a
 * zero-distance touch every step.
 */
export const CHARACTER_SKIN = 0.02;

/** Where a character capsule comes to rest on the world beneath it. */
export interface CapsuleRest {
  /** Capsule CENTRE height at which the capsule just touches down. */
  centerY: number;
  /** World Y of the surface it touches. */
  surfaceY: number;
  /** Up-component of the contact normal; 1 on the flat, lower on a slope. */
  normalY: number;
}

/**
 * Centre height that rests a capsule of this size on `surfaceY`, soles a hair
 * clear of it. Pure, so the footing contract is checkable without a physics
 * world — see `src/gameplay/player.test.ts`.
 */
export function capsuleRestHeight(
  surfaceY: number,
  halfHeight: number,
  radius: number,
  skin = CHARACTER_SKIN,
): number {
  return surfaceY + halfHeight + radius + skin;
}

let rapierReady: Promise<Rapier> | null = null;

export function initRapier(): Promise<Rapier> {
  if (!rapierReady) rapierReady = RAPIER.init().then(() => RAPIER);
  return rapierReady;
}

const _v = new THREE.Vector3();

export class PhysicsWorld implements System {
  readonly name = 'physics';
  /** Inits first (everything needs colliders) and steps at the top of each
   *  fixed update, integrating the forces applied by controllers last step. */
  readonly order = 5;

  world!: RAPIER.World;
  rapier!: Rapier;
  private eventQueue!: RAPIER.EventQueue;

  /** Bodies that want their Object3D synced automatically. */
  private synced: Array<{ body: RAPIER.RigidBody; obj: THREE.Object3D }> = [];

  /** Debug wireframe of every collider — toggled with the `debugPhysics` flag. */
  private debugLines: THREE.LineSegments | null = null;
  debugEnabled = false;

  async init(ctx: GameContext): Promise<void> {
    ctx.provide(Services.Physics, this);
    this.rapier = await initRapier();
    this.world = new this.rapier.World({ x: 0, y: -9.81, z: 0 });
    this.world.integrationParameters.dt = 1 / 60;
    // Slightly stiffer contacts than default — vehicles feel less floaty.
    this.world.integrationParameters.numSolverIterations = 8;
    this.eventQueue = new this.rapier.EventQueue(true);

    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, toneMapped: false });
    this.debugLines = new THREE.LineSegments(geo, mat);
    this.debugLines.frustumCulled = false;
    this.debugLines.visible = false;
    this.debugLines.renderOrder = 9999;
    ctx.scene.add(this.debugLines);
  }

  fixedUpdate(dt: number, _ctx: GameContext): void {
    this.world.timestep = dt;
    this.world.step(this.eventQueue);

    for (const s of this.synced) {
      const t = s.body.translation();
      const r = s.body.rotation();
      s.obj.position.set(t.x, t.y, t.z);
      s.obj.quaternion.set(r.x, r.y, r.z, r.w);
    }

    if (this.debugEnabled && this.debugLines) {
      const buffers = this.world.debugRender();
      const g = this.debugLines.geometry;
      g.setAttribute('position', new THREE.BufferAttribute(buffers.vertices, 3));
      g.setAttribute('color', new THREE.BufferAttribute(buffers.colors, 4));
      this.debugLines.visible = true;
    } else if (this.debugLines) {
      this.debugLines.visible = false;
    }
  }

  /* ---------------- builders ---------------- */

  /** Static trimesh collider from a THREE geometry (city meshes). */
  addStaticTrimesh(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, group = GROUP.staticWorld): RAPIER.Collider {
    const g = matrix ? geometry.clone().applyMatrix4(matrix) : geometry;
    const pos = g.attributes.position.array as Float32Array;
    const idx = g.index
      ? new Uint32Array(g.index.array as ArrayLike<number>)
      : new Uint32Array(Array.from({ length: pos.length / 3 }, (_, i) => i));
    const desc = this.rapier.ColliderDesc.trimesh(new Float32Array(pos), idx)
      .setCollisionGroups(group)
      .setFriction(0.95)
      .setRestitution(0.02);
    if (matrix) g.dispose();
    return this.world.createCollider(desc);
  }

  /** Static box — far cheaper than trimesh; use for buildings and kerbs. */
  addStaticBox(
    halfExtents: THREE.Vector3,
    position: THREE.Vector3,
    quaternion?: THREE.Quaternion,
    group = GROUP.staticWorld,
  ): RAPIER.Collider {
    const desc = this.rapier.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setTranslation(position.x, position.y, position.z)
      .setCollisionGroups(group)
      .setFriction(0.9);
    if (quaternion) desc.setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });
    return this.world.createCollider(desc);
  }

  addDynamicBox(
    halfExtents: THREE.Vector3,
    position: THREE.Vector3,
    mass: number,
    group = GROUP.prop,
    obj?: THREE.Object3D,
  ): RAPIER.RigidBody {
    const bodyDesc = this.rapier.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setLinearDamping(0.08)
      .setAngularDamping(0.22)
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);
    const cDesc = this.rapier.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setCollisionGroups(group)
      .setMass(mass)
      .setFriction(0.7)
      .setRestitution(0.15);
    this.world.createCollider(cDesc, body);
    if (obj) this.synced.push({ body, obj });
    return body;
  }

  createCharacterController(offset = CHARACTER_SKIN): RAPIER.KinematicCharacterController {
    const cc = this.world.createCharacterController(offset);
    cc.enableAutostep(0.42, 0.22, true);
    cc.enableSnapToGround(0.45);
    cc.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    cc.setMinSlopeSlideAngle((38 * Math.PI) / 180);
    cc.setApplyImpulsesToDynamicBodies(true);
    cc.setCharacterMass(78);
    return cc;
  }

  track(body: RAPIER.RigidBody, obj: THREE.Object3D): void {
    this.synced.push({ body, obj });
  }

  untrack(body: RAPIER.RigidBody): void {
    const i = this.synced.findIndex((s) => s.body === body);
    if (i >= 0) this.synced.splice(i, 1);
  }

  removeBody(body: RAPIER.RigidBody): void {
    this.untrack(body);
    this.world.removeRigidBody(body);
  }

  /* ---------------- queries ---------------- */

  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDistance: number,
    filterGroups?: number,
    excludeCollider?: RAPIER.Collider,
  ): RayHit | null {
    const ray = new this.rapier.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: dir.x, y: dir.y, z: dir.z },
    );
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      filterGroups,
      excludeCollider,
    );
    if (!hit) return null;
    const p = ray.pointAt(hit.timeOfImpact);
    const parent = hit.collider.parent();
    return {
      point: new THREE.Vector3(p.x, p.y, p.z),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance: hit.timeOfImpact,
      colliderHandle: hit.collider.handle,
      bodyHandle: parent ? parent.handle : null,
    };
  }

  /**
   * WHERE A CHARACTER CAPSULE ACTUALLY RESTS.
   *
   * A single ray down the middle answers "what is the ground under this point";
   * it does not answer "where does a 0.32 m capsule stop", which is the
   * question a character controller has to get right. Straddling a kerb,
   * standing with one hemisphere over a step nose or perched on a crate, the
   * capsule rests on the HIGHEST thing inside its footprint, not on whatever
   * the centre line happened to find.
   *
   * So the probe is a small sheaf of rays over the footprint, each discounted
   * by how much the rounded base SAGS at its offset — a surface 0.22 m off the
   * axis holds a 0.32 m capsule 0.087 m lower than one under the axis, and
   * ignoring that would levitate the character every time he walked past a
   * kerb. Every ray starts above the capsule base, which is what makes this a
   * DEPENETRATION as well as a probe: Rapier's kinematic controller never
   * pushes a collider back out of geometry it is already inside, so the query
   * that finds the way out has to start outside.
   *
   * WHY NOT `castShape` with the capsule itself, which is the obvious answer:
   * because parry's shape casting is iterative with a tolerance that scales
   * with the geometry, and this city's ground is one 5.9 km cuboid. Measured
   * against it, a capsule cast reported the ground 0.37 m out and a ball cast
   * 0.48 m out — worse than the sink being fixed. Ray/cuboid intersection is
   * closed-form and lands on the millimetre.
   *
   * Returns null when nothing is within reach (airborne, or over a hole), which
   * the caller should read as "leave the controller alone".
   */
  capsuleRest(
    collider: RAPIER.Collider,
    x: number,
    y: number,
    z: number,
    opts: { lift?: number; drop?: number; filterGroups?: number } = {},
  ): CapsuleRest | null {
    const lift = opts.lift ?? 0.6;
    const drop = opts.drop ?? 0.6;
    const shape = collider.shape;
    const half = (shape as { halfHeight?: number }).halfHeight ?? 0;
    const radius = (shape as { radius?: number }).radius ?? 0;
    const base = y - half - radius;

    // Ring offset: far enough out to find a kerb nose the axis misses, close
    // enough in that the sag discount keeps it honest.
    const ring = radius * 0.7;
    const sag = radius - Math.sqrt(Math.max(0, radius * radius - ring * ring));

    let best = Number.NEGATIVE_INFINITY;
    let bestNormal = 1;
    for (let i = 0; i < RING_X.length; i++) {
      const off = i === 0 ? 0 : ring;
      _v.set(x + RING_X[i] * off, base + lift, z + RING_Z[i] * off);
      const hit = this.raycast(_v, DOWN, lift + drop, opts.filterGroups, collider);
      // A ray that starts inside geometry reports zero distance. That is a wall
      // the capsule is beside, not a floor it is on, and snapping to it would
      // hoist the character up the wall.
      if (!hit || hit.distance <= 1e-4) continue;
      // Only a surface you could stand on can hold you up.
      if (hit.normal.y < 0.35) continue;
      const support = i === 0 ? hit.point.y : hit.point.y - sag;
      if (support > best) {
        best = support;
        bestNormal = hit.normal.y;
      }
    }
    if (best === Number.NEGATIVE_INFINITY) return null;

    return {
      centerY: best + half + radius,
      surfaceY: best,
      normalY: bestNormal,
    };
  }

  /** Ground probe straight down. Returns Y of the surface or null. */
  groundAt(x: number, z: number, fromY = 400, maxDistance = 800): number | null {
    _v.set(x, fromY, z);
    const hit = this.raycast(_v, DOWN, maxDistance, probeGroups(CG.STATIC | CG.TERRAIN));
    return hit ? hit.point.y : null;
  }

  drainCollisionEvents(fn: (a: number, b: number, started: boolean) => void): void {
    this.eventQueue.drainCollisionEvents(fn);
  }

  drainContactForceEvents(fn: (event: RAPIER.TempContactForceEvent) => void): void {
    this.eventQueue.drainContactForceEvents(fn);
  }

  dispose(): void {
    this.synced.length = 0;
    this.world?.free();
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);
/** Centre, then four points around the capsule footprint. See `capsuleRest`. */
const RING_X = [0, 1, -1, 0, 0] as const;
const RING_Z = [0, 0, 0, 1, -1] as const;
