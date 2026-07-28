/**
 * Player: kinematic character controller, vehicle enter/exit, health, money.
 *
 * OWNER: player/character agent. Baseline delivers responsive walk/run/sprint,
 * slope + step handling, jumping, and vehicle entry. The agent must deliver a
 * real rigged Bolojan-Agatinei character, animation state machine with IK foot
 * placement, melee, aiming, ragdoll on death, and drive pose.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, System } from '../core/engine';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { Palette } from '../artDirection';
import {
  Services,
  type CharacterHandle,
  type Faction,
  type LocomotionState,
  type PlayerService,
  type VehicleHandle,
} from '../core/services';

const WALK = 2.1;
const JOG = 4.6;
const SPRINT = 7.4;
const JUMP_SPEED = 5.1;
const GRAVITY = -21;

class PlayerCharacter implements CharacterHandle {
  readonly id = 'player';
  readonly archetype = 'builder' as const;
  readonly faction: Faction = 'player';
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  health = 100;
  readonly maxHealth = 100;
  state: LocomotionState = 'idle';

  get isAlive(): boolean {
    return this.health > 0;
  }

  applyDamage(amount: number): void {
    this.health = Math.max(0, this.health - amount);
  }
  moveTo(): void {
    /* player is driven by input, not AI */
  }
  lookAt(target: THREE.Vector3): void {
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    this.object.rotation.y = Math.atan2(dx, dz);
  }
  playState(s: LocomotionState): void {
    this.state = s;
  }
  ragdoll(): void {
    this.state = 'ragdoll';
  }
}

export class PlayerSystem implements System, PlayerService {
  readonly name = 'player';
  readonly order = 200;

  readonly character = new PlayerCharacter();
  /** Yaw the character faces, radians. Camera writes this. */
  desiredYaw = 0;

  private ctx!: GameContext;
  private phys!: PhysicsWorld;
  private controller!: RAPIER.KinematicCharacterController;
  private body!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  private velocityY = 0;
  private grounded = false;
  private _vehicle: VehicleHandle | null = null;
  private _lei = 3400;
  private spawnPoint = new THREE.Vector3(0, 2, 0);
  private enterCooldown = 0;

  private readonly halfHeight = 0.62;
  private readonly radius = 0.34;

  get position(): THREE.Vector3 {
    return this.character.position;
  }
  get inVehicle(): VehicleHandle | null {
    return this._vehicle;
  }
  get isOnFoot(): boolean {
    return this._vehicle === null;
  }
  get health(): number {
    return this.character.health;
  }
  get maxHealth(): number {
    return this.character.maxHealth;
  }
  get lei(): number {
    return this._lei;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.get(Services.Physics);
    ctx.provide(Services.Player, this);

    const city = ctx.tryGet(Services.City);
    if (city) {
      const bh = city.landmarks.get('buildersHouse');
      if (bh) this.spawnPoint.set(bh.position.x + 8, 2, bh.position.z + 12);
    }

    this.buildPlaceholderMesh();
    ctx.scene.add(this.character.object);

    const bodyDesc = this.phys.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z);
    this.body = this.phys.world.createRigidBody(bodyDesc);
    const cDesc = this.phys.rapier.ColliderDesc
      .capsule(this.halfHeight, this.radius)
      .setCollisionGroups(GROUP.player);
    this.collider = this.phys.world.createCollider(cDesc, this.body);
    this.controller = this.phys.createCharacterController();

