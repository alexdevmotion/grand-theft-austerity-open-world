/**
 * SHARED MATERIAL LIBRARY — every system pulls its surfaces from here.
 *
 * Everything is procedural: textures are generated into typed arrays at
 * runtime (no downloads, no art pipeline) and every material instance is
 * SHARED, so a city built from these costs one draw call per
 * (geometry, material) pair rather than one per building.
 *
 * The library also owns the WETNESS response. `Materials.setWetness()` is
 * driven from WeatherService each frame; ground materials darken their albedo,
 * collapse their roughness, grow puddles and pick up an anisotropic vertical
 * smear of the sunset sky — the defining feature of the reference frame.
 *
 * USAGE
 *   import { Materials } from '../render/materials';
 *   const m = Materials.get('panelConcrete');            // shared instance
 *   const m2 = Materials.tinted('paintedRender', 0x8a6f5a); // shared per tint
 *
 * OWNER: lighting/materials agent.
 */

import * as THREE from 'three';
import { Atmosphere, Palette } from '../artDirection';
import { Rng } from '../core/rng';

/* ------------------------------------------------------------------ */
/* Colour space — READ THIS BEFORE AUTHORING ANY COLOUR                */
/* ------------------------------------------------------------------ */

/**
 * three's `ColorManagement` is enabled by default since r155, so
 * `new THREE.Color(0xc9a882)` ALREADY decodes sRGB into the linear working
 * space. `src/artDirection.ts` then calls `.convertSRGBToLinear()` on top of
 * that, so every `Palette` entry in this project is decoded TWICE.
 *
 * The consequences were visible in every capture and are the single biggest
 * reason the game rendered as one flat dark mauve wash:
 *
 *   travertine  0xc9a882  intended (0.591, 0.393, 0.223) warm cream
 *                         actual   (0.310, 0.129, 0.043) dark burnt red
 *   asphaltWet  0x0d0a14  intended (0.004, 0.003, 0.007)
 *                         actual   (0.0003,0.0002,0.0005) i.e. pure black
 *   leafOlive   0x5d6a3a  intended (0.106, 0.144, 0.041)
 *                         actual   (0.008, 0.011, 0.003) i.e. pure black
 *
 * Every warm or mid-tone albedo in the city was crushed toward black AND
 * over-saturated toward red, which left the emissive and sky-reflection terms
 * — all of them magenta — as the only things with any value in the frame.
 * Nothing could read as warm because nothing warm had any luminance left.
 *
 * `artDirection.ts` is not this agent's file, so the fix lives here: `srgb()`
 * decodes exactly ONCE whatever `ColorManagement` is doing, and every material
 * module in the world/render tree authors through it.
 */
export const srgb = (hex: number): THREE.Color => {
  const c = new THREE.Color(hex);
  if (!THREE.ColorManagement.enabled) c.convertSRGBToLinear();
  return c;
};

/**
 * The art-direction palette, decoded correctly. Same hexes as
 * `src/artDirection.ts` — that file remains the authored source of truth for
 * the LOOK, this is the source of truth for the NUMBERS.
 */
export const PAL = {
  skyHorizon: srgb(0xff7a3c),
  skyLowBand: srgb(0xff5f86),
  skyMidBand: srgb(0xd0569f),
  skyHighBand: srgb(0x6b4192),
  skyZenith: srgb(0x231a45),
  sunCore: srgb(0xffd9a8),
  sunLight: srgb(0xff9c5a),
  skyAmbient: srgb(0x6d4f9e),
  groundBounce: srgb(0x2a1c33),
  cloudLit: srgb(0xffa477),
  cloudMid: srgb(0xd2679c),
  cloudShadow: srgb(0x4a3670),
  /**
   * ASPHALT. The brief calls for a genuinely dark base at roughly 0.04 linear.
   * The authored 0x0d0a14 lands at 0.004 even when decoded once — a hundred
   * times darker than real tarmac, which is why the road only ever showed its
   * reflection and never its own surface. 0x3a3540 is 0.042 linear with a
   * violet bias, which is what dry asphalt at dusk actually measures.
   */
  asphaltDry: srgb(0x413b47),
  asphaltWet: srgb(0x3a3540),
  sidewalkStone: srgb(0x6b6270),
  travertine: srgb(0xd8b892),
  concreteGrey: srgb(0x8a8390),
  glassTint: srgb(0x1b2340),
  glassSpecular: srgb(0xbfd4ff),
  builderPurple: srgb(0x7b3fd4),
  builderMagenta: srgb(0xc04ad0),
  screenBlue: srgb(0x3a5cc8),
  sodiumLamp: srgb(0xffb14a),
  neonPink: srgb(0xff2f8e),
  scooterGreen: srgb(0x4ade50),
  daciaYellow: srgb(0xd8c33a),
  daciaPurple: srgb(0x6b3fa0),
  daciaRust: srgb(0x9a5f36),
  policeBlue: srgb(0x2b6cff),
  roBlue: srgb(0x002b7f),
  roYellow: srgb(0xfcd116),
  roRed: srgb(0xce1126),
  leafAmber: srgb(0xc99a4a),
  leafOlive: srgb(0x6f7a44),
  trunkBark: srgb(0x4a3b31),
} as const;

