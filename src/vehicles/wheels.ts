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
  const seg = style === 'scooter' ? 24 : 32;
  const rimSeg = 24;

  // `side` flips which face carries the rim detail. Everything is authored for
  // the +X (left-hand) side and mirrored by negating X.
  const sx = side;
  const tyre: Surf = { color: RUBBER, rough: 0.95, metal: 0.02, coat: 0.08, uv: UV.tread };
  const wall: Surf = { color: RUBBER_WORN, rough: 0.88, metal: 0.02, coat: 0.05, uv: UV.sidewall };

  /* ---- tyre carcass: a small lathe so the tyre has a real crowned profile ---- */
  const hw = W * 0.5;
  const profile: Array<[number, number]> = [
    [-hw * .94, R * .66], [-hw, R * .76], [-hw * 1.02, R * .86],
    [-hw * .96, R * .93], [-hw * .78, R * .982], [-hw * .38, R],
    [hw * .38, R], [hw * .78, R * .982], [hw * .96, R * .93],
    [hw * 1.02, R * .86], [hw, R * .76], [hw * .94, R * .66],
  ];
  // A continuous lathe carries the toroidal shoulder normals across bands.
  // Independent frustums previously produced hard rings across the sidewall.
  const carcass = new THREE.LatheGeometry(profile.map(([x, r]) => new THREE.Vector2(r, x)), rimSeg);
  b.add(carcass, T(0, 0, 0, 0, 0, -sx * Math.PI / 2), wall);
  carcass.dispose();
  b.cyl(R * 1.001, R * 1.001, W * .75, seg, T(0, 0, 0, 0, 0, -sx * Math.PI / 2), tyre, true);

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
    // Original 13-inch pressed-steel wheel: silver outer rim, eight ventilating
    // slots, and a SMALL domed chrome cap. A single full-size chrome disc loses
    // the visible rim well and makes the tire resemble a toy button.
    const steel: Surf = { color: lin(0xa9acab), rough: .31, metal: .82, coat: .18 };
    const chrome: Surf = { color: CHROME, rough: .13, metal: .94, coat: .32 };
    const dark: Surf = { color: RIM_DARK, rough: .58, metal: .58 };
    b.cyl(apertureR * .99, apertureR * .99, W * .80, seg,
      T(0, 0, 0, 0, 0, Math.PI / 2), dark);
    const dishProfile = [[R * .20, hw - W * .04], [R * .34, hw - W * .04],
      [R * .45, hw - W * .10], [R * .51, hw - W * .15],
      [R * .57, hw - W * .09], [R * .63, hw - W * .015], [R * .66, hw - W * .025]];
    const dish = new THREE.LatheGeometry(dishProfile.reverse().map(([r, x]) => new THREE.Vector2(r, x)), rimSeg);
    b.add(dish, T(0, 0, 0, 0, 0, -sx * Math.PI / 2), steel); dish.dispose();
    b.torus(R * .645, R * .012, 4, rimSeg, Math.PI * 2, T(faceX, 0, 0, 0, Math.PI / 2), steel);
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      b.sphere(1, 8,
        T(sx * (hw - W * .085), Math.sin(angle) * R * .525, Math.cos(angle) * R * .525,
          -angle, 0, 0, W * .0125, R * .037, R * .075),
        { color: lin(0x111313), rough: .85, metal: .1 });
    }
    b.sphere(R * .405, 16, T(faceX, 0, 0, 0, 0, 0, .27, 1, 1), chrome);
    b.torus(R * .400, R * .009, 4, rimSeg, Math.PI * 2,
      T(faceX + sx * W * .010, 0, 0, 0, Math.PI / 2), chrome);
    b.cyl(R * .060, R * .066, W * .025, 20,
      T(faceX + sx * R * .112, 0, 0, 0, 0, -sx * Math.PI / 2), steel);
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
      b.torus(R * ring, R * 0.006, 4, rimSeg, Math.PI * 2,
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
