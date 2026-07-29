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

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0) * uExposure;
  // Gentle pre-shoulder so the sun disc and window emissives keep their hue
  // going into AgX instead of clipping straight to white.
  c = c / (1.0 + c * uHighlightRolloff);
  outputColor = vec4(c, inputColor.a);
}
`;

export class ExposureEffect extends Effect {
  constructor(exposure: number = Grade.exposure) {
    super('ExposureEffect', exposureFragment, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform<unknown>>([
        ['uExposure', new Uniform(exposure)],
        // A city full of emissive windows arrives at the tone mapper with
        // values far above 1, and AgX alone clips them into flat white paper
        // that has lost all of its purple and sodium. This shoulder compresses
        // them back into range BEFORE tone mapping, which is what lets a lit
        // interior stay a colour instead of becoming a hole in the facade.
        // Too high and the sun disc loses its punch, so this is a compromise.
        // Measured: a curtain-wall pane arrives here at 3-6 linear, a lit
        // facade at 0.15-0.4. At 0.22 the panes still cleared 2.0 going into
        // AgX and clipped to flat pastel rectangles that out-shone the sky —
        // which inverts the whole image, because in the reference the glass
        // tower is the DARKEST large mass in frame. At 1.1 a pane lands near
        // 0.85 and keeps its hue, while a facade loses only ~15%, which the
        // exposure above pays back.
        ['uHighlightRolloff', new Uniform(1.1)],
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

  // Split tone: shadows go COOL BLUE, highlights go WARM AMBER. This is the
  // single mechanism that keeps light and shadow on opposite sides of the
  // colour wheel after tone mapping, and it only works if the two tints are
  // genuinely far apart. The previous shadow tint (0.80, 0.78, 1.14) had r and
  // g within 3% of each other — a violet that sat in the same hue wedge as the
  // magenta sky, so split-toning deepened the wedge instead of breaking it.
  float l = luma(c);
  float shadowW = pow(1.0 - clamp(l * uSplitBalance, 0.0, 1.0), 2.0);
  float highW  = pow(clamp((l - 0.28) * 1.55, 0.0, 1.0), 1.3);
  c = mix(c, c * uShadowTint, shadowW * uSplitStrength);
  c = mix(c, c * uHighlightTint, highW * uSplitStrength * 0.9);

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
        // Grade.saturation is the authored intent for a NEUTRALLY lit scene.
        // This one is lit by a magenta sky dome, which supplies most of the
        // chroma already, so the grade's job here is to restrain rather than
        // add. Measured (ImageMagick HSL mean, 320x180): reference 0.285,
        // this frame 0.43-0.65 at the old 0.72 multiplier.
        ['uSaturation', new Uniform(Grade.saturation * 0.52)],
        ['uChromaRolloff', new Uniform(0.55)],
        // Where the chroma rolloff starts biting. Too low and it eats the
        // warmth out of every lit facade — the thing the key light exists to
        // create — so it sits just above where a sunlit surface lands and only
        // catches the genuinely clipping highlights above it.
        ['uChromaKnee', new Uniform(0.34)],
        ['uContrast', new Uniform(Grade.contrast * 1.06)],
        // Deep blue-cyan, ~90 degrees of hue away from the amber highlight
        // tint below. The gap between these two IS the split.
        ['uShadowTint', new Uniform(new Vector3(0.66, 0.86, 1.30))],
        ['uHighlightTint', new Uniform(new Vector3(1.32, 0.97, 0.58))],
        ['uSplitStrength', new Uniform(0.66)],
        ['uToeColor', new Uniform(new Vector3(0.055, 0.062, 0.175))],
        ['uToeLift', new Uniform(0.06)],
        ['uSplitBalance', new Uniform(1.35)],
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
