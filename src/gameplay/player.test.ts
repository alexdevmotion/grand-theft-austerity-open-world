/**
 * LOCOMOTION AND FOOTING INVARIANTS.
 *
 * Two bug reports from the owner, one test file:
 *
 *   "Diagonal walking and running is not rendered diagonally — i.e. W+D or
 *    W+A, the character runs forward somehow."
 *   "The character's feet are still sinking a bit into the ground."
 *
 * Both are decidable without a GPU or a physics world, because both come down
 * to arithmetic that lives in pure functions: which way the body should point
 * given the camera and the travel, and which of several disagreeing ground
 * heights the soles belong on. What is NOT decidable here — that the resulting
 * pose reads as a diagonal run on screen — is checked in the browser.
 *
 * Run with `bun test`.
 */

import { expect, test } from 'bun:test';
import {
  bodyTravel,
  cameraTravel,
  bodyYawTarget,
  footSurface,
  playerSpawnFromPlace,
  travelBodyYaw,
} from './player';
import { PLACES } from '../content/places';
import { CHARACTER_SKIN, capsuleRestHeight } from '../physics/physics';

const DEG = Math.PI / 180;

/** Shortest signed angle from `b` to `a`. */
function delta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * The full input -> body pipeline for one stick position at one camera yaw,
 * with the body already settled on its target (the damp in `walkUpdate` only
 * decides how fast it gets there, not where "there" is).
 */
function press(camYaw: number, moveX: number, moveY: number, aiming = false): {
  offCam: number; f: number; s: number;
} {
  const dir = cameraTravel(camYaw, moveX, moveY);
  const len = Math.hypot(dir.x, dir.z);
  const travelYaw = Math.atan2(dir.x, dir.z);
  const bodyYaw = travelBodyYaw(camYaw, travelYaw, aiming);
  const t = bodyTravel(bodyYaw, dir.x / len, dir.z / len);
  return { offCam: delta(bodyYaw, camYaw), f: t.f, s: t.s };
}

/* ------------------------------------------------------------------ */
/* 1. DIAGONAL TRAVEL                                                  */
/* ------------------------------------------------------------------ */

/**
 * THE BUG. W+D used to leave the body square to the camera and express the
 * diagonal entirely as a strafe blend, which reads as running forward with a
 * limp rather than running off at an angle. The body has to turn into it.
 */
test.each([0, 0.7, -2.4, Math.PI - 0.01, 3.9])(
  'camera yaw %p: W+D and W+A turn the body a full 45 degrees into the diagonal',
  (camYaw: number) => {
    for (const [moveX, sign] of [[1, -1], [-1, 1]] as const) {
      const p = press(camYaw, moveX, 1);
      // The body ends up 45 degrees off the camera — the direction of travel.
      expect(p.offCam).toBeCloseTo(sign * 45 * DEG, 4);
      // And having turned, the travel is straight ahead IN BODY SPACE, so the
      // gait is a run, not a side-step. That is the whole point: the diagonal
      // is carried by the yaw, not smuggled through the strafe axis.
      expect(p.f).toBeCloseTo(1, 5);
      expect(Math.abs(p.s)).toBeLessThan(1e-5);
    }
  },
);

test('a diagonal is a diagonal in the world, not just in the pose', () => {
  // Camera looking down +Z. W+D must travel 45 degrees to screen-right of it,
  // which in this basis is -X, and the body must point the same way.
  const dir = cameraTravel(0, 1, 1);
  expect(dir.x).toBeCloseTo(-1, 6);
  expect(dir.z).toBeCloseTo(1, 6);
  const travelYaw = Math.atan2(dir.x, dir.z);
  expect(travelYaw).toBeCloseTo(-45 * DEG, 6);
  expect(travelBodyYaw(0, travelYaw)).toBeCloseTo(travelYaw, 6);
});

/* ------------------------------------------------------------------ */
/* 2. THE BACKPEDAL AND THE SIDE-STEP MUST NOT REGRESS                 */
/* ------------------------------------------------------------------ */

/**
 * The previous fix. Facing the direction of travel made S a spin-and-run: the
 * character turned his back on the camera and jogged away "forwards". Turning
 * the body into diagonals must not bring that back.
 */
test.each([0, 1.3, -2.9])('camera yaw %p: S stays square to the camera and backpedals', (camYaw: number) => {
  const p = press(camYaw, 0, -1);
  expect(Math.abs(p.offCam)).toBeLessThan(1e-9);
  // Travel is straight backwards in body space — the reversed leg cycle.
  expect(p.f).toBeCloseTo(-1, 5);
  expect(Math.abs(p.s)).toBeLessThan(1e-5);
});

