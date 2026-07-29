/**
 * One shared 1024² canvas atlas for every vehicle in the city.
 *
 * The atlas is multiplied by the per-vertex paint colour, so it only carries
 * *detail*: grime, rust, scratches, grille slats, lens ribs, upholstery, plates
 * and the sticker decals that make the Dacia look lived-in. Alpha < 1 is used
 * only in the decal cells (the body materials run with alphaTest).
 */

import * as THREE from 'three';
import { Rng } from '../core/rng';

/** uv rects: [u0, v0, u1, v1] with v measured from the bottom, as in GL. */
export const UV = {
  /** Flat white — chrome, rubber and anything that wants no texture. */
  white: [0.80, 0.02, 0.95, 0.10],

  bodyBattered: [0.00, 0.50, 0.50, 1.00],
  bodyClean: [0.50, 0.50, 1.00, 1.00],

  grille: [0.000, 0.375, 0.125, 0.500],
  plate: [0.125, 0.375, 0.250, 0.500],
  fabric: [0.250, 0.375, 0.375, 0.500],
  dash: [0.375, 0.375, 0.500, 0.500],
  hubcap: [0.500, 0.375, 0.625, 0.500],
  tread: [0.625, 0.375, 0.750, 0.500],
  headlampGlass: [0.750, 0.375, 0.875, 0.500],
  tailLens: [0.875, 0.375, 1.000, 0.500],

  stickerBolt: [0.000, 0.250, 0.125, 0.375],
  stickerStar: [0.125, 0.250, 0.250, 0.375],
  stickerCircle: [0.250, 0.250, 0.375, 0.375],
  stickerArrow: [0.375, 0.250, 0.500, 0.375],
  tape: [0.500, 0.250, 0.750, 0.375],
  rustPatch: [0.750, 0.250, 1.000, 0.375],

  liveryStripe: [0.000, 0.125, 0.500, 0.250],
  glassGrime: [0.500, 0.125, 1.000, 0.250],

  carpet: [0.000, 0.000, 0.250, 0.125],
  sidewall: [0.250, 0.000, 0.500, 0.125],
  vent: [0.500, 0.000, 0.750, 0.125],
} as const;

export type UVRect = readonly [number, number, number, number];

const SIZE = 1024;

let atlas: THREE.CanvasTexture | null = null;

export function vehicleAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SIZE;
  const g = cv.getContext('2d')!;
  paint(g);
  atlas = new THREE.CanvasTexture(cv);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 8;
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  atlas.needsUpdate = true;
  return atlas;
}

/* ------------------------------------------------------------------ */

/** uv rect → canvas pixel rect (canvas y is flipped relative to uv v). */
function px(r: UVRect): { x: number; y: number; w: number; h: number } {
  const x = r[0] * SIZE;
  const w = (r[2] - r[0]) * SIZE;
  const h = (r[3] - r[1]) * SIZE;
  const y = SIZE - r[3] * SIZE;
  return { x, y, w, h };
}

function withCell(g: CanvasRenderingContext2D, r: UVRect, fn: (c: CanvasRenderingContext2D, w: number, h: number) => void): void {
  const p = px(r);
  g.save();
  g.beginPath();
  g.rect(p.x, p.y, p.w, p.h);
  g.clip();
  g.translate(p.x, p.y);
  fn(g, p.w, p.h);
  g.restore();
}

function clearCell(g: CanvasRenderingContext2D, r: UVRect): void {
  const p = px(r);
  g.clearRect(p.x, p.y, p.w, p.h);
}

function paint(g: CanvasRenderingContext2D): void {
  // Everything starts opaque white so the paint colour comes through clean.
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, SIZE, SIZE);

  paintBody(g, UV.bodyBattered, true);
  paintBody(g, UV.bodyClean, false);

  paintGrille(g);
  paintPlate(g);
  paintFabric(g);
  paintDash(g);
  paintHubcap(g);
  paintTread(g);
  paintHeadlampGlass(g);
  paintTailLens(g);
  paintLivery(g);
  paintGlassGrime(g);
  paintCarpet(g);
  paintSidewall(g);
  paintVent(g);

  // Decals: transparent background, alphaTest cuts them out.
  clearCell(g, UV.stickerBolt);
  clearCell(g, UV.stickerStar);
  clearCell(g, UV.stickerCircle);
  clearCell(g, UV.stickerArrow);
  clearCell(g, UV.tape);
  clearCell(g, UV.rustPatch);
  paintStickerBolt(g);
  paintStickerStar(g);
  paintStickerCircle(g);
  paintStickerArrow(g);
  paintTape(g);
  paintRustPatch(g);

  // The flat-white cell must stay pristine — drawn last.
  const w = px(UV.white);
  g.fillStyle = '#ffffff';
  g.fillRect(w.x, w.y, w.w, w.h);
}

