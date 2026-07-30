/**
 * Visible interiors.
 *
 * "Windows are light sources" and "you can see through the glass into lit
 * floors with people and desks" are both non-negotiable rules of the visual
 * target. The facade grammar paints an interior silhouette per pane, which
 * holds up at distance but goes flat when the camera is at street level, ten
 * metres from a lobby.
 *
 * This module builds real, parallax-correct interiors — floor plate, glowing
 * ceiling coffer, desks, partitions and standing figures — inset behind the
 * glass line of the buildings a player can actually walk up to. It is
 * deliberately used only near the hero area: it is the most expensive geometry
 * per square metre in the city.
 */

import * as THREE from 'three';
import type { Rng } from '../../core/rng';
import type { DetailBuilder } from './builders';
import { DetailColor, emi } from './facades';
import { INTERIORS } from '../interiors/defs';

const lin = (hex: number): THREE.Color => new THREE.Color(hex).convertSRGBToLinear();

const CARPET = lin(0x2a2033);
const CEILING = lin(0x3a3346);
const DESK = lin(0x6a5a4a);
const PARTITION = lin(0x4a3f5c);
const SKIN = lin(0xc99a76);
const CLOTH = lin(0x22202e);

const MR_MATTE: [number, number] = [0, 0.9];
const MR_SEMI: [number, number] = [0.05, 0.6];

export interface InteriorFloor {
  /** Centre of the building footprint. */
  cx: number;
  cz: number;
  /** Footprint size. */
  w: number;
  d: number;
  /** Floor slab height (bottom of the visible volume). */
  y: number;
  /** Clear height of the storey. */
  height: number;
  /** How far the interior sits behind the glass line. */
  inset: number;
  /** Tint of the ceiling wash — purple lobby vs magenta open plan. */
  glow: THREE.Color;
  /** How bright, 0..1. */
  intensity: number;
}

/**
 * One lit storey. ~40-90 triangles depending on how much furniture survives
 * the rng, which is why this is hero-area only.
 */
export function buildInteriorFloor(d: DetailBuilder, f: InteriorFloor, rng: Rng): void {
  const hw = f.w / 2 - f.inset;
  const hd = f.d / 2 - f.inset;
  if (hw < 1.5 || hd < 1.5) return;

  // Floor plate.
  d.box(f.cx, f.y + 0.06, f.cz, hw * 2, 0.12, hd * 2, 0, { color: CARPET, mr: MR_MATTE });

  // Ceiling slab + the emissive coffer under it. The coffer is what actually
  // reads from the street: a horizontal band of colour deep inside the glass.
  d.box(f.cx, f.y + f.height - 0.12, f.cz, hw * 2, 0.24, hd * 2, 0, {
    color: CEILING, mr: MR_MATTE,
  });
  d.box(f.cx, f.y + f.height - 0.3, f.cz, hw * 1.86, 0.12, hd * 1.86, 0, {
    color: f.glow, mr: [0, 0.3], emissive: emi(f.glow, 4.0 * f.intensity),
  });
  // Two strip lights running the depth of the plate.
  for (const s of [-1, 1]) {
    d.box(f.cx + s * hw * 0.45, f.y + f.height - 0.42, f.cz, 0.28, 0.1, hd * 1.7, 0, {
      color: lin(0xfff0e0), mr: [0, 0.25], emissive: emi(lin(0xffe6cc), 5.5 * f.intensity),
    });
  }

  // Back wall, washed by the ceiling light.
  d.box(f.cx, f.y + f.height / 2, f.cz + hd, hw * 2, f.height, 0.25, 0, {
    color: PARTITION, mr: MR_MATTE,
  });

  /* ---- furniture ---- */
  const cols = Math.max(1, Math.floor(hw * 2 / 3.4));
  const rows = Math.max(1, Math.floor(hd * 2 / 3.0));
  let budget = 10;

  for (let i = 0; i < cols && budget > 0; i++) {
    for (let j = 0; j < rows && budget > 0; j++) {
      if (!rng.bool(0.55)) continue;
      const x = f.cx - hw + (i + 0.5) * (hw * 2 / cols);
      const z = f.cz - hd + (j + 0.5) * (hd * 2 / rows);
      // Desk.
      d.box(x, f.y + 0.74, z, 1.9, 0.07, 0.85, 0, { color: DESK, mr: MR_SEMI });
      d.box(x, f.y + 0.37, z, 1.7, 0.68, 0.1, 0, { color: PARTITION, mr: MR_MATTE });
      // Monitor — a small cool emissive that flickers nicely under bloom.
      if (rng.bool(0.8)) {
        d.box(x + rng.range(-0.4, 0.4), f.y + 1.02, z - 0.1, 0.52, 0.34, 0.05, 0, {
          color: DetailColor.screen, mr: [0, 0.25], emissive: emi(DetailColor.screen, 3.2),
        });
      }
      // Occupant: torso + head, facing the desk.
      if (rng.bool(0.42)) {
        const px = x + rng.range(-0.5, 0.5);
        const pz = z + 0.75;
        d.box(px, f.y + 0.95, pz, 0.42, 0.62, 0.26, rng.range(-0.4, 0.4), { color: CLOTH, mr: MR_MATTE });
        d.box(px, f.y + 1.4, pz, 0.2, 0.24, 0.2, 0, { color: SKIN, mr: MR_MATTE });
      }
      budget--;
    }
  }
}

