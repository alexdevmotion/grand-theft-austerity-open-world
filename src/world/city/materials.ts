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
import { Atmosphere, HeroSun } from '../../artDirection';
import { srgb } from '../../render/materials';

export const FacadeStyle = {
  glassCorporate: 0,
  bulevard: 1,
  cartier: 2,
  centruVechi: 3,
  guvern: 4,
  industrial: 5,
  /** Plain rendered wall — podiums, blank party walls, park pavilions. */
  plain: 6,
  /**
   * INTERBELIC MODERNISM — the dominant architecture of central Bucharest and
   * the thing that makes Magheru look like Magheru rather than like any
   * mid-century European boulevard. Continuous horizontal balcony bands and
   * string courses, wide horizontal windows, deep reveals, rounded corner
   * expression, and weathered ochre-cream render that has been patched a dozen
   * times in eighty years.
   */
  interbelic: 7,
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

/**
 * GEOMETRIC RELIEF FROM A PROCEDURAL HEIGHT FIELD.
 *
 * A curtain wall painted as a flat rectangle with a grid drawn on it is the
 * single clearest tell that a building is fake: real glazing sits 60-120 mm
 * BEHIND its mullions, every transom throws a hard shadow across the pane
 * under it, and a low sun rakes those reveals into a ladder of light and dark.
 * Painted lines cannot do any of that, because they never change the normal.
 *
 * This is the standard "derivative bump" construction (the same maths three's
 * own perturbNormalArb uses for bump maps), applied to an ANALYTIC height in
 * metres rather than a texture: it costs two derivatives and two cross
 * products, works on any topology, and needs no tangents, no UV unwrap and no
 * texture memory. Everything downstream — the sun, the cascades, the IBL and
 * the specular — then sees the real recessed surface.
 *
 * eyePos and surfN must both be VIEW space; hgt is metres of outward
 * displacement.
 */
vec3 gtaRelief(vec3 eyePos, vec3 surfN, float hgt, float scale) {
  vec2 dH = vec2(dFdx(hgt), dFdy(hgt)) * scale;
  if (dot(dH, dH) < 1e-12) return surfN;
  vec3 sx = dFdx(eyePos);
  vec3 sy = dFdy(eyePos);
  vec3 R1 = cross(sy, surfN);
  vec3 R2 = cross(surfN, sx);
  float det = dot(sx, R1);
  vec3 grad = sign(det) * (dH.x * R1 + dH.y * R2);
  return normalize(abs(det) * surfN - grad);
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
uniform vec3 uOffice;
/* Live look-dev knobs, driven from window.__GTA_CITYMAT__. */
uniform float uEmissiveGain;
uniform float uEnvGain;
uniform float uNight;
/** Dusk-to-night ramp on every interior light in the city. */
#define uLitGain (0.34 + 0.66 * uNight)
${SKY_GLSL}

struct Fac {
  vec3 albedo;
  vec3 emissive;
  float rough;
  float metal;
  float ao;
  /** Outward relief in metres — drives the analytic normal (see gtaRelief). */
  float height;
  /** Per-pixel weight on the EnvProbe radiance. 1 = the material default. */
  float env;
  /** Extra per-panel normal tilt, in facade tangent space. Glass is never flat. */
  vec2 tilt;
};

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
  f.height = 0.0;
  f.env = 1.0;
  f.tilt = vec2(0.0);

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
    /*
     * THE HERO SURFACE. Everything in the reference frame that reads as
     * "expensive" comes off this wall, and it has to do four things at once:
     *
     *   1. STONE AND GLASS TOGETHER. The reference tower is not a glass box.
     *      A travertine slab runs its full height and is the ONLY genuinely
     *      warm surface in the picture; the cold violet curtain wall only
     *      reads as cold because that warm stone is next to it. A uniform
     *      glass tower has nothing to be cold against.
     *   2. REAL DEPTH. Glazing sits behind its mullions, transoms project,
     *      every pane has a reveal and a sill. See f.height / gtaRelief.
     *   3. A MOSAIC, NOT A MIRROR. Each pane is bowed and tinted slightly
     *      differently, so a curtain wall breaks the sunset into a hundred
     *      slightly different slices instead of showing one smooth gradient.
     *   4. LIT ROOMS BEHIND IT, not lightboxes stuck on it.
     */

    /* ---- 1. travertine cladding ---- */
    // u restarts at 0 on every wall face, so a pier at low u lands exactly on
    // the building's vertical corner — which is where a real stone-clad core
    // or lift shaft expresses itself, and where the reference has its slab.
    float pierW = 4.0 + 4.6 * h11(seed * 1.73);
    float corner = 1.0 - smoothstep(pierW, pierW + 0.9, u);
    // Plus whole three-bay groups elsewhere on the elevation. Raised from one
    // group in three to nearly one in two: the reference's tower is roughly
    // half stone by area, and the violet glass only reads as COLD because a
    // large warm surface is standing next to it. Too little stone and the
    // whole building collapses into one cold value with nothing to play off.
    float grp = floor(bi / 3.0);
    float band3 = step(0.56, h11(grp * 7.31 + seed * 2.17 + 1.0));
    float stone = clamp(corner + band3, 0.0, 1.0);

    if (stone > 0.5) {
      // Travertine: horizontal bedding planes, open pitting, sawn coursing.
      // Authored BRIGHT on purpose — this is the frame's warm anchor.
      float bed = fbm2(vec2(u * 0.75, v * 4.4));
      float pit = smoothstep(0.74, 0.96, fbm2(vec2(u * 7.0, v * 7.0)));
      f.albedo = uTravertine * (0.80 + bed * 0.46) * (1.0 - pit * 0.34);
      f.rough = 0.64 + bed * 0.16 + pit * 0.2;
      f.metal = 0.0;
      f.env = 0.85;
      // Coursing: 1.15 m courses, 1.55 m joints, both as real recesses.
      float course = band(fract(v / 1.15) - 0.5, 0.020);
      float joint  = band(fract(u / 1.55) - 0.5, 0.016);
      float cut = max(course, joint);
      f.albedo *= 1.0 - 0.30 * cut;
      f.ao = 1.0 - 0.30 * cut;
      f.height = -0.022 * cut;
      // The slab stands PROUD of the curtain wall it abuts, so its edge throws
      // a shadow onto the glass and the two materials never read as coplanar.
      f.height += 0.16 * smoothstep(pierW + 0.9, pierW + 0.35, u) * corner;
      // Narrow punched openings, deeply reveal-ed, on the stone.
      float wW = 0.55;
      float wH = floorH * 0.44;
      vec2 wc = vec2(um - bayW * 0.5, vm - floorH * 0.52);
      float win = rectMask(wc, vec2(wW * 0.5, wH * 0.5)) * (1.0 - isGround) * band3;
      f.albedo = mix(f.albedo, vec3(0.014, 0.012, 0.024), win);
      f.height -= 0.19 * win;
      float lit = step(1.0 - litBias * 0.7, h21(cell * 2.9 + seed));
      f.emissive += mix(uOffice, uPurple, 0.22) * win * lit * 0.056 * uLitGain;
      f.rough = mix(f.rough, 0.4, win);
      return f;
    }

    /* ---- 2. the curtain wall module ---- */
    float mullionW = 0.075;   // half-width of a vertical mullion, metres
    float transomW = 0.09;    // half-width of the floor-line transom
    float spandrel = 0.80;    // opaque slab band at the bottom of each storey

    // Distance in METRES from this fragment to the nearest pane edge. Positive
    // inside the glass, negative on the frame. Metres, not UV, because the
    // reveal has to be a fixed physical depth on a 3 m storey and on a 4.5 m one.
    float dEdgeU = min(um - mullionW, (bayW - mullionW) - um);
    float dEdgeV = min(vm - (spandrel + transomW), (floorH - transomW) - vm);
    float dEdge = min(dEdgeU, dEdgeV);

    float inSpandrel = step(vm, spandrel) * (1.0 - isGround);
    // 55 mm chamfer from frame face to glass face — the reveal.
    float inGlass = smoothstep(0.0, 0.055, dEdge) * (1.0 - inSpandrel);
    float onFrame = 1.0 - smoothstep(-0.02, 0.03, dEdge);

    // ---- relief, in metres of outward displacement ----
    // Glazing recessed 85 mm behind the frame; the transom at each floor line
    // projects a further 40 mm and carries a sill that catches the low sun.
    f.height = -0.085 * inGlass;
    f.height += 0.026 * band(vm, transomW * 1.6) * (1.0 - isGround);
    float sillT = smoothstep(spandrel + transomW + 0.10, spandrel + transomW - 0.02, vm)
                * smoothstep(spandrel - 0.06, spandrel + 0.02, vm);
    f.height += 0.055 * sillT;
    // Vertical mullions stand proud too, which is what casts the long vertical
    // shadow lines down a curtain wall lit from the side.
    f.height += 0.020 * max(band(um, mullionW * 1.5), band(um - bayW, mullionW * 1.5));

    /* ---- 3. the mosaic ---- */
    // Each pane is a separately-glazed unit: it has its own tint, its own
    // slight bow (glass is never dead flat — it is a pressure-sealed cavity)
    // and its own reflectance. Those three together are what turn a curtain
    // wall into a hundred different slices of sunset rather than one gradient.
    vec3 pid = h23(cell + seed * 3.0);
    /*
     * THE BOW, AND WHY IT HAS TO BE THIS BIG.
     *
     * A reflected ray turns by TWICE the surface normal, and the sky this game
     * reflects goes from hot orange at the horizon to violet thirty degrees up.
     * So a pane needs several degrees of tilt before its reflection lands in a
     * measurably different band of that gradient. The previous authoring used
     * a 2-degree per-pane constant, which is physically about right for real
     * glazing and visually did nothing at all: every pane sampled the same
     * slice of probe and the curtain wall rendered as one smooth gradient —
     * the exact flat-rectangle read this whole grammar exists to avoid.
     *
     * 0.16 rad (9 degrees) of per-pane constant plus a pillow across the pane
     * is an exaggeration, and it is the exaggeration that buys the mosaic.
     */
    vec2 pn = vec2(um / bayW - 0.5, (vm - spandrel) / max(floorH - spandrel, 0.5) - 0.5);
    f.tilt = (pn * (0.22 + pid.z * 0.30) + (pid.xy - 0.5) * 0.32) * inGlass;

    // DARK glass. Acceptance test from the previous pass still holds: the mean
    // luminance of the tower must sit below the mean luminance of the open sky.
    // The mosaic comes from the drift about the tint, never from lifting it.
    vec3 glass = uGlassTint * vec3(
      0.50 + pid.x * 0.70,
      0.58 + pid.y * 0.58,
      0.70 + pid.z * 0.46);

    // Lit interiors behind the glass.
    float lit = step(1.0 - litBias, h21(cell * 1.7 + seed * 3.0 + 4.0));
    vec2 pane = vec2(bu, clamp((vm - spandrel) / max(floorH - spandrel, 0.5), 0.0, 1.0));
    float inner = officeInterior(pane, ch * 91.0 + seed);
    // Four floors in five are ordinary warm office fluorescent; the fifth is
    // one of the Builders' purple/magenta fit-outs. That ratio is what gives
    // the tower two hues to play against each other instead of one.
    float rk = h21(cell + 9.0);
    vec3 room = rk > 0.82 ? mix(uPurple, uMagenta, h11(rk * 31.0)) * 0.55 : uOffice;
    vec3 emis = room * lit * (1.0 - inner * 0.80) * 0.019 * uLitGain;
    emis += room * lit * smoothstep(0.82, 0.98, pane.y) * 0.017 * uLitGain;

    vec3 spandrelCol = mix(uGlassTint * 0.55, uStone * 0.10, 0.5);

    f.albedo = mix(glass, spandrelCol, inSpandrel);
    f.emissive = emis * inGlass;
    f.metal = mix(0.10, 0.78, inGlass);
    // Per-pane roughness drift: a real facade has clean panes and dirty ones,
    // and the dirty ones blur the sunset while the clean ones mirror it. That
    // difference is most of what makes the mosaic read, so the spread is wide
    // — a near-mirror at 0.03 against a milky 0.24 in the same elevation.
    f.rough = mix(0.55, 0.030 + pid.x * 0.21, inGlass);
    // The pane is where the environment reflection belongs, at full strength.
    // Widened for the same reason as the tilt: panes must differ in how much
    // sky they throw back, not only in which bit of it they throw back.
    f.env = mix(0.55, 1.1 + pid.y * 2.3, inGlass);
    f.ao = mix(1.0, 0.9, onFrame);

    // Mullion caps: anodised aluminium, warm, catching the sun along its length.
    f.albedo = mix(f.albedo, uStone * 0.20, onFrame);
    f.metal = mix(f.metal, 0.55, onFrame);
    f.rough = mix(f.rough, 0.34, onFrame);
    f.env = mix(f.env, 0.9, onFrame);
    f.emissive *= (1.0 - onFrame);

    /* ---- 4. travertine podium at street level ---- */
    if (isGround > 0.5) {
      float grain = fbm2(vec2(u * 2.2, v * 5.0));
      f.albedo = uTravertine * (0.86 + grain * 0.50);
      f.metal = 0.0;
      f.rough = 0.68 - grain * 0.14;
      f.env = 0.85;
      f.tilt = vec2(0.0);
      float course = band(fract(v / 1.15) - 0.5, 0.022);
      float joint = band(fract(u / 1.55) - 0.5, 0.018);
      float cut = max(course, joint);
      f.albedo *= 1.0 - 0.32 * cut;
      f.height = -0.024 * cut;
      /*
       * THE LOBBY. In the reference you look THROUGH the ground floor into a
       * lit room with people and furniture in it, and it glows purple. A flat
       * emissive panel at the same brightness reads as a light box stuck to a
       * wall; the depth comes from the interior silhouettes breaking it up and
       * from the glazing sitting 220 mm behind its frame.
       */
      float lobby = step(1.6, v) * step(v, groundH - 0.9);
      float pier = step(0.20, bu) * step(bu, 0.80);
      float glassBand = lobby * pier;
      f.albedo = mix(f.albedo, uGlassTint * 0.5, glassBand);
      vec3 lobbyLight = mix(uOffice, mix(uPurple, uMagenta, h11(bi + seed)), 0.55);
      vec2 lp = vec2(clamp((bu - 0.20) / 0.60, 0.0, 1.0),
                     clamp((v - 1.6) / max(groundH - 2.5, 0.8), 0.0, 1.0));
      float lobbyInner = officeInterior(lp, h11(bi * 5.9 + seed) * 71.0 + seed);
      // Ceiling wash: the brightest part of any lit interior seen from outside.
      float ceil_ = smoothstep(0.68, 0.98, lp.y);
      f.emissive += lobbyLight * glassBand * (1.0 - lobbyInner * 0.86) * 0.085 * uLitGain;
      f.emissive += lobbyLight * glassBand * ceil_ * 0.07 * uLitGain;
      f.metal = mix(f.metal, 0.30, glassBand);
      f.rough = mix(f.rough, 0.11, glassBand);
      f.env = mix(f.env, 1.5, glassBand);
      f.height -= 0.22 * glassBand;
      // Transoms across the shopfront: without them a 4 m tall glazed strip is
      // one undivided sheet, which no real lobby ever is.
      float lt = band(fract((v - 1.6) / 1.6) - 0.5, 0.035) * glassBand;
      f.albedo = mix(f.albedo, uStone * 0.18, lt);
      f.height += 0.06 * lt;
      f.emissive *= 1.0 - lt * 0.8;
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
    vec3 room = mix(uSodium, uMagenta, h21(cell + 3.0) * 0.35);
    vec2 pane = (wc / vec2(wW, wH)) + 0.5;
    float inner = officeInterior(pane, ch * 53.0 + seed);
    f.albedo = mix(f.albedo, vec3(0.012, 0.010, 0.022), win);
    f.emissive += room * lit * win * (1.0 - inner * 0.9) * 0.07 * uLitGain;
    f.metal = mix(f.metal, 0.0, win);
    f.rough = mix(f.rough, 0.42, win);
    f.albedo *= 1.0 - 0.45 * reveal;
    // Real depth: the pane sits 160 mm back inside a 100 mm splayed reveal,
    // and the sill projects. A painted rectangle cannot cast the hard lintel
    // shadow that a low sun puts across the top of every opening.
    f.height = -0.16 * win - 0.07 * reveal;
    f.height += 0.05 * band(vm - (floorH * 0.52 - wH * 0.5 - 0.09), 0.05)
                     * step(abs(wc.x), wW * 0.62);
    f.height -= 0.02 * pil;

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
      /*
       * SHOP INTERIORS WITH DEPTH. A lit rectangle in a wall is a light box.
       * A shop is a lit ceiling with shelving and people in front of it, and
       * the silhouettes are what turn the glazing from a panel into a room —
       * the same trick the upper floors use, at a scale you walk past.
       */
      vec2 spq = vec2(clamp((bu - 0.14) / 0.72, 0.0, 1.0),
                      clamp((v - 0.75) / max(groundH - 2.1, 0.8), 0.0, 1.0));
      float shopInner = officeInterior(spq, sh * 83.0 + seed);
      f.emissive += sign * shopGlass * (1.0 - shopInner * 0.82) * (0.075 + sh * 0.10) * uLitGain;
      // Ceiling strip deep inside the shop.
      f.emissive += uOffice * shopGlass * smoothstep(0.72, 0.97, spq.y) * 0.09 * uLitGain;
      // The glazing is 180 mm behind its frame, so the head and the stallriser
      // both throw a shadow into it under a raking sun.
      f.height -= 0.18 * shopGlass;
      // Fascia sign band above the glazing.
      float fascia = step(groundH - 1.25, v) * step(v, groundH - 0.35);
      f.albedo = mix(f.albedo, mix(uRust, uNeon, sh) * 0.25, fascia);
      float letters = step(0.55, fbm2(vec2(u * 7.0, v * 3.0)));
      f.emissive += sign * fascia * letters * 0.10 * uLitGain;
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
    // Panel joints are 20 mm recesses, loggias are 700 mm ones, and the glass
    // is 140 mm behind its frame. On a bloc that grid of relief IS the facade.
    f.height = -0.020 * max(jv, jh) - 0.70 * balc - 0.14 * win + 0.02 * frame;

    float lit = step(1.0 - litBias, h21(cell * 1.3 + seed * 2.0));
    vec3 room = mix(uSodium, uMagenta, h21(cell + 7.0) * 0.6);
    vec2 pane = (wc / vec2(wW, wH)) + 0.5;
    float inner = officeInterior(pane, ch * 31.0 + seed);
    f.albedo = mix(f.albedo, vec3(0.010, 0.009, 0.020), win);
    f.emissive += room * lit * win * (1.0 - inner * 0.88) * 0.065 * uLitGain;
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
      f.emissive += uSodium * door * 0.08 * uLitGain;
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
    // Moulded architrave proud of the render, glass deep behind it.
    f.height = 0.055 * trim - 0.20 * win + 0.03 * pil;

    float lit = step(1.0 - litBias, h21(cell * 1.9 + seed));
    vec3 room = mix(uSodium, uNeon, h21(cell + 2.0) * 0.5);
    f.emissive += room * lit * win * 0.075 * uLitGain;
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
      f.emissive += mix(uNeon, uSodium, sh) * open * (0.07 + sh * 0.13) * uLitGain;
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
    // Weathered limestone, not a polished slab.
    f.rough = 0.84;

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
    // A giant order only reads if the pilasters actually project and the
    // windows actually recede; on the Palace axis this is the whole effect.
    f.height = 0.11 * pil * aboveBase - 0.30 * win - 0.10 * rev;
    float lit = step(1.0 - litBias, h21(cell * 2.7 + seed));
    f.emissive += mix(uSodium, uPurple, 0.25) * win * lit * 0.06 * uLitGain;
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
    // Corrugated sheet is 25 mm deep. As relief it self-shades under the low
    // sun; as an albedo ripple it was a painted stripe that never moved.
    f.height = rib * 0.025;

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
    f.emissive += mix(uSodium, uPurple, 0.3) * strip * (1.0 - mull) * lit * 0.07 * uLitGain;
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
                    rectMask(vec2(fract(u / 9.0) - 0.5, 0.0), vec2(0.06, 1e3)) * 0.12 * uLitGain;
    }
    return f;
  }

  /* ---------------- 6: plain rendered wall ---------------- */
  if (style < 6.5) {
    float grain = fbm2(vec2(u * 1.6, v * 1.4));
    f.albedo = mix(uStucco, uConcrete, tint) * (0.55 + grain * 0.55);
    f.rough = 0.90;
    f.albedo *= 1.0 - 0.22 * smoothstep(2.0, 0.0, v);
    return f;
  }

  /* ---------------- 7: interbelic modernism ---------------- */
  /*
   * THE MAGHERU FACADE. What the reference photograph is actually made of, and
   * what the city was missing: every block on that boulevard is banded
   * HORIZONTALLY — a continuous balcony running the full width of the elevation
   * at most floors, a projecting string course at every floor line, and windows
   * that are WIDER than they are tall. The existing boulevard grammar had it
   * backwards: tall narrow punched openings on a vertically-pilastered wall,
   * which is a nineteenth-century apartment block, not a 1935 one.
   *
   * The other half of the look is the render. It is not one colour. Eighty
   * years of patch repairs, water staining below every sill and balcony, and
   * mismatched paint between one owner's bay and the next give a facade that
   * is blotchy at three different scales at once — and that patina is most of
   * what separates Bucharest from a clean modernist reconstruction.
   */
  {
    /* ---- weathered render ---- */
    // Three scales of colour variation: the base ochre/cream choice, metre-
    // scale patch repairs, and fine render grain.
    vec3 warm = mix(uStucco, uTravertine, 0.35 + tint * 0.5);
    vec3 pale = mix(uStone, uTravertine, tint * 0.4);
    vec3 base = mix(warm, pale, step(0.5, h11(seed * 1.31)));
    float grain = fbm2(vec2(u * 2.1, v * 1.9));
    // Patch repairs: broad blotches of slightly wrong colour, hard-edged where
    // somebody rendered over a section and never matched it.
    // NB: "patch" is a RESERVED WORD in GLSL ES 3.0 (tessellation). Declaring a
    // float by that name fails the whole fragment shader to compile, which
    // silently removes every wall in the city and leaves the roofs floating.
    float patchId = h21(vec2(floor(u / 5.5 + h11(seed) * 3.0), floor(v / 4.5)) + seed * 3.0);
    float patchAmt = step(0.62, patchId);
    f.albedo = base * (0.62 + grain * 0.44);
    f.albedo = mix(f.albedo, f.albedo * mix(0.80, 1.16, h11(patchId * 17.0)), patchAmt * 0.75);
    f.rough = 0.90 - grain * 0.06;
    f.env = 0.7;

    /* ---- the horizontal banding ---- */
    // A projecting string course at every floor line. This is the single
    // strongest cue in the whole style: it is what turns a wall into a stack.
    float courseT = band(vm, 0.13);
    f.height += 0.075 * courseT;
    f.albedo *= 1.0 - 0.16 * band(vm - 0.16, 0.05);   // shadow under it

    /* ---- continuous balconies ---- */
    // Whole floors carry a balcony that runs the FULL width of the elevation,
    // not a balcony per bay. Alternating-ish, chosen per floor.
    float hasBalc = step(0.42, h21(vec2(0.0, fi) + seed * 7.0));
    // The recess sits above the floor line; the solid parapet closes its front.
    float recessLo = 0.30;
    float recessHi = floorH * 0.42;
    float inRecess = hasBalc * step(recessLo, vm) * step(vm, recessHi) * (1.0 - isGround);
    f.albedo = mix(f.albedo, base * 0.30, inRecess);
    f.ao = mix(f.ao, 0.40, inRecess);
    f.height -= 0.62 * inRecess;
    // Parapet: a solid render band standing in front of the recess, with a
    // coping line along its top. Rendered as relief so it self-shades.
    float parapetT = hasBalc * band(vm - (recessLo + 0.02), 0.34) * (1.0 - isGround);
    f.height += 0.50 * parapetT;
    f.albedo = mix(f.albedo, base * (0.86 + grain * 0.3), parapetT);
    f.albedo *= 1.0 - 0.22 * band(vm - (recessLo + 0.36), 0.035) * hasBalc;

    /* ---- wide horizontal windows ---- */
    // 1.5:1 landscape proportion, in a deep reveal, set back behind the
    // balcony line. Grouped in pairs so the bay reads as a room, not a slot.
    float wW = bayW * 0.72;
    float wH = floorH * 0.34;
    vec2 wc = vec2(um - bayW * 0.5, vm - floorH * 0.66);
    float win = rectMask(wc, vec2(wW * 0.5, wH * 0.5)) * (1.0 - isGround);
    float reveal = (rectMask(wc, vec2(wW * 0.5 + 0.09, wH * 0.5 + 0.09)) - win) * (1.0 - isGround);
    // A central mullion: interbelic windows are wide, and always divided.
    float mull = band(wc.x, 0.035) * win;
    f.albedo = mix(f.albedo, vec3(0.013, 0.011, 0.023), win);
    f.albedo = mix(f.albedo, base * 0.9, mull);
    f.albedo *= 1.0 - 0.42 * reveal;
    f.height += -0.17 * win - 0.07 * reveal + 0.03 * mull;
    // Projecting sill, which is where the staining starts.
    float sill = band(vm - (floorH * 0.66 - wH * 0.5 - 0.07), 0.055) * step(abs(wc.x), wW * 0.60);
    f.height += 0.05 * sill;

    float lit = step(1.0 - litBias, h21(cell * 3.1 + seed));
    vec3 room = mix(uSodium, uOffice, h21(cell + 5.0) * 0.7);
    vec2 pane = (wc / vec2(wW, wH)) + 0.5;
    float inner = officeInterior(pane, ch * 61.0 + seed);
    f.emissive += room * lit * win * (1.0 - inner * 0.88) * 0.07 * uLitGain;
    f.rough = mix(f.rough, 0.42, win);

    /* ---- staining ---- */
    /*
     * Water runs off every sill and every balcony and leaves a vertical streak
     * down the render below it. In the reference these streaks are everywhere
     * and they are what stops a cream facade reading as freshly painted.
     */
    float streak = smoothstep(0.35, 0.95, fbm2(vec2(u * 4.2, v * 0.13)));
    float below = smoothstep(floorH * 0.34, 0.0, vm);
    f.albedo *= 1.0 - 0.30 * streak * below;
    // Grime gathering in the shade of the banding, and up from the pavement.
    f.albedo *= 1.0 - 0.20 * smoothstep(2.4, 0.0, v);

    /* ---- rounded corner expression ---- */
    // A real interbelic corner block turns the corner in a curve. The massing
    // is orthogonal here, so the corner is expressed instead: u restarts at 0
    // on every face, so a band at low u lands exactly on the vertical arris,
    // where these buildings run a smooth rendered pier with no banding on it.
    float roundR = 1.7 + 1.4 * h11(seed * 5.9);
    float corner = 1.0 - smoothstep(roundR, roundR + 0.7, u);
    f.albedo = mix(f.albedo, base * (0.94 + grain * 0.24), corner * 0.85);
    f.height = mix(f.height, 0.045, corner * 0.9);
    f.ao = mix(f.ao, 1.0, corner);

    /* ---- cornice ---- */
    float toTop = bh - v;
    f.albedo = mix(f.albedo, base * 1.24, band(toTop - 0.7, 0.34));
    f.albedo *= 1.0 - 0.30 * band(toTop - 1.25, 0.06);

    /* ---- ground floor retail ---- */
    if (isGround > 0.5) {
      float shopIdx = floor(u / (bayW * 1.6));
      float sh = h11(shopIdx * 4.1 + seed);
      float glassY = step(0.8, v) * step(v, groundH - 1.30);
      float pier = step(0.10, bu) * step(bu, 0.90);
      float shopGlass = glassY * pier;
      f.albedo = mix(uStone * 0.36, vec3(0.02, 0.017, 0.03), shopGlass);
      f.rough = mix(0.78, 0.30, shopGlass);
      vec3 sign = mix(uNeon, uSodium, sh);
      vec2 spq = vec2(clamp((bu - 0.10) / 0.80, 0.0, 1.0),
                      clamp((v - 0.8) / max(groundH - 2.1, 0.8), 0.0, 1.0));
      float shopInner = officeInterior(spq, sh * 67.0 + seed);
      f.emissive += sign * shopGlass * (1.0 - shopInner * 0.82) * (0.07 + sh * 0.10) * uLitGain;
      f.emissive += uOffice * shopGlass * smoothstep(0.72, 0.97, spq.y) * 0.09 * uLitGain;
      f.height -= 0.18 * shopGlass;
      // Fascia band over the shopfront.
      float fascia = step(groundH - 1.20, v) * step(v, groundH - 0.30);
      f.albedo = mix(f.albedo, mix(uRust, uNeon, sh) * 0.24, fascia);
      float letters = step(0.55, fbm2(vec2(u * 7.0, v * 3.0)));
      f.emissive += sign * fascia * letters * 0.10 * uLitGain;
      f.albedo = mix(f.albedo, uStone * 0.24, step(v, 0.8));
    }
    return f;
  }
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
uniform float uNight;
${SKY_GLSL}

struct Surf {
  vec3 albedo;
  vec3 emissive;
  float rough;
  float metal;
  /** Per-pixel weight on the EnvProbe radiance — this is the wet reflection. */
  float env;
  /** Outward relief in metres (kerb arrises, sett domes, paving joints). */
  float height;
};

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
  s.env = 1.0;
  s.height = 0.0;

  float wet = uWetness;
  /** Extra wetness on top of the base mask — gutters, low spots, tram beds. */
  float pooling = 0.0;

  if (kind < 0.5) {
    /* ---- carriageway ---- */
    float grain = fbm2(wp * 1.35);
    float coarse = vnoise(wp * 0.22);
    s.albedo = uAsphalt * (0.62 + grain * 0.55 + coarse * 0.35);
    // DRY TARMAC IS ROUGH. 0.75 is what an unworn wearing course measures; the
    // old 0.52 meant the "dry" end of the wet lerp was already half-glossy, so
    // there was no contrast for the wet end to be wet AGAINST and the whole
    // carriageway collapsed into one reflectivity.
    s.rough = 0.78 - grain * 0.12;

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

    // Tyre polish in the wheel tracks — bitumen worn smooth by rubber.
    float track = 0.0;
    for (int i = 0; i < 3; i++) {
      float o = (float(i) - 1.0) * laneW + 0.9;
      track = max(track, band(abs(across) - abs(o), 0.55));
    }
    s.rough -= track * 0.14;

    /*
     * A DRY CROWN WITH WET GUTTERS. A carriageway is cambered: it sheds water
     * to its edges, so after rain the centre is merely damp and the gutter line
     * holds standing water. Flooding the whole plane uniformly — which is what
     * a global wetness constant does — gives a lake, and a lake has none of the
     * structure that makes the reference's road read as a wet ROAD.
     */
    float camber = abs(across) / max(halfW, 1.0);
    pooling = smoothstep(0.55, 1.0, camber) * 0.55;
    // The gutter itself: a 1.1 m strip of standing water against the kerb.
    float gutter = smoothstep(halfW, halfW - 1.1, abs(across));
    pooling += gutter * 0.5;
    // ...and the crown sheds, so it is drier than the base mask says.
    pooling -= (1.0 - smoothstep(0.0, 0.42, camber)) * 0.30;
    s.albedo *= 1.0 - gutter * 0.22;
    // Standing water in the wheel tracks: ruts hold it.
    pooling += track * 0.16;
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
    /*
     * A PAVEMENT IS DRY, ROUGH, DUSTY STONE. 0.72 was glossy enough that the
     * footway mirrored the sunset as hard as the carriageway did, and the whole
     * city read as though it were cast in polished marble. Real precast paving
     * is a sanded, worn, slightly dusty surface — it measures up around 0.9,
     * and it is what the reference's kerbside actually looks like. The wet
     * look belongs to the ROAD; it is the contrast between a mirror-wet
     * carriageway and a matte footway that makes the road read as wet at all.
     */
    s.rough = 0.90 - tone * 0.07;
    // Slab joints are 8 mm recesses; sunken slabs hold water. Both are relief.
    float broken = step(0.955, h21(cellId * 1.7 + 4.0));
    s.albedo *= 1.0 - 0.35 * broken;
    s.height = -0.02 * broken;
    // Water sits in the joints and in every sunken slab — this is what makes a
    // wet pavement read as paving rather than as one shiny sheet.
    //
    // The joints must NOT be pooled: they are 8 mm antialiased bands, so any
    // extra wetness on them turns them into near-mirrors and the whole pavement
    // renders as a glowing orange lattice of reflected sky. Water in a joint is
    // sub-pixel; water in a sunken slab is metres across, and only the second
    // one is something the eye can read as wet.
    // Only genuinely sunken slabs hold water; the rest of the footway drains
    // and is dry. Pushed well below the damp threshold so puddles on a pavement
    // are isolated events rather than a continuous sheet.
    pooling = broken * 0.55 - 0.34;
    wet *= 0.30;
  } else if (kind < 2.5) {
    /* ---- kerb face ---- */
    float grain = fbm2(wp * 3.0 + vWPosS.y * 4.0);
    s.albedo = uKerb * (0.7 + grain * 0.5);
    // Sawn granite kerb, weathered and dusty — not a polished one.
    s.rough = 0.88;
    // A kerb face is vertical: water runs straight off it.
    pooling = -0.42;
    wet *= 0.30;
  } else if (kind < 3.5) {
    /* ---- plaza stone: large sawn slabs, radiating pattern ---- */
    vec2 g = wp / 1.85;
    vec2 cellId = floor(g);
    float tone = h21(cellId + seed);
    // The 1.12 lift this used to carry was compensation for a frame that was
    // reading too dark overall; with the grazing-specular sheet gone (see the
    // f90 note below) it is a plain over-brightening of the largest surface in
    // any on-foot framing. Sawn andesite reads about 0.09 linear, not 0.12.
    s.albedo = uPaveStone * (0.55 + tone * 0.30);
    vec2 fj = abs(fract(g) - 0.5);
    float joint = max(band(fj.x - 0.5, 0.020), band(fj.y - 0.5, 0.020));
    s.albedo *= 1.0 - 0.42 * joint;
    /*
     * Sawn plaza stone. The dry stone stays matte — that is what the 0.87
     * roughness and the f90 correction are for — but the plane is NOT bone
     * dry. Holding pooling at -0.36 put the whole mask below the damp
     * threshold, so a civic plaza after rain had no standing water anywhere,
     * no mirror, and therefore nothing bright to be dark NEXT TO: measured, it
     * came out as one uniform mid-grey sheet at p50 94 with sd 22, against the
     * reference's p50 56 with sd 45. The tonal range in the reference is not
     * in its stone, it is in the water lying ON the stone.
     *
     * -0.14 keeps roughly two thirds of the slab field dry and lets the
     * hollows and the joint lines hold a film, which is where the wet response
     * below drops roughness to 0.10 and hands those pixels to the env probe.
     */
    s.rough = 0.87;
    pooling = -0.22;
    wet *= 0.62;
    s.height = -0.012 * joint;
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
    float tj = max(band(fj.x - 0.5, 0.09), band(fj.y - 0.5, 0.07));
    s.albedo *= 1.0 - 0.45 * tj;
    s.rough = 0.70;
    pooling = -0.05;
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
    s.rough = 0.68 - dome * 0.14;
    // Setts are domed and their gaps are 15 mm deep: real relief, so a low sun
    // rakes across a cobbled street instead of shading a painted pattern.
    s.height = dome * 0.016;
    pooling = (1.0 - dome) * 0.35 - 0.15;
  }

  /* ================================================================
     WET RESPONSE — the reference is a post-rain street, not a rainy one.

     Four layers, in the order they matter:

       1. A LOW-FREQUENCY PUDDLE MASK, metres across, gating roughness
          between genuinely dry (0.75) and standing water (0.055). This is
          the whole model: a road is wet because it is a PATCHWORK of dry
          and flooded, and the eye reads the contrast, not the average. A
          global wetness constant produces a chrome plate and nothing else.
       2. FRESNEL-WEIGHTED specular. Water at normal incidence reflects 2%
          of what hits it and at a grazing angle nearly 100%, which is why a
          wet road is dark under your feet and a mirror at the far end of
          the street. Getting that ramp right is most of the wet read.
       3. REFLECTION FROM THE ENVPROBE, via s.env on radiance, sampled
          at this pixel's roughness so the blur is roughness-proportional
          for free. The previous authoring instead added an ANALYTIC sky to
          emissive, which is why the road glowed uniformly, ignored the
          real sky, and streaked hard-banded smears to the frame edge.
       4. A DISTANCE FADE, so the wet term is gone before the horizon and
          nothing smears off the edge of the frame.
     ================================================================ */

  vec3 vd = normalize(vWPosS - cameraPosition);
  vec3 nrm = normalize(vWNrmS);
  float dist = distance(vWPosS, cameraPosition);

  // 1. THE MASK. Two octaves, both low-frequency: 12 m pools and 3 m detail.
  //    Nothing finer, because sub-metre puddle structure below a pixel is
  //    exactly what turned this into crawling speckle before.
  float pool = fbmLo(wp * 0.085) * 0.62 + fbmLo(wp * 0.31) * 0.38;
  pool = clamp(pool + pooling, 0.0, 1.4);
  // Standing water: only the top of the mask.
  float standing = smoothstep(0.56, 0.86, pool);
  // Damp: the broad middle. Below 0.30 the surface stays dry, so a third of
  // any stretch of road keeps its aggregate and its own albedo.
  float damp = smoothstep(0.30, 0.58, pool);
  float wetAmt = clamp(wet, 0.0, 1.0) * damp;

  // Water darkens what it soaks into and floods what it sits on.
  s.albedo *= mix(1.0, mix(0.62, 0.30, standing), wetAmt);
  // 0.75 dry -> 0.055 standing water. The damp end has to stay well clear of
  // mirror territory or there is no contrast between puddle and road.
  s.rough = mix(s.rough, mix(0.36, 0.10, standing), wetAmt);
  s.metal = max(s.metal, wetAmt * standing * 0.02);
  // A water film FILLS surface relief; a near-mirror that still carries
  // aggregate normals turns every bump into its own glint and the road reads
  // as glitter under a low sun.
  s.height *= 1.0 - wetAmt * mix(0.5, 0.97, standing);

  // 2 + 3 + 4. Hand the reflection to the probe.
  float fres = pow(1.0 - max(dot(-vd, nrm), 0.0), 5.0);
  float F = 0.02 + 0.98 * fres;
  /*
   * Close up you look partly THROUGH the film and read the aggregate, so the
   * mirror strengthens with distance. But it never goes to ZERO: the reference
   * frame's foreground pavers, two metres from the lens, carry individual
   * reflections of the sky and the kerb, and fading the term out entirely
   * under the camera is what left every on-foot framing standing on a sheet of
   * flat violet felt. Floored at 0.50 — raised from 0.35 once the wet term
   * stopped double-counting Fresnel, because the two together were what kept
   * the near field alive and the floor now has to hold it on its own.
   */
  float nearFade = 0.50 + 0.50 * smoothstep(1.0, 12.0, dist);
  float farFade = 1.0 - smoothstep(150.0, 340.0, dist);
  /* ================================================================
     THE FRESNEL WAS APPLIED TWICE, AND THAT IS THE PALE SHEET.

     radiance is not raw cubemap radiance by the time this multiplies
     it. three's RE_IndirectSpecular multiplies it by the environment
     BRDF, and the environment BRDF ALREADY CONTAINS the grazing Fresnel
     ramp — that is what makes a dielectric mirror-like edge-on and
     nearly invisible face-on. Weighting it again by our own
     F = 0.02 + 0.98 * fres squared that ramp, and the peak was allowed
     to reach 1 + 1 * 1 * 8.8 = 9.8.

     9.8x is not a mirror. A perfect mirror is 1.0x. So at exactly the
     angles that fill the bottom of every on-foot framing — where both
     Fresnel terms sit at 1.0 — the wet response was multiplying a
     full-strength reflection of the horizon by nearly ten, and the far
     half of the ground plane went to a flat pale wash with no tonal
     information in it.

     MEASURED on the street framing, in the band this destroyed
     (screen y 0.59-0.70):

       base                          mean 118
       sun scaled to zero            mean 113   <- the sun was 5 of it
       SSR intensity zero            mean 118   <- the post pass was 0
       material wetness pinned to 0  mean  39   <- ALL of it was this

     So: no second Fresnel here, and a peak near unity. The angular ramp
     is not lost, it is simply left to the one term that is entitled to
     apply it. What survives is the reference's actual construction —
     the surface stays dark and the water lying on it is what is bright.
     ================================================================ */
  // A GENTLE grazing ramp, not the full Schlick one. Removing our second
  // Fresnel outright starved the near field; keeping it whole squared the
  // ramp. mix(0.55, 1.0) keeps its DIRECTION — dark under your feet,
  // mirror down the street — without applying it twice at full strength.
  //
  // AFTER DARK THE REFLECTION IS THE ROAD. There is no sun and no lit sky
  // at 23:00; between the lamps the only thing that reaches the tarmac is
  // what it mirrors, so the daylight weighting leaves the night
  // foreground at p50 17 with a standard deviation of 4 — an empty strip
  // of printed black. The night gain is not a fudge for that: it is the
  // same physical statement the daylight cap makes, from the other end.
  // Keyed above 0.6 so dusk and the storm preset, which still have a sky,
  // are untouched.
  float nightGain = 1.0 + 2.6 * smoothstep(0.60, 1.0, uNight);
  s.env = 1.0 + wetAmt * mix(0.55, 1.0, fres) * (0.55 + 2.40 * standing)
                * nightGain * nearFade * farFade;

  // The sun's own reflection stays analytic: a PMREM cube at 128 px cannot
  // hold a sun disc, and this specular streak running down the carriageway
  // toward the camera is the single defining feature of the reference frame.
  // Broken into bands by a low-frequency mottle so it is a streak, not a slab.
  vec2 smearDir = normalize(vec2(vd.x, vd.z) + 1e-5);
  float mottle = fbmLo((wp - smearDir * dot(wp, smearDir) * 0.86) * 0.9);
  vec3 rdir = normalize(reflect(vd, nrm) + vec3(mottle - 0.5, 0.0, mottle - 0.5) * 0.05);
  vec2 sunAz = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
  float align = pow(max(dot(smearDir, sunAz), 0.0), 3.0);
  float glint = pow(max(dot(rdir, uSunDir), 0.0), 18.0);
  float broken = smoothstep(0.30, 0.80, mottle);
  s.emissive += uSunCore * glint * align * broken * wetAmt * F * 6.0 * farFade;

  return s;
}
`;

/* ------------------------------------------------------------------ */
/* Detail shader (vertex-coloured PBR + per-vertex MR + emissive)      */
/* ------------------------------------------------------------------ */

const DETAIL_VERT_PARS = /* glsl */ `
attribute vec2 aMR;
attribute vec3 aEmissive;
attribute vec2 aFoliage;
varying vec2 vMR;
varying vec3 vEmi;
varying vec3 vWPosD;
varying vec3 vWNrmD;
varying float vTrans;
uniform float uTime;
`;

/**
 * WIND. Every tree in the city is baked into one static chunk geometry, so
 * motion has to come from the vertex shader. aFoliage.y is the sway amplitude
 * in metres, authored per vertex: zero on trunks, ~0.02 on inner branches,
 * 0.10-0.20 on crown tips. Two frequencies — a slow 0.55 Hz sway plus a faster
 * flutter — with the phase taken from world position so neighbouring trees
 * never move in unison, which is what makes a whole avenue read as one object.
 *
 * Chunk meshes carry identity matrices and their geometry is authored in world
 * metres, so `position` IS the world position here.
 */
const DETAIL_VERT_MAIN = /* glsl */ `
vMR = aMR;
vEmi = aEmissive;
vTrans = aFoliage.x;
if (aFoliage.y > 0.0001) {
  float ph = position.x * 0.21 + position.z * 0.17;
  float sway = sin(uTime * 0.55 + ph) * 0.7 + sin(uTime * 1.43 + ph * 2.7) * 0.3;
  float flut = sin(uTime * 3.1 + position.y * 1.9 + ph * 4.1);
  transformed.x += (sway * 0.92 + flut * 0.22) * aFoliage.y;
  transformed.z += (sway * 0.46 - flut * 0.26) * aFoliage.y;
  transformed.y += flut * aFoliage.y * 0.18;
}
vec4 wpD = modelMatrix * vec4(transformed, 1.0);
vWPosD = wpD.xyz;
vWNrmD = normalize(mat3(modelMatrix) * objectNormal);
`;

const DETAIL_FRAG_PARS = /* glsl */ `
varying vec2 vMR;
varying vec3 vEmi;
varying vec3 vWPosD;
varying vec3 vWNrmD;
varying float vTrans;
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
    /** Seconds since world start. Drives foliage wind in the detail shader. */
    uTime: { value: number };
    /** Look-dev multipliers on the facade's interior glow and its reflection. */
    uEmissiveGain: { value: number };
    uEnvGain: { value: number };
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

