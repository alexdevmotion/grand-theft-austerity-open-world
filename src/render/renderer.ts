/** WebGL2 renderer creation + quality tiers. */

import * as THREE from 'three';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

/**
 * WHAT A QUALITY TIER IS ALLOWED TO SAY.
 *
 * EVERY FIELD HERE MUST HAVE AT LEAST ONE CONSUMER — `quality.test.ts` scans
 * the source tree and fails if one does not. A tier field with no reader is a
 * placebo: the menu shows the player a switch, the switch writes a number, and
 * nothing anywhere reads it.
 *
 * Five fields were exactly that and have been removed rather than left to
 * mislead. Where the effect they named actually lives, and why it is not
 * tier-switched:
 *
 *   motionBlur      never implemented. There is no motion-blur pass in
 *                   `postfx.ts` and nothing computes velocity.
 *   depthOfField    deliberately disabled — `PostFXSystem.build` sets
 *                   `this.dof = null` and records why (the near-field blur ate
 *                   the kerb, litter and wet paving joints that the reference
 *                   frame is built on). `setFocusDistance` stays wired for
 *                   cutscenes. It is a look decision, not a budget decision,
 *                   so it does not belong on a quality tier.
 *   ssaoHalfRes     the AO pass is half-res UNCONDITIONALLY, by measurement —
 *                   see the paired A/B note in `postfx.ts`. The tier table
 *                   claimed full res on high and ultra, which was never true.
 *   volumetricLight god rays live in `src/render/sky/godRays.ts` and are
 *                   driven by sun elevation, not by tier.
 *   rainParticles   the rain budget belongs to `src/world/weather.ts`, which
 *                   derives intensity from the preset and has never read this.
 *
 * If you implement one of those, add the field back AND its consumer in the
 * same change; the test will not let you add it back alone.
 */
export interface QualitySettings {
  pixelRatioCap: number;
  shadowMapSize: number;
  /** Number of cascaded shadow splits. */
  shadowCascades: number;
  shadowDistance: number;
  ssao: boolean;
  bloom: boolean;
  screenSpaceReflections: boolean;
  msaa: number;
  /** Draw distance for props/peds/vehicles. */
  entityDrawDistance: number;
  cityDrawDistance: number;
  maxPeds: number;
  maxTraffic: number;
}

export const QUALITY: Record<Quality, QualitySettings> = {
  low: {
    pixelRatioCap: 1, shadowMapSize: 1024, shadowCascades: 2, shadowDistance: 120,
    ssao: false, bloom: false, screenSpaceReflections: false, msaa: 0,
    entityDrawDistance: 110, cityDrawDistance: 420, maxPeds: 24, maxTraffic: 16,
  },
  medium: {
    pixelRatioCap: 1.25, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 200,
    ssao: true, bloom: true, screenSpaceReflections: false, msaa: 0,
    entityDrawDistance: 160, cityDrawDistance: 700, maxPeds: 48, maxTraffic: 32,
  },
  high: {
    pixelRatioCap: 1.5, shadowMapSize: 2048, shadowCascades: 3, shadowDistance: 300,
    ssao: true, bloom: true, screenSpaceReflections: true, msaa: 0,
    entityDrawDistance: 240, cityDrawDistance: 1100, maxPeds: 80, maxTraffic: 52,
  },
  ultra: {
    pixelRatioCap: 2, shadowMapSize: 4096, shadowCascades: 4, shadowDistance: 420,
    ssao: true, bloom: true, screenSpaceReflections: true, msaa: 0,
    entityDrawDistance: 340, cityDrawDistance: 1600, maxPeds: 120, maxTraffic: 72,
  },
};

/* ------------------------------------------------------------------ */
/* Live quality changes                                                */
/* ------------------------------------------------------------------ */

