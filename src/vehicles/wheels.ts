/**
 * Wheels. Built once per (style, radius, width, side) and shared by every
 * vehicle using them, so 40 cars on screen still means two wheel geometries in
 * VRAM per class.
 *
 * The wheel axis is +X: the vehicle system spins them with `rotation.x` and
 * steers with `rotation.y` (YXZ order).
 *
 * Two things were badly wrong before and are fixed here:
 *
 *  1. The hubcap/rim detail was only ever built on the +X face, and the same
 *     geometry was used on both sides of the car. Every wheel on the negative-X
 *     side therefore presented its blanked-off *inner* face to the camera — a
 *     flat black disc sitting in the arch, which reads exactly like a missing
 *     wheel. `wheelGeometry` now takes a side and mirrors properly.
 *
 *  2. The whole wheel was welded with a 36-degree smoothing angle. That is
 *     wider than the angle between the tread band and the sidewall frustum, so
 *     the crease between them was averaged away and a truck tyre came out as a
 *     smooth black ball. Wheels now weld at 16 degrees: round around the
 *     circumference, crisp across the shoulder.
 */

import * as THREE from 'three';
import { GeoBuilder, T, type Surf } from './builder';
import { UV } from './texture';

export type WheelStyle = 'hubcap' | 'steel' | 'alloy' | 'truck' | 'scooter';

const lin = (hex: number) => new THREE.Color(hex);

const RUBBER = lin(0x16161b);
const RUBBER_WORN = lin(0x2a2a31);
const RIM_STEEL = lin(0x8d919c);
const RIM_DARK = lin(0x2a2a32);
const CHROME = lin(0xbcc2d2);
const CHROME_DULL = lin(0x8d93a4);

const cache = new Map<string, THREE.BufferGeometry>();

/** Weld angle that keeps the circumference round but the shoulders sharp. */
const WHEEL_SMOOTH = 16;

