/** A shared low-detail Dacia 1300 for the merged city dressing batch.
 * Coordinates and silhouette follow the driveable 1300: +Z forward, 2.44 m
 * wheelbase, raked glass and a 1.43 m roof. No per-car meshes or materials. */
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GeoBuilder, T, type Surf, type Station } from '../../vehicles/builder';
import { DetailBuilder } from './builders';

const C = (hex: number) => new THREE.Color(hex);
const paintTag = new THREE.Color(1, 0, 1), panelTag = new THREE.Color(0, 1, 1);
const rubber: Surf = { color: C(0x1b1c1d), metal: 0, rough: 0.91 };
const trim: Surf = { color: C(0x252b2c), metal: 0.1, rough: 0.68 };
const chrome: Surf = { color: C(0xa9afaf), metal: 0.82, rough: 0.27 };
const glass: Surf = { color: C(0x526b70), metal: 0, rough: 0.22 };
const paint: Surf = { color: paintTag, rough: 0.40, metal: 0.12 };
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
let cached: THREE.BufferGeometry | undefined;

/** Build once; vertex tags are replaced by each parked car's chosen paint. */
export function parkedDaciaTemplate(): THREE.BufferGeometry {
  if (cached) return cached;
  const b = new GeoBuilder();
  const zs = [-2.10, -1.58, -1.37, -1.12, -0.87, 0, 0.86, 1.07, 1.32, 1.57, 1.78, 2.10];
  const stations: Station[] = zs.map(z => {
    const axle = z < 0 ? -1.12 : 1.32, dist = Math.abs(z - axle);
    const bottom = dist < 0.385 ? Math.max(0.25, 0.31 + Math.sqrt(0.385 ** 2 - dist ** 2)) : 0.25;
    const end = Math.max(0, (Math.abs(z) - 1.7) / 0.4);
    return { z, hw: 0.807 - end * 0.12, yTop: 0.918 - end * (z > 0 ? 0.10 : 0.05),
      yBottom: bottom, rTop: 0.09, rBottom: 0.05, crown: 0.02, sillInset: 0.035 };
  });
  b.loft(stations, { ...paint, colorFn: (x, _y, z, out) => out.copy(x > 0.2 && z < -0.15 && z > -1.5 ? panelTag : paintTag) });
  b.box(1.26, 0.07, 2.4, T(0, 0.28, 0.02), trim);

  // A shallow crowned roof retains smooth curvature in the sun reflection.
  b.loft([
    { z: -0.88, hw: 0.622, yTop: 1.402, yBottom: 1.36, rTop: 0.022, rBottom: 0.012, crown: 0.02 },
    { z: 0.26, hw: 0.666, yTop: 1.425, yBottom: 1.36, rTop: 0.04, rBottom: 0.012, crown: 0.012 },
    { z: 0.50, hw: 0.637, yTop: 1.401, yBottom: 1.36, rTop: 0.022, rBottom: 0.012, crown: 0.014 },
  ], paint);

  // Slightly bowed windscreen and backlight, each split across its curvature.
  for (const front of [true, false]) {
    const baseZ = front ? 0.955 : -1.315, topZ = front ? 0.485 : -0.835;
    for (let j = 0; j < 5; j++) {
      const a = j / 5, c = (j + 1) / 5;
      const point = (t: number, up: number) => V((t * 2 - 1) * (0.765 - up * 0.12),
        0.933 + up * 0.466, baseZ + (topZ - baseZ) * up + (front ? 1 : -1) * Math.sin(t * Math.PI) * 0.025);
      const q = [point(a, 0), point(c, 0), point(c, 1), point(a, 1)];
      if (front) b.quad(q[0], q[1], q[2], q[3], glass);
      else b.quad(q[3], q[2], q[1], q[0], glass);
    }
    b.strut(V(-0.77, 0.936, baseZ), V(0.77, 0.936, baseZ), 0.025, 0.026, trim);
    b.strut(V(-0.646, 1.399, topZ), V(0.646, 1.399, topZ), 0.03, 0.025, chrome);
  }
  for (const side of [-1, 1]) {
    const a = V(side * 0.776, 0.935, -1.30), c = V(side * 0.776, 0.935, 0.94);
    const upperFront = V(side * 0.64, 1.399, 0.48), upperRear = V(side * 0.64, 1.399, -0.83);
    if (side === 1) b.quad(c, a, upperRear, upperFront, glass);
    else b.quad(a, c, upperFront, upperRear, glass);
    b.strut(c, upperFront, 0.063, 0.057, paint);
    b.strut(a, upperRear, 0.09, 0.065, paint);
    b.strut(V(side * 0.778, 0.925, -0.13), V(side * 0.653, 1.402, -0.13), 0.07, 0.045, trim);
    b.strut(a, c, 0.024, 0.025, chrome);
    // Door cuts, handles, sills and the small wing mirror.
    for (const doorZ of [-0.15, -1.27, 0.93]) b.box(0.014, 0.52, 0.012, T(side * 0.812, 0.64, doorZ), trim);
    for (const handleZ of [0.06, -1.03]) b.box(0.035, 0.032, 0.13, T(side * 0.824, 0.84, handleZ), chrome);
    b.box(0.024, 0.04, 1.9, T(side * 0.788, 0.31, -0.15), trim);
    b.box(0.10, 0.032, 0.038, T(side * 0.853, 1.01, 0.79), chrome);
    b.box(0.058, 0.105, 0.14, T(side * 0.907, 1.045, 0.79), chrome);
    b.box(0.061, 0.075, 0.11, T(side * 0.91, 1.045, 0.78), glass);
  }

  // Four individually rounded tyres, recessed steel discs and domed hubcaps.
  for (const z of [-1.12, 1.32]) for (const side of [-1, 1]) {
    const x = side * 0.747;
    const wheel = new THREE.LatheGeometry([
      new THREE.Vector2(0.20, -0.08), new THREE.Vector2(0.281, -0.0875),
      new THREE.Vector2(0.30, -0.06), new THREE.Vector2(0.30, 0.06),
      new THREE.Vector2(0.281, 0.0875), new THREE.Vector2(0.20, 0.08),
    ], 12);
    b.add(wheel, T(x, 0.31, z, 0, 0, Math.PI / 2), rubber); wheel.dispose();
    b.cyl(0.199, 0.199, 0.15, 12, T(x, 0.31, z, 0, 0, Math.PI / 2), chrome);
    b.sphere(0.119, 8, T(x + side * 0.089, 0.31, z, 0, 0, 0, 0.23, 1, 1), chrome);
  }
  // Narrow chrome bumpers and black overriders are the early 1300 signature.
  for (const end of [-1, 1]) {
    b.box(1.55, 0.10, 0.14, T(0, 0.48, end * 2.105), chrome);
    b.box(1.39, 0.033, 0.018, T(0, 0.485, end * 2.179), trim);
    for (const side of [-1, 1]) b.box(0.07, 0.17, 0.17, T(side * 0.49, 0.50, end * 2.11), trim);
    b.box(0.42, 0.10, 0.021, T(0, 0.645, end * 2.112), { color: C(0xc7c4b8), rough: 0.67, metal: 0 });
  }
  b.box(1.15, 0.21, 0.03, T(0, 0.744, 2.104), trim);
  for (let j = 0; j < 4; j++) b.box(0.76, 0.018, 0.018, T(0, 0.676 + j * 0.048, 2.126), chrome);
  for (const side of [-1, 1]) {
    b.box(0.265, 0.175, 0.038, T(side * 0.538, 0.760, 2.112), chrome);
    b.box(0.226, 0.133, 0.042, T(side * 0.538, 0.760, 2.137), { color: C(0xc7d4ca), rough: 0.25, metal: 0 });
    b.box(0.19, 0.054, 0.026, T(side * 0.61, 0.60, 2.12), { color: C(0xb87531), rough: 0.42, metal: 0 });
    b.box(0.27, 0.15, 0.038, T(side * 0.55, 0.77, -2.114), trim);
    b.box(0.23, 0.12, 0.043, T(side * 0.55, 0.77, -2.137), { color: C(0x862a23), rough: 0.31, metal: 0 });
  }
  const raw = b.build(30);
  cached = mergeVertices(raw, 1e-5);
  raw.dispose();
  return cached;
}