/**
 * A lobby: taller, emptier, with a reception desk and a purple back wall — the
 * ground-floor condition in the reference frame.
 */
export function buildLobby(
  d: DetailBuilder,
  cx: number, cz: number, w: number, dep: number,
  height: number, inset: number,
  rng: Rng,
): void {
  const hw = w / 2 - inset;
  const hd = dep / 2 - inset;
  if (hw < 2 || hd < 2) return;

  /*
   * NOT OVER A ROOM YOU CAN WALK INTO.
   *
   * This lobby is a FAKE: a magenta emissive back wall and a purple ceiling
   * coffer, authored to read from the plaza through glass at ten metres. Drawn
   * inside an enterable interior it is a 24 m wall of blown-out magenta four
   * metres from the player's face, and it swallows the real room — which is
   * exactly what it did to the Builders House lobby: the fake was still being
   * drawn at (-46, 46) on top of the room the finale happens in.
   */
  for (const room of INTERIORS) {
    if (Math.abs(cx - room.cx) < room.w / 2 && Math.abs(cz - room.cz) < room.d / 2) return;
  }

  d.box(cx, 0.3, cz, hw * 2, 0.2, hd * 2, 0, { color: lin(0x2b2530), mr: [0.1, 0.35] });
  // Back wall glowing magenta — this is the colour that leaks onto the plaza.
  d.box(cx, height / 2, cz + hd, hw * 2, height, 0.3, 0, {
    color: DetailColor.magenta, mr: [0, 0.4], emissive: emi(DetailColor.magenta, 1.9),
  });
  // Ceiling coffer.
  d.box(cx, height - 0.35, cz, hw * 1.7, 0.14, hd * 1.7, 0, {
    color: DetailColor.purple, mr: [0, 0.3], emissive: emi(DetailColor.purple, 3.4),
  });
  // Reception desk.
  d.box(cx + rng.range(-1, 1), 0.95, cz + hd * 0.35, 5.2, 1.1, 1.1, 0, {
    color: lin(0xd8cbb4), mr: [0, 0.5],
  });
  // A couple of standing figures in the lobby.
  for (let i = 0; i < 3; i++) {
    if (!rng.bool(0.7)) continue;
    const px = cx + rng.range(-hw * 0.7, hw * 0.7);
    const pz = cz + rng.range(-hd * 0.5, hd * 0.5);
    d.box(px, 1.05, pz, 0.4, 0.9, 0.26, rng.range(0, 3.1), { color: CLOTH, mr: MR_MATTE });
    d.box(px, 1.63, pz, 0.2, 0.24, 0.2, 0, { color: SKIN, mr: MR_MATTE });
  }
  // Pendant lights.
  for (let i = 0; i < 4; i++) {
    const px = cx - hw * 0.6 + (i / 3) * hw * 1.2;
    d.cyl(px, height - 1.4, cz - hd * 0.3, 0.02, 0.02, 1.05, 4, { color: DetailColor.metal, mr: [0.7, 0.4] }, false);
    d.box(px, height - 1.45, cz - hd * 0.3, 0.3, 0.12, 0.3, 0, {
      color: lin(0xffd8a8), mr: [0, 0.3], emissive: emi(lin(0xffd8a8), 6),
    });
  }
}
