import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Ragdoll } from './ik';
import { BI, bodyMetrics, buildRig } from './rig';

test('the visual ragdoll keeps its hips anchored to an authoritative physics proxy', () => {
  const root = new THREE.Object3D();
  const rig = buildRig(bodyMetrics('average', false));
  root.add(rig.root);
  root.updateMatrixWorld(true);
  const ragdoll = new Ragdoll(rig, root, new THREE.Vector3(7, 4, 0));
  const proxyHips = new THREE.Vector3(3.5, 1.1, -2.25);

  for (let frame = 0; frame < 12; frame++) {
    proxyHips.x += 0.08;
    proxyHips.y -= 0.025;
    ragdoll.update(1 / 60, null, proxyHips);
    ragdoll.apply();
    root.updateMatrixWorld(true);

    const visibleHips = new THREE.Vector3().setFromMatrixPosition(rig.bones[BI.hips].matrixWorld);
    expect(ragdoll.hipsWorld.distanceTo(proxyHips)).toBeLessThan(1e-6);
    expect(visibleHips.distanceTo(proxyHips)).toBeLessThan(1e-5);
  }
});
