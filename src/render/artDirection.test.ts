import { describe, expect, test } from 'bun:test';
import { Color } from 'three';
import { Palette } from '../artDirection';
import { PAL } from './materials';
import { keyForElevation, newKey } from './sky/skyState';

describe('linear colour authoring', () => {
  test('shared flag colours decode sRGB exactly once across materials and lights', () => {
    for (const [key, hex] of [['roBlue', 0x002b7f], ['roYellow', 0xfcd116], ['roRed', 0xce1126]] as const) {
      const expected = new Color(hex);
      expect(Palette[key].r).toBeCloseTo(expected.r, 7);
      expect(Palette[key].g).toBeCloseTo(expected.g, 7);
      expect(Palette[key].b).toBeCloseTo(expected.b, 7);
      expect(PAL[key]).toBe(Palette[key]);
    }
  });

  test('the whole solar transition stays finite and continuous', () => {
    const current = newKey();
    const next = newKey();
    for (let elevation = -25; elevation <= 50; elevation += 0.1) {
      keyForElevation(current, elevation);
      keyForElevation(next, elevation + 0.001);
      for (const key of ['horizon', 'zenith', 'ambient', 'sunLight'] as const) {
        for (const channel of ['r', 'g', 'b'] as const) {
          expect(Number.isFinite(current[key][channel])).toBe(true);
          expect(current[key][channel]).toBeGreaterThanOrEqual(0);
          expect(Math.abs(current[key][channel] - next[key][channel])).toBeLessThan(0.005);
        }
      }
    }
  });
});
