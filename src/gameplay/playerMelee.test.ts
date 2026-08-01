import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Services } from '../core/services';
import { MeleeCadence, PlayerSystem } from './player';

test('one punch can start per cooldown even when attack is requested repeatedly', () => {
  const cadence = new MeleeCadence(0.5);

  expect(cadence.tryStart()).toBe(true);
  expect(cadence.tryStart()).toBe(false);

  cadence.update(0.49);
  expect(cadence.tryStart()).toBe(false);

  cadence.update(0.01);
  expect(cadence.tryStart()).toBe(true);
});

test('a started punch produces exactly one impact at its contact beat', () => {
  const cadence = new MeleeCadence(0.5, 0.15);

  expect(cadence.tryStart()).toBe(true);
  expect(cadence.update(0.14)).toBe(false);
  expect(cadence.update(0.01)).toBe(true);
  expect(cadence.update(0.01)).toBe(false);
});

test('player impact dispatches the real cone and records hit feedback', () => {
  const strikes: Array<{ origin: THREE.Vector3; forward: THREE.Vector3; damage: number }> = [];
  const shakes: Array<{ strength: number; duration: number }> = [];
  const peds = {
    meleeStrike(origin: THREE.Vector3, forward: THREE.Vector3, damage: number) {
      strikes.push({ origin: origin.clone(), forward: forward.clone(), damage });
      return {
        targetId: 'ped_fixture',
        position: new THREE.Vector3(5.4, 1, 7),
        faction: 'civilian' as const,
        damage,
        fatal: false,
      };
    },
  };
  const camera = {
    shake(strength: number, duration: number) {
      shakes.push({ strength, duration });
    },
  };
  const ctx = {
    time: { elapsed: 12.5 },
    tryGet(key: { id: string }) {
      if (key.id === Services.Peds.id) return peds;
      if (key.id === Services.Camera.id) return camera;
      return undefined;
    },
  } as unknown as GameContext;
  const player = new PlayerSystem();
  player.character.position.set(4, 1, 7);
  const internals = player as unknown as {
    bodyYaw: number;
    meleeHits: number;
    lastMeleeHit: { targetId: string; fatal: boolean; at: number } | null;
    performMeleeImpact(runtime: GameContext): void;
  };
  internals.bodyYaw = Math.PI / 2;

  internals.performMeleeImpact(ctx);

  expect(strikes).toHaveLength(1);
  expect(strikes[0].origin.toArray()).toEqual([4, 1, 7]);
  expect(strikes[0].forward.x).toBeCloseTo(1, 6);
  expect(strikes[0].forward.y).toBe(0);
  expect(strikes[0].forward.z).toBeCloseTo(0, 6);
  expect(strikes[0].damage).toBe(34);
  expect(internals.meleeHits).toBe(1);
  expect(internals.lastMeleeHit).toEqual({ targetId: 'ped_fixture', fatal: false, at: 12.5 });
  expect(shakes).toEqual([{ strength: 0.2, duration: 0.14 }]);
});