/* ---------------- body panels ---------------- */

function paintBody(g: CanvasRenderingContext2D, rect: UVRect, battered: boolean): void {
  withCell(g, rect, (c, w, h) => {
    const rng = new Rng(battered ? 'dacia-battered' : 'traffic-clean');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);

    // Broad mottling — uneven old paint / oxidation.
    const blobs = battered ? 260 : 120;
    for (let i = 0; i < blobs; i++) {
      const x = rng.range(0, w);
      const y = rng.range(0, h);
      const r = rng.range(w * 0.02, w * 0.16);
      const a = rng.range(0.015, battered ? 0.09 : 0.035);
      const grd = c.createRadialGradient(x, y, 0, x, y, r);
      const v = Math.floor(rng.range(120, 200));
      grd.addColorStop(0, `rgba(${v},${v - 8},${v - 18},${a})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = grd;
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }

    // Grime settles into the lower band of the body (u≈0 / u≈1 = underside).
    for (const edge of [0, w]) {
      const grd = c.createLinearGradient(edge, 0, edge === 0 ? w * 0.22 : w * 0.78, 0);
      grd.addColorStop(0, `rgba(58,44,36,${battered ? 0.72 : 0.4})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = grd;
      c.fillRect(0, 0, w, h);
    }

    if (battered) {
      // Rust blooms with a darker core and a feathered halo.
      for (let i = 0; i < 34; i++) {
        const x = rng.range(0, w);
        const y = rng.range(0, h);
        const r = rng.range(6, 34);
        rustBlob(c, rng, x, y, r);
      }
      // Mud spatter.
      for (let i = 0; i < 900; i++) {
        const x = rng.range(0, w);
        const y = rng.range(0, h);
        const s = rng.range(0.6, 2.6);
        c.fillStyle = `rgba(48,36,28,${rng.range(0.06, 0.3)})`;
        c.beginPath();
        c.arc(x, y, s, 0, Math.PI * 2);
        c.fill();
      }
      // Key scratches and panel creases.
      for (let i = 0; i < 46; i++) {
        c.strokeStyle = `rgba(${rng.bool(0.5) ? '250,246,235' : '54,42,34'},${rng.range(0.08, 0.34)})`;
        c.lineWidth = rng.range(0.6, 2.2);
        c.beginPath();
        let x = rng.range(0, w);
        let y = rng.range(0, h);
        c.moveTo(x, y);
        const seg = rng.int(2, 5);
        for (let s = 0; s < seg; s++) {
          x += rng.range(-40, 40);
          y += rng.range(-16, 16);
          c.lineTo(x, y);
        }
        c.stroke();
      }
    } else {
      for (let i = 0; i < 10; i++) {
        const x = rng.range(0, w);
        const y = rng.range(0, h);
        rustBlob(c, rng, x, y, rng.range(3, 11));
      }
      for (let i = 0; i < 250; i++) {
        const x = rng.range(0, w);
        const y = rng.range(0, h);
        c.fillStyle = `rgba(60,52,46,${rng.range(0.03, 0.14)})`;
        c.fillRect(x, y, rng.range(0.7, 2), rng.range(0.7, 2));
      }
    }
  });
}

function rustBlob(c: CanvasRenderingContext2D, rng: Rng, x: number, y: number, r: number): void {
  const grd = c.createRadialGradient(x, y, 0, x, y, r);
  grd.addColorStop(0, 'rgba(94,44,18,0.92)');
  grd.addColorStop(0.45, 'rgba(132,68,28,0.62)');
  grd.addColorStop(0.8, 'rgba(150,96,52,0.24)');
  grd.addColorStop(1, 'rgba(150,96,52,0)');
  c.fillStyle = grd;
  c.beginPath();
  const pts = 11;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const rr = r * (0.6 + rng.next() * 0.65);
    const xx = x + Math.cos(a) * rr;
    const yy = y + Math.sin(a) * rr;
    if (i === 0) c.moveTo(xx, yy); else c.lineTo(xx, yy);
  }
  c.closePath();
  c.fill();
}

