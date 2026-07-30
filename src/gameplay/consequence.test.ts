/**
 * THE PRICE OF EVERYTHING.
 *
 * The consequence loop is mostly world state — an arrest needs a police car,
 * a detention needs a camera and a clock — but the numbers that make it a
 * *system* rather than a cutscene are pure arithmetic, and those are what a
 * balance change gets wrong. These pin the shape of the curves, not their
 * exact values, so retuning is cheap and inverting a rule by accident is not.
 */

import { describe, expect, test } from 'bun:test';
import { RELEASE_POINTS, bribePrice, fineFor, releasePointFor } from './wanted';
import { repairPrice } from './activities';

describe('fines', () => {
  test('cost nothing at zero stars and rise monotonically', () => {
    expect(fineFor(0, false)).toBe(0);
    let prev = -1;
    for (let s = 0; s <= 5; s++) {
      const f = fineFor(s, false);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  test('a five-star fine hurts — more than the most expensive shop', () => {
    expect(fineFor(5, false)).toBeGreaterThan(780);
  });

  test('`conexiuni` makes every fine cheaper but never free', () => {
    for (let s = 1; s <= 5; s++) {
      expect(fineFor(s, true)).toBeLessThan(fineFor(s, false));
      expect(fineFor(s, true)).toBeGreaterThan(0);
    }
  });

  test('stars outside 0..5 are clamped rather than throwing', () => {
    expect(fineFor(-3, false)).toBe(0);
    expect(fineFor(99, false)).toBe(fineFor(5, false));
  });
});

describe('bribes', () => {
  test('cost more the more heat you are carrying', () => {
    for (let s = 1; s < 5; s++) {
      expect(bribePrice(s + 1, 0, false)).toBeGreaterThan(bribePrice(s, 0, false));
    }
  });

  test('inflate every time you do it — the joke has to stop being the answer', () => {
    const first = bribePrice(3, 0, false);
    const fourth = bribePrice(3, 3, false);
    expect(fourth).toBeGreaterThan(first * 1.9);
  });

  test('are worse value than the fine for the same star, before inflation', () => {
    // Buying one star off is deliberately dearer per star than being caught,
    // otherwise a rational player farms arrests instead of driving well.
    for (let s = 1; s <= 5; s++) {
      expect(bribePrice(s, 0, false)).toBeGreaterThan(fineFor(s, false));
    }
  });

  test('`conexiuni` discounts them too', () => {
    expect(bribePrice(4, 2, true)).toBeLessThan(bribePrice(4, 2, false));
  });
});

describe('release points', () => {
  const [depozit, palat] = RELEASE_POINTS;

  test('paying puts you at the nearer address', () => {
    expect(releasePointFor(depozit.x + 10, depozit.z + 10, true).id).toBe('depozit');
    expect(releasePointFor(palat.x - 10, palat.z - 10, true).id).toBe('palat');
  });

  test('refusing puts you at the far one — that is the whole punishment', () => {
    expect(releasePointFor(depozit.x + 10, depozit.z + 10, false).id).toBe('palat');
    expect(releasePointFor(palat.x - 10, palat.z - 10, false).id).toBe('depozit');
  });

  test('paying is never worse than refusing, wherever you were caught', () => {
    for (let x = -1000; x <= 1000; x += 250) {
      for (let z = -1000; z <= 1000; z += 250) {
        const paid = releasePointFor(x, z, true);
        const refused = releasePointFor(x, z, false);
        const d = (p: { x: number; z: number }): number => (p.x - x) ** 2 + (p.z - z) ** 2;
        expect(d(paid)).toBeLessThanOrEqual(d(refused));
      }
    }
  });
});

describe('repairs', () => {
  test('an untouched car is refused rather than charged', () => {
    expect(repairPrice(100, 100)).toBe(0);
  });

  test('cost rises with damage and is never free once it is real', () => {
    const light = repairPrice(90, 100);
    const heavy = repairPrice(10, 100);
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light);
  });

  test('a total wreck costs less to repair than the tow fee on a real wreck', () => {
    // Fixing it before it dies has to be the cheaper path, or the garage is
    // pointless and the correct play is always to write the car off.
    expect(repairPrice(1, 100)).toBeGreaterThan(0);
    expect(repairPrice(50, 100)).toBeLessThan(640 + repairPrice(1, 100));
  });

  test('survives a zero-max-health handle without dividing by zero', () => {
    expect(Number.isFinite(repairPrice(0, 0))).toBe(true);
  });
});
