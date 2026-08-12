import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import { CG, GROUP, PhysicsWorld, initRapier, probeGroups } from '../../physics/physics';
import { registerPropCollisionProxies } from '../props';
import {
  barrierRun,
  hazardTape,
  hoarding,
  jerseyBarrier,
  palletStack,
  scaffold,
  skip,
  spoilHeap,
  trafficCone,
  warningLamp,
} from './barriers';
import { autumnTree, hedgeRow, leafLitter, planter } from './foliage';
import { PropBuilder, PropColor } from './kit';
import {
  atm,
  bench,
  bikeRack,
  busShelter,
  eScooter,
  kiosk,
  litterBin,
  marketStall,
  newsStand,
  phoneBox,
  stoneBollard,
  trafficLight,
  tricolour,
  utilityCabinet,
} from './streetFurniture';
import { contactWires, tractionPole } from './wires';

describe('prop collision metadata', () => {
  test('render primitives stay visual-only and semantic proxies preserve their transforms', () => {
    const props = new PropBuilder();

    props.box(10, 0.61, -3, 1.8, 0.88, 0.55, Math.PI / 3, { color: PropColor.wood });
    props.cyl(-2, 0.17, 7, 0.16, 0.14, 0.84, 6, { color: PropColor.concrete });

    expect(props.collisionProxies).toEqual([]);

    props.addCollisionBox('bench', 10, 0.61, -3, 1.8, 0.88, 0.55, Math.PI / 3);
    props.addCollisionCapsule('bollard', -2, 0.59, 7, 0.84, 0.16);

    expect(props.collisionProxies).toEqual([
      {
        shape: 'box',
        label: 'bench',
        center: [10, 0.61, -3],
        size: [1.8, 0.88, 0.55],
        rotationY: Math.PI / 3,
      },
      {
        shape: 'capsule',
        label: 'bollard',
        center: [-2, 0.59, 7],
        height: 0.84,
        radius: 0.16,
      },
    ]);
  });

  test('substantial authored props emit one efficient blocker each', () => {
    const cases: Array<[
      label: string,
      shape: 'box' | 'capsule',
      build: (props: PropBuilder, rng: Rng) => void,
    ]> = [
      ['bench', 'box', (b, r) => bench(b, 1, 2, 0, 1, r)],
      ['bin', 'capsule', (b, r) => litterBin(b, 1, 2, r)],
      ['bollard', 'capsule', (b) => stoneBollard(b, 1, 2)],
      ['kiosk', 'box', (b, r) => kiosk(b, 1, 2, 0, 1, r)],
      ['atm', 'box', (b) => atm(b, 1, 2, 0, 1)],
      ['market-stall', 'box', (b, r) => marketStall(b, 1, 2, 0, 1, r)],
      ['news-stand', 'box', (b, r) => newsStand(b, 1, 2, 0, 1, r)],
      ['phone-box', 'box', (b) => phoneBox(b, 1, 2, 0, 1)],
      ['utility-cabinet', 'box', (b, r) => utilityCabinet(b, 1, 2, 0, 1, r)],
      ['bike-rack', 'box', (b, r) => bikeRack(b, 1, 2, 0, 1, 3, r)],
      ['e-scooter', 'box', (b, r) => eScooter(b, 1, 2, 0.4, r)],
      ['traffic-light', 'capsule', (b, r) => trafficLight(b, 1, 2, 0, 1, r)],
      ['flagpole', 'capsule', (b, r) => tricolour(b, 1, 0.17, 2, 0, 1, r, true)],
      ['tree', 'capsule', (b, r) => autumnTree(b, 1, 2, r, 1, 0.2, 0)],
      ['hedge', 'box', (b, r) => hedgeRow(b, 1, 2, 1, 0, 6, 1.1, r)],
      ['planter', 'box', (b, r) => planter(b, 1, 2, r)],
      ['crowd-barrier', 'box', (b, r) => { barrierRun(b, 1, 2, 1, 0, 5, r); }],
      ['pallet-stack', 'box', (b, r) => palletStack(b, 1, 0.17, 2, 3, r)],
      ['skip', 'box', (b, r) => skip(b, 1, 0.17, 2, 0.4, r)],
      ['spoil-heap', 'box', (b, r) => spoilHeap(b, 1, 0.17, 2, 1.3, r)],
      ['hoarding', 'box', (b, r) => hoarding(b, 1, 2, 1, 0, 8, r)],
      ['scaffold', 'box', (b, r) => scaffold(b, 1, 2, 1, 0, 3, 2, r)],
      ['jersey-barrier', 'box', (b, r) => jerseyBarrier(b, 1, 0.17, 2, 0.4, r)],
      ['traffic-cone', 'capsule', (b, r) => trafficCone(b, 1, 0.17, 2, r)],
      ['warning-lamp', 'capsule', (b) => warningLamp(b, 1, 0.17, 2)],
      ['traction-pole', 'capsule', (b, r) => tractionPole(b, 1, 2, 1, 0, r)],
    ];

    for (const [label, shape, build] of cases) {
      const props = new PropBuilder();
      build(props, new Rng(`collision-${label}`));
      expect(`${label}: ${JSON.stringify(props.collisionProxies.map((p) => [p.label, p.shape]))}`)
        .toBe(`${label}: ${JSON.stringify([[label, shape]])}`);
    }
  });

  test('a bus shelter blocks only rendered fixtures and leaves its open front traversable', () => {
    const props = new PropBuilder();
    busShelter(props, 1, 2, 0, 1, new Rng('open-shelter'));

    expect(props.collisionProxies.map((p) => p.label)).toEqual([
      'bus-shelter-back',
      'bus-shelter-bench',
      'bus-shelter-advert',
    ]);
    expect(props.collisionProxies.every((p) => p.shape === 'box')).toBe(true);

    const contains = (x: number, y: number, z: number): boolean => props.collisionProxies.some((proxy) => {
      if (proxy.shape !== 'box') return false;
      const dx = x - proxy.center[0];
      const dz = z - proxy.center[2];
      const cs = Math.cos(proxy.rotationY);
      const sn = Math.sin(proxy.rotationY);
      const lx = dx * cs - dz * sn;
      const lz = dx * sn + dz * cs;
      return Math.abs(lx) <= proxy.size[0] / 2
        && Math.abs(y - proxy.center[1]) <= proxy.size[1] / 2
        && Math.abs(lz) <= proxy.size[2] / 2;
    });

    expect(contains(1, 1.2, 1.25)).toBe(true); // glazed back
    expect(contains(1, 1.2, 2.6)).toBe(false); // open pavement-facing entrance
  });

  test('flat litter and overhead lines remain non-colliding dressing', () => {
    const props = new PropBuilder();
    const rng = new Rng('non-colliding-dressing');

    leafLitter(props, 0, 0, 2, 12, rng);
    contactWires(props, -5, 0, 5, 0, 0.62, rng);
    hazardTape(props, -4, 1.2, 1, 4, 1.1, 1, rng);

    expect(props.collisionProxies).toEqual([]);
  });

  test('a knocked-over cone keeps one low, rotated blocker', () => {
    const props = new PropBuilder();
    trafficCone(props, 3, 0.17, -2, new Rng('knocked-14'));

    expect(props.collisionProxies).toHaveLength(1);
    expect(props.collisionProxies[0]).toMatchObject({
      shape: 'box',
      label: 'traffic-cone',
      size: [0.72, 0.2, 0.36],
    });
  });

  test('boxes and capsules register as static GROUP.prop colliders in Rapier', async () => {
    const physics = new PhysicsWorld();
    physics.rapier = await initRapier();
    physics.world = new physics.rapier.World({ x: 0, y: -9.81, z: 0 });

    const props = new PropBuilder();
    props.addCollisionBox('rotated-box', 4, 1, 0, 4, 2, 1, Math.PI / 2);
    props.addCollisionCapsule('round-post', -3, 1, 0, 2, 0.25);

    const colliders = registerPropCollisionProxies(physics, props.collisionProxies);
    const [box, capsule] = colliders;

    expect(colliders).toHaveLength(2);
    expect(colliders.map((c) => c.shapeType())).toEqual([
      physics.rapier.ShapeType.Cuboid,
      physics.rapier.ShapeType.Capsule,
    ]);
    expect(colliders.map((c) => c.collisionGroups())).toEqual([GROUP.prop, GROUP.prop]);
    expect(colliders.map((c) => c.parent())).toEqual([null, null]);
    expect([box.halfExtents().x, box.halfExtents().y, box.halfExtents().z]).toEqual([2, 1, 0.5]);
    expect(box.rotation().y).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(capsule.halfHeight()).toBeCloseTo(0.75, 6);
    expect(capsule.radius()).toBeCloseTo(0.25, 6);

    // Rapier updates its query pipeline on the fixed step, as it does before
    // gameplay starts querying the fully initialised world.
    physics.world.step();
    const boxHit = physics.raycast(
      new THREE.Vector3(4, 1, -4), new THREE.Vector3(0, 0, 1), 8, probeGroups(CG.PROP),
    );
    const capsuleHit = physics.raycast(
      new THREE.Vector3(-3, 3, 0), new THREE.Vector3(0, -1, 0), 4, probeGroups(CG.PROP),
    );
    expect(boxHit?.distance).toBeCloseTo(2, 5);
    expect(capsuleHit?.distance).toBeCloseTo(1, 5);

    physics.world.free();
  });
});
