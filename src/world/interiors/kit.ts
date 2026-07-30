/**
 * THE FITOUT KIT — the furniture every interior is assembled from.
 *
 * Everything here writes into a `DetailBuilder`, so a whole room bakes down to
 * one BufferGeometry and one draw call. Triangle costs are noted where they
 * matter: a box is 12 triangles and a room is allowed a few thousand, because
 * only the interior you are standing near is ever built.
 *
 * Two rules the props obey, both learned from the city:
 *   — nothing is a single colour. A desk is a top, a modesty panel, a pedestal
 *     and a cable, in four values. One-value props read as blocking-out.
 *   — every light fitting also paints an emissive lens AND (where it lands on
 *     something) a pool, because the real point lights are a small pool shared
 *     between rooms and any given fitting usually does not own one.
 *
 * OWNER: interiors agent.
 */

import type * as THREE from 'three';
import type { Rng } from '../../core/rng';
import type { DetailBuilder, DetailOpts } from '../city/builders';
import { srgb } from '../../render/materials';
import { emi } from '../city/facades';

const lin = srgb;

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export const Mat = {
  steel: { color: lin(0x6f767e), mr: [0.85, 0.34] as [number, number] },
  darkSteel: { color: lin(0x33383f), mr: [0.8, 0.42] as [number, number] },
  alu: { color: lin(0x9aa2ab), mr: [0.9, 0.26] as [number, number] },
  black: { color: lin(0x17151b), mr: [0.15, 0.7] as [number, number] },
  plasticBlack: { color: lin(0x201d26), mr: [0.05, 0.55] as [number, number] },
  plasticGrey: { color: lin(0x565360), mr: [0.05, 0.6] as [number, number] },
  woodDark: { color: lin(0x4a3526), mr: [0, 0.72] as [number, number] },
  woodWarm: { color: lin(0x7a5632), mr: [0, 0.66] as [number, number] },
  woodPale: { color: lin(0xa9885a), mr: [0, 0.7] as [number, number] },
  ply: { color: lin(0xb1854c), mr: [0, 0.82] as [number, number] },
  laminate: { color: lin(0xcfc6b4), mr: [0, 0.5] as [number, number] },
  paperWhite: { color: lin(0xd9d3c4), mr: [0, 0.95] as [number, number] },
  fabricGrey: { color: lin(0x3c3947), mr: [0, 0.93] as [number, number] },
  fabricRed: { color: lin(0x6d1f2a), mr: [0, 0.9] as [number, number] },
  fabricPurple: { color: lin(0x3f2a63), mr: [0, 0.9] as [number, number] },
  carpet: { color: lin(0x2a2531), mr: [0, 0.95] as [number, number] },
  glassDark: { color: lin(0x121a2e), mr: [0.85, 0.09] as [number, number] },
  rubber: { color: lin(0x14131a), mr: [0, 0.88] as [number, number] },
  skin: { color: lin(0xc09070), mr: [0, 0.72] as [number, number] },
  skinDark: { color: lin(0x8d6448), mr: [0, 0.74] as [number, number] },
  hair: { color: lin(0x241c1a), mr: [0, 0.8] as [number, number] },
} as const;

export const Glow = {
  screen: lin(0x7fb0ff),
  screenWarm: lin(0xffd9a0),
  fluorescent: lin(0xd8e6ff),
  tungsten: lin(0xffc078),
  sodium: lin(0xffb14a),
  purple: lin(0x7b3fd4),
  magenta: lin(0xc04ad0),
  red: lin(0xff2a32),
  green: lin(0x36d17a),
  amber: lin(0xffa030),
  neonPink: lin(0xff2f8e),
  cold: lin(0xa8c4ff),
} as const;

export function glowOpts(c: THREE.Color, gain: number, rough = 0.3): DetailOpts {
  return { color: c, mr: [0, rough], emissive: emi(c, gain) };
}

/* ------------------------------------------------------------------ */
/* Light anchors                                                       */
/* ------------------------------------------------------------------ */

/**
 * A place a real `THREE.PointLight` should stand if one is spare.
 *
 * The system keeps a FIXED pool of point lights (a varying light count
 * recompiles every shader in the scene — see the vehicle headlight note in
 * `src/vehicles/lights.ts`) and homes them on the nearest anchors.
 */
export interface LightAnchor {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
  distance: number;
  /** Higher wins when the pool is oversubscribed. */
  priority?: number;
}

export function anchor(
  x: number, y: number, z: number,
  color: number, intensity: number, distance: number, priority = 1,
): LightAnchor {
  return { x, y, z, color, intensity, distance, priority };
}

/* ------------------------------------------------------------------ */
/* Small parts                                                         */
/* ------------------------------------------------------------------ */

/** Rotate a local offset into world space around (cx, cz) by `yaw`. */
export function rot(cx: number, cz: number, dx: number, dz: number, yaw: number): [number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [cx + dx * c + dz * s, cz - dx * s + dz * c];
}

/** Office desk: top, modesty panel, two pedestals, a cable to the floor. */
export function desk(
  b: DetailBuilder,
  x: number, z: number, yaw: number,
  w = 1.6, d = 0.78, y = 0,
  top: DetailOpts = Mat.laminate,
): void {
  const h = 0.74;
  b.box(x, y + h, z, w, 0.045, d, yaw, top);
  b.box(x, y + h - 0.05, z, w * 0.92, 0.06, d * 0.86, yaw, Mat.plasticGrey);
  // Modesty panel at the back.
  const [mx, mz] = rot(x, z, 0, -d * 0.44, yaw);
  b.box(mx, y + 0.5, mz, w * 0.9, 0.42, 0.03, yaw, Mat.plasticGrey);
  // Two frame legs.
  for (const s of [-1, 1]) {
    const [lx, lz] = rot(x, z, s * (w / 2 - 0.09), 0, yaw);
    b.box(lx, y + h / 2, lz, 0.06, h, d * 0.9, yaw, Mat.darkSteel);
  }
  // Cable dropping to the floor behind.
  const [c0x, c0z] = rot(x, z, w * 0.28, -d * 0.4, yaw);
  b.tube(c0x, y + h - 0.08, c0z, c0x + 0.05, y + 0.03, c0z - 0.12, 0.014, 4, Mat.rubber);
}

