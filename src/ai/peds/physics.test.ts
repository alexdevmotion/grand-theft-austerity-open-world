import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import { Rng } from '../../core/rng';
import { GROUP, PhysicsWorld } from '../../physics/physics';
import { PedCollisionProxies, resolvePedSpawnPoint } from '../peds';
import { Ped } from './crowd';
import { makeAppearance } from './spawn';

async function physicsHarness(): Promise<{ ctx: GameContext; physics: PhysicsWorld }> {
  const services = new Map<string, unknown>();
  const ctx = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
    get: (key: { id: string }) => services.get(key.id),
    tryGet: (key: { id: string }) => services.get(key.id),
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
  } as unknown as GameContext;
  const physics = new PhysicsWorld();
  await physics.init(ctx);
  physics.world.gravity = { x: 0, y: 0, z: 0 };
  return { ctx, physics };
}

function pedAt(x: number, z: number, seed: string): Ped {
  const rng = new Rng(seed);
  const ped = new Ped();
  ped.reset('civilian', makeAppearance('civilian', rng), x, z, 0, 1.2, rng);
  return ped;
}

test('authored pedestrian spawns validate their final physical root before attachment', () => {
  const requested = new THREE.Vector3(3, 99, 4);
  const out = new THREE.Vector3();
  const spatial = {
    isBlocked: (x: number, z: number) => x === 3 && z === 4,
    groundHeight: () => 1.25,
  };

  expect(resolvePedSpawnPoint(
    spatial,
    (x) => x > 3 && x < 3.5,
    (x, z) => Math.hypot(x - 3, z - 4) < 0.7,
    requested,
    out,
  )).toBe(true);
  expect(spatial.isBlocked(out.x, out.z)).toBe(false);
  expect(Math.hypot(out.x - 3, out.z - 4)).toBeGreaterThanOrEqual(0.7);
  expect(out.y).toBe(1.25);
});

test('ped and dog collision proxies follow attach, sync, despawn, and pool reuse', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(1, 2, 'ped-proxy-lifecycle');
  ped.dog = {
    x: -2, y: 0, z: 4, yaw: 0.4, phase: 0,
    colour: new THREE.Color(0x554433), size: 1,
  };

  try {
    collisions.attach(ped);
    physics.world.step();

    expect(physics.world.bodies.len()).toBe(2);
    expect(physics.world.colliders.len()).toBe(2);
    expect(physics.world.bodies.getAll().map((body) => body.userData)).toEqual([
      { kind: 'ped', id: ped.id },
      { kind: 'ped-dog', id: ped.id },
    ]);

    ped.position.set(5, 0.2, -3);
    ped.dog.x = 7;
    ped.dog.z = -6;
    collisions.sync(ped);
    const targets = new Map(physics.world.bodies.getAll().map((body) => [
      (body.userData as { kind: string }).kind,
      body.nextTranslation(),
    ]));
    expect(targets.get('ped')?.x).toBeCloseTo(5, 8);
    expect(targets.get('ped')?.z).toBeCloseTo(-3, 8);
    expect(targets.get('ped-dog')?.x).toBeCloseTo(7, 8);
    expect(targets.get('ped-dog')?.z).toBeCloseTo(-6, 8);

    expect(ped.strikeByVehicle(1, 0, 13)).toBe(true);
    collisions.syncAll([ped]);
    expect(collisions.physicalState(ped)).toMatchObject({
      bodyType: 'dynamic',
      mass: 75,
      ccd: true,
    });

    collisions.detach(ped);
    expect(physics.world.bodies.len()).toBe(0);
    expect(physics.world.colliders.len()).toBe(0);

    // The pool reuses this same Ped instance and stable id without retaining
    // either the old dog proxy or its old transform.
    const rng = new Rng('ped-proxy-reuse');
    ped.reset('civilian', makeAppearance('civilian', rng), 11, -8, 0, 1.2, rng);
    collisions.attach(ped);
    expect(physics.world.bodies.len()).toBe(1);
    expect(physics.world.bodies.getAll()[0].translation().x).toBeCloseTo(11, 8);
    expect(physics.world.bodies.getAll()[0].translation().z).toBeCloseTo(-8, 8);
    expect(collisions.physicalState(ped)).toMatchObject({
      bodyType: 'kinematic',
      linearVelocity: [0, 0, 0],
    });
  } finally {
    collisions.dispose();
    expect(physics.world.bodies.len()).toBe(0);
    physics.dispose();
  }
});

