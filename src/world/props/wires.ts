/**
 * Overhead wiring — the thing that actually reads as "Bucharest" in a
 * silhouette. Trolleybus and tram contact wires, transverse span wires between
 * poles, junction crossings, feeder drops and the illegal telecom bundles
 * strung between balconies.
 *
 * In the reference frame the wires cut right across the magenta sky above the
 * street; without them the upper half of every street-level shot is empty.
 *
 * OWNER: props / street-dressing agent.
 */

import { Color } from 'three';
import type { Rng } from '../../core/rng';
import { Palette } from '../../artDirection';
import { MR, PropBuilder, PropColor as C, emi, type PropOpts } from './kit';
import { WALK_Y } from './streetFurniture';

const lerpColor = (a: Color, b: Color, t: number): Color => a.clone().lerp(b, t);

const opt = (color: PropOpts['color'], mr: PropOpts['mr'], emissive?: number[]): PropOpts =>
  ({ color, mr, emissive });

/**
 * Wire colour. A real catenary at dusk is NOT black — it is a hard, dry steel
 * silhouette that picks up a rim of the sky it is drawn against, sitting around
 * 0.15-0.2 luminance. Authored at `steelDark` (0.02 linear) it renders as a
 * pure black scratch on the frame, and against a magenta sky twenty of them
 * read as biro scribble. `WIRE` is a desaturated slate lifted toward the sky's
 * violet, plus a small self-emissive term standing in for the sky rim the wire
 * would catch along its whole length.
 */
const WIRE_SLATE = lerpColor(new Color(0x6d7480).convertSRGBToLinear(), Palette.skyHighBand, 0.16);
const WIRE = opt(WIRE_SLATE, [0.3, 0.45], emi(WIRE_SLATE, 0.12));
const CABLE_SLATE = lerpColor(new Color(0x4a4a54).convertSRGBToLinear(), Palette.skyHighBand, 0.14);
const CABLE = opt(CABLE_SLATE, [0.1, 0.7], emi(CABLE_SLATE, 0.10));

/**
 * Tube radius for running wire. At 0.016 m a wire is under a pixel wide beyond
 * 25 m and aliases into a dotted line that crawls as the camera moves; 0.03 m
 * holds a solid stroke to the far cut and costs the same triangles.
 */
const R_RUN = 0.030;
const R_SPAN = 0.032;
const R_HANGER = 0.022;

/** Height of the contact wire above the carriageway. */
export const WIRE_Y = 6.4;

/**
 * Trolleybus traction pole: tapered column, ladder rungs, a bracket arm with
 * insulators, guy anchors and a sodium head. Taller and busier than a plain
 * lamp column, because in the reference it is the tallest thing in the
 * foreground apart from the tower. ~150 tris.
 */
export function tractionPole(
  b: PropBuilder,
  x: number, z: number,
  inwardX: number, inwardZ: number,
  rng: Rng,
): void {
  const steel = opt(C.steel, MR.metal);
  const h = rng.range(9.4, 10.6);
  b.cyl(x, WALK_Y - 0.1, z, 0.22, 0.11, h, 8, steel, false);
  // Cast base.
  b.cyl(x, WALK_Y - 0.12, z, 0.34, 0.27, 0.62, 8, steel);
  b.cyl(x, WALK_Y + 0.5, z, 0.27, 0.24, 0.14, 8, steel);
  // Inspection door + fly-posted band.
  b.box(x + inwardX * 0.2, WALK_Y + 1.1, z + inwardZ * 0.2, 0.28, 0.5, 0.06,
    Math.atan2(inwardX, inwardZ), opt(C.galv, MR.metalRough));
  // Rungs.
  for (let i = 0; i < 5; i++) {
    b.box(x, WALK_Y + 2.4 + i * 0.42, z, 0.34, 0.035, 0.035, 0, steel);
  }
  // Bracket arm over the carriageway with two insulators.
  const reach = rng.range(3.2, 4.4);
  const ay = WIRE_Y + 0.55;
  b.tube(x, ay, z, x + inwardX * reach, ay + 0.12, z + inwardZ * reach, 0.055, 5, steel);
  b.tube(x, ay - 1.5, z, x + inwardX * reach * 0.62, ay + 0.06, z + inwardZ * reach * 0.62,
    0.038, 4, steel);
  for (const t of [0.55, 0.92]) {
    const ix = x + inwardX * reach * t;
    const iz = z + inwardZ * reach * t;
    b.cyl(ix, ay - 0.34, iz, 0.05, 0.05, 0.3, 5, opt(C.paintCream, MR.plastic), false);
    b.cyl(ix, ay - 0.16, iz, 0.09, 0.09, 0.05, 6, opt(C.paintCream, MR.plastic));
  }
  // Sodium head on a gooseneck, arm-mounted.
  const lx = x + inwardX * (reach * 0.72);
  const lz = z + inwardZ * (reach * 0.72);
  b.tube(x, WALK_Y + h - 0.5, z, lx, WALK_Y + h - 0.1, lz, 0.05, 5, steel);
  b.box(lx, WALK_Y + h - 0.16, lz, 0.82, 0.16, 0.38, Math.atan2(inwardX, inwardZ),
    opt(C.steelPale, MR.metal));
  b.box(lx, WALK_Y + h - 0.3, lz, 0.74, 0.1, 0.32, Math.atan2(inwardX, inwardZ),
    opt(C.sodium, MR.lamp, emi(C.sodium, 8.0)));
  // Feeder cable dropping down the pole.
  b.wire(x + inwardX * 0.16, ay - 0.2, z + inwardZ * 0.16, x + inwardX * 0.14, WALK_Y + 2.0, z + inwardZ * 0.14,
    0.08, R_HANGER, CABLE, 3);
}

