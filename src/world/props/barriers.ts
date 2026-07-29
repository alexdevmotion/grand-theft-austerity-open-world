/**
 * Barriers, roadworks and the permanent state of half-finished public works that
 * defines a Bucharest street: crowd-control fencing, red-and-white hazard tape,
 * cones, pallets, skips, scaffolding and construction hoarding.
 *
 * The reference frame has a whole run of these across the plaza — they are what
 * makes the city read as "under siege" rather than as an architectural render.
 *
 * OWNER: props / street-dressing agent.
 */

import type { Rng } from '../../core/rng';
import { MR, PropBuilder, PropColor as C, emi, type PropOpts } from './kit';
import { WALK_Y } from './streetFurniture';

const opt = (color: PropOpts['color'], mr: PropOpts['mr'], emissive?: number[]): PropOpts =>
  ({ color, mr, emissive });

/* ------------------------------------------------------------------ */
/* Fencing                                                             */
/* ------------------------------------------------------------------ */

/**
 * A run of interlocking crowd-control barriers along (dirX, dirZ), each panel
 * leaning slightly differently. Returns the end point so a caller can drape
 * hazard tape along the same run. ~120 tris per panel.
 */
export function barrierRun(
  b: PropBuilder,
  x: number, z: number,
  dirX: number, dirZ: number,
  panels: number,
  rng: Rng,
  y0 = WALK_Y,
  /**
   * Top-rail height. A 1.0 m barrier of 40 mm tube disappears at 20 m; a real
   * Bucharest crowd barrier is 1.15 m with heavier rails and a cross-braced,
   * splayed foot, and that is what actually reads across a plaza.
   */
  top = 1.06,
): [number, number] {
  const panel = 2.1;
  const steel = opt(C.steelPale, MR.metal);
  const alongX = Math.abs(dirX) > 0.5;
  // Perpendicular, for the splayed foot.
  const qx = -dirZ;
  const qz = dirX;
  const rail = top > 1.1 ? 0.075 : 0.06;
  const upright = top > 1.1 ? 0.05 : 0.04;
  for (let i = 0; i < panels; i++) {
    const px = x + dirX * panel * i;
    const pz = z + dirZ * panel * i;
    const lean = rng.range(-0.06, 0.06);
    const knock = rng.bool(0.12) ? rng.range(0.1, 0.28) : 0;
    const cx = px + dirX * panel * 0.5;
    const cz = pz + dirZ * panel * 0.5;
    for (const y of [top, top * 0.47]) {
      b.box(cx, y0 + y - knock, cz,
        alongX ? panel : rail, rail, alongX ? rail : panel, lean, steel);
    }
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      b.box(px + dirX * panel * t, y0 + top * 0.735 - knock, pz + dirZ * panel * t,
        upright, top * 0.585, upright, lean, steel);
    }
    // Cross-brace: a diagonal from foot to top rail. Two of them per panel form
    // an X that holds the run together visually at distance, where the thin
    // uprights have already aliased away.
    for (const s of [-1, 1]) {
      const t0 = s > 0 ? 0.06 : 0.94;
      const t1 = s > 0 ? 0.94 : 0.06;
      b.tube(
        px + dirX * panel * t0, y0 + 0.1 - knock, pz + dirZ * panel * t0,
        px + dirX * panel * t1, y0 + top * 0.47 - knock, pz + dirZ * panel * t1,
        upright * 0.55, 3, steel,
      );
    }
    // Splayed feet, running ACROSS the run so the barrier stands on something.
    for (const t of [0.04, 0.96]) {
      const fx = px + dirX * panel * t;
      const fz = pz + dirZ * panel * t;
      b.box(fx, y0 + 0.035, fz,
        alongX ? 0.11 : 0.7, 0.07, alongX ? 0.7 : 0.11, lean, steel);
      // Rubber shoe at each end of the foot, which is where the eye reads the
      // contact with the ground.
      for (const u of [-1, 1]) {
        b.box(fx + qx * u * 0.33, y0 + 0.045, fz + qz * u * 0.33, 0.13, 0.09, 0.13, lean,
          opt(C.plasticDark, MR.plastic));
      }
    }
  }
  return [x + dirX * panel * panels, z + dirZ * panel * panels];
}