/** Swivel chair: base, column, seat, back. ~90 triangles. */
export function officeChair(
  b: DetailBuilder, x: number, z: number, yaw: number, y = 0,
  cloth: DetailOpts = Mat.fabricGrey,
): void {
  for (let i = 0; i < 5; i++) {
    const a = yaw + (i / 5) * Math.PI * 2;
    b.box(x + Math.sin(a) * 0.16, y + 0.055, z + Math.cos(a) * 0.16, 0.07, 0.05, 0.33, a, Mat.plasticBlack);
  }
  b.cyl(x, y + 0.09, z, 0.045, 0.045, 0.34, 6, Mat.darkSteel, false);
  b.box(x, y + 0.46, z, 0.48, 0.09, 0.46, yaw, cloth);
  const [bx, bz] = rot(x, z, 0, -0.21, yaw);
  b.box(bx, y + 0.74, bz, 0.46, 0.52, 0.07, yaw, cloth);
  for (const s of [-1, 1]) {
    const [ax, az] = rot(x, z, s * 0.26, 0, yaw);
    b.box(ax, y + 0.62, az, 0.05, 0.05, 0.34, yaw, Mat.plasticBlack);
  }
}

export type ScreenContent = 'timeline' | 'grid' | 'text' | 'waveform' | 'broadcast' | 'off';

/**
 * A monitor with something believable on it.
 *
 * The content is what sells the room. An edit timeline — stacked coloured
 * clips on tracks with a playhead — says "this is a newsroom" from across the
 * floor in a way that no amount of desk detail does.
 */
export function monitor(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number,
  w: number, h: number,
  content: ScreenContent,
  rng: Rng,
  gain = 1,
): void {
  const t = 0.045;
  // Case + stand.
  b.box(x, y, z, w + 0.05, h + 0.05, t, yaw, Mat.plasticBlack);
  const [sx, sz] = rot(x, z, 0, 0.05, yaw);
  b.cyl(sx, y - h / 2 - 0.16, sz, 0.03, 0.03, 0.16, 5, Mat.darkSteel, false);
  b.box(sx, y - h / 2 - 0.17, sz, 0.2, 0.02, 0.16, yaw, Mat.darkSteel);
  if (content === 'off') {
    b.box(x, y, z, w, h, 0.006, yaw, { color: lin(0x0c0d13), mr: [0.4, 0.25] });
    return;
  }

  const face = (dx: number, dy: number, sw: number, sh: number, o: DetailOpts): void => {
    const [px, pz] = rot(x, z, dx, -0.028, yaw);
    b.box(px, y + dy, pz, sw, sh, 0.004, yaw, o);
  };
  // Backing.
  face(0, 0, w, h, { color: lin(0x0b1020), mr: [0, 0.3], emissive: emi(lin(0x121a33), 0.5 * gain) });

  if (content === 'timeline') {
    // Preview window, top-left; bin list, top-right; tracks below; playhead.
    face(-w * 0.22, h * 0.22, w * 0.5, h * 0.4,
      glowOpts(rng.bool(0.5) ? Glow.screenWarm : Glow.purple, 0.9 * gain));
    for (let i = 0; i < 4; i++) {
      face(w * 0.28, h * 0.36 - i * h * 0.09, w * 0.36, h * 0.045,
        glowOpts(Glow.screen, (0.5 + i * 0.05) * gain));
    }
    const tracks = 3;
    for (let tI = 0; tI < tracks; tI++) {
      let cursor = -w * 0.46;
      let guard = 0;
      while (cursor < w * 0.46 && guard++ < 8) {
        const len = rng.range(w * 0.06, w * 0.2);
        const col = tI === 0 ? Glow.magenta : tI === 1 ? Glow.screen : Glow.amber;
        face(cursor + len / 2, -h * 0.1 - tI * h * 0.12, Math.min(len, w * 0.46 - cursor), h * 0.075,
          glowOpts(col, 0.75 * gain));
        cursor += len + rng.range(0.01, 0.05);
      }
    }
    face(rng.range(-w * 0.3, w * 0.3), -h * 0.22, 0.012, h * 0.42, glowOpts(Glow.red, 2.4 * gain));
  } else if (content === 'grid') {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const c = rng.bool(0.3) ? Glow.purple : rng.bool(0.5) ? Glow.screen : Glow.screenWarm;
        face((i - 1) * w * 0.31, (0.5 - j) * h * 0.42, w * 0.28, h * 0.36,
          glowOpts(c, (0.5 + rng.next() * 0.7) * gain));
      }
    }
  } else if (content === 'text') {
    face(0, 0, w * 0.9, h * 0.88, glowOpts(Glow.screenWarm, 0.5 * gain));
    for (let i = 0; i < 7; i++) {
      face(-w * 0.06 + rng.range(-0.02, 0.02), h * 0.34 - i * h * 0.1,
        w * rng.range(0.3, 0.72), h * 0.035, { color: lin(0x20242f), mr: [0, 0.6] });
    }
  } else if (content === 'waveform') {
    for (let i = 0; i < 14; i++) {
      const a = rng.range(0.1, 1);
      face(-w * 0.45 + i * (w * 0.068), 0, w * 0.05, h * 0.8 * a, glowOpts(Glow.green, 1.0 * gain));
    }
  } else if (content === 'broadcast') {
    // Tricolour strap under a talking head — Georgescu's national address.
    face(0, h * 0.12, w * 0.86, h * 0.6, glowOpts(Glow.screenWarm, 0.55 * gain));
    face(0, h * 0.2, w * 0.26, h * 0.3, glowOpts(lin(0xd9b79b), 1.1 * gain));
    const bands = [lin(0x002b7f), lin(0xfcd116), lin(0xce1126)];
    for (let i = 0; i < 3; i++) {
      face(-w * 0.3 + i * w * 0.2, -h * 0.3, w * 0.19, h * 0.12, glowOpts(bands[i], 1.5 * gain));
    }
    face(w * 0.22, -h * 0.3, w * 0.3, h * 0.09, glowOpts(Glow.red, 2.0 * gain));
  }
}