/**
 * Transverse span wire across a street between two poles, with the pair of
 * contact wires hung off it. This is the shape that reads as trolleybus
 * infrastructure rather than as random cables.
 */
export function spanWire(
  b: PropBuilder,
  ax: number, az: number,
  bx: number, bz: number,
  rng: Rng,
): void {
  const y = WIRE_Y + 1.05;
  const sag = rng.range(0.3, 0.6);
  b.wire(ax, y, az, bx, y, bz, sag, R_SPAN, WIRE, 6);
  // ONE hanger at midspan, not two. A span wire crossing the frame with a
  // ladder of droppers under it is what turned the sky into a grid.
  const t = 0.5;
  const hx = ax + (bx - ax) * t;
  const hz = az + (bz - az) * t;
  const hy = y - sag * 4 * t * (1 - t);
  b.tube(hx, hy, hz, hx, WIRE_Y, hz, R_HANGER, 3, WIRE);
  b.cyl(hx, WIRE_Y - 0.06, hz, 0.05, 0.05, 0.14, 5, opt(C.paintCream, MR.plastic), false);
}

/** A pair of running contact wires along a street, with sag between supports. */
export function contactWires(
  b: PropBuilder,
  ax: number, az: number,
  bx: number, bz: number,
  gauge: number,
  rng: Rng,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len;
  const pz = dx / len;
  const sag = Math.min(0.5, len * 0.006) + rng.range(0, 0.08);
  for (const s of [-1, 1]) {
    const o = (gauge / 2) * s;
    b.wire(ax + px * o, WIRE_Y, az + pz * o, bx + px * o, WIRE_Y, bz + pz * o, sag, R_RUN, WIRE, 4);
  }
}

/**
 * The tangle over a junction: contact wires crossing, plus the diagonal pull-off
 * wires anchored back to the poles on each corner.
 */
export function junctionWires(
  b: PropBuilder,
  cx: number, cz: number,
  halfW: number, halfD: number,
  rng: Rng,
): void {
  const gauge = 0.62;
  // Straight-through pairs on both axes.
  for (const s of [-1, 1]) {
    b.wire(cx - halfW - 6, WIRE_Y, cz + gauge * 0.5 * s, cx + halfW + 6, WIRE_Y, cz + gauge * 0.5 * s,
      0.18, R_RUN, WIRE, 4);
    b.wire(cx + gauge * 0.5 * s, WIRE_Y, cz - halfD - 6, cx + gauge * 0.5 * s, WIRE_Y, cz + halfD + 6,
      0.18, R_RUN, WIRE, 4);
  }
  // Curve wires: the turn-out an articulated trolleybus actually takes. Only
  // ONE quadrant of a junction gets one — four turn-outs plus the through
  // pairs is eight strokes converging on one point, which reads as a smudge.
  const turn = rng.int(0, 4);
  const quads = [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const;
  for (let qi = 0; qi < quads.length; qi++) {
    const [sx, sz] = quads[qi];
    if (qi !== turn) continue;
    const r = Math.min(halfW, halfD) * 0.85;
    let px = cx + sx * (halfW + 3);
    let pz = cz + sz * gauge * 0.5;
    for (let i = 1; i <= 4; i++) {
      const t = i / 4;
      const a = (Math.PI / 2) * t;
      const qx = cx + sx * (halfW + 3) - sx * r * Math.sin(a);
      const qz = cz + sz * (r - r * Math.cos(a) + gauge * 0.5);
      b.tube(px, WIRE_Y, pz, qx, WIRE_Y, qz, R_RUN, 3, WIRE);
      px = qx;
      pz = qz;
    }
  }
  // The four diagonal pull-off wires that used to be anchored back to every
  // corner are deleted. From street level they projected as a giant X across
  // the whole frame — the single loudest piece of scribble in the build.
}

/**
 * Telecom / power bundles slung between facades — the illegal cable web that
 * hangs over every side street in Bucharest.
 */
export function utilityBundle(
  b: PropBuilder,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  rng: Rng,
): void {
  // 1-2 strands, not 2-5. A facade-to-facade bundle is a silhouette accent;
  // five parallel sagging lines across a narrow street is a stave.
  const n = 1 + rng.int(0, 2);
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const px = -dz / len;
  const pz = dx / len;
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * 0.16;
    const sag = rng.range(0.6, 1.8) + i * 0.12;
    b.wire(ax + px * o, ay + rng.range(-0.2, 0.2), az + pz * o,
      bx + px * o, by + rng.range(-0.2, 0.2), bz + pz * o,
      sag, R_RUN, CABLE, 5);
  }
  // A shoe or two thrown over the line, because of course.
  if (rng.bool(0.12)) {
    const t = rng.range(0.35, 0.65);
    const sxp = ax + dx * t;
    const szp = az + dz * t;
    const syp = ay + (by - ay) * t - 1.2 * 4 * t * (1 - t);
    b.box(sxp, syp - 0.14, szp, 0.1, 0.28, 0.24, rng.range(0, 3), opt(C.plasticDark, MR.plastic));
  }
}

/** Wall bracket + insulator where a span wire lands on a building. */
export function wallAnchor(
  b: PropBuilder, x: number, y: number, z: number, fx: number, fz: number,
): void {
  const steel = opt(C.steel, MR.metal);
  b.box(x, y, z, 0.24, 0.24, 0.16, Math.atan2(fx, fz), steel);
  b.tube(x, y, z, x + fx * 0.55, y - 0.05, z + fz * 0.55, 0.035, 4, steel);
  b.cyl(x + fx * 0.6, y - 0.14, z + fz * 0.6, 0.05, 0.05, 0.16, 5, opt(C.paintCream, MR.plastic));
}
