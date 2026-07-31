/**
 * THE BUILDERS HOUSE LOBBY — the room Act IV ends in.
 *
 * `docs/STORY.md`: "The ground-floor lobby starts dark and neglected — broken
 * furniture, scattered papers, closure signage, builders waiting in silence.
 * The same room becomes the afterparty after liberation."
 *
 * So this is ONE room built in two states. Everything structural — the floor,
 * the columns, the mezzanine soffit, the lift core, the reception counter — is
 * shared; the difference is what is lying on it, whether the fittings are
 * energised, and what colour the room is. `sealed` is a violet-dark space with
 * one work light and a Ministry seal on the lift; `liberated` is warm pendants,
 * a tricolour, string lights, a PA stack on the reception desk and confetti.
 *
 * The reception counter stands at `LOBBY_RECEPTION`, which is where the
 * campaign's final interaction is — walk in through the real door, cross the
 * room, and take the house back.
 *
 * OWNER: interiors agent.
 */

import type { Rng } from '../../core/rng';
import type { DetailBuilder } from '../city/builders';
import { srgb } from '../../render/materials';
import { LOBBY_RECEPTION } from '../../content/places';
import {
  Glow, Mat, anchor, cabinet, cableRun, glowOpts, letterboxWall, liftDoors,
  litterPapers, lowTable, monitor, pendant, signBox, sofa, stairFlight,
  tricolour, type LightAnchor,
} from './kit';
import { Finish, drawShellRoom, innerHalf, lightPool, type ShellSpec } from './shell';

const lin = srgb;

export type LobbyState = 'sealed' | 'liberated';

/** `Finish.lobby` with the lights back on — see `fitLobby`. */
const LOBBY_LIT = {
  wall: [0x4e4759, 0.9],
  floor: [0x453e50, 0.5],
  ceiling: [0x3d3749, 0.94],
  skirting: 0x2a2434,
  frame: 0xa9b1ba,
  glassTint: 0x2a1c46,
  glassWarm: 0xff7a4a,
  glassGain: 0.9,
} as const;

