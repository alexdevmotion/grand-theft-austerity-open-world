import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { VehicleSystem } from './vehicleSystem';
import { TrafficSystem } from '../ai/traffic';
import { TrafficAgent } from '../ai/traffic/agent';
import { TrafficGraph, TRAM_LANE } from '../ai/traffic/roadGraph';
import { JunctionControl } from '../ai/traffic/junctions';
import { Rng } from '../core/rng';
import type { CityService } from '../core/services';

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

test('a grounded tram under full throttle lifts onto its suspension and makes progress', async () => {
  const restoreDocument = installCanvasStub();
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

  const physics = new PhysicsWorld();
  await physics.init(ctx);
  physics.addStaticBox(
    new THREE.Vector3(100, 0.5, 100),
    new THREE.Vector3(0, -0.5, 0),
    undefined,
    GROUP.terrain,
  );

  const vehicles = new VehicleSystem();
  const internals = vehicles as unknown as {
    phys: PhysicsWorld;
    ctx: GameContext;
    atlas: THREE.Texture;
  };
  // The physics seam needs no DOM-backed paint atlas or renderer. Inject the
  // same runtime dependencies `init()` owns, then exercise the public vehicle
  // service (`spawn`, controls, position and speed) with real Rapier dynamics.
  internals.phys = physics;
  internals.ctx = ctx;
  internals.atlas = new THREE.Texture();

  try {
    const tram = vehicles.spawn('tram', new THREE.Vector3(0, 0, 0), Math.PI / 2, {
      faction: 'civilian',
      colorSeed: 1,
    });
    const startX = tram.position.x;
    tram.setControls(1, 0, false);
    for (let frame = 0; frame < 5 * 60; frame++) {
      physics.fixedUpdate(1 / 60, ctx);
      vehicles.fixedUpdate(1 / 60);
      tram.setControls(1, 0, false);
    }

    const diagnostic = tram as unknown as {
      wheelContact: boolean[];
      wheelCompression: number[];
    };
    const distance = tram.position.x - startX;
    const averageCompression = diagnostic.wheelCompression.reduce((sum, value) => sum + value, 0) /
      diagnostic.wheelCompression.length;
    console.info(
      `[tram-motion-test] speed=${tram.speed.toFixed(2)} m/s distance=${distance.toFixed(2)} m ` +
      `y=${tram.position.y.toFixed(3)} grounded=${diagnostic.wheelContact.filter(Boolean).length}/` +
      `${diagnostic.wheelContact.length} compression=${averageCompression.toFixed(2)}`,
    );

    expect(diagnostic.wheelContact.filter(Boolean).length).toBe(diagnostic.wheelContact.length);
    // Static spring compression is g / stiffness (~0.23 here), independent of
    // axle count: each wheel must receive one wheel's share of the vehicle mass.
    expect(averageCompression).toBeGreaterThan(0.18);
    expect(averageCompression).toBeLessThan(0.3);
    expect(tram.position.y).toBeGreaterThan(0.54);
    expect(tram.speed).toBeGreaterThan(2);
    expect(distance).toBeGreaterThan(5);
  } finally {
    restoreDocument();
  }
}, 20_000);

