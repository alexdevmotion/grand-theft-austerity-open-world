/**
 * THE BROADCAST STUDIO — Act III's hijack.
 *
 * One volume, three zones, which is how a real television studio is arranged
 * and also how the mission reads:
 *
 *   STAGE      cyclorama, trough lights, the national-address desk with
 *              Georgescu's set dressing, three pedestal cameras on tally.
 *   GRID       a lighting truss at 6.2 m carrying fresnels and a cold key —
 *              the only thing in the game that lights a room from above with
 *              hard edges, and the reason the studio does not read as an
 *              office with a desk in it.
 *   GALLERY    a raised control room behind glass: multiview wall, vision
 *              mixer, fader bank, and THE TAKEOVER CONSOLE at its foot, which
 *              is the object Act III is about.
 *
 * `state` flips the whole room between the regime's broadcast and the
 * builders' — every screen, the backdrop, the tally lights and the gallery
 * fill. It is driven by the `broadcast:hijacked` event.
 *
 * OWNER: interiors agent.
 */

import type { Rng } from '../../core/rng';
import type { DetailBuilder } from '../city/builders';
import { srgb } from '../../render/materials';
import {
  Glow, Mat, anchor, cableRun, controlDesk, figure, flightCase, glowOpts,
  monitor, monitorWall, officeChair, stairFlight, studioCamera, studioLight,
  tricolour, truss, signBox, type LightAnchor,
} from './kit';
import { Finish, drawShellRoom, innerHalf, type ShellSpec } from './shell';

const lin = srgb;

export type StudioState = 'regime' | 'hijacked';