test('a fatal vehicle strike launches an authoritative CCD body downstream and upward', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(0, 0, 'ped-fatal-dynamic-launch');

  try {
    collisions.attach(ped);
    expect(ped.strikeByVehicle(1, 0, 13)).toBe(true);
    expect(ped.isAlive).toBe(false);

    collisions.syncAll([ped]);
    const state = collisions.physicalState(ped);
    expect(state?.bodyType).toBe('dynamic');
    expect(state?.linearVelocity[0]).toBeGreaterThan(7);
    expect(state?.linearVelocity[1]).toBeGreaterThan(3.5);
    expect(state?.linearVelocity[2]).toBeCloseTo(0, 6);
    expect(state?.mass).toBeCloseTo(75, 3);
    expect(state?.ccd).toBe(true);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

for (const [label, group] of [
  ['building wall', GROUP.staticWorld],
  ['substantial prop', GROUP.prop],
] as const) {
  test(`a launched fatal body cannot tunnel through a ${label} and settles on terrain`, async () => {
    const { ctx, physics } = await physicsHarness();
    physics.world.gravity = { x: 0, y: -9.81, z: 0 };
    const collisions = new PedCollisionProxies(physics);
    const ped = pedAt(0, 0, `ped-fatal-${label}`);

    try {
      physics.addStaticBox(
        new THREE.Vector3(8, 0.1, 8),
        new THREE.Vector3(0, -0.1, 0),
        undefined,
        GROUP.terrain,
      );
      physics.addStaticBox(
        new THREE.Vector3(0.04, 1.5, 2),
        new THREE.Vector3(2, 1.5, 0),
        undefined,
        group,
      );
      collisions.attach(ped);
      expect(ped.strikeByVehicle(1, 0, 13)).toBe(true);
      collisions.syncAll([ped]);

      let furthestX = Number.NEGATIVE_INFINITY;
      for (let frame = 0; frame < 420; frame++) {
        physics.fixedUpdate(1 / 60, ctx);
        collisions.syncAll([ped]);
        furthestX = Math.max(furthestX, ped.position.x);
      }

      const settled = collisions.physicalState(ped);
      expect(furthestX).toBeLessThan(1.98);
      expect(ped.position.x).toBeLessThan(1.98);
      expect(ped.position.y).toBeGreaterThanOrEqual(0.29);
      expect(ped.position.y).toBeLessThan(0.6);
      expect(Math.abs(settled?.linearVelocity[1] ?? Infinity)).toBeLessThan(0.08);
      expect(settled?.sleeping).toBe(true);
    } finally {
      collisions.dispose();
      physics.dispose();
    }
  });
}

test('a settled downed body remains physically movable by a later vehicle impact', async () => {
  const { ctx, physics } = await physicsHarness();
  physics.world.gravity = { x: 0, y: -9.81, z: 0 };
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(0, 0, 'ped-dynamic-rehit');

  try {
    physics.addStaticBox(
      new THREE.Vector3(12, 0.1, 4),
      new THREE.Vector3(0, -0.1, 0),
      undefined,
      GROUP.terrain,
    );
    collisions.attach(ped);
    expect(ped.strikeByVehicle(0, 0, 5)).toBe(true);
    collisions.syncAll([ped]);
    for (let frame = 0; frame < 300; frame++) {
      physics.fixedUpdate(1 / 60, ctx);
      collisions.syncAll([ped]);
    }
    const before = ped.position.x;

    const vehicle = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.dynamic()
        .setTranslation(-3, 0.65, 0)
        .setLinvel(10, 0, 0)
        .setCcdEnabled(true),
    );
    physics.world.createCollider(
      physics.rapier.ColliderDesc.cuboid(0.7, 0.55, 0.8)
        .setCollisionGroups(GROUP.vehicle)
        .setMass(900),
      vehicle,
    );
    for (let frame = 0; frame < 90; frame++) {
      physics.fixedUpdate(1 / 60, ctx);
      collisions.syncAll([ped]);
    }

    expect(ped.position.x).toBeGreaterThan(before + 0.3);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('an active pedestrian collider stops both player and vehicle bodies', async () => {
  const { ctx, physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(0, 0, 'ped-proxy-contact');

  try {
    collisions.attach(ped);
    physics.world.step();
    const playerBody = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(-2, 0.9, 0),
    );
    const playerCollider = physics.world.createCollider(
      physics.rapier.ColliderDesc.capsule(0.58, 0.32).setCollisionGroups(GROUP.player),
      playerBody,
    );
    const controller = physics.createCharacterController();
    controller.computeColliderMovement(playerCollider, { x: 4, y: 0, z: 0 });
    const playerMovement = controller.computedMovement();
    expect(playerMovement.x).toBeGreaterThan(0);
    expect(playerMovement.x).toBeLessThan(1.5);
    physics.world.removeCharacterController(controller);
    physics.world.removeRigidBody(playerBody);

    const vehicle = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.dynamic()
        .setTranslation(-3, 0.75, 0)
        .setLinvel(12, 0, 0)
        .setCcdEnabled(true),
    );
    physics.world.createCollider(
      physics.rapier.ColliderDesc.cuboid(0.55, 0.55, 0.8)
        .setCollisionGroups(GROUP.vehicle)
        .setMass(900),
      vehicle,
    );
    for (let frame = 0; frame < 30; frame++) physics.fixedUpdate(1 / 60, ctx);

    expect(vehicle.translation().x).toBeGreaterThan(-3);
    expect(vehicle.translation().x).toBeLessThan(-0.75);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('a dog proxy stops the player at the visible dog rather than its distant owner', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const owner = pedAt(10, 0, 'dog-proxy-contact');
  owner.dog = {
    x: 0, y: 0, z: 0, yaw: Math.PI / 2, phase: 0,
    colour: new THREE.Color(0x554433), size: 1,
  };

  try {
    collisions.attach(owner);
    physics.world.step();
    const playerBody = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(-2, 0.4, 0),
    );
    const playerCollider = physics.world.createCollider(
      physics.rapier.ColliderDesc.capsule(0.12, 0.24).setCollisionGroups(GROUP.player),
      playerBody,
    );
    const controller = physics.createCharacterController();
    controller.computeColliderMovement(playerCollider, { x: 4, y: 0, z: 0 });

    expect(controller.computedMovement().x).toBeGreaterThan(0);
    expect(controller.computedMovement().x).toBeLessThan(1.6);
    physics.world.removeCharacterController(controller);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('ped movement proxy sweeps against both static walls and physical props', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(0, 0, 'ped-proxy-sweep');

  try {
    collisions.attach(ped);
    physics.addStaticBox(
      new THREE.Vector3(0.05, 1.5, 1),
      new THREE.Vector3(1.5, 1.5, 0),
      undefined,
      GROUP.staticWorld,
    );
    physics.addStaticBox(
      new THREE.Vector3(0.05, 1.5, 1),
      new THREE.Vector3(1.5, 1.5, 5),
      undefined,
      GROUP.prop,
    );
    physics.world.step();
    const out = new THREE.Vector2();

    const staticFraction = collisions.sweep(ped, 0, 0, 0, 3, 0, out);
    expect(staticFraction).toBeLessThan(1);
    expect(out.x).toBeLessThan(1.2);

    ped.position.set(0, 0, 5);
    collisions.snap(ped);
    const propFraction = collisions.sweep(ped, 0, 0, 5, 3, 0, out);
    expect(propFraction).toBeLessThan(1);
    expect(out.x).toBeLessThan(1.2);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('dog movement proxy sweeps against both static walls and physical props', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const owner = pedAt(10, 0, 'dog-proxy-sweep');
  owner.dog = {
    x: 0, y: 0, z: 0, yaw: Math.PI / 2, phase: 0,
    colour: new THREE.Color(0x554433), size: 1,
  };

  try {
    collisions.attach(owner);
    physics.addStaticBox(
      new THREE.Vector3(0.025, 1.5, 1),
      new THREE.Vector3(1.5, 1.5, 0),
      undefined,
      GROUP.staticWorld,
    );
    physics.addStaticBox(
      new THREE.Vector3(0.025, 1.5, 1),
      new THREE.Vector3(1.5, 1.5, 5),
      undefined,
      GROUP.prop,
    );
    physics.world.step();
    const out = new THREE.Vector2();

    const staticFraction = collisions.sweepDog(owner, 0, 0, 0, 3, 0, out);
    expect(staticFraction).toBeLessThan(1);
    expect(out.x).toBeLessThan(1.3);

    owner.dog.z = 5;
    collisions.snap(owner);
    const propFraction = collisions.sweepDog(owner, 0, 0, 5, 3, 0, out);
    expect(propFraction).toBeLessThan(1);
    expect(out.x).toBeLessThan(1.3);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('a high-dt dog lead move cannot tunnel through people or the player', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const owner = pedAt(10, 0, 'dog-actor-sweep-owner');
  owner.dog = {
    x: 0, y: 0, z: 0, yaw: Math.PI / 2, phase: 0,
    colour: new THREE.Color(0x554433), size: 1,
  };
  const other = pedAt(2, 0, 'dog-actor-sweep-ped');

  try {
    collisions.attach(owner);
    collisions.attach(other);
    physics.world.step();
    const out = new THREE.Vector2();
    const pedFraction = collisions.sweepDog(owner, 0, 0, 0, 4, 0, out);
    expect(pedFraction).toBeLessThan(1);
    expect(out.x).toBeLessThan(1.7);

    collisions.detach(other);
    const playerBody = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(2, 0.9, 0),
    );
    physics.world.createCollider(
      physics.rapier.ColliderDesc.capsule(0.58, 0.32).setCollisionGroups(GROUP.player),
      playerBody,
    );
    physics.world.propagateModifiedBodyPositionsToColliders();
    const playerFraction = collisions.sweepDog(owner, 0, 0, 0, 4, 0, out);
    expect(playerFraction).toBeLessThan(1);
    expect(out.x).toBeLessThan(1.7);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('a newly attached dog is not physically coincident with its owner', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const owner = pedAt(0, 0, 'dog-owner-initial-overlap');
  owner.dog = {
    x: 0, y: 0, z: 0, yaw: 0, phase: 0,
    colour: new THREE.Color(0x554433), size: 1,
  };

  try {
    collisions.attach(owner);
    physics.world.step();
    const colliders = physics.world.colliders.getAll();
    expect(colliders).toHaveLength(2);
    expect(physics.world.intersectionPair(colliders[0], colliders[1])).toBe(false);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('syncAll publishes the solved fixed-step pose immediately without a physics-step lag', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(0, 0, 'ped-proxy-no-lag');

  try {
    collisions.attach(ped);
    ped.position.set(7, 0, -4);
    collisions.syncAll([ped]);
    const body = physics.world.bodies.getAll()[0];
    expect(body.translation().x).toBeCloseTo(7, 8);
    expect(body.translation().z).toBeCloseTo(-4, 8);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});

test('a promoted ragdoll proxy treats the authored root as its capsule centre', async () => {
  const { physics } = await physicsHarness();
  const collisions = new PedCollisionProxies(physics);
  const ped = pedAt(0, 0, 'ped-ragdoll-centre');
  ped.knockDown(0, 0, 2);
  ped.ragdolled = true;
  ped.position.set(3, 0.82, -2);

  try {
    collisions.attach(ped);
    const body = physics.world.bodies.getAll()[0];
    expect(body.translation().x).toBeCloseTo(3, 8);
    expect(body.translation().y).toBeCloseTo(0.82, 6);
    expect(body.translation().z).toBeCloseTo(-2, 8);
  } finally {
    collisions.dispose();
    physics.dispose();
  }
});
