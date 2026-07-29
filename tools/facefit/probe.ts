/**
 * FACE PROBE — rasterise each per-vertex shading term of the head in isolation,
 * so a stripe or a seam can be attributed to the term that carries it instead of
 * being tuned for by guesswork.
 *
 * Two previous midline seams in this codebase were found by staring at lit
 * renders, which is slow and produces confident wrong answers: a lit render
 * multiplies albedo, cavity, curvature-driven scattering, roughness and the
 * micro-normal together, so any one of them can be blamed for what another one
 * did. Every one of those terms is authored per vertex in `headMesh.ts`, so all
 * of them can be read straight out of the buffer with no renderer at all.
 *
 *   bun tools/facefit/probe.ts [castId]
 *
 * Writes `tools/out/probe/<term>.png`, an orthographic front view of the head
 * with that term as greyscale and nothing else in it.
 *
 * Studio-only; `tools/` is not shipped.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { CAST } from '../../src/characters/face/heroHead';
import { buildHeadGeometry } from '../../src/characters/face/headMesh';
import type { CastId } from '../../src/characters/face/fitData';
import { bodyMetrics } from '../../src/characters/rig';

const id = (process.argv[2] ?? 'player') as CastId;
const M = bodyMetrics('average', false);
const cfg = CAST[id];
const { geometry } = buildHeadGeometry({
  cloud: cfg.cloud(), chinY: M.headY - 0.010, crownY: M.headTopY, skin: cfg.skin,
  beard: cfg.beardShade, beardColor: cfg.beardColor, hairColor: cfg.hairColor,
  tired: cfg.tired, age: cfg.age, jawPush: cfg.jawPush, browPush: cfg.browPush,
  hairline: cfg.hair.hairline, seed: 0x51a5e,
});

const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
const nrm = geometry.getAttribute('normal') as THREE.BufferAttribute;
const col = geometry.getAttribute('color') as THREE.BufferAttribute;
const skin = geometry.getAttribute('aSkin') as THREE.BufferAttribute;
const index = geometry.getIndex()!;

let maxY = -Infinity, minY = Infinity;
for (let i = 0; i < pos.count; i++) {
  maxY = Math.max(maxY, pos.getY(i));
  minY = Math.min(minY, pos.getY(i));
}

/* Orthographic front camera over the face only. */
const W = 460, H = 620;
const CX = 0.0;
const HALF = 0.105;                       // +-105 mm across
const TOP = maxY - 0.012;
const BOT = TOP - (2 * HALF) * (H / W);

const sx = (x: number): number => ((x - (CX - HALF)) / (2 * HALF)) * W;
const sy = (y: number): number => ((TOP - y) / (TOP - BOT)) * H;

/** Rasterise one scalar over the front-facing triangles, z-buffered. */
function raster(f: (i: number) => number, lo: number, hi: number): Uint8Array {
  const img = new Uint8Array(W * H * 3);
  const zb = new Float32Array(W * H).fill(-Infinity);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t), i1 = index.getX(t + 1), i2 = index.getX(t + 2);
    a.set(sx(pos.getX(i0)), sy(pos.getY(i0)), pos.getZ(i0));
    b.set(sx(pos.getX(i1)), sy(pos.getY(i1)), pos.getZ(i1));
    c.set(sx(pos.getX(i2)), sy(pos.getY(i2)), pos.getZ(i2));
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
    const v0 = f(i0), v1 = f(i1), v2 = f(i2);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const X = px + 0.5, Y = py + 0.5;
        let w0 = ((b.x - a.x) * (Y - a.y) - (X - a.x) * (b.y - a.y)) / area;
        let w1 = ((X - a.x) * (c.y - a.y) - (c.x - a.x) * (Y - a.y)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        // w0 weights c, w1 weights b, w2 weights a.
        const z = a.z * w2 + b.z * w1 + c.z * w0;
        const k = py * W + px;
        if (z <= zb[k]) continue;
        zb[k] = z;
        const v = v2 * w2 + v1 * w1 + v0 * w0;
        const g = Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));
        img[k * 3] = g; img[k * 3 + 1] = g; img[k * 3 + 2] = g;
      }
    }
  }
  return img;
}

function png(path: string, rgb: Uint8Array): void {
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

let TABLE: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const lum = (i: number): number =>
  col.getX(i) * 0.2126 + col.getY(i) * 0.7152 + col.getZ(i) * 0.0722;

mkdirSync('tools/out/probe', { recursive: true });
const terms: Array<[string, (i: number) => number, number, number]> = [
  ['albedo', lum, 0.02, 0.24],
  ['albedo-r', (i) => col.getX(i), 0.02, 0.32],
  ['cavity', (i) => skin.getZ(i), 0.35, 1.0],
  ['roughness', (i) => skin.getW(i), 0.25, 0.65],
  ['curvature', (i) => skin.getX(i), -60, 260],
  ['thickness', (i) => skin.getY(i), 0, 0.9],
  ['normal-x', (i) => nrm.getX(i), -0.7, 0.7],
  ['normal-z', (i) => nrm.getZ(i), 0.2, 1.0],
  ['depth', (i) => pos.getZ(i), 0.0, 0.16],
];
for (const [name, f, lo, hi] of terms) {
  png(`tools/out/probe/${name}.png`, raster(f, lo, hi));
}
console.log(`wrote tools/out/probe/*.png for ${id}`);
