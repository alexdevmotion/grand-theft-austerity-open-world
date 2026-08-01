/** Material-level regression checks for matte masonry and localized puddles. */

import { describe, expect, test } from 'bun:test';
import type * as THREE from 'three';
import { Materials, type WetOptions } from './materials';
import { createCityMaterials } from '../world/city/materials';

function wet(id: Parameters<typeof Materials.get>[0]): Required<WetOptions> {
  const opts = Materials.get(id).userData.gtaWetOpts as Required<WetOptions> | undefined;
  expect(opts).toBeDefined();
  if (!opts) throw new Error(`${id} did not retain its wet-surface parameters`);
  return opts;
}

describe('shared wet materials', () => {
  test('weathered concrete remains rough and carries only a subdued sheen', () => {
    const concrete = wet('kerbConcrete');
    expect(concrete.puddles).toBe(false);
    expect(concrete.amount).toBeLessThanOrEqual(0.5);
    expect(concrete.dampRoughness).toBeGreaterThanOrEqual(0.78);
    expect(concrete.mirror).toBeLessThanOrEqual(0.14);
    expect(concrete.filmNormalFlatten).toBeLessThanOrEqual(0.2);
  });

  test('asphalt and paving reserve their strongest reflection for puddles', () => {
    const asphalt = wet('asphaltWet');
    expect(asphalt.puddles).toBe(true);
    expect(asphalt.dampRoughness).toBeGreaterThanOrEqual(0.46);
    expect(asphalt.puddleRoughness).toBeLessThanOrEqual(0.08);
    expect(asphalt.filmMirror).toBeLessThanOrEqual(0.25);
    expect(asphalt.mirror).toBeGreaterThan(0.7);

    const paving = wet('pavingStone');
    expect(paving.dampRoughness).toBeGreaterThanOrEqual(0.66);
    expect(paving.puddleRoughness).toBeLessThanOrEqual(0.12);
    expect(paving.filmMirror).toBeLessThanOrEqual(0.18);
  });

  test('tiled clones keep the full material-specific wet response', () => {
    const base = wet('kerbConcrete');
    const tiled = Materials.tiledFor('kerbConcrete', 24, 4);
    expect(tiled.userData.gtaWetOpts).toEqual(base);
    expect(tiled.customProgramCacheKey()).toBe(Materials.get('kerbConcrete').customProgramCacheKey());
  });
});

describe('the procedural city surface shader', () => {
  test('uses separate damp roughness and film mirror values per surface kind', () => {
    const g = globalThis as unknown as { window?: unknown };
    if (!g.window) g.window = globalThis;
    const city = createCityMaterials();
    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\n#include <fog_vertex>',
      fragmentShader: [
        '#include <common>',
        '#include <map_fragment>',
        '#include <roughnessmap_fragment>',
        '#include <metalnessmap_fragment>',
        '#include <emissivemap_fragment>',
        '#include <normal_fragment_maps>',
        '#include <lights_fragment_maps>',
        '#include <lights_fragment_end>',
      ].join('\n'),
    };
    city.surface.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );

    expect(shader.fragmentShader).toContain('float dampRough = 0.36;');
    expect(shader.fragmentShader).toContain('dampRough = 0.78;');
    expect(shader.fragmentShader).toContain('filmMirror = 0.12;');
    expect(shader.fragmentShader).toContain('dampRough = 0.82;');
    expect(shader.fragmentShader).toContain('filmMirror = 0.08;');
    expect(shader.fragmentShader).toContain('mix(dampRough, 0.10, standing)');
    expect(shader.fragmentShader).toContain('mix(filmMirror, 1.0, standing)');

    city.facade.dispose();
    city.surface.dispose();
    city.detail.dispose();
  });
});
