import { expect, test } from 'bun:test';
import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Services, type VehicleHandle } from '../core/services';
import { PlayerSystem } from './player';

function fixture(occupied = false) {
  const events: string[] = [];
  const ejections: unknown[][] = [];
  const doors: number[] = [];
  const controls: unknown[][] = [];
  const vehicle = {
    id: 'car', kind: 'sedan', position: new THREE.Vector3(0, 0.6, 0),
    rotation: new THREE.Quaternion(), occupants: [] as string[], speed: 0,
    locked: true, npcDriver: occupied ? 'civilian' : null, entryReserved: false,
    isWrecked: false, seats: 4,
    setControls: (...args: unknown[]) => controls.push(args),
    doorAnchor: (_id: string, out: THREE.Vector3) => out.set(1.3, 0, 0),
    setDoorOpen: (_id: string, value: number) => doors.push(value),
  } as unknown as VehicleHandle;
  const peds = { ejectDriver: (...args: unknown[]) => ejections.push(args) };
  const ctx = {
    events: { emit: (event: string) => events.push(event) },
    tryGet: (key: { id: string }) => key.id === Services.Peds.id ? peds : undefined,
  } as unknown as GameContext;
  const player = new PlayerSystem();
  player.character.position.set(2, 0, 0);
  const internal = player as unknown as {
    ctx: GameContext;
    board: { t: number; dur: number; preparation: string; prepared: boolean } | null;
    updateBoarding(dt: number): { sit: number; action?: string } | null;
    cancelBoarding(): void;
    body: { setTranslation(): void; setNextKinematicTranslation(): void };
    collider: { setEnabled(enabled: boolean): void };
  };
  internal.ctx = ctx;
  internal.body = { setTranslation() {}, setNextKinematicTranslation() {} };
  internal.collider = { setEnabled() {} };
  return { player, internal, vehicle, events, ejections, doors, controls, peds, ctx };
}

test('parked cars stay empty with a closed door while the quick lockpick runs', () => {
  const f = fixture();
  f.player.enterVehicle(f.vehicle);
  expect(f.player.inVehicle).toBeNull();
  expect(f.vehicle.entryReserved).toBe(true);
  expect(f.events).toEqual([]);
  const pose = f.internal.updateBoarding(0.5);
  expect(pose?.action).toBe('lockpick');
  expect(pose?.sit).toBe(0);
  expect(f.doors.at(-1)).toBe(0);
  expect(f.vehicle.locked).toBe(true);
  expect(f.ejections).toEqual([]);
  f.internal.updateBoarding(0.4);
  expect(f.vehicle.locked).toBe(false);
  f.internal.updateBoarding(1);
  expect(f.player.inVehicle).toBe(f.vehicle);
  expect(f.vehicle.occupants).toEqual(['player']);
  expect(f.vehicle.entryReserved).toBe(false);
  expect(f.events).toEqual(['player:enteredVehicle']);
  expect(f.ejections).toEqual([]);
});

test('occupied cars pull their driver out before seating the player, exactly once', () => {
  const f = fixture(true);
  f.player.enterVehicle(f.vehicle);
  f.internal.updateBoarding(0.6);
  expect(f.vehicle.npcDriver).toBe('civilian');
  expect(f.ejections).toHaveLength(0);
  const pose = f.internal.updateBoarding(0.1);
  expect(pose?.action).toBe('pull');
  expect(pose?.sit).toBe(0);
  expect(f.doors.at(-1)).toBe(1);
  expect(f.ejections).toHaveLength(1);
  expect(f.vehicle.npcDriver).toBeNull();
  expect(f.player.inVehicle).toBeNull();
  expect(f.vehicle.occupants).toEqual([]);
  f.player.enterVehicle(f.vehicle);
  f.internal.updateBoarding(0.6);
  expect(f.player.inVehicle).toBeNull();
  expect(f.ejections).toHaveLength(1);
  f.internal.updateBoarding(0.9);
  expect(f.player.inVehicle).toBe(f.vehicle);
  expect(f.events).toEqual(['player:enteredVehicle']);
});

