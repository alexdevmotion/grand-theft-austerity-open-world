/**
 * VEHICLE INVARIANTS — the four things about the Dacia that were wrong, each
 * pinned by a number rather than by a screenshot.
 *
 * Every one of these was reported as a visual defect and every one of them is
 * decidable without a GPU:
 *
 *  1. "The Dacia spawns as TWO FULL STACKED BODIES." It does not, and never
 *     did — the body is built once. What stacked was two VEHICLES spawned at
 *     the same point. The bounding box of a built shell is what tells the two
 *     apart, so it is asserted here; the spawn side of it lives in
 *     `VehicleSystem.clearSpawnPoint`.
 *  2. "Wheels are featureless black discs." The hubcap was authored correctly
 *     and then placed 8% of the tread width down inside the rim well, where no
 *     light reaches it. The cap face must sit at the tyre's outer bead plane.
 *  3. "The rear wheel arch half-skirts the wheel." The opening must clear the
 *     tyre silhouette at every station across the arch.
 *  4. "The beltline kicks up over the rear quarter." The shoulder must run
 *     straight from the cabin to the tail.
 *
 * Run with `bun test`.
 */

import { expect, test } from 'bun:test';
import { MODELS } from './models';
import { carArchY, carTopY, type CarDesign } from './carkit';
import { wheelGeometry } from './wheels';

const dacia = MODELS.dacia1300.spec as CarDesign;

/* ------------------------------------------------------------------ */
/* 1. ONE BODY PER CAR                                                 */
/* ------------------------------------------------------------------ */

/**
 * A stacked pair of Dacias is roughly twice as tall as one Dacia, and that is
 * the cheapest way to tell "the builder emitted the body twice" apart from
 * "two vehicles are parked inside each other". The shell is built in body-local
 * space with the ground plane at `-rideHeight`, so its height above that plane
 * is the car's height plus whatever sticks up (the aerial).
 */
test('a built body is one body, not two stacked', () => {
  for (const id of ['dacia1300', 'dacia1310', 'logan', 'sedanModern']) {
    const model = MODELS[id];
    const build = model.build(0, id === 'dacia1300');
    const box = build.shell.boundingBox!;
    const ground = -model.spec.rideHeight;
    const above = box.max.y - ground;
    // Height plus the aerial, and nothing like a second roof on top of it.
    expect(above).toBeGreaterThan(model.spec.height * 0.9);
    expect(above).toBeLessThan(model.spec.height + 0.55);
    // Nothing hangs a full body's worth below the road either.
    expect(box.min.y - ground).toBeGreaterThan(-0.30);
  }
});

/** The body cache must hand back the SAME geometry, never a fresh build. */
test('bodies are cached, so a respawn cannot double the geometry', async () => {
  const { buildBody, cachedBodyStats } = await import('./bodies');
  const a = buildBody('dacia', 0, true);
  const before = cachedBodyStats();
  const b = buildBody('dacia', 0, true);
  const after = cachedBodyStats();
  expect(b.shell).toBe(a.shell);
  expect(after.bodies).toBe(before.bodies);
  expect(after.triangles).toBe(before.triangles);
});

/* ------------------------------------------------------------------ */
/* 2. THE HUBCAP IS IN THE LIGHT                                       */
/* ------------------------------------------------------------------ */

/**
 * The tyre carcass closes at ±W/2 with a bead annulus running down to 0.66 R.
 * Everything inside that radius is an aperture. If the cap face does not reach
 * the aperture plane, the wheel is a hole with chrome at the bottom of it —
 * which is exactly how four chrome hubcaps rendered as four black discs.
 */
test('the hubcap fills the tyre aperture instead of hiding in the rim well', () => {
  const R = dacia.wheelRadius;
  const W = dacia.tyreWidth;
  for (const side of [1, -1] as const) {
    const geo = wheelGeometry('hubcap', R, W, side);
    const pos = geo.attributes.position;
    // Outboard 10% of the tread width — where a real cap lives.
    const plane = W * 0.5 - W * 0.10;
    let outerCapRadius = 0;
    let capVerts = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      if (Math.sign(x) !== side || Math.abs(x) < plane) continue;
      const r = Math.hypot(pos.getY(i), pos.getZ(i));
      // Ignore the tyre itself, which also reaches this plane.
      if (r > R * 0.70) continue;
      capVerts++;
      if (r > outerCapRadius) outerCapRadius = r;
    }
    expect(capVerts).toBeGreaterThan(20);
    // The cap has to reach out to the bead, not stop at a small button.
    expect(outerCapRadius).toBeGreaterThan(R * 0.58);
  }
});