export function keyboard(b: DetailBuilder, x: number, y: number, z: number, yaw: number): void {
  b.box(x, y + 0.012, z, 0.44, 0.024, 0.15, yaw, Mat.plasticBlack);
  b.box(x, y + 0.028, z, 0.4, 0.008, 0.12, yaw, { color: lin(0x2e2b36), mr: [0, 0.55] });
  const [mx, mz] = rot(x, z, 0.34, 0.02, yaw);
  b.box(mx, y + 0.018, mz, 0.07, 0.03, 0.11, yaw, Mat.plasticBlack);
}

export function mug(b: DetailBuilder, x: number, y: number, z: number, color = 0xd8d2c4): void {
  b.cyl(x, y, z, 0.042, 0.04, 0.095, 6, { color: lin(color), mr: [0, 0.45] });
  b.box(x + 0.05, y + 0.05, z, 0.012, 0.05, 0.03, 0, { color: lin(color), mr: [0, 0.45] });
}

export function paperStack(
  b: DetailBuilder, x: number, y: number, z: number, yaw: number, n = 4, rng?: Rng,
): void {
  for (let i = 0; i < n; i++) {
    const j = rng ? rng.range(-0.02, 0.02) : 0;
    b.box(x + j, y + 0.004 + i * 0.007, z + j, 0.21, 0.006, 0.3, yaw + j, Mat.paperWhite);
  }
}

/** Desk lamp — arm, head, a warm lens, and a pool on the desk. */
export function deskLamp(
  b: DetailBuilder, x: number, y: number, z: number, yaw: number, on = true,
): LightAnchor | null {
  b.cyl(x, y, z, 0.075, 0.07, 0.018, 6, Mat.darkSteel);
  b.tube(x, y + 0.02, z, x + Math.sin(yaw) * 0.18, y + 0.42, z + Math.cos(yaw) * 0.18, 0.012, 4, Mat.darkSteel);
  const hx = x + Math.sin(yaw) * 0.3;
  const hz = z + Math.cos(yaw) * 0.3;
  b.box(hx, y + 0.44, hz, 0.15, 0.1, 0.13, yaw, Mat.darkSteel);
  if (!on) return null;
  b.box(hx, y + 0.39, hz, 0.11, 0.02, 0.1, yaw, glowOpts(Glow.tungsten, 5.5));
  return anchor(hx, y + 0.36, hz, 0xffc078, 4.2, 4.0, 1);
}

/** Suspended ceiling: tee grid plus lit and unlit panels. */
export function ceilingGrid(
  b: DetailBuilder,
  cx: number, cz: number, hx: number, hz: number, y: number,
  litEvery: number, rng: Rng, tint = Glow.fluorescent, gain = 3.2,
): LightAnchor[] {
  const cell = 1.2;
  const nx = Math.max(1, Math.floor((hx * 2) / cell));
  const nz = Math.max(1, Math.floor((hz * 2) / cell));
  const out: LightAnchor[] = [];
  // Tee bars. MATTE, not brushed aluminium: at 0.05 m wide and a couple of
  // hundred per ceiling, a specular tee turns the whole grid into a field of
  // sparkling dots the moment a light lands on it.
  const tee = { color: lin(0x8b8892), mr: [0.0, 0.72] as [number, number] };
  for (let i = 0; i <= nx; i++) {
    const x = cx - hx + i * (hx * 2 / nx);
    b.box(x, y - 0.02, cz, 0.05, 0.04, hz * 2, 0, tee);
  }
  for (let j = 0; j <= nz; j++) {
    const z = cz - hz + j * (hz * 2 / nz);
    b.box(cx, y - 0.02, z, hx * 2, 0.04, 0.05, 0, tee);
  }
  let k = 0;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = cx - hx + (i + 0.5) * (hx * 2 / nx);
      const z = cz - hz + (j + 0.5) * (hz * 2 / nz);
      const lit = k % litEvery === 0;
      k++;
      if (lit) {
        b.box(x, y - 0.035, z, hx * 2 / nx - 0.08, 0.03, hz * 2 / nz - 0.08, 0,
          glowOpts(tint, gain * rng.range(0.85, 1.1)));
        if (out.length < 6) out.push(anchor(x, y - 0.3, z, 0xd8e6ff, 5.0, 9, 2));
      } else {
        b.box(x, y - 0.03, z, hx * 2 / nx - 0.08, 0.02, hz * 2 / nz - 0.08, 0,
          { color: lin(0x6e6c78), mr: [0, 0.95] });
      }
    }
  }
  return out;
}

/** Bare batten fluorescent, the kind a corridor or a shop actually has. */
export function battenLight(
  b: DetailBuilder, x: number, y: number, z: number, len: number, yaw: number,
  tint: THREE.Color = Glow.fluorescent, gain = 4.0,
): LightAnchor {
  b.box(x, y, z, len, 0.07, 0.11, yaw, Mat.alu);
  b.box(x, y - 0.045, z, len * 0.95, 0.03, 0.085, yaw, glowOpts(tint, gain));
  return anchor(x, y - 0.45, z, 0xd8e6ff, 5.6, 11, 2);
}

/** Pendant on a flex. */
export function pendant(
  b: DetailBuilder, x: number, yCeil: number, z: number, drop: number,
  shade = 0x2a2630, tint: THREE.Color = Glow.tungsten, gain = 6,
): LightAnchor {
  b.tube(x, yCeil, z, x, yCeil - drop, z, 0.008, 4, Mat.darkSteel);
  const y = yCeil - drop;
  b.cyl(x, y, z, 0.02, 0.17, 0.16, 8, { color: lin(shade), mr: [0.3, 0.5] }, false);
  b.box(x, y - 0.01, z, 0.26, 0.02, 0.26, 0, glowOpts(tint, gain));
  return anchor(x, y - 0.25, z, 0xffc078, 9.0, 9.0, 2);
}

/** Cable snake: a sagging bundle between two points. */
export function cableRun(
  b: DetailBuilder,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  r = 0.02, sag = 0.12, seg = 4, o: DetailOpts = Mat.rubber,
): void {
  let px = x0;
  let py = y0;
  let pz = z0;
  for (let i = 1; i <= seg; i++) {
    const t = i / seg;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
    b.tube(px, py, pz, x, y, z, r, 4, o);
    px = x; py = y; pz = z;
  }
}

