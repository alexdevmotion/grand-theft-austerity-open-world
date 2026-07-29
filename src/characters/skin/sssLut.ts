/**
 * PRE-INTEGRATED SUBSURFACE SCATTERING LUT (Penner, SIGGRAPH 2011).
 *
 * Skin is translucent: light enters, bounces beneath the surface and leaves
 * somewhere else, reddening as it goes. Without that, skin is indistinguishable
 * from painted plastic, and it is the single biggest anti-plastic win available
 * to a forward renderer like this one — no blur passes, no separate buffers,
 * one texture fetch in the pixel shader.
 *
 * The table is the diffusion profile integrated over a ring of surface at a
 * given curvature, indexed by
 *   u = N.L * 0.5 + 0.5      how the surface is turned away from the light
 *   v = curvature            how fast the incident light is changing
 *
 * Scattering is only visible where the incident light changes, which is exactly
 * why curvature is the second axis: a flat cheek scatters invisibly, the rim of
 * a nostril or the edge of an ear does not.
 *
 * Six-Gaussian skin profile from d'Eon & Luebke, "Advanced Skin Rendering".
 * Generated once at boot; every hero shares the texture.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';

const WIDTH = 128;
const HEIGHT = 48;

/** Curvature axis: v = 0 is flat, v = 1 is a 2 mm radius. */
const MAX_CURVATURE = 0.5;   // 1/mm at v = 1

/** [variance (mm^2), r, g, b] — the classic six-Gaussian skin profile. */
const PROFILE: Array<[number, number, number, number]> = [
  [0.0064, 0.233, 0.455, 0.649],
  [0.0484, 0.100, 0.336, 0.344],
  [0.1870, 0.118, 0.198, 0.000],
  [0.5670, 0.113, 0.007, 0.007],
  [1.9900, 0.358, 0.004, 0.000],
  [7.4100, 0.078, 0.000, 0.000],
];

function scatter(r: number, out: [number, number, number]): void {
  out[0] = 0; out[1] = 0; out[2] = 0;
  for (const [v, cr, cg, cb] of PROFILE) {
    const g = Math.exp(-(r * r) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
    out[0] += g * cr;
    out[1] += g * cg;
    out[2] += g * cb;
  }
}

let cached: THREE.DataTexture | null = null;

/** The shared LUT, built on first use. */
export function sssLut(): THREE.DataTexture {
  if (cached) return cached;

  const data = new Uint8Array(WIDTH * HEIGHT * 4);
  const w: [number, number, number] = [0, 0, 0];

  for (let y = 0; y < HEIGHT; y++) {
    // v -> curvature -> the radius of the sphere the light is wrapping around.
    const v = (y + 0.5) / HEIGHT;
    const curvature = v * MAX_CURVATURE;
    const radius = curvature > 1e-4 ? 1 / curvature : 1e6;

    for (let x = 0; x < WIDTH; x++) {
      const cosTheta = ((x + 0.5) / WIDTH) * 2 - 1;
      const theta = Math.acos(Math.min(1, Math.max(-1, cosTheta)));

      let tw0 = 0, tw1 = 0, tw2 = 0;
      let tl0 = 0, tl1 = 0, tl2 = 0;
      const inc = 0.02;
      for (let a = -Math.PI / 2; a <= Math.PI / 2; a += inc) {
        const sampleAngle = theta + a;
        const diffuse = Math.max(0, Math.cos(sampleAngle));
        // Arc length along the surface between the shaded point and the sample.
        const dist = Math.abs(2 * radius * Math.sin(a * 0.5));
        scatter(dist, w);
        tw0 += w[0]; tw1 += w[1]; tw2 += w[2];
        tl0 += diffuse * w[0]; tl1 += diffuse * w[1]; tl2 += diffuse * w[2];
      }

      const o = (y * WIDTH + x) * 4;
      data[o] = clamp255((tw0 > 0 ? tl0 / tw0 : 0) * 255);
      data[o + 1] = clamp255((tw1 > 0 ? tl1 / tw1 : 0) * 255);
      data[o + 2] = clamp255((tw2 > 0 ? tl2 / tw2 : 0) * 255);
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, WIDTH, HEIGHT, THREE.RGBAFormat);
  tex.name = 'skin-sss-lut';
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}