// Rail traffic uses the same Rapier world as cars, but its bogies constrain
// movement to verified steel instead of steering and periodically teleporting.
test('guided tram stays on its rails without vibration, replans continuously and stops for obstacles', async () => {
  const restoreDocument = installCanvasStub();
  const services = new Map<string, unknown>();
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
    tryGet: (key: { id: string }) => services.get(key.id),
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
  } as unknown as GameContext;
  const physics = new PhysicsWorld();
  await physics.init(ctx);
  physics.addStaticBox(new THREE.Vector3(200, 0.5, 200), new THREE.Vector3(0, -0.5, 0), undefined, GROUP.terrain);
  const vehicles = new VehicleSystem();
  Object.assign(vehicles, { phys: physics, ctx, atlas: new THREE.Texture() });
  try {
    const handle = vehicles.spawn('tram', new THREE.Vector3(), Math.PI / 2, { colorSeed: 1 });
    const tram = handle as typeof handle & {
      setRailPath(points: Array<{ x: number; z: number }>): void;
      body: { applyImpulse(impulse: { x: number; y: number; z: number }, wake: boolean): void };
    };
    const path = [{ x: -20, z: 0 }, { x: 40, z: 0 }, { x: 90, z: 4 }, { x: 180, z: 4 }];
    tram.setRailPath(path);
    let maxVerticalStep = 0;
    let maxStep = 0;
    let previous = tram.position.clone();
    for (let frame = 0; frame < 12 * 60; frame++) {
      tram.setControls(1, frame % 2 ? -1 : 1, false);
      if (frame === 180) tram.body.applyImpulse({ x: 0, y: 400000, z: 400000 }, true);
      physics.fixedUpdate(1 / 60, ctx);
      vehicles.fixedUpdate(1 / 60);
      if (frame % 120 === 0) tram.setRailPath(path);
      if (frame > 2) maxVerticalStep = Math.max(maxVerticalStep, Math.abs(tram.position.y - previous.y));
      maxStep = Math.max(maxStep, tram.position.distanceTo(previous));
      const expectedZ = tram.position.x <= 40 ? 0 : tram.position.x < 90 ? (tram.position.x - 40) * 4 / 50 : 4;
      expect(Math.abs(tram.position.z - expectedZ)).toBeLessThan(0.015);
      previous.copy(tram.position);
    }
    expect(tram.position.x).toBeGreaterThan(65);
    expect(maxVerticalStep).toBeLessThan(0.001);
    expect(maxStep).toBeLessThan(0.3);
    expect(Math.abs(tram.rotation.x) + Math.abs(tram.rotation.z)).toBeLessThan(0.001);

    const barrierX = tram.position.x + 22;
    physics.addStaticBox(new THREE.Vector3(1, 3, 6), new THREE.Vector3(barrierX, 3, 4), undefined, GROUP.static);
    for (let frame = 0; frame < 5 * 60; frame++) {
      tram.setControls(1, 0, false);
      physics.fixedUpdate(1 / 60, ctx);
      vehicles.fixedUpdate(1 / 60);
    }
    expect(tram.position.x).toBeLessThan(barrierX - 7);
    expect(tram.speed).toBe(0);
  } finally { restoreDocument(); }
}, 20_000);

test('ambient exact spawn rejects an occupied lane without relocating or creating a vehicle', async () => {
  const restoreDocument = installCanvasStub();
  const services = new Map<string, unknown>();
  const ctx = {
    scene: new THREE.Scene(),
    provide: (key: { id: string }, value: unknown) => services.set(key.id, value),
    tryGet: (key: { id: string }) => services.get(key.id),
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
  } as unknown as GameContext;
  const physics = new PhysicsWorld();
  await physics.init(ctx);
  const vehicles = new VehicleSystem();
  Object.assign(vehicles, { phys: physics, ctx, atlas: new THREE.Texture() });
  try {
    const first = vehicles.trySpawn('tram', new THREE.Vector3(20, 0, 0), Math.PI / 2, { colorSeed: 1 });
    expect(first).not.toBeNull();
    expect(first!.position.x).toBe(20);
    expect(vehicles.trySpawn('tram', new THREE.Vector3(20, 0, 0), Math.PI / 2, { colorSeed: 1 })).toBeNull();
    expect(vehicles.all.length).toBe(1);
  } finally { restoreDocument(); }
}, 20_000);

test('automatic road rescue recognizes visible source and destination footprints', () => {
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  camera.position.set(0, 5, 0);
  camera.lookAt(0, 1, -50);
  const system = new VehicleSystem();
  Object.assign(system, { ctx: { camera } });
  const seam = system as unknown as {
    recoveryVisible(vehicle: unknown, position: THREE.Vector3): boolean;
  };
  const car = { tuning: { spec: { length: 4.3, width: 1.7, height: 1.5 } } };
  expect(seam.recoveryVisible(car, new THREE.Vector3(0, 0, -45))).toBe(true);
  expect(seam.recoveryVisible(car, new THREE.Vector3(0, 0, 45))).toBe(false);
  expect(seam.recoveryVisible(car, new THREE.Vector3(0, 0, -180))).toBe(true);
});

