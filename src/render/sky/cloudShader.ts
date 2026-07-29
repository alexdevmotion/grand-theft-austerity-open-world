/** Multi-layer procedural cloud deck.
 *
 *  Three physically-separated decks, each projected onto its own spherical
 *  shell so they converge at the horizon at different rates and therefore
 *  parallax against each other as they drift:
 *
 *    cirrus   ~9 km   long fibrous streaks, rotated to converge on the sun
 *    alto     ~5 km   the coral banded mid-deck of the reference frame
 *    cumulus  ~3 km   chunky backlit lobes, amber rims and violet cores
 *
 *  Lighting is a 3-tap in-plane shadow march toward the sun. Because the sun
 *  sits on the horizon, that march is almost horizontal and very long, which is
 *  exactly what produces the reference's rim-lit silhouettes: thin cloud edges
 *  transmit and ignite, thick cores stay violet.
 *
 *  Every deck exposes a matching *Lo variant with fewer octaves, used for the
 *  shadow march and the crepuscular-ray occlusion march. They only have to
 *  correlate with the full field, not match it.
 */

export const CLOUD_GLSL = /* glsl */ `

/* ---- shell projection ------------------------------------------------ */

/** Ray/shell intersection on a unit planet. Finite at the horizon, so cloud
 *  features compress into a convergence band instead of exploding to infinity. */
float skShellT(float dy, float h) {
  return -dy + sqrt(max(dy * dy + 2.0 * h + h * h, 1e-8));
}

/** World direction -> cloud-plane coordinate for a deck at height h.
 *
 *  The raw shell projection stretches horizon features by ~10x, which turns
 *  into shimmering mush at 1080p. The comp term walks that back to ~5x so the
 *  highest octaves stay above one pixel where the sky meets the skyline.
 *
 *  THE EXPONENT MUST BE CONSTANT. Ramping it toward 1.0 with elevation (to
 *  recover overhead detail) makes 't * comp' non-monotonic in d.y — it rises
 *  from 0.176 at 3 degrees to 0.254 at 6 degrees and back to 0.238 at 8 — so
 *  the coordinate folds back on itself and the deck renders a mirrored,
 *  visibly tiled band across the whole sky just above the skyline. Detail
 *  overhead is bought with octaves (skAlto is fbm6, skCumulus fbm5) and deck
 *  scale instead, both of which are monotone by construction. */
vec2 skCloudUV(vec3 d, float h, float scale) {
  float t = skShellT(d.y, h);
  float comp = pow(h / max(t, 1e-4), 0.42);
  return d.xz * (t * comp * scale);
}

/* ---- deck density fields --------------------------------------------- */

/** Cirrus: strongly anisotropic, fibrous, gently bent by a low-frequency warp. */
float skCirrus(vec2 uv, float drift, float cover) {
  vec2 q = uv + vec2(drift * 0.90, drift * 0.33);
  float warp = skFbm2(q * 0.22) - 0.5;
  q.y += warp * 1.05;
  q.x += warp * 0.30;
  vec2 s = vec2(q.x * 0.20, q.y);
  float n = skFbmAniso4(s);
  float fibre = skValue(vec2(s.x * 3.0, s.y * 5.5));
  n = n * 0.80 + fibre * 0.20;
  float lo = 0.665 - cover * 0.26;
  return smoothstep(lo, lo + 0.22, n);
}

/** Alto deck: the coral band structure. Medium anisotropy, rolled edges. */
float skAlto(vec2 uv, float drift, float cover) {
  vec2 q = uv * 0.85 + vec2(drift * 0.50, drift * 0.19);
  float w = skFbm2(q * 0.35) - 0.5;
  q += vec2(w * 0.75, w * 0.30);
  vec2 s = vec2(q.x * 0.55, q.y);
  // Six octaves, not five: the deck was visibly missing its top frequency and
  // reading as an airbrush smudge rather than a banded alto sheet.
  float n = skFbm6(s);
  float lo = 0.640 - cover * 0.24;
  return smoothstep(lo, lo + 0.20, n);
}

float skAltoLo(vec2 uv, float drift, float cover) {
  vec2 q = uv * 0.85 + vec2(drift * 0.50, drift * 0.19);
  vec2 s = vec2(q.x * 0.55, q.y);
  float n = skFbm3(s);
  float lo = 0.640 - cover * 0.24;
  return smoothstep(lo, lo + 0.20, n);
}

/** Cumulus: billowy lobes over a softer body. */
float skCumulus(vec2 uv, float drift, float cover) {
  vec2 q = uv * 0.75 + vec2(drift * 0.28, drift * 0.11);
  float w = skFbm2(q * 0.30) - 0.5;
  q += w * 0.55;
  float body = skFbm5(q);
  float lobes = 1.0 - skBillow4(q * 1.65) * 0.55;
  float n = body * 0.62 + lobes * 0.38;
  float lo = 0.665 - cover * 0.28;
  return smoothstep(lo, lo + 0.18, n);
}

float skCumulusLo(vec2 uv, float drift, float cover) {
  vec2 q = uv * 0.75 + vec2(drift * 0.28, drift * 0.11);
  float n = skFbm3(q) * 0.72 + 0.145;
  float lo = 0.665 - cover * 0.28;
  return smoothstep(lo, lo + 0.18, n);
}

/* ---- back-lighting ---------------------------------------------------- */

/**
 * Accumulated density along the in-plane direction of the sun.
 * stepLen is one march step in cloud-plane units — larger for a lower sun,
 * because a grazing ray cuts a very long chord through the deck.
 */
#ifndef SK_LIGHT_TAPS
  #define SK_LIGHT_TAPS 3
#endif

float skSunTransmittance(vec2 uv, vec2 lightDir, float stepLen, float drift, float cover, int deck) {
  float acc = 0.0;
  float w = 1.0;
  for (int i = 1; i <= SK_LIGHT_TAPS; i++) {
    vec2 p = uv + lightDir * (stepLen * float(i));
    acc += w * ((deck == 0) ? skCumulusLo(p, drift, cover) : skAltoLo(p, drift, cover));
    w *= 0.72;
  }
  return acc;
}
`;
