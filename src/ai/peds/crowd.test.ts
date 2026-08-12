import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { SpatialQuery } from '../../core/services';
import { PavementGraph } from './navigation';
import { makeAppearance } from './spawn';
import { CrowdGrid, Ped, VehicleGrid, type CrowdEnv } from './crowd';

function crowdEnv(
  peds: CrowdGrid,
  playerPos: THREE.Vector3 | null,
  playerInVehicle = false,
): CrowdEnv {
  const vehicles = new VehicleGrid();
  vehicles.begin();
  return {
    graph: new PavementGraph(),
    spatial: {
      snapToRoad: () => false,
      groundHeight: () => 0,
      isBlocked: () => false,
    },
    rng: new Rng('crowd-test-env'),
    time: 1,
    hour: 19,
    district: () => 'bulevard',
    playerPos,
    playerInVehicle,
    playerSpeed: 0,
    vehicles,
    peds,
    onKnockdown: () => {},
    tension: 0,
  };
}

function testSpatial(isBlocked: (x: number, z: number) => boolean): SpatialQuery {
  return {
    snapToRoad: () => false,
    groundHeight: () => 0,
    isBlocked,
  };
}

function activePed(x: number, z: number): Ped {
  const p = new Ped();
  p.active = true;
  p.position.set(x, 0, z);
  return p;
}

function minimumPairDistance(peds: readonly Ped[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let i = 0; i < peds.length; i++) {
    for (let j = i + 1; j < peds.length; j++) {
      minimum = Math.min(minimum, Math.hypot(
        peds[i].position.x - peds[j].position.x,
        peds[i].position.z - peds[j].position.z,
      ));
    }
  }
  return minimum;
}

test('ordinary depenetration uses the open half-plane and retains safe roots in a closed corner', () => {
  const a = activePed(0.1, 0);
  const b = activePed(0.2, 0);
  const halfPlane = testSpatial((x) => x < 0);
  const grid = new CrowdGrid();

  grid.resolve([a, b], halfPlane, null, false);

  expect(halfPlane.isBlocked(a.position.x, a.position.z)).toBe(false);
  expect(halfPlane.isBlocked(b.position.x, b.position.z)).toBe(false);
  expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z))
    .toBeGreaterThanOrEqual(0.72);

  a.position.set(0.1, 0, 0);
  b.position.set(0.2, 0, 0);
  const closedCorner = testSpatial((x, z) => (
    Math.hypot(x - 0.1, z) > 1e-8 && Math.hypot(x - 0.2, z) > 1e-8
  ));

  grid.resolve([a, b], closedCorner, null, false);

  expect(a.position.x).toBeCloseTo(0.1, 8);
  expect(a.position.z).toBeCloseTo(0, 8);
  expect(b.position.x).toBeCloseTo(0.2, 8);
  expect(b.position.z).toBeCloseTo(0, 8);
});

test('anchored depenetration validates roots and permanent anchors independently', () => {
  const anchored = (anchorX: number, rootX: number) => {
    const p = activePed(anchorX, 0);
    p.anchorAt(anchorX, 0, 0, {
      kind: 'talk', pose: 'talk', duration: 30, facesGroup: true,
    });
    p.position.x = rootX;
    return p;
  };
  const a = anchored(0.1, 0.7);
  const b = anchored(0.2, 0.8);
  const halfPlane = testSpatial((x) => x < 0);
  const grid = new CrowdGrid();

  grid.resolve([a, b], halfPlane, null, false);

  for (const p of [a, b]) {
    expect(halfPlane.isBlocked(p.position.x, p.position.z)).toBe(false);
    expect(halfPlane.isBlocked(p.anchorX, p.anchorZ)).toBe(false);
  }
  expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z))
    .toBeGreaterThanOrEqual(0.72);

  a.position.set(0.7, 0, 0); a.anchorX = 0.1; a.anchorZ = 0;
  b.position.set(0.8, 0, 0); b.anchorX = 0.2; b.anchorZ = 0;
  const safe = [0.1, 0.2, 0.7, 0.8];
  const closedCorner = testSpatial((x, z) => (
    Math.abs(z) > 1e-8 || !safe.some((sx) => Math.abs(x - sx) <= 1e-8)
  ));

  grid.resolve([a, b], closedCorner, null, false);

  expect(a.position.x).toBeCloseTo(0.7, 8);
  expect(a.anchorX).toBeCloseTo(0.1, 8);
  expect(b.position.x).toBeCloseTo(0.8, 8);
  expect(b.anchorX).toBeCloseTo(0.2, 8);
});