test('a stolen tram extends its rails beyond the NPC plan and brakes then reverses to the real terminus', async () => {
  const restoreDocument = installCanvasStub();
  const ctx = {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    provide: () => {}, tryGet: () => null,
    events: { on: () => () => {}, off: () => {}, emit: () => {} },
  } as unknown as GameContext;
  const physics = new PhysicsWorld();
  await physics.init(ctx);
  const vehicles = new VehicleSystem();
  Object.assign(vehicles, { phys: physics, ctx, atlas: new THREE.Texture() });
  const nodes = Array.from({ length: 8 }, (_, id) => ({
    id, position: new THREE.Vector3(id * 60, 0, 0), lanes: 3,
    links: [id - 1, id + 1].filter(i => i >= 0 && i < 8),
    isIntersection: false, hasTrafficLight: false,
  }));
  const city = { roadNodes: nodes, tramLines: [nodes.map(n => n.position)], spatial: {
    isBlocked: () => false, groundHeight: () => 0,
  } } as unknown as CityService;
  const graph = new TrafficGraph(city);
  const edge = graph.edgeBetween(1, 2);
  const position = graph.lanePoint(graph.edges[edge], TRAM_LANE, 0.5, new THREE.Vector3());
  try {
    const tram = vehicles.spawn('tram', position, Math.PI / 2, { colorSeed: 1, npcDriver: 'civilian' });
    const agent = new TrafficAgent(tram, graph, edge, TRAM_LANE, new Rng('stolen-tram'));
    const initialEnd = graph.laneExit(graph.edges[graph.edgeBetween(3, 4)], TRAM_LANE, new THREE.Vector3()).x;
    const traffic = new TrafficSystem();
    const slot = { agent, vehicle: tram, distance: 0 };
    Object.assign(traffic, { slots: [slot], byId: new Map([[tram.id, slot]]), junctions: new JunctionControl(nodes), tramCount: 1 });
    tram.npcDriver = null;
    (tram.occupants as string[]).push('player');
    (traffic as unknown as { prune(ctx: GameContext): void }).prune(ctx);
    expect((traffic as unknown as { slots: unknown[] }).slots).toHaveLength(0);

    const step = (seconds: number, throttle: number, brake = false): void => {
      for (let frame = 0; frame < seconds * 60; frame++) {
        tram.setControls(throttle, 1, brake);
        physics.fixedUpdate(1 / 60, ctx);
        vehicles.fixedUpdate(1 / 60);
        expect(Math.abs(tram.position.z - position.z)).toBeLessThan(0.01);
        expect(Math.abs(tram.rotation.x) + Math.abs(tram.rotation.z)).toBeLessThan(0.001);
      }
    };
    step(20, 1);
    expect(tram.position.x).toBeGreaterThan(initialEnd + 30);
    expect(tram.speed).toBeGreaterThan(8);
    step(6, 0, true);
    expect(tram.speed).toBe(0);
    const stopped = tram.position.x;
    step(1, 0, true);
    expect(tram.position.x).toBeCloseTo(stopped, 4);
    step(1, 1);
    expect(tram.speed).toBeGreaterThan(0);
    step(0.2, -1);
    expect(tram.speed).toBeGreaterThan(0);
    step(5, -1);
    expect(tram.speed).toBeLessThan(-1);
    step(75, -1);
    const start = graph.laneEntry(graph.edges[graph.edgeBetween(0, 1)], TRAM_LANE, new THREE.Vector3()).x;
    expect(tram.position.x).toBeGreaterThanOrEqual(start + 7);
    expect(tram.position.x).toBeLessThan(start + 9);
    expect(Math.abs(tram.speed)).toBe(0);
    step(45, 1);
    const end = graph.laneExit(graph.edges[graph.edgeBetween(6, 7)], TRAM_LANE, new THREE.Vector3()).x;
    expect(tram.position.x).toBeGreaterThan(end - 9);
    expect(tram.position.x).toBeLessThanOrEqual(end - 7);
    expect(tram.speed).toBe(0);
  } finally { restoreDocument(); }
}, 20_000);
