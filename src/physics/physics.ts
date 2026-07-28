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

const ALL_SOLID = CG.STATIC | CG.TERRAIN | CG.VEHICLE | CG.CHARACTER | CG.PLAYER | CG.PROP | CG.DEBRIS;

export const GROUP = {
  staticWorld: groups(CG.STATIC, ALL_SOLID),
  terrain: groups(CG.TERRAIN, ALL_SOLID),
  vehicle: groups(CG.VEHICLE, ALL_SOLID | CG.SENSOR),
  character: groups(CG.CHARACTER, ALL_SOLID | CG.SENSOR),
  player: groups(CG.PLAYER, ALL_SOLID | CG.SENSOR),
  prop: groups(CG.PROP, ALL_SOLID),
  debris: groups(CG.DEBRIS, CG.STATIC | CG.TERRAIN),
  sensor: groups(CG.SENSOR, CG.PLAYER | CG.VEHICLE | CG.CHARACTER),
} as const;

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  colliderHandle: number;
  bodyHandle: number | null;
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

  createCharacterController(offset = 0.06): RAPIER.KinematicCharacterController {
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

  /** Ground probe straight down. Returns Y of the surface or null. */
  groundAt(x: number, z: number, fromY = 400, maxDistance = 800): number | null {
    _v.set(x, fromY, z);
    const hit = this.raycast(_v, DOWN, maxDistance, groups(CG.SENSOR, CG.STATIC | CG.TERRAIN));
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
