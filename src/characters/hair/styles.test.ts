import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { CAST } from '../face/heroHead';
import { buildHeadGeometry } from '../face/headMesh';
import { bodyMetrics } from '../rig';
import { buildBeard, buildBrows, buildHairCards, buildLashes } from './styles';

const metrics = bodyMetrics('average', false);
const cfg = CAST.player;
const head = buildHeadGeometry({
  cloud: cfg.cloud(), chinY: metrics.headY - 0.010, crownY: metrics.headTopY,
  skin: cfg.skin, beard: cfg.beardShade, beardColor: cfg.beardColor,
  tired: cfg.tired, age: cfg.age, jawPush: cfg.jawPush, browPush: cfg.browPush,
});

function widestRibbon(geometry: THREE.BufferGeometry): number {
  const positions = geometry.getAttribute('position');
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let width = 0;
  for (let i = 0; i < positions.count; i += 2) {
    a.fromBufferAttribute(positions, i);
    b.fromBufferAttribute(positions, i + 1);
    width = Math.max(width, a.distanceTo(b));
  }
  return width;
}

test('the short beard uses separate narrow dark and grey fibres', () => {
  const beard = buildBeard(head.anchors, cfg.beard, 'beard-regression')!;
  expect(widestRibbon(beard)).toBeLessThan(0.0007);
  const strands = beard.getAttribute('aStrandInfo');
  let dark = 0, grey = 0;
  for (let i = 0; i < strands.count; i += 6) {
    if (strands.getY(i) === 0) dark++;
    else if (strands.getY(i) >= 0.39) grey++;
  }
  expect(dark / (dark + grey)).toBeGreaterThan(0.80);
  expect(grey / (dark + grey)).toBeGreaterThan(0.04);
  expect(grey / (dark + grey)).toBeLessThan(0.16);
  expect(dark + grey).toBeLessThan(6500);
  beard.dispose();
});

test('the crop keeps narrow clumps with a predominantly dark crown', () => {
  const hair = buildHairCards(head.anchors, cfg.hair, 'crop-regression')!;
  expect(widestRibbon(hair)).toBeLessThan(0.0056);
  const info = hair.getAttribute('aStrandInfo');
  let dark = 0, count = 0;
  for (let i = 0; i < info.count; i++) {
    if (info.getX(i) !== 0) continue;
    count++;
    if (info.getY(i) === 0) dark++;
  }
  expect(dark / count).toBeGreaterThan(0.80);
  expect(dark / count).toBeLessThan(0.97);
  hair.dispose();
});

test('brow mass sits just above the eyes and on the sculpted ridge', () => {
  const brows = buildBrows(head.anchors, cfg.brow, 'brow-regression')!;
  const positions = brows.getAttribute('position');
  const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
  const skin = new THREE.Mesh(head.geometry, material);
  const ray = new THREE.Raycaster();
  const point = new THREE.Vector3(), other = new THREE.Vector3();
  const verticesPerSide = cfg.brow.hairs * 3 * 6;
  for (const [side, eye] of [head.anchors.eyeL, head.anchors.eyeR].entries()) {
    const top = Math.max(...eye.ring.map((p) => p.y));
    for (let i = 0; i < verticesPerSide; i += 60) {
      const vertex = side * verticesPerSide + i;
      point.fromBufferAttribute(positions, vertex);
      other.fromBufferAttribute(positions, vertex + 1);
      point.add(other).multiplyScalar(0.5);
      expect(point.y - top).toBeGreaterThan(0.010);
      expect(point.y - top).toBeLessThan(0.021);
      ray.set(new THREE.Vector3(point.x, point.y, 0.3), new THREE.Vector3(0, 0, -1));
      const hit = ray.intersectObject(skin)[0];
      expect(hit).toBeDefined();
      expect(point.z - hit.point.z).toBeGreaterThan(0);
      expect(point.z - hit.point.z).toBeLessThan(0.004);
    }
  }
  brows.dispose();
  material.dispose();
});

test('lashes are sparse short fibres, not radial spikes', () => {
  const lashes = buildLashes(head.anchors, 'lashes-regression')!;
  expect(widestRibbon(lashes)).toBeLessThan(0.00021);
  const positions = lashes.getAttribute('position');
  expect(positions.count / 6).toBe(48);
  const root = new THREE.Vector3(), tip = new THREE.Vector3();
  for (let i = 0; i < positions.count; i += 6) {
    root.fromBufferAttribute(positions, i);
    tip.fromBufferAttribute(positions, i + 4);
    expect(root.distanceTo(tip)).toBeLessThan(0.0025);
  }
  lashes.dispose();
});

test('Nicușor keeps short curls below a three-centimetre silhouette envelope', () => {
  const nicusor = CAST.nicusor;
  const built = buildHeadGeometry({
    cloud: nicusor.cloud(), chinY: metrics.headY - 0.010, crownY: metrics.headTopY,
    skin: nicusor.skin, beard: nicusor.beardShade, beardColor: nicusor.beardColor,
    tired: nicusor.tired, age: nicusor.age, jawPush: nicusor.jawPush, browPush: nicusor.browPush,
  });
  const hair = buildHairCards(built.anchors, nicusor.hair, 'nicusor-curls')!;
  hair.computeBoundingBox();
  expect(hair.boundingBox!.max.y - built.anchors.crownY).toBeLessThan(0.030);
  expect(widestRibbon(hair)).toBeLessThan(0.0063);
  hair.dispose();
  built.geometry.dispose();
});
