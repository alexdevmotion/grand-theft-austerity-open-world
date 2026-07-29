/**
 * Signage: lit Romanian shop fascias, political posters, fly-posted hoardings
 * and the wall-mounted plates that tell you which country you are standing in.
 *
 * All of it is drawn once into two procedural canvas atlases and then rendered
 * with a single InstancedMesh per atlas, so several thousand signs across the
 * city cost exactly two draw calls. Per-instance atlas cell selection is done
 * with an instanced attribute that offsets the UVs in the vertex shader.
 *
 * OWNER: props / street-dressing agent.
 */

import * as THREE from 'three';
import type { Rng } from '../../core/rng';

/* ------------------------------------------------------------------ */
/* Atlas painting                                                      */
/* ------------------------------------------------------------------ */

/** Wide lit shop fascias: 1 column x 8 rows of 1024 x 128. */
export const FASCIA_ROWS = 8;
/** Posters and notices: 4 x 4 cells of 256 x 256. */
export const POSTER_COLS = 4;
export const POSTER_ROWS = 4;

const SHOP_SIGNS: Array<{ text: string; bg: string; fg: string; accent: string }> = [
  { text: 'ALIMENTARA', bg: '#4a1330', fg: '#ffd9a0', accent: '#ff2f8e' },
  { text: 'FARMACIE', bg: '#07301f', fg: '#9dffc6', accent: '#2bff8a' },
  { text: 'NON-STOP · 24h', bg: '#2b0b3c', fg: '#ffc8f0', accent: '#c04ad0' },
  { text: 'PÂINE CALDĂ', bg: '#3a1a06', fg: '#ffcf85', accent: '#ffb14a' },
  { text: 'CASA DE SCHIMB', bg: '#0b1c3f', fg: '#bcd6ff', accent: '#3a5cc8' },
  { text: 'AMANET · LOTO', bg: '#3d0f14', fg: '#ffd2c2', accent: '#ff5a3c' },
  { text: 'BERE · COVRIGI', bg: '#241a05', fg: '#ffe6a8', accent: '#fcd116' },
  { text: 'TUTUN & PRESĂ', bg: '#1a1030', fg: '#d8c6ff', accent: '#7b3fd4' },
];

const POSTERS: Array<{ kind: 'face' | 'text' | 'notice'; title: string; sub: string; bg: string; fg: string }> = [
  { kind: 'face', title: 'GEORGESCU', sub: 'ORDINE · MUNCĂ · BETON', bg: '#2a0f3a', fg: '#ffd9a0' },
  { kind: 'face', title: 'GEORGESCU', sub: 'VOTAȚI ÎNCREDEREA', bg: '#3a0f1a', fg: '#ffe0c0' },
  { kind: 'text', title: 'AUSTERITATE', sub: 'PLANUL NAȚIONAL 2031', bg: '#101a3a', fg: '#bcd6ff' },
  { kind: 'text', title: 'B★ BUILDERSTAR', bg: '#1c0d2e', sub: 'CONSTRUIM VIITORUL', fg: '#e0c4ff' },
  { kind: 'notice', title: 'ÎNCHIS', sub: 'SE LUCREAZĂ', bg: '#2d2418', fg: '#ffd9a0' },
  { kind: 'notice', title: 'DE VÂNZARE', sub: '07XX XXX XXX', bg: '#0e2a20', fg: '#b8f0d0' },
  { kind: 'text', title: 'MITING', sub: 'PIAȚA CONSTITUȚIEI · 19:00', bg: '#3a1010', fg: '#ffc0b0' },
  { kind: 'face', title: 'GEORGESCU', sub: 'PREȘEDINTE', bg: '#141034', fg: '#cfd8ff' },
  { kind: 'notice', title: 'ATENȚIE', sub: 'CADE TENCUIALA', bg: '#3a3208', fg: '#ffe98a' },
  { kind: 'text', title: 'NU PLĂTIM', sub: 'DATORIILE VOASTRE', bg: '#2a0a14', fg: '#ffb0b8' },
  { kind: 'text', title: 'RECORDER', sub: 'INVESTIGAȚII', bg: '#141414', fg: '#ff4d4d' },
  { kind: 'notice', title: 'AFIȘAJ', sub: 'INTERZIS', bg: '#1a1a22', fg: '#a8a8b8' },
  { kind: 'face', title: 'GEORGESCU', sub: 'UN SINGUR DRUM', bg: '#301028', fg: '#ffd0e8' },
  { kind: 'text', title: 'METROU', sub: 'M7 · ÎN CONSTRUCȚIE', bg: '#0a1e2e', fg: '#a0d8ff' },
  { kind: 'notice', title: 'APĂ OPRITĂ', sub: 'ORELE 08–18', bg: '#0f2030', fg: '#bfe0ff' },
  { kind: 'text', title: 'DACIA 1300', sub: 'PIESE · SERVICE', bg: '#2a2408', fg: '#ffe08a' },
];

