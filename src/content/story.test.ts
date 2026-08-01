import { expect, test } from 'bun:test';
import { CAMPAIGN } from './story';

test('story dialogue declares whether it belongs on arrival or interaction completion', () => {
  const complete = new Set([
    'act1_evacuare/brief',
    'act1_evacuare/server',
    'act2_bootstrap/evidence',
    'act2_bootstrap/credentials',
    'act3_termsheet/hijack',
    'act4_giftshop/barricade',
    'act4_giftshop/enter',
    'act4_giftshop/liberate',
  ]);

  let spoken = 0;
  for (const mission of CAMPAIGN) {
    for (const objective of mission.objectives) {
      if (!objective.say?.length) continue;
      spoken++;
      const key = `${mission.id}/${objective.id}`;
      expect(objective.sayAt, key).toBe(complete.has(key) ? 'complete' : 'enter');
      // A podcast clip also emits its own subtitle. Story dialogue must be the
      // sole speech authority at this moment, or the visible NPC is assigned a
      // random line from the radio library.
      expect(objective.voice, `${key} competing voice`).toBeUndefined();
      for (const line of objective.say) {
        expect(line.speaker.length, `${key} speaker`).toBeGreaterThan(2);
        expect(line.text.length, `${key} text`).toBeGreaterThan(18);
        expect(line.ms ?? 0, `${key} readable duration`).toBeGreaterThanOrEqual(3500);
      }
    }
  }
  expect(spoken).toBe(15);
});