    this.character.position.copy(this.spawnPoint);
  }

  /** PLACEHOLDER MESH — replaced by the character agent's rigged model. */
  private buildPlaceholderMesh(): void {
    const g = this.character.object;
    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(this.radius, this.halfHeight * 1.6, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x1a1c2a, roughness: 0.78, metalness: 0.0 }),
    );
    torso.position.y = this.halfHeight + this.radius;
    torso.castShadow = true;
    g.add(torso);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x9c7b62, roughness: 0.62 }),
    );
    head.position.y = this.halfHeight * 2 + this.radius + 0.14;
    head.castShadow = true;
    g.add(head);
    const accent = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.06),
      new THREE.MeshStandardMaterial({
        color: Palette.builderPurple,
        emissive: Palette.builderPurple,
        emissiveIntensity: 1.6,
        roughness: 0.4,
      }),
    );
    accent.position.set(0.22, this.halfHeight * 1.5, 0.1);
    g.add(accent);
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    this.enterCooldown = Math.max(0, this.enterCooldown - dt);

    if (this._vehicle) {
      this.driveUpdate(dt, ctx);
      return;
    }
    this.walkUpdate(dt, ctx);
  }

  private _move = new THREE.Vector3();
  private _desired = new THREE.Vector3();

  private walkUpdate(dt: number, ctx: GameContext): void {
    const input = ctx.input;
    const ax = input.axes.moveX;
    const ay = input.axes.moveY;
    const mag = Math.min(1, Math.hypot(ax, ay));

    const sprint = input.action('sprint');
    const speed = mag < 0.01 ? 0 : sprint ? SPRINT : mag > 0.65 ? JOG : WALK;

    // Movement is relative to the camera yaw.
    const yaw = this.desiredYaw;
    this._desired.set(
      Math.sin(yaw) * ay + Math.cos(yaw) * ax,
      0,
      Math.cos(yaw) * ay - Math.sin(yaw) * ax,
    );
    if (this._desired.lengthSq() > 0.0001) {
      this._desired.normalize().multiplyScalar(speed);
      // Face the direction of travel.
      const targetYaw = Math.atan2(this._desired.x, this._desired.z);
      this.character.object.rotation.y = dampAngle(this.character.object.rotation.y, targetYaw, 14, dt);
    }

    if (this.grounded && input.action('jump')) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
    }
    this.velocityY = Math.max(-55, this.velocityY + GRAVITY * dt);

    this._move.set(this._desired.x * dt, this.velocityY * dt, this._desired.z * dt);

    this.controller.computeColliderMovement(this.collider, this._move);
    const corrected = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.velocityY < 0) this.velocityY = 0;

    const t = this.body.translation();
    const nx = t.x + corrected.x;
    const ny = t.y + corrected.y;
    const nz = t.z + corrected.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });

    this.character.position.set(nx, ny - this.halfHeight - this.radius, nz);
    this.character.object.position.copy(this.character.position);

    // Locomotion state for the animation system.
    const planar = Math.hypot(this._desired.x, this._desired.z);
    this.character.state = !this.grounded
      ? this.velocityY > 0 ? 'jump' : 'fall'
      : planar < 0.2 ? 'idle'
      : planar > SPRINT - 0.5 ? 'sprint'
      : planar > WALK + 0.6 ? 'jog'
      : 'walk';

    if (ny < -30) this.respawn();

    // Enter a nearby vehicle.
    if (input.actionPressed('interact') && this.enterCooldown <= 0) {
      const vehicles = ctx.tryGet(Services.Vehicles);
      const near = vehicles?.nearestEnterable(this.character.position, 3.6);
      if (near) this.enterVehicle(near);
    }
  }

  private driveUpdate(dt: number, ctx: GameContext): void {
    const v = this._vehicle!;
    const input = ctx.input;
    v.setControls(input.axes.throttle, input.axes.steer, input.handbrake);

    this.character.position.copy(v.position);
    this.character.object.visible = false;

    if (input.actionPressed('interact') && this.enterCooldown <= 0) this.exitVehicle();
    void dt;
  }

  enterVehicle(v: VehicleHandle): void {
    if (this._vehicle) return;
    this._vehicle = v;
    (v.occupants as string[]).push('player');
    this.character.object.visible = false;
    this.character.state = 'drive';
    this.enterCooldown = 0.45;
    this.ctx.events.emit('player:enteredVehicle', { vehicleId: v.id });
    this.ctx.tryGet(Services.Camera)?.setMode('vehicle');
  }

  exitVehicle(): void {
    const v = this._vehicle;
    if (!v) return;
    const idx = (v.occupants as string[]).indexOf('player');
    if (idx >= 0) (v.occupants as string[]).splice(idx, 1);

    // Step out to the driver's left, clear of the body.
    const side = new THREE.Vector3(-2.1, 0.4, 0).applyQuaternion(v.rotation);
    const p = v.position.clone().add(side);
    this.body.setNextKinematicTranslation({
      x: p.x,
      y: p.y + this.halfHeight + this.radius,
      z: p.z,
    });
    this.body.setTranslation({ x: p.x, y: p.y + this.halfHeight + this.radius, z: p.z }, true);
    this.character.position.copy(p);
    this.character.object.position.copy(p);
    this.character.object.visible = true;
    this.character.state = 'idle';
    this._vehicle = null;
    this.velocityY = 0;
    this.enterCooldown = 0.45;
    this.ctx.events.emit('player:exitedVehicle', { vehicleId: v.id });
    this.ctx.tryGet(Services.Camera)?.setMode('thirdPerson');
  }

  applyDamage(amount: number, _source?: Faction, _point?: THREE.Vector3): void {
    this.character.applyDamage(amount);
    this.ctx.events.emit('player:damaged', { amount, health: this.character.health });
    if (this.character.health <= 0) {
      this.ctx.events.emit('player:died', { cause: 'damage' });
      this.respawn();
    }
  }

  teleport(p: THREE.Vector3, headingRad = 0): void {
    this.body.setTranslation({ x: p.x, y: p.y + this.halfHeight + this.radius, z: p.z }, true);
    this.character.position.copy(p);
    this.character.object.position.copy(p);
    this.character.object.rotation.y = headingRad;
    this.velocityY = 0;
  }

  respawn(): void {
    if (this._vehicle) this.exitVehicle();
    this.character.health = this.character.maxHealth;
    this.teleport(this.spawnPoint);
    this.ctx.events.emit('player:respawned', { position: this.spawnPoint.clone() });
  }

  addLei(delta: number, reason: string): void {
    this._lei = Math.max(0, this._lei + delta);
    this.ctx.events.emit('economy:changed', { lei: this._lei, delta, reason });
  }
}

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}
