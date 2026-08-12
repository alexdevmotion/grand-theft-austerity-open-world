/**
 * Street furniture: the things a pavement is actually made of.
 *
 * Every function writes into a PropBuilder in world space and takes a facing
 * vector (fx, fz) pointing toward the carriageway, so a piece placed on any of
 * a block's four kerb lines ends up oriented correctly.
 *
 * OWNER: props / street-dressing agent.
 */

import type { Rng } from '../../core/rng';
import { MR, PropBuilder, PropColor as C, emi, type PropOpts } from './kit';
import { SIGN_CELLS, type AtlasPanels } from './signage';

/** Top of the footway. Matches KERB_H in world/city/roads.ts. */
export const WALK_Y = 0.17;

const opt = (color: PropOpts['color'], mr: PropOpts['mr'], emissive?: number[]): PropOpts =>
  ({ color, mr, emissive });

const yawOf = (fx: number, fz: number): number => Math.atan2(fx, fz);

/* ------------------------------------------------------------------ */
/* Seating, bins, small stuff                                          */
/* ------------------------------------------------------------------ */

/** Cast-iron and slat bench. ~60 tris. */
export function bench(b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng): void {
  const yaw = yawOf(fx, fz);
  const wood = opt(rng.bool(0.5) ? C.wood : C.woodPale, MR.wood);
  const iron = opt(C.steelDark, MR.metal);
  const len = 1.8;
  b.addCollisionBox('bench', x, WALK_Y + 0.44, z, len, 0.88, 0.55, yaw);
  // Seat slats, offset along the depth axis.
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 0.17;
    b.box(x + Math.cos(yaw) * off, WALK_Y + 0.44, z + Math.sin(yaw) * off, len, 0.05, 0.13, yaw, wood);
  }
  // Backrest slats.
  for (let i = 0; i < 2; i++) {
    const oy = 0.66 + i * 0.16;
    const od = -0.22;
    b.box(x + Math.cos(yaw) * od, WALK_Y + oy, z + Math.sin(yaw) * od, len, 0.11, 0.05, yaw, wood);
  }
  // Legs / arms.
  for (const s of [-1, 1]) {
    const ax = x + Math.sin(yaw) * s * (len / 2 - 0.08);
    const az = z + Math.cos(yaw) * s * (len / 2 - 0.08);
    b.box(ax, WALK_Y + 0.22, az, 0.07, 0.44, 0.5, yaw, iron);
    b.box(ax + Math.cos(yaw) * -0.22, WALK_Y + 0.55, az + Math.sin(yaw) * -0.22, 0.07, 0.24, 0.07, yaw, iron);
  }
}

/** Perforated steel litter bin on a post. ~40 tris. */
export function litterBin(b: PropBuilder, x: number, z: number, rng: Rng): void {
  const body = opt(rng.bool(0.4) ? C.paintGreen : C.steel, MR.metalRough);
  b.addCollisionCapsule('bin', x, WALK_Y + 0.6, z, 1.2, 0.27);
  b.cyl(x, WALK_Y, z, 0.07, 0.07, 0.62, 6, opt(C.steelDark, MR.metal), false);
  b.cyl(x, WALK_Y + 0.6, z, 0.24, 0.27, 0.56, 8, body, false);
  b.cyl(x, WALK_Y + 1.16, z, 0.29, 0.26, 0.07, 8, opt(C.steelDark, MR.metal));
  // A bag of rubbish poking out.
  if (rng.bool(0.35)) {
    b.blob(x + rng.range(-0.06, 0.06), WALK_Y + 1.26, z + rng.range(-0.06, 0.06),
      0.16, 0.12, 0.15, opt(C.plasticDark, MR.plastic), 0.5, 7);
  }
}

/** Squat concrete ashtray/bollard combo. */
export function stoneBollard(b: PropBuilder, x: number, z: number): void {
  b.addCollisionCapsule('bollard', x, WALK_Y + 0.4, z, 0.84, 0.16);
  b.cyl(x, WALK_Y - 0.02, z, 0.16, 0.14, 0.78, 6, opt(C.concreteDark, MR.stone));
  b.cyl(x, WALK_Y + 0.76, z, 0.15, 0.11, 0.06, 6, opt(C.steelPale, MR.metal));
}

/* ------------------------------------------------------------------ */
/* Shelters, kiosks, cabins                                            */
/* ------------------------------------------------------------------ */

/**
 * Bus / trolleybus shelter: glazed back and ends, cantilever roof, bench,
 * a lit advertising panel at one end and a timetable at the other.
 * ~150 tris.
 */