test.each([0, 1.3, -2.9])('camera yaw %p: A and D side-step, they do not turn the body', (camYaw: number) => {
  for (const [moveX, sign] of [[1, -1], [-1, 1]] as const) {
    const p = press(camYaw, moveX, 0);
    expect(Math.abs(p.offCam)).toBeLessThan(1e-9);
    expect(Math.abs(p.f)).toBeLessThan(1e-5);
    // +S is travel toward the character's LEFT (rig.ts), so D is negative.
    expect(Math.sign(p.s)).toBe(sign);
    expect(Math.abs(p.s)).toBeCloseTo(1, 5);
  }
});

test('S+D is a reversing side-step, not a body turned backwards', () => {
  const p = press(0, 1, -1);
  expect(Math.abs(p.offCam)).toBeLessThan(1e-9);
  expect(p.f).toBeLessThan(-0.7);
  expect(p.s).toBeLessThan(-0.7);
});

/**
 * Handing the offset over between the body and the blend has to be smooth, or
 * a stick sweeping from ahead to abeam snaps the character round mid-stride.
 */
test('the body/blend handover is continuous and never over-rotates', () => {
  let prev = travelBodyYaw(0, 0);
  let peak = 0;
  for (let deg = 0; deg <= 180; deg += 1) {
    const rel = deg * DEG;
    const yaw = travelBodyYaw(0, rel);
    // Never past the travel direction itself — the body leads nothing.
    expect(Math.abs(yaw)).toBeLessThanOrEqual(rel + 1e-9);
    // A hard switch between "face travel" and "face camera" would step ~57
    // degrees here. Handing the offset back over a band costs a few degrees of
    // body yaw per degree of stick, which the yaw damp absorbs.
    expect(Math.abs(yaw - prev)).toBeLessThan(3.5 * DEG);
    peak = Math.max(peak, Math.abs(yaw));
    prev = yaw;
  }
  // It really does reach a full diagonal somewhere in there...
  expect(peak).toBeGreaterThan(50 * DEG);
  // ...and really does hand everything back by the time travel is abeam.
  expect(travelBodyYaw(0, 90 * DEG)).toBeCloseTo(0, 6);
  expect(travelBodyYaw(0, 180 * DEG)).toBeCloseTo(0, 6);
});

/**
 * The seam an aim mode plugs into: sighting a weapon needs the body square to
 * the camera at EVERY travel direction, diagonals included.
 */
test('aiming pins the body to the camera in every direction', () => {
  for (let deg = -180; deg <= 180; deg += 15) {
    expect(travelBodyYaw(1.1, 1.1 + deg * DEG, true)).toBeCloseTo(1.1, 9);
  }
  // And with the body pinned, a diagonal is expressed by the blend instead.
  const p = press(0, 1, 1, true);
  expect(Math.abs(p.offCam)).toBeLessThan(1e-9);
  expect(p.f).toBeCloseTo(Math.SQRT1_2, 5);
  expect(p.s).toBeCloseTo(-Math.SQRT1_2, 5);
});

/* ------------------------------------------------------------------ */
/* 3. SOLE CONTACT                                                     */
/* ------------------------------------------------------------------ */

/** Bucharest's footways. Matches KERB_H in `src/world/city/roads.ts`. */
const KERB_H = 0.17;
const HALF_HEIGHT = 1.805 * 0.5 - 0.32;
const RADIUS = 0.32;

test('a settled capsule stands a shoe sole clear of the surface, never in it', () => {
  // The clearance is a property of the character controller, not of the place.
  for (const surface of [0, KERB_H, 2.5, -1.25]) {
    const centre = capsuleRestHeight(surface, HALF_HEIGHT, RADIUS);
    const base = centre - HALF_HEIGHT - RADIUS;
    expect(base - surface).toBeCloseTo(CHARACTER_SKIN, 9);
    expect(base).toBeGreaterThan(surface);
  }
  // A sole thickness, not a step. Anything past this reads as floating, and a
  // negative skin is the sinking this whole file exists to stop.
  expect(CHARACTER_SKIN).toBeGreaterThan(0);
  expect(CHARACTER_SKIN).toBeLessThanOrEqual(0.03);
});

