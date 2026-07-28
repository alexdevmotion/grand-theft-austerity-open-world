/** WebGL2 renderer creation + quality tiers. */

import * as THREE from 'three';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  pixelRatioCap: number;
  shadowMapSize: number;
  /** Number of cascaded shadow splits. */
  shadowCascades: number;
  shadowDistance: number;
  ssao: boolean;
  ssaoHalfRes: boolean;
  bloom: boolean;
  screenSpaceReflections: boolean;
  motionBlur: boolean;
  depthOfField: boolean;
  volumetricLight: boolean;
  msaa: number;
  /** Draw distance for props/peds/vehicles. */
  entityDrawDistance: number;
  cityDrawDistance: number;
  maxPeds: number;
  maxTraffic: number;
  rainParticles: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  low: {
    pixelRatioCap: 1, shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 120,
    ssao: false, ssaoHalfRes: true, bloom: true, screenSpaceReflections: false,
    motionBlur: false, depthOfField: false, volumetricLight: false, msaa: 0,
    entityDrawDistance: 110, cityDrawDistance: 420, maxPeds: 24, maxTraffic: 16, rainParticles: 1500,
  },
  medium: {
    pixelRatioCap: 1.25, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 200,
    ssao: true, ssaoHalfRes: true, bloom: true, screenSpaceReflections: false,
    motionBlur: false, depthOfField: false, volumetricLight: true, msaa: 0,
    entityDrawDistance: 160, cityDrawDistance: 700, maxPeds: 48, maxTraffic: 32, rainParticles: 3500,
  },
  high: {
    pixelRatioCap: 1.5, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 300,
    ssao: true, ssaoHalfRes: false, bloom: true, screenSpaceReflections: true,
    motionBlur: true, depthOfField: true, volumetricLight: true, msaa: 0,
    entityDrawDistance: 240, cityDrawDistance: 1100, maxPeds: 80, maxTraffic: 52, rainParticles: 6000,
  },
  ultra: {
    pixelRatioCap: 2, shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 420,
    ssao: true, ssaoHalfRes: false, bloom: true, screenSpaceReflections: true,
    motionBlur: true, depthOfField: true, volumetricLight: true, msaa: 0,
    entityDrawDistance: 340, cityDrawDistance: 1600, maxPeds: 120, maxTraffic: 72, rainParticles: 9000,
  },
};

export function detectQuality(): Quality {
  const dpr = window.devicePixelRatio || 1;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (mem <= 4 || cores <= 4) return 'medium';
  if (cores >= 10 && mem >= 8) return dpr > 1.5 ? 'high' : 'ultra';
  return 'high';
}

export function createRenderer(canvas: HTMLCanvasElement, quality: Quality): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // handled by SMAA in the post chain
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true, // needed for screenshot capture in the critic harness
  });

  const q = QUALITY[quality];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
  renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false);

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping happens inside the post chain; keep the linear buffer intact.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  // The engine resets stats once per frame so they cover the whole post chain.
  renderer.info.autoReset = false;

  return renderer;
}
