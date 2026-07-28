declare module 'n8ao' {
  import type { Camera, Color, Scene, WebGLRenderer, WebGLRenderTarget } from 'three';
  import { Pass } from 'postprocessing';

  export interface N8AOConfiguration {
    aoRadius: number;
    distanceFalloff: number;
    intensity: number;
    aoSamples: number;
    denoiseSamples: number;
    denoiseRadius: number;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    screenSpaceRadius: boolean;
    renderMode: number;
    color: Color;
    gammaCorrection: boolean;
    logarithmicDepthBuffer: boolean;
    gpuNormals: boolean;
    gpuDenoise: boolean;
    transparencyAware: boolean;
    aoTones: number;
    accumulate: boolean;
    biasOffset: number;
    biasMultiplier: number;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
    setSize(width: number, height: number): void;
    render(
      renderer: WebGLRenderer,
      inputBuffer: WebGLRenderTarget,
      outputBuffer: WebGLRenderTarget,
      deltaTime?: number,
      stencilTest?: boolean,
    ): void;
    dispose(): void;
  }

  export class N8AOPass extends N8AOPostPass {}
}
