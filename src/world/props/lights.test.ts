import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { GroundGlow, HeadGlow, LampLights } from './lights';

const AMBER = new THREE.Color(1, 0.5, 0.1);

describe('addressable street-lamp effects', () => {
  test('breaking one source zeros only its ground-pool instance', () => {
    const pools = new GroundGlow();
    pools.add(0, 0.16, 0, 5, AMBER, 1, { x: 0, z: 0 });
    pools.add(12, 0.16, 0, 5, AMBER, 1, { x: 12, z: 0 });
    const mesh = pools.build()!;

    expect(pools.disableSourceNear(0, 0, 0.25)).toBe(1);
    const broken = new THREE.Matrix4();
    const neighbour = new THREE.Matrix4();
    mesh.getMatrixAt(0, broken);
    mesh.getMatrixAt(1, neighbour);
    expect(broken.elements.slice(0, 12)).toEqual(new Array(12).fill(0));
    expect(neighbour.elements.slice(0, 12)).not.toEqual(new Array(12).fill(0));

    pools.enableAllSources();
    mesh.getMatrixAt(0, broken);
    expect(broken.elements.slice(0, 12)).not.toEqual(new Array(12).fill(0));
    pools.dispose();
  });

  test('breaking one source zeros only its head flare', () => {
    const flares = new HeadGlow();
    flares.add(0, 8, 0, 0.5, AMBER, 1, { x: 0, z: 0 });
    flares.add(12, 8, 0, 0.5, AMBER, 1, { x: 12, z: 0 });
    const mesh = flares.build()!;

    expect(flares.disableSourceNear(0, 0, 0.25)).toBe(1);
    const size = mesh.geometry.getAttribute('aSize');
    expect([size.getX(0), size.getY(0)]).toEqual([0, 0]);
    expect(size.getX(1)).toBeGreaterThan(0);

    flares.enableAllSources();
    expect(size.getX(0)).toBeGreaterThan(0);
    flares.dispose();
  });

  test('breaking the assigned source immediately extinguishes its real point light', () => {
    const parent = new THREE.Group();
    const lights = new LampLights(1, parent);
    lights.register({
      x: 0, y: 8, z: 0, color: AMBER.clone(), intensity: 20, distance: 20,
    }, { x: 0, z: 0 });
    lights.register({
      x: 15, y: 8, z: 0, color: AMBER.clone(), intensity: 20, distance: 20,
    }, { x: 15, z: 0 });
    const camera = new THREE.Object3D();
    camera.position.set(0, 8, 0);
    lights.update(0.3, camera);
    const light = parent.children[0] as THREE.PointLight;
    expect(light.intensity).toBeGreaterThan(0);

    expect(lights.disableSourceNear(0, 0, 0.25)).toBe(1);
    expect(light.intensity).toBe(0);

    lights.enableAllSources();
    lights.update(0.3, camera);
    expect(light.intensity).toBeGreaterThan(0);
    lights.dispose();
  });
});
