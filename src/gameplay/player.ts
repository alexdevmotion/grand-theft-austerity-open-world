/**
 * Player: kinematic character controller, vehicle enter/exit, health, money —
 * and Ilie Bolojan-Agatinei himself.
 *
 * The placeholder capsule is gone. The player now drives a real skinned
 * humanoid from `src/characters`: procedurally generated body, 22-bone rig,
 * speed-blended locomotion, foot IK against the collision world, additive
 * look-at, a punch, and a ragdoll on death. Movement itself is unchanged —
 * responsive walk/jog/sprint with slope and step handling — the character is
 * driven FROM the controller, never the other way round.
 *
 * OWNER: player/character agent.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { GameContext, System } from '../core/engine';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { CharacterFactory, HERO_APPEARANCE, type CharacterActor } from '../characters';
import {
  Services,
  type CharacterHandle,
  type Faction,
  type LocomotionState,
  type PlayerService,
  type VehicleClass,
  type VehicleHandle,
} from '../core/services';

const WALK = 2.1;
const JOG = 4.6;
const SPRINT = 7.4;
const CROUCH = 1.35;
const JUMP_SPEED = 5.1;
const GRAVITY = -21;

/** Hero stature — the collider is sized to match so he never floats or sinks. */
const HERO_HEIGHT = HERO_APPEARANCE.height;

/**
 * Seat anchors, per vehicle class: how far the driver's hip point sits above
 * the vehicle body origin, before the sit pose offset is applied. Derived from
 * the ride heights in `src/vehicles/bodies.ts`.
 */
const SEAT_RISE: Partial<Record<VehicleClass, number>> = {
  dacia: 0, sedan: 0, hatch: 0, police: 0, van: 0.29, truck: 0.49,
  bus: 0.33, tram: 0.05, scooter: 0.57,
};
/** Lateral seat position (matches the steering wheel in dacia.ts). */
const SEAT_X: Partial<Record<VehicleClass, number>> = {
  dacia: -0.34, scooter: 0, bus: -0.62, truck: -0.55, tram: 0,
};