/* ---------------- small cells ---------------- */

function paintGrille(g: CanvasRenderingContext2D): void {
  withCell(g, UV.grille, (c, w, h) => {
    c.fillStyle = '#2a2a30';
    c.fillRect(0, 0, w, h);
    const rows = 7;
    for (let i = 0; i < rows; i++) {
      const y = (i + 0.5) * (h / rows);
      c.fillStyle = '#d8d8e2';
      c.fillRect(0, y - h * 0.028, w, h * 0.038);
      c.fillStyle = 'rgba(255,255,255,0.55)';
      c.fillRect(0, y - h * 0.028, w, h * 0.012);
    }
    // vertical dividers
    for (let i = 1; i < 4; i++) {
      c.fillStyle = '#b9b9c6';
      c.fillRect((i * w) / 4 - 1.5, 0, 3, h);
    }
  });
}

function paintPlate(g: CanvasRenderingContext2D): void {
  withCell(g, UV.plate, (c, w, h) => {
    c.fillStyle = '#f2f2ee';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#0b2f8f';
    c.fillRect(0, 0, w * 0.12, h);
    c.fillStyle = '#ffcc22';
    c.beginPath();
    c.arc(w * 0.06, h * 0.36, w * 0.028, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#ffffff';
    c.font = `bold ${h * 0.22}px sans-serif`;
    c.textAlign = 'center';
    c.fillText('RO', w * 0.06, h * 0.82);
    // The cell is square but gets stretched across a 4:1 plate, so the glyphs
    // are drawn condensed here and come out correctly proportioned on the car.
    c.fillStyle = '#101014';
    c.save();
    c.translate(w * 0.56, h * 0.72);
    c.scale(0.24, 1);
    c.font = `bold ${h * 0.56}px sans-serif`;
    c.textAlign = 'center';
    c.fillText('B 13 DAC', 0, 0);
    c.restore();
    c.strokeStyle = '#101014';
    c.lineWidth = 2;
    c.strokeRect(1, 1, w - 2, h - 2);
  });
}

function paintFabric(g: CanvasRenderingContext2D): void {
  withCell(g, UV.fabric, (c, w, h) => {
    const rng = new Rng('vinyl');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 5) {
      c.fillStyle = `rgba(30,24,32,${0.10 + (y % 10 === 0 ? 0.1 : 0)})`;
      c.fillRect(0, y, w, 2);
    }
    for (let i = 0; i < 1400; i++) {
      c.fillStyle = `rgba(40,32,44,${rng.range(0.04, 0.18)})`;
      c.fillRect(rng.range(0, w), rng.range(0, h), 1.4, 1.4);
    }
    // Seam piping down the middle of the cushion.
    c.strokeStyle = 'rgba(20,14,24,0.5)';
    c.lineWidth = 2.5;
    for (const x of [w * 0.3, w * 0.5, w * 0.7]) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
  });
}