/* ------------------------------------------------------------------ */
/* Road signs                                                          */
/* ------------------------------------------------------------------ */

/** Road-sign faces: 4 x 4 cells of 256 x 256. */
export const SIGN_COLS = 4;
export const SIGN_ROWS = 4;

/**
 * Which cell of the sign atlas a given sign shape may use. `roadSign()` picks
 * one at random from the matching list, so the mounting geometry and the
 * printed face always agree — an octagonal STOP never lands on a rectangular
 * backing plate.
 */
export const SIGN_CELLS = {
  /** Round: prohibition and speed limits, plus the octagonal STOP. */
  circle: [0, 1, 2, 3, 4],
  /** Triangular: give way and warnings. */
  triangle: [5, 6, 7],
  /** Rectangular: direction and information boards. */
  rect: [8, 9, 10],
  /** Blue square: parking, pedestrian crossing, one way. */
  blue: [11, 12, 13, 14, 15],
} as const;

function ctx2d(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('[props] 2D canvas unavailable');
  return g;
}

function noise(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, rng: Rng): void {
  for (let i = 0; i < n; i++) {
    const a = rng.range(0.02, 0.13);
    g.fillStyle = `rgba(0,0,0,${a.toFixed(3)})`;
    g.fillRect(x + rng.next() * w, y + rng.next() * h, rng.range(2, 26), rng.range(1, 8));
  }
}