/**
 * THE CITY'S SURFACE COLOURS, decoded exactly once.
 *
 * `src/artDirection.ts` double-decodes every entry in `Palette` (see the note
 * in `src/render/materials.ts`), which crushed travertine from a warm cream at
 * 0.59 luminance to a burnt red at 0.31, concrete to near-black and asphalt to
 * literal zero. With every warm albedo gone, the only things left carrying any
 * value in the frame were the emissive and sky-reflection terms — all of them
 * magenta — which is precisely why the whole city rendered as one flat mauve
 * wash with no warm surface anywhere.
 *
 * These are authored against the reference frame and go through `srgb()`.
 */
const C = {
  /*
   * MEASURED, not guessed. `window.__GTA_POST__.meter()` against the reference
   * frame's own histogram (p05 12 / p50 50 / p95 165, mean 66, saturation 0.29)
   * is the acceptance test. Authored a stop brighter than this the city
   * metered p50 100 / mean 101 / saturation 0.47 — a full stop hot and 1.6x
   * over-saturated, i.e. blown cream facades instead of raking warm stone.
   * These are real architectural albedos: travertine 0.33 linear, limestone
   * 0.40, render 0.27, precast concrete 0.15.
   */
  /** The frame's warm anchor. Travertine catching a 3-degree sun. */
  travertine: srgb(0x9d8464),
  stone: srgb(0xaba191),
  stucco: srgb(0x84715f),
  concrete: srgb(0x655f6b),
  /** Curtain-wall glass is the DARKEST large mass in the reference. */
  glassTint: srgb(0x1d2647),
  purple: srgb(0x7b3fd4),
  magenta: srgb(0xc04ad0),
  sodium: srgb(0xffb14a),
  /** Ordinary warm office fluorescent — the city's most common light source. */
  office: srgb(0xffd9a8),
  neon: srgb(0xff2f8e),
  rust: srgb(0x9a5f36),
  /**
   * ASPHALT AT ~0.04 LINEAR — the brief's number, and what real dry tarmac
   * measures. The authored 0x0d0a14 is 0.004 even decoded once: a hundred
   * times too dark, which is why the road only ever showed its reflection and
   * never its own surface, and why it read either as a black hole or as a pale
   * mirror with nothing in between.
   */
  asphalt: srgb(0x37333d),
  paveStone: srgb(0x564e5b),
  kerb: srgb(0x66606c),
  grass: srgb(0x545c34),
  gravel: srgb(0x4b423a),
  water: srgb(0x1b2434),
  marking: srgb(0xb2ac9f),
  skyHorizon: srgb(0xff7a3c),
  skyLow: srgb(0xff5f86),
  skyMid: srgb(0xd0569f),
  skyHigh: srgb(0x6b4192),
  skyZenith: srgb(0x231a45),
  sunCore: srgb(0xffd9a8),
} as const;

