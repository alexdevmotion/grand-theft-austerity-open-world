/** Shared GLSL noise used by the sky, cloud and god-ray shaders.
 *
 *  Everything is hash-based value noise — no textures, no dependencies. The
 *  hashes are the Dave Hoskins "hash without sine" family: cheap, stable across
 *  drivers (no trig precision drift) and free of the diagonal banding you get
 *  from the classic `fract(sin(dot(...)))` hash.
 *
 *  Octave counts are fixed per function so the loops unroll and we never rely
 *  on dynamic loop bounds.
 */

export const NOISE_GLSL = /* glsl */ `
float skHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float skHash13(vec3 p) {
  vec3 p3 = fract(p * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 skHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

/** Quintic-interpolated 2D value noise, 0..1. */
float skValue(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = skHash12(i);
  float b = skHash12(i + vec2(1.0, 0.0));
  float c = skHash12(i + vec2(0.0, 1.0));
  float d = skHash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Irrational rotation between octaves kills axis-aligned lattice artefacts.
const mat2 SK_ROT = mat2(0.80, 0.60, -0.60, 0.80);

float skFbm2(vec2 p) {
  float v = 0.0, a = 0.6;
  for (int i = 0; i < 2; i++) { v += a * skValue(p); p = SK_ROT * p * 2.07; a *= 0.5; }
  return v * 1.111;
}

float skFbm3(vec2 p) {
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) { v += a * skValue(p); p = SK_ROT * p * 2.07; a *= 0.5; }
  return v * 1.039;
}

float skFbm4(vec2 p) {
  float v = 0.0, a = 0.53;
  for (int i = 0; i < 4; i++) { v += a * skValue(p); p = SK_ROT * p * 2.03; a *= 0.5; }
  return v * 1.006;
}

float skFbm5(vec2 p) {
  float v = 0.0, a = 0.52;
  for (int i = 0; i < 5; i++) { v += a * skValue(p); p = SK_ROT * p * 2.02; a *= 0.5; }
  return v * 0.993;
}

float skFbm6(vec2 p) {
  float v = 0.0, a = 0.515;
  for (int i = 0; i < 6; i++) { v += a * skValue(p); p = SK_ROT * p * 2.01; a *= 0.5; }
  return v * 0.985;
}

/**
 * Anisotropy-preserving fbm. The rotating variants above smear a stretched
 * coordinate frame into swirls, which reads as combed hair rather than cirrus;
 * this one only translates between octaves so a 5:1 stretch stays a 5:1 stretch
 * all the way down the octave stack.
 */
float skFbmAniso4(vec2 p) {
  float v = 0.0, a = 0.53;
  for (int i = 0; i < 4; i++) {
    v += a * skValue(p);
    p = p * 2.06 + vec2(19.31, 7.17);
    a *= 0.5;
  }
  return v * 1.006;
}

/** Billowy (absolute-value) fbm — gives cumulus their cauliflower lobes. */
float skBillow4(vec2 p) {
  float v = 0.0, a = 0.54;
  for (int i = 0; i < 4; i++) {
    v += a * abs(skValue(p) * 2.0 - 1.0);
    p = SK_ROT * p * 2.11;
    a *= 0.5;
  }
  return v * 1.9;
}

/** Henyey-Greenstein phase function — Mie forward scattering. */
float skHG(float cosT, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosT;
  return (1.0 - g2) / (12.566370614 * pow(max(denom, 1e-4), 1.5));
}

/** Rayleigh phase, normalised to peak 1 at 90 degrees for art-directed use. */
float skRayleigh(float cosT) {
  return 0.75 * (1.0 + cosT * cosT);
}
`;