/** Lit shop fascias — one wide cell per shop type. */
export function paintFasciaAtlas(rng: Rng): THREE.CanvasTexture {
  const W = 1024;
  const CH = 128;
  const g = ctx2d(W, CH * FASCIA_ROWS);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (let i = 0; i < FASCIA_ROWS; i++) {
    const s = SHOP_SIGNS[i % SHOP_SIGNS.length];
    const y = i * CH;
    g.fillStyle = s.bg;
    g.fillRect(0, y, W, CH);
    // Accent bands top and bottom.
    g.fillStyle = s.accent;
    g.fillRect(0, y + 4, W, 6);
    g.fillRect(0, y + CH - 10, W, 6);
    // Neon tube behind the letters.
    g.globalAlpha = 0.28;
    g.fillStyle = s.accent;
    g.fillRect(40, y + CH * 0.34, W - 80, CH * 0.34);
    g.globalAlpha = 1;
    g.fillStyle = s.fg;
    g.font = `bold ${Math.round(CH * 0.52)}px ui-sans-serif, system-ui, sans-serif`;
    g.fillText(s.text, W / 2, y + CH * 0.52);
    noise(g, 0, y, W, CH, 24, rng);
  }

  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/**
 * Romanian road-sign faces. Real plates, drawn at 256 px so a STOP is legible
 * from across a junction: octagonal red STOP, the inverted-triangle CEDEAZĂ
 * TRECEREA, the yellow priority diamond, blue P parking, speed limits, no
 * entry, pedestrian crossing, one way.
 *
 * Everything is drawn on a transparent cell and mounted on a `PropBuilder`
 * backing plate, so the alpha silhouette gives the octagon and the triangle
 * their real outline instead of a disc with a picture on it.
 */
export function paintSignAtlas(rng: Rng): THREE.CanvasTexture {
  const CELL = 256;
  const g = ctx2d(CELL * SIGN_COLS, CELL * SIGN_ROWS);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  const RED = '#c8232c';
  const WHITE = '#f2efe6';
  const BLUE = '#0d3b8c';
  const YELLOW = '#f2c30d';
  const BLACK = '#141318';

  const poly = (cx: number, cy: number, r: number, n: number, rot: number, fill: string): void => {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  const circ = (cx: number, cy: number, r: number, fill: string): void => {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };
  const txt = (s: string, cx: number, cy: number, px: number, fill: string, weight = 'bold'): void => {
    g.fillStyle = fill;
    g.font = `${weight} ${Math.round(px)}px ui-sans-serif, system-ui, sans-serif`;
    g.fillText(s, cx, cy);
  };

  const H = CELL / 2;
  /** Vertical strip that band-shaped boards occupy: 40% of the cell, centred. */
  const BAND_H = CELL * 0.4;
  const BAND_T = (CELL - BAND_H) / 2;
  for (let i = 0; i < SIGN_COLS * SIGN_ROWS; i++) {
    g.save();
    g.translate((i % SIGN_COLS) * CELL, Math.floor(i / SIGN_COLS) * CELL);
    switch (i) {
      case 0: // STOP
        poly(H, H, H * 0.96, 8, Math.PI / 8, RED);
        poly(H, H, H * 0.86, 8, Math.PI / 8, RED);
        g.strokeStyle = WHITE;
        g.lineWidth = 9;
        g.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = Math.PI / 8 + (k / 8) * Math.PI * 2;
          const x = H + Math.cos(a) * H * 0.82;
          const y = H + Math.sin(a) * H * 0.82;
          if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.closePath();
        g.stroke();
        txt('STOP', H, H + 4, 72, WHITE);
        break;
      case 1: // no entry
        circ(H, H, H * 0.94, RED);
        g.fillStyle = WHITE;
        g.fillRect(H * 0.34, H * 0.86, CELL * 0.66, CELL * 0.13);
        break;
      case 2: // 50
      case 3: { // 30
        circ(H, H, H * 0.94, RED);
        circ(H, H, H * 0.74, WHITE);
        txt(i === 2 ? '50' : '30', H, H + 6, 108, BLACK);
        break;
      }
      case 4: // access interzis / no stopping
        circ(H, H, H * 0.94, RED);
        circ(H, H, H * 0.78, BLUE);
        g.strokeStyle = RED;
        g.lineWidth = 22;
        g.beginPath();
        g.moveTo(H * 0.55, H * 1.45);
        g.lineTo(H * 1.45, H * 0.55);
        g.stroke();
        break;
      case 5: // CEDEAZĂ TRECEREA — inverted triangle
        poly(H, H * 1.06, H * 1.02, 3, Math.PI / 2, RED);
        poly(H, H * 1.0, H * 0.76, 3, Math.PI / 2, WHITE);
        txt('CEDEAZĂ', H, H * 0.82, 25, BLACK);
        txt('TRECEREA', H, H * 1.05, 25, BLACK);
        break;
      case 6: // warning: roadworks
        poly(H, H * 0.92, H * 1.0, 3, -Math.PI / 2, RED);
        poly(H, H * 0.98, H * 0.74, 3, -Math.PI / 2, WHITE);
        g.fillStyle = BLACK;
        g.fillRect(H * 0.86, H * 0.9, H * 0.28, H * 0.55);
        g.beginPath();
        g.moveTo(H * 0.6, H * 1.02);
        g.lineTo(H * 1.4, H * 1.02);
        g.lineTo(H * 1.0, H * 0.72);
        g.closePath();
        g.fill();
        break;
      case 7: // priority diamond
        poly(H, H, H * 0.92, 4, Math.PI / 4, WHITE);
        poly(H, H, H * 0.62, 4, Math.PI / 4, YELLOW);
        break;
      // Boards 8-10 are BANDS, drawn vertically centred in the cell so the
      // printed face sits exactly on the backing plate rather than hanging
      // below it. `BAND_T`/`BAND_B` is the 40% strip they live in.
      case 8: // direction board
        g.fillStyle = BLUE;
        g.fillRect(0, BAND_T, CELL, BAND_H);
        g.strokeStyle = WHITE;
        g.lineWidth = 5;
        g.strokeRect(8, BAND_T + 8, CELL - 16, BAND_H - 16);
        txt('BD. UNIRII', H, BAND_T + BAND_H * 0.34, 32, WHITE);
        txt('CENTRU  \u25B8', H, BAND_T + BAND_H * 0.70, 24, WHITE, '600');
        break;
      case 9: // PIAȚA CONSTITUȚIEI
        g.fillStyle = BLUE;
        g.fillRect(0, BAND_T, CELL, BAND_H);
        g.strokeStyle = WHITE;
        g.lineWidth = 5;
        g.strokeRect(8, BAND_T + 8, CELL - 16, BAND_H - 16);
        txt('P-ȚA', H, BAND_T + BAND_H * 0.32, 30, WHITE);
        txt('CONSTITUȚIEI', H, BAND_T + BAND_H * 0.70, 22, WHITE, '600');
        break;
      case 10: // white regulatory plate with a time restriction
        g.fillStyle = WHITE;
        g.fillRect(0, BAND_T, CELL, BAND_H);
        g.strokeStyle = BLACK;
        g.lineWidth = 5;
        g.strokeRect(8, BAND_T + 8, CELL - 16, BAND_H - 16);
        txt('LUNI–VINERI', H, BAND_T + BAND_H * 0.32, 26, BLACK);
        txt('08 – 18', H, BAND_T + BAND_H * 0.72, 30, BLACK);
        break;
      case 11: // P parking
        g.fillStyle = BLUE;
        g.fillRect(H * 0.1, H * 0.1, CELL * 0.9, CELL * 0.9);
        g.strokeStyle = WHITE;
        g.lineWidth = 8;
        g.strokeRect(H * 0.1 + 12, H * 0.1 + 12, CELL * 0.9 - 24, CELL * 0.9 - 24);
        txt('P', H, H + 6, 130, WHITE);
        break;
      case 12: // pedestrian crossing
        g.fillStyle = BLUE;
        g.fillRect(H * 0.1, H * 0.1, CELL * 0.9, CELL * 0.9);
        poly(H, H * 1.02, H * 0.62, 3, -Math.PI / 2, WHITE);
        g.fillStyle = BLACK;
        for (let k = 0; k < 4; k++) g.fillRect(H * 0.68 + k * 18, H * 1.1, 11, H * 0.32);
        circ(H * 0.98, H * 0.72, 13, BLACK);
        break;
      case 13: // one way — a square blue plate with a white arrow
        g.fillStyle = BLUE;
        g.fillRect(H * 0.1, H * 0.1, CELL * 0.9, CELL * 0.9);
        g.strokeStyle = WHITE;
        g.lineWidth = 8;
        g.strokeRect(H * 0.1 + 12, H * 0.1 + 12, CELL * 0.9 - 24, CELL * 0.9 - 24);
        g.fillStyle = WHITE;
        g.fillRect(H * 0.42, H - 11, CELL * 0.42, 22);
        g.beginPath();
        g.moveTo(H * 1.66, H);
        g.lineTo(H * 1.3, H - 40);
        g.lineTo(H * 1.3, H + 40);
        g.closePath();
        g.fill();
        break;
      default: // bus / taxi bay
        g.fillStyle = BLUE;
        g.fillRect(H * 0.1, H * 0.1, CELL * 0.9, CELL * 0.9);
        g.strokeStyle = WHITE;
        g.lineWidth = 8;
        g.strokeRect(H * 0.1 + 12, H * 0.1 + 12, CELL * 0.9 - 24, CELL * 0.9 - 24);
        txt('BUS', H, H - 12, 60, WHITE);
        txt('TAXI', H, H + 48, 40, WHITE, '600');
        break;
    }
    // Grime and a couple of stickers — a clean sign is a render, not a street.
    noise(g, 0, 0, CELL, CELL, 14, rng);
    if (rng.bool(0.4)) {
      g.fillStyle = `rgba(${rng.int(120, 240)},${rng.int(60, 200)},${rng.int(120, 240)},0.5)`;
      g.fillRect(rng.range(10, 150), rng.range(150, 220), rng.range(28, 70), rng.range(16, 34));
    }
    g.restore();
  }

  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 16;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Political posters, fly-posting and municipal notices. */
export function paintPosterAtlas(rng: Rng): THREE.CanvasTexture {
  const CELL = 256;
  const g = ctx2d(CELL * POSTER_COLS, CELL * POSTER_ROWS);
  g.textAlign = 'center';
  g.textBaseline = 'middle';

  for (let i = 0; i < POSTER_COLS * POSTER_ROWS; i++) {
    const p = POSTERS[i % POSTERS.length];
    const cx = (i % POSTER_COLS) * CELL;
    const cy = Math.floor(i / POSTER_COLS) * CELL;
    g.save();
    g.translate(cx, cy);

    g.fillStyle = p.bg;
    g.fillRect(0, 0, CELL, CELL);

    if (p.kind === 'face') {
      // A stylised political portrait: shoulders, head, hair, hard rim light.
      const grd = g.createLinearGradient(0, 0, 0, CELL);
      grd.addColorStop(0, 'rgba(255,120,60,0.35)');
      grd.addColorStop(1, 'rgba(40,10,60,0.9)');
      g.fillStyle = grd;
      g.fillRect(0, 0, CELL, CELL);
      // Shoulders.
      g.fillStyle = '#15121f';
      g.beginPath();
      g.ellipse(CELL / 2, CELL * 1.02, CELL * 0.46, CELL * 0.34, 0, 0, Math.PI * 2);
      g.fill();
      // Head.
      g.fillStyle = '#c99878';
      g.beginPath();
      g.ellipse(CELL / 2, CELL * 0.5, CELL * 0.185, CELL * 0.235, 0, 0, Math.PI * 2);
      g.fill();
      // Hair.
      g.fillStyle = '#6d6a72';
      g.beginPath();
      g.ellipse(CELL / 2, CELL * 0.35, CELL * 0.2, CELL * 0.12, 0, Math.PI, Math.PI * 2);
      g.fill();
      // Brow / eyes / mouth as dark marks.
      g.fillStyle = 'rgba(20,12,20,0.75)';
      g.fillRect(CELL * 0.41, CELL * 0.47, CELL * 0.07, CELL * 0.022);
      g.fillRect(CELL * 0.52, CELL * 0.47, CELL * 0.07, CELL * 0.022);
      g.fillRect(CELL * 0.455, CELL * 0.60, CELL * 0.09, CELL * 0.018);
      // Collar and tie.
      g.fillStyle = '#e8e4dc';
      g.beginPath();
      g.moveTo(CELL * 0.42, CELL * 0.76);
      g.lineTo(CELL * 0.5, CELL * 0.86);
      g.lineTo(CELL * 0.58, CELL * 0.76);
      g.lineTo(CELL * 0.5, CELL * 0.74);
      g.closePath();
      g.fill();
      g.fillStyle = '#a01828';
      g.beginPath();
      g.moveTo(CELL * 0.48, CELL * 0.8);
      g.lineTo(CELL * 0.52, CELL * 0.8);
      g.lineTo(CELL * 0.53, CELL * 1.0);
      g.lineTo(CELL * 0.47, CELL * 1.0);
      g.closePath();
      g.fill();
      // Rim light from the sunset.
      g.strokeStyle = 'rgba(255,150,90,0.75)';
      g.lineWidth = 4;
      g.beginPath();
      g.ellipse(CELL / 2, CELL * 0.5, CELL * 0.185, CELL * 0.235, 0, Math.PI * 0.15, Math.PI * 0.85);
      g.stroke();
    } else if (p.kind === 'notice') {
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(CELL * 0.06, CELL * 0.06, CELL * 0.88, CELL * 0.88);
      g.strokeStyle = p.fg;
      g.lineWidth = 3;
      g.strokeRect(CELL * 0.08, CELL * 0.08, CELL * 0.84, CELL * 0.84);
    } else {
      // Bold typographic poster with a diagonal band.
      g.save();
      g.translate(CELL / 2, CELL / 2);
      g.rotate(-0.35);
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.fillRect(-CELL, -CELL * 0.16, CELL * 2, CELL * 0.32);
      g.restore();
    }

    // Titles.
    g.fillStyle = p.fg;
    g.font = `bold ${Math.round(CELL * (p.title.length > 10 ? 0.115 : 0.15))}px ui-sans-serif, system-ui, sans-serif`;
    g.fillText(p.title, CELL / 2, p.kind === 'face' ? CELL * 0.9 : CELL * 0.42);
    g.font = `${Math.round(CELL * 0.062)}px ui-sans-serif, system-ui, sans-serif`;
    g.fillText(p.sub, CELL / 2, p.kind === 'face' ? CELL * 0.965 : CELL * 0.56);

    // Weathering: torn corner, damp, paste marks.
    noise(g, 0, 0, CELL, CELL, 40, rng);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.moveTo(CELL, 0);
    g.lineTo(CELL - rng.range(10, 60), 0);
    g.lineTo(CELL, rng.range(10, 70));
    g.closePath();
    g.fill();
    g.restore();
  }

  const t = new THREE.CanvasTexture(g.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/* ------------------------------------------------------------------ */
/* Instanced atlas panels                                              */
/* ------------------------------------------------------------------ */

const CELL_VERT = /* glsl */ `
attribute vec4 aCell;
varying vec4 vCell;
`;

/**
 * Panels sharing one atlas texture, one draw call. `add()` collects, `build()`
 * bakes; the geometry is a unit quad facing +Z, scaled by the instance matrix.
 */
export class AtlasPanels {
  private readonly mats: THREE.Matrix4[] = [];
  private readonly cells: number[] = [];
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(
    private readonly cols: number,
    private readonly rows: number,
  ) {}

  get count(): number {
    return this.mats.length;
  }

  /**
   * Place a panel centred at (x,y,z), `w` x `h` metres, facing (nx, nz).
   * `cell` indexes the atlas in reading order.
   */
  add(
    x: number, y: number, z: number,
    w: number, h: number,
    nx: number, nz: number,
    cell: number,
  ): void {
    const yaw = Math.atan2(nx, nz);
    this._q.setFromAxisAngle(this._up, yaw);
    this._p.set(x, y, z);
    this._s.set(w, h, 1);
    this.mats.push(this._m.clone().compose(this._p, this._q, this._s));
    const c = cell % (this.cols * this.rows);
    const cu = c % this.cols;
    const cv = Math.floor(c / this.cols);
    // v is flipped: canvas row 0 is the top of the texture.
    this.cells.push(cu / this.cols, 1 - (cv + 1) / this.rows, 1 / this.cols, 1 / this.rows);
  }

  /** Place a panel lying flat on the ground, rotated `yaw` about Y. */
  addFlat(
    x: number, y: number, z: number,
    w: number, d: number, yaw: number,
    cell: number,
  ): void {
    this._q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, yaw, 'YXZ'));
    this._p.set(x, y, z);
    this._s.set(w, d, 1);
    this.mats.push(this._m.clone().compose(this._p, this._q, this._s));
    const c = cell % (this.cols * this.rows);
    const cu = c % this.cols;
    const cv = Math.floor(c / this.cols);
    this.cells.push(cu / this.cols, 1 - (cv + 1) / this.rows, 1 / this.cols, 1 / this.rows);
  }

  build(material: THREE.Material, name: string): THREE.InstancedMesh | null {
    const n = this.mats.length;
    if (n === 0) return null;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(this.cells), 4));
    const mesh = new THREE.InstancedMesh(geo, material, n);
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, this.mats[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.computeBoundingSphere();
    return mesh;
  }
}

/**
 * Rewrites every texture UV varying to sample the instance's atlas cell.
 * Applied to any material used with `AtlasPanels`.
 */
export function makeAtlasMaterial(
  map: THREE.Texture,
  opts: {
    emissive?: boolean; emissiveIntensity?: number; roughness?: number; key: string;
    /** Cut out transparent atlas cells — needed for shaped plates (STOP, give way). */
    alphaTest?: number;
    doubleSided?: boolean;
  },
): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map,
    roughness: opts.roughness ?? 0.72,
    metalness: 0.0,
    envMapIntensity: 1.0,
    side: opts.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: opts.alphaTest ?? 0,
    transparent: false,
  });
  if (opts.emissive) {
    m.emissive = new THREE.Color(0xffffff);
    m.emissiveMap = map;
    m.emissiveIntensity = opts.emissiveIntensity ?? 2.0;
  }
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CELL_VERT}`)
      .replace(
        '#include <uv_vertex>',
        /* glsl */ `
        #include <uv_vertex>
        vCell = aCell;
        #ifdef USE_MAP
          vMapUv = vMapUv * aCell.zw + aCell.xy;
        #endif
        #ifdef USE_EMISSIVEMAP
          vEmissiveMapUv = vEmissiveMapUv * aCell.zw + aCell.xy;
        #endif
        `,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vCell;');
  };
  m.customProgramCacheKey = () => `gta-atlas-${opts.key}`;
  m.name = `gta:atlas:${opts.key}`;
  return m;
}