export function appendParkedDacia(
  d: DetailBuilder, x: number, z: number, heading: number,
  body: THREE.Color, panel: THREE.Color, roughness: number, groundY = 0,
): void {
  const g = parkedDaciaTemplate(), p = g.getAttribute('position'), n = g.getAttribute('normal');
  const color = g.getAttribute('color'), mat = g.getAttribute('aMat');
  const lift = groundY - g.boundingBox!.min.y;
  const cos = Math.cos(heading), sin = Math.sin(heading), base = d.pos.length / 3;
  for (let i = 0; i < p.count; i++) {
    // Vehicle +Z becomes parked-car +X; this rotation preserves winding.
    d.pos.push(x + p.getZ(i) * cos - p.getX(i) * sin, p.getY(i) + lift, z - p.getZ(i) * sin - p.getX(i) * cos);
    d.nrm.push(n.getZ(i) * cos - n.getX(i) * sin, n.getY(i), -n.getZ(i) * sin - n.getX(i) * cos);
    const paint = color.getZ(i) === 1 && (color.getX(i) === 1 || color.getY(i) === 1);
    const c = color.getX(i) === 1 ? body : panel;
    d.col.push(paint ? c.r : color.getX(i), paint ? c.g : color.getY(i), paint ? c.b : color.getZ(i));
    d.mr.push(mat.getY(i), paint ? roughness : mat.getX(i));
    d.emi.push(0, 0, 0); d.fol.push(0, 0);
  }
  const index = g.index!;
  for (let i = 0; i < index.count; i++) d.idx.push(base + index.getX(i));
}
