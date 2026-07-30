/**
 * MAP MATHS — every pure function the map needs, with no DOM and no services.
 *
 * OWNER: map agent.
 *
 * Kept separate for two reasons. It is the part that is worth unit testing
 * (`map.test.ts` runs under `bun test`, which has no canvas), and it is the
 * part that both views share: the minimap and the full-screen map are the same
 * projection with different centres, scales and rotations.
 *
 * THE PROJECTION. World is three.js: +X east, +Z south. On the map, screen up
 * is the direction the view faces; with `rot = 0` that is north, i.e. -Z.
 *
 *     sx = ox + ( dx·cos(rot) + dz·sin(rot)) · scale
 *     sy = oy + (-dx·sin(rot) + dz·cos(rot)) · scale
 *
 * `unproject` is its exact inverse, which is what turns a click on the
 * full-screen map into a world position.
 */

export interface MapView {
  /** World-space centre of the view. */
  cx: number;
  cz: number;
  /** Pixels per metre. */
  scale: number;
  /** Radians. 0 = north up; otherwise the compass heading placed at screen up. */
  rot: number;
  /** Pixel position of (cx, cz) inside the canvas. */
  ox: number;
  oy: number;
  /** Canvas size in CSS pixels. */
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export function makeView(w: number, h: number): MapView {
  return { cx: 0, cz: 0, scale: 0.2, rot: 0, ox: w / 2, oy: h / 2, w, h };
}

/** World (x, z) -> canvas (x, y), in CSS pixels. */
export function project(v: MapView, x: number, z: number, out: Pt): Pt {
  const dx = x - v.cx;
  const dz = z - v.cz;
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  out.x = v.ox + (dx * c + dz * s) * v.scale;
  out.y = v.oy + (-dx * s + dz * c) * v.scale;
  return out;
}

/** Canvas (x, y) -> world (x, z). Exact inverse of `project`. */
export function unproject(v: MapView, sx: number, sy: number, out: { x: number; z: number }): { x: number; z: number } {
  const a = (sx - v.ox) / v.scale;
  const b = (sy - v.oy) / v.scale;
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  out.x = v.cx + a * c - b * s;
  out.z = v.cz + a * s + b * c;
  return out;
}

/**
 * World-space AABB covering the canvas, padded by `pad` metres.
 *
 * With rotation on, the visible world region is a rotated rectangle; the
 * segment query wants an axis-aligned box, so take the bounding box of the
 * four unprojected corners. That over-queries by at most 41% at 45°, which is
 * far cheaper than clipping properly.
 */
export function viewBounds(v: MapView, pad = 0): { x0: number; z0: number; x1: number; z1: number } {
  const p = { x: 0, z: 0 };
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [sx, sy] of [
    [0, 0],
    [v.w, 0],
    [0, v.h],
    [v.w, v.h],
  ] as const) {
    unproject(v, sx, sy, p);
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

/**
 * Metres from the centre of the minimap to its top edge, as a function of
 * speed. Standing still you want detail (which street is that?); at 100 km/h
 * you want the next two junctions. Matches the feel of a GTA minimap: it opens
 * up quickly off the line and then flattens out.
 */
export function rangeForSpeed(kmh: number, near = 125, far = 290): number {
  const t = clamp01(Math.abs(kmh) / 135);
  return near + (far - near) * (t * t * (3 - 2 * t));
}

/** Exponential smoothing that behaves the same at any frame rate. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Shortest signed angular difference, radians. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Angle damping that takes the short way round. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "820 m" / "1.4 km" — Romanian decimal comma. */
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

/** Compass letter for a heading in radians, 0 = north. */
export function compassLetter(rad: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SV', 'V', 'NV'];
  const i = Math.round((((rad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return names[i];
}

/**
 * Corner-chamfered rectangle, as a flat [x, y, x, y, ...] ring.
 *
 * The chamfer is the pause menu's `clip-path` polygon in canvas form — the
 * minimap has to belong to the same broadcast-console family as the rest of
 * the UI, and a plain rounded rect does not read as this game.
 */
export function chamferRing(w: number, h: number, cut: number): number[] {
  const c = Math.max(0, Math.min(cut, Math.min(w, h) / 2));
  return [
    c, 0,
    w, 0,
    w, h - c,
    w - c, h,
    0, h,
    0, c,
  ];
}

/**
 * Clamp a point to the inside of a rect, reporting whether it had to move.
 * This is what turns an off-map waypoint into an edge arrow.
 */
export function clampToRect(
  p: Pt,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Pt,
): boolean {
  out.x = clamp(p.x, x0, x1);
  out.y = clamp(p.y, y0, y1);
  return out.x !== p.x || out.y !== p.y;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export interface RoutePoint {
  x: number;
  z: number;
}

/**
 * How far along a polyline the player is: returns the index of the first point
 * still ahead of them. Used to trim the travelled tail off the route line so
 * the line always starts at the car, exactly like a satnav.
 *
 * "Ahead" is measured by the closest *segment*, not the closest point — with
 * 92 m between road nodes, closest-point snapping pops a whole block early.
 */
export function routeAdvance(points: ReadonlyArray<RoutePoint>, x: number, z: number): number {
  if (points.length < 2) return 0;
  let bestSeg = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? clamp01(((x - a.x) * vx + (z - a.z) * vz) / len2) : 0;
    const px = a.x + vx * t;
    const pz = a.z + vz * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < bestD2) {
      bestD2 = d2;
      bestSeg = i;
    }
  }
  return bestSeg + 1;
}

/** Planar length of a polyline from `from` onward, metres. */
export function polylineLength(points: ReadonlyArray<RoutePoint>, from = 0): number {
  let d = 0;
  for (let i = Math.max(0, from); i < points.length - 1; i++) {
    d += Math.hypot(points[i + 1].x - points[i].x, points[i + 1].z - points[i].z);
  }
  return d;
}

/**
 * Distance from a point to a polyline, metres. The router uses it to decide
 * whether the player has left the route and it has to think again.
 */
export function distanceToPolyline(points: ReadonlyArray<RoutePoint>, x: number, z: number): number {
  if (!points.length) return Infinity;
  if (points.length === 1) return Math.hypot(points[0].x - x, points[0].z - z);
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vx = b.x - a.x;
    const vz = b.z - a.z;
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? clamp01(((x - a.x) * vx + (z - a.z) * vz) / len2) : 0;
    const d = Math.hypot(x - (a.x + vx * t), z - (a.z + vz * t));
    if (d < best) best = d;
  }
  return best;
}

/**
 * Round off a polyline's corners so the route reads as a drawn ribbon rather
 * than a wireframe of the road graph. Chaikin, one pass, corner-preserving at
 * the ends.
 */
export function smoothPolyline(points: ReadonlyArray<RoutePoint>, cut = 0.22): RoutePoint[] {
  if (points.length < 3) return points.slice();
  const out: RoutePoint[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (i > 0) out.push({ x: a.x + (b.x - a.x) * cut, z: a.z + (b.z - a.z) * cut });
    if (i < points.length - 2) {
      out.push({ x: b.x - (b.x - a.x) * cut, z: b.z - (b.z - a.z) * cut });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}
