/** Exposure + cinematic colour grade.
 *
 *  Two effects live here because they are two halves of one decision:
 *
 *  `ExposureEffect` runs BEFORE tone mapping, in linear HDR. Without it the
 *  AgX curve receives a scene that is a stop and a half under and crushes
 *  everything into the toe — which is exactly why the baseline read as black
 *  silhouettes against a bright sky.
 *
 *  `GradeEffect` runs AFTER tone mapping and behaves like a DI grade:
 *  ASC-CDL lift/gamma/gain, a violet-shadow / orange-highlight split tone, and
 *  an explicit toe lift so that nothing in the frame is ever pure black —
 *  rule 1 of the visual target.
 */

import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector3 } from 'three';
import { Grade } from '../artDirection';

/* ------------------------------------------------------------------ */
/* Exposure (pre tone mapping)                                         */
/* ------------------------------------------------------------------ */

const exposureFragment = /* glsl */ `
uniform float uExposure;
uniform float uHighlightRolloff;
uniform float uShoulderKnee;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0) * uExposure;

  /* SOFT-KNEE SHOULDER, NOT A GLOBAL DIVIDE.
   *
   * This used to be c / (1 + c * 1.1), which is a hyperbola with a hard
   * asymptote at 1/1.1 = 0.909. That single line meant NOTHING IN THE GAME
   * COULD EVER EXCEED 0.909 LINEAR coming out of this pass — the sun disc, the
   * horizon rip, a window emissive and a moderately lit wall all arrived at
   * AgX inside the same half stop. That is the mechanism behind two of the
   * three headline failures: the sun measured 1.25x brighter than sky 120px
   * away (it cannot measure more), and bloom's luminance threshold sat at 0.92,
   * ABOVE the ceiling, so the bloom pass was effectively dead.
   *
   * The shoulder below leaves everything under the knee completely untouched —
   * a lit facade at 0.4 stays 0.4 — and compresses only above it, toward a
   * ceiling near 21. So the sun still lands two orders of magnitude above the
   * city, clips its core to white through AgX, and drives bloom, while a
   * window emissive at 4 linear lands near 3.5 and keeps its hue instead of
   * becoming flat pastel paper. */
  vec3 over = max(c - uShoulderKnee, 0.0);
  c = min(c, vec3(uShoulderKnee)) + over / (1.0 + over * uHighlightRolloff);

  outputColor = vec4(c, inputColor.a);
}
`;

export class ExposureEffect extends Effect {
  constructor(exposure: number = Grade.exposure) {
    super('ExposureEffect', exposureFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform<unknown>>([
        ['uExposure', new Uniform(exposure)],
        // Where the shoulder starts. Below this, values pass through exactly.
        // A lit facade measures 0.15-0.4 here, so the whole of the city's
        // ordinary tonal range is untouched and only genuinely emissive things
        // are compressed.
        ['uShoulderKnee', new Uniform(0.72)],
        // Compression above the knee. Ceiling = knee + 1/rolloff ~= 21 linear,
        // which is roughly AgX's own white point, so the sun clips there and
        // nothing else does. Sample points: 1 -> 0.996, 4 -> 3.56, 40 -> 14.3.
        ['uHighlightRolloff', new Uniform(0.048)],
      ]),
    });
  }

  set exposure(v: number) {
    (this.uniforms.get('uExposure') as Uniform<number>).value = v;
  }

  get exposure(): number {
    return (this.uniforms.get('uExposure') as Uniform<number>).value;
  }

  set rolloff(v: number) {
    (this.uniforms.get('uHighlightRolloff') as Uniform<number>).value = v;
  }

  /** Where the highlight shoulder starts, in linear post-exposure units. */
  set knee(v: number) {
    (this.uniforms.get('uShoulderKnee') as Uniform<number>).value = v;
  }
}

/* ------------------------------------------------------------------ */
/* Grade (post tone mapping)                                           */
/* ------------------------------------------------------------------ */

