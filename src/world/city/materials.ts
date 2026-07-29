/**
 * Shared city materials.
 *
 * NOTE: `src/render/materials.ts` does not exist in the tree yet, so the city
 * defines its own library here using the names the brief asked for
 * (`cityMaterials.facade` / `.surface` / `.detail`). If a global material
 * module lands later this file should be re-exported from it.
 *
 * There are exactly three materials for the whole city so that every chunk
 * draws in three calls:
 *
 *   facade  — a facade GRAMMAR shader. Storeys, bays, mullions, spandrels,
 *             punched windows, arcades, balconies, corrugation, graffiti and
 *             lit interiors are all evaluated analytically from world-metre UVs
 *             plus per-vertex grammar attributes. No texture memory, crisp at
 *             any distance, and one program for the entire city.
 *   surface — roads, lane markings, kerbs, paving joints, plaza stone, lawn,
 *             gravel and water, with the wet sky-mirror response the reference
 *             frame is built on.
 *   detail  — vertex-coloured PBR for all the small stuff (cornices, parapets,
 *             balconies, roof plant, poles, tram rails, signage), with
 *             per-vertex metalness/roughness and emissive.
 *
 * All three carry an ANALYTIC sky model matching src/render/sky.ts, so glass
 * and wet asphalt reflect the magenta-orange dome even though the scene has no
 * environment map. If the lighting agent later installs a real IBL, drop
 * `uEnvMix` toward 0 rather than deleting the code.
 */

import * as THREE from 'three';
import { Atmosphere, HeroSun, Palette } from '../../artDirection';

export const FacadeStyle = {
  glassCorporate: 0,
  bulevard: 1,
  cartier: 2,
  centruVechi: 3,
  guvern: 4,
  industrial: 5,
  /** Plain rendered wall — podiums, blank party walls, park pavilions. */
  plain: 6,
} as const;

/* ------------------------------------------------------------------ */
/* Shared GLSL                                                         */
/* ------------------------------------------------------------------ */

const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyHorizon, uSkyLow, uSkyMid, uSkyHigh, uSkyZenith, uSunCore, uSunDir;
uniform float uEnvMix;

vec3 gtaSky(vec3 d) {
  d = normalize(d);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 s = uSkyHorizon;
  s = mix(s, uSkyLow,    smoothstep(0.480, 0.545, h));
  s = mix(s, uSkyMid,    smoothstep(0.530, 0.630, h));
  s = mix(s, uSkyHigh,   smoothstep(0.600, 0.780, h));
  s = mix(s, uSkyZenith, smoothstep(0.720, 1.000, h));
  float sd = max(dot(d, uSunDir), 0.0);
  s += uSunCore * (pow(sd, 5.0) * 0.42 + pow(sd, 60.0) * 1.6);
  vec2 df = normalize(vec2(d.x, d.z) + 1e-5);
  vec2 sf = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
  float toward = pow(max(dot(df, sf), 0.0), 2.0);
  s += mix(uSkyLow, uSkyHorizon, toward) * exp(-abs(d.y) * 11.0) * (0.22 + 0.75 * toward);
  // Below the horizon the world takes over: dark violet city haze.
  s = mix(uSkyZenith * 0.30, s, smoothstep(-0.10, 0.02, d.y));
  return s * uEnvMix;
}

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 h23(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x),
             mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm2(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return v * 1.143;
}
/** Two-octave variant for broad, low-frequency masks (puddles, staining). */
float fbmLo(vec2 p) {
  return (vnoise(p) * 0.5 + vnoise(p * 2.07) * 0.25) * 1.333;
}
/** Antialiased band: 1 inside [-w, w] around 0, smoothed by screen derivative. */
float band(float x, float w) {
  float aa = fwidth(x) * 0.9 + 1e-5;
  return 1.0 - smoothstep(w - aa, w + aa, abs(x));
}
float rectMask(vec2 p, vec2 half_) {
  vec2 d = half_ - abs(p);
  vec2 aa = fwidth(p) * 0.9 + 1e-5;
  vec2 m = smoothstep(vec2(0.0), aa, d);
  return m.x * m.y;
}
`;

/* ------------------------------------------------------------------ */
/* Facade grammar                                                      */
/* ------------------------------------------------------------------ */

const FACADE_VERT_PARS = /* glsl */ `
attribute vec4 aFacade;
attribute vec4 aFacade2;
varying vec4 vFac;
varying vec4 vFac2;
varying vec2 vUvM;
varying vec3 vWPosF;
varying vec3 vWNrmF;
`;

const FACADE_VERT_MAIN = /* glsl */ `
vFac = aFacade;
vFac2 = aFacade2;
vUvM = uv;
vec4 wpF = modelMatrix * vec4(transformed, 1.0);
vWPosF = wpF.xyz;
vWNrmF = normalize(mat3(modelMatrix) * objectNormal);
`;

const FACADE_FRAG_PARS = /* glsl */ `
varying vec4 vFac;
varying vec4 vFac2;
varying vec2 vUvM;
varying vec3 vWPosF;
varying vec3 vWNrmF;
uniform vec3 uTravertine, uConcrete, uStucco, uGlassTint, uStone, uPurple, uMagenta, uSodium, uNeon, uRust;
uniform float uNight;
/** Dusk-to-night ramp on every interior light in the city. */
#define uLitGain (0.34 + 0.66 * uNight)
${SKY_GLSL}

struct Fac { vec3 albedo; vec3 emissive; float rough; float metal; float ao; };

/** Silhouettes of desks, monitors and people behind a lit pane. */
float officeInterior(vec2 p, float seed) {
  // p in 0..1 across the pane.
  float m = 0.0;
  // Desk band across the bottom.
  float desk = step(p.y, 0.30 + h11(seed * 3.1) * 0.08) * step(0.05, p.y);
  m = max(m, desk * 0.85);
  // Monitor blocks.
  float mc = h11(seed * 7.7);
  m = max(m, rectMask(p - vec2(0.22 + mc * 0.5, 0.42), vec2(0.075, 0.075)) * 0.9);
  // Person silhouette: torso + head.
  float pr = h11(seed * 11.3);
  if (pr > 0.45) {
    vec2 pc = vec2(0.28 + h11(seed * 13.1) * 0.5, 0.30);
    m = max(m, rectMask(p - pc, vec2(0.085, 0.20)) * 0.95);
    float head = 1.0 - smoothstep(0.055, 0.075, length((p - pc - vec2(0.0, 0.24)) * vec2(1.0, 0.9)));
    m = max(m, head * 0.95);
  }
  // Ceiling strip light.
  m = max(m, 0.0);
  return clamp(m, 0.0, 1.0);
}

