import { describe, expect, test } from 'bun:test';
import { Rng } from '../../core/rng';
import { DetailBuilder } from './builders';
import { bollard, crowdBarrier, parkedCar, planeTree, streetLamp, wasteBin } from './facades';

describe('city detail collision proxies', () => {
  test('substantial street objects publish one semantic blocker each', () => {
    const d = new DetailBuilder();
    const rng = new Rng('detail-collision-proxies');

    parkedCar(d, 4, -3, Math.PI / 3, rng);
    streetLamp(d, 8, 2, 1, 0, 8);
    planeTree(d, -6, 7, rng, 1, 2);
    bollard(d, 1, 9);
    wasteBin(d, -2, 3, rng);
    crowdBarrier(d, 12, -4, 1, 0, 4, rng);

    const kinds = d.collisionBoxes.map((box) => box.kind);
    expect(kinds).toContain('parked-car');
    expect(kinds).toContain('street-lamp');
    expect(kinds).toContain('tree-trunk');
    expect(kinds).toContain('bollard');
    expect(kinds).toContain('waste-bin');
    expect(kinds.filter((kind) => kind === 'crowd-barrier')).toHaveLength(4);

    for (const box of d.collisionBoxes) {
      expect(box.halfExtents.x).toBeGreaterThan(0);
      expect(box.halfExtents.y).toBeGreaterThan(0);
      expect(box.halfExtents.z).toBeGreaterThan(0);
      expect(Number.isFinite(box.position.x + box.position.y + box.position.z + box.rotationY)).toBe(true);
    }
  });
});
