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
 *     geometry was used on both sides of the car. Every wheel on the left-hand
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

const lin = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();

const RUBBER = lin(0x16161b);
const RUBBER_WORN = lin(0x2a2a31);
const RIM_STEEL = lin(0xc3c7d4);
const RIM_DARK = lin(0x33333c);
const CHROME = lin(0xe4e9f5);

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
  const seg = style === 'scooter' ? 14 : style === 'truck' ? 22 : 20;

  // `side` flips which face carries the rim detail. Everything is authored for
  // the right-hand side and mirrored by negating X.
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

  const faceX = sx * (hw - W * 0.08);
  const innerX = sx * (-hw + W * 0.05);

  if (style === 'scooter') {
    b.cyl(R * 0.72, R * 0.72, W * 0.55, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.4, metal: 0.85, coat: 0.3 });
    b.cyl(R * 0.16, R * 0.16, W * 1.4, 8, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_STEEL, rough: 0.3, metal: 0.95, coat: 0.3 });
  } else if (style === 'hubcap') {
    // Steel wheel with a chromed hubcap — the Dacia's signature small wheel.
    b.cyl(R * 0.70, R * 0.70, W * 0.78, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.55, metal: 0.6, coat: 0.2 });
    b.cyl(R * 0.70, R * 0.64, W * 0.11, seg, T(faceX - sx * W * 0.05, 0, 0, 0, 0, -sx * Math.PI / 2), {
      color: CHROME, rough: 0.12, metal: 1, coat: 0.4, uv: UV.hubcap,
    });
    // Slightly domed centre.
    b.sphere(R * 0.36, 12, T(faceX + sx * W * 0.02, 0, 0, 0, 0, 0, 0.32, 1, 1), {
      color: CHROME, rough: 0.10, metal: 1, coat: 0.45, uv: UV.hubcap,
    });
    // Chrome lug ring.
    b.torus(R * 0.46, R * 0.032, 6, seg, Math.PI * 2, T(faceX + sx * W * 0.02, 0, 0, 0, Math.PI / 2, 0), {
      color: CHROME, rough: 0.14, metal: 1, coat: 0.4,
    });
  } else if (style === 'alloy') {
    b.cyl(R * 0.74, R * 0.74, W * 0.76, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.35, metal: 0.9, coat: 0.3 });
    b.cyl(R * 0.72, R * 0.66, W * 0.10, seg, T(faceX, 0, 0, 0, 0, -sx * Math.PI / 2), { color: RIM_STEEL, rough: 0.22, metal: 0.95, coat: 0.4 });
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
    // Plain painted steel wheel with a small chrome cap.
    b.cyl(R * 0.70, R * 0.70, W * 0.76, seg, T(0, 0, 0, 0, 0, Math.PI / 2), { color: RIM_DARK, rough: 0.6, metal: 0.55, coat: 0.2 });
    b.cyl(R * 0.68, R * 0.50, W * 0.12, seg, T(faceX, 0, 0, 0, 0, -sx * Math.PI / 2), { color: RIM_STEEL, rough: 0.42, metal: 0.8, coat: 0.3, uv: UV.hubcap });
    b.cyl(R * 0.20, R * 0.20, W * 0.08, 10, T(faceX + sx * W * 0.06, 0, 0, 0, 0, -sx * Math.PI / 2), { color: CHROME, rough: 0.18, metal: 1, coat: 0.4 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      b.cyl(R * 0.045, R * 0.045, W * 0.08, 6,
        T(faceX + sx * W * 0.05, Math.sin(a) * R * 0.30, Math.cos(a) * R * 0.30, 0, 0, -sx * Math.PI / 2),
        { color: CHROME, rough: 0.24, metal: 1, coat: 0.3 });
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
