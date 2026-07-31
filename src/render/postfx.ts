/** Post-processing pipeline.
 *
 *  Chain (high/ultra):
 *    RenderPass
 *      → N8AO (SSAO, violet-tinted)
 *      → EffectPass[ WetReflection, Exposure ]
 *      → EffectPass[ Bloom, DoF, ChromaticAberration, ToneMapping, Grade, Vignette ]
 *      → EffectPass[ SMAA ]
 *
 *  The order matters:
 *   - AO runs on the raw HDR buffer, before anything brightens it.
 *   - The wet-street reflection needs scene colour AND depth, and must land
 *     before bloom so reflected lamps and windows bloom in the puddles too.
 *   - Exposure is its own pass so that bloom's luminance threshold sees
 *     correctly-exposed values rather than the raw, under-lit render.
 *   - Bloom before tone mapping so highlights bloom in linear space.
 *   - Grade after tone mapping so lift/gain behave like a real DI grade.
 *   - AA last.
 */

import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { GameContext, System } from '../core/engine';
import { Services, type RenderService } from '../core/services';
import { Atmosphere, Grade } from '../artDirection';
import { ExposureEffect, GradeEffect } from './gradeEffect';
import { QUALITY, applyQuality, type Quality } from './renderer';

/* ------------------------------------------------------------------ */
/* Calibration                                                         */
/*                                                                     */
/* artDirection authors the intent; these convert it into values that  */
/* suit the actual chain (AgX after a real exposure stage). They are   */
/* renderer setup, not look, so they live with the renderer.           */
/* ------------------------------------------------------------------ */

/*
 * The scene is lit in physical units; this puts mid-grey where AgX wants it.
 * Calibrated by sweeping against the reference frame's measured histogram
 * (p50 50, mean 66) across both a street-level and a skyline framing — a
 * single framing is not enough, because the two disagree by a stop.
 */
/*
 * RECALIBRATED when the exposure shoulder changed shape. The old
 * `c / (1 + c * 1.1)` divided EVERY value, not just highlights: a mid-tone at
 * 0.35 came out at 0.25, a 0.5 stop reduction applied across the whole frame,
 * and the 1.76 here existed to pay that back. The shoulder that replaced it
 * leaves everything below 0.72 untouched, so keeping 1.76 double-counted the
 * compensation and blew the frame out — measured p50 67 against the
 * reference's 50, with the entire city sitting in pale peach.
 */
const EXPOSURE = Grade.exposure * 1.38;
/*
 * Only genuinely hot things bloom — sun disc, horizon rip, cloud rims, window
 * emissives. A dusk city is full of moderately bright surfaces and a low
 * threshold turns the whole frame into haze, destroying the very contrast the
 * reference depends on.
 *
 * THIS NUMBER USED TO BE UNREACHABLE. At 0.92 it sat ABOVE the 0.909 hard
 * ceiling the old exposure rolloff imposed on every pixel in the game, so
 * nothing ever crossed it fully and the bloom pass contributed almost nothing.
 * Now that the exposure shoulder preserves real HDR headroom (ceiling ~21
 * linear, sun disc landing near 14), the threshold can sit meaningfully above
 * where lit architecture lands and BELOW where the sun and the rip land — so
 * the bloom keys off the sun, which is what it is for.
 */
const BLOOM_THRESHOLD = 1.05;
const BLOOM_INTENSITY = Grade.bloomIntensity * 1.95;

/* ------------------------------------------------------------------ */
/* Wet-street screen-space reflection                                  */
/* ------------------------------------------------------------------ */

