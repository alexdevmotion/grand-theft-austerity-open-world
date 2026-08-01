import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import { EventBus } from '../../core/events';
import { Services } from '../../core/services';
import { PedSystem, applyPedMeleeStrike, placePedMeleeDebugTarget } from '../peds';
import { Ped } from './crowd';

test('a melee strike damages only the nearest living pedestrian in the forward cone', () => {
  const nearest = new Ped();
  nearest.position.set(0.18, 0, 1.55);

  const farther = new Ped();
  farther.position.set(-0.12, 0, 1.95);

  const beside = new Ped();
  beside.position.set(1.45, 0, 0.55);

  const behind = new Ped();
  behind.position.set(0, 0, -0.8);

  const hit = applyPedMeleeStrike(
    [farther, beside, nearest, behind],
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 1),
    34,
  );

  expect(hit).toMatchObject({ targetId: nearest.id, damage: 34, fatal: false });
  expect(nearest.health).toBe(66);
  expect(nearest.mode).toBe('flee');
  expect([farther.health, beside.health, behind.health]).toEqual([100, 100, 100]);
});

test('invalid, dead, unreachable and vertically separated pedestrians are not melee targets', () => {
  const dead = new Ped();
  dead.position.set(0, 0, 0.6);
  dead.health = 0;

  const unreachable = new Ped();
  unreachable.position.set(0, 0, 2.4);

  const upstairs = new Ped();
  upstairs.position.set(0, 1.4, 1.1);

  const valid = new Ped();
  valid.position.set(0.1, 0, 1.8);

  const corrupt = new Ped();
  corrupt.position.set(Number.NaN, 0, 0.4);

  const hit = applyPedMeleeStrike(
    [dead, unreachable, upstairs, valid, corrupt],
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, 1),
    34,
  );

  expect(hit?.targetId).toBe(valid.id);
  expect(valid.health).toBe(66);
  expect([dead.health, unreachable.health, upstairs.health, corrupt.health]).toEqual([0, 100, 100, 100]);

  const invalidHeading = applyPedMeleeStrike(
    [valid],
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0),
    34,
  );
  expect(invalidHeading).toBeNull();
  expect(valid.health).toBe(66);
});

test('debug target placement stays reachable and inside the real melee cone', () => {
  const out = new THREE.Vector3();
  const placed = placePedMeleeDebugTarget(
    {
      groundHeight: () => 0.17,
      // Force the helper off the exact centreline to exercise its deterministic
      // fallback while leaving the rest of the forward cone open.
      isBlocked: (x, z) => Math.abs(x) < 0.01 && Math.abs(z - 1.55) < 0.01,
    },
    new THREE.Vector3(0, 0.17, 0),
    new THREE.Vector3(0, 0, 1),
    out,
  );

  const planarDistance = Math.hypot(out.x, out.z);
  const forwardDot = out.z / planarDistance;
  expect(placed).toBe(true);
  expect(planarDistance).toBeCloseTo(1.55, 6);
  expect(forwardDot).toBeGreaterThan(Math.cos(38 * Math.PI / 180));
  expect(out.y).toBeCloseTo(0.17, 6);
  expect(Math.abs(out.x)).toBeGreaterThan(0.01);
});

function serviceHarness(target: Ped) {
  const heat: Array<{ amount: number; at: THREE.Vector3 }> = [];
  const audio: Array<{ id: string; at: THREE.Vector3; volume: number }> = [];
  const killed: THREE.Vector3[] = [];
  const events = new EventBus();
  events.on('ped:killed', ({ position }) => killed.push(position.clone()));
  const wanted = {
    addHeat(amount: number, at: THREE.Vector3) {
      heat.push({ amount, at: at.clone() });
    },
  };
  const sound = {
    oneShot(id: string, at: THREE.Vector3, volume: number) {
      audio.push({ id, at: at.clone(), volume });
    },
  };
  const ctx = {
    events,
    tryGet(key: { id: string }) {
      if (key.id === Services.Wanted.id) return wanted;
      if (key.id === Services.Audio.id) return sound;
      return undefined;
    },
  } as unknown as GameContext;
  const system = new PedSystem();
  const internals = system as unknown as {
    ctx: GameContext;
    list: Ped[];
    peds: Map<string, Ped>;
  };
  internals.ctx = ctx;
  internals.list = [target];
  internals.peds = new Map([[target.id, target]]);
  return { system, heat, audio, killed };
}

test('ped service applies civilian and protected-faction wanted consequences', () => {
  for (const [faction, expectedHeat] of [['civilian', 65], ['police', 120]] as const) {
    const target = new Ped();
    target.faction = faction;
    target.position.set(0, 0, 1.4);
    const h = serviceHarness(target);

    const hit = h.system.meleeStrike(
      new THREE.Vector3(),
      new THREE.Vector3(0, 0, 1),
      34,
    );

    expect(hit).toMatchObject({ targetId: target.id, faction, damage: 34, fatal: false });
    expect(h.heat.map((entry) => entry.amount)).toEqual([expectedHeat]);
    expect(h.heat[0].at.toArray()).toEqual(target.position.toArray());
    expect(h.audio.map((entry) => entry.id)).toEqual(['ped_hit']);
    expect(h.audio[0].volume).toBeCloseTo(0.72, 6);
    expect(h.killed).toEqual([]);
  }
});

test('fatal service strike emits the existing killed consequence exactly once', () => {
  const target = new Ped();
  target.position.set(0.1, 0, 1.3);
  target.health = 20;
  const h = serviceHarness(target);

  const hit = h.system.meleeStrike(
    new THREE.Vector3(),
    new THREE.Vector3(0, 0, 1),
    34,
  );

  expect(hit).toMatchObject({ targetId: target.id, damage: 20, fatal: true });
  expect(target.health).toBe(0);
  expect(target.mode).toBe('down');
  expect(h.killed).toHaveLength(1);
  expect(h.killed[0].toArray()).toEqual(target.position.toArray());
  expect(h.audio.map((entry) => entry.id)).toEqual(['ped_hit']);
  // Fatal wanted heat is intentionally owned by the real `ped:killed` police
  // listener; the pedestrian service must not also double-charge it here.
  expect(h.heat).toEqual([]);
});
