/** The sky dome shader: the shared band ladder, an HDR sun with separated
 *  lobes and airmass reddening, a three-deck genuinely backlit cloud system,
 *  crepuscular rays, star field and a moon with a real terminator.
 *
 *  Composited far-to-near so the decks occlude each other correctly:
 *      gradient -> cirrus -> alto -> cumulus -> shafts -> sun/stars
 *
 *  THE GRADIENT IS NOT COMPUTED HERE. It comes from `skBandRadiance` in
 *  sky/skyBands.ts, which the aerial-perspective fog also calls, so that fogged
 *  geometry and open sky are the same function of the same view direction and
 *  the horizon seam cannot exist. Do not re-implement it locally.
 *
 *  Everything is HDR: the horizon rip runs 2-3x white and the sun core ~45x, so
 *  the bloom and AgX tone map in the post chain have something real to work
 *  with. The sky is the key light of this game — it has to out-punch every
 *  surface in the frame by orders of magnitude, and until the sun did, the
 *  brightest thing on screen was a lit building wall.
 */

import { NOISE_GLSL } from './noise';
import { CLOUD_GLSL } from './cloudShader';
import { SKY_AIRMASS_GLSL, SKY_BANDS_GLSL } from './skyBands';

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Skybox trick: pin to the far plane so early-Z rejects every pixel the city
  // already covers. Cuts the sky's full-screen overdraw to visible sky only.
  gl_Position.z = gl_Position.w * 0.999999;
}
`;

export const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec2 uSunAz;

uniform vec3 cHorizon, cLow, cMid, cHigh, cZenith;
uniform vec3 cAway, cToward, cSunCore, cSunHalo;
uniform vec3 cCloudLit, cCloudMid, cCloudCore;
uniform vec3 cGroundHaze, cMoon;

uniform float uTime;
uniform vec3  uCover;      // cirrus, alto, cumulus coverage 0..1
uniform vec4  uP;          // skyIntensity, sunIntensity, nightFactor, haze
uniform vec4  uP2;         // cloudDark, shaftStrength, stars, moon
uniform vec2  uLightStep;  // in-plane sun march step: cumulus, alto
uniform float uSunRadius;
uniform float uFlash;
uniform float uWind;

#ifndef SK_QUALITY
  #define SK_QUALITY 2
#endif

${NOISE_GLSL}
${CLOUD_GLSL}
${SKY_BANDS_GLSL}
${SKY_AIRMASS_GLSL}

// Deck geometry: shell height (planet radii) and plane scale.
const float SK_H_CIRRUS = 0.100;
const float SK_S_CIRRUS = 118.0;
const float SK_H_ALTO   = 0.062;
const float SK_S_ALTO   = 146.0;
const float SK_H_CUMULUS= 0.042;
const float SK_S_CUMULUS= 172.0;

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  float f = max(asin(clamp(up, -1.0, 1.0)) * 0.63661977, 0.0);

  float cosSun = dot(d, uSunDir);
  vec2 hdir = normalize(vec2(d.x, d.z) + vec2(1e-6));
  float az = dot(hdir, uSunAz);
  float azW = smoothstep(-0.40, 0.98, az);

  /* ---------------- airmass ---------------- */

  // One extinction, used by the disc, both glow lobes, the cloud rim colour and
  // the veil, so every warm thing in the frame reddens together as the sun sets.
  vec3 ext = skAirmassExtinction(uSunDir);
  vec3 haloCol = cSunHalo * ext;
  vec3 coreCol = cSunCore * ext;

  /* ---------------- base scattering gradient ---------------- */

  SkBandSet B;
  B.horizon = cHorizon;
  B.low = cLow;
  B.mid = cMid;
  B.high = cHigh;
  B.zenith = cZenith;
  B.away = cAway;
  B.toward = cToward;
  B.halo = haloCol;
  B.ground = cGroundHaze;

  vec3 sky = skBandRadiance(d, uSunDir, uSunAz, B, uP.w, uP.x);

  /* ---------------- cloud decks (far to near) ---------------- */

  vec2 lightDir = normalize(uSunDir.xz + vec2(1e-5));
  float sunUpFade = smoothstep(-0.14, 0.05, uSunDir.y);

  /* THE RIM LOBE.
   *
   * Henyey-Greenstein at g = 0.75 is a genuine forward-scattering lobe: it is
   * ~1 at 90 degrees off-sun and climbs steeply inside about 25 degrees. This
   * is what makes a cloud EDGE ignite while its body stays dark, and it is the
   * whole difference between "backlit deck" and "grey smudge". The decks used
   * to sample the same hue and saturation at every angle to the sun, which is
   * exactly why they read as dirt. */
  float mie = skHG(cosSun, 0.75);
  float mieRim = skHG(cosSun, 0.86);

  // Scattering tint for the decks. Deliberately NOT cSunCore, which is scaled
  // for a 0.4-degree disc and would nuke every cloud edge in the frame.
  vec3 sunLit = haloCol * (0.30 + 0.70 * sunUpFade);

  // Accumulated deck opacity, so stars can be occluded by cloud.
  float cloudMask = 0.0;

  // Azimuthal proximity to the sun. The decks on the solar half ignite and
  // everything behind you stays violet — without this the whole sky turns into
  // one flat sheet of pink.
  float towardSun = pow(azW, 1.25);

  // ...and a low sun only rakes the decks near the horizon. Clouds overhead are
  // lit from below and edge-on, so they fall back toward their cold cores.
  float deckLight = (0.10 + 0.90 * towardSun) * (0.12 + 0.88 * exp(-f * 2.6));

  /* RIM IGNITION GATE.
   *
   * Softer than it was, on purpose. At pow(azW, 3.2) the amber was confined to
   * a narrow wedge pointing dead at the sun, so in any framing that was not
   * looking straight down-sun every cloud in the frame was a grey silhouette
   * with no warm edge anywhere. A real backlit deck at golden hour carries some
   * rim across most of the solar hemisphere, and the FALLOFF that separates
   * "hot rim" from "cold deck" should come from the HG lobe and the deck's own
   * transmittance, not from a hard azimuth cut. */
  float rimGate = (0.10 + 0.90 * pow(azW, 1.7)) * sunUpFade;

  /* VERTICAL DENSITY GRADIENT.
   *
   * Real decks are lit on top and dark underneath. Seen from below at sunset
   * the base of a deck is the darkest thing in the sky and its upper shoulder
   * is the brightest. Decks near the horizon are seen edge-on (mostly shoulder,
   * so bright); decks overhead are seen from directly below (all base, so
   * dark). This one term is most of what makes the sky read as having weight. */
  float baseShade = mix(0.34, 1.0, exp(-f * 2.2));

  if (up > -0.02) {
    /* --- cirrus: thin, high, fibrous, lit almost entirely by transmission --- */
#if SK_QUALITY >= 1
    {
      vec2 uv = skCloudUV(d, SK_H_CIRRUS, SK_S_CIRRUS);
      // Rotate into the sun's azimuth frame so the streaks converge on sunset.
      vec2 r = vec2(dot(uv, uSunAz), dot(uv, vec2(-uSunAz.y, uSunAz.x)));
      float dens = skCirrus(r, uTime * uWind * 1.00, uCover.x);
      dens *= smoothstep(0.016, 0.150, up);
      if (dens > 0.001) {
        float T = exp(-dens * 1.5);
        float lit = clamp(T * deckLight, 0.0, 1.0);
        // THREE HUES chained, not two brightnesses: indigo-blue core -> rose
        // body -> amber rim.
        vec3 col = mix(cCloudCore, cCloudMid, smoothstep(0.05, 0.58, lit));
        col = mix(col, cCloudLit, pow(lit, 1.45) * rimGate);
        // Cirrus is optically thin, so it is mostly transmitted light: the HG
        // lobe dominates its appearance.
        col += sunLit * mieRim * 0.30 * T * rimGate;
        col *= uP2.x * uP.x * mix(baseShade, 1.0, 0.65);
        float a = dens * 0.55;
        sky = mix(sky, col, a);
        cloudMask = mix(cloudMask, 1.0, a);
      }
    }
#endif

    /* --- alto: the banded coral mid-deck --- */
    {
      vec2 uv = skCloudUV(d, SK_H_ALTO, SK_S_ALTO);
      float drift = uTime * uWind * 0.62;
      float dens = skAlto(uv, drift, uCover.y);
      dens *= smoothstep(0.022, 0.135, up);
      if (dens > 0.001) {
        float sh = skSunTransmittance(uv, lightDir, uLightStep.y, drift, uCover.y, 1);
        float T = exp(-sh * 2.30);
        float lit = clamp(T * deckLight, 0.0, 1.0);
        // Thin edges: dens*(1-dens) peaks where the deck is half-transparent,
        // which is geometrically where a real cloud's rim is.
        float edge = dens * (1.0 - dens) * 4.0;
        vec3 col = mix(cCloudCore, cCloudMid, smoothstep(0.04, 0.52, lit));
        col = mix(col, cCloudLit, pow(lit, 1.9) * rimGate);
        // AMBER RIM IGNITION. Forward-scattered light punching through the thin
        // edge of the deck. This term is the one that has to be unmistakable.
        col += sunLit * mieRim * (0.10 + edge * 1.35) * T * rimGate;
        col += cCloudLit * mie * edge * 0.55 * T * rimGate;
        col *= uP2.x * uP.x * baseShade;
        float a = dens * 0.94;
        sky = mix(sky, col, a);
        cloudMask = mix(cloudMask, 1.0, a);
      }
    }

    /* --- cumulus: chunky, backlit, indigo-cored --- */
    {
      vec2 uv = skCloudUV(d, SK_H_CUMULUS, SK_S_CUMULUS);
      float drift = uTime * uWind * 0.36;
      float dens = skCumulus(uv, drift, uCover.z);
      dens *= smoothstep(0.026, 0.130, up);
      if (dens > 0.001) {
        float sh = skSunTransmittance(uv, lightDir, uLightStep.x, drift, uCover.z, 0);
        float T = exp(-sh * 2.90);
        float lit = clamp(T * deckLight, 0.0, 1.0);
        float edge = dens * (1.0 - dens) * 4.0;
        vec3 col = mix(cCloudCore, cCloudMid, smoothstep(0.03, 0.50, lit));
        col = mix(col, cCloudLit, pow(lit, 2.2) * rimGate);
        // Powder: dense cores facing the sun stay dark, which reads as volume.
        col *= mix(1.0, 0.52, dens * (1.0 - T));
        col += sunLit * mieRim * (0.08 + edge * 1.55) * T * rimGate;
        col += cCloudLit * mie * edge * 0.62 * T * rimGate;
        col *= uP2.x * uP.x * baseShade;
        float a = dens * 0.985;
        sky = mix(sky, col, a);
        cloudMask = mix(cloudMask, 1.0, a);
      }
    }
  }

  /* ---------------- crepuscular rays ---------------- */

#if SK_QUALITY >= 1
  if (uP2.y > 0.001 && cosSun > 0.15) {
    float acc = 0.0;
    for (int i = 1; i <= 4; i++) {
      vec3 sd = normalize(mix(d, uSunDir, float(i) * 0.21));
      vec2 uvs = skCloudUV(sd, SK_H_ALTO, SK_S_ALTO);
      acc += skAltoLo(uvs, uTime * uWind * 0.62, uCover.y) * smoothstep(-0.01, 0.05, sd.y);
    }
    float open = 1.0 - clamp(acc * 0.32, 0.0, 1.0);
    // Crepuscular rays are a NARROW effect. A wide lobe here lays flat orange
    // over a 40-degree cone and is indistinguishable from a bad lens flare.
    float shaft = open * smoothstep(0.30, 0.80, cosSun) * pow(max(cosSun, 0.0), 9.0);
    sky += haloCol * shaft * uP2.y * 0.22 * sunUpFade * uP.x;
  }
#endif

  /* ---------------- sun ---------------- */

  vec3 sRight = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
  vec3 sUp = cross(sRight, uSunDir);
  float ax = dot(d, sRight);
  float ay = dot(d, sUp);
  // Atmospheric refraction squashes the disc vertically as it nears the horizon.
  float flatten = mix(0.55, 1.0, smoothstep(-0.02, 0.24, uSunDir.y));
  float rr = sqrt(ax * ax + (ay / flatten) * (ay / flatten));
  float disc = (1.0 - smoothstep(uSunRadius * 0.72, uSunRadius, rr)) * step(0.0, cosSun);
  disc *= mix(1.0, 0.70, smoothstep(0.0, uSunRadius, rr));   // limb darkening
  disc *= smoothstep(-0.055, -0.005, up);                    // sinks below the horizon

  /* THE LOBES.
   *
   * A real low sun is a SMALL core that clips to white inside a LARGE warm
   * halo inside a very broad veil, and the three are orders of magnitude apart
   * in radiance. Getting that wrong in either direction is what makes a sun
   * look fake: one flat lobe at a moderate value is a beige dot (what this
   * was), and one flat lobe at a high value is a ten-degree ball of clipped
   * white with no hue anywhere.
   *
   *   core  pow(.,4200) ~ 1.2 deg half-width, fed the disc colour, HDR
   *   halo  pow(.,110)  ~ 6.5 deg,           fed the reddened halo colour
   *   veil  pow(.,9)    ~ 22  deg,           weak; tints, does not bleach
   *
   * All three are reddened by the same airmass extinction, so the whole
   * apparatus goes from white at noon to blood orange at sunset together.
   */
  float cs = max(cosSun, 0.0);
  float glowCore = pow(cs, 9000.0);   // ~0.85 deg
  float glowInner = pow(cs, 900.0);   // ~2.7 deg
  float glowHalo = pow(cs, 110.0);    // ~7.7 deg
  float glowVeil = pow(cs, 9.0);      // ~27 deg

  /* THE HALO CARRIES THE COLOUR, THE CORE CARRIES THE BRIGHTNESS.
   *
   * This split matters more than any single magnitude. Everything above about
   * 15 linear survives the exposure shoulder and AgX as pure white no matter
   * what hue it started as — highlight compression converges the channels by
   * construction, so a "deep orange sun" authored at 40x white renders as a
   * white blob every time. The only way to get a sun that is BOTH the
   * brightest thing in the frame AND visibly orange is to let a ~1-degree core
   * clip to white (which is what a real sun does through a real lens) and hang
   * a much larger halo off it at a value low enough to keep its hue — around
   * 1.5-2 linear, well under the shoulder's knee-to-white range. */
  float glowWide = pow(cs, 28.0);     // ~15 deg
  sky += haloCol * glowVeil * 0.060 * uP.w * sunUpFade * uP.x;
  sky += haloCol * glowWide * 1.15 * sunUpFade * uP.x;
  sky += haloCol * glowHalo * 5.60 * sunUpFade * uP.x;
  sky += haloCol * glowInner * 3.00 * sunUpFade * uP.x;
  sky += coreCol * glowCore * 0.60 * sunUpFade * uP.x;
  // THE DISC. This is the brightest thing in the game by design — it has to
  // clear the bloom threshold by a wide margin and clip its core to white.
  sky += coreCol * disc * uP.y * uP.x;
  // Broad Mie veil in the air. Weak: at any real strength this single term
  // paints a 20-degree cone of flat salmon over everything.
  sky += haloCol * mie * 0.030 * uP.w * sunUpFade * uP.x;

  /* ---------------- night: stars + moon ---------------- */

  if (uP2.z > 0.002) {
    vec3 g = d * 190.0;
    vec3 cell = floor(g);
    float h = skHash13(cell);
    vec3 off = vec3(skHash13(cell + 1.31), skHash13(cell + 7.77), skHash13(cell + 13.13));
    float dist = length(g - (cell + off));
    float mag = smoothstep(0.9955, 0.9999, h);
    float star = mag * exp(-dist * dist * 11.0);
    float tw = 0.72 + 0.28 * sin(uTime * (1.3 + h * 5.0) + h * 41.0);
    vec3 tint = mix(vec3(0.72, 0.80, 1.0), vec3(1.0, 0.88, 0.72), fract(h * 37.0));
    sky += tint * star * tw * uP2.z * 3.4 * smoothstep(0.0, 0.16, up) * (1.0 - cloudMask);

    // A faint dusty band, Milky-Way-ish, so the zenith is never dead flat.
    float band = exp(-pow((dot(d, normalize(vec3(0.55, 0.42, -0.72)))) * 3.1, 2.0));
    sky += vec3(0.36, 0.34, 0.52) * band * uP2.z * 0.06 * smoothstep(0.0, 0.3, up) * (1.0 - cloudMask);
  }

  if (uP2.w > 0.002) {
    float mr = 0.0125;
    vec3 mRight = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    vec3 mUp = cross(mRight, uMoonDir);
    float mx = dot(d, mRight) / mr;
    float my = dot(d, mUp) / mr;
    float cm = dot(d, uMoonDir);
    float r2 = mx * mx + my * my;
    if (r2 < 1.6 && cm > 0.0) {
      float zz = sqrt(max(0.0, 1.0 - r2));
      vec3 n = mRight * mx + mUp * my + uMoonDir * zz;
      float lam = max(dot(n, uSunDir), 0.0);
      float maria = 0.72 + 0.28 * skFbm3(vec2(mx, my) * 2.4);
      float diskMask = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
      sky += cMoon * diskMask * (0.06 + lam * 1.9) * maria * uP2.w * 6.5 * (1.0 - cloudMask * 0.85);
    }
    float halo = pow(max(cm, 0.0), 900.0) * 0.35 + pow(max(cm, 0.0), 46.0) * 0.022;
    sky += cMoon * halo * uP2.w * (1.0 - cloudMask * 0.7);
  }

  sky += vec3(0.86, 0.80, 1.0) * uFlash;

  gl_FragColor = vec4(max(sky, vec3(0.0)), 1.0);
}
`;