export function fitLobby(
  b: DetailBuilder, s: ShellSpec, rng: Rng, state: LobbyState = 'sealed',
): LightAnchor[] {
  const free = state === 'liberated';
  const { hx, hz } = innerHalf(s);
  const x0 = s.cx - hx;
  const x1 = s.cx + hx;
  const z0 = s.cz - hz;
  const z1 = s.cz + hz;
  const y = s.floorY;
  const h = s.ceilingY;
  const lights: LightAnchor[] = [];

  /*
   * The shell is repainted for the party. Not a gimmick: the sealed finish is
   * a near-black violet, correct for a condemned hall lit by two work lamps
   * and hopeless once nine pendants and a string of festoons are running —
   * the fittings came on and the room they were in stayed the colour of a
   * power cut. A lighter wall and ceiling is what "the lights are back" looks
   * like from the far end of a 28 m room.
   */
  drawShellRoom(b, s, free ? LOBBY_LIT : Finish.lobby, { glazed: ['south'] });

  /* ---- terrazzo floor with a brass inlay grid ---- */
  b.box(s.cx, y + 0.012, s.cz, hx * 2 - 0.3, 0.024, hz * 2 - 0.3, 0,
    { color: lin(free ? 0x46404f : 0x332e3b), mr: [0.06, 0.42] });
  for (let i = -2; i <= 2; i++) {
    b.box(s.cx + i * 5.4, y + 0.026, s.cz, 0.05, 0.004, hz * 2 - 0.6, 0,
      { color: lin(0x8a6a2a), mr: [0.85, 0.3] });
  }
  for (let j = -1; j <= 1; j++) {
    b.box(s.cx, y + 0.026, s.cz + j * 6.2, hx * 2 - 0.6, 0.004, 0.05, 0,
      { color: lin(0x8a6a2a), mr: [0.85, 0.3] });
  }

  /* ---- structure: four columns and the mezzanine soffit ---- */
  for (const cx2 of [s.cx - 7.6, s.cx + 7.6]) {
    for (const cz2 of [s.cz - 4.4, s.cz + 4.4]) {
      b.box(cx2, y + h / 2, cz2, 0.62, h, 0.62, 0, { color: lin(0x3b3644), mr: [0, 0.92] });
      // Brushed collar at head and foot: a bare column reads as a mistake.
      b.box(cx2, y + 0.12, cz2, 0.76, 0.24, 0.76, 0, Mat.alu);
      b.box(cx2, y + h - 0.16, cz2, 0.76, 0.32, 0.76, 0, Mat.alu);
      // Caged bulkhead at head height: the light that is on in a building
      // nobody is allowed into, and the thing that gives the columns an edge.
      b.box(cx2 - 0.36, y + 2.5, cz2, 0.1, 0.26, 0.3, 0, Mat.darkSteel);
      b.box(cx2 - 0.42, y + 2.5, cz2, 0.04, 0.18, 0.22, 0,
        glowOpts(free ? Glow.tungsten : Glow.purple, free ? 5 : 3.2));
      lights.push(anchor(cx2 - 0.7, y + 2.5, cz2,
        free ? 0xffc078 : 0x8a5ad8, free ? 2.6 : 1.9, 9, 1));
    }
  }
  // Mezzanine gallery over the north third, with a glazed balustrade.
  const mezZ = z1 - 3.6;
  b.box(s.cx, y + 4.5, (mezZ + z1) / 2, hx * 2 - 0.4, 0.36, z1 - mezZ, 0,
    { color: lin(0x312c3a), mr: [0, 0.9] });
  // Balustrade glass, deliberately not a mirror — see `glassPanel` in shell.ts.
  b.box(s.cx, y + 5.28, mezZ + 0.06, hx * 2 - 0.4, 1.2, 0.06, 0,
    { color: lin(0x0f1526), mr: [0.35, 0.2], emissive: [0.014, 0.016, 0.032] });
  b.box(s.cx, y + 5.92, mezZ + 0.06, hx * 2 - 0.4, 0.09, 0.14, 0, Mat.alu);
  // Stair up to it, against the east wall.
  stairFlight(b, x1 - 2.2, s.cz - 3.0, 0, 14, 0.3, 0.3, 1.5, y);

  /* ---- lift core on the north wall ---- */
  liftDoors(b, s.cx - 3.4, y, z1 - 0.2, Math.PI, 1.2, 2.3);
  liftDoors(b, s.cx - 0.6, y, z1 - 0.2, Math.PI, 1.2, 2.3);
  letterboxWall(b, s.cx + 4.6, y + 1.5, z1 - 0.18, Math.PI, 6, 4, rng);

  /* ---- reception counter, where the house is taken back ---- */
  const rx = LOBBY_RECEPTION.x;
  const rz = LOBBY_RECEPTION.z;
  b.box(rx, y + 0.55, rz, 5.4, 1.1, 0.9, 0, { color: lin(0x2f2a38), mr: [0, 0.62] });
  b.box(rx, y + 1.13, rz, 5.7, 0.07, 1.1, 0, { color: lin(0xcfc6b4), mr: [0.05, 0.42] });
  b.box(rx, y + 0.52, rz - 0.48, 5.0, 0.9, 0.05, 0,
    free ? glowOpts(Glow.magenta, 1.6) : { color: lin(0x241f2c), mr: [0, 0.85] });
  monitor(b, rx - 1.6, y + 1.45, rz + 0.1, Math.PI, 0.5, 0.32, free ? 'grid' : 'off', rng, 0.8);
  monitor(b, rx + 1.6, y + 1.45, rz + 0.1, Math.PI, 0.5, 0.32, 'off', rng);

  /* ---- the house's own sign, over the lift core ---- */
  signBox(b, s.cx + 1.0, y + 6.9, z1 - 0.24, Math.PI, 7.0, 1.1,
    free ? Glow.magenta : lin(0x3a3446), free ? 3.2 : 0.12);
  b.box(s.cx - 2.6, y + 6.9, z1 - 0.34, 0.9, 0.9, 0.06, 0,
    free ? glowOpts(Glow.purple, 3.4) : { color: lin(0x2e2937), mr: [0, 0.8] });

  /* ---- the emergency sign over the door, lit in every state ---- */
  b.box(s.cx, y + s.door.height + 0.55, z0 + 0.4, 0.9, 0.28, 0.08, 0, Mat.darkSteel);
  b.box(s.cx, y + s.door.height + 0.55, z0 + 0.36, 0.8, 0.2, 0.02, 0, glowOpts(Glow.green, 4.0));
  lights.push(anchor(s.cx, y + s.door.height + 0.3, z0 + 1.0, 0x36d17a, 1.1, 6, 1));

  /* ---- seating bay by the west wall ---- */
  sofa(b, x0 + 2.4, s.cz - 2.0, Math.PI * 0.5, 2.2, free ? Mat.fabricPurple : Mat.fabricGrey, y);
  sofa(b, x0 + 2.4, s.cz + 1.6, Math.PI * 0.5, 2.2, free ? Mat.fabricPurple : Mat.fabricGrey, y);
  lowTable(b, x0 + 4.1, s.cz - 0.2, 0, 1.1, 0.7, 0.42, Mat.woodDark);
  cabinet(b, x0 + 1.2, s.cz + 5.4, Math.PI * 0.5, 1.4, 1.0, 0.5, Mat.darkSteel);

  if (!free) {
    /* ================= SEALED — closed down, waiting ================= */

    // Dust sheets over both sofas and the low table.
    for (const sz of [s.cz - 2.0, s.cz + 1.6]) {
      b.box(x0 + 2.5, y + 0.62, sz, 1.15, 1.0, 2.5, 0, { color: lin(0x9a94a2), mr: [0, 0.98] });
    }
    b.box(x0 + 4.1, y + 0.48, s.cz - 0.2, 1.3, 0.14, 0.9, 0.1, { color: lin(0x9a94a2), mr: [0, 0.98] });

    // Chairs, overturned and stacked, and packing boxes.
    for (let i = 0; i < 7; i++) {
      const px = s.cx + rng.range(-9, 9);
      const pz = s.cz + rng.range(-7, 5);
      const roll = rng.next();
      if (roll < 0.5) {
        // On its side.
        b.box(px, y + 0.24, pz, 0.5, 0.48, 0.06, rng.range(0, 3), Mat.woodDark);
        b.box(px + 0.2, y + 0.1, pz + 0.15, 0.46, 0.2, 0.46, rng.range(0, 3), Mat.woodDark);
      } else {
        // Stacked.
        for (let k = 0; k < 3; k++) {
          b.box(px, y + 0.42 + k * 0.09, pz, 0.46, 0.06, 0.46, 0.2 * k, Mat.woodDark);
          b.box(px, y + 0.2 + k * 0.09, pz, 0.42, 0.36, 0.05, 0.2 * k, Mat.woodDark);
        }
      }
    }
    for (let i = 0; i < 6; i++) {
      const px = s.cx + rng.range(-10, 10);
      const pz = s.cz + rng.range(-8, 6);
      b.box(px, y + 0.22, pz, 0.6, 0.44, 0.45, rng.range(0, 3), { color: lin(0x8a6b45), mr: [0, 0.95] });
      b.box(px, y + 0.45, pz, 0.62, 0.02, 0.47, rng.range(0, 3), { color: lin(0xb08a5a), mr: [0, 0.95] });
    }
    litterPapers(b, s.cx, s.cz, hx - 1.5, hz - 1.5, y + 0.03, 34, rng);

    // MINISTRY SEALS. Red tape crossed over the lift doors, notices on the
    // counter and beside the door, a printed A3 order taped to the glass.
    const seal = { color: lin(0xd9333a), mr: [0, 0.55] as [number, number] };
    for (const lx of [s.cx - 3.4, s.cx - 0.6]) {
      b.box(lx, y + 1.2, z1 - 0.42, 1.7, 0.1, 0.03, 0.62, seal);
      b.box(lx, y + 1.2, z1 - 0.42, 1.7, 0.1, 0.03, -0.62, seal);
    }
    b.box(s.cx + 1.7, y + 1.35, s.cz - hz + 0.2, 0.6, 0.85, 0.03, 0, { color: lin(0xe8e2d6), mr: [0, 0.9] });
    b.box(s.cx + 1.7, y + 1.62, s.cz - hz + 0.18, 0.5, 0.14, 0.02, 0, seal);
    b.box(rx + 2.9, y + 1.2, rz - 0.5, 0.42, 0.6, 0.02, 0.2, { color: lin(0xe8e2d6), mr: [0, 0.9] });

    // Hazard tape across the stair, and a barrier at its foot.
    for (const ty of [0.55, 1.05]) {
      b.box(x1 - 2.2, y + ty, s.cz - 3.4, 1.9, 0.09, 0.02, 0, seal);
      b.box(x1 - 2.2, y + ty + 0.09, s.cz - 3.4, 1.9, 0.09, 0.02, 0, { color: lin(0xe8e2d6), mr: [0, 0.7] });
    }

    // One work light on a tripod: the only thing energised in the room.
    const wx = s.cx + 5.5;
    const wz = s.cz - 5.0;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      b.tube(wx, y + 1.55, wz, wx + Math.sin(a) * 0.55, y, wz + Math.cos(a) * 0.55, 0.018, 4, Mat.darkSteel);
    }
    b.box(wx, y + 1.7, wz, 0.34, 0.3, 0.24, 0.5, Mat.darkSteel);
    b.box(wx, y + 1.7, wz - 0.13, 0.28, 0.24, 0.03, 0.5, glowOpts(Glow.purple, 4.5));
    cableRun(b, wx, y + 1.4, wz, wx + 3.2, y + 0.03, wz + 2.4, 0.016, 0.1, 3);
    lightPool(b, wx, y, wz, 3.4, 0x7b3fd4, 0.22);
    lights.push(anchor(wx, y + 1.7, wz - 0.4, 0x8a5ad8, 7.5, 18, 3));
    // A second stand across the room, and a hand lamp lying on the counter:
    // three sources is the minimum that gives a 28 m room any shape at all.
    const w2x = s.cx - 7.0;
    const w2z = s.cz + 1.5;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      b.tube(w2x, y + 1.45, w2z, w2x + Math.sin(a) * 0.5, y, w2z + Math.cos(a) * 0.5, 0.018, 4, Mat.darkSteel);
    }
    b.box(w2x, y + 1.6, w2z, 0.3, 0.26, 0.22, 2.2, Mat.darkSteel);
    b.box(w2x + 0.1, y + 1.6, w2z - 0.1, 0.24, 0.2, 0.03, 2.2, glowOpts(Glow.purple, 4.0));
    lightPool(b, w2x, y, w2z, 3.0, 0x7b3fd4, 0.2);
    lights.push(anchor(w2x, y + 1.6, w2z - 0.4, 0x8a5ad8, 6.0, 15, 3));
    b.box(rx - 1.9, y + 1.2, rz - 0.3, 0.16, 0.1, 0.24, 0.4, Mat.darkSteel);
    b.box(rx - 1.9, y + 1.2, rz - 0.44, 0.12, 0.08, 0.02, 0.4, glowOpts(Glow.tungsten, 5.0));
    lightPool(b, rx - 1.9, y, rz - 1.0, 1.8, 0xffc078, 0.24);
    lights.push(anchor(rx - 1.9, y + 1.2, rz - 0.7, 0xffc078, 2.6, 8, 2));
    // And the sunset leaking through the doorway, which is the only other light.
    lights.push(anchor(s.cx, y + 1.6, s.cz - hz + 1.6, 0xff8a5a, 2.2, 9, 2));

    // Dead pendants, hanging unlit.
    for (let i = 0; i < 5; i++) {
      const px = s.cx - 8 + i * 4;
      b.tube(px, h - 0.1, s.cz - 1.5, px, h - 2.6, s.cz - 1.5, 0.008, 4, Mat.darkSteel);
      b.cyl(px, h - 2.6, s.cz - 1.5, 0.02, 0.19, 0.18, 8, { color: lin(0x2a2630), mr: [0.3, 0.6] }, false);
    }
    return lights;
  }

  /* ================= LIBERATED — the afterparty ================= */

  /*
   * WHY THIS SECTION IS MOSTLY EMISSIVE AND FLOOR POOLS.
   *
   * `docs/STORY.md` promises "dancing builders, restored lights, Romanian folk
   * music and a slow interior camera pan". The music played and the room did
   * not: a playtester walked into the finale and photographed a black hall
   * with one visible person, some confetti and a glowing desk.
   *
   * The cause is arithmetic. This is a 28 x 22 m room and the whole game
   * shares SIX point lights (`LIGHT_POOL`, interiorSystem.ts) — a fixed count,
   * because a varying one re-links every shader in the scene. Six lights
   * cannot light a hall this size; standing at the door, every fitting over
   * the dance floor is out of range and the room reads as unlit.
   *
   * So the party is carried by things that cost no lights at all: a raised
   * ambient fill for this state (`STATE_FILL`), emissive fittings, and a pool
   * of light drawn on the floor under every one of them. The six real lights
   * are then spent on the few metres the player is actually standing in.
   */

  // The pendants come on — and each one lays a pool of light on the floor,
  // which is what makes a lit room read as lit from across the hall.
  for (let i = 0; i < 5; i++) {
    const px = s.cx - 8 + i * 4;
    lights.push(pendant(b, px, h - 0.1, s.cz - 1.5, 2.5, 0x2a2630, Glow.tungsten, 8));
    lightPool(b, px, y, s.cz - 1.5, 3.1, 0xffc078, 0.3);
  }
  // A second run of pendants over the north half, so the room is lit end to
  // end rather than along one line.
  for (let i = 0; i < 4; i++) {
    const px = s.cx - 6 + i * 4;
    lights.push(pendant(b, px, h - 0.1, s.cz + 5.0, 2.9, 0x2a2630, Glow.tungsten, 7));
    lightPool(b, px, y, s.cz + 5.0, 2.9, 0xffc078, 0.26);
  }

  /*
   * THE DANCE FLOOR: a lit chequer between the columns.
   *
   * The gains are small ON PURPOSE. The first pass ran at 0.5 and the floor
   * stopped being a floor — a 13 m slab of white light with the rest of the
   * room silhouetted against it. A dance floor has to be the brightest thing
   * at ANKLE height and nowhere near the brightest thing in the frame.
   */
  const dfx = s.cx;
  const dfz = s.cz - 1.6;
  for (let ix = -2; ix <= 2; ix++) {
    for (let iz = -2; iz <= 2; iz++) {
      const on = (ix + iz) % 2 === 0;
      const cx2 = dfx + ix * 1.72;
      const cz2 = dfz + iz * 1.72;
      b.box(cx2, y + 0.032, cz2, 1.6, 0.01, 1.6, 0, on
        ? glowOpts(Glow.magenta, 0.13)
        : glowOpts(Glow.purple, 0.075));
    }
  }
  lights.push(anchor(dfx, y + 0.9, dfz, 0xd45ad8, 4.2, 15, 3));

  /* ---- uplighters washing the four columns ---- */
  for (const cx2 of [s.cx - 7.6, s.cx + 7.6]) {
    for (const cz2 of [s.cz - 4.4, s.cz + 4.4]) {
      b.box(cx2, y + 0.14, cz2 + 0.52, 0.3, 0.28, 0.22, 0, Mat.darkSteel);
      b.box(cx2, y + 0.26, cz2 + 0.44, 0.22, 0.06, 0.04, 0, glowOpts(Glow.magenta, 6));
      // The wash on the column itself: a tall, dim emissive face is a far
      // better use of a triangle than a sixth point light would be.
      b.box(cx2, y + h * 0.42, cz2 + 0.33, 0.5, h * 0.8, 0.02, 0, glowOpts(Glow.purple, 0.42));
      lightPool(b, cx2, y, cz2 + 0.7, 1.5, 0xc04ad0, 0.3);
    }
  }
  // String lights zig-zagged across the room, the cheapest possible party.
  for (let r = 0; r < 3; r++) {
    const zA = s.cz - 6 + r * 5;
    cableRun(b, x0 + 0.6, y + 6.4, zA, x1 - 0.6, y + 6.2, zA + 1.4, 0.012, 0.8, 5, Mat.darkSteel);
    for (let i = 0; i < 12; i++) {
      const t = (i + 0.5) / 12;
      const bx = x0 + 0.6 + (x1 - x0 - 1.2) * t;
      const bz = zA + 1.4 * t;
      const sag = Math.sin(t * Math.PI) * 0.8;
      b.box(bx, y + 6.4 - sag, bz, 0.09, 0.12, 0.09, 0,
        glowOpts(i % 3 === 0 ? Glow.magenta : i % 3 === 1 ? Glow.tungsten : Glow.purple, 6));
    }
  }
  lights.push(anchor(s.cx, y + 5.6, s.cz, 0xffb0e0, 5.0, 22, 4));

  // Tricolour over the lift core, and builders' banners either side.
  tricolour(b, s.cx + 1.0, y + 5.4, z1 - 0.4, Math.PI, 4.5, 2.6, 1.4);
  for (const bx of [x0 + 0.4, x1 - 0.4]) {
    b.box(bx, y + 5.0, s.cz, 0.05, 3.2, 4.0, 0, glowOpts(Glow.purple, 0.9));
  }
  // And one strung over the entrance, so the room announces itself the moment
  // the door is in frame rather than after you have crossed it.
  tricolour(b, s.cx, y + 4.2, z0 + 0.5, 0, 5.2, 1.3, 1.2);
  lights.push(anchor(s.cx, y + 2.4, z0 + 2.4, 0xffb47a, 3.4, 12, 3));

  // PA stack and decks on the reception counter.
  for (const sgn of [-1, 1]) {
    const sx = rx + sgn * 3.6;
    b.box(sx, y + 0.55, rz - 0.4, 0.7, 1.1, 0.6, 0, Mat.plasticBlack);
    b.cyl(sx, y + 0.75, rz - 0.72, 0.22, 0.22, 0.03, 10, Mat.black);
    b.cyl(sx, y + 0.3, rz - 0.72, 0.12, 0.12, 0.03, 8, Mat.black);
    b.box(sx, y + 1.15, rz - 0.4, 0.6, 0.06, 0.5, 0, Mat.darkSteel);
    b.box(sx, y + 1.5, rz - 0.4, 0.5, 0.64, 0.4, 0, Mat.plasticBlack);
    b.cyl(sx, y + 1.5, rz - 0.62, 0.14, 0.14, 0.03, 9, Mat.black);
    lightPool(b, sx, y, rz - 1.2, 1.6, 0xc04ad0, 0.3);
  }
  b.box(rx, y + 1.2, rz - 0.1, 1.1, 0.09, 0.6, 0, Mat.darkSteel);
  for (let i = 0; i < 10; i++) {
    b.box(rx - 0.45 + i * 0.1, y + 1.26, rz - 0.2, 0.05, 0.03, 0.28, 0,
      glowOpts(i % 2 ? Glow.green : Glow.magenta, 3.0));
  }
  // The decks are the loudest thing in the room; give them a real light.
  lights.push(anchor(rx, y + 1.9, rz - 1.4, 0xff7ad0, 4.4, 12, 3));

  // Drinks table, plastic cups, a crate of beer.
  lowTable(b, s.cx + 6.0, s.cz + 1.0, 0, 2.2, 0.9, 0.78, Mat.woodPale);
  for (let i = 0; i < 14; i++) {
    b.cyl(s.cx + 5.1 + (i % 7) * 0.28, y + 0.8, s.cz + 0.7 + Math.floor(i / 7) * 0.3,
      0.035, 0.042, 0.11, 6, { color: lin(0xd8d2c4), mr: [0, 0.6] });
  }
  b.box(s.cx + 6.0, y + 0.16, s.cz + 2.0, 0.5, 0.32, 0.36, 0.3, { color: lin(0x2a4a6d), mr: [0, 0.85] });

  // Confetti and spilled paper on the floor, but swept into drifts. Drawn
  // ABOVE the dance-floor tiles, which are themselves a millimetre proud of
  // the terrazzo.
  for (let i = 0; i < 90; i++) {
    const px = s.cx + rng.range(-hx + 1, hx - 1);
    const pz = s.cz + rng.range(-hz + 1, hz - 1);
    b.box(px, y + 0.044, pz, 0.06, 0.002, 0.05, rng.range(0, 3),
      { color: [lin(0xc04ad0), lin(0xfcd116), lin(0x002b7f), lin(0xce1126)][rng.int(0, 4)], mr: [0, 0.9] });
  }
  litterPapers(b, s.cx, s.cz - 6, hx - 3, 2.0, y + 0.03, 10, rng);

  // The lift comes back on.
  b.box(s.cx - 3.4, y + 2.62, z1 - 0.28, 0.12, 0.1, 0.02, Math.PI, glowOpts(Glow.amber, 4));
  return lights;
}
