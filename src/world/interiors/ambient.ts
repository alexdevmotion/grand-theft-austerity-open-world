/**
 * THE AMBIENT INTERIORS — so the city is not solid.
 *
 * A corner shop, a bar and a block stairwell, all three on the frontage the
 * player crosses in the first minute of the game. They carry no story: their
 * whole job is that the first time you walk up to a door in this city, it
 * opens, and what is behind it is a room somebody works in rather than a
 * cupboard.
 *
 * Each is deliberately SMALL and dense. A 15 x 12 shop with four aisles, a
 * lit fridge run and a shopkeeper reads better than a hall three times the
 * size with the same budget spread across it.
 *
 * OWNER: interiors agent.
 */

import type { Rng } from '../../core/rng';
import type { DetailBuilder } from '../city/builders';
import { srgb } from '../../render/materials';
import {
  Glow, Mat, anchor, barCounter, battenLight, beerTaps, cableRun,
  figure, fridgeCabinet, glowOpts, letterboxWall, liftDoors, litterPapers,
  monitor, officeChair, pendant, shelfUnit, signBox,
  stairFlight, type LightAnchor,
} from './kit';
import { Finish, drawShellRoom, innerHalf, lightPool, type ShellSpec } from './shell';

const lin = srgb;

/* ------------------------------------------------------------------ */
/* Magazin Non-Stop                                                    */
/* ------------------------------------------------------------------ */