const ssrFragment = /* glsl */ `
uniform mat4 uProjection;
uniform mat4 uInverseProjection;
uniform mat4 uCamWorld;
uniform mat4 uViewMatrix;
uniform mat4 uProjView;
uniform float uWetness;
uniform float uIntensity;
uniform float uGroundY;
uniform float uGroundBand;
uniform float uMaxDistance;
uniform float uThickness;
uniform float uPeak;

/** Interleaved-gradient noise — the cheap blue-noise stand-in. Its value
 *  decorrelates between neighbouring pixels, which is what turns a fixed tap
 *  pattern from a visible comb into film-like dither. */
float ssrDither(vec2 fragCoord) {
  return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
}

float ssrHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float ssrNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ssrHash(i), ssrHash(i + vec2(1, 0)), u.x),
             mix(ssrHash(i + vec2(0, 1)), ssrHash(i + vec2(1, 1)), u.x), u.y);
}

vec3 viewPositionFrom(const in vec2 uv, const in float d, const in float viewZ) {
  vec4 clip = vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
  float clipW = uProjection[2][3] * viewZ + uProjection[3][3];
  clip *= clipW;
  return (uInverseProjection * clip).xyz;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  outputColor = inputColor;
  if (uWetness < 0.01 || depth >= 1.0) return;

  float viewZ = getViewZ(depth);
  vec3 viewPos = viewPositionFrom(uv, depth, viewZ);
  vec3 worldPos = (uCamWorld * vec4(viewPos, 1.0)).xyz;

  // Only near-horizontal ground participates. Everything else keeps its own
  // material reflection.
  float groundW = 1.0 - smoothstep(uGroundY + uGroundBand * 0.5, uGroundY + uGroundBand, worldPos.y);
  if (groundW < 0.02) return;

  vec3 camW = uCamWorld[3].xyz;
  vec3 V = normalize(worldPos - camW);

  // Streak axis: fast across the view direction, slow along it, so the mirror
  // breaks into long bands running toward the camera — the reference's smears.
  vec2 fwd = normalize(vec2(V.x, V.z) + 1e-5);
  vec2 side = vec2(-fwd.y, fwd.x);
  float across = dot(worldPos.xz, side);
  float along = dot(worldPos.xz, fwd);

  // Metres per pixel: fade octaves finer than the footprint, or the ripple
  // turns into crawling speckle in the distance.
  float pixW = max(fwidth(across), fwidth(along));
  float o1 = 1.0 - smoothstep(0.35, 1.1, 0.30 * pixW * 2.0);
  float o2 = 1.0 - smoothstep(0.35, 1.1, 0.95 * pixW * 2.0);
  float ripple = (ssrNoise(vec2(across * 0.30, along * 0.05)) - 0.5) * 0.72 * o1
               + (ssrNoise(vec2(across * 0.95, along * 0.13)) - 0.5) * 0.28 * o2;

  // WETNESS IS NOT UNIFORM. A post-rain street has a dry crown, dry strips
  // under overhangs and standing water in the gutters and the wheel ruts.
  // Driving the mirror off a global 0.85 made the whole ground plane one
  // flooded lake with no asphalt visible anywhere; a low-frequency mask keeps
  // roughly a third of the road dry, and gives the wet third something to be
  // wet NEXT TO, which is what reads as "wet" rather than as "water".
  float pool = ssrNoise(worldPos.xz * 0.085) * 0.62 + ssrNoise(worldPos.xz * 0.30 + 7.3) * 0.38;
  // Gutters: wetness rises away from the crown of the carriageway.
  float wetMask = smoothstep(0.34, 0.68, pool);
  if (wetMask < 0.02) return;
  // Standing water is flat; merely damp tarmac keeps its chop.
  float roughProxy = mix(0.34, 0.045, wetMask);

  vec3 N = normalize(vec3(side.x * ripple * 0.045, 1.0, side.y * ripple * 0.045));
  vec3 R = reflect(V, N);
  if (R.y <= 0.001) return;

  float fres = pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 4.0);

  // March in world space with growing steps: fine near the contact point where
  // reflections must stay attached, coarse far away.
  float stride = uMaxDistance / float(SSR_STEPS);
  vec3 p = worldPos + R * stride * 0.35;
  float hit = 0.0;
  vec2 hitUv = vec2(0.0);
  float travelled = 0.0;

  for (int i = 0; i < SSR_STEPS; i++) {
    float grow = 1.0 + float(i) * 0.22;
    p += R * stride * grow;
    travelled += stride * grow;

    vec4 clip = uProjView * vec4(p, 1.0);
    if (clip.w <= 0.0) break;
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;

    float sd = readDepth(suv);
    if (sd >= 1.0) continue;
    float sViewZ = getViewZ(sd);
    float pViewZ = (uViewMatrix * vec4(p, 1.0)).z;

    // Scene surface sits in front of the ray point: an intersection.
    float diff = sViewZ - pViewZ;
    if (diff > 0.0 && diff < uThickness * grow) {
      hit = 1.0;
      hitUv = suv;
      break;
    }
  }

  if (hit < 0.5) return;

  // Smear the hit vertically. Two things were wrong before:
  //   1. the blur radius was fixed in SCREEN space, so every pixel in a row
  //      sampled the same three offsets and the result combed into hard
  //      vertical columns — visible as banding across the whole lower half of
  //      any frame shot toward the sun;
  //   2. it did not scale with how far the reflected ray actually travelled,
  //      so a reflection 100m away was as sharp as one at the contact point.
  // Now the radius grows with ray distance AND with the surface's roughness
  // proxy, and every tap offset is dithered per pixel, which turns the comb
  // into grain the grain pass then hides.
  float rayT = clamp(travelled / uMaxDistance, 0.0, 1.0);
  float smear = (0.004 + 0.030 * rayT) * (0.35 + roughProxy * 3.2);
  float jitter = ssrDither(gl_FragCoord.xy) - 0.5;
  vec3 refl = texture2D(inputBuffer, hitUv).rgb * 0.34;
  refl += texture2D(inputBuffer, hitUv + vec2(0.0, smear * (1.0 + jitter * 0.8))).rgb * 0.22;
  refl += texture2D(inputBuffer, hitUv - vec2(0.0, smear * (1.0 - jitter * 0.8))).rgb * 0.22;
  refl += texture2D(inputBuffer, hitUv + vec2(0.0, smear * (2.1 + jitter))).rgb * 0.11;
  refl += texture2D(inputBuffer, hitUv - vec2(0.0, smear * (2.1 - jitter))).rgb * 0.11;

  // The sky toward the sun is HDR by design, and mirroring it unclamped drove
  // the road past 1.0 and clipped it to a white smear — measured max 1.02 on
  // the into-sun framing. Compress rather than clip, so the smear stays a
  // bright ORANGE streak instead of becoming a hole.
  float rl = max(max(refl.r, refl.g), refl.b);
  if (rl > uPeak) refl *= uPeak / rl * (1.0 + 0.35 * (1.0 - uPeak / rl));

  // Fades: screen edges, distance, grazing angle, wetness.
  vec2 edge = smoothstep(vec2(0.0), vec2(0.16), hitUv) *
              (1.0 - smoothstep(vec2(0.84), vec2(1.0), hitUv));
  float edgeFade = edge.x * edge.y;
  float distFade = 1.0 - smoothstep(0.55, 1.0, rayT);

  float k = uIntensity * uWetness * groundW * wetMask * edgeFade * distFade * mix(0.12, 1.0, fres);
  k = clamp(k, 0.0, 0.72);

  outputColor = vec4(mix(inputColor.rgb, refl, k), inputColor.a);
}
`;