/* ------------------------------------------------------------------ */
/* Deterministic tileable noise                                        */
/* ------------------------------------------------------------------ */

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x ^ seed, 374761393) + Math.imul(y ^ (seed >>> 5), 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Value noise that wraps exactly every `period` lattice cells — seamless tiles. */
function tileValue(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (a: number) => ((a % period) + period) % period;
  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const d = hash2(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function tileFbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += tileValue(fx, fy, p, seed + i * 7919) * amp;
    norm += amp;
    fx *= 2;
    fy *= 2;
    p *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Tileable ridged noise — cracks, veins, rust edges. */
function tileRidge(x: number, y: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += (1 - Math.abs(tileValue(fx, fy, p, seed + i * 3571) * 2 - 1)) * amp;
    norm += amp;
    fx *= 2;
    fy *= 2;
    p *= 2;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * Value noise sits on an axis-aligned lattice, so stacking octaves on the same
 * axes leaves a visible square grid — on a road lit by a near-horizontal sun
 * that reads as woven basketwork.
 *
 * Rotating the octaves would decorrelate them but would also destroy
 * seamlessness, because the wrap happens on lattice coordinates and a rotated
 * tile boundary no longer lands on whole cells. Warping the sample position by
 * another TILEABLE noise field achieves the same decorrelation and stays exactly
 * periodic, since a periodic offset added to a periodic coordinate is periodic.
 *
 * `cells` is the number of lattice cells per unit of u/v, and must be an
 * integer for the tile to close.
 */
function warpedValue(u: number, v: number, cells: number, warpCells: number, warp: number, seed: number): number {
  const wx = tileValue(u * warpCells, v * warpCells, warpCells, seed ^ 0x5bd1) - 0.5;
  const wy = tileValue(u * warpCells, v * warpCells, warpCells, seed ^ 0x9e37) - 0.5;
  return tileValue(u * cells + wx * warp, v * cells + wy * warp, cells, seed);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Linear -> sRGB byte, so albedo textures can be flagged SRGBColorSpace. */
function lin2srgbByte(v: number): number {
  const c = clamp01(v);
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/* ------------------------------------------------------------------ */
/* Texture assembly                                                    */
/* ------------------------------------------------------------------ */

interface Surfel {
  /** Linear albedo. */
  r: number;
  g: number;
  b: number;
  /** Height 0..1, used to derive the normal map. */
  h: number;
  rough: number;
  metal: number;
  /** Baked cavity occlusion 0..1. */
  ao: number;
  /** Linear emissive. */
  er?: number;
  eg?: number;
  eb?: number;
}

type Sampler = (u: number, v: number, px: number, py: number) => Surfel;

interface MapSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  /** R = AO, G = roughness, B = metalness (glTF ORM convention). */
  orm: THREE.DataTexture;
  emissiveMap?: THREE.DataTexture;
}

let maxAnisotropy = 8;

function finishTexture(t: THREE.DataTexture, srgb: boolean): THREE.DataTexture {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = maxAnisotropy;
  t.needsUpdate = true;
  return t;
}

/**
 * Runs `sample` once per texel and emits albedo / normal / ORM (and emissive
 * when the sampler produces any). One pass, so a 512² material costs ~260k
 * sampler calls — a few milliseconds, and only on first use.
 */
function buildMaps(size: number, normalStrength: number, sample: Sampler, wantEmissive = false): MapSet {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const emis = wantEmissive ? new Uint8Array(n * 4) : null;
  const height = new Float32Array(n);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const s = sample((x + 0.5) / size, (y + 0.5) / size, x, y);
      const o = i * 4;
      // Bake cavity AO into albedo as well; it survives even when a consumer
      // ignores the ORM map, and it is what stops flat-coloured surfaces.
      albedo[o] = lin2srgbByte(s.r * s.ao);
      albedo[o + 1] = lin2srgbByte(s.g * s.ao);
      albedo[o + 2] = lin2srgbByte(s.b * s.ao);
      albedo[o + 3] = 255;
      orm[o] = Math.round(clamp01(s.ao) * 255);
      orm[o + 1] = Math.round(clamp01(s.rough) * 255);
      orm[o + 2] = Math.round(clamp01(s.metal) * 255);
      orm[o + 3] = 255;
      if (emis) {
        emis[o] = lin2srgbByte(s.er ?? 0);
        emis[o + 1] = lin2srgbByte(s.eg ?? 0);
        emis[o + 2] = lin2srgbByte(s.eb ?? 0);
        emis[o + 3] = 255;
      }
      height[i] = s.h;
    }
  }

  // Sobel the height field into a tangent-space normal map (wrapping).
  const normal = new Uint8Array(n * 4);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = dx * normalStrength;
      let ny = dy * normalStrength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const o = (y * size + x) * 4;
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;
    }
  }

  const out: MapSet = {
    map: finishTexture(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), true),
    normalMap: finishTexture(new THREE.DataTexture(normal, size, size, THREE.RGBAFormat), false),
    orm: finishTexture(new THREE.DataTexture(orm, size, size, THREE.RGBAFormat), false),
  };
  if (emis) {
    out.emissiveMap = finishTexture(new THREE.DataTexture(emis, size, size, THREE.RGBAFormat), true);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shared uniforms — wetness, sun, sky. Live objects, mutated in place. */
/* ------------------------------------------------------------------ */

const SHARED = {
  // Annotated: artDirection is `as const`, so the initialiser would otherwise
  // pin these uniforms to their literal types and make them read-only.
  wetness: { value: Atmosphere.wetness as number },
  sunDir: { value: new THREE.Vector3(-0.95, 0.06, -0.31) },
  skyHorizon: { value: PAL.skyHorizon.clone() },
  skyLow: { value: PAL.skyLowBand.clone() },
  skyMid: { value: PAL.skyMidBand.clone() },
  skyHigh: { value: PAL.skyHighBand.clone() },
  skyZenith: { value: PAL.skyZenith.clone() },
  sunCore: { value: PAL.sunCore.clone() },
  /** Global scale on the analytic sky reflection — dropped at night. */
  skyEnergy: { value: 1.0 as number },
};

/**
 * Analytic sunset sky, mirrored from the sky dome shader. Cheap enough to tap
 * six times per wet pixel, and needs no cube sampler — which is what lets the
 * road smear the sky vertically without a full SSR budget.
 */
const SKY_GLSL = /* glsl */ `
uniform float uWetness;
uniform float uWetAmount;
uniform float uSkyEnergy;
uniform vec3 uSunDirW;
uniform vec3 uSkyHorizon, uSkyLow, uSkyMid, uSkyHigh, uSkyZenith, uSunCoreW;
varying vec3 vWPosG;
varying vec3 vWNormG;

float gWet = 0.0;
float gPuddle = 0.0;

vec3 gtaSky(vec3 d) {
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 s = uSkyHorizon;
  s = mix(s, uSkyLow,    smoothstep(0.480, 0.545, h));
  s = mix(s, uSkyMid,    smoothstep(0.530, 0.630, h));
  s = mix(s, uSkyHigh,   smoothstep(0.600, 0.780, h));
  s = mix(s, uSkyZenith, smoothstep(0.720, 1.000, h));
  float sd = max(dot(d, uSunDirW), 0.0);
  // Deliberately BROADER than the sky dome's own sun. A mirror-sharp disc
  // reflected off a rippled surface resolves into a dense field of white
  // sparkles; widening it turns those same ripples into the long, soft
  // orange smears the reference frame is built on.
  s += uSunCoreW * (pow(sd, 4.0) * 0.62 + pow(sd, 14.0) * 1.15);
  float band = exp(-abs(d.y) * 13.0);
  vec2 dh = normalize(vec2(d.x, d.z) + 1e-5);
  vec2 sh = normalize(vec2(uSunDirW.x, uSunDirW.z) + 1e-5);
  float toward = pow(max(dot(dh, sh), 0.0), 2.0);
  s += mix(uSkyLow, uSkyHorizon, toward) * band * (0.30 + 0.90 * toward);
  return s * uSkyEnergy;
}

float gtaHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float gtaNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gtaHash(i), gtaHash(i + vec2(1, 0)), u.x),
             mix(gtaHash(i + vec2(0, 1)), gtaHash(i + vec2(1, 1)), u.x), u.y);
}

/**
 * World-space procedural noise has no mip chain, so an octave whose period
 * falls below a pixel turns into crawling speckle. pixelWorld is how many
 * metres one pixel covers here; octaves finer than that are faded out, which
 * is the analytic equivalent of a mip level.
 */
float gtaOctave(float freq, float pixelWorld) {
  return 1.0 - smoothstep(0.35, 1.1, freq * pixelWorld * 2.0);
}
`;

/** Vertex additions: world position + world normal, instancing-aware. */
const WORLD_VERT_HEAD = /* glsl */ `
varying vec3 vWPosG;
varying vec3 vWNormG;
`;

const WORLD_VERT_BODY = /* glsl */ `
#include <worldpos_vertex>
{
  vec4 gWp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    gWp = instanceMatrix * gWp;
    vWNormG = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  #else
    vWNormG = normalize(mat3(modelMatrix) * objectNormal);
  #endif
  vWPosG = (modelMatrix * gWp).xyz;
}
`;

/* ------------------------------------------------------------------ */
/* Wetness / anisotropic sky-smear injection                           */
/* ------------------------------------------------------------------ */

export interface WetOptions {
  /** How strongly this surface responds to rain, 0..1. Asphalt 1, stone 0.8. */
  amount?: number;
  /** Puddles only make sense on near-horizontal surfaces. */
  puddles?: boolean;
  /** Strength of the vertical sky smear. */
  mirror?: number;
}

/**
 * Turns a standard material into a wet-capable ground surface:
 *  - albedo darkens and roughness collapses as wetness rises
 *  - world-space puddle mask flattens the normal and mirrors harder
 *  - an anisotropic sky reflection stretched along the view direction, which
 *    is what produces the reference's long orange/magenta vertical smears
 */
function applyWetGround(mat: THREE.MeshStandardMaterial, opts: WetOptions = {}): THREE.MeshStandardMaterial {
  const amount = opts.amount ?? 1.0;
  const puddles = opts.puddles !== false;
  const mirror = opts.mirror ?? 1.0;

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    prev?.call(this, shader, renderer);

    shader.uniforms.uWetness = SHARED.wetness;
    shader.uniforms.uWetAmount = { value: amount };
    shader.uniforms.uSkyEnergy = SHARED.skyEnergy;
    shader.uniforms.uSunDirW = SHARED.sunDir;
    shader.uniforms.uSkyHorizon = SHARED.skyHorizon;
    shader.uniforms.uSkyLow = SHARED.skyLow;
    shader.uniforms.uSkyMid = SHARED.skyMid;
    shader.uniforms.uSkyHigh = SHARED.skyHigh;
    shader.uniforms.uSkyZenith = SHARED.skyZenith;
    shader.uniforms.uSunCoreW = SHARED.sunCore;
    shader.uniforms.uMirror = { value: mirror };
    shader.uniforms.uPuddles = { value: puddles ? 1 : 0 };

    shader.vertexShader = WORLD_VERT_HEAD + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', WORLD_VERT_BODY);

    shader.fragmentShader =
      SKY_GLSL + 'uniform float uMirror;\nuniform float uPuddles;\n' + shader.fragmentShader;

    // Wet darkening + puddle mask, evaluated before anything reads albedo.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      {
        float pw = 0.0;
        // WETNESS IS A MASK, NOT A CONSTANT. Driving every ground pixel from
        // the global Atmosphere.wetness made the street one uniform flooded
        // sheet: no dry crown, no dry strip under an overhang, no kerb line —
        // a lake, not a wet road. The low-frequency term below is what leaves
        // roughly a third of any given stretch merely damp, and it is the
        // contrast between the two that reads as "wet".
        float dampMask = 1.0;
        if (uPuddles > 0.5) {
          float ppx = max(fwidth(vWPosG.x), fwidth(vWPosG.z));
          float p0 = gtaNoise(vWPosG.xz * 0.09);
          float p1 = gtaNoise(vWPosG.xz * 0.28 + 11.3);
          float pool = p0 * 0.72 + mix(0.28 * 0.5, p1 * 0.28, gtaOctave(0.28, ppx));
          // Standing water: the top of the mask only.
          pw = smoothstep(0.60, 0.84, pool);
          // Dry-to-damp: the bottom third of the mask stays above roughness
          // 0.25 so asphalt grain survives somewhere in every frame.
          dampMask = smoothstep(0.24, 0.52, pool);
        }
        gPuddle = pw;
        gWet = clamp(uWetness * uWetAmount, 0.0, 1.0) * dampMask;
      }
      #include <map_fragment>
      diffuseColor.rgb *= mix(1.0, mix(0.48, 0.18, gPuddle), gWet);
      `,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
      #include <roughnessmap_fragment>
      // Open wet tarmac is NOT a mirror — the water film follows the aggregate
      // and scatters. Only standing water in puddles gets near-mirror values.
      // Driving open road down to 0.085 made every surviving normal detail a
      // specular glint and the street read as glitter.
      // 0.30 damp -> 0.035 standing water. The damp end must stay well above
      // mirror territory or the whole road collapses into one reflectivity.
      roughnessFactor = mix(roughnessFactor, mix(0.300, 0.035, gPuddle), gWet);
      `,
    );

    // Standing water FILLS the surface relief. Collapsing roughness without
    // also flattening the normal map is physically wrong and visually fatal:
    // on a near-mirror surface every surviving aggregate bump becomes its own
    // specular glint, and the road turns into a crawling lattice of sparkles
    // under a low sun. Flattening both together is what makes wet tarmac read
    // as a sheet of water rather than as glitter.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #include <normal_fragment_maps>
      normal = normalize(mix(normal, nonPerturbedNormal, gWet * mix(0.94, 0.995, gPuddle)));
      `,
    );

    // Anisotropic mirror. Reflection vector is smeared vertically and jittered
    // across the view axis so highlights run toward the camera in long bands.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      /* glsl */ `
      {
        float wetK = gWet * uMirror;
        if (wetK > 0.001) {
          vec3 Vw = normalize(vWPosG - cameraPosition);
          vec3 Nw = normalize(vWNormG);

          // Streak axis: along the view direction projected onto the ground.
          vec2 fwd = normalize(vec2(Vw.x, Vw.z) + 1e-5);
          vec2 side = vec2(-fwd.y, fwd.x);
          float across = dot(vWPosG.xz, side);
          float along = dot(vWPosG.xz, fwd);

          // Metres of world covered by one pixel here — the analytic mip level.
          float pixW = max(fwidth(across), fwidth(along));

          // Fast across the view axis, slow along it => streaks toward camera.
          // Metre-scale bands, not centimetre speckle.
          float streak = (gtaNoise(vec2(across * 0.34, along * 0.05)) - 0.5) * gtaOctave(0.34, pixW);
          float streak2 = (gtaNoise(vec2(across * 1.05, along * 0.14)) - 0.5) * gtaOctave(1.05, pixW);
          float ripple = (streak * 0.72 + streak2 * 0.28);

          // Puddles are mirror-flat; open wet tarmac keeps some chop. This is
          // what breaks the mirror into bands — with it near zero the road
          // goes uniformly dark and the smears disappear entirely.
          float chop = mix(0.045, 0.010, gPuddle);
          Nw = normalize(Nw + vec3(side.x, 0.0, side.y) * ripple * chop);

          vec3 R = reflect(Vw, Nw);
          // Wide VERTICAL blur of the reflected ray. This is the anisotropy:
          // the sky is smeared along the view axis and left sharp across it,
          // which is what makes reflections run toward the camera in long
          // bands instead of resolving into mirror-image dots.
          // Blur radius scales with roughness AND with how far away the patch
          // is: a fixed-length screen-space spread is what combs a reflection
          // into vertical columns, because every pixel in a row then samples
          // the same offsets. The per-pixel dither breaks the remaining
          // coherence into grain.
          float dist = length(vWPosG - cameraPosition);
          float distK = 1.0 + smoothstep(6.0, 120.0, dist) * 1.6;
          float spread = mix(0.46, 0.10, gPuddle) * distK;
          float dith = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
          vec3 refl = vec3(0.0);
          for (int i = 0; i < 6; i++) {
            float t = (float(i) / 5.0 - 0.5) * 2.0 + dith * 0.33;
            // Cubic weighting concentrates taps near the true ray, so the
            // smear has a bright core and a long soft tail.
            refl += gtaSky(normalize(R + vec3(0.0, t * abs(t) * spread, 0.0)));
          }
          refl *= (1.0 / 6.0);
          // The sky toward the sun is HDR; mirroring it unclamped drove the
          // road past 1.0 and clipped it to white. Compress instead of clip so
          // the smear stays an orange streak rather than becoming a hole.
          float rmax = max(max(refl.r, refl.g), refl.b);
          refl *= 0.85 / max(rmax, 0.85);

          float fres = pow(1.0 - clamp(dot(-Vw, Nw), 0.0, 1.0), 5.0);
          // The streak field modulates reflection STRENGTH as well as normal:
          // a real post-rain road is a patchwork of standing film and merely
          // damp tarmac, so the mirror comes and goes in bands. This is what
          // produces the reference's high in-road dynamic range — a dark
          // violet bed with a handful of very bright streaks running toward
          // the camera — rather than a uniformly lit grey sheet.
          // Headroom matters more than peak strength here: if the base term
          // already saturates the clamp, the band modulation has nothing to
          // work with and the road flattens into a uniform mirror. Keeping the
          // grazing-angle term near 0.6 lets the streaks swing either side of
          // it, which is what reads as wet tarmac rather than as a lake.
          float bands = 0.72 + 0.62 * (ripple + 0.5);
          float k = wetK * mix(0.05, 0.60, fres) * mix(0.70, 1.0, gPuddle) * bands;
          outgoingLight = mix(outgoingLight, refl, clamp(k, 0.0, 0.80));
        }
      }
      #include <opaque_fragment>
      `,
    );
  };

  mat.customProgramCacheKey = () => `wet:${amount}:${puddles}:${mirror}`;
  mat.userData.gtaWet = true;
  // Recorded so tiledFor() can rebuild the injection after cloning — see the
  // note there. Without this the whole wet-ground system silently disappears
  // from every tiled surface in the game.
  mat.userData.gtaWetOpts = { amount, puddles, mirror } satisfies WetOptions;
  return mat;
}

/* ------------------------------------------------------------------ */
/* Surface generators                                                  */
/* ------------------------------------------------------------------ */

const P = PAL;
void Palette;

/*
 * FREQUENCY BUDGET. Every generator keeps its finest lattice cell at 5 texels
 * or coarser. Anything finer aliases into a visible dot grid the moment the
 * surface is seen at an angle — which, for a game about a wet street shot from
 * chest height, is all the time. Micro-detail below that scale is left to the
 * normal map and the roughness variation, where mipmapping handles it
 * gracefully instead of shimmering.
 */
const CELLS = (texels: number, size: number) => Math.max(4, Math.round(size / texels));

/** Asphalt: aggregate speckle, tar patches, hairline cracks, wheel polish. */
function asphaltSampler(wet: boolean): Sampler {
  const base = wet ? P.asphaltWet : P.asphaltDry;
  // 512px map: 42 cells = 12 texels, 88 cells = 5.8 texels.
  return (u, v) => {
    const x = u * 26;
    const y = v * 26;
    // Aggregate: a coarse bed plus a finer grit. Both are domain-warped so the
    // two lattices do not line up into a grid, and both use exact integer cell
    // counts so the 14m tile still closes seamlessly along a boulevard.
    const grain = warpedValue(u, v, 42, 7, 1.6, 991);
    const grain2 = warpedValue(u, v, 88, 11, 1.1, 2287);
    const agg = grain * 0.62 + grain2 * 0.38;
    // Broad tar patches / repairs.
    const patch = tileFbm(x * 0.35, y * 0.35, 26, 4, 4451);
    // Cracks.
    const crack = tileRidge(x * 0.9, y * 0.9, 26, 3, 6607);
    const crackMask = smooth(0.86, 0.98, crack);

    // Aggregate is a RELIEF feature, not an albedo one. Modulating albedo by
    // ±30% at the lattice frequency turned the road into a woven red dot grid
    // the moment it was seen at a grazing angle — mipmaps cannot rescue a
    // pattern whose contrast is that high. Keeping the albedo nearly flat and
    // pushing the aggregate into the height/roughness maps gives the same
    // close-up texture with none of the shimmer, because normals and roughness
    // average gracefully under minification while hard albedo contrast does not.
    const tone = lerp(0.93, 1.07, agg) * lerp(0.84, 1.14, patch);
    const r = base.r * tone;
    const g = base.g * tone;
    const b = base.b * tone;

    // Relief stays shallow. A near-horizontal sun turns any bump into a
    // bright/dark pair, so aggregate modelled at full height becomes a
    // corduroy pattern across the whole road surface.
    const h = agg * 0.22 + patch * 0.4 - crackMask * 0.85;
    const rough = clamp01(lerp(0.95, 0.62, agg) - patch * 0.14 + crackMask * 0.05);
    const ao = clamp01(1 - crackMask * 0.62 - smooth(0.0, 0.35, 1 - agg) * 0.16);
    return { r, g, b, h, rough, metal: 0.0, ao };
  };
}

/** Kerb / cast concrete: smoother, chipped arrises, salt staining. */
const kerbSampler: Sampler = (u, v) => {
  const x = u * 12;
  const y = v * 12;
  const fine = tileValue(x * 3.5, y * 3.5, 42, 313);
  const blot = tileFbm(x * 0.8, y * 0.8, 12, 4, 1201);
  const chip = tileRidge(x * 2.4, y * 2.4, 12, 3, 5077);
  const chipMask = smooth(0.9, 1.0, chip);
  const t = lerp(0.82, 1.18, fine * 0.5 + blot * 0.5);
  const c = P.sidewalkStone;
  return {
    r: c.r * t * 1.18,
    g: c.g * t * 1.14,
    b: c.b * t * 1.1,
    h: fine * 0.4 + blot * 0.4 - chipMask * 0.6,
    rough: clamp01(0.82 - blot * 0.1 + fine * 0.08),
    metal: 0,
    ao: clamp01(1 - chipMask * 0.4 - blot * 0.12),
  };
};

/** Paving stone: bevelled setts with mortar joints and per-sett tone drift. */
const pavingSampler: Sampler = (u, v) => {
  const cells = 6;
  // Running bond: offset every other row.
  const fy = v * cells;
  const row = Math.floor(fy);
  const offset = (row % 2) * 0.5;
  const fx = u * cells + offset;
  const col = Math.floor(fx);
  const lx = fx - col;
  const ly = fy - row;

  const joint = 0.055;
  const dx = Math.min(lx, 1 - lx);
  const dy = Math.min(ly, 1 - ly);
  const edge = Math.min(dx, dy);
  const inJoint = 1 - smooth(joint * 0.4, joint, edge);
  const bevel = smooth(joint, joint * 3.2, edge);

  const id = hash2(col, row, 8123);
  const id2 = hash2(col + 31, row + 17, 4409);
  const speck = tileValue(u * 72, v * 72, 72, 733);

  const stoneTone = lerp(0.68, 1.3, id) * lerp(0.9, 1.1, speck);
  const warm = lerp(0.94, 1.1, id2);
  const c = P.sidewalkStone;

  const mortar = 0.42;
  const mix3 = (a: number, b: number, t: number) => a + (b - a) * t;

  const r = mix3(c.r * stoneTone * warm * 1.25, c.r * mortar, inJoint);
  const g = mix3(c.g * stoneTone * 1.16, c.g * mortar, inJoint);
  const b = mix3(c.b * stoneTone * 1.12, c.b * mortar * 1.1, inJoint);

  return {
    r,
    g,
    b,
    h: (1 - inJoint) * (0.35 + bevel * 0.55) + speck * 0.08 + id * 0.05,
    rough: clamp01(mix3(lerp(0.58, 0.78, id), 0.93, inJoint)),
    metal: 0,
    ao: clamp01(1 - inJoint * 0.65 - (1 - bevel) * 0.18),
  };
};

/** Travertine: warm banded stone with horizontal veins and pitting. */
const travertineSampler: Sampler = (u, v) => {
  const x = u * 8;
  const y = v * 8;
  // Bedding planes run horizontally — squash the noise in Y.
  const band = tileFbm(x * 0.55, y * 4.2, 8, 5, 2711);
  const vein = tileRidge(x * 0.7, y * 5.5, 8, 3, 9137);
  const veinMask = smooth(0.72, 0.95, vein);
  const pit = tileValue(x * 7, y * 7, 56, 1607);
  const pitMask = smooth(0.86, 0.99, pit);
  const grain = tileValue(x * 13, y * 13, 104, 4133);

  const t = lerp(0.78, 1.22, band) * lerp(0.94, 1.06, grain);
  const c = P.travertine;
  const dark = 1 - veinMask * 0.3 - pitMask * 0.45;
  return {
    r: c.r * t * dark,
    g: c.g * t * dark * 0.99,
    b: c.b * t * dark * 0.96,
    h: band * 0.5 - veinMask * 0.3 - pitMask * 0.8 + grain * 0.1,
    rough: clamp01(0.52 + band * 0.16 + veinMask * 0.14 + pitMask * 0.2),
    metal: 0,
    ao: clamp01(1 - pitMask * 0.6 - veinMask * 0.22),
  };
};

/** Painted render: flat wall paint, mottled, blistering and peeling at damp. */
const paintedSampler: Sampler = (u, v) => {
  const x = u * 10;
  const y = v * 10;
  const mottle = tileFbm(x * 0.9, y * 0.9, 10, 5, 3313);
  const dirt = tileFbm(x * 0.4, y * 1.9, 10, 4, 7717);
  const peel = tileFbm(x * 2.3, y * 2.3, 10, 3, 5153);
  const peelMask = smooth(0.62, 0.72, peel);
  const roughStone = tileValue(x * 4.8, y * 4.8, 48, 2003);

  // Base paint is a warm off-white; consumers re-tint via Materials.tinted().
  const paintR = 0.62;
  const paintG = 0.58;
  const paintB = 0.55;
  const under = P.concreteGrey;

  const t = lerp(0.86, 1.14, mottle);
  // Damp staining creeps up from the bottom of the wall.
  const stain = 1 - smooth(0.0, 0.42, v) * 0.0 - (1 - smooth(0.0, 0.3, v)) * dirt * 0.34;

  const r = lerp(paintR * t, under.r * 1.1, peelMask) * stain;
  const g = lerp(paintG * t, under.g * 1.1, peelMask) * stain;
  const b = lerp(paintB * t, under.b * 1.1, peelMask) * stain;

  return {
    r,
    g,
    b,
    h: mottle * 0.35 - peelMask * 0.45 + roughStone * 0.12,
    rough: clamp01(lerp(0.62, 0.9, peelMask) + mottle * 0.08),
    metal: 0,
    ao: clamp01(1 - peelMask * 0.3 - (1 - mottle) * 0.1),
  };
};

/** Communist-era precast panel: big panel joints, rain streaks, aggregate. */
const panelSampler: Sampler = (u, v) => {
  // Two panels across, three up — the classic prefab module.
  const px = u * 2;
  const py = v * 3;
  const jx = Math.min(px - Math.floor(px), 1 - (px - Math.floor(px)));
  const jy = Math.min(py - Math.floor(py), 1 - (py - Math.floor(py)));
  const jointW = 0.018;
  const joint = 1 - smooth(jointW * 0.5, jointW * 1.8, Math.min(jx, jy));

  const pid = hash2(Math.floor(px), Math.floor(py), 6151);
  const agg = tileValue(u * 88, v * 88, 88, 8887);
  const agg2 = tileValue(u * 34, v * 34, 34, 1123);
  const blotch = tileFbm(u * 5, v * 5, 5, 4, 3467);

  // Vertical rain staining below every joint.
  const streakN = tileValue(u * 34, v * 1.2, 34, 4801);
  const streak = smooth(0.5, 0.9, streakN) * smooth(0.0, 0.55, jy) * 0.5;

  const c = P.concreteGrey;
  const t = lerp(0.72, 1.16, agg * 0.4 + agg2 * 0.3 + blotch * 0.3) * lerp(0.9, 1.08, pid);
  const soot = 1 - streak * 0.42 - joint * 0.3;

  return {
    r: c.r * t * soot,
    g: c.g * t * soot * 0.985,
    b: c.b * t * soot * 1.02,
    h: agg * 0.35 + agg2 * 0.25 + blotch * 0.2 - joint * 0.9,
    rough: clamp01(0.86 + agg * 0.1 - blotch * 0.08 + streak * 0.05),
    metal: 0,
    ao: clamp01(1 - joint * 0.7 - streak * 0.25),
  };
};

/** Brushed metal: fine directional scoring, anisotropic-looking roughness. */
const brushedSampler: Sampler = (u, v) => {
  // Long thin scratches along U. 256px map, so 52 cells = 4.9 texels.
  const scratch = tileValue(u * 3.0, v * 52, 52, 2179);
  const scratch2 = tileValue(u * 9.0, v * 26, 26, 6737);
  const blotch = tileFbm(u * 4, v * 4, 4, 3, 4363);
  const s = scratch * 0.6 + scratch2 * 0.4;
  const t = lerp(0.55, 0.86, s) * lerp(0.92, 1.06, blotch);
  return {
    r: 0.52 * t,
    g: 0.53 * t,
    b: 0.56 * t,
    h: s * 0.5,
    rough: clamp01(0.22 + s * 0.24 + blotch * 0.06),
    metal: 1.0,
    ao: clamp01(1 - (1 - s) * 0.12),
  };
};

/** Chrome: near-mirror with faint orange-peel and micro pitting. */
const chromeSampler: Sampler = (u, v) => {
  const peel = tileFbm(u * 14, v * 14, 14, 3, 8171);
  const pit = tileValue(u * 24, v * 24, 24, 3673);
  const pitMask = smooth(0.955, 1.0, pit);
  return {
    r: 0.86,
    g: 0.87,
    b: 0.9,
    h: peel * 0.25 - pitMask * 0.5,
    rough: clamp01(0.035 + peel * 0.05 + pitMask * 0.35),
    metal: 1.0,
    ao: clamp01(1 - pitMask * 0.3),
  };
};

/** Rusted steel: rust blooms eating through paint, pitted and matte. */
const rustSampler: Sampler = (u, v) => {
  const bloom = tileFbm(u * 5, v * 5, 5, 5, 5417);
  const fine = tileFbm(u * 24, v * 24, 24, 4, 9199);
  const rust = clamp01(smooth(0.42, 0.72, bloom * 0.7 + fine * 0.3));
  const pit = tileValue(u * 48, v * 48, 48, 2609);
  const pitMask = smooth(0.8, 1.0, pit) * rust;

  const steelR = 0.36;
  const steelG = 0.37;
  const steelB = 0.4;
  const rc = P.daciaRust;
  const drift = lerp(0.7, 1.35, fine);

  return {
    r: lerp(steelR, rc.r * drift * 1.5, rust),
    g: lerp(steelG, rc.g * drift * 1.2, rust),
    b: lerp(steelB, rc.b * drift * 0.9, rust),
    h: bloom * 0.35 + fine * 0.3 - pitMask * 0.7,
    rough: clamp01(lerp(0.42, 0.95, rust) + pitMask * 0.05),
    metal: clamp01(1 - rust * 0.88),
    ao: clamp01(1 - pitMask * 0.5 - rust * 0.14),
  };
};

/**
 * Glass curtain wall. Mullion grid, per-panel tint drift and per-panel normal
 * tilt so each pane catches a different slice of sky — that mosaic of violet,
 * steel-blue and warm sunset is what sells the tower in the reference. A
 * minority of panels carry an interior glow in the emissive map.
 */
const glassSampler: Sampler = (u, v) => {
  // 9m tile (TILE_METRES) split 6 x 3 gives 1.5m-wide panes on a 3m floor
  // pitch — real curtain-wall proportions. The first pass used an 8x8 grid,
  // which at the same tile size made 1.1m squares and read as an LED disco
  // board rather than a building.
  const cols = 6;
  const rows = 3;
  const fx = u * cols;
  const fy = v * rows;
  const cx = Math.floor(fx);
  const cy = Math.floor(fy);
  const lx = fx - cx;
  const ly = fy - cy;

  // Vertical mullions are slender; the horizontal transom at each floor line
  // is deeper, because it hides the floor slab behind it.
  const mullV = 0.045;
  const mullH = 0.07;
  const dV = Math.min(lx, 1 - lx);
  const dH = Math.min(ly, 1 - ly);
  const isMullion = dV < mullV || dH < mullH;
  const mullT = Math.max(1 - smooth(mullV * 0.5, mullV, dV), 1 - smooth(mullH * 0.5, mullH, dH));

  // The opaque spandrel band that caps every floor — glass above, panel below.
  const spandrel = ly > 0.80 && ly < 0.96;

  const id = hash2(cx, cy, 7331);
  const id2 = hash2(cx + 77, cy + 13, 2963);
  const id3 = hash2(cx + 5, cy + 91, 8837);

  /*
   * GLASS IS DARK. This is the single most important fact about the reference
   * frame's hero asset: the curtain wall is the darkest large mass in the
   * image and everything it shows is a REFLECTION of the sunset. The previous
   * authoring multiplied `Palette.glassTint` up by 1.25-1.6 and then lit it
   * with an emissive map, which produced a wall of pastel lightboxes brighter
   * than the sky behind it — the image inverted.
   *
   * The tint now sits at or below the authored `glassTint` and the mosaic
   * comes from a per-panel drift about it, so the panel-to-panel variety
   * survives without any panel becoming a light source. What makes it read as
   * glass is metalness + very low roughness + a strong `envMapIntensity`,
   * which is set on the material below.
   */
  const gt = P.glassTint;
  const gr = gt.r * lerp(0.72, 1.05, id);
  const gg = gt.g * lerp(0.80, 1.08, id2);
  const gb = gt.b * lerp(0.88, 1.12, id3);

  // Interiors glow (rule 3: a dark window at dusk is a bug) but the emissive
  // map only carries the RATIO between panels — absolute brightness is set
  // once by emissiveIntensity on the material, so it can be tuned globally
  // without regenerating textures.
  //
  // Lit panels are a small MINORITY: ~12% of the glass. In the reference you
  // can count the lit floors on one hand. And there are exactly TWO interior
  // colours, warm sodium and cool fluorescent, because that is what an office
  // building actually contains; a random pastel per pane is what made the
  // tower read as an LED scoreboard rather than as a building.
  const lit = id2 > 0.88;
  const warmLit = id3 > 0.45;
  const glowC = warmLit ? P.sodiumLamp : P.screenBlue;
  const glowK = lit && !isMullion && !spandrel ? lerp(0.55, 1.0, id3) : 0;
  // Desk/ceiling silhouette banding inside the lit floor.
  const slab = ly > 0.60 && ly < 0.72 ? 0.35 : 1.0;

  // Mullions read as anodised aluminium catching the sky, not as black gaps —
  // a near-black grid over dark glass just looks like missing geometry.
  const mullionC = 0.16;
  const spandrelC = 0.05;

  // Slight per-panel bow so panes are not coplanar and each catches its own
  // sliver of sunset.
  const bow = (lx - 0.5) * (0.5 - Math.abs(ly - 0.5)) * lerp(-1, 1, id);
  const h = isMullion ? 0.0 : spandrel ? 0.2 : 0.55 + bow * 0.16 + (id - 0.5) * 0.08;

  if (isMullion) {
    return {
      r: mullionC, g: mullionC, b: mullionC * 1.15, h,
      rough: lerp(0.5, 0.68, id), metal: 0.62, ao: clamp01(1 - mullT * 0.5),
    };
  }
  if (spandrel) {
    return {
      r: spandrelC, g: spandrelC, b: spandrelC * 1.3, h,
      rough: 0.42, metal: 0.35, ao: 0.82,
    };
  }
  return {
    r: gr, g: gg, b: gb, h,
    rough: 0.05 + id * 0.025,
    // Not a metal, but a dielectric this smooth needs a strong environment
    // term to read at all, and three's metalness workflow is the only lever
    // that gives a MeshStandardMaterial a full-strength mirror. Kept below 1
    // so the pane still has a diffuse component to carry its tint.
    metal: 0.86,
    ao: 1,
    er: glowC.r * glowK * slab,
    eg: glowC.g * glowK * slab,
    eb: glowC.b * glowK * slab,
  };
};

/** Tarmac markings: worn lane paint on transparent, for decal quads. */
function markingsMaps(size: number): { map: THREE.DataTexture; alphaFromMap: true } {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // A centred dashed line running along V.
      const inBand = Math.abs(u - 0.5) < 0.075;
      const dash = (v * 4) % 1 < 0.58;
      const wear = tileFbm(u * 22, v * 22, 22, 4, 6449);
      const scuff = tileValue(u * 64, v * 64, 64, 1979);
      let a = inBand && dash ? 1 : 0;
      a *= clamp01(smooth(0.28, 0.62, wear) * 0.75 + 0.25);
      a *= clamp01(1 - smooth(0.72, 0.98, scuff) * 0.85);
      // Paint is a dirty warm white.
      const o = (y * size + x) * 4;
      data[o] = lin2srgbByte(0.72);
      data[o + 1] = lin2srgbByte(0.68);
      data[o + 2] = lin2srgbByte(0.58);
      data[o + 3] = Math.round(clamp01(a) * 255);
    }
  }
  const t = finishTexture(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), true);
  return { map: t, alphaFromMap: true };
}

/** Autumn foliage card: thinning amber/olive leaf clusters on transparent. */
function foliageMaps(size: number): { map: THREE.DataTexture; normalMap: THREE.DataTexture; orm: THREE.DataTexture } {
  const n = size * size;
  const albedo = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const height = new Float32Array(n);
  const rng = new Rng('foliage-card');

  // Scatter leaf ellipses, deterministic.
  const leaves: Array<{ x: number; y: number; rx: number; ry: number; rot: number; amber: number; shade: number }> = [];
  for (let i = 0; i < 260; i++) {
    leaves.push({
      x: rng.next(),
      y: rng.next(),
      rx: rng.range(0.022, 0.058),
      ry: rng.range(0.012, 0.03),
      rot: rng.range(0, Math.PI),
      amber: rng.next(),
      shade: rng.range(0.55, 1.15),
    });
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      let cover = 0;
      let cr = 0;
      let cg = 0;
      let cb = 0;
      let ch = 0;
      for (const l of leaves) {
        // Wrap so the card tiles.
        let dx = u - l.x;
        let dy = v - l.y;
        if (dx > 0.5) dx -= 1;
        if (dx < -0.5) dx += 1;
        if (dy > 0.5) dy -= 1;
        if (dy < -0.5) dy += 1;
        const cs = Math.cos(l.rot);
        const sn = Math.sin(l.rot);
        const rx = (dx * cs + dy * sn) / l.rx;
        const ry = (-dx * sn + dy * cs) / l.ry;
        const d = rx * rx + ry * ry;
        if (d < 1) {
          const w = 1 - d;
          cover = Math.max(cover, w > 0.06 ? 1 : 0);
          const amber = l.amber;
          const a = P.leafAmber;
          const o = P.leafOlive;
          cr += lerp(o.r, a.r, amber) * l.shade * w;
          cg += lerp(o.g, a.g, amber) * l.shade * w;
          cb += lerp(o.b, a.b, amber) * l.shade * w;
          ch = Math.max(ch, w);
        }
      }
      const norm = ch > 0 ? 1 / Math.max(0.35, ch * 2.2) : 0;
      const idx = (y * size + x) * 4;
      albedo[idx] = lin2srgbByte(cr * norm);
      albedo[idx + 1] = lin2srgbByte(cg * norm);
      albedo[idx + 2] = lin2srgbByte(cb * norm);
      albedo[idx + 3] = cover > 0.5 ? 255 : 0;
      orm[idx] = Math.round(clamp01(0.55 + ch * 0.45) * 255);
      orm[idx + 1] = Math.round(clamp01(0.68 + (1 - ch) * 0.2) * 255);
      orm[idx + 2] = 0;
      orm[idx + 3] = 255;
      height[y * size + x] = ch;
    }
  }

  const normal = new Uint8Array(n * 4);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x - 1, y) - at(x + 1, y);
      const dy = at(x, y - 1) - at(x, y + 1);
      let nx = dx * 2.2;
      let ny = dy * 2.2;
      const len = Math.hypot(nx, ny, 1);
      nx /= len;
      ny /= len;
      const o = (y * size + x) * 4;
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;
    }
  }

  return {
    map: finishTexture(new THREE.DataTexture(albedo, size, size, THREE.RGBAFormat), true),
    normalMap: finishTexture(new THREE.DataTexture(normal, size, size, THREE.RGBAFormat), false),
    orm: finishTexture(new THREE.DataTexture(orm, size, size, THREE.RGBAFormat), false),
  };
}

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

export type MaterialId =
  | 'asphaltWet'
  | 'asphaltDry'
  | 'kerbConcrete'
  | 'pavingStone'
  | 'travertine'
  | 'paintedRender'
  | 'panelConcrete'
  | 'brushedMetal'
  | 'chrome'
  | 'rustedSteel'
  | 'glassCurtain'
  | 'roadMarkings'
  | 'foliageAutumn';

export const MATERIAL_IDS: readonly MaterialId[] = [
  'asphaltWet', 'asphaltDry', 'kerbConcrete', 'pavingStone', 'travertine',
  'paintedRender', 'panelConcrete', 'brushedMetal', 'chrome', 'rustedSteel',
  'glassCurtain', 'roadMarkings', 'foliageAutumn',
];

/** How many world metres one texture tile should cover, per material. */
const TILE_METRES: Record<MaterialId, number> = {
  // Larger tiles than feel natural per-texel: a road seen down a boulevard
  // shows the repeat long before it shows the grain, so the period matters
  // more than the density.
  asphaltWet: 14,
  asphaltDry: 14,
  kerbConcrete: 3.5,
  pavingStone: 4.0,
  travertine: 5.5,
  paintedRender: 7,
  panelConcrete: 8,
  brushedMetal: 2,
  chrome: 2,
  rustedSteel: 2.5,
  glassCurtain: 9,
  roadMarkings: 6,
  foliageAutumn: 2,
};

class MaterialLibrary {
  private cache = new Map<string, THREE.MeshStandardMaterial>();
  private maps = new Map<string, MapSet>();
  private disposables: Array<{ dispose(): void }> = [];
  private newMaterialListeners: Array<(m: THREE.Material) => void> = [];

  /** Set from the renderer once, so every generated texture is crisp at grazing angles. */
  setAnisotropy(v: number): void {
    maxAnisotropy = Math.max(1, Math.min(16, v));
  }

  /** Notified whenever a material is created, so CSM can register it. */
  onMaterialCreated(cb: (m: THREE.Material) => void): void {
    this.newMaterialListeners.push(cb);
    for (const m of this.cache.values()) cb(m);
  }

  private announce(m: THREE.Material): void {
    for (const cb of this.newMaterialListeners) cb(m);
  }

  /** Metres-per-tile for a material — use it to set `texture.repeat`. */
  tileMetres(id: MaterialId): number {
    return TILE_METRES[id];
  }

  private mapsFor(id: MaterialId): MapSet {
    const hit = this.maps.get(id);
    if (hit) return hit;
    let m: MapSet;
    switch (id) {
      case 'asphaltWet': m = buildMaps(512, 0.75, asphaltSampler(true)); break;
      case 'asphaltDry': m = buildMaps(512, 1.05, asphaltSampler(false)); break;
      case 'kerbConcrete': m = buildMaps(256, 1.5, kerbSampler); break;
      case 'pavingStone': m = buildMaps(512, 3.2, pavingSampler); break;
      case 'travertine': m = buildMaps(512, 1.4, travertineSampler); break;
      case 'paintedRender': m = buildMaps(256, 1.2, paintedSampler); break;
      case 'panelConcrete': m = buildMaps(512, 2.4, panelSampler); break;
      case 'brushedMetal': m = buildMaps(256, 1.0, brushedSampler); break;
      case 'chrome': m = buildMaps(128, 0.6, chromeSampler); break;
      case 'rustedSteel': m = buildMaps(256, 1.8, rustSampler); break;
      case 'glassCurtain': m = buildMaps(512, 2.6, glassSampler, true); break;
      default: m = buildMaps(256, 1.0, asphaltSampler(false)); break;
    }
    for (const t of Object.values(m)) if (t) this.disposables.push(t as THREE.Texture);
    this.maps.set(id, m);
    return m;
  }

  /** The shared instance for `id`. Never mutate the result — use `variant()`. */
  get(id: MaterialId): THREE.MeshStandardMaterial {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const m = this.create(id);
    m.name = `gta:${id}`;
    this.cache.set(id, m);
    this.disposables.push(m);
    this.announce(m);
    return m;
  }

  /**
   * A shared, cached copy of `id` with a different base colour — for painted
   * facades, vehicle bodywork and signage that must vary per building without
   * regenerating textures. Same textures, so batching still works per tint.
   */
  tinted(id: MaterialId, colorHex: number, extra?: Partial<THREE.MeshStandardMaterialParameters>): THREE.MeshStandardMaterial {
    const key = `${id}#${colorHex.toString(16)}${extra ? JSON.stringify(extra) : ''}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const m = this.create(id);
    m.color.setHex(colorHex).convertSRGBToLinear();
    if (extra) m.setValues(extra);
    m.name = `gta:${id}:${colorHex.toString(16)}`;
    this.cache.set(key, m);
    this.disposables.push(m);
    this.announce(m);
    return m;
  }

  private create(id: MaterialId): THREE.MeshStandardMaterial {
    if (id === 'roadMarkings') {
      const { map } = markingsMaps(512);
      const m = new THREE.MeshStandardMaterial({
        map,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 1.1,
      });
      return applyWetGround(m, { amount: 0.7, puddles: false, mirror: 0.45 });
    }

    if (id === 'foliageAutumn') {
      const f = foliageMaps(512);
      return new THREE.MeshStandardMaterial({
        map: f.map,
        normalMap: f.normalMap,
        aoMap: f.orm,
        roughnessMap: f.orm,
        alphaTest: 0.45,
        side: THREE.DoubleSide,
        roughness: 0.78,
        metalness: 0,
        envMapIntensity: 1.35,
      });
    }

    const maps = this.mapsFor(id);
    maps.orm.channel = 0;

    const base: THREE.MeshStandardMaterialParameters = {
      map: maps.map,
      normalMap: maps.normalMap,
      aoMap: maps.orm,
      roughnessMap: maps.orm,
      metalnessMap: maps.orm,
      roughness: 1,
      metalness: 1,
      aoMapIntensity: 1,
    };

    switch (id) {
      case 'asphaltWet':
      case 'asphaltDry': {
        const m = new THREE.MeshStandardMaterial({
          ...base,
          color: 0xffffff,
          envMapIntensity: 1.15,
          normalScale: new THREE.Vector2(0.8, 0.8),
        });
        return applyWetGround(m, { amount: id === 'asphaltWet' ? 1 : 0.55, puddles: true, mirror: 1 });
      }
      case 'kerbConcrete': {
        const m = new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 1.25 });
        return applyWetGround(m, { amount: 0.8, puddles: false, mirror: 0.55 });
      }
      case 'pavingStone': {
        const m = new THREE.MeshStandardMaterial({
          ...base,
          envMapIntensity: 1.3,
          normalScale: new THREE.Vector2(1.1, 1.1),
        });
        return applyWetGround(m, { amount: 0.95, puddles: true, mirror: 0.9 });
      }
      case 'travertine':
        return new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 1.5 });
      case 'paintedRender':
        return new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 1.2 });
      case 'panelConcrete':
        return new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 1.15 });
      case 'brushedMetal':
        return new THREE.MeshStandardMaterial({
          ...base,
          envMapIntensity: 1.9,
          normalScale: new THREE.Vector2(0.45, 0.45),
        });
      case 'chrome':
        return new THREE.MeshStandardMaterial({
          ...base,
          envMapIntensity: 2.4,
          normalScale: new THREE.Vector2(0.25, 0.25),
        });
      case 'rustedSteel':
        return new THREE.MeshStandardMaterial({ ...base, envMapIntensity: 1.35 });
      case 'glassCurtain':
        return new THREE.MeshStandardMaterial({
          ...base,
          emissive: 0xffffff,
          emissiveMap: maps.emissiveMap,
          // Interiors must read as lit rooms seen THROUGH glass, not as
          // blown-out rectangles stuck on it. Acceptance test: on a skyline
          // framing, the mean luminance of the glass tower must be BELOW the
          // mean luminance of the open sky. At 1.0 it was three times above.
          emissiveIntensity: 0.35,
          // The sky reflection is what makes glass read as glass; with the
          // emissive cut this is now the dominant term on the facade.
          envMapIntensity: 1.5,
          normalScale: new THREE.Vector2(0.6, 0.6),
        });
      default:
        return new THREE.MeshStandardMaterial(base);
    }
  }

  /**
   * Clones the tiling textures of `id` at a given world scale. Use when a mesh
   * has raw metre-scale UVs: `Materials.tiledFor('pavingStone', 20, 20)`.
   * The clone shares GPU memory with the original.
   */
  tiledFor(id: MaterialId, widthMetres: number, heightMetres: number): THREE.MeshStandardMaterial {
    const per = TILE_METRES[id];
    const rx = Math.max(0.25, widthMetres / per);
    const ry = Math.max(0.25, heightMetres / per);
    const key = `${id}@${rx.toFixed(2)}x${ry.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const src = this.get(id);
    const m = src.clone();

    /*
     * THREE.Material.copy() does NOT carry onBeforeCompile or
     * customProgramCacheKey across — they are instance function properties and
     * three deliberately leaves them alone. That silently stripped the entire
     * wetness / puddle / sky-mirror injection off every tiled surface, which
     * is most of the ground in the game, since tiledFor() is exactly what
     * metre-scale UVs are supposed to use. The road rendered as dry, fully
     * rough, aggregate-normal tarmac and nothing about the material's
     * configuration hinted that anything was missing.
     *
     * Re-applying from the recorded options rebuilds it on the clone.
     */
    const wetOpts = src.userData.gtaWetOpts as WetOptions | undefined;
    if (wetOpts) applyWetGround(m, wetOpts);

    for (const slot of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'] as const) {
      const t = m[slot];
      if (!t) continue;
      const c = t.clone();
      c.wrapS = THREE.RepeatWrapping;
      c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(rx, ry);
      c.needsUpdate = true;
      m[slot] = c;
      this.disposables.push(c);
    }
    m.name = `${src.name}@${rx.toFixed(1)}`;
    this.cache.set(key, m);
    this.disposables.push(m);
    this.announce(m);
    return m;
  }

  /* ---- live state ---- */

  /** 0..1, driven from WeatherService each frame. */
  setWetness(w: number): void {
    SHARED.wetness.value = clamp01(w);
  }

  get wetness(): number {
    return SHARED.wetness.value;
  }

  /** Keeps the analytic road reflection locked to the real sun. */
  setSunDirection(d: THREE.Vector3): void {
    SHARED.sunDir.value.copy(d).normalize();
  }

  /** Re-tint the analytic sky reflection (weather/time-of-day changes). */
  setSkyColors(c: {
    horizon: THREE.Color; low: THREE.Color; mid: THREE.Color; high: THREE.Color; zenith: THREE.Color; sun: THREE.Color;
  }): void {
    SHARED.skyHorizon.value.copy(c.horizon);
    SHARED.skyLow.value.copy(c.low);
    SHARED.skyMid.value.copy(c.mid);
    SHARED.skyHigh.value.copy(c.high);
    SHARED.skyZenith.value.copy(c.zenith);
    SHARED.sunCore.value.copy(c.sun);
  }

  /** Overall brightness of the road's sky mirror — drop it at night. */
  setSkyEnergy(v: number): void {
    SHARED.skyEnergy.value = Math.max(0, v);
  }

  /** True when the material carries the wet-ground shader injection. */
  isWetGround(m: THREE.Material): boolean {
    return m.userData?.gtaWet === true;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.cache.clear();
    this.maps.clear();
  }
}

/** The one shared library. Import this, not the class. */
export const Materials = new MaterialLibrary();