export function fitShop(b: DetailBuilder, s: ShellSpec, rng: Rng): LightAnchor[] {
  const { hx, hz } = innerHalf(s);
  const x0 = s.cx - hx;
  const x1 = s.cx + hx;
  const z0 = s.cz - hz;
  const z1 = s.cz + hz;
  const y = s.floorY;
  const lights: LightAnchor[] = [];

  drawShellRoom(b, s, Finish.shop, { glazed: ['north'] });

  // Vinyl tiles, worn along the walked line from the door to the counter.
  b.box(s.cx, y + 0.012, s.cz, hx * 2 - 0.2, 0.024, hz * 2 - 0.2, 0,
    { color: lin(0x8d857a), mr: [0.03, 0.55] });
  b.box(s.cx - 1.5, y + 0.026, s.cz + 1.0, 8.0, 0.004, 1.6, 0.12,
    { color: lin(0x776f66), mr: [0.05, 0.42] });
  // Entrance mat.
  b.box(s.cx + s.door.offset, y + 0.03, z1 - 0.9, 1.6, 0.02, 1.0, 0, Mat.rubber);
  // Tiled dado on the three solid walls: a flat painted box reads as untextured
  // no matter how much stock is standing in front of it.
  for (const [wx, wz, sx, sz] of [
    [s.cx, z0 + 0.1, hx * 2 - 0.2, 0.05],
    [x0 + 0.1, s.cz, 0.05, hz * 2 - 0.2],
    [x1 - 0.1, s.cz, 0.05, hz * 2 - 0.2],
  ] as Array<[number, number, number, number]>) {
    b.box(wx, y + 0.75, wz, sx, 1.5, sz, 0, { color: lin(0xb9b2a4), mr: [0.05, 0.42] });
    b.box(wx, y + 1.52, wz, sx, 0.05, sz + 0.02, 0, { color: lin(0x8d857a), mr: [0, 0.6] });
  }

  /* ---- counter, till, cigarette gantry ---- */
  const cx = x0 + 1.9;
  b.box(cx, y + 0.5, s.cz - 0.4, 1.0, 1.0, 4.2, 0, { color: lin(0x6d6459), mr: [0, 0.7] });
  b.box(cx, y + 1.04, s.cz - 0.4, 1.15, 0.07, 4.4, 0, { color: lin(0xd8d0be), mr: [0.05, 0.4] });
  // Till + card reader + a jar of lighters.
  b.box(cx, y + 1.2, s.cz + 0.9, 0.42, 0.26, 0.5, -0.3, Mat.plasticGrey);
  b.box(cx - 0.1, y + 1.32, s.cz + 0.9, 0.24, 0.02, 0.3, -0.3, glowOpts(Glow.green, 2.2));
  b.box(cx + 0.35, y + 1.12, s.cz + 0.2, 0.1, 0.09, 0.16, 0, Mat.plasticBlack);
  b.cyl(cx, y + 1.08, s.cz - 1.2, 0.09, 0.09, 0.13, 8, { color: lin(0x3a6d4a), mr: [0, 0.6] });
  // Gantry behind: cigarettes under a shutter, spirits above.
  shelfUnit(b, x0 + 0.5, s.cz - 0.4, 0, 4.2, 1.1, 0.32, 3, rng, Mat.plasticGrey, 'stock', y + 1.6);
  b.box(x0 + 0.42, y + 2.35, s.cz - 0.4, 0.1, 0.5, 4.2, 0, { color: lin(0x5a5650), mr: [0.4, 0.7] });
  shelfUnit(b, x0 + 0.5, s.cz - 0.4, 0, 4.2, 0.9, 0.3, 2, rng, Mat.plasticGrey, 'bottles', y + 0.5);
  // Shopkeeper, permanently behind it.
  figure(b, cx - 0.75, y, s.cz + 0.4, Math.PI * 0.5, { color: lin(0x3a4a6d), mr: [0, 0.9] }, rng);

  /* ---- fridge run along the back wall ---- */
  for (let i = 0; i < 3; i++) {
    const fx = s.cx + 0.4 + i * 1.9;
    lights.push(fridgeCabinet(b, fx, z0 + 0.5, Math.PI, 1.8, 2.0, 0.75, rng, y));
    lightPool(b, fx, y, z0 + 1.4, 1.5, 0xa8c4ff, 0.16);
  }

  /* ---- two aisles ---- */
  for (let a = 0; a < 2; a++) {
    const ax = s.cx - 1.4 + a * 3.4;
    shelfUnit(b, ax, s.cz + 0.6, 0, 0.9, 1.75, 0.5, 4, rng, Mat.plasticGrey, 'stock', y);
    shelfUnit(b, ax, s.cz - 1.6, 0, 0.9, 1.75, 0.5, 4, rng, Mat.plasticGrey, 'stock', y);
    // Aisle price rails.
    for (let k = 1; k <= 3; k++) {
      b.box(ax, y + k * 0.44 + 0.02, s.cz - 0.5, 0.92, 0.05, 0.02, 0,
        { color: lin(0xd8b23a), mr: [0, 0.6] });
    }
  }
  // Bread rack and a crate of vegetables by the window.
  shelfUnit(b, x1 - 1.2, s.cz + 2.6, Math.PI * 0.5, 2.4, 1.5, 0.45, 3, rng, Mat.woodPale, 'stock', y);
  for (let i = 0; i < 3; i++) {
    b.box(x1 - 1.6, y + 0.16 + i * 0.02, z0 + 1.6 + i * 0.05, 0.6, 0.3, 0.4, 0.1 * i,
      { color: lin(0x6d5a3a), mr: [0, 0.92] });
  }
  // Basket stack by the door.
  for (let i = 0; i < 5; i++) {
    b.box(x1 - 0.9, y + 0.14 + i * 0.09, z1 - 1.6, 0.42, 0.2, 0.3, 0.05 * i,
      { color: lin(0xc23a3a), mr: [0, 0.75] });
  }

  /* ---- light: two battens and the fridge glow, nothing else ---- */
  lights.push(battenLight(b, s.cx - 2.0, s.ceilingY - 0.2, s.cz, 3.4, 0, Glow.fluorescent, 3.8));
  lights.push(battenLight(b, s.cx + 3.0, s.ceilingY - 0.2, s.cz, 3.4, 0, Glow.fluorescent, 3.8));
  // Fly strip and a dead wasp's worth of realism.
  b.tube(x1 - 2.4, s.ceilingY - 0.2, s.cz + 1.2, x1 - 2.4, s.ceilingY - 0.9, s.cz + 1.2,
    0.01, 4, { color: lin(0xc8a83a), mr: [0, 0.8] });
  // Illuminated shopfront sign, inside the glass.
  signBox(b, s.cx, s.ceilingY - 0.55, z1 - 0.3, Math.PI, 4.4, 0.6, Glow.red, 3.4);
  lights.push(anchor(s.cx, s.ceilingY - 0.9, z1 - 1.0, 0xff5a5a, 1.4, 6, 1));
  return lights;
}

/* ------------------------------------------------------------------ */
/* Barul Constructorilor                                               */
/* ------------------------------------------------------------------ */