function paintDash(g: CanvasRenderingContext2D): void {
  withCell(g, UV.dash, (c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(18,14,22,0.72)';
    c.fillRect(0, 0, w, h);
    // instrument binnacle
    c.fillStyle = 'rgba(6,4,10,0.95)';
    c.beginPath();
    c.ellipse(w * 0.26, h * 0.5, w * 0.15, h * 0.3, 0, 0, Math.PI * 2);
    c.fill();
    for (const cx of [w * 0.2, w * 0.33]) {
      c.strokeStyle = 'rgba(255,190,120,0.85)';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(cx, h * 0.5, h * 0.18, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = 'rgba(255,120,60,0.9)';
      c.beginPath();
      c.moveTo(cx, h * 0.5);
      c.lineTo(cx + h * 0.13, h * 0.36);
      c.stroke();
    }
    // vents + radio
    c.fillStyle = 'rgba(2,2,4,0.9)';
    c.fillRect(w * 0.55, h * 0.28, w * 0.16, h * 0.44);
    c.fillStyle = 'rgba(255,150,80,0.8)';
    c.fillRect(w * 0.575, h * 0.4, w * 0.11, h * 0.09);
    for (let i = 0; i < 5; i++) {
      c.fillStyle = 'rgba(60,52,66,0.9)';
      c.fillRect(w * 0.78, h * 0.24 + i * h * 0.11, w * 0.16, h * 0.05);
    }
  });
}

function paintHubcap(g: CanvasRenderingContext2D): void {
  withCell(g, UV.hubcap, (c, w, h) => {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
    c.fillStyle = '#4a4a52';
    c.fillRect(0, 0, w, h);
    // steel rim
    c.fillStyle = '#8d8d98';
    c.beginPath(); c.arc(cx, cy, R * 0.97, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#2b2b33';
    c.beginPath(); c.arc(cx, cy, R * 0.82, 0, Math.PI * 2); c.fill();
    // hubcap dome
    const grd = c.createRadialGradient(cx - R * 0.25, cy - R * 0.25, R * 0.05, cx, cy, R * 0.72);
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.5, '#c9c9d4');
    grd.addColorStop(1, '#6e6e7a');
    c.fillStyle = grd;
    c.beginPath(); c.arc(cx, cy, R * 0.7, 0, Math.PI * 2); c.fill();
    // cooling slots
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      c.fillStyle = '#20202a';
      c.save();
      c.translate(cx + Math.cos(a) * R * 0.48, cy + Math.sin(a) * R * 0.48);
      c.rotate(a);
      c.fillRect(-R * 0.1, -R * 0.06, R * 0.2, R * 0.12);
      c.restore();
    }
    c.fillStyle = '#3b3b45';
    c.beginPath(); c.arc(cx, cy, R * 0.16, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(40,34,30,0.5)';
    c.lineWidth = 3;
    c.beginPath(); c.arc(cx, cy, R * 0.88, 0.6, 2.4); c.stroke();
  });
}

function paintTread(g: CanvasRenderingContext2D): void {
  withCell(g, UV.tread, (c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(40,40,46,0.35)';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const y = (i / 26) * h;
      c.fillStyle = 'rgba(8,8,10,0.85)';
      c.fillRect(0, y, w, h * 0.014);
      c.save();
      c.translate(0, y);
      c.fillRect(w * 0.18, -h * 0.012, w * 0.14, h * 0.03);
      c.fillRect(w * 0.62, -h * 0.012, w * 0.14, h * 0.03);
      c.restore();
    }
    c.fillStyle = 'rgba(6,6,8,0.8)';
    c.fillRect(w * 0.46, 0, w * 0.05, h);
  });
}

function paintHeadlampGlass(g: CanvasRenderingContext2D): void {
  withCell(g, UV.headlampGlass, (c, w, h) => {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      c.strokeStyle = `rgba(150,160,180,${0.18 + i * 0.02})`;
      c.lineWidth = R * 0.055;
      c.beginPath();
      c.arc(cx, cy, R * (0.14 + i * 0.12), 0, Math.PI * 2);
      c.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      c.strokeStyle = 'rgba(120,130,150,0.22)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      c.stroke();
    }
    // grubby film
    const rng = new Rng('lamp');
    for (let i = 0; i < 160; i++) {
      c.fillStyle = `rgba(90,80,70,${rng.range(0.03, 0.16)})`;
      c.beginPath();
      c.arc(rng.range(0, w), rng.range(0, h), rng.range(1, 5), 0, Math.PI * 2);
      c.fill();
    }
  });
}

function paintTailLens(g: CanvasRenderingContext2D): void {
  withCell(g, UV.tailLens, (c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += w / 14) {
      c.fillStyle = 'rgba(70,20,20,0.32)';
      c.fillRect(x, 0, w / 28, h);
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.fillRect(x + w / 28, 0, w / 60, h);
    }
    for (let y = 0; y < h; y += h / 9) {
      c.fillStyle = 'rgba(60,16,16,0.22)';
      c.fillRect(0, y, w, h / 40);
    }
  });
}

