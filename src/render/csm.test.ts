import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { CascadedShadows } from './csm';

function make(cascades: number) {
  return new CascadedShadows({
    camera: new THREE.PerspectiveCamera(58, 1, .15, 3000), parent: new THREE.Scene(),
    cascades, shadowMapSize: 256, maxFar: 200, lightDirection: new THREE.Vector3(1, -1, 0),
    lightColor: new THREE.Color('white'), lightIntensity: 1,
  });
}

describe('shadow quality rebuilds', () => {
  test('cached shader uniforms follow a replacement rig without recompilation', () => {
    const material = new THREE.MeshStandardMaterial();
    const low = make(2);
    low.setupMaterial(material);
    const cached = { uniforms: {} } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(cached, {} as THREE.WebGLRenderer);
    low.dispose();
    const high = make(3);
    high.setupMaterial(material);
    // Returning to a previously used GPU program does not call the compile hook.
    expect(cached.uniforms.CSM_cascades.value).toHaveLength(3);
    high.dispose();
  });
  test('restores authored hooks even for a material never compiled', () => {
    const material = new THREE.MeshStandardMaterial();
    const authored = material.onBeforeCompile;
    const csm = make(3);
    csm.setupMaterial(material);
    expect(material.onBeforeCompile).not.toBe(authored);
    csm.dispose();
    expect(material.onBeforeCompile).toBe(authored);
    expect(material.defines?.CSM_CASCADES).toBeUndefined();
  });

  test('repeated tier changes invoke the author once and upload the active split count', () => {
    const material = new THREE.MeshStandardMaterial();
    let calls = 0;
    material.onBeforeCompile = () => { calls++; };
    const authored = material.onBeforeCompile;
    for (const count of [3, 3, 2, 3, 4, 2, 3]) {
      const csm = make(count);
      csm.setupMaterial(material);
      const shader = { uniforms: {} } as THREE.WebGLProgramParametersWithUniforms;
      const before = calls;
      material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
      expect(calls - before).toBe(1);
      expect(shader.uniforms.CSM_cascades.value).toHaveLength(count);
      expect(shader.uniforms.CSM_cascades.value.every((v: THREE.Vector2) => Number.isFinite(v.x + v.y))).toBe(true);
      csm.dispose();
      expect(material.onBeforeCompile).toBe(authored);
    }
  });
});
