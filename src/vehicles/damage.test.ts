import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { EventBus } from '../core/events';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { DamageModel } from './damage';
import { incomingNormalSpeed, routeVehicleEnvironmentContact } from './vehicleSystem';

const IMPACT_POINT = new THREE.Vector3(0.4, 0.2, -0.7);
const CONTACT_LOCK_SECONDS = 0.22;
const CRASH_THRESHOLD = 20_000;
const MAX_SEVERITY_FORCE = 1_000_000;

test('three maximum-severity crashes wreck a 1000-health car', () => {
  const damage = new DamageModel(1_000);

  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(420);
  damage.tick(CONTACT_LOCK_SECONDS);
  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(420);
  damage.tick(CONTACT_LOCK_SECONDS);
  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(160);

  expect(damage.health).toBe(0);
  expect(damage.isWrecked).toBe(true);
});

test('the contact lock ignores an immediate duplicate impact', () => {
  const damage = new DamageModel(1_000);

  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(420);
  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(0);
  expect(damage.health).toBe(580);

  damage.tick(CONTACT_LOCK_SECONDS);
  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(420);
  expect(damage.health).toBe(160);
});

test('a below-threshold contact is harmless and does not lock out a later crash', () => {
  const damage = new DamageModel(1_000);

  expect(damage.impact(IMPACT_POINT, CRASH_THRESHOLD - 1, CRASH_THRESHOLD)).toBe(0);
  expect(damage.health).toBe(1_000);
  expect(damage.impact(IMPACT_POINT, MAX_SEVERITY_FORCE, CRASH_THRESHOLD)).toBe(420);
});

test('separated low-severity impacts accumulate', () => {
  const damage = new DamageModel(1_000);

  for (let hit = 0; hit < 5; hit++) {
    expect(damage.impact(IMPACT_POINT, 40_000, CRASH_THRESHOLD)).toBe(18);
    damage.tick(CONTACT_LOCK_SECONDS);
  }

  expect(damage.health).toBe(910);
});

test('separated moderate impacts accumulate', () => {
  const damage = new DamageModel(1_000);

  for (let hit = 0; hit < 4; hit++) {
    expect(damage.impact(IMPACT_POINT, 120_000, CRASH_THRESHOLD)).toBe(90);
    damage.tick(CONTACT_LOCK_SECONDS);
  }

  expect(damage.health).toBe(640);
});

test('direct damage and repair keep health within zero and max health', () => {
  const damage = new DamageModel(1_000);

  damage.applyDamage(600);
  expect(damage.health).toBe(400);

  damage.applyDamage(-900);
  expect(damage.health).toBe(1_000);

  damage.applyDamage(1_200);
  expect(damage.health).toBe(0);
});

test('flushing a dent keeps shared vehicle geometry pristine', () => {
  const sharedGeometry = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  const sharedPositions = Array.from(sharedGeometry.attributes.position.array);
  const hitMesh = new THREE.Mesh(sharedGeometry);
  const untouchedMesh = new THREE.Mesh(sharedGeometry);
  const damage = new DamageModel(1_000);

  damage.impact(new THREE.Vector3(1, 0, 0), MAX_SEVERITY_FORCE, CRASH_THRESHOLD);
  damage.flush(hitMesh, 0);

  expect(hitMesh.geometry).not.toBe(sharedGeometry);
  expect(untouchedMesh.geometry).toBe(sharedGeometry);
  expect(Array.from(sharedGeometry.attributes.position.array)).toEqual(sharedPositions);

  damage.dispose();
  sharedGeometry.dispose();
});

test('crash eligibility uses incoming speed projected onto the contact normal', () => {
  // Real Rapier 0.19.3 reproduction: a 12 m/s car is almost stopped by a pole
  // and two equal cars leave with nearly matching post-solver velocities.
  expect(incomingNormalSpeed({ x: 12, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toBe(12);
  expect(incomingNormalSpeed(
    { x: 12, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  )).toBe(12);
  expect(incomingNormalSpeed(
    { x: 5.5075, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 6.4925, y: 0, z: 0 },
  )).toBeCloseTo(0.985, 3);
  // Fast tangential motion is a scrape, not another damaging crash episode.
  expect(incomingNormalSpeed(
    { x: 0.2, y: 0, z: 12 },
    { x: 1, y: 0, z: 0 },
  )).toBeCloseTo(0.2, 6);
});

test('a real Rapier pole impact remains eligible after the solver stops the car', async () => {
  const services = new Map<string, unknown>();
  const ctx = {
    scene: new THREE.Scene(),
    events: new EventBus(),
    provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
    get: (key: { id: string }) => services.get(key.id),
    tryGet: (key: { id: string }) => services.get(key.id),
  } as unknown as GameContext;
  const physics = new PhysicsWorld();
  await physics.init(ctx);
  try {
    const body = physics.world.createRigidBody(
      physics.rapier.RigidBodyDesc.dynamic()
        .setTranslation(-3, 1, 0)
        .setLinvel(12, 0, 0)
        .setCcdEnabled(true),
    );
    const vehicle = physics.world.createCollider(
      physics.rapier.ColliderDesc.cuboid(0.95, 0.65, 0.9)
        .setCollisionGroups(GROUP.vehicle)
        .setMass(950)
        .setActiveEvents(physics.rapier.ActiveEvents.CONTACT_FORCE_EVENTS),
      body,
    );
    const pole = physics.addStaticBox(
      new THREE.Vector3(0.17, 4.2, 0.17),
      new THREE.Vector3(0, 4.2, 0),
      undefined,
      GROUP.prop,
    );

    let routed = false;
    let force = 0;
    let incomingAtContact = new THREE.Vector3();
    for (let frame = 0; frame < 30 && !routed; frame++) {
      const before = body.linvel();
      incomingAtContact.set(before.x, before.y, before.z);
      physics.fixedUpdate(1 / 60, ctx);
      physics.drainContactForceEvents((event) => {
        const direction = event.maxForceDirection();
        force = event.totalForceMagnitude();
        const result = routeVehicleEnvironmentContact({
          impact: (handle) => handle === pole.handle ? 'broken' : 'ignored',
        } as never, {
          collider1: vehicle.handle,
          collider2: pole.handle,
          vehicleOnFirst: true,
          force,
          direction: new THREE.Vector3(direction.x, direction.y, direction.z),
          normalSpeed: incomingNormalSpeed(incomingAtContact, direction),
          settled: true,
          parked: false,
        });
        routed = result === 'broken';
      });
    }

    const after = body.linvel();
    expect(force).toBeGreaterThan(28_000);
    expect(incomingAtContact.length()).toBeGreaterThan(4);
    expect(Math.hypot(after.x, after.y, after.z)).toBeLessThan(4);
    expect(routed).toBe(true);
  } finally {
    physics.dispose();
  }
});
