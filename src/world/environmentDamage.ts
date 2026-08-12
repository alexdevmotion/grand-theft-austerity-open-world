import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, System } from '../core/engine';
import {
  Services,
  type BreakablePoleRegistration,
  type BreakablePoleState,
  type EnvironmentDamageService,
  type EnvironmentDamageStats,
  type EnvironmentImpactResult,
} from '../core/services';
import { GROUP, type PhysicsWorld } from '../physics/physics';

/** A parked vehicle cannot reach this; an intentional road-speed hit can. */
export const BREAKABLE_POLE_FORCE = 28_000;

interface PoleRecord {
  readonly id: string;
  colliderHandle: number | null;
  readonly position: THREE.Vector3;
  readonly height: number;
  readonly inward: THREE.Vector3;
  readonly setIntactVisible: (visible: boolean) => void;
  broken: boolean;
}

interface PoleDebris {
  readonly root: THREE.Group;
  body: RAPIER.RigidBody | null;
  poleId: string | null;
  born: number;
}

interface PoleQaSnapshot {
  id: string;
  colliderHandle: number | null;
  broken: boolean;
  height: number;
  position: { x: number; y: number; z: number };
  debris: { x: number; y: number; z: number; upY: number } | null;
}

interface PoleQaSurface {
  stats(): EnvironmentDamageStats;
  list(limit?: number): PoleQaSnapshot[];
  nearest(x?: number, z?: number): (PoleQaSnapshot & { distance: number }) | null;
  hit(id: string, force?: number, dx?: number, dz?: number): EnvironmentImpactResult;
  break(id: string, dx?: number, dz?: number): EnvironmentImpactResult;
  reset(): EnvironmentDamageStats;
}

export interface EnvironmentDamageOptions {
  debrisLimit?: number;
}

/** Owns only explicitly registered breakable props; buildings never enter it. */
export class EnvironmentDamageSystem implements System, EnvironmentDamageService {
  readonly name = 'environmentDamage';
  readonly order = 18;

  private readonly debrisLimit: number;
  private readonly byCollider = new Map<number, PoleRecord>();
  private readonly byId = new Map<string, PoleRecord>();
  private readonly debris: PoleDebris[] = [];
  private readonly root = new THREE.Group();
  private readonly trunkGeometry = new THREE.CylinderGeometry(0.13, 0.16, 1, 5);
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly metalMaterial = new THREE.MeshStandardMaterial({
    color: 0x34343d,
    metalness: 0.78,
    roughness: 0.4,
  });
  private readonly headMaterial = new THREE.MeshStandardMaterial({
    color: 0xc7bd9e,
    emissive: 0xff9d28,
    emissiveIntensity: 1.8,
    metalness: 0.45,
    roughness: 0.38,
  });
  private ctx!: GameContext;
  private physics!: PhysicsWorld;
  private debrisClock = 0;
  private offGameStarted: (() => void) | null = null;
  private qa: PoleQaSurface | null = null;

  constructor(options: EnvironmentDamageOptions = {}) {
    this.debrisLimit = Math.max(1, Math.floor(options.debrisLimit ?? 24));
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.physics = ctx.get(Services.Physics);
    ctx.provide(Services.EnvironmentDamage, this);
    this.root.name = 'breakable-pole-debris';
    ctx.scene.add(this.root);
    this.offGameStarted = ctx.events.on('game:started', () => this.reset());
    this.installQaSurface();
  }

  registerBreakablePole(pole: BreakablePoleRegistration): void {
    const old = this.byId.get(pole.id);
    if (old && old.colliderHandle !== null) this.byCollider.delete(old.colliderHandle);
    const record: PoleRecord = {
      id: pole.id,
      colliderHandle: pole.colliderHandle,
      position: pole.position.clone(),
      height: pole.height,
      inward: pole.inward.clone(),
      setIntactVisible: pole.setIntactVisible,
      broken: false,
    };
    this.byId.set(record.id, record);
    this.byCollider.set(record.colliderHandle!, record);
  }

  impact(colliderHandle: number, force: number, direction: THREE.Vector3): EnvironmentImpactResult {
    const pole = this.byCollider.get(colliderHandle);
    if (!pole) return 'ignored';
    if (pole.broken) return 'already-broken';
    if (!Number.isFinite(force) || force < BREAKABLE_POLE_FORCE) return 'resisted';

    // Mark first: every later operation is feedback for this one irreversible
    // transaction, so a callback can never re-enter and emit a second break.
    pole.broken = true;
    pole.colliderHandle = null;
    const collider = this.physics.world.getCollider(colliderHandle);
    pole.setIntactVisible(false);
    // Allocate the falling body's collider before releasing the static handle.
    // Rapier aggressively reuses freed handles; preserving this order makes the
    // authored handle observably disappear instead of immediately naming the
    // replacement debris collider.
    this.spawnDebris(pole, force, direction);
    if (collider) this.physics.world.removeCollider(collider, true);
    this.ctx.events.emit('prop:broken', {
      kind: 'street-lamp',
      position: pole.position.clone(),
    });
    return 'broken';
  }