/**
 * Red-and-white hazard tape strung between two points, sagging in the middle.
 * Alternating segment colours give the stripes for free.
 */
export function hazardTape(
  b: PropBuilder,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  rng: Rng,
): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const segs = Math.max(6, Math.round(len / 0.42));
  const sag = rng.range(0.12, 0.3);
  const w = 0.075;
  // Perpendicular so the tape reads as a ribbon, not a wire.
  const px = -dz / (len || 1);
  const pz = dx / (len || 1);
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    const y0 = ay + (by - ay) * t0 - sag * 4 * t0 * (1 - t0);
    const y1 = ay + (by - ay) * t1 - sag * 4 * t1 * (1 - t1);
    const x0 = ax + dx * t0;
    const z0 = az + dz * t0;
    const x1 = ax + dx * t1;
    const z1 = az + dz * t1;
    const col = i % 2 === 0 ? C.hazardRed : C.hazardWhite;
    const o = opt(col, MR.plastic);
    const tw = w / 2;
    // A twisted ribbon: two triangles per segment, both sides.
    const tw0 = i % 3 === 0 ? tw * 0.35 : tw;
    b.quad(
      [x0 + px * tw0, y0 + tw, z0 + pz * tw0],
      [x1 + px * tw, y1 + tw, z1 + pz * tw],
      [x1 - px * tw, y1 - tw, z1 - pz * tw],
      [x0 - px * tw0, y0 - tw, z0 - pz * tw0],
      o,
    );
    b.quad(
      [x0 - px * tw0, y0 - tw, z0 - pz * tw0],
      [x1 - px * tw, y1 - tw, z1 - pz * tw],
      [x1 + px * tw, y1 + tw, z1 + pz * tw],
      [x0 + px * tw0, y0 + tw, z0 + pz * tw0],
      o,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Roadworks kit                                                       */
/* ------------------------------------------------------------------ */

/** Traffic cone with a reflective collar. ~28 tris. */
export function trafficCone(b: PropBuilder, x: number, y: number, z: number, rng: Rng): void {
  const knocked = rng.bool(0.12);
  const orange = opt(C.paintOrange, MR.plastic, emi(C.paintOrange, 0.25));
  if (knocked) {
    // On its side.
    const yaw = rng.range(0, Math.PI * 2);
    b.tube(x, y + 0.12, z,
      x + Math.sin(yaw) * 0.5, y + 0.05, z + Math.cos(yaw) * 0.5, 0.1, 6, orange);
    b.box(x, y + 0.02, z, 0.36, 0.04, 0.36, yaw, opt(C.plasticDark, MR.plastic));
    return;
  }
  b.box(x, y + 0.03, z, 0.36, 0.06, 0.36, rng.range(0, 1.5), opt(C.plasticDark, MR.plastic));
  b.cyl(x, y + 0.05, z, 0.15, 0.09, 0.3, 6, orange, false);
  b.cyl(x, y + 0.35, z, 0.09, 0.055, 0.14, 6, opt(C.hazardWhite, MR.plastic, emi(C.hazardWhite, 0.5)), false);
  b.cyl(x, y + 0.49, z, 0.055, 0.02, 0.16, 6, orange);
}

/** Stack of wooden pallets. ~90 tris for three. */
export function palletStack(b: PropBuilder, x: number, y: number, z: number, n: number, rng: Rng): void {
  const yaw = rng.range(0, Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const py = y + i * 0.15;
    const jitter = rng.range(-0.05, 0.05);
    const wood = opt(rng.bool(0.5) ? C.wood : C.woodPale, MR.wood);
    // Deck boards.
    for (let k = 0; k < 4; k++) {
      const off = (k - 1.5) * 0.28;
      b.box(x + Math.cos(yaw + jitter) * off, py + 0.13, z + Math.sin(yaw + jitter) * off,
        1.2, 0.035, 0.16, yaw + jitter, wood);
    }
    // Bearers.
    for (const s of [-1, 0, 1]) {
      b.box(x + Math.sin(yaw + jitter) * s * 0.5, py + 0.06, z + Math.cos(yaw + jitter) * s * 0.5,
        0.12, 0.1, 1.0, yaw + jitter, wood);
    }
  }
}

/** Builder's skip, half full of rubble. ~60 tris. */
export function skip(b: PropBuilder, x: number, y: number, z: number, yaw: number, rng: Rng): void {
  const shell = opt(rng.weighted([C.paintOrange, C.paintYellow, C.rust], [3, 2, 2]), MR.metalRough);
  const w = 3.2;
  const d = 1.7;
  b.openBox(x, y + 0.62, z, w, 1.24, d, yaw, shell);
  // Sloped ends read as a real skip rather than a crate.
  b.box(x, y + 0.06, z, w + 0.1, 0.12, d + 0.1, yaw, opt(C.steelDark, MR.metal));
  b.box(x, y + 1.24, z, w + 0.14, 0.09, d + 0.14, yaw, opt(C.steelDark, MR.metal));
  // Rubble and timber sticking out.
  for (let i = 0; i < 4; i++) {
    const t = rng.range(-w / 2 + 0.3, w / 2 - 0.3);
    const u = rng.range(-d / 2 + 0.25, d / 2 - 0.25);
    const px = x + Math.sin(yaw) * t + Math.cos(yaw) * u;
    const pz = z + Math.cos(yaw) * t - Math.sin(yaw) * u;
    if (rng.bool(0.5)) {
      b.blob(px, y + 1.1, pz, rng.range(0.16, 0.3), rng.range(0.1, 0.2), rng.range(0.16, 0.3),
        opt(C.concreteDark, MR.stone), 0.7, 21 + i, 1);
    } else {
      b.box(px, y + 1.2, pz, rng.range(0.6, 1.4), 0.08, 0.12,
        rng.range(0, Math.PI), opt(C.wood, MR.wood));
    }
  }
}

/** Sand / gravel pile with a shovel-shaped edge. */
export function spoilHeap(b: PropBuilder, x: number, y: number, z: number, r: number, rng: Rng): void {
  b.blob(x, y + r * 0.42, z, r, r * 0.5, r * 0.9,
    opt(rng.bool(0.5) ? C.cardboard : C.concreteDark, MR.stone), 0.45, 31);
}

/**
 * Construction hoarding: plywood panels on posts, tops of scaffolding poles
 * showing above. Posters get pasted on separately by the signage pass.
 */
export function hoarding(
  b: PropBuilder,
  x: number, z: number,
  dirX: number, dirZ: number,
  length: number,
  rng: Rng,
): void {
  const h = 2.4;
  const alongX = Math.abs(dirX) > 0.5;
  const panels = Math.max(1, Math.round(length / 2.4));
  const step = length / panels;
  for (let i = 0; i < panels; i++) {
    const cx = x + dirX * (i + 0.5) * step;
    const cz = z + dirZ * (i + 0.5) * step;
    const col = rng.weighted([C.paintBlue, C.woodPale, C.paintGreen, C.hazardWhite], [3, 2, 2, 1]);
    b.box(cx, WALK_Y + h / 2, cz,
      alongX ? step : 0.09, h, alongX ? 0.09 : step, 0, opt(col, MR.wood));
    // Post.
    b.box(x + dirX * i * step, WALK_Y + h / 2 + 0.06, z + dirZ * i * step,
      0.13, h + 0.12, 0.13, 0, opt(C.wood, MR.wood));
  }
  // Capping rail.
  b.box(x + dirX * length / 2, WALK_Y + h + 0.08, z + dirZ * length / 2,
    alongX ? length : 0.15, 0.09, alongX ? 0.15 : length, 0, opt(C.steelDark, MR.metal));
}

/** Scaffolding lift: standards, ledgers, boards and a debris net. */
export function scaffold(
  b: PropBuilder,
  x: number, z: number,
  dirX: number, dirZ: number,
  bays: number, lifts: number,
  rng: Rng,
): void {
  const bay = 2.4;
  const lift = 2.0;
  const depth = 1.1;
  const tubeC = opt(C.galv, MR.metal);
  const px = -dirZ;
  const pz = dirX;
  const top = WALK_Y + lifts * lift;

  for (let i = 0; i <= bays; i++) {
    const sx = x + dirX * bay * i;
    const sz = z + dirZ * bay * i;
    for (const d of [0, depth]) {
      b.tube(sx + px * d, WALK_Y, sz + pz * d, sx + px * d, top + 0.9, sz + pz * d, 0.028, 4, tubeC);
    }
    // Transoms.
    for (let l = 1; l <= lifts; l++) {
      const y = WALK_Y + l * lift;
      b.tube(sx, y, sz, sx + px * depth, y, sz + pz * depth, 0.024, 4, tubeC);
    }
  }
  for (let l = 1; l <= lifts; l++) {
    const y = WALK_Y + l * lift;
    for (const d of [0, depth]) {
      b.tube(x + px * d, y, z + pz * d, x + dirX * bay * bays + px * d, y, z + dirZ * bay * bays + pz * d,
        0.026, 4, tubeC);
      b.tube(x + px * d, y - 0.9, z + pz * d,
        x + dirX * bay * bays + px * d, y - 0.9, z + dirZ * bay * bays + pz * d, 0.02, 3, tubeC);
    }
    // Boards.
    for (let i = 0; i < bays; i++) {
      b.box(x + dirX * bay * (i + 0.5) + px * depth * 0.5, y + 0.03, z + dirZ * bay * (i + 0.5) + pz * depth * 0.5,
        Math.abs(dirX) > 0.5 ? bay : depth, 0.05, Math.abs(dirX) > 0.5 ? depth : bay, 0,
        opt(C.woodPale, MR.wood));
    }
  }
  // Debris netting over the whole face — a translucent-looking green sheet.
  const net = opt(rng.bool(0.5) ? C.leafOlive : C.paintGreen, MR.fabric);
  b.panel(
    x + dirX * bay * bays * 0.5 + px * (depth + 0.06),
    WALK_Y + (top - WALK_Y) / 2 + 0.3,
    z + dirZ * bay * bays * 0.5 + pz * (depth + 0.06),
    bay * bays, top - WALK_Y + 0.6, px, pz, net,
  );
}

/** Jersey barrier — precast concrete, splashed and chipped. ~30 tris. */
export function jerseyBarrier(
  b: PropBuilder, x: number, y: number, z: number, yaw: number, rng: Rng,
): void {
  const col = opt(rng.bool(0.25) ? C.hazardWhite : C.concrete, MR.stone);
  b.box(x, y + 0.12, z, 0.62, 0.24, 2.0, yaw, col);
  b.box(x, y + 0.44, z, 0.4, 0.42, 2.0, yaw, col);
  b.box(x, y + 0.78, z, 0.26, 0.3, 2.0, yaw, col);
  if (rng.bool(0.4)) {
    b.box(x, y + 0.96, z, 0.18, 0.08, 0.5, yaw, opt(C.hazardRed, MR.plastic, emi(C.hazardRed, 0.6)));
  }
}

/** Flashing amber roadworks lamp on a post. */
export function warningLamp(b: PropBuilder, x: number, y: number, z: number): void {
  b.cyl(x, y, z, 0.03, 0.03, 0.9, 4, opt(C.steelDark, MR.metal), false);
  b.blob(x, y + 0.96, z, 0.1, 0.11, 0.1,
    opt(C.paintOrange, MR.lamp, emi(C.paintOrange, 6.0)), 0, 5);
}