export function busShelter(
  b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng,
): void {
  const yaw = yawOf(fx, fz);
  const w = 4.2;
  const d = 1.5;
  const h = 2.5;
  const frame = opt(C.steel, MR.metal);
  const glass = opt(C.glass, MR.glass);
  const back = -d / 2;
  // Keep the pavement-facing side genuinely open. The shelter is three
  // semantic blockers, matching the rendered back, bench and advert end;
  // a single footprint box would create an invisible wall across its entrance.
  b.addCollisionBox(
    'bus-shelter-back',
    x + fx * back, WALK_Y + 1.35, z + fz * back,
    w, 2.2, 0.08, yaw,
  );
  b.addCollisionBox(
    'bus-shelter-bench',
    x + fx * (back + 0.3), WALK_Y + 0.46, z + fz * (back + 0.3),
    w - 1.2, 0.07, 0.34, yaw,
  );

  // Roof.
  b.box(x + fx * 0.1, WALK_Y + h, z + fz * 0.1, w, 0.12, d + 0.5, yaw, opt(C.alu, MR.metal));
  b.box(x + fx * 0.1, WALK_Y + h + 0.09, z + fz * 0.1, w - 0.3, 0.05, d + 0.2, yaw, frame);
  // Back glazing (away from the road). Lit from behind by the advert panel and
  // the strip light, so it must not read as a black slab at dusk.
  b.box(x + fx * back, WALK_Y + 1.35, z + fz * back, w, 2.2, 0.05, yaw,
    opt(C.glassPale, MR.glass, emi(C.screenBlue, 0.35)));
  // Corner posts.
  for (const s of [-1, 1]) {
    const px = x + Math.sin(yaw) * s * (w / 2 - 0.06);
    const pz = z + Math.cos(yaw) * s * (w / 2 - 0.06);
    b.box(px + fx * back, WALK_Y + h / 2, pz + fz * back, 0.1, h, 0.1, yaw, frame);
    b.box(px + fx * (d / 2), WALK_Y + h / 2, pz + fz * (d / 2), 0.1, h, 0.1, yaw, frame);
  }
  // Bench inside.
  b.box(x + fx * (back + 0.3), WALK_Y + 0.46, z + fz * (back + 0.3), w - 1.2, 0.07, 0.34, yaw, opt(C.steelPale, MR.metal));

  // Lit advert panel on one end — a real light source on the pavement.
  const s = rng.bool(0.5) ? -1 : 1;
  const ex = x + Math.sin(yaw) * s * (w / 2);
  const ez = z + Math.cos(yaw) * s * (w / 2);
  const adColor = rng.bool(0.5) ? C.magenta : C.screenBlue;
  b.addCollisionBox('bus-shelter-advert', ex, WALK_Y + 1.32, ez, 0.14, 1.9, d - 0.15, yaw);
  b.box(ex, WALK_Y + 1.32, ez, 0.14, 1.9, d - 0.15, yaw, frame);
  b.box(ex + fx * 0.02, WALK_Y + 1.32, ez + fz * 0.02, 0.06, 1.72, d - 0.32, yaw,
    opt(adColor, MR.lamp, emi(adColor, 2.4)));
  // Timetable at the other end.
  const tx = x - Math.sin(yaw) * s * (w / 2 - 0.2);
  const tz = z - Math.cos(yaw) * s * (w / 2 - 0.2);
  b.box(tx + fx * (back + 0.06), WALK_Y + 1.5, tz + fz * (back + 0.06), 0.6, 0.85, 0.04, yaw,
    opt(C.paper, MR.paper, emi(C.sodium, 0.25)));
  // Strip light under the roof.
  b.box(x + fx * 0.1, WALK_Y + h - 0.12, z + fz * 0.1, w - 0.6, 0.08, 0.5, yaw,
    opt(C.sodium, MR.lamp, emi(C.sodium, 4.5)));
}

/**
 * Corner kiosk — the Bucharest `chioșc`: metal box, glazed serving hatch,
 * an awning, shelves of magazines and a lit fascia.
 * ~180 tris.
 */