/** Wall-mounted whiteboard with marker strokes and sticky notes. */
export function whiteboard(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number, w: number, h: number, rng: Rng,
): void {
  b.box(x, y, z, w, h, 0.05, yaw, Mat.alu);
  const [fx, fz] = rot(x, z, 0, -0.032, yaw);
  b.box(fx, y, fz, w - 0.06, h - 0.06, 0.012, yaw, { color: lin(0xe4e0d6), mr: [0, 0.35] });
  const ink = [lin(0x1c2430), lin(0x8d2230), lin(0x1f5c34)];
  for (let i = 0; i < 12; i++) {
    const lw = rng.range(0.1, w * 0.4);
    const [sx, sz] = rot(x, z, rng.range(-w * 0.4, w * 0.4) , -0.04, yaw);
    b.box(sx, y + rng.range(-h * 0.35, h * 0.35), sz, lw, 0.022, 0.006, yaw,
      { color: ink[rng.int(0, 3)], mr: [0, 0.6] });
  }
  for (let i = 0; i < 5; i++) {
    const [sx, sz] = rot(x, z, rng.range(-w * 0.42, w * 0.42), -0.045, yaw);
    b.box(sx, y + rng.range(-h * 0.36, h * 0.36), sz, 0.09, 0.09, 0.005, yaw,
      { color: rng.bool(0.5) ? lin(0xe8c84a) : lin(0xe07a9a), mr: [0, 0.8] });
  }
  // Pen tray.
  const [tx, tz] = rot(x, z, 0, -0.07, yaw);
  b.box(tx, y - h / 2 - 0.03, tz, w * 0.7, 0.03, 0.09, yaw, Mat.alu);
}

/** Open shelving with clutter on it. */
export function shelfUnit(
  b: DetailBuilder,
  x: number, z: number, yaw: number, w: number, h: number, depth: number,
  shelves: number, rng: Rng, frame: DetailOpts = Mat.darkSteel,
  fill: 'files' | 'awards' | 'stock' | 'bottles' | 'none' = 'files',
  y0 = 0,
): void {
  for (const s of [-1, 1]) {
    const [px, pz] = rot(x, z, s * (w / 2 - 0.03), 0, yaw);
    b.box(px, y0 + h / 2, pz, 0.05, h, depth, yaw, frame);
  }
  for (let i = 0; i <= shelves; i++) {
    const sy = y0 + (i / shelves) * h;
    b.box(x, sy, z, w, 0.035, depth, yaw, frame);
    if (i === shelves || fill === 'none') continue;
    let cursor = -w / 2 + 0.06;
    let guard = 0;
    while (cursor < w / 2 - 0.1 && guard++ < 22) {
      const bw = rng.range(0.05, 0.14);
      const bh = rng.range(0.16, 0.29);
      const [ix, iz] = rot(x, z, cursor + bw / 2, rng.range(-0.02, 0.02), yaw);
      if (fill === 'files') {
        b.box(ix, sy + bh / 2 + 0.02, iz, bw, bh, depth * 0.8, yaw, {
          color: [lin(0x6d3b2a), lin(0x2f4a63), lin(0x5a5a4a), lin(0x77604a)][rng.int(0, 4)],
          mr: [0, 0.85],
        });
      } else if (fill === 'awards') {
        // Plinth + a small bright form on it.
        b.box(ix, sy + 0.035, iz, 0.11, 0.07, 0.11, yaw, Mat.woodDark);
        b.box(ix, sy + 0.14, iz, 0.05, 0.14, 0.05, yaw,
          rng.bool(0.5) ? glowOpts(Glow.amber, 0.5) : Mat.alu);
        cursor += 0.16;
        continue;
      } else if (fill === 'stock') {
        b.box(ix, sy + bh / 2 + 0.02, iz, bw * 1.6, bh * 0.7, depth * 0.7, yaw, {
          color: [lin(0xc23a3a), lin(0xd8b23a), lin(0x3a7ac2), lin(0x39a05a), lin(0xd0d0c4)][rng.int(0, 5)],
          mr: [0, 0.6],
        });
        cursor += bw * 1.7;
        continue;
      } else if (fill === 'bottles') {
        b.cyl(ix, sy + 0.04, iz, 0.033, 0.03, 0.2, 5, {
          color: [lin(0x2f5a2a), lin(0x6d3a18), lin(0x22303f), lin(0x8a6a2a)][rng.int(0, 4)],
          mr: [0.2, 0.22],
        }, false);
        b.cyl(ix, sy + 0.24, iz, 0.012, 0.012, 0.07, 4, Mat.glassDark, true);
        cursor += 0.085;
        continue;
      }
      cursor += bw + 0.012;
    }
  }
}

/** Filing / storage cabinet. */
export function cabinet(
  b: DetailBuilder, x: number, z: number, yaw: number, w = 0.9, h = 1.3, d = 0.5,
  o: DetailOpts = Mat.plasticGrey,
): void {
  b.box(x, h / 2, z, w, h, d, yaw, o);
  const drawers = Math.max(2, Math.round(h / 0.34));
  for (let i = 0; i < drawers; i++) {
    const y = 0.14 + i * (h - 0.2) / drawers;
    const [hx, hz] = rot(x, z, 0, -d / 2 - 0.01, yaw);
    b.box(hx, y, hz, w * 0.62, 0.03, 0.03, yaw, Mat.alu);
  }
}

