/**
 * THE RECORDER NEWSROOM — the "realistic Recorder building office".
 *
 * An independent-journalism floor: two desk pods with edit timelines running
 * on every monitor, a camera kit corner that has clearly been packed and
 * unpacked a hundred times, whiteboards with a running story list, a coffee
 * counter, cable everywhere, awards nobody dusts, and the red Recorder mark on
 * the wall. Alex Need-Aid works here; `PLACES.recorderDrop` is 40 m outside
 * the door.
 *
 * Lit by recessed panels overhead, desk lamps at the pods and the monitors
 * themselves — a fluorescent-over-warm mix, which is what stops an office
 * reading as a showroom.
 *
 * OWNER: interiors agent.
 */

import type { Rng } from '../../core/rng';
import type { DetailBuilder } from '../city/builders';
import { srgb } from '../../render/materials';
import {
  Glow, Mat, anchor, cabinet, cableRun, ceilingGrid, deskLamp, desk, figure,
  flightCase, glowOpts, keyboard, monitor, mug, officeChair, paperStack,
  recorderMark, rot, shelfUnit, signBox, sofa, lowTable, tripod, whiteboard,
  type LightAnchor,
} from './kit';
import { Finish, drawShellRoom, innerHalf, type ShellSpec } from './shell';

const lin = srgb;