export function kiosk(
  b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng,
): void {
  const yaw = yawOf(fx, fz);
  const w = rng.range(2.4, 3.2);
  const d = rng.range(1.8, 2.3);
  const h = 2.7;
  const shell = rng.weighted([C.paintCream, C.paintGreen, C.paintBlue, C.steelPale], [3, 2, 2, 2]);
  b.addCollisionBox('kiosk', x, WALK_Y + h / 2, z, w, h, d, yaw);

  b.box(x, WALK_Y + h / 2, z, w, h, d, yaw, opt(shell, MR.paint));
  // Roof cap.
  b.box(x, WALK_Y + h + 0.06, z, w + 0.24, 0.12, d + 0.24, yaw, opt(C.steelDark, MR.metal));
  // Glazed front + serving hatch.
  b.box(x + fx * (d / 2 + 0.01), WALK_Y + 1.55, z + fz * (d / 2 + 0.01), w - 0.34, 1.25, 0.06, yaw,
    opt(C.glassPale, MR.glass, emi(C.sodium, 0.9)));
  // Interior glow spilling through.
  b.box(x, WALK_Y + 1.5, z, w - 0.5, 1.1, d - 0.5, yaw, opt(C.sodium, MR.lamp, emi(C.sodium, 1.3)));
  // Lit fascia sign band.
  const fascia = rng.bool(0.5) ? C.neon : C.sodium;
  b.box(x + fx * (d / 2 + 0.04), WALK_Y + 2.42, z + fz * (d / 2 + 0.04), w - 0.1, 0.42, 0.09, yaw,
    opt(fascia, MR.lamp, emi(fascia, 3.4)));
  // Awning over the hatch.
  b.box(x + fx * (d / 2 + 0.42), WALK_Y + 2.16, z + fz * (d / 2 + 0.42), w, 0.05, 0.9, yaw,
    opt(C.fabricRed, MR.fabric));
  for (const s of [-1, 1]) {
    const px = x + Math.sin(yaw) * s * (w / 2 - 0.1);
    const pz = z + Math.cos(yaw) * s * (w / 2 - 0.1);
    b.tube(px + fx * (d / 2), WALK_Y + 2.3, pz + fz * (d / 2),
      px + fx * (d / 2 + 0.85), WALK_Y + 2.14, pz + fz * (d / 2 + 0.85), 0.02, 3, opt(C.steel, MR.metal));
  }
  // Magazines racked outside.
  if (rng.bool(0.6)) {
    const rx = x + fx * (d / 2 + 0.36) + Math.sin(yaw) * (w / 2 - 0.4);
    const rz = z + fz * (d / 2 + 0.36) + Math.cos(yaw) * (w / 2 - 0.4);
    b.box(rx, WALK_Y + 0.5, rz, 0.7, 0.9, 0.3, yaw, opt(C.steel, MR.metal));
    for (let i = 0; i < 3; i++) {
      b.box(rx, WALK_Y + 0.62 + i * 0.22, rz + 0.02, 0.62, 0.02, 0.26, yaw, opt(C.paper, MR.paper));
    }
  }
}

/** Wall-mounted ATM / bancomat with a lit screen. ~45 tris. */
export function atm(b: PropBuilder, x: number, z: number, fx: number, fz: number): void {
  const yaw = yawOf(fx, fz);
  b.addCollisionBox('atm', x, WALK_Y + 1.35, z, 1.0, 1.9, 0.34, yaw);
  b.box(x, WALK_Y + 1.35, z, 1.0, 1.9, 0.34, yaw, opt(C.steelPale, MR.metal));
  b.box(x + fx * 0.18, WALK_Y + 1.62, z + fz * 0.18, 0.62, 0.46, 0.05, yaw,
    opt(C.screenBlue, MR.lamp, emi(C.screenBlue, 2.6)));
  b.box(x + fx * 0.18, WALK_Y + 1.2, z + fz * 0.18, 0.36, 0.24, 0.05, yaw, opt(C.plasticDark, MR.plastic));
  // Canopy light.
  b.box(x + fx * 0.16, WALK_Y + 2.24, z + fz * 0.16, 1.06, 0.12, 0.4, yaw,
    opt(C.sodium, MR.lamp, emi(C.sodium, 1.8)));
}