test('on-foot player depenetration finds an open half-plane and never commits a closed-corner fallback', () => {
  const ped = activePed(0.1, 0);
  ped.anchorAt(0.1, 0, 0, {
    kind: 'wait', pose: 'idle', duration: 30, facesGroup: false,
  });
  const player = new THREE.Vector3(0.2, 0, 0);
  const halfPlane = testSpatial((x) => x < 0);
  const grid = new CrowdGrid();

  grid.resolve([ped], halfPlane, player, false);

  expect(halfPlane.isBlocked(ped.position.x, ped.position.z)).toBe(false);
  expect(halfPlane.isBlocked(ped.anchorX, ped.anchorZ)).toBe(false);
  expect(Math.hypot(ped.position.x - player.x, ped.position.z - player.z))
    .toBeGreaterThanOrEqual(0.86);

  ped.position.set(0.1, 0, 0);
  ped.anchorX = 0.1;
  ped.anchorZ = 0;
  const closedCorner = testSpatial((x, z) => Math.hypot(x - 0.1, z) > 1e-8);

  grid.resolve([ped], closedCorner, player, false);

  expect(ped.position.x).toBeCloseTo(0.1, 8);
  expect(ped.position.z).toBeCloseTo(0, 8);
  expect(ped.anchorX).toBeCloseTo(0.1, 8);
  expect(ped.anchorZ).toBeCloseTo(0, 8);
});

test('crowd grid deterministically separates pedestrians spawned at the exact same point', () => {
  const a = new Ped();
  const b = new Ped();
  a.active = true;
  b.active = true;
  a.position.set(12, 0, -7);
  b.position.copy(a.position);

  const grid = new CrowdGrid();
  grid.resolve([b, a], testSpatial(() => false), null, false);

  const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
  expect(Number.isFinite(distance)).toBe(true);
  expect(distance).toBeGreaterThanOrEqual(0.72);
  // Depenetration must not make a coincident pair drift across the pavement.
  expect((a.position.x + b.position.x) * 0.5).toBeCloseTo(12, 8);
  expect((a.position.z + b.position.z) * 0.5).toBeCloseTo(-7, 8);
});

test('a batch of anchored spawns publishes non-overlapping roots immediately', () => {
  const peds: Ped[] = [];
  const grid = new CrowdGrid();
  const spatial = testSpatial(() => false);

  for (let i = 0; i < 80; i++) {
    const pair = Math.floor(i / 2);
    const x = (pair % 10) * 3;
    const z = Math.floor(pair / 10) * 3;
    const p = activePed(x, z);
    p.anchorAt(x, z, 0, {
      kind: i % 2 === 0 ? 'talk' : 'listen',
      pose: i % 2 === 0 ? 'talk' : 'idle',
      duration: 30,
      facesGroup: true,
    });
    peds.push(p);

    grid.publish(peds, spatial, null, false);

    expect(minimumPairDistance(peds)).toBeGreaterThanOrEqual(0.739);
  }

  expect(peds).toHaveLength(80);
  expect(minimumPairDistance(peds)).toBeGreaterThanOrEqual(0.739);
  for (const p of peds) {
    expect(p.object.position.x).toBeCloseTo(p.position.x, 8);
    expect(p.object.position.z).toBeCloseTo(p.position.z, 8);
  }
});

