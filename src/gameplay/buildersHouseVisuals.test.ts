import { describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { DOORWAY, TOWER_SOUTH_Z } from '../content/places';
import { createSealedEntrance } from './buildersHouse';

describe('Builders House opening seal', () => {
  test('visibly closes the authored south entrance with layered closure cues', () => {
    const seal = createSealedEntrance();
    const names = seal.children.map((c) => c.name);

    expect(seal.name).toBe('builders-house:ministry-seal');
    expect(names.filter((n) => n === 'seal:barrier-rail').length).toBeGreaterThanOrEqual(8);
    expect(names.filter((n) => n === 'seal:hazard-tape').length).toBeGreaterThanOrEqual(20);
    expect(names.filter((n) => n === 'seal:door-plank').length).toBe(3);
    expect(names).toContain('seal:evacuation-order');
    expect(names).toContain('seal:warning-beacon');

    const bounds = new THREE.Box3().setFromObject(seal);
    expect(bounds.min.x).toBeLessThan(DOORWAY.x - 5);
    expect(bounds.max.x).toBeGreaterThan(DOORWAY.x + 5);
    expect(bounds.min.z).toBeLessThan(TOWER_SOUTH_Z - 4);
    expect(bounds.max.z).toBeLessThan(TOWER_SOUTH_Z);
  });
});