/** Old telephone box, glass and steel, lit from inside. ~70 tris. */
export function phoneBox(b: PropBuilder, x: number, z: number, fx: number, fz: number): void {
  const yaw = yawOf(fx, fz);
  const h = 2.25;
  const frame = opt(C.paintBlue, MR.paint);
  b.addCollisionBox('phone-box', x, WALK_Y + h / 2, z, 1.0, h, 0.86, yaw);
  for (const [sx, sz] of [[-1, -1], [-1, 1], [1, 1], [1, -1]] as const) {
    const px = x + Math.sin(yaw) * sx * 0.42 + Math.cos(yaw) * sz * 0.36;
    const pz = z + Math.cos(yaw) * sx * 0.42 - Math.sin(yaw) * sz * 0.36;
    b.box(px, WALK_Y + h / 2, pz, 0.09, h, 0.09, yaw, frame);
  }
  b.box(x, WALK_Y + h + 0.06, z, 1.0, 0.14, 0.86, yaw, frame);
  b.box(x, WALK_Y + 1.4, z, 0.84, 1.5, 0.72, yaw, opt(C.glassPale, MR.glass, emi(C.screenBlue, 0.7)));
  b.box(x, WALK_Y + h - 0.12, z, 0.7, 0.06, 0.6, yaw, opt(C.sodium, MR.lamp, emi(C.sodium, 2.2)));
}

/** Newspaper / lottery stand: a low glazed case on legs. ~50 tris. */
export function newsStand(b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng): void {
  const yaw = yawOf(fx, fz);
  b.addCollisionBox('news-stand', x, WALK_Y + 0.9, z, 1.5, 1.8, 0.72, yaw);
  b.box(x, WALK_Y + 0.5, z, 1.4, 0.9, 0.6, yaw, opt(C.steel, MR.metal));
  b.box(x, WALK_Y + 1.02, z, 1.5, 0.14, 0.72, yaw, opt(C.paintRed, MR.paint));
  // Papers stacked on the top, roughly aligned.
  for (let i = 0; i < 4; i++) {
    b.ground(
      x + Math.sin(yaw) * rng.range(-0.5, 0.5) + Math.cos(yaw) * rng.range(-0.16, 0.16),
      WALK_Y + 1.1 + i * 0.006,
      z + Math.cos(yaw) * rng.range(-0.5, 0.5) - Math.sin(yaw) * rng.range(-0.16, 0.16),
      0.3, 0.4, yaw + rng.range(-0.3, 0.3), opt(C.paper, MR.paper),
    );
  }
  b.box(x, WALK_Y + 1.5, z, 1.5, 0.7, 0.06, yaw, opt(C.paperDim, MR.paper, emi(C.sodium, 0.4)));
  for (const s of [-1, 1]) {
    b.box(x + Math.sin(yaw) * s * 0.7, WALK_Y + 1.5, z + Math.cos(yaw) * s * 0.7, 0.06, 0.76, 0.08, yaw,
      opt(C.steel, MR.metal));
  }
}

/** Steel utility cabinet, stickered and tagged. ~20 tris. */
export function utilityCabinet(b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng): void {
  const yaw = yawOf(fx, fz);
  const h = rng.range(1.0, 1.5);
  const w = rng.range(0.7, 1.1);
  b.addCollisionBox('utility-cabinet', x, WALK_Y + h / 2, z, w, h, 0.42, yaw);
  b.box(x, WALK_Y + h / 2, z, w, h, 0.42, yaw, opt(C.galv, MR.metalRough));
  b.box(x + fx * 0.22, WALK_Y + h * 0.62, z + fz * 0.22, 0.34, 0.24, 0.02, yaw, opt(C.paper, MR.paper));
}

/* ------------------------------------------------------------------ */
/* Wheels                                                              */
/* ------------------------------------------------------------------ */

/** Sheffield-style bike stands with a couple of locked bicycles. */
export function bikeRack(
  b: PropBuilder, x: number, z: number, fx: number, fz: number, n: number, rng: Rng,
): void {
  const yaw = yawOf(fx, fz);
  const sx = Math.sin(yaw);
  const sz = Math.cos(yaw);
  const steel = opt(C.steelPale, MR.metal);
  b.addCollisionBox('bike-rack', x + Math.cos(yaw) * 0.175, WALK_Y + 0.36, z + Math.sin(yaw) * 0.175,
    0.75, 0.72, Math.max(0.1, (n - 1) * 0.85 + 0.1), yaw);
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 0.85;
    const px = x + sx * off;
    const pz = z + sz * off;
    b.box(px, WALK_Y + 0.36, pz, 0.05, 0.72, 0.05, yaw, steel);
    b.box(px + Math.cos(yaw) * 0.35, WALK_Y + 0.36, pz + Math.sin(yaw) * 0.35, 0.05, 0.72, 0.05, yaw, steel);
    b.box(px + Math.cos(yaw) * 0.175, WALK_Y + 0.72, pz + Math.sin(yaw) * 0.175, 0.05, 0.05, 0.4, yaw, steel);
    if (rng.bool(0.5)) bicycle(b, px + sx * 0.2, pz + sz * 0.2, yaw + Math.PI / 2, rng);
  }
}

