/** Linear HDR exposure before AgX, followed by a restrained display grade.
 * ArtDirection owns the defaults. Debug shoulders remain available for
 * look development but do not compress the scene a second time by default.
 */

import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector3 } from 'three';
import { Grade } from '../artDirection';

const exposureFragment = /* glsl */ `
uniform float uExposure;
uniform float uHighlightRolloff;
uniform float uShoulderKnee;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0) * uExposure;

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

        ['uShoulderKnee', new Uniform(Grade.exposureKnee)],

        ['uHighlightRolloff', new Uniform(Grade.exposureRolloff)],
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

  set knee(v: number) {
    (this.uniforms.get('uShoulderKnee') as Uniform<number>).value = v;
  }
}

const fragment = /* glsl */ `
uniform vec3 uLift;
uniform vec3 uGain;
uniform vec3 uGamma;
uniform float uSaturation;
uniform float uContrast;
uniform float uPivot;
uniform float uShoulderKnee;
uniform float uShoulder;
uniform float uToeDepth;
uniform float uToeRange;
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

float grain(vec2 uv, float t) {
  vec3 p3 = fract(vec3(uv.xyx) * 443.8975 + t * 13.13);
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.x + p3.y) * p3.z) - 0.5;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);

  float l = luma(c);
  float shadowW = pow(1.0 - clamp(l * uSplitBalance, 0.0, 1.0), 2.0);
  float highW  = pow(clamp((l - 0.24) * 1.75, 0.0, 1.0), 1.15);
  c = mix(c, c * uShadowTint, shadowW * uSplitStrength);
  c = mix(c, c * uHighlightTint, highW * uSplitStrength);

  float lt = luma(c);
  c *= 1.0 - uToeDepth * (1.0 - smoothstep(0.0, uToeRange, lt));

  c = uPivot * pow(max(c, 0.0) / uPivot, vec3(uContrast));
  vec3 over = max(c - uShoulderKnee, 0.0);
  c = min(c, vec3(uShoulderKnee)) + over / (1.0 + over * uShoulder);

  c = c * uGain + uLift;
  c = pow(max(c, 0.0), 1.0 / uGamma);

  float g = luma(c);

  float rolloff = 1.0 - uChromaRolloff * smoothstep(uChromaKnee, 1.0, g);
  c = mix(vec3(g), c, uSaturation * rolloff);

  c = max(c, 0.0);
  c += uToeColor * uToeLift * (1.0 - smoothstep(0.0, 0.42, luma(c)));

  c = mix(c, uFlashColor, uFlash);

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

        ['uSaturation', new Uniform(Grade.saturation)],

        ['uChromaRolloff', new Uniform(Grade.chromaRolloff)],

        ['uChromaKnee', new Uniform(Grade.chromaKnee)],
        ['uContrast', new Uniform(Grade.contrast)],

        ['uPivot', new Uniform(Grade.contrastPivot)],

        ['uShoulderKnee', new Uniform(Grade.shoulderKnee)],
        ['uShoulder', new Uniform(Grade.shoulderStrength)],

        ['uToeDepth', new Uniform(Grade.toeDepth)],
        ['uToeRange', new Uniform(Grade.toeRange)],

        ['uShadowTint', new Uniform(new Vector3(...Grade.shadowRGB))],

        ['uHighlightTint', new Uniform(new Vector3(...Grade.highlightRGB))],
        ['uSplitStrength', new Uniform(Grade.splitStrength)],

        ['uToeColor', new Uniform(new Vector3(...Grade.toeRGB))],
        ['uToeLift', new Uniform(Grade.toeLift)],
        ['uSplitBalance', new Uniform(Grade.splitBalance)],

        ['uGrain', new Uniform(Grade.filmGrain)],
        ['uTime', new Uniform(0)],
        ['uFlash', new Uniform(0)],
        ['uFlashColor', new Uniform(new Vector3(1, 0.35, 0.75))],
      ]),
    });
  }

  setFlash(amount: number, r = 1, g = 0.35, b = 0.75): void {
    (this.uniforms.get('uFlash') as Uniform<number>).value = amount;
    (this.uniforms.get('uFlashColor') as Uniform<Vector3>).value.set(r, g, b);
  }

  setSaturation(v: number): void {
    (this.uniforms.get('uSaturation') as Uniform<number>).value = v;
  }

  setContrast(v: number, pivot?: number): void {
    (this.uniforms.get('uContrast') as Uniform<number>).value = v;
    if (pivot !== undefined) (this.uniforms.get('uPivot') as Uniform<number>).value = pivot;
  }

  setShoulder(knee: number, strength?: number): void {
    (this.uniforms.get('uShoulderKnee') as Uniform<number>).value = knee;
    if (strength !== undefined) (this.uniforms.get('uShoulder') as Uniform<number>).value = strength;
  }

  setToeDepth(depth: number, range?: number): void {
    (this.uniforms.get('uToeDepth') as Uniform<number>).value = depth;
    if (range !== undefined) (this.uniforms.get('uToeRange') as Uniform<number>).value = range;
  }

  setChromaRolloff(v: number, knee?: number): void {
    (this.uniforms.get('uChromaRolloff') as Uniform<number>).value = v;
    if (knee !== undefined) (this.uniforms.get('uChromaKnee') as Uniform<number>).value = knee;
  }

  setSplitTint(sr: number, sg: number, sb: number, hr: number, hg: number, hb: number): void {
    (this.uniforms.get('uShadowTint') as Uniform<Vector3>).value.set(sr, sg, sb);
    (this.uniforms.get('uHighlightTint') as Uniform<Vector3>).value.set(hr, hg, hb);
  }

  setSplitStrength(v: number): void {
    (this.uniforms.get('uSplitStrength') as Uniform<number>).value = v;
  }

  setGrain(v: number): void {
    (this.uniforms.get('uGrain') as Uniform<number>).value = v;
  }

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
