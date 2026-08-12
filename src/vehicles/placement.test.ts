import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Services, type VehicleClass, type VehicleHandle } from '../core/services';
import { GROUP, PhysicsWorld } from '../physics/physics';
import {
  VehicleSystem,
  vehicleFootprintsOverlap,
  vehiclePlacementIsClear,
  type VehiclePlacementFootprint,
} from './vehicleSystem';

function footprint(
  x: number,
  z: number,
  heading: number,
  width: number,
  length: number,
  height: number,
): VehiclePlacementFootprint {
  return {
    position: new THREE.Vector3(x, 0, z),
    heading,
    width,
    length,
    height,
  };
}

test('long vehicle clearance follows the oriented tram and bus footprints', () => {
  const tram = footprint(0, 0, 0, 2.46, 15.2, 3.35);

  // These parallel vehicles have 0.41 m between their sides. A centre-radius
  // approximation rejects them because both are long, even though their full
  // oriented rectangles are disjoint.
  const busAlongside = footprint(2.9, 0, 0, 2.52, 11.6, 3.16);
  expect(vehicleFootprintsOverlap(tram, busAlongside)).toBe(false);

  // The same bus in-lane overlaps the tram nose by 0.25 m. Long overhangs must
  // remain part of the test even though both centres are far apart.
  const busAtNose = footprint(0, 13.5, 0, 2.52, 11.6, 3.16);
  expect(vehicleFootprintsOverlap(tram, busAtNose)).toBe(true);
});

async function physicsWorld(): Promise<{ phys: PhysicsWorld; ctx: GameContext }> {
  const scene = new THREE.Scene();
  const services = new Map<string, unknown>();
  const ctx = {
    scene,
    camera: new THREE.PerspectiveCamera(),
    provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
    get: (key: { id: string }) => services.get(key.id),
    tryGet: (key: { id: string }) => services.get(key.id),
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
  } as unknown as GameContext;
  const phys = new PhysicsWorld();
  await phys.init(ctx);
  return { phys, ctx };
}

function installCanvasStub(): () => void {
  const previousDocument = globalThis.document;
  const gradient = { addColorStop: () => {} };
  const context = {
    createRadialGradient: () => gradient,
    fillRect: () => {},
    fillStyle: gradient,
  };
  const documentStub = {
    createElement: (tagName: string) => {
      if (tagName !== 'canvas') throw new Error(`Unexpected test element: ${tagName}`);
      return { width: 0, height: 0, getContext: () => context };
    },
  } as unknown as Document;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });

  return () => {
    if (previousDocument === undefined) delete (globalThis as { document?: Document }).document;
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  };
}

function placementOf(vehicle: VehicleHandle): VehiclePlacementFootprint {
  const testVehicle = vehicle as VehicleHandle & {
    model: { spec: { width: number; length: number; height: number } };
  };
  return footprint(
    vehicle.position.x,
    vehicle.position.z,
    new THREE.Euler().setFromQuaternion(vehicle.rotation, 'YXZ').y,
    testVehicle.model.spec.width,
    testVehicle.model.spec.length,
    testVehicle.model.spec.height,
  );
}

type CharacterProxyKind = 'player' | 'ped' | 'dog' | 'downed';

function addCharacterProxy(
  phys: PhysicsWorld,
  kind: CharacterProxyKind,
  x: number,
  z: number,
): void {
  const horizontal = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    Math.PI / 2,
  );
  const radius = kind === 'dog' ? 0.18 : 0.32;
  const halfHeight = kind === 'dog' ? 0.25 : kind === 'player' ? 0.58 : 0.55;
  const horizontalBody = kind === 'dog' || kind === 'downed';
  const y = kind === 'dog' ? 0.36 : horizontalBody ? radius : halfHeight + radius;
  const body = phys.world.createRigidBody(
    phys.rapier.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(x, y, z)
      .setRotation(horizontalBody ? horizontal : new THREE.Quaternion()),
  );
  phys.world.createCollider(
    phys.rapier.ColliderDesc.capsule(halfHeight, radius)
      .setCollisionGroups(kind === 'player' ? GROUP.player : GROUP.character),
    body,
  );
}