/**
 * Leaning bicycle. ~70 tris.
 *
 * Bicycles are emitted only by `bikeRack`; that high-level prop owns one
 * aggregate blocker for the stands and any optional bikes. Giving each wheel
 * and frame another collider would add overlapping shapes without changing
 * what can traverse the rack.
 */
export function bicycle(b: PropBuilder, x: number, z: number, yaw: number, rng: Rng): void {
  const frameC = rng.weighted(
    [C.paintRed, C.paintBlue, C.steelDark, C.paintGreen, C.paintYellow],
    [2, 2, 3, 1, 1],
  );
  const frame = opt(frameC, MR.paint);
  const tyre = opt(C.rubber, MR.rubber);
  const lean = rng.range(-0.08, 0.08);
  const ax = Math.sin(yaw);
  const az = Math.cos(yaw);
  const at = (t: number, y: number): [number, number, number] =>
    [x + ax * t + lean * y, WALK_Y + y, z + az * t];
  // Wheels as thin rings approximated by cylinders on their side.
  for (const t of [-0.52, 0.52]) {
    const [wx, wy, wz] = at(t, 0.34);
    b.tube(wx - az * 0.02, wy, wz + ax * 0.02, wx + az * 0.02, wy, wz - ax * 0.02, 0.34, 8, tyre);
  }
  const [r0x, r0y, r0z] = at(-0.5, 0.34);
  const [r1x, r1y, r1z] = at(0.5, 0.34);
  const [cx, cy, cz] = at(-0.05, 0.3);
  const [sx, sy, sz] = at(-0.12, 0.72);
  const [hx, hy, hz] = at(0.42, 0.9);
  b.tube(r0x, r0y, r0z, cx, cy, cz, 0.025, 4, frame);
  b.tube(cx, cy, cz, sx, sy, sz, 0.025, 4, frame);
  b.tube(sx, sy, sz, r0x, r0y, r0z, 0.022, 4, frame);
  b.tube(sx, sy, sz, hx, hy, hz, 0.025, 4, frame);
  b.tube(hx, hy, hz, r1x, r1y, r1z, 0.025, 4, frame);
  b.box(hx, hy + 0.04, hz, 0.5, 0.03, 0.03, yaw + Math.PI / 2, frame);
  b.box(sx, sy + 0.08, sz, 0.22, 0.05, 0.1, yaw, opt(C.plasticDark, MR.plastic));
}

/** The acid-green e-scooter from the reference. ~60 tris. */
export function eScooter(b: PropBuilder, x: number, z: number, yaw: number, rng: Rng): void {
  const deck = opt(C.plasticDark, MR.plastic);
  const green = opt(C.scooter, MR.plastic, emi(C.scooter, 0.35));
  const ax = Math.sin(yaw);
  const az = Math.cos(yaw);
  const lean = rng.bool(0.35);
  const tilt = lean ? rng.range(0.28, 0.46) * (rng.bool() ? 1 : -1) : 0;
  const px = (t: number): number => x + ax * t;
  const pz = (t: number): number => z + az * t;
  const drop = Math.abs(tilt) * 0.18;
  b.addCollisionBox(
    'e-scooter', px(-0.02), WALK_Y + 0.52, pz(-0.02),
    1.05, 1.04, 0.28, yaw + Math.PI / 2,
  );

  // Deck.
  b.box(px(-0.02), WALK_Y + 0.15 - drop, pz(-0.02), 0.9, 0.07, 0.19, yaw + Math.PI / 2, deck);
  b.box(px(-0.02), WALK_Y + 0.19 - drop, pz(-0.02), 0.86, 0.02, 0.17, yaw + Math.PI / 2, green);
  // Wheels.
  for (const t of [-0.5, 0.48]) {
    b.tube(px(t) - az * 0.03, WALK_Y + 0.11, pz(t) + ax * 0.03,
      px(t) + az * 0.03, WALK_Y + 0.11, pz(t) - ax * 0.03, 0.11, 6, opt(C.rubber, MR.rubber));
  }
  // Stem + bars.
  const sx0 = px(0.46);
  const sz0 = pz(0.46);
  const sx1 = px(0.46) + tilt * 0.9;
  const sz1 = pz(0.46) + tilt * 0.4;
  b.tube(sx0, WALK_Y + 0.16, sz0, sx1, WALK_Y + 1.02, sz1, 0.035, 5, opt(C.steelPale, MR.metal));
  b.box(sx1, WALK_Y + 1.04, sz1, 0.46, 0.045, 0.045, yaw + Math.PI / 2, opt(C.steelDark, MR.metal));
  b.box(sx1, WALK_Y + 0.92, sz1, 0.16, 0.12, 0.08, yaw, green);
  // Stand.
  b.tube(px(-0.3), WALK_Y + 0.13, pz(-0.3), px(-0.34), WALK_Y, pz(-0.34) - 0.1, 0.015, 3,
    opt(C.steelPale, MR.metal));
}