export function wheelGeometry(
  style: WheelStyle, radius: number, width: number, side: 1 | -1 = 1,
): THREE.BufferGeometry {
  const key = `${style}|${radius.toFixed(3)}|${width.toFixed(3)}|${side}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const b = new GeoBuilder();
  const R = radius;
  const W = width;
  const seg = style === 'scooter' ? 20 : 32;

  // `side` flips which face carries the rim detail. Everything is authored for
  // the +X (left-hand) side and mirrored by negating X.
  const sx = side;
  const tyre: Surf = { color: RUBBER, rough: 0.95, metal: 0.02, coat: 0.08, uv: UV.tread };
  const wall: Surf = { color: RUBBER_WORN, rough: 0.88, metal: 0.02, coat: 0.05, uv: UV.sidewall };

  /* ---- tyre carcass: a small lathe so the tyre has a real crowned profile ---- */
  const hw = W * 0.5;
  const profile: Array<[number, number]> = [
    [-hw, R * 0.66],           // inner bead
    [-hw, R * 0.86],
    [-hw * 0.86, R * 0.975],   // inner shoulder
    [-hw * 0.52, R * 1.0],
    [hw * 0.52, R * 1.0],      // crown
    [hw * 0.86, R * 0.975],    // outer shoulder
    [hw, R * 0.86],
    [hw, R * 0.66],            // outer bead
  ];
  // rz = -sx * PI/2 sends the cylinder's +Y (its `rTop` end) to +sx * X, so the
  // profile is laid out inboard → outboard in the direction the side wants.
  for (let i = 0; i < profile.length - 1; i++) {
    const [x0, r0] = profile[i];
    const [x1, r1] = profile[i + 1];
    b.cyl(r1, r0, Math.abs(x1 - x0) || 1e-4, seg,
      T(sx * (x0 + x1) * 0.5, 0, 0, 0, 0, -sx * Math.PI / 2),
      i === 3 ? tyre : wall, true);
  }

  /**
   * The plane the rim detail lives in.
   *
   * The tyre carcass closes at `hw` with a flat bead annulus running down to
   * `R * 0.66`, so everything inside that radius is an APERTURE you look
   * through. The face used to be struck at `hw - W*0.08` — a full 8% of the
   * tread width down inside the rim well, where nothing but bounced light ever
   * reaches it. That is why every wheel in the city read as a featureless black
   * disc: the chrome was there, it was just at the bottom of a hole. The face
   * now sits essentially flush with the tyre's outer sidewall, which is also
   * where a real hubcap sits.
   */
  const faceX = sx * (hw - W * 0.03);
  const innerX = sx * (-hw + W * 0.05);
  /** Radius at which the tyre's bead annulus closes — the aperture a cap fills. */
  const apertureR = R * 0.66;

  if (style === 'scooter') {
    b.cyl(R * 0.72, R * 0.72, W * 0.55, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.4, metal: 0.85, coat: 0.3 });
    b.cyl(R * 0.16, R * 0.16, W * 1.4, 8, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_STEEL, rough: 0.3, metal: 0.95, coat: 0.3 });
  } else if (style === 'hubcap') {
    /**
     * Steel wheel behind a FULL-FACE CHROME HUBCAP — the Dacia's signature.
     *
     * Look at `docs/reference/world/dacia-1300.jpg`: the cap is not a small
     * button in the middle of a black wheel, it is a dish covering roughly
     * two thirds of the tyre's diameter, sitting in the plane of the sidewall
     * with a bright rolled outer flange, a ring of stamped slots and a
     * polished raised centre. It is the single brightest thing on the lower
     * half of the car and the reason a parked 1300 does not read as four
     * black holes.
     */
    const capR = apertureR;
    // metal 0.86, not 1: a fully metallic surface has NO diffuse term, so in the
    // shadow of its own arch — which is where a wheel spends its life — it has
    // nothing but the environment lobe to show and goes black. Real hubcaps are
    // dulled, scratched chrome; leaving a little diffuse in keeps them readable
    // on the shaded side of the car without making them look painted.
    const cap: Surf = { color: CHROME, rough: 0.13, metal: 0.86, coat: 0.5, uv: UV.hubcap };
    const capDull: Surf = { color: CHROME_DULL, rough: 0.26, metal: 0.95, coat: 0.3 };
    // Rim well behind the cap, so no daylight shows through the slots.
    b.cyl(R * 0.655, R * 0.655, W * 0.80, seg, T(0, 0, 0, 0, 0, Math.PI / 2),
      { color: RIM_DARK, rough: 0.55, metal: 0.6, coat: 0.2 });
    // Full-face dish. Two shallow cones: a rolled flange that catches the sun,
    // then the dished face that carries the hubcap cell of the atlas.
    b.cyl(capR * 0.955, capR, W * 0.055, seg, T(faceX - sx * W * 0.028, 0, 0, 0, 0, -sx * Math.PI / 2), cap);
    b.cyl(capR * 0.62, capR * 0.955, W * 0.05, seg, T(faceX - sx * W * 0.080, 0, 0, 0, 0, -sx * Math.PI / 2), cap);
    // Bright rolled lip right on the tyre bead — the highlight that separates
    // chrome from rubber at any distance.
    b.torus(capR * 0.965, R * 0.022, 5, seg, Math.PI * 2,
      T(faceX - sx * W * 0.010, 0, 0, 0, Math.PI / 2, 0), cap);
    // Ring of stamped cooling slots.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      b.cyl(R * 0.052, R * 0.052, W * 0.07, 6,
        T(faceX - sx * W * 0.070, Math.sin(a) * capR * 0.74, Math.cos(a) * capR * 0.74, 0, 0, -sx * Math.PI / 2),
        { color: lin(0x0a0a0f), rough: 0.9, metal: 0.1, coat: 0 });
    }
    // Polished centre pan and boss.
    b.cyl(capR * 0.56, capR * 0.62, W * 0.05, seg, T(faceX - sx * W * 0.050, 0, 0, 0, 0, -sx * Math.PI / 2), cap);
    b.torus(capR * 0.58, R * 0.016, 5, seg, Math.PI * 2, T(faceX - sx * W * 0.040, 0, 0, 0, Math.PI / 2, 0), capDull);
    b.sphere(capR * 0.30, 12, T(faceX - sx * W * 0.010, 0, 0, 0, 0, 0, 0.44, 1, 1), cap);
  } else if (style === 'alloy') {
    b.cyl(R * 0.74, R * 0.74, W * 0.76, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.35, metal: 0.9, coat: 0.3 });
    b.cyl(apertureR * 0.92, apertureR, W * 0.10, seg, T(faceX, 0, 0, 0, 0, -sx * Math.PI / 2), { color: RIM_STEEL, rough: 0.22, metal: 0.95, coat: 0.4 });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.box(W * 0.1, R * 0.15, R * 0.64,
        T(faceX + sx * W * 0.03, Math.sin(a) * R * 0.34, Math.cos(a) * R * 0.34, a, 0, 0),
        { color: RIM_STEEL, rough: 0.24, metal: 0.95, coat: 0.4 });
    }
    b.cyl(R * 0.21, R * 0.21, W * 0.14, 10, T(faceX + sx * W * 0.05, 0, 0, 0, 0, -sx * Math.PI / 2), { color: RIM_DARK, rough: 0.36, metal: 0.85, coat: 0.3 });
  } else if (style === 'truck') {
    // Deep-dish steel truck wheel: a real rim well, a hub and eight nuts.
    b.cyl(R * 0.64, R * 0.64, W * 0.84, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.5, metal: 0.75, coat: 0.2 });
    b.cyl(R * 0.63, R * 0.40, W * 0.16, seg, T(faceX - sx * W * 0.02, 0, 0, 0, 0, -sx * Math.PI / 2), {
      color: RIM_STEEL, rough: 0.36, metal: 0.9, coat: 0.3, uv: UV.hubcap,
    });
    b.cyl(R * 0.40, R * 0.40, W * 0.10, seg, T(faceX + sx * W * 0.06, 0, 0, 0, 0, -sx * Math.PI / 2), {
      color: RIM_STEEL, rough: 0.32, metal: 0.92, coat: 0.3, uv: UV.hubcap,
    });
    // hub cap + wheel nuts
    b.cyl(R * 0.17, R * 0.17, W * 0.09, 10, T(faceX + sx * W * 0.11, 0, 0, 0, 0, -sx * Math.PI / 2), { color: CHROME, rough: 0.16, metal: 1, coat: 0.4 });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      b.cyl(R * 0.05, R * 0.05, W * 0.10, 6,
        T(faceX + sx * W * 0.10, Math.sin(a) * R * 0.29, Math.cos(a) * R * 0.29, 0, 0, -sx * Math.PI / 2),
        { color: CHROME, rough: 0.22, metal: 1, coat: 0.35 });
    }
  } else {
    // Plain painted steel wheel (1310, ARO, Oltcit) with a small chrome cap.
    // Same rule as the hubcap: the face closes the tyre's bead aperture instead
    // of hiding at the bottom of the rim well.
    b.cyl(R * 0.655, R * 0.655, W * 0.76, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.6, metal: 0.55, coat: 0.2 });
    b.cyl(apertureR * 0.80, apertureR, W * 0.10, seg, T(faceX - sx * W * 0.03, 0, 0, 0, 0, -sx * Math.PI / 2), { color: RIM_STEEL, rough: 0.42, metal: 0.8, coat: 0.3, uv: UV.hubcap });
    b.cyl(apertureR * 0.36, apertureR * 0.42, W * 0.07, 12, T(faceX - sx * W * 0.01, 0, 0, 0, 0, -sx * Math.PI / 2), { color: CHROME, rough: 0.18, metal: 1, coat: 0.4 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      b.cyl(R * 0.042, R * 0.042, W * 0.07, 6,
        T(faceX - sx * W * 0.02, Math.sin(a) * R * 0.34, Math.cos(a) * R * 0.34, 0, 0, -sx * Math.PI / 2),
        { color: CHROME, rough: 0.24, metal: 1, coat: 0.3 });
    }
  }

  if (style !== 'scooter') {
    // Molded sidewall rings and a valve retain scale at close inspection.
    const sidewall: Surf = { color: RUBBER_WORN, rough: 0.93, metal: 0 };
    for (const ring of [0.73, 0.89]) {
      b.torus(R * ring, R * 0.006, 4, seg, Math.PI * 2,
        T(sx * (hw + 0.001), 0, 0, 0, Math.PI / 2), sidewall);
    }
    b.cyl(0.006, 0.008, 0.025, 6,
      T(faceX + sx * 0.011, R * 0.45, R * 0.35, 0, 0, -sx * Math.PI / 2),
      { color: RUBBER, rough: 0.8, metal: 0.1 });
    if (style === 'steel') {
      // Stamped ventilation holes, recessed against the darker rim well.
      for (let i = 0; i < 8; i++) {
        const a = i / 8 * Math.PI * 2;
        b.cyl(R * 0.055, R * 0.055, 0.006, 8,
          T(faceX + sx * 0.007, Math.sin(a) * R * 0.50, Math.cos(a) * R * 0.50, 0, 0, -sx * Math.PI / 2),
          { color: RIM_DARK, rough: 0.8, metal: 0.2 });
      }
    }
  }

  // Dark inner face so you never see through the wheel.
  b.cyl(R * 0.70, R * 0.70, W * 0.05, seg, T(innerX, 0, 0, 0, 0, -sx * Math.PI / 2), { color: lin(0x07070a), rough: 0.95, metal: 0, coat: 0 });

  // Note: the mirror is expressed as *placement* (every X offset and every
  // cylinder axis flips), never as a negative scale, so triangle winding and
  // normals stay valid without a fix-up pass.
  const g = b.build(WHEEL_SMOOTH);
  cache.set(key, g);
  return g;
}
