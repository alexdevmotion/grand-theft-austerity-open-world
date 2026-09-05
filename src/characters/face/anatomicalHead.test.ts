import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import cooked from './generated/anatomical-cast.json';
import { buildAnatomicalHead, type AnatomicalCast } from './anatomicalHead';
import { CAST } from './heroHead';
import { buildHeadGeometry } from './headMesh';
import { eyeLayerGeometries } from './eyes';
import { bodyMetrics } from '../rig';
import type { CastId } from './fitData';

for (const id of ['player', 'ally', 'nicusor'] as CastId[]) {
  test(`${id}: anatomical head stays in the rig frame with open pupils and a closing blink`, () => {
    const cfg = CAST[id], m = bodyMetrics('average', false);
    const fallback = buildHeadGeometry({
      cloud: cfg.cloud(), chinY: m.headY - 0.01, crownY: m.headTopY,
      skin: cfg.skin, beard: cfg.beardShade, beardColor: cfg.beardColor,
      hairColor: cfg.hairColor, tired: cfg.tired, age: cfg.age,
      jawPush: cfg.jawPush, browPush: cfg.browPush, hairline: cfg.hair.hairline,
    });
    const result = buildAnatomicalHead(cooked.casts[id] as AnatomicalCast, cfg, fallback)!;
    expect(result).not.toBeNull();
    const { geometry, anchors } = result;
    const box = geometry.boundingBox!;
    expect(box.max.y - anchors.chinY).toBeGreaterThan(0.20);
    expect(box.max.y - anchors.chinY).toBeLessThan(0.27);
    expect(box.min.y).toBeGreaterThan(anchors.chinY - 0.06);
    for (const key of ['position', 'normal', 'color', 'aSkin']) {
      expect(Array.from(geometry.attributes[key].array).every(Number.isFinite)).toBe(true);
    }
    const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
    const head = new THREE.Mesh(geometry, material);
    head.updateMatrixWorld(true);
    for (const eye of [anchors.eyeL, anchors.eyeR]) {
      expect(eye.radius).toBeGreaterThan(0.010);
      expect(eye.radius).toBeLessThan(0.015);
      const layers = eyeLayerGeometries(eye, 0);
      const globe = new THREE.Mesh(layers.globe, material);
      globe.updateMatrixWorld(true);
      const ray = new THREE.Raycaster(eye.centre.clone().add(new THREE.Vector3(0, 0, 0.15)), new THREE.Vector3(0, 0, -1));
      head.morphTargetInfluences![0] = 0;
      expect(ray.intersectObjects([head, globe])[0]?.object === globe).toBe(true);
      head.morphTargetInfluences![0] = 1;
      expect(ray.intersectObjects([head, globe])[0]?.object === head).toBe(true);
      layers.globe.dispose(); layers.cornea.dispose();
    }
    head.morphTargetInfluences![0] = 0;
    const bvh = new MeshBVH(geometry, { indirect: true });
    // Scalp roots project onto the new mesh rather than the old ellipsoid.
    for (const az of [-2, -1, 0, 1, 2]) {
      const root = anchors.surface(az, 0.8, 0, new THREE.Vector3());
      expect(bvh.closestPointToPoint(root)!.distance).toBeLessThan(0.0001);
      const raised = anchors.surface(az, 0.8, 0.025, new THREE.Vector3());
      expect(raised.distanceTo(root)).toBeCloseTo(0.025 * anchors.frame.scale, 5);
    }
    geometry.dispose(); fallback.geometry.dispose(); material.dispose();
  });
}