/* ------------------------------------------------------------------ */
/* Traffic control                                                     */
/* ------------------------------------------------------------------ */

/**
 * Traffic light: post, head with three lit lenses, plus a pedestrian head
 * lower down. The lenses are emissive so bloom picks them up.
 * ~90 tris.
 */
export function trafficLight(
  b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng, mast = false,
): void {
  const yaw = yawOf(fx, fz);
  const post = opt(C.steelDark, MR.metal);
  const h = mast ? 5.6 : 3.4;
  b.addCollisionCapsule('traffic-light', x, WALK_Y + h / 2 - 0.05, z, h, 0.2);
  b.cyl(x, WALK_Y - 0.05, z, 0.115, 0.085, h, 6, post, false);
  b.cyl(x, WALK_Y - 0.06, z, 0.2, 0.17, 0.28, 6, post);

  const headAt = (hx: number, hy: number, hz: number, phase: number): void => {
    b.box(hx, hy, hz, 0.32, 0.92, 0.28, yaw, post);
    const lenses: Array<[number, typeof C.hazardRed, number]> = [
      [0.33, C.hazardRed, phase === 0 ? 4.2 : 0.06],
      [0.0, C.paintYellow, phase === 1 ? 4.2 : 0.06],
      [-0.33, C.scooter, phase === 2 ? 4.2 : 0.06],
    ];
    for (const [dy, col, gain] of lenses) {
      b.box(hx + fx * 0.15, hy + dy, hz + fz * 0.15, 0.2, 0.2, 0.06, yaw,
        opt(col, MR.lamp, emi(col, gain)));
      // Hood over each lens.
      b.box(hx + fx * 0.2, hy + dy + 0.13, hz + fz * 0.2, 0.24, 0.04, 0.16, yaw, post);
    }
  };

  const phase = rng.int(0, 3);
  if (mast) {
    // Cantilever arm out over the carriageway with a head hanging off it.
    const reach = 4.6;
    b.tube(x, WALK_Y + h - 0.2, z, x + fx * reach, WALK_Y + h - 0.35, z + fz * reach, 0.07, 5, post);
    b.tube(x, WALK_Y + h - 1.5, z, x + fx * reach * 0.5, WALK_Y + h - 0.28, z + fz * reach * 0.5,
      0.045, 4, post);
    headAt(x + fx * reach, WALK_Y + h - 0.95, z + fz * reach, phase);
  }
  headAt(x + fx * 0.16, WALK_Y + h - 0.7, z + fz * 0.16, phase);
  // Pedestrian head at eye level.
  const pcol = phase === 2 ? C.hazardRed : C.scooter;
  b.box(x + fx * 0.14, WALK_Y + 2.05, z + fz * 0.14, 0.26, 0.5, 0.2, yaw, post);
  b.box(x + fx * 0.25, WALK_Y + 2.05, z + fz * 0.25, 0.17, 0.34, 0.04, yaw,
    opt(pcol, MR.lamp, emi(pcol, 2.4)));
}

export type SignShape = 'circle' | 'triangle' | 'rect' | 'blue';

/**
 * Road sign on a galvanised post.
 *
 * The FACE is a printed cell of the sign atlas (`signage.ts`), not a flat
 * coloured plate: a stop sign has to be a saturated red octagon with STOP
 * across it, a give-way has to be the inverted triangle, a parking sign has to
 * be a blue square with a P. A row of anonymous dark discs down a pavement is
 * one of the loudest tells that a street was generated.
 *
 * `faces` receives the printed panel; the builder gets the post, the backing
 * plate and the clamps. The backing plate is a low-roughness painted plate so
 * headlights and sodium lamps catch it at night. ~40 tris.
 */