/** A person standing about, in five boxes plus a head. Static dressing only. */
export function figure(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number,
  cloth: DetailOpts, rng: Rng, seated = false,
): void {
  const skin = rng.bool(0.5) ? Mat.skin : Mat.skinDark;
  const legY = seated ? y + 0.42 : y + 0.42;
  if (seated) {
    b.box(x, y + 0.44, z, 0.34, 0.16, 0.42, yaw, cloth);
    const [kx, kz] = rot(x, z, 0, 0.28, yaw);
    b.box(kx, y + 0.24, kz, 0.3, 0.42, 0.16, yaw, cloth);
    b.box(x, y + 0.78, z, 0.42, 0.52, 0.24, yaw, cloth);
  } else {
    for (const s of [-1, 1]) {
      const [lx, lz] = rot(x, z, s * 0.1, 0, yaw);
      b.box(lx, legY, lz, 0.15, 0.84, 0.18, yaw, Mat.plasticBlack);
    }
    b.box(x, y + 1.16, z, 0.44, 0.62, 0.25, yaw, cloth);
    for (const s of [-1, 1]) {
      const [ax, az] = rot(x, z, s * 0.27, 0.02, yaw);
      b.box(ax, y + 1.12, az, 0.11, 0.56, 0.13, yaw, cloth);
    }
  }
  const headY = seated ? y + 1.16 : y + 1.62;
  b.box(x, headY, z, 0.19, 0.22, 0.2, yaw, skin);
  b.box(x, headY + 0.11, z, 0.2, 0.06, 0.21, yaw, Mat.hair);
}

/* ------------------------------------------------------------------ */
/* Bigger set pieces                                                   */
/* ------------------------------------------------------------------ */

/** Broadcast pedestal camera: base, column, body, lens, viewfinder, tally. */
export function studioCamera(
  b: DetailBuilder, x: number, z: number, yaw: number, y = 0, tally = true,
): void {
  for (let i = 0; i < 3; i++) {
    const a = yaw + (i / 3) * Math.PI * 2;
    b.box(x + Math.sin(a) * 0.34, y + 0.06, z + Math.cos(a) * 0.34, 0.1, 0.12, 0.7, a, Mat.darkSteel);
    b.cyl(x + Math.sin(a) * 0.62, y, z + Math.cos(a) * 0.62, 0.09, 0.09, 0.14, 6, Mat.rubber);
  }
  b.cyl(x, y + 0.1, z, 0.09, 0.075, 1.1, 8, Mat.alu, false);
  const bodyY = y + 1.28;
  b.box(x, bodyY, z, 0.34, 0.3, 0.62, yaw, Mat.darkSteel);
  const [lx, lz] = rot(x, z, 0, 0.44, yaw);
  b.cyl(lx, bodyY - 0.06, lz, 0.11, 0.12, 0.02, 8, Mat.black);
  b.box(lx, bodyY, lz, 0.22, 0.22, 0.3, yaw, Mat.black);
  const [vx, vz] = rot(x, z, -0.22, -0.1, yaw);
  b.box(vx, bodyY + 0.2, vz, 0.16, 0.13, 0.12, yaw, Mat.plasticBlack);
  b.box(vx, bodyY + 0.2, vz - 0.07, 0.13, 0.1, 0.01, yaw, glowOpts(Glow.cold, 1.2));
  // Pan bars.
  for (const s of [-1, 1]) {
    const [hx2, hz2] = rot(x, z, s * 0.2, -0.36, yaw);
    b.tube(hx2, bodyY - 0.05, hz2, hx2, bodyY - 0.16, hz2 - 0.34, 0.016, 4, Mat.darkSteel);
  }
  if (tally) {
    const [tx, tz] = rot(x, z, 0, 0.3, yaw);
    b.box(tx, bodyY + 0.19, tz, 0.1, 0.05, 0.04, yaw, glowOpts(Glow.red, 6));
  }
}

/** Lighting truss: two chords, verticals and diagonals. */
export function truss(
  b: DetailBuilder,
  x0: number, z0: number, x1: number, z1: number, y: number, size = 0.3,
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 0.2) return;
  const ux = dx / len;
  const uz = dz / len;
  const px = -uz * size / 2;
  const pz = ux * size / 2;
  for (const s of [-1, 1]) {
    for (const dy of [0, size]) {
      b.tube(x0 + px * s, y + dy, z0 + pz * s, x1 + px * s, y + dy, z1 + pz * s, 0.026, 4, Mat.alu);
    }
  }
  const bays = Math.max(2, Math.round(len / 0.9));
  for (let i = 0; i <= bays; i++) {
    const t = i / bays;
    const x = x0 + dx * t;
    const z = z0 + dz * t;
    for (const s of [-1, 1]) {
      b.tube(x + px * s, y, z + pz * s, x + px * s, y + size, z + pz * s, 0.016, 4, Mat.alu);
    }
    b.tube(x + px, y, z + pz, x - px, y + size, z - pz, 0.014, 4, Mat.alu);
  }
}

/** Studio fresnel with barn doors, aimed down and inward. */
export function studioLight(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number,
  tint: THREE.Color = Glow.tungsten, gain = 7, intensity = 11,
): LightAnchor {
  b.box(x, y - 0.06, z, 0.12, 0.12, 0.12, yaw, Mat.darkSteel);
  b.box(x, y - 0.28, z, 0.3, 0.32, 0.3, yaw, Mat.darkSteel);
  for (const s of [-1, 1]) {
    const [fx, fz] = rot(x, z, s * 0.17, 0, yaw);
    b.box(fx, y - 0.44, fz, 0.02, 0.2, 0.28, yaw + s * 0.35, Mat.black);
  }
  b.box(x, y - 0.45, z, 0.24, 0.02, 0.24, yaw, glowOpts(tint, gain));
  return anchor(x, y - 0.55, z, tint === Glow.cold ? 0xa8c4ff : 0xffc078, intensity, 16, 3);
}

/** A grid of small monitors — the gallery's multiview wall. */
export function monitorWall(
  b: DetailBuilder,
  cx: number, cy: number, cz: number, yaw: number,
  cols: number, rows: number, cw: number, ch: number,
  rng: Rng,
): void {
  b.box(cx, cy, cz, cols * cw + 0.12, rows * ch + 0.12, 0.09, yaw, Mat.plasticBlack);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const dx = (i - (cols - 1) / 2) * cw;
      const dy = ((rows - 1) / 2 - j) * ch;
      const [px, pz] = rot(cx, cz, dx, -0.05, yaw);
      const roll = rng.next();
      const tint = roll < 0.2 ? Glow.purple : roll < 0.45 ? Glow.screenWarm : roll < 0.8 ? Glow.screen : Glow.green;
      b.box(px, cy + dy, pz, cw - 0.02, ch - 0.02, 0.01, yaw, glowOpts(tint, rng.range(0.6, 1.6)));
      // A caption strap along the bottom of each feed.
      b.box(px, cy + dy - ch * 0.4, pz - 0.002, cw - 0.04, ch * 0.12, 0.004, yaw,
        glowOpts(Glow.red, 1.2));
    }
  }
}

