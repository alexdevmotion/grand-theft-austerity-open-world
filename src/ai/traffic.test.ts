import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Rng } from '../core/rng';
import { Services, type CityService, type VehicleHandle, type VehicleService } from '../core/services';
import { TrafficSystem } from './traffic';
import { TrafficGraph } from './traffic/roadGraph';
import { SensorField } from './traffic/sensors';
import { TrafficVisibility } from './traffic/streaming';

function spawning(vehicles: Pick<VehicleService, 'spawn' | 'trySpawn'>): {
  trySpawn(): boolean;
  field: SensorField;
} {
  const city = {
    roadNodes: [60, 160].map((z, id) => ({
      id, position: new THREE.Vector3(0, 0, z), lanes: 1, links: [1 - id],
      isIntersection: false, hasTrafficLight: false,
    })),
    tramLines: [],
    spatial: { isBlocked: () => false, groundHeight: () => 0 },
    districtAt: () => 'bulevard',
  } as unknown as CityService;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -1);
  const visibility = new TrafficVisibility();
  visibility.update(camera);
  const rng = new Rng('streaming-fixture');
  // Every attempt selects the same hidden lane slot, including refill bursts.
  rng.range = (min, max) => (min + max) / 2;
  rng.weighted = (items) => items[0];
  const system = new TrafficSystem();
  Object.assign(system, {
    ctx: { tryGet: (key: unknown) => key === Services.City ? city : null },
    vehicles, graph: new TrafficGraph(city), visibility, rng,
  });
  return system as unknown as { trySpawn(): boolean; field: SensorField };
}

test('a blocked ambient lane is skipped without calling the relocating spawn API', () => {
  let fallbackCalls = 0;
  const system = spawning({
    spawn: () => { fallbackCalls++; throw new Error('ambient cars must not relocate'); },
    trySpawn: () => null,
  });
  expect(system.trySpawn()).toBe(false);
  expect(fallbackCalls).toBe(0);
  expect(system.field.all.length).toBe(0);
});

test('a new ambient car blocks overlapping spawns in the same refill burst', () => {
  let spawnCalls = 0;
  const system = spawning({
    spawn: () => { throw new Error('unexpected relocating spawn'); },
    trySpawn: (kind, position, heading) => {
      spawnCalls++;
      return {
        id: `traffic-${spawnCalls}`, kind, position: position.clone(),
        rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading),
        speed: 0,
      } as VehicleHandle;
    },
  });
  expect(system.trySpawn()).toBe(true);
  expect(system.field.all.length).toBe(1);
  expect(system.trySpawn()).toBe(false);
  expect(spawnCalls).toBe(1);
});

test('retired visible vehicles remain until the camera turns away', () => {
  const visibility = new TrafficVisibility();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 2, 0);
  camera.lookAt(0, 2, -1);
  visibility.update(camera);
  let despawned = 0;
  const system = new TrafficSystem();
  const vehicle = {
    id: 'retired', kind: 'dacia', position: new THREE.Vector3(0, 0, -100),
    rotation: new THREE.Quaternion(), occupants: [],
  };
  Object.assign(system, {
    visibility,
    vehicles: { despawn: () => { despawned++; } },
    slots: [{ vehicle, distance: 100, agent: { id: 'retired', retire: true, releaseAll: () => {} } }],
  });
  const ctx = { tryGet: () => null } as unknown as GameContext;
  const harness = system as unknown as { prune(ctx: GameContext): void };
  harness.prune(ctx);
  expect(despawned).toBe(0);
  camera.lookAt(0, 2, 1);
  visibility.update(camera);
  harness.prune(ctx);
  expect(despawned).toBe(1);
});