test('depenetrating an anchored cluster moves its anchors with its bodies', () => {
  const members = Array.from({ length: 4 }, () => {
    const p = new Ped();
    p.active = true;
    p.anchorAt(3, -2, 0, {
      kind: 'talk',
      pose: 'talk',
      duration: 30,
      facesGroup: true,
    });
    return p;
  });

  new CrowdGrid().resolve(members, testSpatial(() => false), null, false);

  for (let i = 0; i < members.length; i++) {
    expect(members[i].anchorX).toBeCloseTo(members[i].position.x, 8);
    expect(members[i].anchorZ).toBeCloseTo(members[i].position.z, 8);
    for (let j = i + 1; j < members.length; j++) {
      const d = Math.hypot(
        members[i].position.x - members[j].position.x,
        members[i].position.z - members[j].position.z,
      );
      expect(d).toBeGreaterThanOrEqual(0.72);
    }
  }
});

test('an anchored pedestrian cannot remain coincident with the on-foot player', () => {
  const rng = new Rng('player-overlap-ped');
  const ped = new Ped();
  ped.reset('civilian', makeAppearance('civilian', rng), 5, 9, 0, 1.2, rng);
  ped.anchorAt(5, 9, 0, {
    kind: 'wait',
    pose: 'idle',
    duration: 30,
    facesGroup: false,
  });
  const grid = new CrowdGrid();
  grid.rebuild([ped]);
  const player = new THREE.Vector3(5, 0, 9);

  grid.step(1 / 60, crowdEnv(grid, player));

  const distance = Math.hypot(ped.position.x - player.x, ped.position.z - player.z);
  expect(Number.isFinite(distance)).toBe(true);
  expect(distance).toBeGreaterThanOrEqual(0.86);
});

test('an off-centre vehicle player causes no circular drift without a vehicle sample', () => {
  const rng = new Rng('vehicle-player-overlap-ped');
  const ped = new Ped();
  ped.reset('civilian', makeAppearance('civilian', rng), 5.4, 9, 0, 1.2, rng);
  ped.anchorAt(5.4, 9, 0, {
    kind: 'wait',
    pose: 'idle',
    duration: 30,
    facesGroup: false,
  });
  const grid = new CrowdGrid();
  grid.rebuild([ped]);
  const player = new THREE.Vector3(5, 0, 9);

  grid.step(0.1, crowdEnv(grid, player, true));

  expect(ped.position.x).toBeCloseTo(5.4, 8);
  expect(ped.position.z).toBeCloseTo(9, 8);
});

test('pedestrians moving toward the same point preserve a hard body separation', () => {
  const rng = new Rng('moving-overlap-peds');
  const a = new Ped();
  const b = new Ped();
  a.reset('civilian', makeAppearance('civilian', rng), -0.38, 0, Math.PI / 2, 1.2, rng);
  b.reset('civilian', makeAppearance('civilian', rng), 0.38, 0, -Math.PI / 2, 1.2, rng);
  a.moveTo(new THREE.Vector3(0, 0, 0), 4);
  b.moveTo(new THREE.Vector3(0, 0, 0), 4);
  const grid = new CrowdGrid();
  grid.rebuild([a, b]);
  const env = crowdEnv(grid, null);

  grid.step(0.2, env);

  const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
  expect(distance).toBeGreaterThanOrEqual(0.72);
});