/** Vision mixer / patch desk: sloped panel, button rows, faders. */
export function controlDesk(
  b: DetailBuilder,
  cx: number, cy: number, cz: number, yaw: number, w: number, rng: Rng,
): void {
  b.box(cx, cy, cz, w, 0.06, 0.9, yaw, Mat.darkSteel);
  b.box(cx, cy - 0.36, cz, w * 0.96, 0.68, 0.7, yaw, Mat.plasticGrey);
  const [px, pz] = rot(cx, cz, 0, 0.16, yaw);
  b.box(px, cy + 0.06, pz, w * 0.9, 0.05, 0.5, yaw, Mat.plasticBlack);
  const cols = Math.max(6, Math.floor(w / 0.11));
  for (let i = 0; i < cols; i++) {
    const dx = (i - (cols - 1) / 2) * (w * 0.88 / cols);
    for (let r = 0; r < 3; r++) {
      const [bx, bz] = rot(cx, cz, dx, 0.06 + r * 0.11, yaw);
      const on = rng.bool(0.28);
      b.box(bx, cy + 0.095, bz, 0.06, 0.02, 0.06, yaw,
        on ? glowOpts(r === 0 ? Glow.red : r === 1 ? Glow.green : Glow.amber, 3.2) : Mat.plasticBlack);
    }
    // Fader.
    const [fx, fz] = rot(cx, cz, dx, -0.2, yaw);
    b.box(fx, cy + 0.075, fz, 0.03, 0.012, 0.16, yaw, Mat.black);
    b.box(fx, cy + 0.095, fz + rng.range(-0.05, 0.05), 0.045, 0.028, 0.035, yaw, Mat.alu);
  }
}

/** Flight case / equipment trunk. */
export function flightCase(
  b: DetailBuilder, x: number, y: number, z: number, yaw: number,
  w = 0.8, h = 0.55, d = 0.55,
): void {
  b.box(x, y + h / 2, z, w, h, d, yaw, { color: lin(0x1b1a20), mr: [0.1, 0.72] });
  // Aluminium extrusion on every edge, faked with two bands.
  b.box(x, y + h - 0.02, z, w + 0.02, 0.05, d + 0.02, yaw, Mat.alu);
  b.box(x, y + 0.03, z, w + 0.02, 0.05, d + 0.02, yaw, Mat.alu);
  for (const s of [-1, 1]) {
    const [cx2, cz2] = rot(x, z, s * (w / 2 - 0.06), d / 2 + 0.01, yaw);
    b.box(cx2, y + h * 0.55, cz2, 0.1, 0.1, 0.03, yaw, Mat.alu);
  }
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      const [wx, wz] = rot(x, z, s * (w / 2 - 0.09), t * (d / 2 - 0.09), yaw);
      b.cyl(wx, y - 0.05, wz, 0.05, 0.05, 0.07, 5, Mat.rubber);
    }
  }
}

/** Tripod with a camera or a light on it. */
export function tripod(
  b: DetailBuilder, x: number, z: number, yaw: number, h: number, head: 'camera' | 'light' | 'none',
  y0 = 0,
): void {
  for (let i = 0; i < 3; i++) {
    const a = yaw + (i / 3) * Math.PI * 2;
    b.tube(x, y0 + h, z, x + Math.sin(a) * h * 0.4, y0, z + Math.cos(a) * h * 0.4, 0.016, 4, Mat.darkSteel);
  }
  b.cyl(x, y0 + h, z, 0.03, 0.03, 0.12, 5, Mat.darkSteel);
  if (head === 'camera') {
    b.box(x, y0 + h + 0.2, z, 0.16, 0.14, 0.34, yaw, Mat.black);
    const [lx, lz] = rot(x, z, 0, 0.24, yaw);
    b.cyl(lx, y0 + h + 0.2, lz, 0.06, 0.07, 0.02, 7, Mat.glassDark);
  } else if (head === 'light') {
    b.box(x, y0 + h + 0.16, z, 0.42, 0.42, 0.1, yaw, Mat.darkSteel);
    b.box(x, y0 + h + 0.16, z - 0.06, 0.36, 0.36, 0.02, yaw, glowOpts(Glow.fluorescent, 4.5));
  }
}

/** Sofa: base, back, arms, cushions. */
export function sofa(
  b: DetailBuilder, x: number, z: number, yaw: number, w = 1.9,
  cloth: DetailOpts = Mat.fabricPurple, y0 = 0,
): void {
  b.box(x, y0 + 0.2, z, w, 0.28, 0.82, yaw, cloth);
  const [bx, bz] = rot(x, z, 0, -0.32, yaw);
  b.box(bx, y0 + 0.52, bz, w, 0.52, 0.2, yaw, cloth);
  for (const s of [-1, 1]) {
    const [ax, az] = rot(x, z, s * (w / 2 - 0.1), 0, yaw);
    b.box(ax, y0 + 0.42, az, 0.2, 0.34, 0.82, yaw, cloth);
  }
  const seats = Math.max(2, Math.round(w / 0.7));
  for (let i = 0; i < seats; i++) {
    const [sx, sz] = rot(x, z, (i - (seats - 1) / 2) * (w * 0.84 / seats), 0.04, yaw);
    b.box(sx, y0 + 0.38, sz, w * 0.8 / seats, 0.1, 0.72, yaw, cloth);
  }
}

export function lowTable(
  b: DetailBuilder, x: number, z: number, yaw: number, w = 1.0, d = 0.6, h = 0.42,
  o: DetailOpts = Mat.woodDark,
): void {
  b.box(x, h, z, w, 0.04, d, yaw, o);
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      const [lx, lz] = rot(x, z, s * (w / 2 - 0.07), t * (d / 2 - 0.07), yaw);
      b.box(lx, h / 2, lz, 0.05, h, 0.05, yaw, o);
    }
  }
}