function paintLivery(g: CanvasRenderingContext2D): void {
  withCell(g, UV.liveryStripe, (c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    // Ministry of National De-Acceleration livery: deep blue band + chevrons.
    c.fillStyle = '#0d2f96';
    c.fillRect(0, h * 0.34, w, h * 0.4);
    c.fillStyle = '#ffd400';
    for (let i = 0; i < 18; i++) {
      const x = i * (w / 18);
      c.beginPath();
      c.moveTo(x, h * 0.74);
      c.lineTo(x + w / 36, h * 0.34);
      c.lineTo(x + w / 22, h * 0.34);
      c.lineTo(x + w / 60, h * 0.74);
      c.closePath();
      c.fill();
    }
    c.fillStyle = '#0d2f96';
    c.font = `bold ${h * 0.2}px sans-serif`;
    c.textAlign = 'center';
    c.fillText('MINISTERUL DE-ACCELERĂRII', w * 0.5, h * 0.24);
    c.fillStyle = '#101014';
    c.font = `bold ${h * 0.15}px sans-serif`;
    c.fillText('112', w * 0.5, h * 0.95);
  });
}

function paintGlassGrime(g: CanvasRenderingContext2D): void {
  withCell(g, UV.glassGrime, (c, w, h) => {
    const rng = new Rng('glass-grime');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    // wiper arcs
    c.save();
    c.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 3; i++) {
      c.strokeStyle = `rgba(150,140,150,${0.1 + i * 0.03})`;
      c.lineWidth = h * 0.06;
      c.beginPath();
      c.arc(w * 0.35, h * 1.25, h * (0.85 + i * 0.09), Math.PI * 1.15, Math.PI * 1.85);
      c.stroke();
    }
    c.restore();
    // dust film heavier toward the edges
    const grd = c.createRadialGradient(w * 0.5, h * 0.5, h * 0.15, w * 0.5, h * 0.5, w * 0.6);
    grd.addColorStop(0, 'rgba(180,175,180,0)');
    grd.addColorStop(1, 'rgba(120,112,120,0.55)');
    c.fillStyle = grd;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 700; i++) {
      c.fillStyle = `rgba(120,112,116,${rng.range(0.03, 0.2)})`;
      c.fillRect(rng.range(0, w), rng.range(0, h), rng.range(0.8, 2.4), rng.range(0.8, 2.4));
    }
    // rain streaks
    for (let i = 0; i < 40; i++) {
      const x = rng.range(0, w);
      c.strokeStyle = `rgba(200,196,205,${rng.range(0.05, 0.18)})`;
      c.lineWidth = rng.range(1, 3.4);
      c.beginPath();
      c.moveTo(x, 0);
      c.bezierCurveTo(x + rng.range(-8, 8), h * 0.4, x + rng.range(-10, 10), h * 0.7, x + rng.range(-14, 14), h);
      c.stroke();
    }
  });
}

function paintCarpet(g: CanvasRenderingContext2D): void {
  withCell(g, UV.carpet, (c, w, h) => {
    const rng = new Rng('carpet');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(24,18,26,0.85)';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 2200; i++) {
      c.fillStyle = `rgba(${rng.int(50, 90)},${rng.int(42, 70)},${rng.int(52, 86)},${rng.range(0.1, 0.4)})`;
      c.fillRect(rng.range(0, w), rng.range(0, h), 1.6, 1.6);
    }
  });
}

function paintSidewall(g: CanvasRenderingContext2D): void {
  withCell(g, UV.sidewall, (c, w, h) => {
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(30,30,34,0.28)';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) {
      c.strokeStyle = `rgba(10,10,12,${0.25 + i * 0.05})`;
      c.lineWidth = R * 0.03;
      c.beginPath();
      c.arc(cx, cy, R * (0.55 + i * 0.08), 0, Math.PI * 2);
      c.stroke();
    }
    c.strokeStyle = 'rgba(200,198,206,0.4)';
    c.lineWidth = R * 0.02;
    c.beginPath();
    c.arc(cx, cy, R * 0.78, 0.2, 1.5);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, R * 0.78, 3.4, 4.7);
    c.stroke();
  });
}

function paintVent(g: CanvasRenderingContext2D): void {
  withCell(g, UV.vent, (c, w, h) => {
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) {
      const y = (i / 16) * h;
      c.fillStyle = 'rgba(20,18,26,0.75)';
      c.fillRect(0, y, w, h * 0.032);
      c.fillStyle = 'rgba(210,210,225,0.35)';
      c.fillRect(0, y + h * 0.032, w, h * 0.012);
    }
  });
}

/* ---------------- decals ---------------- */

