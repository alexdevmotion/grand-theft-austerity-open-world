/** Post-processing pipeline.
 *
 *  Chain (high/ultra):
 *    RenderPass → N8AO (SSAO) → EffectPass[ Bloom, DoF, ChromaticAberration,
 *    Vignette, ToneMapping, Grade ] → SMAA
 *
 *  The order matters: AO must run on the raw HDR buffer, bloom before tone
 *  mapping so highlights bloom in linear space, grade after tone mapping so
 *  the lift/gain values behave like a real DI grade, AA last.
 */

import * as THREE from 'three';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  DepthOfFieldEffect,
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
import { Grade } from '../artDirection';
import { GradeEffect } from './gradeEffect';
import { QUALITY, type Quality } from './renderer';

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
  bloom!: BloomEffect;
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
      ao.configuration.aoRadius = 2.2;
      ao.configuration.distanceFalloff = 1.4;
      ao.configuration.intensity = 3.1;
      ao.configuration.halfRes = q.ssaoHalfRes;
      // AO tinted violet rather than black — matches the reference's shadows.
      ao.configuration.color = new THREE.Color(0x2a1d47);
      ao.setQualityMode(this._quality === 'ultra' ? 'High' : 'Medium');
      this.composer.addPass(ao);
      this.ao = ao;
    }

    const effects: Array<BloomEffect | DepthOfFieldEffect | ChromaticAberrationEffect | VignetteEffect | ToneMappingEffect | GradeEffect> = [];

    this.bloom = new BloomEffect({
      intensity: Grade.bloomIntensity,
      luminanceThreshold: Grade.bloomThreshold,
      luminanceSmoothing: Grade.bloomSmoothing,
      radius: Grade.bloomRadius,
      mipmapBlur: true,
      kernelSize: KernelSize.LARGE,
    });
    effects.push(this.bloom);

    if (q.depthOfField) {
      this.dof = new DepthOfFieldEffect(camera, {
        focusDistance: 0.02,
        focalLength: 0.035,
        bokehScale: 2.4,
        height: 480,
      });
      effects.push(this.dof);
    }

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

    effects.push(
      new VignetteEffect({
        darkness: Grade.vignetteDarkness,
        offset: Grade.vignetteOffset,
      }),
    );

    this.composer.addPass(new EffectPass(camera, ...effects));

    const smaa = new SMAAEffect({
      preset: this._quality === 'low' ? SMAAPreset.LOW : SMAAPreset.HIGH,
    });
    this.composer.addPass(new EffectPass(camera, smaa));

    const w = this.ctx.canvas.parentElement?.clientWidth ?? window.innerWidth;
    const h = this.ctx.canvas.parentElement?.clientHeight ?? window.innerHeight;
    this.composer.setSize(w, h);
  }

  setQuality(q: Quality): void {
    if (q === this._quality) return;
    this._quality = q;
    const s = QUALITY[q];
    this.ctx.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, s.pixelRatioCap));
    this.build();
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

  update(dt: number): void {
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
  }

  dispose(): void {
    this.composer?.dispose();
  }
}