export function fitBar(b: DetailBuilder, s: ShellSpec, rng: Rng): LightAnchor[] {
  const { hx, hz } = innerHalf(s);
  const x0 = s.cx - hx;
  const x1 = s.cx + hx;
  const z0 = s.cz - hz;
  const z1 = s.cz + hz;
  const y = s.floorY;
  const lights: LightAnchor[] = [];

  drawShellRoom(b, s, Finish.bar, { glazed: ['north'] });

  // Boards, laid along the room, and a dado of dark panelling.
  b.box(s.cx, y + 0.012, s.cz, hx * 2 - 0.2, 0.024, hz * 2 - 0.2, 0,
    { color: lin(0x3a2a1e), mr: [0.04, 0.62] });
  for (const wz of [z0 + 0.1, z1 - 0.1]) {
    b.box(s.cx, y + 0.55, wz, hx * 2 - 0.2, 1.1, 0.06, 0, Mat.woodWarm);
    b.box(s.cx, y + 1.12, wz, hx * 2 - 0.2, 0.05, 0.09, 0, Mat.woodWarm);
  }

  /* ---- the bar itself, along the back wall ---- */
  const bz = z0 + 1.1;
  barCounter(b, s.cx - 4.6, s.cx + 3.2, bz, 0, y);
  beerTaps(b, s.cx - 1.0, y + 1.1, bz - 0.18, 4);
  // Back gantry: bottles on lit glass shelves, a mirror behind them.
  b.box(s.cx - 0.7, y + 1.7, z0 + 0.18, 8.4, 2.6, 0.05, 0,
    { color: lin(0x1d1912), mr: [0.5, 0.25] });
  shelfUnit(b, s.cx - 0.7, z0 + 0.42, 0, 8.0, 1.5, 0.3, 3, rng, Mat.woodDark, 'bottles', y + 1.1);
  for (let i = 0; i < 3; i++) {
    b.box(s.cx - 0.7, y + 1.12 + i * 0.5, z0 + 0.5, 7.9, 0.02, 0.28, 0, glowOpts(Glow.amber, 2.6));
  }
  lights.push(anchor(s.cx - 0.7, y + 2.0, z0 + 1.0, 0xffa030, 8.0, 9, 3));
  // Glasses hanging over the counter.
  for (let i = 0; i < 9; i++) {
    b.cyl(s.cx - 3.6 + i * 0.5, y + 2.05, bz + 0.1, 0.035, 0.045, 0.14, 6,
      { color: lin(0xbfd0d8), mr: [0.6, 0.14] }, false);
  }
  b.box(s.cx - 1.3, y + 2.22, bz + 0.1, 5.0, 0.06, 0.3, 0, Mat.woodWarm);

  // Stools.
  for (let i = 0; i < 5; i++) {
    const sx = s.cx - 4.0 + i * 1.6;
    b.cyl(sx, y, bz + 0.95, 0.2, 0.06, 0.72, 7, Mat.darkSteel, false);
    b.cyl(sx, y + 0.72, bz + 0.95, 0.19, 0.19, 0.08, 9, Mat.fabricRed);
    if (i === 1 || i === 3) {
      figure(b, sx, y + 0.28, bz + 0.95, 0,
        i === 1 ? { color: lin(0x4a3a2a), mr: [0, 0.92] } : Mat.fabricGrey, rng, true);
    }
  }

  /* ---- tables ---- */
  const tables: Array<[number, number]> = [
    [x0 + 2.2, z1 - 2.2], [s.cx + 0.6, z1 - 2.4], [x1 - 2.4, z1 - 2.2], [x1 - 2.6, s.cz - 0.4],
  ];
  tables.forEach(([tx, tz], i) => {
    b.cyl(tx, y, tz, 0.28, 0.08, 0.72, 8, Mat.darkSteel, false);
    b.cyl(tx, y + 0.72, tz, 0.42, 0.42, 0.05, 12, Mat.woodWarm);
    for (let k = 0; k < 2; k++) {
      const a = i + k * Math.PI + 0.6;
      officeChair(b, tx + Math.sin(a) * 0.78, tz + Math.cos(a) * 0.78, a + Math.PI, y,
        { color: lin(0x3a2a24), mr: [0, 0.9] });
    }
    // Glasses, an ashtray-that-is-now-a-bottle-cap-dish, a candle.
    for (let g = 0; g < 2; g++) {
      b.cyl(tx + (g - 0.5) * 0.22, y + 0.75, tz + 0.08, 0.036, 0.042, 0.13, 6,
        { color: lin(0xc8b070), mr: [0.3, 0.2], emissive: [0.05, 0.03, 0.005] });
    }
    b.cyl(tx, y + 0.75, tz - 0.16, 0.04, 0.04, 0.08, 6, { color: lin(0xd8d2c4), mr: [0, 0.5] });
    b.box(tx, y + 0.83, tz - 0.16, 0.03, 0.05, 0.03, 0, glowOpts(Glow.tungsten, 7));
    lights.push(pendant(b, tx, s.ceilingY - 0.1, tz, 1.35, 0x3a2a1e, Glow.tungsten, 6.5));
  });

  /* ---- dressing: TV, neon, dartboard, jukebox, a builders' banner ---- */
  monitor(b, x1 - 0.35, y + 2.2, s.cz + 2.6, -Math.PI * 0.5, 1.1, 0.66, 'broadcast', rng, 1.1);
  lights.push(anchor(x1 - 1.2, y + 2.1, s.cz + 2.6, 0x8fb6ff, 2.6, 5.5, 1));
  signBox(b, x0 + 0.24, y + 2.2, s.cz + 1.5, Math.PI * 0.5, 1.8, 0.7, Glow.neonPink, 4.5);
  lights.push(anchor(x0 + 1.0, y + 2.2, s.cz + 1.5, 0xff2f8e, 3.4, 6.5, 2));
  b.cyl(x0 + 0.3, y + 1.7, s.cz - 2.6, 0.3, 0.3, 0.06, 14, { color: lin(0x1d3a24), mr: [0, 0.9] });
  b.cyl(x0 + 0.28, y + 1.7, s.cz - 2.6, 0.1, 0.1, 0.02, 10, { color: lin(0xc23a3a), mr: [0, 0.9] });
  // Jukebox in the corner, humming.
  b.box(x1 - 0.9, y + 0.75, z0 + 1.4, 0.9, 1.5, 0.6, -0.3, Mat.woodWarm);
  b.box(x1 - 1.1, y + 1.15, z0 + 1.25, 0.6, 0.5, 0.06, -0.3, glowOpts(Glow.magenta, 3.0));
  lights.push(anchor(x1 - 1.4, y + 1.2, z0 + 1.9, 0xc04ad0, 2.8, 5.5, 1));
  // A builders' banner nailed over the bar.
  b.box(s.cx - 0.7, y + 2.62, z0 + 0.22, 3.2, 0.44, 0.03, 0, glowOpts(Glow.purple, 0.9));
  cableRun(b, x0 + 0.5, s.ceilingY - 0.25, z1 - 0.4, x1 - 0.5, s.ceilingY - 0.35, z1 - 0.4,
    0.012, 0.25, 4, Mat.darkSteel);
  return lights;
}

