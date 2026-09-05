import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { PedSystem } from './peds';
import { Ped } from './peds/crowd';

function fixture() {
  const system = new PedSystem();
  const ped = new Ped();
  ped.active = true;
  const calls: string[] = [];
  const internal = system as unknown as {
    peds: Map<string, Ped>;
    list: Ped[];
    promote(p: Ped): undefined;
    collisions: { attach(p: Ped): void; detach(p: Ped): void; snap(p: Ped): void };
    driverEjections: Map<string, unknown>;
    updateDriverEjections(dt: number): void;
  };
  system.spawn = (_archetype, exit, heading) => {
    ped.position.copy(exit);
    ped.yaw = heading;
    internal.peds.set(ped.id, ped);
    internal.list.push(ped);
    return ped;
  };
  internal.promote = () => { calls.push('promote'); return undefined; };
  internal.collisions = {
    attach: () => { calls.push('attach'); },
    detach: () => { calls.push('detach'); },
    snap: () => { calls.push('snap'); },
  };
  return { system, internal, ped, calls };
}

test('pulled driver leaves the seat, gains collision only outside, and flees alive', () => {
  const f = fixture();
  const seat = new THREE.Vector3(0, 0.2, 0);
  const exit = new THREE.Vector3(2, 0, -1);
  const handle = f.system.ejectDriver('civilian', seat, exit, 0, 0.8);
  expect(handle).toBe(f.ped);
  expect(f.calls).toEqual(['promote', 'detach']);
  expect(handle.position.equals(seat)).toBe(true);
  f.internal.updateDriverEjections(0.4);
  expect(handle.position.distanceTo(seat)).toBeGreaterThan(0);
  expect(handle.position.distanceTo(exit)).toBeGreaterThan(0);
  expect(f.ped.mode).toBe('scripted');
  expect(f.calls).not.toContain('attach');
  f.internal.updateDriverEjections(0.4);
  expect(handle.position.equals(exit)).toBe(true);
  expect(f.ped.mode).toBe('flee');
  expect(f.ped.isAlive).toBe(true);
  expect(f.calls).toEqual(['promote', 'detach', 'attach', 'snap']);
  expect(f.internal.driverEjections.size).toBe(0);
  expect(f.system.get(handle.id)).toBe(handle);
});

test('despawning during a pull removes its pending transition', () => {
  const f = fixture();
  f.system.ejectDriver('civilian', new THREE.Vector3(), new THREE.Vector3(2, 0, 0), 0, 0.8);
  f.system.despawn(f.ped.id);
  f.internal.updateDriverEjections(1);
  expect(f.internal.driverEjections.size).toBe(0);
  expect(f.system.get(f.ped.id)).toBeUndefined();
  expect(f.calls).not.toContain('attach');
});

test('ejection uses rendered frame time even when physics cannot keep up', () => {
  const f = fixture();
  f.system.ejectDriver('civilian', new THREE.Vector3(), new THREE.Vector3(2, 0, 0), 0, 0.8);
  for (let frame = 0; frame < 8; frame++) f.system.update(0.1);
  expect(f.internal.driverEjections.size).toBe(0);
  expect(f.ped.mode).toBe('flee');
});
