/** Cinematic colour grade: ASC-CDL style lift/gamma/gain, saturation,
 *  contrast, filmic shoulder, plus a subtle violet-shadow / orange-highlight
 *  split-tone that is the signature of the reference frame. */

import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector3 } from 'three';
import { Grade } from '../artDirection';

const fragment = /* glsl */ `
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uGamma;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
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

  // Split tone: push shadows violet, highlights warm.
  float l = luma(c);
  float shadowW = pow(1.0 - clamp(l * uSplitBalance, 0.0, 1.0), 2.0);
  float highW  = pow(clamp((l - 0.35) * 1.5, 0.0, 1.0), 1.4);
  c = mix(c, c * uShadowTint, shadowW * 0.55);
  c = mix(c, c * uHighlightTint, highW * 0.42);

  // ASC CDL: (in * gain + lift) ^ gamma
  c = c * uGain + uLift;
  c = pow(max(c, 0.0), 1.0 / uGamma);

  // Contrast about mid-grey.
  c = (c - 0.18) * uContrast + 0.18;

  // Saturation.
  float g = luma(c);
  c = mix(vec3(g), c, uSaturation);

  // Broadcast-hijack / damage flash.
  c = mix(c, uFlashColor, uFlash);

  // Grain, stronger in the shadows the way real sensors behave.
  float gr = grain(uv, uTime);
  c += gr * uGrain * (1.0 - smoothstep(0.0, 0.75, g));

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
        ['uSaturation', new Uniform(Grade.saturation)],
        ['uContrast', new Uniform(Grade.contrast)],
        ['uShadowTint', new Uniform(new Vector3(0.78, 0.72, 1.16))],
        ['uHighlightTint', new Uniform(new Vector3(1.12, 0.98, 0.86))],
        ['uSplitBalance', new Uniform(1.35)],
        ['uGrain', new Uniform(Grade.filmGrain)],
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

  override update(): void {
    const u = this.uniforms.get('uTime') as Uniform<number>;
    u.value = (u.value + 0.016) % 1000;
  }
}