test('a pedestrian cannot cross a thin building blocker between frame endpoints', () => {
  const rng = new Rng('swept-scripted-ped');
  const ped = new Ped();
  ped.reset('civilian', makeAppearance('civilian', rng), 0, 0, Math.PI / 2, 1.2, rng);
  ped.moveTo(new THREE.Vector3(4, 0, 0), 8);
  const grid = new CrowdGrid();
  const env = crowdEnv(grid, null);
  env.spatial = testSpatial((x) => x >= 1.45 && x <= 1.55);
  grid.rebuild([ped]);

  grid.step(0.25, env);

  expect(ped.position.x).toBeGreaterThan(0);
  expect(ped.position.x).toBeLessThan(1.45);
  expect(env.spatial.isBlocked(ped.position.x, ped.position.z)).toBe(false);
});

test('a downed pedestrian cannot tumble through a thin building blocker', () => {
  const rng = new Rng('swept-downed-ped');
  const ped = new Ped();
  ped.reset('civilian', makeAppearance('civilian', rng), 0, 0, Math.PI / 2, 1.2, rng);
  ped.knockDown(1, 0, 8);
  const grid = new CrowdGrid();
  const env = crowdEnv(grid, null);
  env.spatial = testSpatial((x) => x >= 1.45 && x <= 1.55);
  grid.rebuild([ped]);

  grid.step(0.5, env);

  expect(ped.position.x).toBeGreaterThan(0);
  expect(ped.position.x).toBeLessThan(1.45);
  expect(env.spatial.isBlocked(ped.position.x, ped.position.z)).toBe(false);
});

test('standing pedestrians separate from downed bodies without dragging the body', () => {
  const rng = new Rng('downed-body-separation');
  const downed = new Ped();
  downed.reset('civilian', makeAppearance('civilian', rng), 0, 0, 0, 1.2, rng);
  downed.knockDown(0, 0, 2);
  const standing = activePed(0, 0);

  new CrowdGrid().resolve([standing, downed], testSpatial(() => false), null, false);

  expect(downed.position.x).toBeCloseTo(0, 8);
  expect(downed.position.z).toBeCloseTo(0, 8);
  expect(Math.hypot(
    standing.position.x - downed.position.x,
    standing.position.z - downed.position.z,
  )).toBeGreaterThanOrEqual(0.72);
});

test('a downed body stays fixed when only it has a safe separation path', () => {
  const rng = new Rng('downed-body-closed-separation');
  const downed = new Ped();
  downed.reset('civilian', makeAppearance('civilian', rng), 0, 0, 0, 1.2, rng);
  downed.knockDown(0, 0, 2);
  const standing = activePed(0, 0);

  new CrowdGrid().resolve(
    [standing, downed],
    testSpatial(() => false),
    null,
    false,
    (ped, fromX, _fromY, fromZ, dx, dz, result) => {
      if (ped === standing) {
        result.set(fromX, fromZ);
        return 0;
      }
      result.set(fromX + dx, fromZ + dz);
      return 1;
    },
  );

  expect(downed.position.x).toBeCloseTo(0, 8);
  expect(downed.position.z).toBeCloseTo(0, 8);
  expect(standing.position.x).toBeCloseTo(0, 8);
  expect(standing.position.z).toBeCloseTo(0, 8);
});

test('an upright pedestrian cannot stand inside the long axis of a downed body', () => {
  const rng = new Rng('downed-horizontal-envelope');
  const downed = new Ped();
  downed.reset('civilian', makeAppearance('civilian', rng), 0, 0, 0, 1.2, rng);
  downed.knockDown(0, 0, 2);
  const standing = activePed(0, 0.78);

  new CrowdGrid().resolve([downed, standing], testSpatial(() => false), null, false);

  expect(standing.position.z).toBeGreaterThan(1.05);
  expect(downed.position.x).toBeCloseTo(0, 8);
  expect(downed.position.z).toBeCloseTo(0, 8);
});

test('two coincident downed bodies depenetrate deterministically', () => {
  const rng = new Rng('downed-downed-envelope');
  const a = new Ped();
  const b = new Ped();
  a.reset('civilian', makeAppearance('civilian', rng), 0, 0, 0, 1.2, rng);
  b.reset('civilian', makeAppearance('civilian', rng), 0, 0, 0, 1.2, rng);
  a.knockDown(0, 0, 2);
  b.knockDown(0, 0, 2);

  new CrowdGrid().resolve([a, b], testSpatial(() => false), null, false);

  expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThanOrEqual(0.63);
});