export function fitRecorder(b: DetailBuilder, s: ShellSpec, rng: Rng): LightAnchor[] {
  const { hx, hz } = innerHalf(s);
  const x0 = s.cx - hx;
  const x1 = s.cx + hx;
  const z0 = s.cz - hz;
  const z1 = s.cz + hz;
  const y = s.floorY;
  const lights: LightAnchor[] = [];

  drawShellRoom(b, s, Finish.office, { glazed: ['west'] });

  /* ---- floor: carpet tiles in the open plan, vinyl at the entrance ---- */
  b.box(s.cx + 2.4, y + 0.012, s.cz, (hx - 2.4) * 2, 0.024, hz * 2 - 1.0, 0, Mat.carpet);
  b.box(x0 + 3.4, y + 0.012, s.cz, 6.4, 0.024, 5.0, 0, { color: lin(0x35313c), mr: [0.05, 0.55] });

  /* ---- suspended ceiling: one lit panel in three ---- */
  /*
   * ONE LIT PANEL IN SEVEN, at a quarter of the gain the first pass used.
   * Every third panel of a 1.2 m grid over a 300 m² floor is forty luminaires;
   * rendered emissive they weld into one continuous light box and the ceiling
   * becomes the brightest thing in the frame, which is what an office ceiling
   * never is.
   */
  lights.push(...ceilingGrid(b, s.cx, s.cz, hx - 0.2, hz - 0.2, s.ceilingY, 12, rng, Glow.fluorescent, 0.9));

  // Cable tray running the length of the floor above the pods.
  for (const tz of [s.cz - 5.9, s.cz + 5.9]) {
    b.box(s.cx + 2.4, s.ceilingY - 0.42, tz, (hx - 2.4) * 2, 0.05, 0.34, 0, Mat.alu);
    for (let i = 0; i < 6; i++) {
      const cx = s.cx - hx + 4 + i * 3;
      b.tube(cx, s.ceilingY - 0.05, tz, cx, s.ceilingY - 0.4, tz, 0.012, 4, Mat.darkSteel);
    }
    cableRun(b, s.cx - 4, s.ceilingY - 0.36, tz, s.cx + 8, s.ceilingY - 0.36, tz, 0.035, 0.05, 3);
  }

  /* ---- the mark, on the wall you turn to as you come in ---- */
  recorderMark(b, s.cx - 5.5, y + 2.3, z0 + 0.1, 0, 1.05);
  lights.push(anchor(s.cx - 5.5, y + 2.3, z0 + 1.4, 0xff3a40, 2.4, 6, 2));

  /* ---- entrance: reception desk, sofa, low table, awards ---- */
  const rx = x0 + 3.2;
  b.box(rx, y + 0.55, s.cz + 2.4, 2.6, 1.1, 0.72, 0, { color: lin(0x2f2a38), mr: [0, 0.6] });
  b.box(rx, y + 1.13, s.cz + 2.4, 2.9, 0.06, 0.92, 0, Mat.laminate);
  monitor(b, rx + 0.7, y + 1.45, s.cz + 2.2, Math.PI * 0.5, 0.42, 0.28, 'text', rng, 0.7);
  paperStack(b, rx - 0.7, y + 1.16, s.cz + 2.3, 0.2, 5, rng);
  officeChair(b, rx, s.cz + 3.2, 0, y);

  sofa(b, x0 + 2.6, s.cz - 2.6, Math.PI * 0.5, 2.0, Mat.fabricPurple, y);
  lowTable(b, x0 + 4.2, s.cz - 2.6, 0, 0.9, 0.6, 0.42, Mat.woodDark);
  paperStack(b, x0 + 4.2, y + 0.44, s.cz - 2.6, 0.4, 3, rng);
  mug(b, x0 + 4.4, y + 0.46, s.cz - 2.2, 0xb8452f);

  // Awards, on a shelf by the reception. Nobody dusts them.
  shelfUnit(b, x0 + 1.0, s.cz + 4.8, Math.PI * 0.5, 2.4, 1.9, 0.34, 4, rng, Mat.darkSteel, 'awards', y);
  lights.push(anchor(x0 + 1.6, y + 1.8, s.cz + 4.8, 0xffc078, 2.2, 4.5, 1));

  /* ---- the open plan: two pods of four ---- */
  const pod = (px: number, pz: number): void => {
    // Back-to-back screen divider.
    b.box(px, y + 1.16, pz, 3.9, 0.52, 0.06, 0, { color: lin(0x4a3f5c), mr: [0, 0.9] });
    b.box(px, y + 0.9, pz, 3.9, 0.04, 0.1, 0, Mat.alu);
    for (const side of [-1, 1]) {
      const dz = side * 0.62;
      const yaw = side > 0 ? 0 : Math.PI;
      for (const dx of [-0.95, 0.95]) {
        const dxp = px + dx;
        const dzp = pz + dz;
        desk(b, dxp, dzp, yaw, 1.75, 0.8, y, { color: lin(0xbfae94), mr: [0, 0.55] });
        // Monitor faces the user, who sits on the outside of the pod.
        const [mx, mz] = rot(dxp, dzp, 0, -0.24 * side, 0);
        monitor(b, mx, y + 1.05, mz, yaw + Math.PI, 0.62, 0.38,
          rng.bool(0.62) ? 'timeline' : rng.bool(0.5) ? 'text' : 'waveform', rng);
        if (rng.bool(0.35)) {
          monitor(b, mx + 0.72 * (dx < 0 ? -1 : 1), y + 1.02, mz + 0.06 * side, yaw + Math.PI + 0.35 * side,
            0.5, 0.32, 'grid', rng, 0.8);
        }
        keyboard(b, dxp, y + 0.79, dzp + 0.2 * side, yaw);
        if (rng.bool(0.6)) mug(b, dxp + rng.range(-0.5, 0.5), y + 0.79, dzp + 0.28 * side,
          rng.bool(0.5) ? 0xd8d2c4 : 0x2f6d4a);
        if (rng.bool(0.5)) paperStack(b, dxp - 0.55, y + 0.78, dzp + 0.24 * side, rng.range(0, 0.4), 3, rng);
        if (rng.bool(0.45)) {
          const a = deskLamp(b, dxp + 0.72, y + 0.78, dzp + 0.1 * side, yaw + Math.PI);
          if (a) lights.push(a);
        }
        // Chair, and sometimes somebody in it.
        const cz2 = dzp + 1.05 * side;
        officeChair(b, dxp, cz2, yaw, y, rng.bool(0.4) ? Mat.fabricPurple : Mat.fabricGrey);
        if (rng.bool(0.4)) {
          figure(b, dxp, y + 0.06, cz2 + 0.06 * side, yaw + Math.PI,
            rng.bool(0.5) ? Mat.fabricGrey : { color: lin(0x22303f), mr: [0, 0.9] }, rng, true);
        }
        // Power and data to the floor.
        cableRun(b, dxp + 0.6, y + 0.7, dzp - 0.3 * side, px, y + 0.04, pz, 0.016, 0.08, 3);
      }
    }
    // Under-pod cable spine.
    b.box(px, y + 0.03, pz, 4.2, 0.06, 0.22, 0, Mat.rubber);
  };
  pod(s.cx + 1.0, s.cz + 3.6);
  pod(s.cx + 1.0, s.cz - 3.6);
  pod(s.cx + 7.0, s.cz + 3.6);
  pod(s.cx + 7.0, s.cz - 3.6);

  /* ---- whiteboards + the story list, on the north wall ---- */
  whiteboard(b, s.cx - 1.5, y + 1.85, z1 - 0.12, Math.PI, 3.2, 1.5, rng);
  whiteboard(b, s.cx + 2.4, y + 1.85, z1 - 0.12, Math.PI, 2.2, 1.5, rng);
  // Printed pages taped up in a grid — the running order.
  for (let i = 0; i < 12; i++) {
    b.box(s.cx + 4.6 + (i % 6) * 0.34, y + 2.3 - Math.floor(i / 6) * 0.44, z1 - 0.1,
      0.24, 0.34, 0.006, Math.PI, Mat.paperWhite);
  }

  /* ---- camera kit corner: tripods, cases, a light stand, a boom ---- */
  const kx = x1 - 3.4;
  const kz = z1 - 2.6;
  tripod(b, kx, kz, -0.6, 1.35, 'camera', y);
  tripod(b, kx - 1.6, kz - 0.4, 0.4, 1.25, 'none', y);
  tripod(b, kx - 0.4, kz - 2.4, 1.9, 2.0, 'light', y);
  lights.push(anchor(kx - 0.4, y + 2.1, kz - 2.4, 0xd8e6ff, 1.8, 6, 1));
  flightCase(b, kx - 2.9, y, kz - 3.4, 0.3, 0.95, 0.6, 0.62);
  flightCase(b, kx - 2.9, y + 0.6, kz - 3.4, 0.3, 0.95, 0.42, 0.62);
  flightCase(b, kx - 1.5, y, kz - 4.2, -0.2, 0.7, 0.5, 0.5);
  // Boom pole leaning in the corner, and a battery charger stack.
  b.tube(x1 - 0.4, y + 0.05, z1 - 0.6, x1 - 1.2, y + 2.5, z1 - 1.1, 0.022, 5, Mat.darkSteel);
  b.box(x1 - 1.2, y + 2.55, z1 - 1.15, 0.09, 0.24, 0.09, 0, Mat.black);
  for (let i = 0; i < 4; i++) {
    b.box(x1 - 0.9, y + 0.9 + i * 0.14, z1 - 4.2, 0.24, 0.12, 0.18, 0, Mat.plasticBlack);
    b.box(x1 - 0.9, y + 0.9 + i * 0.14, z1 - 4.3, 0.05, 0.03, 0.02, 0, glowOpts(Glow.green, 3));
  }
  cabinet(b, x1 - 1.1, z1 - 5.6, Math.PI * 0.5, 1.2, 0.9, 0.6, Mat.darkSteel);

  /* ---- edit suite: the dark corner with the big screens ---- */
  const ex = x1 - 4.0;
  const ez = z0 + 3.0;
  b.box(ex + 1.6, y + 1.6, z0 + 0.14, 7.2, 3.0, 0.1, 0, { color: lin(0x201d28), mr: [0, 0.96] });
  desk(b, ex, ez, 0, 2.4, 0.9, y, { color: lin(0x2a2630), mr: [0, 0.6] });
  monitor(b, ex - 0.7, y + 1.16, ez - 0.3, Math.PI, 0.9, 0.54, 'timeline', rng, 1.2);
  monitor(b, ex + 0.75, y + 1.14, ez - 0.28, Math.PI - 0.3, 0.7, 0.44, 'waveform', rng, 1.1);
  keyboard(b, ex, y + 0.79, ez + 0.22, 0);
  // Grade panel: a row of trackballs and lit buttons.
  b.box(ex + 0.9, y + 0.8, ez + 0.2, 0.5, 0.06, 0.28, 0, Mat.plasticBlack);
  for (let i = 0; i < 3; i++) {
    b.cyl(ex + 0.74 + i * 0.16, y + 0.83, ez + 0.2, 0.05, 0.05, 0.03, 6, glowOpts(Glow.purple, 1.6));
  }
  officeChair(b, ex, ez + 1.1, 0, y, Mat.fabricPurple);
  lights.push(anchor(ex, y + 1.5, ez - 0.6, 0x8fb6ff, 2.2, 5.5, 2));
  // Speakers either side.
  for (const sgn of [-1, 1]) {
    b.box(ex + sgn * 1.5, y + 1.15, ez - 0.34, 0.22, 0.34, 0.22, 0, Mat.plasticBlack);
    b.cyl(ex + sgn * 1.5, y + 1.1, ez - 0.46, 0.07, 0.07, 0.02, 8, Mat.black);
  }

  /* ---- coffee counter ---- */
  const cx = s.cx - 4.5;
  const cz = z0 + 0.9;
  b.box(cx, y + 0.45, cz + 0.3, 3.0, 0.9, 0.62, 0, { color: lin(0x4a4450), mr: [0, 0.7] });
  b.box(cx, y + 0.92, cz + 0.3, 3.1, 0.05, 0.68, 0, Mat.laminate);
  // Filter machine, kettle, cups.
  b.box(cx - 0.9, y + 1.09, cz + 0.3, 0.3, 0.29, 0.28, 0, Mat.plasticBlack);
  b.box(cx - 0.9, y + 1.0, cz + 0.18, 0.2, 0.12, 0.02, 0, glowOpts(Glow.red, 2.2));
  b.cyl(cx - 0.2, y + 0.95, cz + 0.3, 0.09, 0.08, 0.24, 7, Mat.alu);
  for (let i = 0; i < 5; i++) mug(b, cx + 0.35 + i * 0.14, y + 0.95, cz + 0.36 + (i % 2) * 0.14);
  // Wall units over it.
  b.box(cx, y + 1.95, cz + 0.14, 3.0, 0.7, 0.34, 0, { color: lin(0x3e3947), mr: [0, 0.8] });
  b.box(cx, y + 1.58, cz + 0.14, 2.9, 0.03, 0.3, 0, glowOpts(Glow.tungsten, 2.2));
  lights.push(anchor(cx, y + 1.4, cz + 0.6, 0xffc078, 1.5, 5, 1));
  // Bin, and the recycling nobody empties.
  b.cyl(cx + 2.0, y, cz + 0.4, 0.22, 0.24, 0.6, 8, Mat.plasticGrey);
  b.box(cx + 2.55, y + 0.25, cz + 0.4, 0.4, 0.5, 0.34, 0.2, { color: lin(0x6d5a3a), mr: [0, 0.9] });

  /* ---- signage: the fire plan and a Recorder strap over the door ---- */
  signBox(b, x0 + 0.14, y + 2.55, s.cz, Math.PI * 0.5, 2.2, 0.42, lin(0xe12b32), 2.2);
  b.box(x0 + 0.2, y + 1.7, s.cz + 4.2, 0.03, 0.42, 0.3, 0, Mat.paperWhite);

  /* ---- litter of a working office ---- */
  for (let i = 0; i < 14; i++) {
    const px = s.cx + rng.range(-hx * 0.8, hx * 0.8);
    const pz = s.cz + rng.range(-hz * 0.8, hz * 0.8);
    b.box(px, y + 0.02, pz, 0.21, 0.004, 0.3, rng.range(0, 3.1), Mat.paperWhite);
  }
  return lights;
}
