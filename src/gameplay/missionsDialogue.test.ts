import { describe, expect, test } from 'bun:test';
import { appendDialogue, type PendingLine } from './missions';

describe('mission dialogue timeline', () => {
  test('a later interaction waits for an already-visible opening line', () => {
    const opening: PendingLine[] = [{
      at: 0.18,
      speaker: 'ȘTIRI',
      text: 'Casa a fost sigilată.',
      ms: 6800,
    }];
    const queued = appendDialogue(opening, 0.4, [{
      speaker: 'Builder',
      text: 'Au luat clădirea.',
      delayMs: 200,
      ms: 4200,
    }]);

    expect(queued.map((l) => l.speaker)).toEqual(['ȘTIRI', 'Builder']);
    expect(queued[1].at).toBeGreaterThanOrEqual(7.34);
  });

  test('authored multi-speaker order is stable at one event seam', () => {
    const queued = appendDialogue([], 0, [
      { speaker: 'Alex', text: 'Dovezile.', delayMs: 300, ms: 4400 },
      { speaker: 'Ilie', text: 'Ne întoarcem.', delayMs: 4900, ms: 4000 },
    ]);

    expect(queued.map((l) => l.speaker)).toEqual(['Alex', 'Ilie']);
    expect(queued.map((l) => l.at)).toEqual([0.3, 4.9]);
  });

  test('a line already visible reserves the subtitle surface for its full duration', () => {
    const later = appendDialogue(
      [],
      0.2,
      [{ speaker: 'Builder', text: 'Acum răspund.', ms: 3000 }],
      7.16,
    );

    expect(later[0].at).toBeCloseTo(7.16, 9);
  });
});
