/** THE SKY BAND LADDER — the single evaluation of "what colour is the sky in
 *  direction d", shared by the sky dome and by the aerial-perspective fog.
 *
 *  WHY THIS FILE EXISTS
 *
 *  There used to be two independent answers to that question: the dome ran its
 *  own gradient, and the fog in-scatter came from a hand-authored table of
 *  literal linear triples in aerialPerspective.ts. Those two answers disagreed,
 *  and they disagreed WORST exactly where they meet — so the frame carried a
 *  razor-straight, full-width hue discontinuity along the horizon line, where
 *  fogged ground geometry (table colour) butted against sky dome (gradient
 *  colour) in a single pixel row.
 *
 *  No amount of re-authoring the table can fix that. For a homogeneous
 *  scattering medium the composite along a view ray is
 *
 *      L = L_surface * e^-tau  +  L_inscatter * (1 - e^-tau)
 *
 *  and at tau -> infinity that must equal the sky radiance ALONG THE SAME RAY.
 *  So the only structurally sound fix is to make `L_inscatter` literally be the
 *  sky-dome evaluation for that pixel's own view direction. Then the seam
 *  cannot exist: the two sides of the horizon line are the same function of the
 *  same argument. That is what `skBandRadiance` below is for, and it is why the
 *  old AERIAL_STOPS colour table is gone.
 *
 *  THE LADDER ITSELF IS A HUE LADDER, NOT A VALUE RAMP.
 *
 *  Parameterised by ELEVATION, not by `d.y`. `pow(d.y, 0.45)` — the previous
 *  parameterisation — reaches 0.16 at one degree above the horizon and 0.27 at
 *  three, so the horizon band had already handed over to the band above it
 *  inside the first degree of sky. The "hot orange rip" was therefore under a
 *  degree tall and simply never appeared in any framing. `asin(d.y)` is linear
 *  in degrees, so a band authored as "0 to 8 degrees" is 8 degrees tall.
 *
 *  Band placement (degrees of elevation):
 *      0 - 10    hot orange rip        horizon
 *      7 - 23    coral / salmon        low
 *     21 - 45    magenta               mid
 *     42 - 78    violet                high
 *     78 - 90    deep indigo           zenith
 */

/** Shared band uniforms + the evaluation. Include in any shader that needs to
 *  know the sky's radiance along a direction. Declares no uniforms of its own —
 *  everything arrives as arguments, so the two call sites are free to name
 *  their uniforms differently. */