test('dogs depenetrate from their owner, other pedestrians, other dogs, and the player', () => {
  const owner = activePed(0, 0);
  const other = activePed(0.2, 0);
  owner.dog = {
    x: 0, y: 0, z: 0, yaw: 0, phase: 0,
    colour: new THREE.Color(), size: 1,
  };
  other.dog = {
    x: 0, y: 0, z: 0, yaw: 0, phase: 0,
    colour: new THREE.Color(), size: 1,
  };

  new CrowdGrid().publish(
    [owner, other],
    testSpatial(() => false),
    new THREE.Vector3(0, 0, 0),
    false,
  );

  for (const ped of [owner, other]) {
    const dog = ped.dog!;
    expect(Math.hypot(dog.x - owner.position.x, dog.z - owner.position.z)).toBeGreaterThanOrEqual(0.54);
    expect(Math.hypot(dog.x - other.position.x, dog.z - other.position.z)).toBeGreaterThanOrEqual(0.54);
    expect(Math.hypot(dog.x, dog.z)).toBeGreaterThanOrEqual(0.49);
  }
  expect(Math.hypot(owner.dog.x - other.dog.x, owner.dog.z - other.dog.z)).toBeGreaterThanOrEqual(0.35);
});

test('a crowd frame is equivalent per pedestrian id when the source list is reversed', () => {
  const appearanceRng = new Rng('order-independent-appearance');
  const appA = makeAppearance('civilian', appearanceRng);
  const appB = makeAppearance('civilian', appearanceRng);
  const a = new Ped();
  const b = new Ped();

  const initialise = () => {
    a.reset('civilian', appA, -0.38, 0, Math.PI / 2, 1.2, new Rng('order-independent-a'));
    b.reset('civilian', appB, 0.38, 0, -Math.PI / 2, 1.2, new Rng('order-independent-b'));
    a.moveTo(new THREE.Vector3(0, 0, 0), 4);
    b.moveTo(new THREE.Vector3(0, 0, 0), 4);
  };
  const run = (order: Ped[]) => {
    initialise();
    const grid = new CrowdGrid();
    const env = crowdEnv(grid, null);
    grid.rebuild(order);
    grid.step(0.05, env);
    return new Map(order.map((p) => [p.id, p.position.clone()]));
  };

  const forward = run([a, b]);
  const reverse = run([b, a]);

  for (const p of [a, b]) {
    expect(reverse.get(p.id)?.x).toBeCloseTo(forward.get(p.id)!.x, 8);
    expect(reverse.get(p.id)?.z).toBeCloseTo(forward.get(p.id)!.z, 8);
  }
});

test('a passing pedestrian depenetrates without permanently dragging a loiter anchor', () => {
  const loiterer = new Ped();
  loiterer.active = true;
  loiterer.anchorAt(8, 4, 0, {
    kind: 'phone',
    pose: 'phone',
    duration: 30,
    facesGroup: false,
  });
  const passerby = new Ped();
  passerby.active = true;
  passerby.mode = 'route';
  passerby.position.set(8, 0, 4);

  new CrowdGrid().resolve(
    [passerby, loiterer],
    testSpatial(() => false),
    null,
    false,
  );

  expect(loiterer.position.x).toBeCloseTo(8, 8);
  expect(loiterer.position.z).toBeCloseTo(4, 8);
  expect(loiterer.anchorX).toBe(8);
  expect(loiterer.anchorZ).toBe(4);
  expect(Math.hypot(
    loiterer.position.x - passerby.position.x,
    loiterer.position.z - passerby.position.z,
  )).toBeGreaterThanOrEqual(0.72);
});
