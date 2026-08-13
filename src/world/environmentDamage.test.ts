import { afterEach, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { EventBus } from '../core/events';
import { Services, type EnvironmentDamageService } from '../core/services';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { routeVehicleEnvironmentContact } from '../vehicles/vehicleSystem';
import {
  BREAKABLE_POLE_FORCE,
  EnvironmentDamageSystem,
} from './environmentDamage';

interface Harness {
  ctx: GameContext;
  physics: PhysicsWorld;
  system: EnvironmentDamageSystem;
  service: EnvironmentDamageService;
  dispose(): void;
}

const live: Harness[] = [];

async function harness(debrisLimit = 3): Promise<Harness> {
  const values = new Map<string, unknown>();
  const scene = new THREE.Scene();
  const events = new EventBus();
  const ctx = {
    scene,
    events,
    provide: <T>(key: { id: string }, value: T) => { values.set(key.id, value); },
    get: <T>(key: { id: string }) => {
      const value = values.get(key.id);
      if (value === undefined) throw new Error(`missing test service ${key.id}`);
      return value as T;
    },
    tryGet: <T>(key: { id: string }) => values.get(key.id) as T | undefined,
  } as unknown as GameContext;

  const physics = new PhysicsWorld();
  await physics.init(ctx);
  const system = new EnvironmentDamageSystem({ debrisLimit });
  system.init(ctx);
  const service = ctx.get(Services.EnvironmentDamage);
  const result: Harness = {
    ctx,
    physics,
    system,
    service,
    dispose: () => {
      system.dispose();
      physics.dispose();
    },
  };
  live.push(result);
  return result;
}

function registerPole(
  h: Harness,
  id: string,
  x = 0,
): { handle: number; visible: () => boolean } {
  const position = new THREE.Vector3(x, 0.17, 0);
  const collider = h.physics.addStaticBox(
    new THREE.Vector3(0.17, 4.2, 0.17),
    new THREE.Vector3(x, 4.37, 0),
    undefined,
    GROUP.prop,
  );
  let intactVisible = true;
  h.service.registerBreakablePole({
    id,
    colliderHandle: collider.handle,
    position,
    height: 8.4,
    inward: new THREE.Vector3(1, 0, 0),
    setIntactVisible: (visible) => { intactVisible = visible; },
  });
  return { handle: collider.handle, visible: () => intactVisible };
}

afterEach(() => {
  while (live.length) live.pop()!.dispose();
});

describe('breakable environment poles', () => {
  test('a low-force contact leaves the registered pole and its collider intact', async () => {
    const h = await harness();
    const pole = registerPole(h, 'lamp-low');
    let events = 0;
    h.ctx.events.on('prop:broken', () => { events++; });

    const result = h.service.impact(
      pole.handle,
      BREAKABLE_POLE_FORCE - 1,
      new THREE.Vector3(1, 0, 0),
    );

    expect(result).toBe('resisted');
    expect(h.service.getPole('lamp-low')?.broken).toBe(false);
    expect(pole.visible()).toBe(true);
    expect(h.physics.world.colliders.contains(pole.handle)).toBe(true);
    expect(h.service.stats.activeDebris).toBe(0);
    expect(events).toBe(0);
  });

  test('a road-speed impact breaks exactly one registered pole exactly once', async () => {
    const h = await harness();
    const struck = registerPole(h, 'lamp-struck', 0);
    const neighbour = registerPole(h, 'lamp-neighbour', 12);
    const events: Array<{ kind: string; position: THREE.Vector3 }> = [];
    h.ctx.events.on('prop:broken', (event) => { events.push(event); });

    expect(h.service.impact(
      struck.handle,
      BREAKABLE_POLE_FORCE,
      new THREE.Vector3(1, 0, 0),
    )).toBe('broken');
    expect(h.service.impact(
      struck.handle,
      BREAKABLE_POLE_FORCE * 2,
      new THREE.Vector3(1, 0, 0),
    )).toBe('already-broken');

    expect(h.service.getPole('lamp-struck')?.broken).toBe(true);
    expect(struck.visible()).toBe(false);
    expect(h.physics.world.colliders.contains(struck.handle)).toBe(false);
    expect(h.service.stats.activeDebris).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('street-lamp');
    expect(events[0].position.toArray()).toEqual([0, 0.17, 0]);

    expect(h.service.getPole('lamp-neighbour')?.broken).toBe(false);
    expect(neighbour.visible()).toBe(true);
    expect(h.physics.world.colliders.contains(neighbour.handle)).toBe(true);
  });

  test('the replacement pole is a real dynamic body that topples after impact', async () => {
    const h = await harness();
    const pole = registerPole(h, 'lamp-topple');
    h.physics.addStaticBox(
      new THREE.Vector3(20, 0.1, 20),
      new THREE.Vector3(0, -0.1, 0),
      undefined,
      GROUP.terrain,
    );

    h.service.impact(
      pole.handle,
      BREAKABLE_POLE_FORCE * 1.2,
      new THREE.Vector3(1, 0, 0),
    );
    const atBreak = h.service.getPole('lamp-topple')?.debris;
    expect(atBreak).not.toBeNull();

    for (let i = 0; i < 45; i++) {
      h.physics.fixedUpdate(1 / 60, h.ctx);
      h.system.fixedUpdate(1 / 60, h.ctx);
    }

    const fallen = h.service.getPole('lamp-topple')?.debris;
    expect(fallen).not.toBeNull();
    expect(fallen!.upY).toBeLessThan(0.82);
    expect(fallen!.position.y).toBeLessThan(atBreak!.position.y);
  });

  test('falling replacements stay bounded and reset restores every intact slot', async () => {
    const h = await harness(2);
    const first = registerPole(h, 'lamp-one', -8);
    const second = registerPole(h, 'lamp-two', 0);
    const third = registerPole(h, 'lamp-three', 8);

    for (const pole of [first, second, third]) {
      expect(h.service.impact(
        pole.handle,
        BREAKABLE_POLE_FORCE,
        new THREE.Vector3(0, 0, 1),
      )).toBe('broken');
    }

    expect(h.service.stats).toEqual({
      registeredPoles: 3,
      brokenPoles: 3,
      activeDebris: 2,
      debrisLimit: 2,
    });
    expect(h.service.getPole('lamp-one')?.debris).toBeNull();
    expect(h.service.getPole('lamp-two')?.debris).not.toBeNull();
    expect(h.service.getPole('lamp-three')?.debris).not.toBeNull();

    h.service.reset();

    expect(h.service.stats.brokenPoles).toBe(0);
    expect(h.service.stats.activeDebris).toBe(0);
    expect(first.visible()).toBe(true);
    expect(second.visible()).toBe(true);
    expect(third.visible()).toBe(true);
    for (const id of ['lamp-one', 'lamp-two', 'lamp-three']) {
      const state = h.service.getPole(id)!;
      expect(state.broken).toBe(false);
      expect(state.colliderHandle).not.toBeNull();
      expect(h.physics.world.colliders.contains(state.colliderHandle!)).toBe(true);
    }
  });

  test('even a huge vehicle force cannot damage an unregistered building collider', async () => {
    const h = await harness();
    const building = h.physics.addStaticBox(
      new THREE.Vector3(8, 15, 8),
      new THREE.Vector3(30, 15, 30),
    );

    expect(h.service.impact(
      building.handle,
      BREAKABLE_POLE_FORCE * 100,
      new THREE.Vector3(1, 0, 0),
    )).toBe('ignored');
    expect(h.physics.world.colliders.contains(building.handle)).toBe(true);
    expect(h.service.stats.registeredPoles).toBe(0);
    expect(h.service.stats.brokenPoles).toBe(0);
  });

  test('vehicle contact routing selects only the non-vehicle collider and rejects resting force', async () => {
    const h = await harness();
    const first = registerPole(h, 'lamp-route-first', -4);
    const second = registerPole(h, 'lamp-route-second', 4);
    const resting = registerPole(h, 'lamp-route-resting', 12);

    expect(routeVehicleEnvironmentContact(h.service, {
      collider1: 9001,
      collider2: first.handle,
      vehicleOnFirst: true,
      force: BREAKABLE_POLE_FORCE,
      direction: new THREE.Vector3(1, 0, 0),
      normalSpeed: 8,
      settled: true,
      parked: false,
    })).toBe('broken');
    expect(routeVehicleEnvironmentContact(h.service, {
      collider1: second.handle,
      collider2: 9002,
      vehicleOnFirst: false,
      force: BREAKABLE_POLE_FORCE,
      direction: new THREE.Vector3(-1, 0, 0),
      normalSpeed: 8,
      settled: true,
      parked: false,
    })).toBe('broken');
    expect(routeVehicleEnvironmentContact(h.service, {
      collider1: 9003,
      collider2: resting.handle,
      vehicleOnFirst: true,
      force: BREAKABLE_POLE_FORCE * 4,
      direction: new THREE.Vector3(1, 0, 0),
      normalSpeed: 0.2,
      settled: true,
      parked: false,
    })).toBe('ignored');
    expect(h.service.getPole('lamp-route-resting')?.broken).toBe(false);
  });
});
