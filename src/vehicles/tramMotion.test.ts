import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { VehicleSystem } from './vehicleSystem';

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