test('unlocked re-entry has no lockpick or driver removal', () => {
  const f = fixture();
  f.vehicle.locked = false;
  f.player.enterVehicle(f.vehicle);
  expect(f.internal.board?.preparation).toBeNull();
  f.internal.updateBoarding(1.31);
  expect(f.player.inVehicle).toBe(f.vehicle);
  expect(f.ejections).toHaveLength(0);
});

test('teleport cancels entry without ownership or an open door', () => {
  const f = fixture(true);
  f.player.enterVehicle(f.vehicle);
  f.internal.updateBoarding(0.3);
  f.player.teleport(new THREE.Vector3(10, 0, 10));
  expect(f.vehicle.entryReserved).toBe(false);
  expect(f.vehicle.npcDriver).toBe('civilian');
  expect(f.doors.at(-1)).toBe(0);
  expect(f.player.inVehicle).toBeNull();
  expect(f.events).toEqual([]);
});

test('unsafe driver ejection cancels entry and retains the driver', () => {
  const f = fixture(true);
  f.peds.ejectDriver = () => { throw new Error('Blocked pavement'); };
  f.player.enterVehicle(f.vehicle);
  f.internal.updateBoarding(0.7);
  expect(f.internal.board).toBeNull();
  expect(f.vehicle.npcDriver).toBe('civilian');
  expect(f.vehicle.entryReserved).toBe(false);
  expect(f.events).toEqual([]);
});

test('a wreck during entry releases the reservation without granting control', () => {
  const f = fixture();
  f.player.enterVehicle(f.vehicle);
  Object.assign(f.vehicle, { isWrecked: true });
  f.player.fixedUpdate(0.016, f.ctx);
  expect(f.internal.board).toBeNull();
  expect(f.vehicle.entryReserved).toBe(false);
  expect(f.player.inVehicle).toBeNull();
});

test('entry follows the visible root and cancellation keeps the current safe position', () => {
  const f = fixture();
  const original = f.player.position.clone();
  f.player.enterVehicle(f.vehicle);
  f.internal.updateBoarding(0.5);
  const atDoor = f.player.character.object.position.clone();
  expect(f.player.position.equals(atDoor)).toBe(true);
  expect(atDoor.distanceTo(original)).toBeGreaterThan(0.5);
  f.internal.cancelBoarding();
  expect(f.player.position.equals(atDoor)).toBe(true);
  expect(f.player.character.object.position.equals(atDoor)).toBe(true);
});

test('low frame rates do not seat the player before the timed driver pull finishes', () => {
  const f = fixture(true);
  let driverRemaining = 0;
  f.peds.ejectDriver = (...args) => {
    driverRemaining = args[4] as number;
    return f.ejections.push(args);
  };
  f.player.enterVehicle(f.vehicle);
  // Peds update before player on the frame clock; physics may drop its backlog.
  for (let frame = 0; frame < 22; frame++) {
    driverRemaining = Math.max(0, driverRemaining - 0.1);
    const pose = f.internal.updateBoarding(0.1);
    if (pose && pose.sit > 0.001) expect(driverRemaining).toBeLessThan(1e-6);
  }
  expect(f.player.inVehicle).toBe(f.vehicle);
  expect(f.ejections).toHaveLength(1);
});

test('fast cars and remote cars cannot bypass entry; scripted empty placement stays explicit', () => {
  const f = fixture();
  Object.assign(f.vehicle, { speed: 6 });
  f.player.enterVehicle(f.vehicle);
  expect(f.internal.board).toBeNull();
  Object.assign(f.vehicle, { speed: 0 });
  f.player.character.position.set(50, 0, 0);
  f.player.enterVehicle(f.vehicle);
  expect(f.player.inVehicle).toBeNull();
  f.player.enterVehicle(f.vehicle, true);
  expect(f.player.inVehicle).toBe(f.vehicle);
});
