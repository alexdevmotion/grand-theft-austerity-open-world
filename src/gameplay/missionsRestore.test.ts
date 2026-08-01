import { describe, expect, test } from 'bun:test';
import { restoreFinaleState } from './missions';

describe('mission world-state restoration', () => {
  test('a completed finale restores a liberated exit', () => {
    let liberated = 0;
    let sealed = 0;
    const result = restoreFinaleState(
      new Set(['act4_giftshop']),
      { liberate: () => liberated++, seal: () => sealed++ },
    );

    expect(result).toBe(true);
    expect(liberated).toBe(1);
    expect(sealed).toBe(0);
  });

  test('an earlier save re-establishes the Ministry seal', () => {
    let liberated = 0;
    let sealed = 0;
    const result = restoreFinaleState(
      new Set(['act1_evacuare']),
      { liberate: () => liberated++, seal: () => sealed++ },
    );

    expect(result).toBe(false);
    expect(liberated).toBe(0);
    expect(sealed).toBe(1);
  });
});