function skyUniforms(shared: CityMaterials['shared']): Record<string, THREE.IUniform> {
  return {
    uSkyHorizon: { value: C.skyHorizon },
    uSkyLow: { value: C.skyLow },
    uSkyMid: { value: C.skyMid },
    uSkyHigh: { value: C.skyHigh },
    uSkyZenith: { value: C.skyZenith },
    uSunCore: { value: C.sunCore },
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
    uTime: { value: 0.0 },
    uEmissiveGain: { value: 1.0 },
    uEnvGain: { value: 1.0 },
  };

  /* ---- facade ---- */
  const facade = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 1.0,
    // Per-PIXEL weighted by Fac.env in the shader, so this is the reference
    // level for a matte surface and glass multiplies up from here.
    // WEATHERED RENDER IS NOT REFLECTIVE. This is the reference level for a
    // matte facade; glass multiplies up from here per-pixel via Fac.env. At
    // 0.42 every rendered wall in the city picked up a sheen of sunset and the
    // concrete read as polished. Real patinated render throws back very little.
    //
    // DEAD KNOB — see the long note on the surface material's envMapIntensity
    // below. three overwrites this with `scene.environmentIntensity` (0.8) on
    // every draw because this material has no `envMap` of its own, so the
    // 0.30 never reached the GPU and the facade look was in fact tuned at
    // 0.8. Set to the effective value so the source stops lying; the
    // per-pixel weighting that actually works is `Fac.env`.
    envMapIntensity: 0.8,
    dithering: true,
  });
  facade.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms(shared), {
      uTravertine: { value: C.travertine },
      uConcrete: { value: C.concrete },
      uStucco: { value: C.stucco },
      uGlassTint: { value: C.glassTint },
      uStone: { value: C.stone },
      uPurple: { value: C.purple },
      uMagenta: { value: C.magenta },
      uSodium: { value: C.sodium },
      uNeon: { value: C.neon },
      uRust: { value: C.rust },
      uOffice: { value: C.office },
      uEmissiveGain: shared.uEmissiveGain,
      uEnvGain: shared.uEnvGain,
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
        _f.emissive *= uEmissiveGain;
        _f.env *= uEnvGain;
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
      /*
       * GEOMETRIC RELIEF. The grammar's height field becomes a real normal
       * here, so mullions, reveals, sills, panel joints and pilasters are lit
       * by the actual sun and the actual cascades rather than being painted on.
       * The pane tilt is applied on top: each glazing unit is bowed a fraction
       * of a degree differently, which is what breaks a curtain wall into a
       * mosaic of sky slices instead of one smooth gradient.
       *
       * The relief fades out with distance for the same reason the emissive
       * does — a 55 mm reveal below a pixel is nothing but aliasing.
       */
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        {
          vec3 _eye = (viewMatrix * vec4(vWPosF, 1.0)).xyz;
          float _texel = max(fwidth(vUvM.x), fwidth(vUvM.y));
          float _rk = 1.0 - smoothstep(0.014, 0.055, _texel);
          if (_rk > 0.002) {
            // Facade tangent frame: walls are vertical, so world up and the
            // wall normal give an exact frame with no derivatives needed.
            vec3 _wn = normalize(vWNrmF);
            vec3 _tan = normalize(cross(vec3(0.0, 1.0, 0.0), _wn) + vec3(1e-5));
            vec3 _bit = cross(_wn, _tan);
            vec3 _tilted = normalize(_wn + (_tan * _f.tilt.x + _bit * _f.tilt.y) * _rk);
            normal = normalize(mix(normal, normalize((viewMatrix * vec4(_tilted, 0.0)).xyz), _rk));
            normal = gtaRelief(_eye, normal, _f.height, 11.0 * _rk);
          }
        }
        `,
      )
      /*
       * THE ENVIRONMENT REFLECTION. radiance is the prefiltered EnvProbe
       * cubemap sampled at this pixel's roughness, i.e. a genuine sunset
       * reflection with roughness-proportional blur for free. Weighting it
       * per-pixel is what lets one shared material give glass a full mirror
       * and render a matte 0.5x, which is the entire reason a curtain wall
       * mosaics the sky and the stone beside it does not.
       */
      .replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `
        #include <lights_fragment_maps>
        radiance *= _f.env;
        `,
      )
      // Analytic sky on top, so glass still reads on hardware/frames where the
      // probe has not refreshed, and so the sun's own reflection stays sharp.
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          vec3 _vd = normalize(vWPosF - cameraPosition);
          /*
           * THE ANALYTIC REFLECTION MUST SEE THE PANE TILT TOO.
           *
           * This term used the flat geometric normal, so while the PROBE
           * reflection mosaicked, the analytic sky on top of it did not — and
           * being the sharper of the two it averaged the mosaic back out. Both
           * halves of the reflection now sample the same bowed pane.
           */
          vec3 _flat = normalize(vWNrmF);
          vec3 _t = normalize(cross(vec3(0.0, 1.0, 0.0), _flat) + vec3(1e-5));
          vec3 _b = cross(_flat, _t);
          vec3 _n = normalize(_flat + _t * _f.tilt.x + _b * _f.tilt.y);
          vec3 _r = reflect(_vd, _n);
          float _f0 = mix(0.045, 1.0, metalnessFactor);
          float _fres = _f0 + (1.0 - _f0) * pow(1.0 - max(dot(-_vd, _n), 0.0), 5.0);
          float _gloss = 1.0 - roughnessFactor;
          vec3 _sky = gtaSky(_r);
          reflectedLight.indirectSpecular += _sky * _fres * min(_f.env, 1.4) *
            ((0.10 + 0.90 * _gloss * _gloss) * diffuseColor.rgb * 0.14 + _gloss * _gloss * 0.11);
          // Sky-dome hemisphere fill so nothing reads as flat black.
          reflectedLight.indirectDiffuse += gtaSky(_n * 0.6 + vec3(0.0, 0.4, 0.0)) * diffuseColor.rgb * 0.13;
        }
        `,
      );
  };
  facade.customProgramCacheKey = () => 'gta-facade-v7';

  /* ---- surface ---- */
  const surface = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 1.0,
    /*
     * THIS KNOB IS DEAD, AND SO IS THE FACADE'S. Recorded here because it is
     * invisible from the source and it will mislead the next person who tunes
     * a reflection.
     *
     * three r0.185 `WebGLRenderer.js` (in `setProgram`):
     *
     *   if ( ( material.isMeshStandardMaterial || ... ) &&
     *        material.envMap === null && scene.environment !== null ) {
     *     m_uniforms.envMapIntensity.value = scene.environmentIntensity;
     *   }
     *
     * Neither of these materials carries its own `envMap` — the reflection
     * comes from `scene.environment`, which EnvProbe installs — so three
     * OVERWRITES whatever is authored here with `scene.environmentIntensity`
     * on every draw. Verified live: sweeping this value 0 -> 1 moved the
     * ground by 0 levels, while sweeping `scene.environmentIntensity` over
     * the same range moved it by 4. The effective value for every material in
     * the game is EnvProbe's 0.8.
     *
     * Left at the effective number rather than "corrected" to the old 0.5:
     * the whole city's look was tuned with 0.8 actually in force, so writing
     * a different number here would change nothing today and silently change
     * everything the day someone gives these materials a real envMap. Per
     * material weighting is done per PIXEL by `Surf.env` below, which does
     * work.
     */
    envMapIntensity: 0.8,
    dithering: true,
  });
  surface.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, skyUniforms(shared), {
      uAsphalt: { value: C.asphalt },
      uPaveStone: { value: C.paveStone },
      uKerb: { value: C.kerb },
      uGrass: { value: C.grass },
      uGravelC: { value: C.gravel },
      uWaterC: { value: C.water },
      uMarking: { value: C.marking },
      uWetness: shared.uWetness,
      uNight: shared.uNight,
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
      // Kerb arrises, paving joints and sett domes as real relief, so the low
      // sun rakes across them. Faded out well before they fall under a pixel.
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        {
          float _texel = max(fwidth(vWPosS.x), fwidth(vWPosS.z));
          float _rk = 1.0 - smoothstep(0.006, 0.03, _texel);
          if (_rk > 0.002 && abs(_s.height) > 1e-5) {
            normal = gtaRelief((viewMatrix * vec4(vWPosS, 1.0)).xyz, normal, _s.height, 12.0 * _rk);
          }
        }
        `,
      )
      // The wet reflection: the prefiltered EnvProbe cubemap, sampled at this
      // pixel's roughness, weighted by the puddle mask and the Fresnel term.
      .replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `
        #include <lights_fragment_maps>
        radiance *= _s.env;
        /*
         * A CEILING ON THE MIRROR, NOT A SCALE ON IT.
         *
         * A wet plane at grazing incidence reflects the brightest thing in
         * the sky — the horizon rip — and the probe carries it at full HDR,
         * so the far half of the ground plane arrived brighter than anything
         * else in the frame and flattened into a sheet.
         *
         * Scaling the wet term down globally fixes that and breaks the NIGHT
         * street, where the reflection is the only thing carrying the road at
         * all: measured, taking the multiplier down far enough to tame the
         * dusk band left the night foreground at p50 17 with a standard
         * deviation of 3, i.e. an empty black strip across the bottom third.
         *
         * A soft knee separates the two. Everything below it — every night
         * reflection, every lamp pool, every dim puddle — passes through
         * untouched; only a reflection that has become brighter than the lit
         * scene around it is compressed, and it compresses toward a ceiling
         * rather than clipping, so the smear keeps its orange instead of
         * going to white paper.
         */
        {
          float _rl = max(max(radiance.r, radiance.g), radiance.b);
          // The knee opens right up after dark. A night street's reflection is
          // the only thing carrying its road at all — no sun, no bright sky,
          // and between the lamps nothing else reaches the tarmac. Clamping it
          // with the same knee that tames a sunset metered the night
          // foreground at p50 16 with a standard deviation of 4, i.e. an empty
          // strip of printed black across the bottom third. There is no bright
          // sky to out-run at 23:00, so there is nothing to compress.
          float _knee = 0.20 + 12.0 * smoothstep(0.60, 1.00, uNight);
          float _over = max(_rl - _knee, 0.0);
          float _lim = min(_rl, _knee) + _over / (1.0 + _over * 1.90);
          radiance *= _lim / max(_rl, 1e-4);
        }
        `,
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        /* ================================================================
           GRAZING SPECULAR ON A ROUGH DIELECTRIC — f90 IS NOT 1.0.
           MEASURED. At an on-foot framing looking down-sun (camera 1.75 m,
           sun 7 degrees up, ground filling the bottom of the frame) the
           surface's channels decomposed as, in linear radiance:

             directSpecular   0.181  <- 75% of the pixel
             albedo*direct    0.044     18%
             indirectDiffuse  0.009      4%
             indirectSpecular 0.005      2%
             sun glint        0.002      1%

           i.e. the ground was not bright because of its albedo, its puddle
           mask, its env probe or the SSR — every one of those A/B-ed to
           within 2 levels. It was one broad, uniform sheet of DIRECT
           specular, and that is why it read as an overexposed sheet with
           the reflection lost in it rather than as wet asphalt.

           The cause is Schlick. three ramps Fresnel to f90 = 1.0 at 90
           degrees, which is only true of a SMOOTH interface. Weathered
           tarmac and sawn dusty stone are rough below the microfacet
           model's scale and their microfacets shadow each other, so real
           grazing reflectance is a fraction of Schlick's. Frostbite and
           Filament both handle it by pulling f90 down toward (1 - rough).

           Note the trap this closes: every previous pass that made these
           surfaces "matte" RAISED roughness (asphalt 0.52 -> 0.78, footway
           0.72 -> 0.90, plaza 0.66 -> 0.87). Raising GGX roughness widens
           the lobe, so it made the grazing sheet cover the WHOLE plane
           instead of removing it. Matte has to be spent on f90, not on
           alpha.

           Standing water keeps its mirror: at roughness 0.10 the factor is
           0.9, so the gutters and puddles are untouched and become the
           BRIGHT thing on a now-dark road — which is the reference's
           actual construction.
           ================================================================ */
        {
          float _ndv = clamp(dot(normalize(geometryNormal), geometryViewDir), 0.0, 1.0);
          float _graze = pow(1.0 - _ndv, 5.0);
          // f90 for a rough dielectric, shaped. A linear (1 - rough) still
          // left the dry plaza at p25 80 against the reference kerbside's 36;
          // the exponent is what takes a genuinely dusty surface the rest of
          // the way down while leaving anything under ~0.4 roughness — wet
          // tarmac, standing water, polished granite — essentially alone.
          // Floored so a grazing highlight never vanishes outright.
          float _f90 = max(pow(max(1.0 - roughnessFactor, 0.0), 1.7), 0.02);
          const float _F0 = 0.04;
          float _corrected = _F0 + (_f90 - _F0) * _graze;
          float _schlick   = _F0 + (1.0  - _F0) * _graze;
          reflectedLight.directSpecular *= _corrected / max(_schlick, 1e-4);
        }
        reflectedLight.indirectDiffuse += gtaSky(vec3(0.0, 0.75, 0.0)) * diffuseColor.rgb * 0.14;
        `,
      );
  };
  surface.customProgramCacheKey = () => 'gta-surface-v16';

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
    Object.assign(shader.uniforms, skyUniforms(shared), {
      uNight: shared.uNight,
      uTime: shared.uTime,
    });
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

          /*
           * SUB-SURFACE SCATTER through thin surfaces — leaves, above all.
           *
           * With the sun three degrees up, a street tree is always between the
           * camera and the key. An opaque crown therefore renders as a black
           * plate on a magenta sky, which is exactly what the whole foliage
           * layer used to do. Two terms:
           *   wrap     broad back-lit diffuse, so the shadow side of a crown
           *            is lit by the sun BEHIND it rather than by fill alone;
           *   thru     a tight forward lobe that fires only when you look
           *            along the sun ray through the canopy — the amber glow.
           * Both are gated on the view/sun geometry, so a crown lights up as
           * you walk round it and goes olive when the sun is behind you.
           */
          if (vTrans > 0.001) {
            float _wrap = max(0.0, (-dot(_n, uSunDir) + 0.45) / 1.45);
            /*
             * BROADER FORWARD LOBE. At an exponent of 4 the glow only fired
             * within about forty degrees of the sun, so a canopy read as a
             * flat amber shape everywhere else and only lit up if you aimed
             * straight into the key. Real foliage carries a wide forward
             * scatter: an avenue of backlit trees glows across most of the
             * frame, not in one hotspot. Exponent 3, gain up, and the broad
             * wrapped term DOWN to pay for it — the wrapped term fires on half
             * the facets of every lobe at once, so it is what bleaches an
             * amber canopy to cream if it leads.
             */
            float _thru = pow(max(0.0, dot(_vd, uSunDir)), 3.0);
            totalEmissiveRadiance += diffuseColor.rgb * uSunCore * 2.1 * vTrans *
              (_wrap * 0.19 + _thru * 1.3) * (1.0 - uNight * 0.82);
            // Sky fill through the leaf as well, or a crown with its back to
            // the sun goes to a flat silhouette instead of a dim olive mass.
            // Kept small: this is the term that desaturates, and a shadowed
            // autumn crown should stay a deep olive-umber, not go chalky.
            totalEmissiveRadiance += diffuseColor.rgb * gtaSky(_n * -0.4 + vec3(0.0, 0.55, 0.0))
              * vTrans * 0.06;
          }
        }
        `,
      );
  };
  detail.customProgramCacheKey = () => 'gta-detail-v3';

  (window as unknown as { __GTA_CITYMAT__: unknown }).__GTA_CITYMAT__ = {
    emissive: (v: number) => { shared.uEmissiveGain.value = v; },
    env: (v: number) => { shared.uEnvGain.value = v; },
    night: (v: number) => { shared.uNight.value = v; },
    get: () => ({
      emissive: shared.uEmissiveGain.value,
      env: shared.uEnvGain.value,
      night: shared.uNight.value,
      wetness: shared.uWetness.value,
      envMix: shared.uEnvMix.value,
      /** Foliage wind clock. If this is not advancing, the trees are frozen. */
      time: shared.uTime.value,
    }),
  };

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