export class WetReflectionEffect extends Effect {
  private camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera, steps = 20) {
    super('WetReflectionEffect', ssrFragment, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.DEPTH,
      defines: new Map<string, string>([['SSR_STEPS', String(steps)]]),
      uniforms: new Map<string, THREE.Uniform<unknown>>([
        ['uProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uInverseProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uViewMatrix', new THREE.Uniform(new THREE.Matrix4())],
        ['uProjView', new THREE.Uniform(new THREE.Matrix4())],
        ['uWetness', new THREE.Uniform(Atmosphere.wetness)],
        ['uIntensity', new THREE.Uniform(0.95)],
        ['uGroundY', new THREE.Uniform(0.0)],
        ['uGroundBand', new THREE.Uniform(1.1)],
        ['uMaxDistance', new THREE.Uniform(160)],
        ['uThickness', new THREE.Uniform(1.6)],
        // Linear ceiling on the mirrored radiance. The sun smear must peak
        // below 1.0 or it clips to white and loses the orange entirely.
        // Lowered when the sky gained real HDR: the dome's horizon rip is now
        // several times brighter than it was, and mirroring that at the old
        // ceiling turned every wet surface into a sheet of white.
        ['uPeak', new THREE.Uniform(0.72)],
      ]),
    });
    this.camera = camera;
  }

  setWetness(w: number): void {
    (this.uniforms.get('uWetness') as THREE.Uniform<number>).value = Math.max(0, Math.min(1, w));
  }

  setIntensity(v: number): void {
    (this.uniforms.get('uIntensity') as THREE.Uniform<number>).value = v;
  }

  private projView = new THREE.Matrix4();

  override update(): void {
    const c = this.camera;
    (this.uniforms.get('uProjection') as THREE.Uniform<THREE.Matrix4>).value.copy(c.projectionMatrix);
    (this.uniforms.get('uInverseProjection') as THREE.Uniform<THREE.Matrix4>).value.copy(c.projectionMatrixInverse);
    (this.uniforms.get('uCamWorld') as THREE.Uniform<THREE.Matrix4>).value.copy(c.matrixWorld);
    (this.uniforms.get('uViewMatrix') as THREE.Uniform<THREE.Matrix4>).value.copy(c.matrixWorldInverse);
    this.projView.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    (this.uniforms.get('uProjView') as THREE.Uniform<THREE.Matrix4>).value.copy(this.projView);
  }
}

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export class PostFXSystem implements System, RenderService {
  readonly name = 'postfx';
  readonly order = 900;

  private composer!: EffectComposer;
  private ctx!: GameContext;
  private _quality: Quality;
  private _fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;

  grade!: GradeEffect;
  exposure!: ExposureEffect;
  bloom!: BloomEffect;
  vignette!: VignetteEffect;
  ssr: WetReflectionEffect | null = null;
  private dof: DepthOfFieldEffect | null = null;
  private ao: N8AOPostPass | null = null;
  private flash = 0;

  postEnabled = true;

  constructor(quality: Quality) {
    this._quality = quality;
  }

  get quality(): Quality {
    return this._quality;
  }

  get fps(): number {
    return this._fps;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Render, this);
    this.build();

    window.addEventListener('gta:resize', () => {
      const c = ctx.canvas;
      const w = c.parentElement?.clientWidth ?? window.innerWidth;
      const h = c.parentElement?.clientHeight ?? window.innerHeight;
      this.composer.setSize(w, h);
    });

    ctx.engine.renderOverride = () => {
      if (this.postEnabled) this.composer.render(ctx.time.dt);
      else ctx.renderer.render(ctx.scene, ctx.camera);
    };

    this.installTuningHooks();
  }

  /**
   * Live grade/exposure knobs under `window.__GTA_POST__`. Separate from the
   * `__GTA_DEBUG__` automation contract on purpose — this is a look-dev aid,
   * not something the critic harness depends on.
   */
  private installTuningHooks(): void {
    (window as unknown as { __GTA_POST__: Record<string, unknown> }).__GTA_POST__ = {
      exposure: (v: number) => { this.exposure.exposure = v; },
      rolloff: (v: number) => { this.exposure.rolloff = v; },
      saturation: (v: number) => this.grade.setSaturation(v),
      chromaRolloff: (v: number) => this.grade.setChromaRolloff(v),
      split: (v: number) => this.grade.setSplitStrength(v),
      splitTint: (sr: number, sg: number, sb: number, hr: number, hg: number, hb: number) =>
        this.grade.setSplitTint(sr, sg, sb, hr, hg, hb),
      grain: (v: number) => this.grade.setGrain(v),
      contrast: (v: number, pivot?: number) => this.grade.setContrast(v, pivot),
      /** Highlight compression — the knob that tames the wet-road sky mirror. */
      shoulder: (knee: number, strength?: number) => this.grade.setShoulder(knee, strength),
      /** Shadow crush — how deep the blacks go and up to what luma. */
      toeDepth: (depth: number, range?: number) => this.grade.setToeDepth(depth, range),
      toe: (lift: number, r?: number, g?: number, b?: number) => this.grade.setToe(lift, r, g, b),
      vignette: (darkness: number) => { this.vignette.darkness = darkness; },
      bloom: (intensity: number, threshold?: number) => {
        this.bloom.intensity = intensity;
        if (threshold !== undefined) this.bloom.luminanceMaterial.threshold = threshold;
      },
      ssr: (intensity: number) => this.ssr?.setIntensity(intensity),
      /** Live AO configuration, for A/B-ing its cost against its contribution. */
      ao: (intensity?: number, radius?: number) => {
        if (!this.ao) return null;
        if (intensity !== undefined) this.ao.configuration.intensity = intensity;
        if (radius !== undefined) this.ao.configuration.aoRadius = radius;
        return this.ao.configuration;
      },
      /** Mean/percentile luminance of the presented frame, for calibration. */
      meter: () => this.meter(),
      /** Bypass the whole chain — isolates post cost from scene cost. */
      post: (on: boolean) => { this.postEnabled = on; },
      /** Live scene handle. Look-dev only; nothing ships against this. */
      scene: () => this.ctx.scene,
      /** The live pass list, so individual stages can be A/B-ed for cost. */
      passes: () => this.composer.passes,
      /**
       * Median GPU milliseconds per frame, measured with
       * EXT_disjoint_timer_query_webgl2. Wall-clock fps is capped by vsync, so
       * this is the only number with headroom information in it.
       *
       * CAVEAT, learned the hard way: a timer query measures the GPU, and the
       * GPU is shared. With a dozen other WebGL contexts alive on the same
       * machine this reported 155ms for a frame that times at 10ms when they
       * are closed — a 15x error, entirely outside the renderer. Always
       * re-measure on a quiet machine before drawing a conclusion from it, and
       * always compare against the `post(false)` scene-only floor rather than
       * against an absolute target.
       *
       * NOTE: this returns a Promise. `JSON.stringify(gpuMs())` yields `{}`,
       * which is what makes it look broken from an automation harness — await
       * it.
       */
      gpuMs: (samples = 40) => this.gpuMs(samples),
      /**
       * Times `frames` presented frames with the current settings. More
       * trustworthy than the smoothed fps counter when A/B-ing passes.
       */
      bench: (frames = 90) =>
        new Promise<number>((resolve) => {
          let n = 0;
          const t0 = performance.now();
          const tick = () => {
            if (++n >= frames) resolve(Math.round((n / ((performance.now() - t0) / 1000)) * 10) / 10);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    };
  }

  /**
   * Wraps whole frames in GPU timer queries and returns the median duration.
   * Queries are resolved asynchronously, so this never stalls the pipeline the
   * way a `finish()`-based timer would.
   */
  private gpuMs(samples: number): Promise<{ median: number; min: number; max: number; n: number }> {
    const gl = this.ctx.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if (!ext) return Promise.resolve({ median: -1, min: -1, max: -1, n: 0 });

    const results: number[] = [];
    const pending: WebGLQuery[] = [];
    const prev = this.ctx.engine.renderOverride;

    return new Promise((resolve) => {
      let taken = 0;
      this.ctx.engine.renderOverride = () => {
        // Only one timer query may be active at a time.
        const q = taken < samples ? gl.createQuery() : null;
        if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
        if (this.postEnabled) this.composer.render(this.ctx.time.dt);
        else this.ctx.renderer.render(this.ctx.scene, this.ctx.camera);
        if (q) {
          gl.endQuery(ext.TIME_ELAPSED_EXT);
          pending.push(q);
          taken++;
        }

        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i];
          if (!gl.getQueryParameter(p, gl.QUERY_RESULT_AVAILABLE)) continue;
          if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
            results.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6);
          }
          gl.deleteQuery(p);
          pending.splice(i, 1);
        }

        if (taken >= samples && pending.length === 0) {
          this.ctx.engine.renderOverride = prev;
          results.sort((a, b) => a - b);
          const r = (v: number) => Math.round(v * 100) / 100;
          resolve(
            results.length
              ? { median: r(results[results.length >> 1]), min: r(results[0]), max: r(results[results.length - 1]), n: results.length }
              : { median: -1, min: -1, max: -1, n: 0 },
          );
        }
      };
    });
  }

  /** Reads back the canvas and reports the tonal distribution of the frame. */
  private meter(): Record<string, number> {
    const src = this.ctx.canvas;
    const t = document.createElement('canvas');
    t.width = 240;
    t.height = 135;
    const g2 = t.getContext('2d');
    if (!g2) return {};
    g2.drawImage(src, 0, 0, t.width, t.height);
    const d = g2.getImageData(0, 0, t.width, t.height).data;
    const lum: number[] = [];
    let sat = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const gg = d[i + 1];
      const b = d[i + 2];
      lum.push(0.2126 * r + 0.7152 * gg + 0.0722 * b);
      const mx = Math.max(r, gg, b);
      const mn = Math.min(r, gg, b);
      sat += mx === 0 ? 0 : (mx - mn) / mx;
    }
    lum.sort((a, b) => a - b);
    const at = (p: number) => Math.round(lum[Math.floor((lum.length - 1) * p)]);
    return {
      p01: at(0.01), p05: at(0.05), p25: at(0.25), p50: at(0.5),
      p75: at(0.75), p95: at(0.95), p99: at(0.99),
      mean: Math.round(lum.reduce((a, b) => a + b, 0) / lum.length),
      saturation: Math.round((sat / (d.length / 4)) * 100) / 100,
    };
  }

  private build(): void {
    const { scene, camera, renderer } = this.ctx;
    const q = QUALITY[this._quality];

    this.composer?.dispose();
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: q.msaa,
    });

    this.composer.addPass(new RenderPass(scene, camera));

    if (q.ssao) {
      const ao = new N8AOPostPass(scene, camera);
      // A tighter radius is both cheaper (far better depth-buffer cache
      // locality) and more correct here: this AO exists to seat kerbs, window
      // reveals and street furniture into their surroundings, not to darken
      // whole building faces, which is the low sun's job.
      ao.configuration.aoRadius = 1.4;
      ao.configuration.distanceFalloff = 1.2;
      ao.configuration.intensity = 2.6;
      /*
       * Half res with depth-aware upsampling, unconditionally.
       *
       * MEASUREMENT NOTE. The old note here recorded this same pass at 78ms
       * on a contended machine and 0.4ms on a quiet one and concluded "the
       * 78ms was contention, not this pass". The first half is right and the
       * conclusion is too generous: neither absolute number is usable, because
       * BOTH were taken by timing one config for a while and another config
       * later, and this GPU's contention drifts by more than the effect being
       * measured. Re-measured with a frame-INTERLEAVED paired A/B — configs
       * alternate every single frame, so both arms see identical contention
       * and the per-cycle paired difference cancels the drift:
       *
       *   SSAO, paired median vs the same frame with the pass disabled
       *     hero framing   -2.95, -4.59, -2.81 ms   (frame total 8.4-15.6 ms)
       *     street framing -4.03, -3.01, -4.37 ms   (frame total 8.9-17.5 ms)
       *
       * Expressed as a FRACTION of the frame — the only contention-invariant
       * form — this pass is a stable 25-40% of GPU frame time across a 2.2x
       * swing in machine load, which makes it the single most expensive thing
       * in the renderer. It is not 0.4ms and it never was.
       *
       * It stays at half res: it is visually indistinguishable at this radius
       * and tint, and it is already the largest line item in the budget.
       */
      ao.configuration.halfRes = true;
      ao.configuration.depthAwareUpsampling = true;
      ao.configuration.denoiseSamples = 4;
      ao.configuration.denoiseRadius = 8;
      // AO tinted violet rather than black — matches the reference's shadows.
      ao.configuration.color = new THREE.Color(0x2f2150);
      ao.setQualityMode('Performance');
      this.composer.addPass(ao);
      this.ao = ao;
    }

    /* --- reflections + exposure, before bloom sees the frame --- */
    this.exposure = new ExposureEffect(EXPOSURE);
    const preBloom: Effect[] = [];

    if (q.screenSpaceReflections) {
      /*
       * 12 steps on BOTH high and ultra. `high` used to get 8 on the theory
       * that each step is a dependent depth fetch and therefore expensive.
       *
       * MEASURED, and the theory was wrong. Timed with a frame-INTERLEAVED
       * paired GPU A/B (alternating configs every frame so contention drift
       * cancels), toggling `uWetness` to 0 so the shader's top-of-function
       * early-out skips the entire march while the pass itself stays in the
       * chain. At the street framing — camera at 1.75m, wet road filling the
       * lower half, ~1020 draw calls, live wetness 0.85 — the whole march
       * costs a paired median of -0.06, +0.24 and -0.15 ms across three runs.
       * That is zero to within the noise, against an SSAO pass measuring
       * -3.0 to -4.4 ms in the very same runs.
       *
       * Reach and precision both improve with step count here, because stride
       * is `uMaxDistance / SSR_STEPS` and grows 22% per step: total reach is
       * `uMaxDistance * (1 + 0.11 * (N - 1))`, so N=12 marches ~2.21x
       * uMaxDistance where N=8 reached ~1.77x, with finer sampling near the
       * contact point as well. Longer, better-resolved streaks are exactly
       * what the reference frame's wet street is built on.
       */
      this.ssr = new WetReflectionEffect(camera, 12);
      this.ssr.setIntensity(this._quality === 'ultra' ? 0.85 : 0.7);
      preBloom.push(this.ssr);
    } else {
      this.ssr = null;
    }
    preBloom.push(this.exposure);
    this.composer.addPass(new EffectPass(camera, ...preBloom));

    /* --- main look pass --- */
    const effects: Effect[] = [];

    // `q.bloom` used to be declared by every tier and read by none — the pass
    // was built unconditionally. It is now honoured, which is what makes the
    // low tier actually cheaper than the medium one.
    this.bloom = new BloomEffect({
      intensity: q.bloom ? BLOOM_INTENSITY : 0,
      luminanceThreshold: BLOOM_THRESHOLD,
      luminanceSmoothing: Grade.bloomSmoothing,
      radius: 0.86,
      mipmapBlur: true,
      kernelSize: q.bloom ? KernelSize.LARGE : KernelSize.SMALL,
    });
    if (q.bloom) effects.push(this.bloom);

    /*
     * DEPTH OF FIELD IS OFF, and the reason is the look, not the cost.
     *
     * The reference's far boulevard is softened by ATMOSPHERE — it goes hazy
     * and warm, not blurred — and SkySystem's aerial perspective already does
     * exactly that. What DoF added on top was a near-field blur that ate the
     * kerb, the litter and the wet paving joints in the bottom third of the
     * frame, which is precisely where the reference puts its detail.
     * `setFocusDistance` stays wired so cutscenes can still rack focus.
     */
    this.dof = null;

    effects.push(
      new ChromaticAberrationEffect({
        offset: new THREE.Vector2(Grade.chromaticAberration, Grade.chromaticAberration * 0.6),
        radialModulation: true,
        modulationOffset: 0.42,
      }),
    );

    effects.push(
      new ToneMappingEffect({
        mode: ToneMappingMode.AGX,
        resolution: 256,
      }),
    );

    this.grade = new GradeEffect();
    effects.push(this.grade);

    // The authored darkness is tuned for a bright frame; over a dusk street it
    // swallowed the corners entirely, which is where the reference keeps its
    // wet-kerb reflections and its foreground litter.
    this.vignette = new VignetteEffect({
      darkness: Grade.vignetteDarkness * 0.62,
      offset: Grade.vignetteOffset + 0.12,
    });
    effects.push(this.vignette);

    this.composer.addPass(new EffectPass(camera, ...effects));

    const smaa = new SMAAEffect({
      preset: this._quality === 'low' ? SMAAPreset.LOW : SMAAPreset.HIGH,
    });
    this.composer.addPass(new EffectPass(camera, smaa));

    const w = this.ctx.canvas.parentElement?.clientWidth ?? window.innerWidth;
    const h = this.ctx.canvas.parentElement?.clientHeight ?? window.innerHeight;
    this.composer.setSize(w, h);
  }

  /**
   * Change the quality tier — for real, everywhere.
   *
   * This used to rebuild the post chain and the pixel ratio and stop there,
   * while the city's draw distance, the prop cut-offs, the ped and traffic
   * budgets and the whole shadow configuration stayed at whatever
   * `detectQuality()` returned during init in six unrelated files. Dropping
   * from ultra to low changed the post chain and left 120 pedestrians, 72
   * cars, a 1.6 km draw distance and 4096-pixel cascades running. `applyQuality`
   * is the other half: every system that reads a `QualitySettings` field
   * registers with `onQualityChange` and is re-applied here.
   */
  setQuality(q: Quality): void {
    if (q === this._quality) return;
    this._quality = q;
    const s = QUALITY[q];
    this.ctx.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.pixelRatioCap));
    this.build();
    const applied = applyQuality(q);
    console.info(`[quality] ${q}: post chain rebuilt, ${applied} systems re-applied`);
  }

  /** Screen flash — broadcast hijack, damage, sirens. */
  triggerFlash(amount: number, color: [number, number, number] = [1, 0.35, 0.75]): void {
    this.flash = Math.max(this.flash, amount);
    this.grade.setFlash(this.flash, ...color);
  }

  /** Focus DoF on a world-space distance (metres). */
  setFocusDistance(metres: number): void {
    if (!this.dof) return;
    this.dof.circleOfConfusionMaterial.focusDistance = metres;
  }

  /** Exposure in stops-ish multiplier; 1 is the calibrated default. */
  setExposureScale(scale: number): void {
    this.exposure.exposure = EXPOSURE * scale;
  }

  update(dt: number, ctx: GameContext): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this._fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 2.2);
      this.grade.setFlash(this.flash);
    }
    if (this.ssr) {
      this.ssr.setWetness(ctx.tryGet(Services.Weather)?.wetness ?? Atmosphere.wetness);
    }
  }

  dispose(): void {
    this.composer?.dispose();
  }
}
