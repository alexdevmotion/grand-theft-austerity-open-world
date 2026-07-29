/**
 * Litter — newspapers and political flyers trodden into the wet paving, cans,
 * cigarette ends, cups, bottles and the drifts of rubbish that collect against
 * every kerb and railing.
 *
 * The reference frame has loose papers lying in the foreground reflecting the
 * sky. A pavement with nothing on it is the clearest tell that a street was
 * generated rather than lived in.
 *
 * Flat printed litter is instanced off the poster atlas (one draw call for the
 * whole city); three-dimensional debris is merged into the tile geometry.
 *
 * OWNER: props / street-dressing agent.
 */

import type { Rng } from '../../core/rng';
import { MR, PropBuilder, PropColor as C, type PropOpts } from './kit';
import type { AtlasPanels } from './signage';

const opt = (color: PropOpts['color'], mr: PropOpts['mr']): PropOpts => ({ color, mr });

/**
 * Scatter printed litter — flyers, torn posters, a dropped newspaper — over a
 * patch of ground. `density` is items per square metre.
 */
export function printedLitter(
  panels: AtlasPanels,
  x: number, z: number, y: number,
  radius: number, count: number,
  rng: Rng,
): void {
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * radius;
    const w = rng.range(0.22, 0.46);
    // Newspapers open out wider than they are tall; flyers are near-square.
    const d = w * rng.range(0.62, 1.35);
    panels.addFlat(
      x + Math.cos(a) * r,
      y + 0.004 + (i % 4) * 0.0015,
      z + Math.sin(a) * r,
      w, d, rng.range(0, Math.PI * 2), rng.int(0, 16),
    );
  }
}

/** Crushed cans, cups, bottles and cigarette ends. Merged, ~10 tris each. */
export function debris(
  b: PropBuilder,
  x: number, z: number, y: number,
  radius: number, count: number,
  rng: Rng,
): void {
  for (let i = 0; i < count; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * radius;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const yaw = rng.range(0, Math.PI);
    const roll = rng.next();
    if (roll < 0.3) {
      // Can on its side.
      const col = rng.weighted([C.paintRed, C.paintBlue, C.alu, C.paintGreen], [2, 2, 3, 1]);
      b.tube(px, y + 0.033, pz, px + Math.cos(yaw) * 0.115, y + 0.033, pz + Math.sin(yaw) * 0.115,
        0.033, 5, opt(col, MR.metal));
    } else if (roll < 0.5) {
      // Paper cup.
      b.cyl(px, y, pz, 0.032, 0.042, 0.1, 5, opt(C.paper, MR.paper), false);
    } else if (roll < 0.62) {
      // Bottle.
      b.cyl(px, y, pz, 0.035, 0.035, 0.17, 5, opt(C.glassPale, MR.glass), false);
      b.cyl(px, y + 0.17, pz, 0.02, 0.014, 0.07, 5, opt(C.glassPale, MR.glass));
    } else if (roll < 0.78) {
      // Cigarette end.
      b.box(px, y + 0.005, pz, 0.022, 0.01, 0.008, yaw, opt(C.paperDim, MR.paper));
    } else if (roll < 0.9) {
      // Squashed cardboard.
      b.ground(px, y + 0.004, pz, rng.range(0.16, 0.34), rng.range(0.12, 0.26), yaw,
        opt(C.cardboard, MR.paper));
    } else {
      // Bin bag that never made it into the bin.
      b.blob(px, y + 0.16, pz, rng.range(0.16, 0.26), rng.range(0.12, 0.2), rng.range(0.16, 0.26),
        opt(C.plasticDark, MR.plastic), 0.55, 907 + i, 1);
    }
  }
}

/**
 * A drift of rubbish piled against a wall or railing: bags, boxes, a pallet
 * end. Placed where two surfaces meet, which is where real litter collects.
 */
export function rubbishDrift(
  b: PropBuilder,
  x: number, z: number, y: number,
  dirX: number, dirZ: number,
  length: number,
  rng: Rng,
): void {
  const n = Math.max(2, Math.round(length / 0.8));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * (length / n) + rng.range(-0.15, 0.15);
    const px = x + dirX * t;
    const pz = z + dirZ * t;
    if (rng.bool(0.55)) {
      b.blob(px, y + rng.range(0.14, 0.26), pz,
        rng.range(0.2, 0.32), rng.range(0.14, 0.24), rng.range(0.2, 0.32),
        opt(rng.bool(0.6) ? C.plasticDark : C.bitumen, MR.plastic), 0.55, 1301 + i * 5, 1);
    } else {
      b.box(px, y + 0.16, pz, rng.range(0.3, 0.6), rng.range(0.22, 0.4), rng.range(0.25, 0.5),
        rng.range(0, Math.PI), opt(C.cardboard, MR.paper));
    }
  }
}
