import { describe, expect, test } from 'bun:test';
import { pauseAwareCountdown } from './hud';

describe('HUD presentation clock', () => {
  test('subtitle time freezes while gameplay is paused', () => {
    expect(pauseAwareCountdown(3.8, 2, true)).toBe(3.8);
  });

  test('subtitle time advances only through playable time', () => {
    expect(pauseAwareCountdown(3.8, 0.5, false)).toBeCloseTo(3.3, 9);
    expect(pauseAwareCountdown(0.2, 0.5, false)).toBe(0);
  });
});