function vehicleSystem(phys: PhysicsWorld, ctx: GameContext): VehicleSystem {
  const system = new VehicleSystem();
  const internals = system as unknown as {
    phys: PhysicsWorld;
    ctx: GameContext;
    atlas: THREE.Texture;
  };
  internals.phys = phys;
  internals.ctx = ctx;
  internals.atlas = new THREE.Texture();
  return system;
}

function installStraightRoad(ctx: GameContext): void {
  const nodes = [
    { id: 0, position: new THREE.Vector3(0, 0, 0), links: [1] },
    { id: 1, position: new THREE.Vector3(0, 0, 30), links: [0] },
  ];
  ctx.provide(Services.City, {
    roadNodes: nodes,
    nearestNode: () => 0,
    spatial: {
      isBlocked: () => false,
      groundHeight: () => 0,
    },
  } as never);
}

function fillRoadWithCharacters(phys: PhysicsWorld): void {
  const kinds: CharacterProxyKind[] = ['player', 'ped', 'dog', 'downed'];
  for (let z = 0, i = 0; z <= 30; z += 3, i++) {
    addCharacterProxy(phys, kinds[i % kinds.length], 0, z);
  }
}

function armOccupiedRecovery(vehicle: VehicleHandle): void {
  const diagnostic = vehicle as VehicleHandle & {
    occupants: string[];
    occupiedRecovery: {
      stalledSeconds: number;
      forwardStalledSeconds: number;
      reverseStalledSeconds: number;
      cooldown: number;
    };
  };
  diagnostic.occupants.push('player');
  diagnostic.occupiedRecovery = {
    stalledSeconds: 3.5,
    forwardStalledSeconds: 1,
    reverseStalledSeconds: 1,
    cooldown: 0,
  };
  vehicle.setControls(1, 0, false);
}