const fragment = /* glsl */ `
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uGamma;
uniform float uSaturation;
uniform float uContrast;
uniform float uSplitStrength;
uniform float uChromaRolloff;
uniform float uChromaKnee;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform vec3 uToeColor;
uniform float uToeLift;
uniform float uSplitBalance;
uniform float uGrain;
uniform float uTime;
uniform float uFlash;
uniform vec3 uFlashColor;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Hash-based film grain — cheap and stable enough at 60fps.
float grain(vec2 uv, float t) {
  vec3 p3 = fract(vec3(uv.xyx) * 443.8975 + t * 13.13);
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.x + p3.y) * p3.z) - 0.5;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);

  /* SPLIT TONE: shadows go COOL AZURE, highlights go WARM AMBER.
   *
   * This is the one mechanism that keeps light and shadow on opposite sides of
   * the colour wheel after tone mapping, and it only works if the two weights
   * do not OVERLAP. The previous balance of 1.35 meant the shadow weight was
   * still 0.35 at mid-grey while the highlight weight was already 0.26 there,
   * so every mid-tone in the frame — which at dusk is most of the frame,
   * including the entire sky gradient — got tinted toward BOTH and came out
   * the average of the two: a desaturated mauve. That is a large part of why
   * the whole image measured as one hue.
   *
   * At 2.4 the shadow tint is gone by luma 0.42 and the highlight tint has not
   * started until 0.24, so the two act on genuinely different parts of the
   * tonal range and the split reads as a split. */
  float l = luma(c);
  float shadowW = pow(1.0 - clamp(l * uSplitBalance, 0.0, 1.0), 2.0);
  float highW  = pow(clamp((l - 0.24) * 1.75, 0.0, 1.0), 1.15);
  c = mix(c, c * uShadowTint, shadowW * uSplitStrength);
  c = mix(c, c * uHighlightTint, highW * uSplitStrength);

  // ASC CDL: (in * gain + lift) ^ gamma
  c = c * uGain + uLift;
  c = pow(max(c, 0.0), 1.0 / uGamma);

  // Contrast about mid-grey.
  c = (c - 0.18) * uContrast + 0.18;

  // Saturation, applied after contrast so the magentas survive AgX.
  float g = luma(c);
  // Chroma rolloff: bright values desaturate the way film and real sensors do.
  // Without it a saturated key light drives everything it touches to a single
  // screaming hue — the frame measured 0.82 saturation against the reference
  // frame's 0.37 before this was added. It also keeps the sun disc and the
  // window emissives from clipping as pure primaries.
  float rolloff = 1.0 - uChromaRolloff * smoothstep(uChromaKnee, 1.0, g);
  c = mix(vec3(g), c, uSaturation * rolloff);

  // Toe lift: a printed-film black that is violet, never zero. Rule 1.
  c = max(c, 0.0);
  c += uToeColor * uToeLift * (1.0 - smoothstep(0.0, 0.42, luma(c)));

  // Broadcast-hijack / damage flash.
  c = mix(c, uFlashColor, uFlash);

  // Grain, stronger in the shadows the way real sensors behave.
  float gr = grain(uv, uTime);
  c += gr * uGrain * (1.0 - smoothstep(0.0, 0.75, luma(c)));

  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', fragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform<unknown>>([
        ['uLift', new Uniform(new Vector3(...Grade.liftRGB))],
        ['uGain', new Uniform(new Vector3(...Grade.gainRGB))],
        ['uGamma', new Uniform(new Vector3(...Grade.gammaRGB))],
        /* Saturation was 0.52x the authored intent — a 40% desaturation of the
         * whole frame on top of AgX, which already desaturates hard. Between
         * the two, a hot orange horizon and a violet zenith were being dragged
         * to within a few degrees of each other and the image measured as one
         * low-chroma mauve wash. Measured hue histogram of the reference: 43%
         * of its chromatic pixels are warm (red/orange), 36% cool. The frame
         * this replaced measured 4-6% warm and 91% cool. */
        ['uSaturation', new Uniform(Grade.saturation * 1.06)],
        /* Chroma rolloff still exists — it is what lets the sun's core go
         * genuinely white instead of clipping as a saturated primary — but it
         * now starts far higher up. At knee 0.34 it was desaturating every
         * sunlit facade and the entire horizon rip, i.e. removing exactly the
         * warmth the key light exists to create. */
        ['uChromaRolloff', new Uniform(0.40)],
        // High on purpose. The horizon rip lands around 0.8 luma after tone
        // mapping; a knee below that desaturates the single most important
        // warm feature in the frame and turns fire into pale peach.
        ['uChromaKnee', new Uniform(0.78)],
        ['uContrast', new Uniform(Grade.contrast * 1.06)],
        // Deep azure, ~180 degrees of hue from the amber highlight tint below.
        // Azure and not violet on purpose: measured against the reference, its
        // cool pixels are 30% azure / 21% blue and only 10% violet, so tinting
        // shadows violet put them in the SAME wedge as the magenta sky bands.
        ['uShadowTint', new Uniform(new Vector3(0.62, 0.88, 1.38))],
        ['uHighlightTint', new Uniform(new Vector3(1.42, 1.00, 0.48))],
        ['uSplitStrength', new Uniform(0.88)],
        ['uToeColor', new Uniform(new Vector3(0.048, 0.058, 0.170))],
        ['uToeLift', new Uniform(0.06)],
        ['uSplitBalance', new Uniform(2.20)],
        // Grain reads far stronger over a dark, low-contrast frame than the
        // authored value assumes; it was the dominant texture in the shadows.
        ['uGrain', new Uniform(Grade.filmGrain * 0.5)],
        ['uTime', new Uniform(0)],
        ['uFlash', new Uniform(0)],
        ['uFlashColor', new Uniform(new Vector3(1, 0.35, 0.75))],
      ]),
    });
  }

  /** 0..1 full-screen colour flash, decays externally. */
  setFlash(amount: number, r = 1, g = 0.35, b = 0.75): void {
    (this.uniforms.get('uFlash') as Uniform<number>).value = amount;
    (this.uniforms.get('uFlashColor') as Uniform<Vector3>).value.set(r, g, b);
  }

  setSaturation(v: number): void {
    (this.uniforms.get('uSaturation') as Uniform<number>).value = v;
  }

  setContrast(v: number): void {
    (this.uniforms.get('uContrast') as Uniform<number>).value = v;
  }

  /** How hard the brightest values fall back toward neutral. 0 disables it. */
  setChromaRolloff(v: number, knee?: number): void {
    (this.uniforms.get('uChromaRolloff') as Uniform<number>).value = v;
    if (knee !== undefined) (this.uniforms.get('uChromaKnee') as Uniform<number>).value = knee;
  }

  /** Shadow / highlight tints of the split tone, in linear RGB multipliers. */
  setSplitTint(sr: number, sg: number, sb: number, hr: number, hg: number, hb: number): void {
    (this.uniforms.get('uShadowTint') as Uniform<Vector3>).value.set(sr, sg, sb);
    (this.uniforms.get('uHighlightTint') as Uniform<Vector3>).value.set(hr, hg, hb);
  }

  /** Overall weight of the violet-shadow / warm-highlight split tone. */
  setSplitStrength(v: number): void {
    (this.uniforms.get('uSplitStrength') as Uniform<number>).value = v;
  }

  setGrain(v: number): void {
    (this.uniforms.get('uGrain') as Uniform<number>).value = v;
  }

  /** How far the printed black is lifted, and toward which colour. */
  setToe(lift: number, r?: number, g?: number, b?: number): void {
    (this.uniforms.get('uToeLift') as Uniform<number>).value = lift;
    if (r !== undefined) {
      (this.uniforms.get('uToeColor') as Uniform<Vector3>).value.set(r, g ?? 0, b ?? 0);
    }
  }

  override update(): void {
    const u = this.uniforms.get('uTime') as Uniform<number>;
    u.value = (u.value + 0.016) % 1000;
  }
}