export function fitStudio(
  b: DetailBuilder, s: ShellSpec, rng: Rng, state: StudioState = 'regime',
): LightAnchor[] {
  const { hx, hz } = innerHalf(s);
  const x0 = s.cx - hx;
  const x1 = s.cx + hx;
  const z0 = s.cz - hz;
  const z1 = s.cz + hz;
  const y = s.floorY;
  const lights: LightAnchor[] = [];
  const taken = state === 'hijacked';
  const key = taken ? Glow.purple : Glow.tungsten;

  drawShellRoom(b, s, Finish.studio);

  /* ---- studio floor: painted, matte, marked up with camera positions ---- */
  b.box(s.cx, y + 0.012, s.cz, hx * 2 - 0.4, 0.024, hz * 2 - 0.4, 0, { color: lin(0x27242f), mr: [0.02, 0.72] });
  for (let i = 0; i < 5; i++) {
    b.box(x0 + 9 + i * 5.5, y + 0.026, s.cz + 2, 0.5, 0.004, 0.06, 0, { color: lin(0xd8d0b8), mr: [0, 0.9] });
    b.box(x0 + 9 + i * 5.5, y + 0.026, s.cz + 2, 0.06, 0.004, 0.5, 0, { color: lin(0xd8d0b8), mr: [0, 0.9] });
  }

  /* ---- acoustic treatment on the long walls ---- */
  for (let i = 0; i < 14; i++) {
    const px = x0 + 1.6 + i * 3.0;
    if (px > x1 - 1.6) break;
    for (const wz of [z0 + 0.2, z1 - 0.2]) {
      b.box(px, y + 3.2, wz, 2.6, 4.4, 0.16, 0, { color: lin(0x2b2731), mr: [0, 0.98] });
      b.box(px, y + 3.2, wz + (wz < s.cz ? 0.09 : -0.09), 2.5, 4.3, 0.05, 0, { color: lin(0x1e1b25), mr: [0, 0.99] });
    }
  }

  /* ---- cyclorama: a coved white wall washed from a floor trough ---- */
  const cycX = x0 + 0.5;
  for (let i = 0; i < 9; i++) {
    const cz2 = s.cz - 8 + i * 2;
    // The cyc carries a little emissive of its own: it is the surface the
    // trough lights exist to make glow, and six shared point lights cannot be
    // spent on a wall.
    b.box(cycX + 0.2, y + 3.0, cz2, 0.5, 6.0, 2.02, 0, {
      color: lin(0x9c98a6), mr: [0, 0.97],
      emissive: taken ? [0.10, 0.03, 0.16] : [0.13, 0.07, 0.05],
    });
  }
  // The cove itself, and the trough lights standing in it.
  b.box(cycX + 0.9, y + 0.35, s.cz, 1.6, 0.7, 18.2, 0, { color: lin(0x8e8a98), mr: [0, 0.97] });
  for (let i = 0; i < 7; i++) {
    const cz2 = s.cz - 7.5 + i * 2.5;
    b.box(cycX + 1.9, y + 0.22, cz2, 0.34, 0.3, 1.1, 0, Mat.darkSteel);
    b.box(cycX + 1.72, y + 0.24, cz2, 0.03, 0.24, 1.0, 0, glowOpts(taken ? Glow.magenta : Glow.amber, 5.5));
  }
  lights.push(anchor(cycX + 2.4, y + 1.4, s.cz - 4, taken ? 0xc04ad0 : 0xffa030, 9, 16, 2));
  lights.push(anchor(cycX + 2.4, y + 1.4, s.cz + 4, taken ? 0xc04ad0 : 0xffa030, 9, 16, 2));

  /*
   * THE SET — national-address desk, crest, backdrop screen.
   *
   * IT FACES EAST, down the length of the room, because that is where the
   * cameras, the gallery and the door are. Built facing south (the first
   * pass), the presenter had his back to every camera in the room and the
   * backdrop — the single most expensive object in the studio — was only
   * visible from inside the cyclorama.
   */
  const setX = x0 + 7.5;
  const setZ = s.cz;
  // Riser.
  b.box(setX, y + 0.1, setZ, 7.0, 0.2, 8.0, 0, { color: lin(0x241f2c), mr: [0, 0.9] });
  // Desk: a heavy curved-fronted lectern-desk in state blue.
  b.box(setX, y + 0.58, setZ, 1.15, 0.76, 3.6, 0, { color: lin(0x1b2c52), mr: [0, 0.6] });
  b.box(setX, y + 0.99, setZ, 1.35, 0.07, 3.9, 0, { color: lin(0x2a3a63), mr: [0.1, 0.45] });
  b.box(setX + 0.62, y + 0.62, setZ, 0.06, 0.62, 3.2, 0, glowOpts(taken ? Glow.purple : Glow.screen, 1.1));
  // The crest on the desk front: a shield with a wreath, at readable scale.
  b.box(setX + 0.66, y + 0.62, setZ, 0.05, 0.5, 0.7, 0, glowOpts(taken ? Glow.magenta : Glow.amber, 1.6));
  b.box(setX + 0.69, y + 0.62, setZ, 0.03, 0.3, 0.3, 0, { color: lin(0x1b2c52), mr: [0, 0.6] });
  // Two chairs behind it, one always empty.
  officeChair(b, setX - 0.9, setZ - 0.8, Math.PI * 0.5, y + 0.2, { color: lin(0x27324f), mr: [0, 0.9] });
  officeChair(b, setX - 0.9, setZ + 0.8, Math.PI * 0.5, y + 0.2, { color: lin(0x27324f), mr: [0, 0.9] });
  if (!taken) {
    figure(b, setX - 0.85, y + 0.26, setZ - 0.8, Math.PI * 0.5, { color: lin(0x1c2338), mr: [0, 0.9] }, rng, true);
  }
  // Backdrop, standing against the cyclorama behind the presenter.
  const backX = setX - 3.2;
  b.box(backX, y + 3.0, setZ, 0.2, 3.4, 7.0, 0, Mat.darkSteel);
  b.box(backX + 0.12, y + 3.0, setZ, 0.04, 3.1, 6.7, 0,
    glowOpts(taken ? Glow.purple : Glow.screenWarm, taken ? 1.6 : 0.9));
  if (taken) {
    // The builders' mark takes the wall.
    b.box(backX + 0.18, y + 3.0, setZ, 0.03, 2.4, 2.4, 0, glowOpts(Glow.magenta, 2.6));
    b.box(backX + 0.21, y + 3.0, setZ, 0.03, 1.3, 1.3, 0, glowOpts(Glow.purple, 3.0));
  } else {
    tricolour(b, backX + 0.18, y + 1.9, setZ, Math.PI * 0.5, 4.2, 0.7, 1.1);
    // A vast head-and-shoulders — Georgescu, addressing the nation.
    b.box(backX + 0.18, y + 3.5, setZ, 0.03, 1.7, 1.5, 0, glowOpts(lin(0xd9b79b), 1.0));
    b.box(backX + 0.2, y + 4.35, setZ, 0.03, 0.5, 1.6, 0, glowOpts(lin(0x2f2730), 0.5));
  }
  lights.push(anchor(setX - 2.2, y + 2.2, setZ, taken ? 0x7b3fd4 : 0xffd9a0, 14, 16, 4));
  // Autocue-fed floor monitor at the front of the riser.
  monitor(b, setX + 2.6, y + 0.6, setZ, -Math.PI * 0.5, 1.0, 0.6, taken ? 'grid' : 'broadcast', rng, 1.2);

  /* ---- lighting grid ---- */
  const gridY = y + 6.2;
  for (let i = 0; i < 6; i++) {
    const gz = s.cz - 9 + i * 3.6;
    truss(b, x0 + 1.2, gz, x1 - 12.0, gz, gridY, 0.36);
  }
  truss(b, x0 + 2.2, s.cz - 9.5, x0 + 2.2, s.cz + 9.5, gridY + 0.5, 0.36);
  truss(b, x1 - 13.0, s.cz - 9.5, x1 - 13.0, s.cz + 9.5, gridY + 0.5, 0.36);
  // Hoist wires up to the structure.
  for (let i = 0; i < 8; i++) {
    const gx = x0 + 2.5 + i * 2.4;
    for (const gz of [s.cz - 9.5, s.cz + 9.5]) {
      b.tube(gx, gridY + 0.86, gz, gx, s.ceilingY - 0.1, gz, 0.008, 4, Mat.darkSteel);
    }
  }
  // Fixtures: warm key over the set, cold fill over the floor.
  const rig: Array<[number, number, boolean]> = [
    [setX - 2.5, setZ - 3.0, false], [setX + 2.0, setZ - 3.0, false],
    [setX - 1.0, setZ + 4.5, true], [setX + 3.5, setZ + 1.0, true],
    [s.cx - 1, s.cz - 6.5, false], [s.cx + 2, s.cz + 6.0, true],
    [s.cx + 5, s.cz - 2.0, false],
  ];
  for (const [lx, lz, cold] of rig) {
    const a = studioLight(b, lx, gridY, lz, Math.atan2(setX - lx, setZ - lz),
      cold ? Glow.cold : key, cold ? 6.5 : 9.0, cold ? 22 : 30);
    lights.push(a);
  }
  // Practical: a working light on a wall bracket, so the room is never black.
  b.box(x1 - 1.2, y + 4.4, s.cz - 6, 0.5, 0.3, 0.3, 0, Mat.darkSteel);
  b.box(x1 - 1.45, y + 4.4, s.cz - 6, 0.05, 0.2, 0.24, 0, glowOpts(Glow.fluorescent, 4));
  lights.push(anchor(x1 - 2, y + 4.2, s.cz - 6, 0xd8e6ff, 9, 18, 1));

  /* ---- cameras ---- */
  const aim = (cx2: number, cz2: number): number => Math.atan2(setX - cx2, setZ - cz2);
  studioCamera(b, setX + 7.5, setZ - 3.4, aim(setX + 7.5, setZ - 3.4), y, true);
  studioCamera(b, setX + 9.5, setZ + 2.0, aim(setX + 9.5, setZ + 2.0), y, false);
  studioCamera(b, setX + 6.0, setZ + 5.5, aim(setX + 6.0, setZ + 5.5), y, false);
  // Cable snakes from each camera back to the gallery wall.
  cableRun(b, setX + 7.5, y + 0.06, setZ - 3.4, s.cx + 6, y + 0.06, z0 + 2.0, 0.03, 0.0, 4);
  cableRun(b, setX + 9.5, y + 0.06, setZ + 2.0, s.cx + 6, y + 0.06, z0 + 2.0, 0.03, 0.0, 4);

  /* ---- the gallery: raised, glazed, looking onto the stage ---- */
  const galZ0 = z0 + 0.2;
  const galZ1 = z0 + 6.4;
  const galY = y + 1.25;
  const galX0 = s.cx - 2.0;
  const galX1 = x1 - 0.6;
  const galCx = (galX0 + galX1) / 2;
  const galCz = (galZ0 + galZ1) / 2;
  // Platform.
  b.box(galCx, y + 0.62, galCz, galX1 - galX0, 1.25, galZ1 - galZ0, 0, { color: lin(0x25222b), mr: [0, 0.9] });
  b.box(galCx, galY + 0.02, galCz, galX1 - galX0, 0.05, galZ1 - galZ0, 0, { color: lin(0x322d3a), mr: [0, 0.8] });
  // Steps up at the west end.
  stairFlight(b, galX0 - 0.9, galZ1 - 1.2, Math.PI, 6, 0.21, 0.3, 1.4, y);
  // Glazed screen along the front of the gallery, with a mullion every 2 m.
  for (let gx = galX0; gx <= galX1 - 0.1; gx += 2.0) {
    b.box(gx, galY + 1.1, galZ1, 0.09, 2.2, 0.12, 0, Mat.alu);
  }
  b.box(galCx, galY + 1.1, galZ1, galX1 - galX0, 2.2, 0.03, 0, {
    color: lin(0x0e1526), mr: [0.9, 0.06], emissive: [0.02, 0.024, 0.05],
  });
  b.box(galCx, galY + 0.5, galZ1, galX1 - galX0, 1.0, 0.1, 0, Mat.darkSteel);

  // Multiview wall on the back wall of the gallery.
  monitorWall(b, galCx + 1.5, galY + 2.0, galZ0 + 0.22, 0, 5, 3, 0.86, 0.56, rng);
  lights.push(anchor(galCx + 1.5, galY + 1.7, galZ0 + 1.6, taken ? 0x9b6cff : 0x8fb6ff, 6.0, 8, 3));
  // Two desks: vision mixer and sound.
  controlDesk(b, galCx + 1.2, galY + 0.78, galCz + 0.4, 0, 3.6, rng);
  controlDesk(b, galCx - 3.6, galY + 0.78, galCz + 0.4, 0, 2.2, rng);
  officeChair(b, galCx + 1.2, galCz + 1.5, 0, galY);
  officeChair(b, galCx - 3.6, galCz + 1.5, 0, galY);
  if (!taken) {
    figure(b, galCx + 1.2, galY + 0.06, galCz + 1.45, Math.PI, { color: lin(0x232833), mr: [0, 0.9] }, rng, true);
  }
  // Rack bay: patch panels and blinking gear.
  for (let i = 0; i < 3; i++) {
    const rx = galX1 - 1.2 - i * 0.72;
    b.box(rx, galY + 0.95, galZ0 + 0.5, 0.66, 1.9, 0.7, 0, Mat.darkSteel);
    for (let j = 0; j < 8; j++) {
      b.box(rx, galY + 0.3 + j * 0.2, galZ0 + 0.16, 0.6, 0.16, 0.05, 0, Mat.plasticBlack);
      for (let k = 0; k < 4; k++) {
        b.box(rx - 0.22 + k * 0.14, galY + 0.3 + j * 0.2, galZ0 + 0.13, 0.03, 0.03, 0.02, 0,
          glowOpts(rng.bool(0.4) ? Glow.green : Glow.amber, 3.0));
      }
    }
  }

  /* ---- THE TAKEOVER CONSOLE, at the foot of the gallery ---- */
  const tc = takeoverConsole(s);
  b.box(tc.x, y + 0.5, tc.z, 1.5, 1.0, 0.8, 0, { color: lin(0x2b2732), mr: [0.2, 0.6] });
  b.box(tc.x, y + 1.02, tc.z, 1.6, 0.08, 0.9, 0, Mat.darkSteel);
  b.box(tc.x, y + 1.12, tc.z + 0.1, 1.3, 0.12, 0.5, 0, Mat.plasticBlack);
  for (let i = 0; i < 6; i++) {
    b.box(tc.x - 0.5 + i * 0.2, y + 1.19, tc.z + 0.02, 0.12, 0.03, 0.12, 0,
      glowOpts(taken ? Glow.purple : Glow.red, 3.4));
  }
  monitor(b, tc.x, y + 1.62, tc.z + 0.3, Math.PI, 0.66, 0.4, taken ? 'grid' : 'broadcast', rng, 1.4);
  // The lever you pull, in builder purple, on a red-and-white guard plate.
  b.box(tc.x + 0.58, y + 1.14, tc.z - 0.1, 0.26, 0.06, 0.3, 0, { color: lin(0xd9333a), mr: [0, 0.5] });
  b.cyl(tc.x + 0.58, y + 1.16, tc.z - 0.1, 0.035, 0.03, 0.34, 6, Mat.alu, false);
  b.box(tc.x + 0.58, y + 1.53, tc.z - 0.1, 0.09, 0.09, 0.09, 0, glowOpts(Glow.magenta, 4.5));
  lights.push(anchor(tc.x, y + 1.6, tc.z - 0.4, taken ? 0xc04ad0 : 0xff3a40, 3.4, 6, 2));
  signBox(b, tc.x, y + 2.35, tc.z + 0.5, Math.PI, 1.4, 0.34, taken ? Glow.magenta : Glow.red, 3.0);

  /* ---- floor kit: cases, sandbags, a fan, a spare stand ---- */
  flightCase(b, x1 - 3.0, y, s.cz + 8.5, 0.4, 1.0, 0.6, 0.62);
  flightCase(b, x1 - 3.0, y + 0.6, s.cz + 8.5, 0.4, 1.0, 0.45, 0.62);
  flightCase(b, x1 - 5.0, y, s.cz + 9.2, -0.3, 0.8, 0.55, 0.55);
  for (let i = 0; i < 6; i++) {
    b.box(x0 + 3 + rng.range(0, 16), y + 0.09, s.cz + rng.range(-9, 9), 0.4, 0.18, 0.3,
      rng.range(0, 3), { color: lin(0x2a2620), mr: [0, 0.96] });
  }
  b.cyl(x1 - 6.5, y, s.cz - 8.5, 0.28, 0.24, 0.9, 8, Mat.darkSteel, false);
  b.box(x1 - 6.5, y + 1.05, s.cz - 8.5, 0.5, 0.5, 0.16, 0.3, Mat.darkSteel);

  /* ---- entrance vestibule by the door, with the station's crest ---- */
  b.box(x1 - 5.6, y + 1.4, z1 - 0.14, 3.0, 2.2, 0.08, 0, { color: lin(0x1d1a24), mr: [0, 0.95] });
  signBox(b, x1 - 5.6, y + 2.2, z1 - 0.2, 0, 2.4, 0.5, taken ? Glow.purple : Glow.amber, 2.4);
  b.box(x1 - 9.5, y + 0.5, z1 - 1.2, 1.6, 1.0, 0.6, 0, { color: lin(0x2f2a38), mr: [0, 0.7] });
  b.box(x1 - 9.5, y + 1.03, z1 - 1.2, 1.75, 0.06, 0.72, 0, Mat.laminate);
  // A rope line, because there is always a rope line.
  for (const px of [x1 - 7.4, x1 - 10.4]) {
    b.cyl(px, y, z1 - 3.0, 0.16, 0.1, 0.95, 8, { color: lin(0x8a6a2a), mr: [0.8, 0.32] });
    b.box(px, y + 1.0, z1 - 3.0, 0.12, 0.1, 0.12, 0, { color: lin(0x8a6a2a), mr: [0.8, 0.32] });
  }
  cableRun(b, x1 - 7.4, y + 0.9, z1 - 3.0, x1 - 10.4, y + 0.9, z1 - 3.0, 0.02, 0.14, 3,
    { color: lin(0x6d1f2a), mr: [0, 0.9] });

  return lights;
}

/** Where the console stands — exported so the story can aim an interaction. */
export function takeoverConsole(s: ShellSpec): { x: number; z: number } {
  const { hz } = innerHalf(s);
  return { x: s.cx + 2.0, z: s.cz - hz + 7.8 };
}
