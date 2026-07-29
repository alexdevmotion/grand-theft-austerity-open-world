/**
 * MICRO-DETAIL — the pore and fine-wrinkle normal layer.
 *
 * At conversational distance pores and fine creases are what say "skin". A
 * smooth normal reads as a balloon no matter how good the scattering is, so a
 * high-frequency normal map is layered over the base normal and projected
 * triplanar-ish in object space, which avoids needing a UV layout on a head
 * whose parametrisation is driven by anatomy rather than by texturing.
 *
 * Two octaves: a dense pore field, and a sparser, more elongated crease field
 * that gives the crow's-feet and forehead scoring their direction.
 *
 * Generated procedurally at boot from the deterministic Rng; nothing is
 * downloaded and nothing is sampled from a photograph.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { Rng } from '../../core/rng';

const SIZE = 256;

let cached: THREE.DataTexture | null = null;

/** Tiling RGB normal map of skin micro-relief. */
export function microNormalMap(): THREE.DataTexture {
  if (cached) return cached;
  const rng = new Rng('skin-micro');

  /* Height field first — normals are derived from it so the map is consistent. */
  const h = new Float32Array(SIZE * SIZE);

  // Pores: small round dents, denser on the whole face than they look.
  const pores = 5200;
  for (let i = 0; i < pores; i++) {
    const cx = rng.next() * SIZE;
    const cy = rng.next() * SIZE;
    const r = rng.range(0.9, 2.3);
    const depth = rng.range(0.25, 1.0);
    splat(h, cx, cy, r, -depth);
  }
  // Raised inter-pore skin islands, which is what actually catches the light.
  for (let i = 0; i < 2600; i++) {
    const cx = rng.next() * SIZE;
    const cy = rng.next() * SIZE;
    splat(h, cx, cy, rng.range(1.6, 4.0), rng.range(0.10, 0.34));
  }
  // Fine creases: short elongated grooves in a preferred direction, which is
  // what makes crow's feet and forehead scoring read as skin rather than noise.
  for (let i = 0; i < 900; i++) {
    const cx = rng.next() * SIZE;
    const cy = rng.next() * SIZE;
    const ang = rng.range(0, Math.PI * 2);
    const len = rng.range(4, 16);
    const w = rng.range(0.7, 1.5);
    const d = rng.range(0.2, 0.7);
    const steps = Math.ceil(len);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      splat(h, cx + Math.cos(ang) * len * (t - 0.5), cy + Math.sin(ang) * len * (t - 0.5), w, -d);
    }
  }

  /* Height -> tangent-space normal. */
  const data = new Uint8Array(SIZE * SIZE * 4);
  const S = 2.6;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const l = h[y * SIZE + ((x + SIZE - 1) % SIZE)];
      const r = h[y * SIZE + ((x + 1) % SIZE)];
      const d = h[((y + SIZE - 1) % SIZE) * SIZE + x];
      const u = h[((y + 1) % SIZE) * SIZE + x];
      let nx = (l - r) * S;
      let ny = (d - u) * S;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len;
      const o = (y * SIZE + x) * 4;
      data[o] = ((nx * 0.5 + 0.5) * 255) | 0;
      data[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      data[o + 2] = ((nz / len * 0.5 + 0.5) * 255) | 0;
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
  tex.name = 'skin-micro-normal';
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

function splat(h: Float32Array, cx: number, cy: number, r: number, amp: number): void {
  const r2 = r * r;
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y <= y1; y++) {
    const yy = ((y % SIZE) + SIZE) % SIZE;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const f = 1 - d2 / r2;
      const xx = ((x % SIZE) + SIZE) % SIZE;
      h[yy * SIZE + xx] += amp * f * f;
    }
  }
}