/**
 * THE OTHER BUG, in one number. Standing on a raised footway the capsule can
 * come to rest against the KERB FACE rather than its top, and a ray down the
 * middle of the capsule can find the carriageway a few centimetres beside the
 * slab he is on. Either way the soles must end up on the footway.
 */
test('on a kerb the soles land on the footway, not on the carriageway beside it', () => {
  // Settled on the footway: base is one skin above the kerb top.
  const onKerb = KERB_H + CHARACTER_SKIN;

  // Standing on the kerb EDGE. The probe ray goes down through the last few
  // centimetres of overhang and finds the carriageway; the capsule sweep has
  // the whole footprint and found the kerb nose. The soles follow the capsule.
  expect(footSurface(onKerb, 0, KERB_H, KERB_H)).toBeCloseTo(KERB_H, 9);
  // The sweep alone is enough — no analytic footway height needed.
  expect(footSurface(onKerb, 0, KERB_H, null)).toBeCloseTo(KERB_H, 9);
  // And the analytic height alone is enough, for the coarse-trimesh corners
  // where the collision world has no footway at all. This is the last-resort
  // correction the whole footing pass started life as.
  expect(footSurface(onKerb, 0, null, KERB_H)).toBeCloseTo(KERB_H, 9);
  // Everything agreeing changes nothing.
  expect(footSurface(onKerb, KERB_H, KERB_H, KERB_H)).toBeCloseTo(KERB_H, 9);
  // Out on the carriageway, the kerb must not levitate him.
  expect(footSurface(CHARACTER_SKIN, 0, 0, 0)).toBeCloseTo(0, 9);
});

test('footing rejects surfaces that belong to a different storey', () => {
  // Standing on a footbridge with a road 6 m below: the analytic ground height
  // is for the road and has no business dragging the soles down to it.
  expect(footSurface(6.0, 6.0, 6.0, 0)).toBeCloseTo(6.0, 9);
  // A capsule sweep that found something ABOVE the capsule base is something
  // he is standing BESIDE, not on.
  expect(footSurface(0.02, 0, 1.4, 0)).toBeCloseTo(0, 9);
  // Nothing has an opinion: say so, rather than inventing one.
  expect(footSurface(0.02, null, null, null)).toBeNull();
});

/* ------------------------------------------------------------------ */
/* 4. CAMERA-RELATIVE INPUT                                            */
/* ------------------------------------------------------------------ */

test('stick input is camera-relative and A/D are not swapped', () => {
  // Camera down +Z: W is +Z, D is -X (F x up), S is -Z, A is +X.
  const w = cameraTravel(0, 0, 1);
  expect(w.x).toBeCloseTo(0, 9);
  expect(w.z).toBeCloseTo(1, 9);
  const d = cameraTravel(0, 1, 0);
  expect(d.x).toBeCloseTo(-1, 9);
  expect(d.z).toBeCloseTo(0, 9);

  // Turn the camera a quarter turn and the same key travels a quarter turn.
  const wTurned = cameraTravel(Math.PI / 2, 0, 1);
  expect(wTurned.x).toBeCloseTo(1, 9);
  expect(wTurned.z).toBeCloseTo(0, 9);
});

/* ------------------------------------------------------------------ */
/* 5. FREE LOOK MUST NOT TURN THE BODY                                  */
/* ------------------------------------------------------------------ */

test('mouse-only orbit leaves the on-foot body heading unchanged', () => {
  const bodyYaw = 0.35;
  // The camera can be anywhere after a long mouse orbit. With no movement,
  // the public locomotion target must still be the body's existing heading.
  expect(bodyYawTarget(bodyYaw, 2.4, 2.4, false)).toBeCloseTo(bodyYaw, 12);
  expect(bodyYawTarget(bodyYaw, -2.4, -2.4, false)).toBeCloseTo(bodyYaw, 12);
});

test('opening spawn is on the forecourt, clear of the builders, facing the sealed entrance', () => {
  const start = playerSpawnFromPlace();
  // Independent authored coordinates: the intended opening composition is
  // (-59, 11), not whatever arithmetic a future implementation happens to
  // use to reach it.
  expect(start.x).toBe(-59);
  expect(start.z).toBe(11);
  // The three outside builders occupy z=20..22.8; the player starts south of
  // them, with a clear view of the public entrance at the tower's south face.
  expect(start.z).toBeLessThan(PLACES.buildersForecourt.z - 6);
  expect(start.yaw).toBeGreaterThan(0.4);
  expect(start.yaw).toBeLessThan(0.7);
});
