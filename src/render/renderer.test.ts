import { test, expect, describe } from 'bun:test';
import { detectQuality, isQuality, wantsPreservedDrawingBuffer, QUALITY } from './renderer';

/**
 * `preserveDrawingBuffer` used to be unconditional, costing every player a
 * per-frame surface copy so that an automation-only readback could work. These
 * pin the gate that replaced it — the failure mode being guarded against is a
 * silent flip back to "always on" (perf regression) or "always off" (breaks
 * `__GTA_POST__.meter()` for every critic).
 */
describe('wantsPreservedDrawingBuffer', () => {
  test('follows navigator.webdriver when no override is present', () => {
    expect(wantsPreservedDrawingBuffer('', true)).toBe(true);
    expect(wantsPreservedDrawingBuffer('', false)).toBe(false);
  });

  test('a real player on a plain URL does not pay for it', () => {
    expect(wantsPreservedDrawingBuffer('?q=high', false)).toBe(false);
  });

  test('an automated browser keeps meter() working without asking', () => {
    expect(wantsPreservedDrawingBuffer('?q=high', true)).toBe(true);
  });

  test('capture=1 forces it on even outside automation', () => {
    expect(wantsPreservedDrawingBuffer('?capture=1', false)).toBe(true);
  });

  test('capture=0 forces it off even under automation — this is what makes it benchmarkable', () => {
    expect(wantsPreservedDrawingBuffer('?capture=0', true)).toBe(false);
  });

  test('the override survives other params in any position', () => {
    expect(wantsPreservedDrawingBuffer('?q=ultra&capture=0&osm=1', true)).toBe(false);
    expect(wantsPreservedDrawingBuffer('?capture=1&q=low', false)).toBe(true);
  });

  test('an unrelated value is ignored rather than treated as truthy', () => {
    // Only the exact strings '1' and '0' are overrides; anything else defers.
    expect(wantsPreservedDrawingBuffer('?capture=yes', false)).toBe(false);
    expect(wantsPreservedDrawingBuffer('?capture=yes', true)).toBe(true);
  });
});

/**
 * The headline perf claim is "60fps at 1600x900" on `high`. These pin the
 * knobs that claim depends on, so a look change cannot quietly move them.
 */
describe('quality tiers', () => {
  test('only real quality names are accepted at startup', () => {
    expect(isQuality('low')).toBe(true);
    expect(isQuality('ultra')).toBe(true);
    expect(isQuality('potato')).toBe(false);
    expect(isQuality(null)).toBe(false);
  });

  test('automatic detection reserves low for genuinely constrained devices', () => {
    expect(detectQuality({ dpr: 2, memoryGb: 2, cores: 8, mobile: true })).toBe('low');
    expect(detectQuality({ dpr: 2, memoryGb: 4, cores: 4, mobile: true })).toBe('low');
    expect(detectQuality({ dpr: 3, cores: 6, mobile: true })).toBe('medium');
    expect(detectQuality({ dpr: 1, memoryGb: 16, cores: 12, mobile: false })).toBe('ultra');
  });

  test('high stays at the pixel-ratio cap the 60fps claim was measured at', () => {
    expect(QUALITY.high.pixelRatioCap).toBe(1.5);
  });

  test('shadow cost is bounded: high uses 3 cascades, not ultra\'s 4', () => {
    expect(QUALITY.high.shadowCascades).toBe(3);
    expect(QUALITY.ultra.shadowCascades).toBe(4);
  });

  test('tiers are monotonic in the things that cost the most', () => {
    const tiers = [QUALITY.low, QUALITY.medium, QUALITY.high, QUALITY.ultra];
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].shadowDistance).toBeGreaterThanOrEqual(tiers[i - 1].shadowDistance);
      expect(tiers[i].maxPeds).toBeGreaterThanOrEqual(tiers[i - 1].maxPeds);
      expect(tiers[i].maxTraffic).toBeGreaterThanOrEqual(tiers[i - 1].maxTraffic);
      expect(tiers[i].pixelRatioCap).toBeGreaterThanOrEqual(tiers[i - 1].pixelRatioCap);
    }
  });
});