class PlayerCharacter implements CharacterHandle {
  readonly id = 'player';
  readonly archetype = 'builder' as const;
  readonly faction: Faction = 'player';
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  health = 100;
  readonly maxHealth = 100;
  state: LocomotionState = 'idle';
  /** Set once the rigged actor exists. */
  actor: CharacterActor | null = null;

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
    this.actor?.playState(s);
  }
  ragdoll(impulse?: THREE.Vector3): void {
    this.state = 'ragdoll';
    this.actor?.ragdoll(impulse);
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
  private grounded = true;
  private wasGrounded = true;
  private airTime = 0;
  private _vehicle: VehicleHandle | null = null;
  private _lei = 3400;
  private spawnPoint = new THREE.Vector3(0, 2, 0);
  private enterCooldown = 0;

  private actor: CharacterActor | null = null;
  private planarSpeed = 0;
  private prevYaw = 0;
  private turnRate = 0;
  private crouching = false;
  private deathTimer = 0;
  private lookTarget: THREE.Vector3 | null = null;

  private readonly radius = 0.32;
  private readonly halfHeight = HERO_HEIGHT * 0.5 - 0.32;

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

    this.buildHero(ctx);
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

  /** ILIE BOLOJAN-AGATINEI — dark practical kit, one loud purple harness. */
  private buildHero(ctx: GameContext): void {
    const factory = CharacterFactory.of(ctx);
    this.actor = factory.create(HERO_APPEARANCE, { hero: true, seed: 11 });
    this.actor.footIk = true;
    this.character.actor = this.actor;
    this.character.object.add(this.actor.object);

    // Step-timed footfalls. Any system can hook the same callback shape; the
    // audio service gets them for free here.
    this.actor.onFootfall = (_foot, pos, intensity) => {
      ctx.tryGet(Services.Audio)?.oneShot('footstep', pos, 0.22 + intensity * 0.42);
    };
  }

  fixedUpdate(dt: number, ctx: GameContext): void {
    this.enterCooldown = Math.max(0, this.enterCooldown - dt);

    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      if (this.deathTimer <= 0) this.respawn();
      return;
    }

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

    this.crouching = input.action('crouch');
    const sprint = input.action('sprint') && !this.crouching;
    const speed = mag < 0.01
      ? 0
      : this.crouching ? CROUCH * Math.min(1, mag / 0.7)
      : sprint ? SPRINT
      : mag > 0.65 ? JOG
      : WALK;

    // Movement is relative to the camera yaw.
    const yaw = this.desiredYaw;
    // Camera-relative basis.
    //   forward F = ( sin(yaw), 0,  cos(yaw) )   — matches CameraSystem's rig
    //   right   R = F x up = (-cos(yaw), 0, sin(yaw))
    // The strafe terms used +R's negation, so A and D were swapped on screen.
    this._desired.set(
      Math.sin(yaw) * ay - Math.cos(yaw) * ax,
      0,
      Math.cos(yaw) * ay + Math.sin(yaw) * ax,
    );
    if (this._desired.lengthSq() > 0.0001) {
      this._desired.normalize().multiplyScalar(speed);
      // Face the direction of travel.
      const targetYaw = Math.atan2(this._desired.x, this._desired.z);
      this.character.object.rotation.y = dampAngle(this.character.object.rotation.y, targetYaw, 14, dt);
    }
    const yawNow = this.character.object.rotation.y;
    let dYaw = yawNow - this.prevYaw;
    while (dYaw > Math.PI) dYaw -= Math.PI * 2;
    while (dYaw < -Math.PI) dYaw += Math.PI * 2;
    this.turnRate = dYaw / Math.max(1e-4, dt);
    this.prevYaw = yawNow;

    if (this.grounded && input.action('jump') && !this.crouching) {
      this.velocityY = JUMP_SPEED;
      this.grounded = false;
      this.character.playState('jump');
    }
    this.velocityY = Math.max(-55, this.velocityY + GRAVITY * dt);

    this._move.set(this._desired.x * dt, this.velocityY * dt, this._desired.z * dt);

    this.controller.computeColliderMovement(this.collider, this._move);
    const corrected = this.controller.computedMovement();
    this.wasGrounded = this.grounded;
    this.grounded = this.controller.computedGrounded();
    const impactSpeed = this.velocityY;
    if (this.grounded && this.velocityY < 0) this.velocityY = 0;

    const t = this.body.translation();
    const nx = t.x + corrected.x;
    const ny = t.y + corrected.y;
    const nz = t.z + corrected.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });

    this.character.position.set(nx, ny - this.halfHeight - this.radius, nz);
    this.character.object.position.copy(this.character.position);
    this.character.object.quaternion.setFromAxisAngle(UP, yawNow);

    // Locomotion state for the animation system.
    const planar = Math.hypot(corrected.x, corrected.z) / Math.max(1e-4, dt);
    this.planarSpeed = Math.min(planar, SPRINT + 1);
    this.airTime = this.grounded ? 0 : this.airTime + dt;

    const landing = this.grounded && !this.wasGrounded && impactSpeed < -5.5;

    let state: LocomotionState;
    if (!this.grounded) {
      state = this.velocityY > 0.6 && this.airTime < 0.42 ? 'jump' : 'fall';
    } else if (landing) {
      state = 'land';
    } else if (this.crouching) {
      state = this.planarSpeed < 0.25 ? 'crouchIdle' : 'crouchWalk';
    } else if (this.planarSpeed < 0.25) {
      state = 'idle';
    } else if (this.planarSpeed > SPRINT - 1.2) {
      state = 'sprint';
    } else if (this.planarSpeed > WALK + 0.6) {
      state = 'jog';
    } else {
      state = 'walk';
    }
    if (this.character.state !== 'punch' || state !== 'idle') this.character.state = state;

    if (landing) {
      this.ctx.tryGet(Services.Camera)?.shake(Math.min(0.5, -impactSpeed * 0.03), 0.18);
    }

    if (ny < -30) this.respawn();

    if (ctx.input.actionPressed('punch')) this.character.playState('punch');

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
    this.character.state = 'drive';
    this.planarSpeed = 0;

    if (input.actionPressed('interact') && this.enterCooldown <= 0) this.exitVehicle();
    void dt;
  }

  /** Per-frame: pose the hero. Physics already ran this frame. */
  update(dt: number, ctx: GameContext): void {
    const actor = this.actor;
    if (!actor) return;

    if (this._vehicle) this.seatInVehicle(this._vehicle);

    actor.drive({
      state: this.character.state,
      speed: this.planarSpeed,
      grounded: this.grounded || this._vehicle !== null,
      turnRate: this.turnRate,
      steer: this._vehicle ? ctx.input.axes.steer : 0,
      verticalSpeed: this.velocityY,
    });
    actor.lookAt(this.lookTarget);
    actor.update(dt, ctx);
  }

  private _seat = new THREE.Vector3();

  private seatInVehicle(v: VehicleHandle): void {
    const scale = HERO_HEIGHT / 1.75;
    const rise = SEAT_RISE[v.kind] ?? 0;
    const sx = SEAT_X[v.kind] ?? -0.36;
    this._seat.set(sx, rise - 0.44 * scale, 0.04).applyQuaternion(v.rotation);
    this.character.object.position.copy(v.position).add(this._seat);
    this.character.object.quaternion.copy(v.rotation);
  }

  /** Point the hero's head and eyes at something. Pass null to release. */
  setLookTarget(p: THREE.Vector3 | null): void {
    this.lookTarget = p;
  }

  enterVehicle(v: VehicleHandle): void {
    if (this._vehicle) return;
    this._vehicle = v;
    (v.occupants as string[]).push('player');
    this.character.state = 'drive';
    this.enterCooldown = 0.45;
    this.seatInVehicle(v);
    this.ctx.events.emit('player:enteredVehicle', { vehicleId: v.id });
    this.ctx.tryGet(Services.Camera)?.setMode('vehicle');
  }

  exitVehicle(): void {
    const v = this._vehicle;
    if (!v) return;
    const idx = (v.occupants as string[]).indexOf('player');
    if (idx >= 0) (v.occupants as string[]).splice(idx, 1);

    // Step out to the driver's side, clear of the body.
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
    this.character.object.quaternion.setFromAxisAngle(UP, this.character.object.rotation.y);
    this.character.object.visible = true;
    this.character.state = 'idle';
    this._vehicle = null;
    this.velocityY = 0;
    this.enterCooldown = 0.45;
    this.ctx.events.emit('player:exitedVehicle', { vehicleId: v.id });
    this.ctx.tryGet(Services.Camera)?.setMode('thirdPerson');
  }

  applyDamage(amount: number, _source?: Faction, point?: THREE.Vector3): void {
    if (this.deathTimer > 0) return;
    this.character.applyDamage(amount);
    this.ctx.events.emit('player:damaged', { amount, health: this.character.health });
    if (this.character.health > 0) {
      if (amount > 18) this.character.playState('stagger');
      return;
    }
    // Death: collapse into a ragdoll, then respawn.
    const impulse = new THREE.Vector3(0, 2.2, 0);
    if (point) {
      impulse.add(this.character.position.clone().sub(point).setY(0).normalize().multiplyScalar(4.5));
    } else {
      impulse.z -= 3;
    }
    this.character.playState('die');
    this.actor?.ragdoll(impulse);
    this.deathTimer = 2.9;
    this.ctx.events.emit('player:died', { cause: 'damage' });
  }

  teleport(p: THREE.Vector3, headingRad = 0): void {
    this.body.setTranslation({ x: p.x, y: p.y + this.halfHeight + this.radius, z: p.z }, true);
    this.character.position.copy(p);
    this.character.object.position.copy(p);
    this.character.object.rotation.set(0, headingRad, 0);
    this.prevYaw = headingRad;
    this.velocityY = 0;
  }

  respawn(): void {
    if (this._vehicle) this.exitVehicle();
    this.character.health = this.character.maxHealth;
    this.deathTimer = 0;
    this.actor?.revive();
    this.character.state = 'idle';
    this.teleport(this.spawnPoint);
    this.ctx.events.emit('player:respawned', { position: this.spawnPoint.clone() });
  }

  addLei(delta: number, reason: string): void {
    this._lei = Math.max(0, this._lei + delta);
    this.ctx.events.emit('economy:changed', { lei: this._lei, delta, reason });
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * (1 - Math.exp(-lambda * dt));
}