/* ------------------------------------------------------------------ */
/* 3. THE ARCH IS OPEN                                                 */
/* ------------------------------------------------------------------ */

/**
 * `carArchY` is the bottom of the flank at a given z. The tyre, seen from the
 * side, is a circle of radius `wheelRadius` centred at the hub. The flank must
 * stay above it everywhere, at BOTH axles — a rear arch that dips into the
 * circle is a skirt.
 */
test('both wheel arches clear the tyre they sit over', () => {
  for (const ax of [dacia.frontAxleZ, dacia.rearAxleZ]) {
    for (let i = -20; i <= 20; i++) {
      const dz = (i / 20) * dacia.wheelRadius * 0.98;
      const tyreTop = dacia.wheelRadius + Math.sqrt(Math.max(0, dacia.wheelRadius ** 2 - dz * dz));
      const arch = carArchY(dacia, ax + dz);
      expect(arch).toBeGreaterThan(tyreTop + 0.035);
    }
  }
});

/** The opening must be an arch, not a slot: it has to rise well off the sill. */
test('the arch opening is struck from the hub, not from the sill', () => {
  for (const ax of [dacia.frontAxleZ, dacia.rearAxleZ]) {
    expect(carArchY(dacia, ax)).toBeGreaterThan(dacia.sill + dacia.wheelRadius);
  }
});

/* ------------------------------------------------------------------ */
/* 4. THE SHOULDER RUNS STRAIGHT                                       */
/* ------------------------------------------------------------------ */

/**
 * On a 1300 the shoulder is dead straight from the headlamp to the tail lamp
 * and the boot lid is flat and level with the doors. A boot that sits proud of
 * the belt puts a visible kick-up behind the C pillar.
 */
test('the beltline does not kick up over the rear quarter', () => {
  const tail = -dacia.length * 0.5;
  for (let z = tail + dacia.tailRound; z <= dacia.rsBase; z += 0.05) {
    expect(carTopY(dacia, z)).toBeLessThan(dacia.belt + 0.02);
  }
  // ...and it does not sag into the boot lid either.
  expect(carTopY(dacia, (tail + dacia.rsBase) * 0.5)).toBeGreaterThan(dacia.belt - 0.02);
});

/* ------------------------------------------------------------------ */
/* 5. THE FACE IS A 1300's FACE                                        */
/* ------------------------------------------------------------------ */

/**
 * `docs/LIKENESS.md` records a correction that has already been got wrong once
 * in the other direction: the 1300 has RECTANGULAR headlamps with round
 * auxiliaries, not round main lights. Pin the styling choice so a future pass
 * cannot quietly revert it.
 */
test('the 1300 keeps rectangular lamps, fine slats and chrome bumpers', () => {
  expect(dacia.lamps).toBe('rect1300');
  expect(dacia.grille).toBe('fineSlats');
  expect(dacia.bumpers).toBe('chrome');
  expect(dacia.brightwork).toBe(true);
  expect(dacia.wheelStyle).toBe('hubcap');
});

test('vehicle door names and visible driver use the left-hand side', () => {
  for (const id of ['dacia1300', 'logan', 'panelVan', 'roman']) {
    const model = MODELS[id];
    const build = model.build(0, id === 'dacia1300');
    const frontLeft = build.doors?.find((door) => door.id === 'frontLeft');
    const frontRight = build.doors?.find((door) => door.id === 'frontRight');

    expect(frontLeft?.side).toBe(1);
    expect(frontRight?.side).toBe(-1);
    const driverBox = build.driver?.boundingBox;
    expect(driverBox).toBeDefined();
    expect((driverBox!.min.x + driverBox!.max.x) * 0.5).toBeGreaterThan(0);
  }
});
