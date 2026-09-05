import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { CAST } from './heroHead';
import { applyBlenderSculpt, blinkWeight } from './blenderSculpt';
import { buildHeadGeometry } from './headMesh';
import { eyeLayerGeometries } from './eyes';
import { bodyMetrics } from '../rig';
import { BEARD_TOP } from '../hair/styles';
import type { CastId } from './fitData';

for (const id of ['player', 'nicusor', 'ally'] as CastId[]) {
  for (const detail of [1, 0.8]) {
    test(`${id}/${detail}: Blender sculpt preserves visible pupils and blink closes them`, () => {
      const cfg = CAST[id];
      const m = bodyMetrics('average', false);
      const { geometry, anchors } = buildHeadGeometry({
        cloud: cfg.cloud(), chinY: m.headY - 0.01, crownY: m.headTopY,
        skin: cfg.skin, beard: cfg.beardShade, beardColor: cfg.beardColor,
        hairColor: cfg.hairColor, tired: cfg.tired, age: cfg.age,
        jawPush: cfg.jawPush, browPush: cfg.browPush,
        hairline: cfg.hair.hairline, beardLine: BEARD_TOP,
        cols: Math.round(108 * detail), rows: Math.round(84 * detail), seed: 0,
      });
      const original = geometry.attributes.position.array.slice();
      expect(applyBlenderSculpt(geometry, id, detail, anchors.frame)).toBe(true);
      const position = geometry.attributes.position as THREE.BufferAttribute;
      const blink = geometry.morphAttributes.position[0];
      let maxMove = 0;
      for (let i = 0; i < position.count; i++) {
        maxMove = Math.max(maxMove, Math.hypot(...[0, 1, 2].map(c => position.array[i * 3 + c] - original[i * 3 + c])));
      }
      expect(maxMove).toBeGreaterThan(0.00001);
      expect(maxMove).toBeLessThan(0.002);
      const material = new THREE.MeshBasicMaterial();
      const skin = new THREE.Mesh(geometry, material);
      skin.updateMatrixWorld(true);
      for (const eye of [anchors.eyeL, anchors.eyeR]) {
        const layers = eyeLayerGeometries(eye, 0);
        const globe = new THREE.Mesh(layers.globe, material);
        globe.updateMatrixWorld(true);
        const origin = eye.centre.clone().add(new THREE.Vector3(0, 0, 0.10));
        const ray = new THREE.Raycaster(origin, new THREE.Vector3(0, 0, -1));
        skin.morphTargetInfluences![0] = 0;
        expect(ray.intersectObjects([skin, globe], false)[0]?.object).toBe(globe);
        skin.morphTargetInfluences![0] = 1;
        expect(ray.intersectObjects([skin, globe], false)[0]?.object).toBe(skin);
        layers.globe.dispose(); layers.cornea.dispose();
      }
      expect(Array.from(blink.array).every(Number.isFinite)).toBe(true);
      geometry.dispose(); material.dispose();
    });
  }
}

test('blinks close quickly, reopen smoothly and remain bounded across phases', () => {
  expect(blinkWeight(0.065, 0)).toBeCloseTo(1);
  expect(blinkWeight(0.19, 0)).toBeCloseTo(0);
  for (let t = 0; t < 20; t += 0.017) {
    for (const phase of [0, 0.29, 0.58]) {
      const value = blinkWeight(t, phase);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  }
});