/* ------------------------------------------------------------------ */
/* Scara Blocului 12                                                   */
/* ------------------------------------------------------------------ */

export function fitBlockHall(b: DetailBuilder, s: ShellSpec, rng: Rng): LightAnchor[] {
  const { hx, hz } = innerHalf(s);
  const x0 = s.cx - hx;
  const x1 = s.cx + hx;
  const z0 = s.cz - hz;
  const z1 = s.cz + hz;
  const y = s.floorY;
  const lights: LightAnchor[] = [];

  drawShellRoom(b, s, Finish.hall, { glazed: ['north'] });

  // Mozaic floor and the oil-paint dado every Romanian stairwell has.
  b.box(s.cx, y + 0.012, s.cz, hx * 2 - 0.2, 0.024, hz * 2 - 0.2, 0,
    { color: lin(0x746e64), mr: [0.08, 0.5] });
  for (const [wx, wz, sx, sz] of [
    [s.cx, z0 + 0.1, hx * 2 - 0.2, 0.06],
    [s.cx, z1 - 0.1, hx * 2 - 0.2, 0.06],
    [x0 + 0.1, s.cz, 0.06, hz * 2 - 0.2],
    [x1 - 0.1, s.cz, 0.06, hz * 2 - 0.2],
  ] as Array<[number, number, number, number]>) {
    b.box(wx, y + 0.75, wz, sx, 1.5, sz, 0, { color: lin(0x3f5f52), mr: [0.05, 0.55] });
    b.box(wx, y + 1.52, wz, sx, 0.04, sz + 0.02, 0, { color: lin(0x2a3f38), mr: [0, 0.7] });
  }

  // Letterboxes, the lift, and the stair up.
  letterboxWall(b, x0 + 0.16, y + 1.45, s.cz + 1.2, -Math.PI * 0.5, 5, 4, rng);
  liftDoors(b, s.cx + 1.6, y, z0 + 0.14, 0, 1.1, 2.15);
  // A light over the lift, or brushed steel doors in a dark hall are a hole in
  // the wall rather than the thing you walk towards.
  b.box(s.cx + 1.6, y + 2.5, z0 + 0.5, 0.6, 0.14, 0.22, 0, Mat.alu);
  b.box(s.cx + 1.6, y + 2.43, z0 + 0.5, 0.5, 0.03, 0.16, 0, glowOpts(Glow.tungsten, 4.5));
  lights.push(anchor(s.cx + 1.6, y + 2.3, z0 + 1.0, 0xffc078, 4.0, 6, 2));
  stairFlight(b, x1 - 1.6, s.cz - 2.6, 0, 8, 0.18, 0.28, 1.6, y);
  // The half-landing the stair disappears into.
  b.box(x1 - 1.6, y + 1.5, s.cz + 0.4, 1.8, 0.2, 1.4, 0, { color: lin(0x6a6560), mr: [0, 0.9] });
  b.box(x1 - 0.7, y + 2.2, s.cz + 0.4, 0.06, 1.2, 1.4, 0, { color: lin(0x2a2620), mr: [0, 0.95] });

  // Bicycle chained to the rail, a radiator, a notice board, a pushchair.
  const bx = x0 + 1.6;
  const bz = z0 + 1.4;
  for (const dz of [-0.52, 0.52]) {
    b.cyl(bx, y + 0.34, bz + dz, 0.33, 0.33, 0.035, 14, { color: lin(0x24222a), mr: [0.2, 0.7] });
  }
  b.tube(bx, y + 0.62, bz - 0.5, bx, y + 0.34, bz + 0.5, 0.02, 5, { color: lin(0x6d2a2a), mr: [0.5, 0.4] });
  b.tube(bx, y + 0.62, bz - 0.5, bx, y + 0.3, bz - 0.1, 0.018, 5, { color: lin(0x6d2a2a), mr: [0.5, 0.4] });
  b.box(bx, y + 0.9, bz - 0.5, 0.44, 0.03, 0.03, 0, Mat.darkSteel);
  b.box(x0 + 0.4, y + 0.35, s.cz - 3.2, 0.14, 0.6, 1.2, 0, { color: lin(0x9a958a), mr: [0.3, 0.6] });
  b.box(s.cx - 2.6, y + 1.7, z0 + 0.16, 1.2, 0.9, 0.06, 0, Mat.woodPale);
  for (let i = 0; i < 6; i++) {
    b.box(s.cx - 3.0 + (i % 3) * 0.36, y + 1.85 - Math.floor(i / 3) * 0.3, z0 + 0.12,
      0.24, 0.2, 0.005, rng.range(-0.06, 0.06), Mat.paperWhite);
  }
  litterPapers(b, x0 + 2.0, s.cz + 2.4, 1.2, 1.0, y + 0.03, 6, rng);

  // One batten with a dying tube, which is the whole mood of the room.
  lights.push(battenLight(b, s.cx, s.ceilingY - 0.12, s.cz, 1.2, 0, Glow.fluorescent, 3.4));
  b.box(s.cx + 2.4, s.ceilingY - 0.12, s.cz + 2.6, 0.9, 0.06, 0.1, 0, Mat.alu);
  cableRun(b, s.cx, s.ceilingY - 0.1, s.cz, s.cx + 2.4, s.ceilingY - 0.1, s.cz + 2.6,
    0.01, 0.06, 3, Mat.darkSteel);
  lights.push(anchor(s.cx, y + 1.4, s.cz + hz - 1.2, 0xff8a5a, 1.2, 6, 1));

  return lights;
}