/**
 * THE QUALITY MENU USED TO BE HALF A PLACEBO.
 *
 * `RenderService.setQuality` rebuilt the post chain and the pixel ratio, and
 * that was all. City draw distance, prop cut-offs, the ped and traffic budgets
 * and the whole shadow configuration were each snapshotted ONCE at init by an
 * independent `detectQuality()` call in six different files, so switching from
 * ultra to low left 120 pedestrians, 72 cars, a 1.6 km city draw distance and
 * 4096-pixel shadow cascades exactly where they were. The player saw the menu
 * move and the frame rate not.
 *
 * A system that reads a quality field now REGISTERS here instead, and gets
 * called again whenever the tier changes. `applyQuality` is invoked by
 * `PostFXSystem.setQuality`, which is the one place a tier change happens.
 *
 * Registration is by name so a system that re-inits (hot reload, a second
 * world) replaces its own entry instead of accumulating stale closures over
 * disposed objects.
 */
export type QualityApply = (quality: Quality, settings: QualitySettings) => void;

const qualityConsumers = new Map<string, { fields: readonly (keyof QualitySettings)[]; apply: QualityApply }>();

/**
 * Declare that `name` reads `fields` and can re-apply them at any time.
 * Returns an unsubscribe function for systems that are disposed.
 */
export function onQualityChange(
  name: string,
  fields: readonly (keyof QualitySettings)[],
  apply: QualityApply,
): () => void {
  qualityConsumers.set(name, { fields, apply });
  return () => { qualityConsumers.delete(name); };
}

/** Re-apply a tier to every registered consumer. Returns how many ran. */
export function applyQuality(quality: Quality): number {
  const settings = QUALITY[quality];
  let n = 0;
  for (const [name, c] of qualityConsumers) {
    try {
      c.apply(quality, settings);
      n++;
    } catch (err) {
      console.error(`[quality] consumer "${name}" threw while re-applying ${quality}`, err);
    }
  }
  return n;
}

/** Which registered systems read each field. Used by the coverage test. */
export function qualityConsumerNames(): Map<keyof QualitySettings, string[]> {
  const out = new Map<keyof QualitySettings, string[]>();
  for (const [name, c] of qualityConsumers) {
    for (const f of c.fields) {
      const list = out.get(f) ?? [];
      list.push(name);
      out.set(f, list);
    }
  }
  return out;
}

/** Test seam: forget every registration. */
export function resetQualityConsumers(): void {
  qualityConsumers.clear();
}

export function detectQuality(): Quality {
  const dpr = window.devicePixelRatio || 1;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  if (mem <= 4 || cores <= 4) return 'medium';
  if (cores >= 10 && mem >= 8) return dpr > 1.5 ? 'high' : 'ultra';
  return 'high';
}

/**
 * Should the backbuffer survive the swap?
 *
 * `preserveDrawingBuffer` forces the driver to keep the colour buffer valid
 * after present, which costs an extra full-surface copy every frame and
 * defeats the swap-chain fast path. It was unconditional here, with a comment
 * claiming the critic harness needed it — **that comment was wrong**.
 * `tools/shot.mjs` screenshots through CDP `Page.captureScreenshot`, which
 * captures the compositor surface and never touches the WebGL backbuffer.
 *
 * The one thing that genuinely needs it is `__GTA_POST__.meter()`, which does
 * a synchronous `drawImage(canvas, …)` from an `eval` — i.e. from OUTSIDE the
 * frame, long after the buffer would otherwise have been invalidated.
 *
 * So it is now on exactly where it is needed and off where it costs:
 *   - `?capture=1` forces it on, `?capture=0` forces it off (that override is
 *     what lets it be A/B-benchmarked at all);
 *   - otherwise it follows `navigator.webdriver`, which every automated
 *     browser sets and no real player does. `src/ui/menu/frontEnd.ts` already
 *     uses that same signal, so this adds no new concept.
 *
 * Net effect: agents and critics keep `meter()` working unchanged, and
 * shipping players stop paying for a readback nobody performs.
 */
export function wantsPreservedDrawingBuffer(
  search: string,
  webdriver: boolean,
): boolean {
  const explicit = new URLSearchParams(search).get('capture');
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return webdriver;
}

export function createRenderer(canvas: HTMLCanvasElement, quality: Quality): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // handled by SMAA in the post chain
    alpha: false,
    stencil: false,
    depth: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: wantsPreservedDrawingBuffer(
      typeof location === 'undefined' ? '' : location.search,
      typeof navigator !== 'undefined' && navigator.webdriver === true,
    ),
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