export function roadSign(
  b: PropBuilder, faces: AtlasPanels,
  x: number, z: number, fx: number, fz: number, kind: SignShape, rng: Rng,
): void {
  const yaw = yawOf(fx, fz);
  const post = opt(C.galv, MR.metal);
  const top = rng.range(2.1, 2.5);
  b.addCollisionCapsule('road-sign', x, WALK_Y + top / 2, z, top, 0.07);
  b.cyl(x, WALK_Y, z, 0.045, 0.04, top, 5, post, false);
  const fy = WALK_Y + top - 0.1;
  // Sheeting is retroreflective: low roughness so practicals pick it out.
  const plate = opt(C.steelPale, [0.1, 0.25]);
  const cells = SIGN_CELLS[kind];
  const cell = cells[rng.int(0, cells.length)];

  let w: number;
  let cy: number;
  switch (kind) {
    case 'circle':
      w = 0.74;
      cy = fy - 0.32;
      // Backing disc slightly smaller than the print so the printed rim reads.
      b.disc(x + fx * 0.03, cy, z + fz * 0.03, w * 0.46, fx, fz, 10, plate);
      break;
    case 'triangle':
      w = 0.84;
      cy = fy - 0.34;
      b.panel(x + fx * 0.03, cy, z + fz * 0.03, w * 0.82, w * 0.72, fx, fz, plate);
      break;
    case 'blue':
      w = 0.66;
      cy = fy - 0.34;
      b.box(x + fx * 0.03, cy, z + fz * 0.03, w * 0.9, w * 0.9, 0.03, yaw, plate);
      break;
    default:
      // Band boards print into the middle 40% of a square cell, so the plate
      // is that band and the panel is the whole square around it.
      w = 1.05;
      cy = fy - 0.3;
      b.box(x + fx * 0.03, cy, z + fz * 0.03, w * 0.98, w * 0.38, 0.03, yaw, plate);
      break;
  }
  // Clamps front and back of the post.
  for (const s of [-1, 1]) {
    b.box(x, cy + s * w * 0.26, z, 0.11, 0.07, 0.11, yaw, opt(C.galv, MR.metalRough));
  }
  faces.add(x + fx * 0.055, cy, z + fz * 0.055, w, w, fx, fz, cell);
}

/** Blue street-name plate, mounted on a wall or a lamp post. */
export function streetNamePlate(
  b: PropBuilder, x: number, y: number, z: number, fx: number, fz: number,
): void {
  const yaw = yawOf(fx, fz);
  b.box(x, y, z, 0.95, 0.26, 0.04, yaw, opt(C.paintBlue, MR.paint, emi(C.screenBlue, 0.22)));
  b.box(x + fx * 0.025, y, z + fz * 0.025, 0.8, 0.09, 0.02, yaw, opt(C.hazardWhite, MR.paint));
}

/* ------------------------------------------------------------------ */
/* Flags                                                               */
/* ------------------------------------------------------------------ */

/**
 * Romanian tricolour. `mast` builds a freestanding vertical flagpole from the
 * ground; otherwise the pole rakes out of a facade at 30 degrees, which is how
 * every ministry and bank in Bucharest flies one.
 *
 * The cloth is built as a shallow S-curve of quads so it catches the low sun on
 * one fold and falls into violet shadow on the next — a flat plate reads as a
 * sticker. ~110 tris.
 */