  getPole(id: string): BreakablePoleState | undefined {
    const pole = this.byId.get(id);
    if (!pole) return undefined;
    const slot = this.debris.find((candidate) => candidate.poleId === id && candidate.body);
    const debris = slot?.body
      ? (() => {
          const translation = slot.body!.translation();
          const rotation = slot.body!.rotation();
          const quaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
          return {
            position: new THREE.Vector3(translation.x, translation.y, translation.z),
            rotation: quaternion,
            upY: new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).y,
          };
        })()
      : null;
    return {
      id: pole.id,
      colliderHandle: pole.colliderHandle,
      position: pole.position.clone(),
      height: pole.height,
      broken: pole.broken,
      debris,
    };
  }

  get stats(): EnvironmentDamageStats {
    let brokenPoles = 0;
    for (const pole of this.byId.values()) if (pole.broken) brokenPoles++;
    return {
      registeredPoles: this.byId.size,
      brokenPoles,
      activeDebris: this.debris.reduce((n, slot) => n + (slot.body ? 1 : 0), 0),
      debrisLimit: this.debrisLimit,
    };
  }

  fixedUpdate(_dt: number): void {
    for (const slot of this.debris) {
      if (!slot.body) continue;
      const position = slot.body.translation();
      const rotation = slot.body.rotation();
      slot.root.position.set(position.x, position.y, position.z);
      slot.root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    }
  }

  reset(): void {
    this.clearDebris();
    this.byCollider.clear();
    for (const pole of this.byId.values()) {
      if (pole.broken || pole.colliderHandle === null) {
        const collider = this.physics.addStaticBox(
          new THREE.Vector3(0.17, pole.height / 2, 0.17),
          new THREE.Vector3(
            pole.position.x,
            pole.position.y + pole.height / 2,
            pole.position.z,
          ),
          undefined,
          GROUP.prop,
        );
        pole.colliderHandle = collider.handle;
      }
      pole.broken = false;
      pole.setIntactVisible(true);
      this.byCollider.set(pole.colliderHandle!, pole);
    }
  }

  private spawnDebris(pole: PoleRecord, force: number, direction: THREE.Vector3): void {
    const slot = this.acquireDebris();
    const horizontal = new THREE.Vector3(direction.x, 0, direction.z);
    if (horizontal.lengthSq() < 1e-6) horizontal.copy(pole.inward).setY(0);
    if (horizontal.lengthSq() < 1e-6) horizontal.set(1, 0, 0);
    horizontal.normalize();

    this.configureDebrisVisual(slot.root, pole.height);
    const yaw = -Math.atan2(pole.inward.z, pole.inward.x);
    const rotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yaw,
    );
    const centre = new THREE.Vector3(
      pole.position.x,
      pole.position.y + pole.height / 2,
      pole.position.z,
    );
    const body = this.physics.world.createRigidBody(
      this.physics.rapier.RigidBodyDesc.dynamic()
        .setTranslation(centre.x, centre.y, centre.z)
        .setRotation(rotation)
        .setLinearDamping(0.08)
        .setAngularDamping(0.12)
        .setCcdEnabled(true),
    );
    this.physics.world.createCollider(
      this.physics.rapier.ColliderDesc
        .cuboid(0.14, pole.height / 2, 0.14)
        .setCollisionGroups(GROUP.debris)
        .setMass(72)
        .setFriction(0.72)
        .setRestitution(0.08),
      body,
    );

    const strength = THREE.MathUtils.clamp(force / BREAKABLE_POLE_FORCE, 1, 2.4);
    const impulse = horizontal.multiplyScalar(270 * strength);
    body.applyImpulseAtPoint(
      { x: impulse.x, y: 38 * strength, z: impulse.z },
      {
        x: pole.position.x,
        y: pole.position.y + pole.height * 0.86,
        z: pole.position.z,
      },
      true,
    );

    slot.body = body;
    slot.poleId = pole.id;
    slot.born = ++this.debrisClock;
    slot.root.position.copy(centre);
    slot.root.quaternion.copy(rotation);
    slot.root.visible = true;
    slot.root.userData.poleId = pole.id;
  }

  private acquireDebris(): PoleDebris {
    let slot = this.debris.find((candidate) => !candidate.body);
    if (!slot && this.debris.length < this.debrisLimit) {
      const root = new THREE.Group();
      root.name = `breakable-pole-debris-${this.debris.length}`;
      root.visible = false;
      const trunk = new THREE.Mesh(this.trunkGeometry, this.metalMaterial);
      trunk.name = 'trunk';
      const arm = new THREE.Mesh(this.boxGeometry, this.metalMaterial);
      arm.name = 'arm';
      const head = new THREE.Mesh(this.boxGeometry, this.headMaterial);
      head.name = 'head';
      root.add(trunk, arm, head);
      this.root.add(root);
      slot = { root, body: null, poleId: null, born: 0 };
      this.debris.push(slot);
    }
    if (!slot) {
      slot = this.debris.reduce((oldest, candidate) =>
        candidate.born < oldest.born ? candidate : oldest,
      );
      this.removeDebrisBody(slot);
    }
    return slot;
  }

  private configureDebrisVisual(root: THREE.Group, height: number): void {
    const trunk = root.getObjectByName('trunk') as THREE.Mesh;
    const arm = root.getObjectByName('arm') as THREE.Mesh;
    const head = root.getObjectByName('head') as THREE.Mesh;
    trunk.position.set(0, 0, 0);
    trunk.scale.set(1, height, 1);
    arm.position.set(0.95, height / 2 + 0.34, 0);
    arm.scale.set(1.9, 0.12, 0.12);
    head.position.set(1.9, height / 2 + 0.6, 0);
    head.scale.set(0.95, 0.18, 0.42);
  }

  private removeDebrisBody(slot: PoleDebris): void {
    if (slot.body) this.physics.world.removeRigidBody(slot.body);
    slot.body = null;
    slot.poleId = null;
    slot.root.visible = false;
    delete slot.root.userData.poleId;
  }

  private clearDebris(): void {
    for (const slot of this.debris) this.removeDebrisBody(slot);
  }

  private snapshot(pole: PoleRecord): PoleQaSnapshot {
    const state = this.getPole(pole.id)!;
    return {
      id: state.id,
      colliderHandle: state.colliderHandle,
      broken: state.broken,
      height: state.height,
      position: { x: state.position.x, y: state.position.y, z: state.position.z },
      debris: state.debris ? {
        x: state.debris.position.x,
        y: state.debris.position.y,
        z: state.debris.position.z,
        upY: state.debris.upY,
      } : null,
    };
  }

  private installQaSurface(): void {
    if (typeof window === 'undefined') return;
    const qa: PoleQaSurface = {
      stats: () => ({ ...this.stats }),
      list: (limit = 40) => Array.from(this.byId.values())
        .slice(0, THREE.MathUtils.clamp(Math.floor(limit), 0, 200))
        .map((pole) => this.snapshot(pole)),
      nearest: (x, z) => {
        const origin = new THREE.Vector3();
        if (Number.isFinite(x) && Number.isFinite(z)) origin.set(x!, 0, z!);
        else this.ctx.camera.getWorldPosition(origin);
        let best: PoleRecord | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const pole of this.byId.values()) {
          const distance = Math.hypot(pole.position.x - origin.x, pole.position.z - origin.z);
          if (distance >= bestDistance) continue;
          best = pole;
          bestDistance = distance;
        }
        return best ? { ...this.snapshot(best), distance: bestDistance } : null;
      },
      hit: (id, force = BREAKABLE_POLE_FORCE * 1.15, dx = 1, dz = 0) => {
        const pole = this.byId.get(id);
        if (!pole) return 'ignored';
        if (pole.broken || pole.colliderHandle === null) return 'already-broken';
        return this.impact(pole.colliderHandle, force, new THREE.Vector3(dx, 0, dz));
      },
      break: (id, dx = 1, dz = 0) => qa.hit(id, BREAKABLE_POLE_FORCE, dx, dz),
      reset: () => {
        this.reset();
        return { ...this.stats };
      },
    };
    this.qa = qa;
    (window as unknown as { __GTA_POLES__: PoleQaSurface }).__GTA_POLES__ = qa;
  }

  dispose(): void {
    // In the real engine PhysicsWorld disposes first; its freed world already
    // owns/frees these bodies. Tests and isolated hosts may dispose us first.
    try { this.clearDebris(); } catch { /* physics world is already gone */ }
    this.root.removeFromParent();
    this.root.clear();
    this.trunkGeometry.dispose();
    this.boxGeometry.dispose();
    this.metalMaterial.dispose();
    this.headMaterial.dispose();
    this.offGameStarted?.();
    this.offGameStarted = null;
    if (typeof window !== 'undefined') {
      const holder = window as unknown as { __GTA_POLES__?: PoleQaSurface };
      if (holder.__GTA_POLES__ === this.qa) delete holder.__GTA_POLES__;
    }
    this.qa = null;
    this.byCollider.clear();
    this.byId.clear();
  }
}