Fac facadeGrammar() {
  Fac f;
  float style = vFac.x;
  float floorH = max(vFac.y, 2.2);
  float bayW  = max(vFac.z, 1.2);
  float seed  = vFac.w;
  float bh    = vFac2.x;
  float groundH = max(vFac2.y, 2.5);
  float litBias = vFac2.z;
  float tint  = vFac2.w;

  // After dark far more of the city is lit from within, and a dark window at
  // dusk is a bug (see docs/VISUAL_TARGET.md rule 3).
  litBias = mix(litBias, clamp(litBias * 1.3 + 0.22, 0.0, 0.94), uNight);

  f.albedo = uConcrete;
  f.emissive = vec3(0.0);
  f.rough = 0.85;
  f.metal = 0.0;
  f.ao = 1.0;

  // Roof / soffit faces: bitumen and gravel, never facade grammar.
  if (abs(vWNrmF.y) > 0.55) {
    float g = fbm2(vWPosF.xz * 1.6);
    f.albedo = mix(vec3(0.030, 0.026, 0.038), vec3(0.075, 0.062, 0.070), g);
    f.rough = 0.92 - g * 0.10;
    // Weather staining pooled in the middle of large roofs.
    f.albedo *= 0.85 + 0.3 * fbm2(vWPosF.xz * 0.22);
    return f;
  }

  float u = vUvM.x;
  float v = vUvM.y;

  float isGround = step(v, groundH);
  float fy = (v - groundH) / floorH;
  float fi = floor(fy);
  float fv = fract(fy);
  float bi = floor(u / bayW);
  float bu = fract(u / bayW);
  vec2 cell = vec2(bi, fi);
  float ch = h21(cell + seed * 17.0);
  float topFloor = floor((bh - groundH) / floorH);
  float nearTop = step(topFloor - 1.5, fi);

  // Panel-relative coordinates in metres for crisp derivatives.
  float um = bu * bayW;
  float vm = fv * floorH;

  /* ---------------- 0: glass curtain wall ---------------- */
  if (style < 0.5) {
    float mullionW = 0.085;
    float transomW = 0.10;
    float spandrel = 0.86;                       // opaque slab band
    float inSpandrel = step(vm, spandrel) * (1.0 - isGround);

    float vert = max(band(um, mullionW), band(um - bayW, mullionW));
    float horiz = band(vm, transomW);
    float mull = clamp(vert + horiz, 0.0, 1.0);

    // Every pane reflects a slightly different slice of sky.
    vec3 vd = normalize(vWPosF - cameraPosition);
    vec3 jitter = (h23(cell + seed) - 0.5) * 0.16;
    vec3 rdir = reflect(vd, normalize(vWNrmF + jitter));
    vec3 skyRef = gtaSky(rdir);
    float fres = pow(1.0 - max(dot(-vd, vWNrmF), 0.0), 3.4);

    // The reference tower is DARK glass: each pane shows a different slice of
    // sky, but the panel reads near-black violet, not as a light source.
    vec3 glass = uGlassTint * (0.55 + ch * 0.5);
    glass = mix(glass, skyRef * 0.075, 0.14 + 0.34 * fres);

    // Lit interiors behind the glass.
    float lit = step(1.0 - litBias, h21(cell * 1.7 + seed * 3.0 + 4.0));
    vec2 pane = vec2(bu, clamp((vm - spandrel) / max(floorH - spandrel, 0.5), 0.0, 1.0));
    float inner = officeInterior(pane, ch * 91.0 + seed);
    vec3 room = mix(uPurple * 0.55, uMagenta * 0.8, h21(cell + 9.0));
    vec3 emis = room * lit * (1.0 - inner * 0.92) * 1.05 * uLitGain;
    // Ceiling glow just under the slab above.
    emis += room * lit * smoothstep(0.82, 0.98, pane.y) * 0.75 * uLitGain;

    vec3 spandrelCol = mix(uGlassTint * 0.35, uStone * 0.16, 0.5);

    f.albedo = mix(glass, spandrelCol, inSpandrel);
    f.emissive = emis * (1.0 - inSpandrel);
    f.metal = mix(0.34, 0.08, inSpandrel);
    f.rough = mix(0.175, 0.55, inSpandrel);

    // Mullions: warm anodised aluminium catching the sun.
    f.albedo = mix(f.albedo, uStone * 0.16, mull);
    f.metal = mix(f.metal, 0.45, mull);
    f.rough = mix(f.rough, 0.42, mull);
    f.emissive *= (1.0 - mull);

    // Travertine podium at street level.
    if (isGround > 0.5) {
      float grain = fbm2(vec2(u * 2.2, v * 5.0));
      f.albedo = uTravertine * (0.72 + grain * 0.55);
      f.metal = 0.0;
      f.rough = 0.62 - grain * 0.15;
      // Stone coursing.
      float course = band(fract(v / 1.15) - 0.5, 0.022);
      float joint = band(fract(u / 1.55) - 0.5, 0.018);
      f.albedo *= 1.0 - 0.35 * max(course, joint);
      // Lobby glazing strip in the middle of the podium.
      float lobby = step(1.6, v) * step(v, groundH - 0.9);
      float pier = step(0.20, bu) * step(bu, 0.80);
      float glassBand = lobby * pier;
      f.albedo = mix(f.albedo, uGlassTint * 0.25, glassBand);
      f.emissive += mix(uPurple, uMagenta, h11(bi + seed)) * glassBand * 1.5 * uLitGain;
      f.metal = mix(f.metal, 0.10, glassBand);
      f.rough = mix(f.rough, 0.26, glassBand);
    }
    return f;
  }

  /* ---------------- 1: communist boulevard block ---------------- */
  if (style < 1.5) {
    vec3 base = mix(uStucco, uTravertine, tint * 0.55);
    float grain = fbm2(vec2(u * 1.3, v * 1.1));
    f.albedo = base * (0.62 + grain * 0.62);
    f.rough = 0.86;

    // Rendered pilaster strips between bays.
    float pil = band(um - bayW * 0.5, bayW * 0.06);
    f.albedo *= 1.0 - 0.10 * pil;

    // Punched windows, tall proportion, with a deep reveal.
    float wW = bayW * 0.44;
    float wH = floorH * 0.52;
    vec2 wc = vec2(um - bayW * 0.5, vm - floorH * 0.52);
    float win = rectMask(wc, vec2(wW * 0.5, wH * 0.5));
    float reveal = rectMask(wc, vec2(wW * 0.5 + 0.10, wH * 0.5 + 0.10)) - win;
    win *= 1.0 - isGround;
    reveal *= 1.0 - isGround;

    float lit = step(1.0 - litBias, h21(cell * 2.3 + seed));
    vec3 room = mix(uSodium, uMagenta, h21(cell + 3.0) * 0.45);
    vec2 pane = (wc / vec2(wW, wH)) + 0.5;
    float inner = officeInterior(pane, ch * 53.0 + seed);
    f.albedo = mix(f.albedo, vec3(0.012, 0.010, 0.022), win);
    f.emissive += room * lit * win * (1.0 - inner * 0.9) * 1.9 * uLitGain;
    f.metal = mix(f.metal, 0.0, win);
    f.rough = mix(f.rough, 0.42, win);
    f.albedo *= 1.0 - 0.45 * reveal;

    // Sill + lintel shadow.
    f.albedo *= 1.0 - 0.30 * band(vm - (floorH * 0.52 - wH * 0.5 - 0.09), 0.05) * step(abs(wc.x), wW * 0.62);

    // String course between floors and a heavy cornice at the top.
    f.albedo *= 1.0 - 0.22 * band(vm, 0.07);
    float cornice = step(bh - floorH * 0.55, v);
    f.albedo = mix(f.albedo, base * 1.25, cornice * 0.7);
    f.albedo *= 1.0 - 0.35 * band(v - (bh - floorH * 0.55), 0.06);

    // Ground floor: retail glazing, awnings, lit signage.
    if (isGround > 0.5) {
      float shopIdx = floor(u / (bayW * 2.0));
      float sh = h11(shopIdx * 3.7 + seed);
      float glassY = step(0.75, v) * step(v, groundH - 1.35);
      float pier = step(0.14, bu) * step(bu, 0.86);
      float shopGlass = glassY * pier;
      f.albedo = mix(uStone * 0.35, vec3(0.02, 0.017, 0.03), shopGlass);
      f.rough = mix(0.72, 0.30, shopGlass);
      f.metal = mix(0.0, 0.05, shopGlass);
      vec3 sign = mix(uNeon, uSodium, sh);
      f.emissive += sign * shopGlass * (0.45 + sh * 0.8) * uLitGain;
      // Fascia sign band above the glazing.
      float fascia = step(groundH - 1.25, v) * step(v, groundH - 0.35);
      f.albedo = mix(f.albedo, mix(uRust, uNeon, sh) * 0.25, fascia);
      float letters = step(0.55, fbm2(vec2(u * 7.0, v * 3.0)));
      f.emissive += sign * fascia * letters * 1.7 * uLitGain;
      // Plinth.
      f.albedo = mix(f.albedo, uStone * 0.22, step(v, 0.75));
    }
    return f;
  }

  /* ---------------- 2: cartier panel blocks ---------------- */
  if (style < 2.5) {
    float pw = 3.15;                                    // precast panel width
    vec3 base = mix(uConcrete, uStucco * 0.8, tint);
    float grain = fbm2(vec2(u * 0.9, v * 0.8));
    float panelTone = h21(vec2(floor(u / pw), fi) + seed * 5.0);
    f.albedo = base * (0.52 + grain * 0.5 + panelTone * 0.22);
    f.rough = 0.92;

    // Panel joints — the signature grid of a Romanian bloc.
    float jv = band(fract(u / pw) - 0.5, 0.020);
    float jh = band(fv - 0.5, 0.020 / floorH);
    f.albedo *= 1.0 - 0.42 * max(jv, jh);

    // Loggia/balcony recess on alternating bays.
    float hasBalcony = step(0.42, h11(bi * 2.1 + seed));
    float balc = hasBalcony * rectMask(vec2(um - bayW * 0.5, vm - floorH * 0.5),
                                       vec2(bayW * 0.34, floorH * 0.36)) * (1.0 - isGround);
    f.albedo = mix(f.albedo, base * 0.35, balc);
    f.ao = mix(1.0, 0.45, balc);
    // Laundry / stored junk colour flecks inside the loggia.
    vec3 junk = h23(cell * 3.3 + seed);
    f.albedo = mix(f.albedo, junk * 0.5, balc * step(0.55, junk.x) * step(vm, floorH * 0.55));

    // Windows: mismatched frames — some white PVC, some brown timber.
    float wW = bayW * (0.34 + 0.10 * h11(bi + fi * 3.0 + seed));
    float wH = floorH * 0.46;
    vec2 wc = vec2(um - bayW * 0.5, vm - floorH * 0.55);
    float frameM = rectMask(wc, vec2(wW * 0.5 + 0.07, wH * 0.5 + 0.07));
    float win = rectMask(wc, vec2(wW * 0.5, wH * 0.5)) * (1.0 - isGround);
    float frame = (frameM - win) * (1.0 - isGround);
    vec3 frameCol = mix(vec3(0.30, 0.29, 0.275), uRust * 0.42, step(0.55, h11(bi * 5.1 + seed)));
    f.albedo = mix(f.albedo, frameCol, frame);

    float lit = step(1.0 - litBias, h21(cell * 1.3 + seed * 2.0));
    vec3 room = mix(uSodium, uMagenta, h21(cell + 7.0) * 0.6);
    vec2 pane = (wc / vec2(wW, wH)) + 0.5;
    float inner = officeInterior(pane, ch * 31.0 + seed);
    f.albedo = mix(f.albedo, vec3(0.010, 0.009, 0.020), win);
    f.emissive += room * lit * win * (1.0 - inner * 0.88) * 1.7 * uLitGain;
    f.metal = mix(f.metal, 0.0, win);
    f.rough = mix(f.rough, 0.44, win);

    // Rust/dirt streaks running down from every sill.
    float streak = smoothstep(0.0, 1.0, fbm2(vec2(u * 3.5, v * 0.16)));
    float below = smoothstep(floorH * 0.30, 0.0, vm);
    f.albedo *= 1.0 - 0.28 * streak * below;

    // Graffiti tags along the ground floor.
    if (v < 3.2) {
      vec2 gp = vec2(u * 0.55, v * 0.75);
      float tag = smoothstep(0.60, 0.78, fbm2(gp + seed));
      vec3 tagCol = h23(vec2(floor(u / 6.0), seed));
      f.albedo = mix(f.albedo, normalize(tagCol + 0.1) * 0.35, tag * 0.8);
      f.albedo *= 1.0 - 0.25 * smoothstep(1.4, 0.0, v);      // grime at the base
    }
    // Ground floor: blind plinth with a couple of lit entrances.
    if (isGround > 0.5) {
      float ent = step(0.86, h11(floor(u / (bayW * 2.0)) * 9.1 + seed));
      float door = ent * rectMask(vec2(fract(u / (bayW * 2.0)) - 0.5, v - 1.25), vec2(0.09, 1.1));
      f.emissive += uSodium * door * 1.4 * uLitGain;
      f.albedo = mix(f.albedo, uStone * 0.18, step(v, 0.9));
    }
    return f;
  }

  /* ---------------- 3: old town ---------------- */
  if (style < 3.5) {
    vec3 base = mix(uStucco, uTravertine, tint);
    float grain = fbm2(vec2(u * 2.6, v * 2.2));
    float blotch = fbm2(vec2(u * 0.4, v * 0.3));
    f.albedo = base * (0.55 + grain * 0.45 + blotch * 0.35);
    f.rough = 0.88;

    // Pilaster strips and a rusticated ground storey.
    float pil = band(um, bayW * 0.05);
    f.albedo *= 1.0 + 0.10 * pil;

    // Arched window: rectangle with a semicircular head.
    float wW = bayW * 0.40;
    float wH = floorH * 0.42;
    vec2 wc = vec2(um - bayW * 0.5, vm - floorH * 0.50);
    float rectPart = rectMask(wc, vec2(wW * 0.5, wH * 0.5));
    vec2 ac = vec2(wc.x, wc.y - wH * 0.5);
    float arch = (1.0 - smoothstep(wW * 0.5 - 0.03, wW * 0.5 + 0.03, length(ac))) * step(0.0, ac.y);
    float win = clamp(rectPart + arch, 0.0, 1.0) * (1.0 - isGround);
    float trim = (clamp(rectMask(wc, vec2(wW * 0.5 + 0.11, wH * 0.5 + 0.11)) +
                  (1.0 - smoothstep(wW * 0.5 + 0.08, wW * 0.5 + 0.13, length(ac))) * step(0.0, ac.y), 0.0, 1.0) - win)
                  * (1.0 - isGround);
    f.albedo = mix(f.albedo, base * 1.35, trim);
    f.albedo = mix(f.albedo, vec3(0.014, 0.011, 0.024), win);

    float lit = step(1.0 - litBias, h21(cell * 1.9 + seed));
    vec3 room = mix(uSodium, uNeon, h21(cell + 2.0) * 0.5);
    f.emissive += room * lit * win * 2.0 * uLitGain;
    f.metal = mix(f.metal, 0.0, win);
    f.rough = mix(f.rough, 0.42, win);

    // Ornate cornice: three stacked bands under the eaves.
    float toEave = bh - v;
    f.albedo *= 1.0 - 0.30 * band(toEave - 0.45, 0.07);
    f.albedo = mix(f.albedo, base * 1.4, band(toEave - 0.85, 0.16));
    f.albedo *= 1.0 - 0.24 * band(toEave - 1.35, 0.05);
    // String course over the ground floor.
    f.albedo = mix(f.albedo, base * 1.3, band(v - groundH, 0.13));

    if (isGround > 0.5) {
      // Arcade: round-headed openings with terrace/neon behind.
      vec2 oc = vec2(um - bayW * 0.5, v - groundH * 0.46);
      float open = rectMask(oc, vec2(bayW * 0.30, groundH * 0.34));
      float head = (1.0 - smoothstep(bayW * 0.28, bayW * 0.32,
                    length(vec2(oc.x, oc.y - groundH * 0.34)))) * step(0.0, oc.y - groundH * 0.34);
      open = clamp(open + head, 0.0, 1.0);
      f.albedo = mix(f.albedo, vec3(0.02, 0.015, 0.03), open);
      float sh = h11(bi * 4.3 + seed);
      f.emissive += mix(uNeon, uSodium, sh) * open * (1.2 + sh * 2.2) * uLitGain;
      f.ao = mix(f.ao, 0.5, open);
      f.albedo *= 1.0 - 0.30 * smoothstep(0.9, 0.0, v);
    }
    return f;
  }

  /* ---------------- 4: monumental government stone ---------------- */
  if (style < 4.5) {
    vec3 stone = uStone * (1.02 + tint * 0.16);
    float grain = fbm2(vec2(u * 3.0, v * 2.4));
    f.albedo = stone * (0.78 + grain * 0.34);
    f.rough = 0.74;

    // Giant order: engaged pilasters running the full height above the base.
    float pilW = bayW * 0.19;
    float pil = rectMask(vec2(um - bayW * 0.5, 0.0), vec2(pilW, 1e3));
    float aboveBase = step(groundH, v);
    f.albedo *= 1.0 + 0.16 * pil * aboveBase;
    // Fluting.
    f.albedo *= 1.0 - 0.10 * pil * aboveBase * band(fract(um * 5.0) - 0.5, 0.22);

    // Tall recessed windows between the pilasters.
    float wW = bayW * 0.34;
    float wH = floorH * 0.66;
    vec2 wc = vec2(um - bayW * 0.5, vm - floorH * 0.50);
    float win = rectMask(wc, vec2(wW * 0.5, wH * 0.5)) * aboveBase;
    float rev = (rectMask(wc, vec2(wW * 0.5 + 0.16, wH * 0.5 + 0.16)) - win) * aboveBase;
    f.albedo *= 1.0 - 0.42 * rev;
    f.albedo = mix(f.albedo, vec3(0.016, 0.013, 0.026), win);
    float lit = step(1.0 - litBias, h21(cell * 2.7 + seed));
    f.emissive += mix(uSodium, uPurple, 0.25) * win * lit * 1.5 * uLitGain;
    f.metal = mix(f.metal, 0.0, win);
    f.rough = mix(f.rough, 0.42, win);

    // Rusticated base with deep horizontal joints.
    float rust_ = 1.0 - aboveBase;
    f.albedo *= 1.0 - 0.34 * rust_ * band(fract(v / 1.05) - 0.5, 0.05);
    // Entablature and attic storey.
    float toTop = bh - v;
    f.albedo = mix(f.albedo, stone * 1.22, band(toTop - 1.1, 0.55));
    f.albedo *= 1.0 - 0.30 * band(toTop - 1.85, 0.06);
    f.albedo *= 1.0 - 0.28 * band(toTop - 0.45, 0.05);
    return f;
  }

  /* ---------------- 5: industrial ---------------- */
  if (style < 5.5) {
    // Corrugated cladding: vertical ribs shading the albedo.
    float rib = 0.5 + 0.5 * cos(u * 6.2831 / 0.32);
    vec3 base = mix(uConcrete * 0.8, uRust, tint * 0.5);
    f.albedo = base * (0.42 + rib * 0.5);
    f.metal = 0.42;
    f.rough = 0.62 - rib * 0.12;

    // Horizontal fixing lines.
    f.albedo *= 1.0 - 0.20 * band(fract(v / 2.4) - 0.5, 0.02);

    // Rust bleeding from the base upward.
    float rustAmt = smoothstep(4.0, 0.0, v) * smoothstep(0.35, 0.75, fbm2(vec2(u * 1.2, v * 0.5)));
    f.albedo = mix(f.albedo, uRust * 0.55, rustAmt * 0.7);

    // Continuous clerestory strip just under the eaves.
    float strip = step(bh - 2.6, v) * step(v, bh - 0.8);
    float mull = band(fract(u / 1.5) - 0.5, 0.06);
    f.albedo = mix(f.albedo, vec3(0.02, 0.018, 0.032), strip * (1.0 - mull));
    float lit = step(1.0 - litBias * 0.8, h21(vec2(floor(u / 1.5), 0.0) + seed));
    f.emissive += mix(uSodium, uPurple, 0.3) * strip * (1.0 - mull) * lit * 1.8 * uLitGain;
    f.metal = mix(f.metal, 0.0, strip * (1.0 - mull));
    f.rough = mix(f.rough, 0.40, strip * (1.0 - mull));

    // Roller shutter doors along the ground.
    if (isGround > 0.5) {
      float dIdx = floor(u / 9.0);
      float hasDoor = step(0.4, h11(dIdx * 6.1 + seed));
      float door = hasDoor * rectMask(vec2(fract(u / 9.0) - 0.5, v - 2.4), vec2(0.28, 2.2));
      f.albedo = mix(f.albedo, mix(uRust, uConcrete, 0.5) * 0.5, door);
      f.albedo *= 1.0 - 0.25 * door * band(fract(v / 0.22) - 0.5, 0.1);
      f.emissive += uSodium * hasDoor * band(v - 4.9, 0.06) *
                    rectMask(vec2(fract(u / 9.0) - 0.5, 0.0), vec2(0.06, 1e3)) * 2.5 * uLitGain;
    }
    return f;
  }

  /* ---------------- 6: plain rendered wall ---------------- */
  float grain = fbm2(vec2(u * 1.6, v * 1.4));
  f.albedo = mix(uStucco, uConcrete, tint) * (0.55 + grain * 0.55);
  f.rough = 0.90;
  f.albedo *= 1.0 - 0.22 * smoothstep(2.0, 0.0, v);
  return f;
}
`;

/* ------------------------------------------------------------------ */
/* Surface shader (roads, pavements, plazas, lawns, water)             */
/* ------------------------------------------------------------------ */

const SURF_VERT_PARS = /* glsl */ `
attribute vec4 aSurf;
varying vec4 vSurf;
varying vec2 vUvM;
varying vec3 vWPosS;
varying vec3 vWNrmS;
`;

const SURF_VERT_MAIN = /* glsl */ `
vSurf = aSurf;
vUvM = uv;
vec4 wpS = modelMatrix * vec4(transformed, 1.0);
vWPosS = wpS.xyz;
vWNrmS = normalize(mat3(modelMatrix) * objectNormal);
`;

const SURF_FRAG_PARS = /* glsl */ `
varying vec4 vSurf;
varying vec2 vUvM;
varying vec3 vWPosS;
varying vec3 vWNrmS;
uniform vec3 uAsphalt, uPaveStone, uKerb, uGrass, uGravelC, uWaterC, uMarking;
uniform float uWetness;
${SKY_GLSL}