export function tricolour(
  b: PropBuilder,
  x: number, y: number, z: number,
  fx: number, fz: number,
  rng: Rng,
  mast = false,
): void {
  const pole = opt(C.alu, MR.metal);
  const len = mast ? 8.5 : 3.4;
  const rake = mast ? 0 : 0.52;
  // Pole tip.
  const tx = x + fx * len * Math.cos(rake);
  const tz = z + fz * len * Math.cos(rake);
  const ty = y + (mast ? len : len * Math.sin(rake));
  b.tube(x, y, z, tx, ty, tz, 0.045, 5, pole);
  b.blob(tx, ty, tz, 0.075, 0.09, 0.075, opt(C.roYellow, MR.metal), 0, 3);
  if (mast) {
    b.addCollisionCapsule('flagpole', x, y + len / 2, z, len, 0.24);
    b.cyl(x, y - 0.02, z, 0.24, 0.19, 0.34, 8, opt(C.concrete, MR.stone));
  } else {
    b.box(x, y, z, 0.18, 0.3, 0.18, Math.atan2(fx, fz), opt(C.steel, MR.metal));
  }

  // Flag hangs from the outer half of the pole.
  const h = mast ? 1.5 : 1.15;
  const w = mast ? 2.4 : 1.85;
  // Along the pole axis, from 45% to 45%+w.
  const ux = mast ? 0 : fx * Math.cos(rake);
  const uz = mast ? 0 : fz * Math.cos(rake);
  const uy = mast ? -1 : Math.sin(rake);
  const startT = mast ? len * 0.06 : len * 0.42;
  const ax = mast ? x : x + ux * startT;
  const az = mast ? z : z + uz * startT;
  const ay = mast ? y + len - 0.25 : y + uy * startT;
  // Perpendicular used for the drape.
  const dx = mast ? 1 : -fz;
  const dz = mast ? 0 : fx;

  const bands = [C.roBlue, C.roYellow, C.roRed];
  const cols = 4;
  const flutter = rng.range(0.12, 0.3);
  for (let s = 0; s < 3; s++) {
    const o = opt(bands[s], MR.fabric);
    const y0 = -h * (s / 3);
    const y1 = -h * ((s + 1) / 3);
    for (let c = 0; c < cols; c++) {
      const t0 = (c / cols) * w;
      const t1 = ((c + 1) / cols) * w;
      // S-curve: the cloth waves away from the pole.
      const w0 = Math.sin(t0 * 2.1) * flutter * (t0 / w);
      const w1 = Math.sin(t1 * 2.1) * flutter * (t1 / w);
      const p0x = ax + ux * t0 + dx * w0;
      const p0z = az + uz * t0 + dz * w0;
      const p1x = ax + ux * t1 + dx * w1;
      const p1z = az + uz * t1 + dz * w1;
      const p0y = ay + uy * t0;
      const p1y = ay + uy * t1;
      b.quad(
        [p0x, p0y + y0, p0z], [p1x, p1y + y0, p1z],
        [p1x, p1y + y1, p1z], [p0x, p0y + y1, p0z], o,
      );
      b.quad(
        [p0x, p0y + y1, p0z], [p1x, p1y + y1, p1z],
        [p1x, p1y + y0, p1z], [p0x, p0y + y0, p0z], o,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Market                                                              */
/* ------------------------------------------------------------------ */

/** Market stall: striped canopy on poles, crates of produce, a lamp. ~140 tris. */
export function marketStall(
  b: PropBuilder, x: number, z: number, fx: number, fz: number, rng: Rng,
): void {
  const yaw = yawOf(fx, fz);
  const w = rng.range(2.6, 3.4);
  const d = 1.7;
  const legs = opt(C.steelPale, MR.metal);
  b.addCollisionBox('market-stall', x, WALK_Y + 0.45, z, w, 0.9, d - 0.3, yaw);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = x + Math.sin(yaw) * sx * (w / 2 - 0.1) + Math.cos(yaw) * sz * (d / 2 - 0.1);
      const pz = z + Math.cos(yaw) * sx * (w / 2 - 0.1) - Math.sin(yaw) * sz * (d / 2 - 0.1);
      b.box(px, WALK_Y + 1.1, pz, 0.05, 2.2, 0.05, yaw, legs);
    }
  }
  // Striped canopy, two slopes.
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) * (w / 5);
    const col = i % 2 === 0 ? C.hazardWhite : C.fabricRed;
    b.box(x + Math.sin(yaw) * t, WALK_Y + 2.26, z + Math.cos(yaw) * t, w / 5, 0.06, d + 0.5, yaw,
      opt(col, MR.fabric));
  }
  // Trestle table.
  b.box(x, WALK_Y + 0.86, z, w, 0.06, d - 0.3, yaw, opt(C.woodPale, MR.wood));
  // Crates and produce.
  for (let i = 0; i < 4; i++) {
    const t = rng.range(-w / 2 + 0.3, w / 2 - 0.3);
    const cx = x + Math.sin(yaw) * t;
    const cz = z + Math.cos(yaw) * t;
    b.box(cx, WALK_Y + 1.0, cz, 0.44, 0.22, 0.32, yaw + rng.range(-0.2, 0.2), opt(C.cardboard, MR.wood));
    const produce = rng.weighted([C.paintRed, C.paintOrange, C.leafOlive, C.paintYellow], [2, 2, 2, 1]);
    b.blob(cx, WALK_Y + 1.16, cz, 0.19, 0.08, 0.13, opt(produce, MR.plastic), 0.5, 13 + i);
  }
  // Bare bulb strung under the canopy.
  b.box(x, WALK_Y + 2.1, z, 0.12, 0.12, 0.12, 0, opt(C.sodium, MR.lamp, emi(C.sodium, 5.0)));
}