test('spawn moves clear of player, standing ped, dog, and downed proxies', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    const cases: Array<[CharacterProxyKind, number]> = [
      ['player', 0], ['ped', 30], ['dog', 60], ['downed', 90],
    ];
    for (const [kind, x] of cases) addCharacterProxy(phys, kind, x, 0);
    phys.world.step();
    const system = vehicleSystem(phys, ctx);

    const distances = cases.map(([kind, x], index) => {
      const car = system.spawn('dacia', new THREE.Vector3(x, 0, 0), 0, {
        colorSeed: index + 1,
      });
      return [kind, Math.hypot(car.position.x - x, car.position.z)] as const;
    });
    console.info(distances.map(([kind, distance]) =>
      `[character-spawn-test] ${kind} displacement=${distance.toFixed(2)}`,
    ).join('\n'));
    for (const [, distance] of distances) expect(distance).toBeGreaterThan(1);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('airborne rescue refuses road slots occupied by character bodies', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    installStraightRoad(ctx);
    fillRoadWithCharacters(phys);
    phys.world.step();
    const system = vehicleSystem(phys, ctx);
    const car = system.spawn('dacia', new THREE.Vector3(50, 8, 0), 0, { colorSeed: 1 });
    const source = car.position.clone();
    (car as VehicleHandle & { airTime: number }).airTime = 5;

    system.fixedUpdate(1 / 60);

    const displacement = Math.hypot(car.position.x - source.x, car.position.z - source.z);
    console.info(`[character-airborne-test] displacement=${displacement.toFixed(2)}`);
    expect(displacement).toBeLessThan(0.1);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('airborne rescue still teleports when a road slot is clear', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    installStraightRoad(ctx);
    const system = vehicleSystem(phys, ctx);
    const car = system.spawn('dacia', new THREE.Vector3(50, 8, 0), 0, { colorSeed: 1 });
    const source = car.position.clone();
    (car as VehicleHandle & { airTime: number }).airTime = 5;

    system.fixedUpdate(1 / 60);

    const displacement = Math.hypot(car.position.x - source.x, car.position.z - source.z);
    console.info(`[clear-airborne-test] displacement=${displacement.toFixed(2)}`);
    expect(displacement).toBeGreaterThan(20);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('occupied recovery refuses road slots occupied by character bodies', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    installStraightRoad(ctx);
    phys.addStaticBox(
      new THREE.Vector3(100, 0.5, 100),
      new THREE.Vector3(0, -0.5, 0),
      undefined,
      GROUP.terrain,
    );
    fillRoadWithCharacters(phys);
    phys.world.step();
    const system = vehicleSystem(phys, ctx);
    const car = system.spawn('dacia', new THREE.Vector3(50, 0, 0), 0, { colorSeed: 1 });
    const source = car.position.clone();
    armOccupiedRecovery(car);

    system.fixedUpdate(1 / 60);

    const displacement = Math.hypot(car.position.x - source.x, car.position.z - source.z);
    console.info(`[character-occupied-test] displacement=${displacement.toFixed(2)}`);
    expect(displacement).toBeLessThan(0.1);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('occupied recovery still teleports when a road slot is clear', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    installStraightRoad(ctx);
    phys.addStaticBox(
      new THREE.Vector3(100, 0.5, 100),
      new THREE.Vector3(0, -0.5, 0),
      undefined,
      GROUP.terrain,
    );
    phys.world.step();
    const system = vehicleSystem(phys, ctx);
    const car = system.spawn('dacia', new THREE.Vector3(50, 0, 0), 0, { colorSeed: 1 });
    const source = car.position.clone();
    armOccupiedRecovery(car);

    system.fixedUpdate(1 / 60);

    const displacement = Math.hypot(car.position.x - source.x, car.position.z - source.z);
    console.info(`[clear-occupied-test] displacement=${displacement.toFixed(2)}`);
    expect(displacement).toBeGreaterThan(20);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('the Rapier placement probe checks a rotated full footprint against buildings', async () => {
  const { phys } = await physicsWorld();
  try {
    // Supporting terrain belongs below a vehicle and must not make every road
    // slot look occupied.
    phys.addStaticBox(
      new THREE.Vector3(30, 0.5, 30),
      new THREE.Vector3(0, -0.5, 0),
      undefined,
      GROUP.terrain,
    );
    // This narrow building is beside an unrotated bus, but intersects its nose
    // when the 11.6 m body is turned across the X axis.
    phys.addStaticBox(
      new THREE.Vector3(0.2, 1, 0.2),
      new THREE.Vector3(5.9, 1, 0),
      undefined,
      GROUP.staticWorld,
    );
    phys.addStaticBox(
      new THREE.Vector3(0.2, 0.7, 0.2),
      new THREE.Vector3(20, 0.7, 6.1),
      undefined,
      GROUP.prop,
    );
    phys.addStaticBox(
      new THREE.Vector3(0.4, 0.2, 0.4),
      new THREE.Vector3(40, 0.2, 0),
      undefined,
      GROUP.prop,
    );
    phys.world.step();

    const unrotated = footprint(0, 0, 0, 2.52, 11.6, 3.16);
    const acrossRoad = footprint(0, 0, Math.PI / 2, 2.52, 11.6, 3.16);
    const besideProp = footprint(20, 0, 0, 2.52, 11.6, 3.16);
    const liftedAboveLowProp = {
      ...footprint(40, 0, 0, 1.8, 4.4, 1.5),
      position: new THREE.Vector3(40, 1, 0),
    };
    expect(vehiclePlacementIsClear(phys, unrotated, [])).toBe(true);
    expect(vehiclePlacementIsClear(phys, acrossRoad, [])).toBe(false);
    expect(vehiclePlacementIsClear(phys, besideProp, [])).toBe(false);
    expect(vehiclePlacementIsClear(phys, liftedAboveLowProp, [])).toBe(false);
  } finally {
    phys.dispose();
  }
});

test('spawn verifies collision-free candidates for every vehicle class', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    phys.addStaticBox(
      new THREE.Vector3(3, 2, 3),
      new THREE.Vector3(0, 2, 0),
      undefined,
      GROUP.staticWorld,
    );
    phys.world.step();

    const system = new VehicleSystem();
    const internals = system as unknown as {
      phys: PhysicsWorld;
      ctx: GameContext;
      atlas: THREE.Texture;
    };
    internals.phys = phys;
    internals.ctx = ctx;
    internals.atlas = new THREE.Texture();

    const kinds: VehicleClass[] = [
      'dacia', 'sedan', 'hatch', 'van', 'truck', 'bus', 'police', 'tram', 'scooter',
    ];
    const spawned = kinds.map((kind, index) => system.spawn(
      kind,
      new THREE.Vector3(0, 0, 0),
      0,
      { colorSeed: index + 1 },
    ));
    const placements = spawned.map(placementOf);
    const unsafe = placements.flatMap((candidate, index) => {
      const others = placements.filter((_, otherIndex) => otherIndex !== index);
      return vehiclePlacementIsClear(phys, candidate, others) ? [] : [kinds[index]];
    });
    console.info(`[vehicle-placement-test] unsafe=${unsafe.join(',') || 'none'}`);
    expect(unsafe).toEqual([]);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('each chassis collider reaches the rendered roof without lowering its underbody', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    const system = new VehicleSystem();
    const internals = system as unknown as {
      phys: PhysicsWorld;
      ctx: GameContext;
      atlas: THREE.Texture;
    };
    internals.phys = phys;
    internals.ctx = ctx;
    internals.atlas = new THREE.Texture();

    const kinds: VehicleClass[] = [
      'dacia', 'sedan', 'hatch', 'van', 'truck', 'bus', 'police', 'tram', 'scooter',
    ];
    const diagnostics = kinds.map((kind, index) => {
      const vehicle = system.spawn(
        kind,
        new THREE.Vector3(index * 30, 0, 50),
        0,
        { colorSeed: index + 1 },
      ) as VehicleHandle & {
        collider: { translation(): { y: number }; halfExtents(): { y: number } };
        model: { spec: {
          height: number;
          rideHeight: number;
          wheelRadius: number;
        } };
      };
      vehicle.object.updateWorldMatrix(true, true);
      const renderedTop = new THREE.Box3().setFromObject(vehicle.object).max.y;
      const colliderCenter = vehicle.collider.translation().y;
      const colliderHalfY = vehicle.collider.halfExtents().y;
      const colliderTop = colliderCenter + colliderHalfY;
      const colliderBottom = colliderCenter - colliderHalfY;
      const specRoof = vehicle.position.y - vehicle.model.spec.rideHeight + vehicle.model.spec.height;
      const expectedBottom = vehicle.position.y - vehicle.model.spec.rideHeight +
        THREE.MathUtils.clamp(vehicle.model.spec.wheelRadius * 0.5, 0.14, 0.26);
      return { kind, colliderTop, colliderBottom, specRoof, expectedBottom, renderedTop };
    });

    console.info(diagnostics.map((d) =>
      `[vehicle-envelope-test] ${d.kind} physical=${d.colliderBottom.toFixed(2)}..${d.colliderTop.toFixed(2)} ` +
      `specRoof=${d.specRoof.toFixed(2)} renderedTop=${d.renderedTop.toFixed(2)}`,
    ).join('\n'));
    for (const d of diagnostics) {
      // The spec roof is independently corroborated by the built geometry.
      expect(d.renderedTop).toBeGreaterThanOrEqual(d.specRoof - 0.03);
      expect(d.colliderTop).toBeGreaterThanOrEqual(d.specRoof - 0.01);
      // Growing upward must not move the lower collision face into the road or
      // wheels; suspension geometry and ride height keep the old contract.
      expect(d.colliderBottom).toBeCloseTo(d.expectedBottom, 3);
    }
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('airborne rescue never teleports into an occupied road slot', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    // Every slot reachable in this deliberately tiny road graph is inside the
    // Rapier building, while the analytic city stub says the centres are open.
    // The placement seam, not centre sampling, must be the final authority.
    phys.addStaticBox(
      new THREE.Vector3(3, 3, 30),
      new THREE.Vector3(0, 3, 20),
      undefined,
      GROUP.staticWorld,
    );
    phys.world.step();
    const nodes = [
      { id: 0, position: new THREE.Vector3(0, 0, 0), links: [1] },
      { id: 1, position: new THREE.Vector3(0, 0, 30), links: [0] },
    ];
    ctx.provide(Services.City, {
      roadNodes: nodes,
      nearestNode: () => 0,
      spatial: {
        isBlocked: () => false,
        groundHeight: () => 0,
      },
    } as never);

    const system = new VehicleSystem();
    const internals = system as unknown as {
      phys: PhysicsWorld;
      ctx: GameContext;
      atlas: THREE.Texture;
    };
    internals.phys = phys;
    internals.ctx = ctx;
    internals.atlas = new THREE.Texture();

    const car = system.spawn('dacia', new THREE.Vector3(50, 8, 0), 0, { colorSeed: 1 });
    (car as VehicleHandle & { airTime: number }).airTime = 5;
    system.fixedUpdate(1 / 60);

    const finalPlacement = placementOf(car);
    const clear = vehiclePlacementIsClear(phys, finalPlacement, []);
    console.info(
      `[airborne-placement-test] x=${car.position.x.toFixed(1)} ` +
      `z=${car.position.z.toFixed(1)} clear=${clear}`,
    );
    expect(clear).toBe(true);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);

test('occupied recovery rejects a road slot whose full Rapier footprint is blocked', async () => {
  const restoreDocument = installCanvasStub();
  const { phys, ctx } = await physicsWorld();
  try {
    phys.addStaticBox(
      new THREE.Vector3(100, 0.5, 100),
      new THREE.Vector3(0, -0.5, 0),
      undefined,
      GROUP.terrain,
    );
    phys.addStaticBox(
      new THREE.Vector3(3, 3, 60),
      new THREE.Vector3(0, 3, 30),
      undefined,
      GROUP.staticWorld,
    );
    phys.world.step();
    const nodes = [
      { id: 0, position: new THREE.Vector3(0, 0, 0), links: [1] },
      { id: 1, position: new THREE.Vector3(0, 0, 30), links: [0] },
    ];
    ctx.provide(Services.City, {
      roadNodes: nodes,
      nearestNode: () => 0,
      spatial: {
        isBlocked: () => false,
        groundHeight: () => 0,
      },
    } as never);

    const system = new VehicleSystem();
    const internals = system as unknown as {
      phys: PhysicsWorld;
      ctx: GameContext;
      atlas: THREE.Texture;
    };
    internals.phys = phys;
    internals.ctx = ctx;
    internals.atlas = new THREE.Texture();

    const car = system.spawn('dacia', new THREE.Vector3(50, 0, 0), 0, { colorSeed: 1 });
    const diagnostic = car as VehicleHandle & {
      occupants: string[];
      occupiedRecovery: {
        stalledSeconds: number;
        forwardStalledSeconds: number;
        reverseStalledSeconds: number;
        cooldown: number;
      };
    };
    diagnostic.occupants.push('player');
    diagnostic.occupiedRecovery = {
      stalledSeconds: 3.5,
      forwardStalledSeconds: 1,
      reverseStalledSeconds: 1,
      cooldown: 0,
    };
    car.setControls(1, 0, false);
    system.fixedUpdate(1 / 60);

    const finalPlacement = placementOf(car);
    const clear = vehiclePlacementIsClear(phys, finalPlacement, []);
    console.info(
      `[occupied-placement-test] x=${car.position.x.toFixed(1)} ` +
      `z=${car.position.z.toFixed(1)} clear=${clear}`,
    );
    expect(clear).toBe(true);
  } finally {
    phys.dispose();
    restoreDocument();
  }
}, 20_000);