/** Straight flight of stairs with a handrail. */
export function stairFlight(
  b: DetailBuilder,
  x: number, z: number, yaw: number,
  steps: number, rise: number, going: number, width: number, y0 = 0,
): void {
  for (let i = 0; i < steps; i++) {
    const [sx, sz] = rot(x, z, 0, i * going, yaw);
    b.box(sx, y0 + (i + 0.5) * rise, sz, width, rise, going, yaw, { color: lin(0x6a6560), mr: [0, 0.9] });
    b.box(sx, y0 + (i + 1) * rise + 0.01, sz, width, 0.02, going * 0.94, yaw, { color: lin(0x88827a), mr: [0, 0.85] });
  }
  // Handrail along one side.
  const [r0x, r0z] = rot(x, z, width / 2 - 0.04, 0, yaw);
  const [r1x, r1z] = rot(x, z, width / 2 - 0.04, steps * going, yaw);
  b.tube(r0x, y0 + 0.95, r0z, r1x, y0 + steps * rise + 0.95, r1z, 0.022, 5, Mat.darkSteel);
  for (let i = 0; i <= steps; i += 3) {
    const [px, pz] = rot(x, z, width / 2 - 0.04, i * going, yaw);
    b.tube(px, y0 + i * rise, pz, px, y0 + i * rise + 0.95, pz, 0.014, 4, Mat.darkSteel);
  }
}

/** Lift doors with a call panel and a floor indicator. */
export function liftDoors(
  b: DetailBuilder, x: number, y0: number, z: number, yaw: number, w = 1.1, h = 2.2,
): void {
  b.box(x, y0 + h / 2, z, w + 0.24, h + 0.16, 0.12, yaw, Mat.alu);
  for (const s of [-1, 1]) {
    const [dx, dz] = rot(x, z, s * w / 4, -0.06, yaw);
    b.box(dx, y0 + h / 2, dz, w / 2 - 0.015, h, 0.05, yaw,
      { color: lin(0x8b9199), mr: [0.88, 0.28] });
  }
  const [px, pz] = rot(x, z, w / 2 + 0.22, -0.06, yaw);
  b.box(px, y0 + 1.05, pz, 0.11, 0.2, 0.03, yaw, Mat.darkSteel);
  b.box(px, y0 + 1.05, pz - 0.01, 0.06, 0.06, 0.02, yaw, glowOpts(Glow.amber, 3.5));
  const [ix, iz] = rot(x, z, 0, -0.07, yaw);
  b.box(ix, y0 + h + 0.16, iz, 0.34, 0.14, 0.03, yaw, Mat.plasticBlack);
  b.box(ix, y0 + h + 0.16, iz - 0.01, 0.1, 0.09, 0.01, yaw, glowOpts(Glow.red, 4));
}

/** A wall of letterboxes — the thing that makes a Romanian stairwell read. */
export function letterboxWall(
  b: DetailBuilder,
  cx: number, cy: number, cz: number, yaw: number,
  cols: number, rows: number, rng: Rng,
): void {
  const bw = 0.21;
  const bh = 0.17;
  b.box(cx, cy, cz, cols * bw + 0.08, rows * bh + 0.08, 0.06, yaw, Mat.darkSteel);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const dx = (i - (cols - 1) / 2) * bw;
      const dy = ((rows - 1) / 2 - j) * bh;
      const [px, pz] = rot(cx, cz, dx, -0.055, yaw);
      const worn = rng.next();
      b.box(px, cy + dy, pz, bw - 0.015, bh - 0.015, 0.05, yaw, {
        color: lin(worn < 0.25 ? 0x5a5e52 : worn < 0.6 ? 0x6a6a5e : 0x74705f),
        mr: [0.35, 0.72],
      });
      // Slot + a paper corner sticking out of some of them.
      b.box(px, cy + dy + bh * 0.22, pz - 0.03, bw * 0.66, 0.012, 0.02, yaw, Mat.black);
      if (rng.bool(0.3)) {
        b.box(px, cy + dy + bh * 0.22, pz - 0.05, bw * 0.5, 0.05, 0.01, yaw, Mat.paperWhite);
      }
    }
  }
}

/** Glass-fronted fridge cabinet, back-lit, with bottles inside. */
export function fridgeCabinet(
  b: DetailBuilder,
  x: number, z: number, yaw: number, w: number, h: number, d: number, rng: Rng, y0 = 0,
): LightAnchor {
  b.box(x, y0 + h / 2, z, w, h, d, yaw, { color: lin(0xdedad0), mr: [0.2, 0.5] });
  const [fx, fz] = rot(x, z, 0, -d / 2 + 0.02, yaw);
  /*
   * The glow goes BEHIND the glass, not in front of it. Offset the wrong way
   * it is a blown-out white slab hung on the front of the cabinet, and the
   * shelves, the bottles and the whole point of a lit fridge disappear behind
   * it — which is exactly what it did on the first pass.
   */
  const gx = fx + (x - fx) * 0.62;
  const gz = fz + (z - fz) * 0.62;
  b.box(gx, y0 + h / 2, gz, w - 0.2, h - 0.3, 0.02, yaw, glowOpts(Glow.cold, 0.75));
  const shelves = 4;
  for (let i = 0; i < shelves; i++) {
    const sy = y0 + 0.22 + i * (h - 0.4) / shelves;
    b.box(x, sy, z, w - 0.14, 0.02, d * 0.7, yaw, Mat.alu);
    let cursor = -w / 2 + 0.08;
    let guard = 0;
    while (cursor < w / 2 - 0.1 && guard++ < 20) {
      const [bx, bz] = rot(x, z, cursor, 0, yaw);
      b.cyl(bx, sy + 0.02, bz, 0.031, 0.028, 0.19, 5, {
        color: [lin(0x2f5a2a), lin(0x6d3a18), lin(0xc2a83a)][rng.int(0, 3)],
        mr: [0.15, 0.3],
      }, false);
      cursor += 0.075;
    }
  }
  /*
   * NO PANE ACROSS THE FRONT. An opaque "glass" panel over a display cabinet
   * hides the one thing worth seeing — the lit shelves behind it — and reads
   * as a white slab. What makes a glass door read is its FRAME and its
   * handle, so that is all that is drawn: a mullion ring around an open
   * aperture, and the interior does the rest.
   */
  const frame = { color: lin(0x9aa2ab), mr: [0.85, 0.3] as [number, number] };
  const alongX = Math.abs(Math.cos(yaw)) > 0.5;
  for (const sgn of [-1, 1]) {
    const [ax, az] = rot(x, z, sgn * (w / 2 - 0.05), -d / 2 + 0.02, yaw);
    b.box(ax, y0 + h / 2, az, alongX ? 0.08 : 0.06, h - 0.1, alongX ? 0.06 : 0.08, yaw, frame);
  }
  for (const ty of [y0 + 0.1, y0 + h - 0.08]) {
    b.box(fx, ty, fz, alongX ? w - 0.06 : 0.06, 0.09, alongX ? 0.06 : w - 0.06, yaw, frame);
  }
  // Centre stile and a vertical handle, which is what says "door" at a glance.
  b.box(fx, y0 + h / 2, fz, alongX ? 0.05 : 0.05, h - 0.16, alongX ? 0.05 : 0.05, yaw, frame);
  const [hxp, hzp] = rot(x, z, 0.16, -d / 2 - 0.03, yaw);
  b.box(hxp, y0 + h * 0.55, hzp, 0.04, 0.9, 0.04, yaw, frame);
  return anchor(x, y0 + h * 0.6, z, 0xa8c4ff, 2.6, 5.5, 1);
}

