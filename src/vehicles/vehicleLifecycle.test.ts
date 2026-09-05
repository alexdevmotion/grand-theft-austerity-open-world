import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Services } from '../core/services';
import { VehicleSystem } from './vehicleSystem';

interface FakeVehicle {
  id: string;
  occupants: string[];
  entryReserved?: boolean;
  object: THREE.Object3D;
  collider: { handle: number };
  body: { token: string };
  damage: { dispose(): void };
  unbindAudio(ctx: GameContext): void;
}

class TrackingMap<K, V> extends Map<K, V> {
  constructor(
    private readonly deletion: string,
    private readonly calls: string[],
  ) {
    super();
  }

  override delete(key: K): boolean {
    this.calls.push(this.deletion);
    return super.delete(key);
  }
}

test('despawn refuses occupied cars and commits cleanup before freeing the body', () => {
  const calls: string[] = [];
  const system = new VehicleSystem();
  const vehicles = new TrackingMap<string, FakeVehicle>('vehicle-map', calls);
  const byCollider = new TrackingMap<number, FakeVehicle>('collider-map', calls);
  const list: FakeVehicle[] = [];

  const audio = {
    unbindEngine(id: string) {
      calls.push(`audio:${id}`);
    },
  };
  const ctx = {
    scene: {
      remove(object: THREE.Object3D) {
        expect(object.name).toBe('lifecycle-car');
        calls.push('scene');
      },
    },
    tryGet(key: { id: string }) {
      return key.id === Services.Audio.id ? audio : undefined;
    },
  } as unknown as GameContext;
  const phys = {
    world: {
      removeRigidBody(body: { token: string }) {
        expect(body.token).toBe('live-rapier-body');
        calls.push('body');
      },
    },
  };

  const vehicle: FakeVehicle = {
    id: 'veh_traffic_17',
    occupants: ['player'],
    object: Object.assign(new THREE.Object3D(), { name: 'lifecycle-car' }),
    collider: { handle: 917 },
    body: { token: 'live-rapier-body' },
    damage: { dispose: () => calls.push('damage') },
    unbindAudio(runtime) {
      runtime.tryGet(Services.Audio)?.unbindEngine(this.id);
    },
  };
  vehicles.set(vehicle.id, vehicle);
  byCollider.set(vehicle.collider.handle, vehicle);
  list.push(vehicle);

  const internals = system as unknown as {
    vehicles: Map<string, FakeVehicle>;
    byCollider: Map<number, FakeVehicle>;
    list: FakeVehicle[];
    ctx: GameContext;
    phys: typeof phys;
  };
  internals.vehicles = vehicles;
  internals.byCollider = byCollider;
  internals.list = list;
  internals.ctx = ctx;
  internals.phys = phys;

  // Occupancy is a hard transaction guard: absolutely nothing is touched.
  system.despawn(vehicle.id);
  expect(calls).toEqual([]);
  expect(system.get(vehicle.id)).toBe(vehicle);
  expect(system.all).toEqual([vehicle]);
  expect(byCollider.get(vehicle.collider.handle)).toBe(vehicle);

  // Once handed back, cache invalidation and collider lookup removal happen
  // before Rapier frees the body.  Every owning collection is then cleared.
  vehicle.occupants.length = 0;
  vehicle.entryReserved = true;
  system.despawn(vehicle.id);
  expect(calls).toEqual([]);
  expect(system.get(vehicle.id)).toBe(vehicle);
  vehicle.entryReserved = false;
  system.despawn(vehicle.id);
  expect(calls).toEqual([
    'audio:veh_traffic_17',
    'scene',
    'collider-map',
    'body',
    'damage',
    'vehicle-map',
  ]);
  expect(system.get(vehicle.id)).toBeUndefined();
  expect(system.all).toEqual([]);
  expect(byCollider.has(vehicle.collider.handle)).toBe(false);

  // Idempotent teardown cannot touch the freed handle a second time.
  system.despawn(vehicle.id);
  expect(calls).toHaveLength(6);
});
