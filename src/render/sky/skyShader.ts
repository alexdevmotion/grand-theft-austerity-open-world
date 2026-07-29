/** The sky dome shader: analytic scattering gradient, flattened sun disc,
 *  three-deck backlit cloud system, crepuscular rays, star field and a moon
 *  with a real terminator.
 *
 *  Composited far-to-near so the decks occlude each other correctly:
 *      gradient -> cirrus -> alto -> cumulus -> shafts -> sun/stars -> haze
 *
 *  Everything is HDR: the horizon runs 3-5x white, the sun core ~60x, so the
 *  bloom and AgX tone map in the post chain have something real to work with.
 *  The sky is the key light of this game — it has to out-punch every surface.
 */

import { NOISE_GLSL } from './noise';
import { CLOUD_GLSL } from './cloudShader';

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
  float f = clamp(up, 0.0, 1.0);

  float cosSun = dot(d, uSunDir);
  vec2 hdir = normalize(vec2(d.x, d.z) + vec2(1e-6));
  float az = dot(hdir, uSunAz);
  float azW = smoothstep(-0.35, 0.98, az);
  // The orange rip is a THIN band. At exp(-f*7) it was still at 30% strength
  // 15 degrees up, which smeared hot orange over the coral and magenta bands
  // and is most of why the low sky measured as one cream wash.
  float lowMask = exp(-f * 14.0);

  /* ---------------- base scattering gradient ---------------- */

  /* Band placement, in degrees of elevation:
   *     0 - 6    hot orange rip        cHorizon
   *     6 - 15   coral / rose          cLow
   *    15 - 35   magenta               cMid
   *    35 - 60   violet                cHigh
   *    60 - 90   indigo                cZenith
   * The previous stops held the horizon and coral bands up past 25 degrees,
   * so magenta and violet were squeezed into the top sliver of the dome and
   * simply never appeared in a normal street or skyline framing. */
  float k = pow(f, 0.45);
  vec3 sky = cHorizon;
  sky = mix(sky, cLow,    smoothstep(0.00, 0.34, k));
  sky = mix(sky, cMid,    smoothstep(0.32, 0.56, k));
  sky = mix(sky, cHigh,   smoothstep(0.54, 0.80, k));
  sky = mix(sky, cZenith, smoothstep(0.76, 0.98, k));

  // Anti-solar half keeps its short-wavelength violet; the solar half loses
  // blue and becomes coral. Without this split the whole dome is one hue.
  //
  // ...but the split has to DIE OFF WITH ALTITUDE. 'azW' is a purely horizontal
  // azimuth test, so applied flat it bleached the warm tint all the way to the
  // zenith and the sun-facing hemisphere measured as one 22-degree hue arc of
  // salmon with no blue anywhere. A low sun only warms the air near the
  // horizon; 40 degrees up, both halves of the dome are violet.
  float azWt = azW * (0.22 + 0.78 * exp(-f * 2.6));
  sky *= mix(cAway, cToward, azWt);

  // Rayleigh lobe: brightest at 90 degrees from the sun, softly lifts the dome.
  sky += cHigh * skRayleigh(cosSun) * 0.06 * (1.0 - uP.z);

  // The orange rip along the horizon toward the sun.
  sky += cHorizon * pow(azW, 2.9) * lowMask * uP.w * 0.42;
  sky += cLow * pow(azW, 1.4) * lowMask * uP.w * 0.16;

  /* ---------------- cloud decks (far to near) ---------------- */

  vec2 lightDir = normalize(uSunDir.xz + vec2(1e-5));
  float mie = skHG(cosSun, 0.78);
  float sunUpFade = smoothstep(-0.14, 0.05, uSunDir.y);
  // Scattering tint for the decks. Deliberately NOT cSunCore, which is scaled
  // for a 0.4-degree disc and would nuke every cloud edge in the frame.
  vec3 sunLit = cSunHalo * (0.30 + 0.70 * sunUpFade);
  // Accumulated deck opacity, so stars can be occluded by cloud.
  float cloudMask = 0.0;
  // Azimuthal proximity to the sun. At sunset the decks on the solar half of
  // the dome ignite and everything behind you stays violet — without this the
  // whole sky turns into one flat sheet of pink.
  float towardSun = pow(azW, 1.45);
  // ...and a low sun only rakes the decks near the horizon. Clouds overhead
  // are lit from below and edge-on, so they stay violet — reference, top left.
  // Steep in BOTH terms. A 3-degree sun cannot reach a cloud 30 degrees up
  // except edge-on, so the deck overhead has to fall back to its violet core
  // fast. At exp(-f*2.9) it was still 36% lit at 30 degrees, which painted the
  // whole upper dome in warm cloud and buried the magenta/violet ladder under it.
  float deckLight = (0.08 + 0.92 * towardSun) * (0.08 + 0.92 * exp(-f * 4.5));
  // Rim ignition gate. Only the decks ON the solar side get an amber edge; a
  // cloud 90 degrees round the dome must stay a cold violet silhouette, which
  // is what gives a single frame both a hot rim and a dark deck.
  float rimGate = pow(azW, 3.2) * sunUpFade;

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
        // Two HUES, not two brightnesses: indigo core -> rose body -> amber rim.
        vec3 col = mix(cCloudCore, cCloudMid, smoothstep(0.06, 0.60, lit));
        col = mix(col, cCloudLit, pow(lit, 1.75) * (0.14 + 0.86 * rimGate));
        col += sunLit * mie * 0.06 * T * rimGate;
        col += cCloudLit * pow(max(cosSun, 0.0), 4.0) * 0.18 * rimGate;
        col *= uP2.x;
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
        float edge = dens * (1.0 - dens) * 4.0;
        vec3 col = mix(cCloudCore, cCloudMid, smoothstep(0.05, 0.55, lit));
        col = mix(col, cCloudLit, pow(lit, 2.3) * (0.08 + 0.92 * rimGate));
        // Silver lining: forward-scattered light punching through thin edges.
        // Gated on the solar azimuth, so it ignites one side of the sky only.
        col += sunLit * mie * (0.05 + edge * 0.66) * T * rimGate;
        col += cCloudLit * pow(max(cosSun, 0.0), 5.0) * T * 0.34 * rimGate;
        col *= uP2.x;
        float a = dens * 0.94;
        sky = mix(sky, col, a);
        cloudMask = mix(cloudMask, 1.0, a);
      }
    }

    /* --- cumulus: chunky, backlit, violet-cored --- */
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
        vec3 col = mix(cCloudCore, cCloudMid, smoothstep(0.04, 0.52, lit));
        col = mix(col, cCloudLit, pow(lit, 2.8) * (0.06 + 0.94 * rimGate));
        // Powder: dense cores facing the sun stay dark, which reads as volume.
        col *= mix(1.0, 0.55, dens * (1.0 - T));
        col += sunLit * mie * (0.04 + edge * 0.84) * T * rimGate;
        col += cCloudLit * pow(max(cosSun, 0.0), 6.0) * T * 0.38 * rimGate;
        col *= uP2.x;
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
    // pow(.,3) is a 55-degree lobe. At a 0.55 weight this single line laid
    // 0.24 linear of orange over a 40-degree cone centred on the sun and was
    // the largest contributor to the sun-facing sky measuring as one flat
    // pale-salmon wash. Crepuscular rays are a NARROW, subtle effect.
    float shaft = open * smoothstep(0.30, 0.80, cosSun) * pow(max(cosSun, 0.0), 9.0);
    sky += cSunHalo * shaft * uP2.y * 0.16 * sunUpFade;
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
  float disc = (1.0 - smoothstep(uSunRadius * 0.70, uSunRadius, rr)) * step(0.0, cosSun);
  disc *= mix(1.0, 0.66, smoothstep(0.0, uSunRadius, rr));   // limb darkening
  disc *= smoothstep(-0.055, -0.005, up);                    // sinks below the horizon

  /* Glow lobes.
   *
   * These, not the disc, are what used to make the sun a 10-degree ball of
   * clipped pure white. 'pow(cosSun, 780)' is a 2.9-degree half-width lobe fed
   * a 26x near-white core colour at a 0.5 scalar — 13x white over 6 degrees of
   * sky, which no tone map can hold on to a hue. A real sun is a SMALL
   * saturated core inside a LARGE soft coloured halo, so:
   *
   *   core  pow(.,5200) ~ 1.0 deg half-width, fed the deep-orange disc colour
   *   halo  pow(.,150)  ~ 5.5 deg,           fed the halo colour only
   *   veil  pow(.,9)    ~ 22  deg,           very weak, tints not bleaches
   *
   * The middle lobe used to be fed core-magnitude values; it is halo-only now.
   */
  float cs = max(cosSun, 0.0);
  float glowCore = pow(cs, 5200.0);
  float glowHalo = pow(cs, 150.0);
  float glowVeil = pow(cs, 9.0);

  sky += cSunHalo * glowVeil * 0.014 * uP.w * sunUpFade;
  sky += cSunHalo * glowHalo * 0.100 * sunUpFade;
  sky += cSunCore * glowCore * 0.220 * sunUpFade;
  sky += cSunCore * disc * uP.y;
  // Broad Mie veil. At 0.13 (and even at 0.10) this single term put 0.14 linear
  // of orange over a ~20-degree cone around the sun and was on its own most of
  // the pale-salmon wash the whole sun-facing sky was measuring as.
  sky += cSunHalo * mie * 0.022 * uP.w * sunUpFade;

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

  /* ---------------- horizon haze + below-horizon ---------------- */

  float hz = exp(-max(up, 0.0) * 64.0) * smoothstep(-0.06, 0.005, up);
  vec3 hazeCol = mix(cGroundHaze * 2.0, cHorizon * 0.80, pow(azW, 1.5));
  sky = mix(sky, hazeCol, hz * uP.w * 0.34);

  sky = mix(sky, cGroundHaze, smoothstep(0.002, -0.085, up));

  sky *= uP.x;
  sky += vec3(0.86, 0.80, 1.0) * uFlash;

  gl_FragColor = vec4(max(sky, vec3(0.0)), 1.0);
}
`;