struct Surf { vec3 albedo; vec3 emissive; float rough; float metal; };

Surf surfaceShade() {
  Surf s;
  float kind = vSurf.x;
  float halfW = vSurf.y;
  float lanes = vSurf.z;
  float seed = vSurf.w;
  vec2 uvm = vUvM;
  vec2 wp = vWPosS.xz;

  s.albedo = uAsphalt;
  s.emissive = vec3(0.0);
  s.rough = 0.6;
  s.metal = 0.0;

  float wet = uWetness;

  if (kind < 0.5) {
    /* ---- carriageway ---- */
    float grain = fbm2(wp * 1.35);
    float coarse = vnoise(wp * 0.22);
    s.albedo = uAsphalt * (0.62 + grain * 0.55 + coarse * 0.35);
    s.rough = 0.52 - grain * 0.14;

    float across = uvm.x - halfW;         // signed metres from centreline
    float along = uvm.y;
    float laneW = 3.6;
    int nl = int(lanes);

    if (nl > 0) {
      // Edge lines.
      float edge = max(band(abs(across) - (halfW - 0.42), 0.075), 0.0);
      // Centre: double solid on 3+ lane boulevards, dashed otherwise.
      float centre;
      if (lanes > 2.5) {
        centre = max(band(across - 0.16, 0.075), band(across + 0.16, 0.075));
      } else {
        centre = band(across, 0.075) * step(fract(along / 6.0), 0.55);
      }
      // Lane dividers.
      float divider = 0.0;
      for (int i = 1; i < 4; i++) {
        if (i >= nl) break;
        float o = float(i) * laneW;
        float d = max(band(across - o, 0.06), band(across + o, 0.06));
        divider = max(divider, d * step(fract(along / 8.0), 0.5));
      }
      float paint = clamp(edge + centre + divider, 0.0, 1.0);
      // Paint is scuffed and worn.
      float wear = smoothstep(0.25, 0.75, fbmLo(wp * 2.4 + 11.0));
      s.albedo = mix(s.albedo, uMarking * (0.55 + wear * 0.55), paint * (0.55 + wear * 0.45));
      s.rough = mix(s.rough, 0.62, paint);
    }

    // Tyre polish in the wheel tracks, and a wet gutter near the kerb.
    float track = 0.0;
    for (int i = 0; i < 3; i++) {
      float o = (float(i) - 1.0) * laneW + 0.9;
      track = max(track, band(abs(across) - abs(o), 0.55));
    }
    s.rough -= track * 0.10;
    float gutter = smoothstep(halfW, halfW - 1.1, abs(across));
    wet = clamp(wet + gutter * 0.25, 0.0, 1.0);
    s.albedo *= 1.0 - gutter * 0.25;
  } else if (kind < 1.5) {
    /* ---- pavement: cast slabs with joints ---- */
    vec2 g = wp / vec2(0.62, 0.62);
    vec2 cellId = floor(g);
    float tone = h21(cellId + seed);
    float dirt = fbmLo(wp * 0.55);
    s.albedo = uPaveStone * (0.55 + tone * 0.30 + dirt * 0.42);
    vec2 fj = abs(fract(g) - 0.5);
    float joint = max(band(fj.x - 0.5, 0.035), band(fj.y - 0.5, 0.035));
    s.albedo *= 1.0 - 0.42 * joint;
    s.rough = 0.60 - tone * 0.10;
    // Occasional missing/sunken slab and puddling.
    float broken = step(0.955, h21(cellId * 1.7 + 4.0));
    s.albedo *= 1.0 - 0.35 * broken;
    wet *= 0.5;
  } else if (kind < 2.5) {
    /* ---- kerb face ---- */
    float grain = fbm2(wp * 3.0 + vWPosS.y * 4.0);
    s.albedo = uKerb * (0.7 + grain * 0.5);
    s.rough = 0.62;
    // Painted kerb bands near crossings are handled by decals; keep it plain.
    wet *= 0.7;
  } else if (kind < 3.5) {
    /* ---- plaza stone: large sawn slabs, radiating pattern ---- */
    vec2 g = wp / 1.85;
    vec2 cellId = floor(g);
    float tone = h21(cellId + seed);
    s.albedo = uPaveStone * (0.72 + tone * 0.36) * 1.12;
    vec2 fj = abs(fract(g) - 0.5);
    float joint = max(band(fj.x - 0.5, 0.020), band(fj.y - 0.5, 0.020));
    s.albedo *= 1.0 - 0.30 * joint;
    s.rough = 0.50;
  } else if (kind < 4.5) {
    /* ---- lawn ---- */
    float n = fbm2(wp * 2.2);
    float blotch = fbm2(wp * 0.35);
    s.albedo = uGrass * (0.45 + n * 0.65 + blotch * 0.35);
    s.rough = 0.95;
    wet *= 0.25;
  } else if (kind < 5.5) {
    /* ---- gravel / compacted yard ---- */
    float n = fbm2(wp * 4.5);
    s.albedo = uGravelC * (0.5 + n * 0.8);
    s.rough = 0.88;
    wet *= 0.5;
  } else if (kind < 6.5) {
    /* ---- water ---- */
    s.albedo = uWaterC * 0.35;
    s.rough = 0.035;
    s.metal = 0.55;
    wet = 1.0;
  } else if (kind < 7.5) {
    /* ---- tram bed: setts between the rails ---- */
    vec2 g = wp / vec2(0.30, 0.42);
    float tone = h21(floor(g) + seed);
    s.albedo = uKerb * (0.42 + tone * 0.40);
    vec2 fj = abs(fract(g) - 0.5);
    s.albedo *= 1.0 - 0.45 * max(band(fj.x - 0.5, 0.09), band(fj.y - 0.5, 0.07));
    s.rough = 0.55;
  } else if (kind < 8.5) {
    /* ---- zebra crossing ---- */
    float grain = fbm2(wp * 1.4);
    s.albedo = uAsphalt * (0.62 + grain * 0.5);
    float stripe = step(fract(uvm.y / max(halfW, 0.4)), 0.52);
    float wear = smoothstep(0.2, 0.8, fbm2(wp * 3.0 + 7.0));
    s.albedo = mix(s.albedo, uMarking * (0.5 + wear * 0.55), stripe * (0.5 + wear * 0.5));
    s.rough = 0.55;
  } else {
    /* ---- cobbles (old town) ---- */
    vec2 g = wp / 0.26;
    vec2 cellId = floor(g + vec2(0.0, 0.0));
    // Offset alternate rows for a running bond.
    g.x += mod(cellId.y, 2.0) * 0.5;
    cellId = floor(g);
    vec2 fp = fract(g) - 0.5;
    float dome = 1.0 - smoothstep(0.24, 0.48, length(fp * vec2(1.0, 1.25)));
    float tone = h21(cellId + seed);
    s.albedo = uKerb * (0.35 + tone * 0.55) * (0.55 + dome * 0.7);
    s.rough = 0.48 - dome * 0.16;
  }

  /* ---- wet response: the reference is a post-rain street ---- */
  vec3 vd = normalize(vWPosS - cameraPosition);
  // Puddle map: broad low spots plus fine ripple detail.
  // A real post-rain street is patchy: standing water in the low spots and the
  // gutter, a damp sheen everywhere else. A constant 0.85 everywhere is what
  // made this read as a chrome plate rather than asphalt.
  float puddle = smoothstep(0.42, 0.72, fbmLo(wp * 0.20)) * smoothstep(0.30, 0.62, fbmLo(wp * 0.9));
  float wetAmt = clamp(wet * (0.22 + puddle * 1.05), 0.0, 1.0);

  // Long vertical smears of sky along the view direction — this is what makes
  // the reference's asphalt read as a mirror rather than a shiny plane.
  vec2 smearDir = normalize(vec2(vd.x, vd.z) + 1e-5);
  float smear = fbmLo(wp * vec2(1.9));
  float smearLong = fbmLo((wp - smearDir * dot(wp, smearDir) * 0.86) * 2.6);
  float mottle = mix(smear, smearLong, 0.75);

  vec3 nrm = normalize(vWNrmS);
  vec3 rdir = reflect(vd, nrm);
  // Roughen the reflection with the mottle so the mirror breaks up.
  rdir = normalize(rdir + vec3(mottle - 0.5, 0.0, mottle - 0.5) * 0.045 * (1.0 - wetAmt * 0.6));
  vec3 skyRef = gtaSky(rdir);
  float fres = pow(1.0 - max(dot(-vd, nrm), 0.0), 4.0);

  s.albedo *= 1.0 - wetAmt * 0.62;
  // Not a chrome plate: a wet road still has microfacet spread, and driving
  // roughness to ~0 turns the IBL into a perfect second sky.
  s.rough = mix(s.rough, 0.115, wetAmt);
  // A wet street MIRRORS the sky, it does not MATCH it. Keeping the mirror
  // term well under 1.0 is what stops the road reading as a second sky and
  // preserves the dark violet asphalt the reference is built on.
  float grazing = 0.05 + 0.48 * fres;
  // Very close to the camera you look THROUGH the water film and read the
  // asphalt grain; the mirror only takes over with distance. Without this the
  // bottom third of every street-level frame is one blown lavender slab.
  float nearFade = smoothstep(3.0, 26.0, distance(vWPosS, cameraPosition));
  float mirror = pow(clamp(mottle, 0.0, 1.0), 1.7);
  s.emissive += skyRef * grazing * wetAmt * (0.10 + mirror * 0.85) * (0.34 + 0.66 * nearFade);

  // Anisotropic sun glitter: the low sun lays a broken specular streak down
  // the wet carriageway toward the camera. This is the single defining
  // feature of the reference frame.
  vec2 sunAz = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
  float align = pow(max(dot(smearDir, sunAz), 0.0), 3.0);
  float glint = pow(max(dot(rdir, uSunDir), 0.0), 22.0);
  float broken = smoothstep(0.35, 0.85, mottle);
  s.emissive += uSunCore * glint * align * broken * wetAmt * 2.4;

  s.metal = max(s.metal, wetAmt * 0.10);
  return s;
}
`;

/* ------------------------------------------------------------------ */
/* Detail shader (vertex-coloured PBR + per-vertex MR + emissive)      */
/* ------------------------------------------------------------------ */

const DETAIL_VERT_PARS = /* glsl */ `
attribute vec2 aMR;
attribute vec3 aEmissive;
varying vec2 vMR;
varying vec3 vEmi;
varying vec3 vWPosD;
varying vec3 vWNrmD;
`;

const DETAIL_VERT_MAIN = /* glsl */ `
vMR = aMR;
vEmi = aEmissive;
vec4 wpD = modelMatrix * vec4(transformed, 1.0);
vWPosD = wpD.xyz;
vWNrmD = normalize(mat3(modelMatrix) * objectNormal);
`;

const DETAIL_FRAG_PARS = /* glsl */ `
varying vec2 vMR;
varying vec3 vEmi;
varying vec3 vWPosD;
varying vec3 vWNrmD;
uniform float uNight;
${SKY_GLSL}
`;

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

export interface CityMaterials {
  facade: THREE.MeshStandardMaterial;
  surface: THREE.MeshStandardMaterial;
  detail: THREE.MeshStandardMaterial;
  /** Uniform objects shared across all three, so a weather change tints once. */
  shared: {
    uSunDir: { value: THREE.Vector3 };
    uWetness: { value: number };
    uEnvMix: { value: number };
    uNight: { value: number };
  };
  setSunDirection(v: THREE.Vector3): void;
  setWetness(w: number): void;
  dispose(): void;
}

function sunDirection(): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(HeroSun.elevationDeg);
  const az = THREE.MathUtils.degToRad(HeroSun.azimuthDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();
}

function skyUniforms(shared: CityMaterials['shared']): Record<string, THREE.IUniform> {
  return {
    uSkyHorizon: { value: Palette.skyHorizon },
    uSkyLow: { value: Palette.skyLowBand },
    uSkyMid: { value: Palette.skyMidBand },
    uSkyHigh: { value: Palette.skyHighBand },
    uSkyZenith: { value: Palette.skyZenith },
    uSunCore: { value: Palette.sunCore },
    uSunDir: shared.uSunDir,
    uEnvMix: shared.uEnvMix,
  };
}

export function createCityMaterials(): CityMaterials {
  const shared: CityMaterials['shared'] = {
    uSunDir: { value: sunDirection() },
    uWetness: { value: Atmosphere.wetness as number },
    uEnvMix: { value: 1.0 },
    uNight: { value: 0.0 },
  };

  /* ---- facade ---- */
  const facade = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 1.0,
    // The grammar adds its own analytic sky reflection; a full-strength IBL on
    // top of it turns every curtain wall into a light box.
    envMapIntensity: 0.28,
    dithering: true,
  });
  facade.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms(shared), {
      uTravertine: { value: Palette.travertine },
      uConcrete: { value: Palette.concreteGrey },
      uStucco: { value: new THREE.Color(0xa08a78).convertSRGBToLinear() },
      uGlassTint: { value: Palette.glassTint },
      uStone: { value: new THREE.Color(0xd8cdbc).convertSRGBToLinear() },
      uPurple: { value: Palette.builderPurple },
      uMagenta: { value: Palette.builderMagenta },
      uSodium: { value: Palette.sodiumLamp },
      uNeon: { value: Palette.neonPink },
      uRust: { value: Palette.daciaRust },
      uNight: shared.uNight,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FACADE_VERT_PARS}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${FACADE_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_FRAG_PARS}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        Fac _f = facadeGrammar();
        // Distance LOD. Window bays are ~1.2 m; past a few hundred metres they
        // fall under a pixel and turn into crawling moire that bloom then
        // amplifies into a glowing honeycomb. Fade the high-frequency terms out
        // and let the massing and the aerial haze carry the far field.
        float _dLod = smoothstep(70.0, 340.0, distance(vWPosF, cameraPosition));
        _f.emissive *= 1.0 - _dLod * 0.86;
        _f.rough = mix(_f.rough, 0.80, _dLod);
        _f.metal = mix(_f.metal, 0.0, _dLod);
        // Night: interiors carry the frame, so emissive gains while albedo
        // (which now has almost no key light on it) falls back.
        _f.emissive *= 1.0 + uNight * 1.6;
        diffuseColor.rgb = _f.albedo * (1.0 - uNight * 0.30);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = clamp(_f.rough, 0.03, 1.0);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        'float metalnessFactor = clamp(_f.metal, 0.0, 1.0);',
      )
      .replace(
        '#include <aomap_fragment>',
        'reflectedLight.indirectDiffuse *= _f.ao;',
      )
      .replace(
        '#include <emissivemap_fragment>',
        'totalEmissiveRadiance = _f.emissive;',
      )
      // Glass and polished stone need a sky specular even without an env map.
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          vec3 _vd = normalize(vWPosF - cameraPosition);
          vec3 _n = normalize(vWNrmF);
          vec3 _r = reflect(_vd, _n);
          float _f0 = mix(0.045, 1.0, metalnessFactor);
          float _fres = _f0 + (1.0 - _f0) * pow(1.0 - max(dot(-_vd, _n), 0.0), 5.0);
          float _gloss = 1.0 - roughnessFactor;
          vec3 _sky = gtaSky(_r);
          reflectedLight.indirectSpecular += _sky * _fres *
            ((0.10 + 0.90 * _gloss * _gloss) * diffuseColor.rgb * 0.14 + _gloss * _gloss * 0.11);
          // Sky-dome hemisphere fill so nothing reads as flat black.
          reflectedLight.indirectDiffuse += gtaSky(_n * 0.6 + vec3(0.0, 0.4, 0.0)) * diffuseColor.rgb * 0.13;
        }
        `,
      );
  };
  facade.customProgramCacheKey = () => 'gta-facade-v1';

  /* ---- surface ---- */
  const surface = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 1.0,
    // The analytic mirror below already carries the sky; letting the IBL do it
    // a second time at roughness 0.1 blows the carriageway to a white slab.
    envMapIntensity: 0.35,
    dithering: true,
  });
  surface.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms(shared), {
      uAsphalt: { value: Palette.asphaltWet },
      uPaveStone: { value: Palette.sidewalkStone },
      uKerb: { value: new THREE.Color(0x6d6470).convertSRGBToLinear() },
      uGrass: { value: Palette.leafOlive },
      uGravelC: { value: new THREE.Color(0x4a4038).convertSRGBToLinear() },
      uWaterC: { value: new THREE.Color(0x243046).convertSRGBToLinear() },
      uMarking: { value: new THREE.Color(0xe8e2d6).convertSRGBToLinear() },
      uWetness: shared.uWetness,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SURF_VERT_PARS}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${SURF_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURF_FRAG_PARS}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        Surf _s = surfaceShade();
        diffuseColor.rgb = _s.albedo;
        `,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(_s.rough, 0.02, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(_s.metal, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = _s.emissive;')
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        reflectedLight.indirectDiffuse += gtaSky(vec3(0.0, 0.75, 0.0)) * diffuseColor.rgb * 0.14;
        `,
      );
  };
  surface.customProgramCacheKey = () => 'gta-surface-v1';

  /* ---- detail ---- */
  const detail = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 1.0,
    dithering: true,
  });
  detail.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms(shared), { uNight: shared.uNight });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DETAIL_VERT_PARS}`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>\n${DETAIL_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DETAIL_FRAG_PARS}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vMR.y, 0.03, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(vMR.x, 0.0, 1.0);')
      .replace(
        '#include <emissivemap_fragment>',
        // Sodium lamps, screens and lit doorways drive the night frame.
        'totalEmissiveRadiance = vEmi * (1.0 + uNight * 2.2);',
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          vec3 _vd = normalize(vWPosD - cameraPosition);
          vec3 _n = normalize(vWNrmD);
          float _f0 = mix(0.04, 1.0, metalnessFactor);
          float _fres = _f0 + (1.0 - _f0) * pow(1.0 - max(dot(-_vd, _n), 0.0), 5.0);
          float _gloss = 1.0 - roughnessFactor;
          reflectedLight.indirectSpecular += gtaSky(reflect(_vd, _n)) * _fres * _gloss * _gloss * 0.7;
          reflectedLight.indirectDiffuse += gtaSky(_n * 0.5 + vec3(0.0, 0.5, 0.0)) * diffuseColor.rgb * 0.25;
        }
        `,
      );
  };
  detail.customProgramCacheKey = () => 'gta-detail-v1';

  return {
    facade,
    surface,
    detail,
    shared,
    setSunDirection(v) {
      shared.uSunDir.value.copy(v).normalize();
    },
    setWetness(w) {
      shared.uWetness.value = w;
    },
    dispose() {
      facade.dispose();
      surface.dispose();
      detail.dispose();
    },
  };
}