export const SKY_BANDS_GLSL = /* glsl */ `

struct SkBandSet {
  vec3 horizon;
  vec3 low;
  vec3 mid;
  vec3 high;
  vec3 zenith;
  /** Multiplicative tint on the anti-solar half — azure/indigo. */
  vec3 away;
  /** Multiplicative tint on the solar half — kills blue, makes it coral. */
  vec3 toward;
  /** Sun halo colour, already reddened by airmass. */
  vec3 halo;
  /** What the dome becomes below the horizon line. */
  vec3 ground;
};

/**
 * Radiance of the clear-sky gradient in direction 'd'.
 *
 * 'haze' scales the horizon rip and the solar veil; 'mul' is the whole-dome
 * weather multiplier. Both call sites pass identical values, which is what
 * makes fog in-scatter converge to the dome by construction.
 */
vec3 skBandRadiance(vec3 d, vec3 sunDir, vec2 sunAz, SkBandSet B, float haze, float mul) {
  // Linear in elevation: -1 at nadir, 0 at the horizon, +1 at the zenith.
  float e = asin(clamp(d.y, -1.0, 1.0)) * 0.63661977;
  float f = max(e, 0.0);

  vec3 sky = B.horizon;
  sky = mix(sky, B.low,    smoothstep(0.015, 0.125, f));
  sky = mix(sky, B.mid,    smoothstep(0.090, 0.290, f));
  sky = mix(sky, B.high,   smoothstep(0.260, 0.560, f));
  sky = mix(sky, B.zenith, smoothstep(0.540, 0.930, f));

  // Azimuthal split. The anti-solar half keeps its short-wavelength azure; the
  // solar half loses blue and becomes coral. Without this the dome is one hue.
  // It has to DIE OFF WITH ALTITUDE — a low sun only warms the air near the
  // horizon, and applied flat this bleached the violet all the way to the top.
  vec2 hdir = normalize(vec2(d.x, d.z) + vec2(1e-6));
  float az = dot(hdir, sunAz);
  float azW = smoothstep(-0.40, 0.98, az);
  float azWt = azW * (0.16 + 0.84 * exp(-f * 3.2));
  sky *= mix(B.away, B.toward, azWt);

  float cosSun = dot(d, sunDir);

  // Rayleigh lobe — brightest at 90 degrees from the sun, softly lifts the dome.
  sky += B.high * (0.75 * (1.0 + cosSun * cosSun)) * 0.05;

  /* THE ORANGE RIP.
   *
   * A thin, violently hot band hugging the horizon on the solar side. This is
   * the single most identifiable feature of the reference frame and it was
   * worth 0.42 of an already dark band before — invisible. It is now the
   * brightest part of the dome by a wide margin, which is also what makes the
   * far end of a boulevard glow when the fog converges onto it. */
  float rip = exp(-f * 9.5);
  sky += B.horizon * pow(azW, 2.2) * rip * haze * 0.50;
  sky += B.low * pow(azW, 1.25) * rip * haze * 0.16;

  // Broad warm veil in the air around the sun. Deliberately weak and wide: at
  // any real strength this alone paints a 40-degree cone of flat salmon.
  float sunUp = smoothstep(-0.16, 0.06, sunDir.y);
  sky += B.halo * pow(max(cosSun, 0.0), 8.0) * 0.020 * haze * sunUp;

  // A thin band of extra haze pooling right at the horizon line.
  float hz = exp(-f * 46.0) * smoothstep(-0.05, 0.004, e);
  sky = mix(sky, mix(B.ground * 2.2, B.horizon * 0.72, pow(azW, 1.4)), hz * haze * 0.30);

  /* BELOW THE HORIZON LINE.
   *
   * There is no dome down here, and in a finite 2.4 km city there is very
   * often no geometry either — from any rooftop you see straight past the edge
   * of the world. Cutting to a dark 'ground haze' colour over four degrees put
   * a razor-straight navy band underneath a hot orange sky, which is the
   * horizon seam in its single most visible form: a large hue AND value jump
   * inside one pixel row, running the full width of the frame.
   *
   * So the radiance decays smoothly OUT OF the band it was already showing,
   * over about 25 degrees, rather than being replaced by an unrelated colour.
   * Distant hazy ground genuinely looks like a dimmed, slightly desaturated
   * version of the sky just above it, and — critically — this construction can
   * never introduce an edge, because at e = 0 it is exactly the sky value. */
  float below = smoothstep(0.030, -0.32, e);
  sky = mix(sky, sky * 0.32 + B.ground, below);

  return max(sky, vec3(0.0)) * mul;
}
`;

/**
 * AIRMASS REDDENING — shared so the disc, the halo and the directional light
 * all redden together.
 *
 * A sun 3 degrees up looks through ~18 air masses; a sun on the horizon
 * through ~40. Rayleigh extinction is strongly wavelength-dependent, so the
 * disc goes from white through amber to a deep blood orange as it sets. The
 * previous sky had no extinction at all and the disc stayed a flat beige dot
 * at every hour, which is most of why it never read as a sun.
 *
 * Coefficients are art-directed rather than physical: they are tuned so the
 * disc lands near 0xff3a10 at true sunset and stays essentially white above
 * about 25 degrees.
 */
export const SKY_AIRMASS_GLSL = /* glsl */ `
vec3 skAirmassExtinction(vec3 sunDir) {
  float airmass = 1.0 / max(sunDir.y, 0.025);
  // The green coefficient is deliberately steep. Every stage downstream of
  // here — the exposure shoulder, then AgX — pulls the channels back TOGETHER,
  // so a ratio that looks like a convincing orange in linear arrives at the
  // display as yellow-cream. The extinction has to overshoot to land right.
  return exp(-vec3(0.50, 2.55, 4.60) * (airmass - 1.0) * 0.075);
}
`;
