import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { AnimationController } from './animation';
import { BI, bodyMetrics, buildRig } from './rig';

test('turning in place lifts alternating boots and releases the swing foot', () => {
  const rig = buildRig(bodyMetrics('average', false));
  const anim = new AnimationController(rig, 0, 0);
  const minY = [Infinity, Infinity];
  const maxY = [-Infinity, -Infinity];
  const released = [false, false];
  const footfalls = new Set<string>();
  anim.onFootfall = (foot) => { footfalls.add(foot); };
  const position = new THREE.Vector3();
  for (let frame = 0; frame < 300; frame++) {
    anim.drive({ state: 'idle', speed: 0, grounded: true, turnRate: 2.4 });
    anim.update(1 / 60);
    anim.applyTo(rig);
    rig.root.updateMatrixWorld(true);
    if (frame < 60) continue;
    for (let side = 0; side < 2; side++) {
      position.setFromMatrixPosition(rig.bones[side === 0 ? BI.footL : BI.footR].matrixWorld);
      minY[side] = Math.min(minY[side], position.y);
      maxY[side] = Math.max(maxY[side], position.y);
      released[side] ||= anim.footPlant[side] < 0.1;
    }
  }
  for (let side = 0; side < 2; side++) {
    expect(maxY[side] - minY[side]).toBeGreaterThan(0.025);
    expect(maxY[side] - minY[side]).toBeLessThan(0.16);
    expect(released[side]).toBe(true);
  }
  expect(footfalls).toEqual(new Set(['left', 'right']));
});

test('stationary idle keeps both feet planted', () => {
  const rig = buildRig(bodyMetrics('average', false));
  const anim = new AnimationController(rig, 0, 0);
  for (let frame = 0; frame < 180; frame++) {
    anim.drive({ state: 'idle', speed: 0, grounded: true });
    anim.update(1 / 60);
    expect(anim.footPlant).toEqual([1, 1]);
  }
});

test('braking checks the hips back before returning to relaxed idle', () => {
  const rig = buildRig(bodyMetrics('average', false));
  const anim = new AnimationController(rig, 0, 0);
  for (let frame = 0; frame < 120; frame++) {
    anim.drive({ state: 'jog', speed: 4.3, grounded: true });
    anim.update(1 / 60);
  }
  let checkedBack = false;
  for (let frame = 0; frame < 180; frame++) {
    anim.drive({ state: 'idle', speed: 0, grounded: true });
    anim.update(1 / 60);
    checkedBack ||= anim.pose.q[BI.hips * 4] < -0.001;
    expect(anim.pose.q.every(Number.isFinite)).toBe(true);
  }
  expect(checkedBack).toBe(true);
  expect(anim.pose.q[BI.hips * 4]).toBeGreaterThan(0);
});
