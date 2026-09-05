import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import { GROUP, PhysicsWorld } from '../../physics/physics';
import { VehicleSystem } from '../../vehicles/vehicleSystem';
import { Driver } from './driver';
import { TrafficAgent } from './agent';
import { TrafficGraph } from './roadGraph';
import { JunctionControl } from './junctions';
import { SensorField } from './sensors';
import { Rng } from '../../core/rng';
import type { CityService, RoadNode } from '../../core/services';

async function withDrivingWorld(run: (physics: PhysicsWorld, vehicles: VehicleSystem, ctx: GameContext) => void): Promise<void> {
  const previousDocument = globalThis.document;
  const canvasContext = { createRadialGradient: () => ({ addColorStop: () => {} }), fillRect: () => {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }),
  } });
  const services = new Map<string, unknown>();
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
    get: (key: { id: string }) => services.get(key.id),
    tryGet: (key: { id: string }) => services.get(key.id),
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
  } as unknown as GameContext;
  const physics = new PhysicsWorld();
  await physics.init(ctx);
  physics.addStaticBox(new THREE.Vector3(250, .5, 250), new THREE.Vector3(0, -.5, 0), undefined, GROUP.terrain);
  const vehicles = new VehicleSystem();
  Object.assign(vehicles, { phys: physics, ctx, atlas: new THREE.Texture() });
  try {
    run(physics, vehicles, ctx);
  } finally {
    if (previousDocument === undefined) delete (globalThis as { document?: Document }).document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  }
}

test('civilian lane corrections converge with the physical right-positive steering contract', async () => {
  await withDrivingWorld((physics, vehicles, ctx) => {
    for (const side of [-1, 1]) {
      const car = vehicles.spawn('dacia', new THREE.Vector3(side * 2, 0, -60), 0, {
        faction: 'civilian', colorSeed: 1,
      });
      const driver = new Driver(car);
      let minHeight = Infinity;
      let maxHeight = -Infinity;
      for (let frame = 0; frame < 12 * 60; frame++) {
        physics.fixedUpdate(1 / 60, ctx);
        vehicles.fixedUpdate(1 / 60);
        driver.sense(1 / 60);
        driver.drive(1 / 60, 0, car.position.z + 12, 7, 0, { crossTrack: car.position.x, allowReverse: false });
        if (frame > 120) {
          minHeight = Math.min(minHeight, car.position.y);
          maxHeight = Math.max(maxHeight, car.position.y);
        }
      }
      expect(Math.abs(car.position.x)).toBeLessThan(.3);
      expect(car.position.z).toBeGreaterThan(-10);
      expect(car.speed).toBeGreaterThan(5);
      expect(maxHeight - minHeight).toBeLessThan(.15);
      vehicles.despawn(car.id);
    }
  });
}, 20_000);


test('a physical civilian car brakes before red, waits, then drives through green', async () => {
  await withDrivingWorld((physics, vehicles, ctx) => {
    const nodes: RoadNode[] = [-100, 0, 100].map((x, i) => ({
      id: i, position: new THREE.Vector3(x, 0, 0), links: i === 1 ? [0, 2] : [1],
      lanes: 1, isIntersection: i === 1, hasTrafficLight: i === 1,
    }));
    const graph = new TrafficGraph({ roadNodes: nodes, tramLines: [], spatial: { isBlocked: () => false } } as unknown as CityService);
    const edge = graph.edges[graph.edgeBetween(0, 1)];
    const car = vehicles.spawn('dacia', graph.lanePoint(edge, 0, .72, new THREE.Vector3()), Math.PI / 2,
      { faction: 'civilian', colorSeed: 1 });
    const agent = new TrafficAgent(car, graph, edge.index, 0, new Rng(3));
    const junctions = new JunctionControl(nodes);
    // Begin immediately after this approach has turned red, providing enough
    // time to approach the light from rest and hold before the next phase.
    junctions.update(15);
    const field = new SensorField();
    let closestRedBumper = -Infinity;
    let waited = 0;
    let observedGreen = false;
    for (let frame = 0; frame < 17 * 60; frame++) {
      physics.fixedUpdate(1 / 60, ctx);
      vehicles.fixedUpdate(1 / 60);
      junctions.update(1 / 60);
      agent.bid(junctions);
      agent.update(1 / 60, field, junctions, { horn: () => {} });
      if (!observedGreen && junctions.signal(1, true) === 'red') {
        closestRedBumper = Math.max(closestRedBumper, car.position.x + 2.2);
        if (Math.abs(car.speed) < .4 && car.position.x > edge.xx - 7) waited++;
      } else observedGreen = true;
    }
    expect(closestRedBumper).toBeLessThanOrEqual(edge.xx + .15);
    expect(waited).toBeGreaterThan(60);
    expect(observedGreen).toBe(true);
    expect(car.position.x - 2.2).toBeGreaterThan(graph.edges[graph.edgeBetween(1, 2)].ex);
    expect(Math.abs(car.position.z - graph.laneOffset(edge, 0))).toBeLessThan(.5);
    vehicles.despawn(car.id);
  });
}, 20_000);