/** Bar counter with a top, a front, a foot rail and a back gantry. */
export function barCounter(
  b: DetailBuilder,
  x0: number, x1: number, z: number, yaw: number, y0 = 0,
): void {
  const w = x1 - x0;
  const cx = (x0 + x1) / 2;
  b.box(cx, y0 + 1.06, z, w, 0.07, 0.62, yaw, Mat.woodWarm);
  b.box(cx, y0 + 0.53, z, w, 1.02, 0.46, yaw, Mat.woodDark);
  // Panelled front.
  const panels = Math.max(3, Math.round(w / 0.8));
  for (let i = 0; i < panels; i++) {
    const px = x0 + (i + 0.5) * (w / panels);
    b.box(px, y0 + 0.55, z - 0.245, w / panels - 0.09, 0.72, 0.02, yaw, Mat.woodWarm);
  }
  b.tube(x0 + 0.1, y0 + 0.18, z - 0.3, x1 - 0.1, y0 + 0.18, z - 0.3, 0.022, 6, {
    color: lin(0xb08a3a), mr: [0.85, 0.28],
  });
}

/** Beer taps on a bar. */
export function beerTaps(b: DetailBuilder, x: number, y: number, z: number, n: number): void {
  b.box(x, y + 0.03, z, 0.1 * n + 0.1, 0.06, 0.16, 0, Mat.alu);
  for (let i = 0; i < n; i++) {
    const px = x - (n - 1) * 0.05 + i * 0.1;
    b.cyl(px, y + 0.06, z, 0.018, 0.018, 0.24, 5, Mat.alu, false);
    b.box(px, y + 0.3, z - 0.05, 0.03, 0.06, 0.1, 0, Mat.alu);
    b.box(px, y + 0.34, z, 0.045, 0.1, 0.02, 0, {
      color: [lin(0xc2382a), lin(0x2a6d3a), lin(0xd8b23a)][i % 3], mr: [0, 0.5],
    });
  }
}

/** Illuminated sign — a lit box with a coloured face. */
export function signBox(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number, w: number, h: number,
  tint: THREE.Color, gain = 4,
): void {
  b.box(x, y, z, w, h, 0.14, yaw, Mat.darkSteel);
  const [fx, fz] = rot(x, z, 0, -0.08, yaw);
  b.box(fx, y, fz, w - 0.06, h - 0.06, 0.02, yaw, glowOpts(tint, gain));
}

/**
 * THE RECORDER MARK — the red circular logo, built as a ring of segments.
 *
 * Twelve segments at this radius is enough that the silhouette reads as a
 * circle from anywhere in the room, and the inner dot is what makes it read as
 * a record button rather than as a ring.
 */
export function recorderMark(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number, r: number,
): void {
  const seg = 20;
  const red = lin(0xe12b32);
  const thick = r * 0.2;
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const px = x + Math.cos(a) * r * Math.cos(yaw);
    const pz = z - Math.cos(a) * r * Math.sin(yaw);
    b.box(px, y + Math.sin(a) * r, pz, thick, thick, 0.05, yaw, {
      color: red, mr: [0, 0.4], emissive: emi(red, 1.5),
    });
  }
  b.cyl(x, y - r * 0.42, z, r * 0.42, r * 0.42, 0.05, 14, {
    color: red, mr: [0, 0.4], emissive: emi(red, 1.5),
  });
  // Wordmark bar under it.
  b.box(x, y - r * 1.5, z, r * 2.4, r * 0.22, 0.04, yaw, {
    color: lin(0xe8e4dc), mr: [0, 0.6], emissive: emi(lin(0xe8e4dc), 0.35),
  });
}

/** Tricolour banner, three cloth panels. */
export function tricolour(
  b: DetailBuilder,
  x: number, y: number, z: number, yaw: number, w: number, h: number, glow = 0,
): void {
  const bands = [lin(0x002b7f), lin(0xfcd116), lin(0xce1126)];
  for (let i = 0; i < 3; i++) {
    const [px, pz] = rot(x, z, (i - 1) * (w / 3), 0, yaw);
    b.box(px, y, pz, w / 3 - 0.01, h, 0.02, yaw, {
      color: bands[i], mr: [0, 0.9],
      emissive: glow > 0 ? emi(bands[i], glow) : undefined,
    });
  }
}

/** Scattered A4 on the floor. */
export function litterPapers(
  b: DetailBuilder,
  cx: number, cz: number, hx: number, hz: number, y: number, n: number, rng: Rng,
): void {
  for (let i = 0; i < n; i++) {
    b.box(
      cx + rng.range(-hx, hx), y + 0.003 + rng.range(0, 0.004), cz + rng.range(-hz, hz),
      0.21, 0.002, 0.297, rng.range(0, Math.PI),
      { color: lin(rng.bool(0.8) ? 0xcfc7b4 : 0xb8ac92), mr: [0, 0.97] },
    );
  }
}