function paintStickerBolt(g: CanvasRenderingContext2D): void {
  withCell(g, UV.stickerBolt, (c, w, h) => {
    c.fillStyle = 'rgba(250,246,236,0.96)';
    c.beginPath();
    c.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#1a1024';
    c.beginPath();
    c.moveTo(w * 0.56, h * 0.16);
    c.lineTo(w * 0.34, h * 0.54);
    c.lineTo(w * 0.48, h * 0.54);
    c.lineTo(w * 0.42, h * 0.86);
    c.lineTo(w * 0.68, h * 0.44);
    c.lineTo(w * 0.52, h * 0.44);
    c.closePath();
    c.fill();
  });
}

function paintStickerStar(g: CanvasRenderingContext2D): void {
  withCell(g, UV.stickerStar, (c, w, h) => {
    c.fillStyle = 'rgba(24,14,34,0.95)';
    c.beginPath();
    c.arc(w / 2, h / 2, w * 0.44, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#f4e9ff';
    c.font = `bold ${h * 0.4}px sans-serif`;
    c.textAlign = 'center';
    c.fillText('B★', w * 0.5, h * 0.62);
    c.strokeStyle = 'rgba(196,74,208,0.95)';
    c.lineWidth = w * 0.05;
    c.beginPath();
    c.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2);
    c.stroke();
  });
}

function paintStickerCircle(g: CanvasRenderingContext2D): void {
  withCell(g, UV.stickerCircle, (c, w, h) => {
    c.fillStyle = 'rgba(240,238,232,0.95)';
    c.beginPath();
    c.arc(w / 2, h / 2, w * 0.42, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#c8102e';
    c.lineWidth = w * 0.07;
    c.beginPath();
    c.arc(w / 2, h / 2, w * 0.38, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = '#12101c';
    c.font = `bold ${h * 0.46}px sans-serif`;
    c.textAlign = 'center';
    c.fillText('70', w * 0.5, h * 0.66);
  });
}

function paintStickerArrow(g: CanvasRenderingContext2D): void {
  withCell(g, UV.stickerArrow, (c, w, h) => {
    c.fillStyle = 'rgba(74,222,80,0.92)';
    c.beginPath();
    c.arc(w / 2, h / 2, w * 0.4, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#0e1a10';
    c.beginPath();
    c.moveTo(w * 0.28, h * 0.56);
    c.lineTo(w * 0.56, h * 0.56);
    c.lineTo(w * 0.56, h * 0.72);
    c.lineTo(w * 0.78, h * 0.46);
    c.lineTo(w * 0.56, h * 0.22);
    c.lineTo(w * 0.56, h * 0.4);
    c.lineTo(w * 0.28, h * 0.4);
    c.closePath();
    c.fill();
  });
}

function paintTape(g: CanvasRenderingContext2D): void {
  withCell(g, UV.tape, (c, w, h) => {
    // Grubby duct/hazard tape used to hold the front bumper on.
    c.fillStyle = 'rgba(214,206,186,0.97)';
    c.fillRect(0, h * 0.06, w, h * 0.88);
    const rng = new Rng('tape');
    for (let i = 0; i < 300; i++) {
      c.fillStyle = `rgba(90,80,66,${rng.range(0.05, 0.25)})`;
      c.fillRect(rng.range(0, w), rng.range(h * 0.06, h * 0.94), rng.range(1, 5), rng.range(1, 3));
    }
    c.strokeStyle = 'rgba(120,110,92,0.6)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(0, h * 0.08);
    c.lineTo(w, h * 0.1);
    c.stroke();
    c.beginPath();
    c.moveTo(0, h * 0.92);
    c.lineTo(w, h * 0.9);
    c.stroke();
  });
}

function paintRustPatch(g: CanvasRenderingContext2D): void {
  withCell(g, UV.rustPatch, (c, w, h) => {
    const rng = new Rng('rust-decal');
    for (let i = 0; i < 16; i++) {
      rustBlob(c, rng, rng.range(w * 0.15, w * 0.85), rng.range(h * 0.15, h * 0.85), rng.range(w * 0.06, w * 0.2));
    }
    // Feather the border so the decal edge is invisible.
    const grd = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.18, w / 2, h / 2, Math.min(w, h) * 0.52);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(1, 'rgba(0,0,0,1)');
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = grd;
    c.fillRect(0, 0, w, h);
    c.restore();
  });
}
