import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { AnimationController } from './animation';
import { buildHumanoidGeometry } from './humanoid';
import { BONE_COUNT, bodyMetrics, buildRig } from './rig';
import { buildTailoredBody } from './tailoredBody';
import { CAST_APPEARANCES, SLOT } from './wardrobe';

for (const appearance of Object.values(CAST_APPEARANCES)) {
  test(`${appearance.cast}: runtime uses authored body topology and normalized game-rig weights`, () => {
    const rig = buildRig(bodyMetrics(appearance.body, appearance.female));
    const geometry = buildHumanoidGeometry(appearance, rig);
    const skinIndex = geometry.getAttribute('skinIndex'), weight = geometry.getAttribute('skinWeight');
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    expect(geometry.userData.anatomicalBody.nativeVertices).toBeGreaterThan(6000);
    expect(geometry.userData.tailoringVertices).toBeGreaterThan(100);
    let invalidWeights = 0, nonFinite = 0, maximumX = 0;
    for (let i = 0; i < position.count; i++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const bone = skinIndex.array[i * 4 + k], w = weight.array[i * 4 + k];
        sum += w;
        if (bone < 0 || bone >= BONE_COUNT || w < 0 || w > 1 || !Number.isFinite(w)) invalidWeights++;
      }
      if (Math.abs(sum - 1) > .00001) invalidWeights++;
      for (let k = 0; k < 3; k++) if (!Number.isFinite(position.array[i*3+k]) || !Number.isFinite(normal.array[i*3+k])) nonFinite++;
      maximumX = Math.max(maximumX, Math.abs(position.getX(i)));
    }
    expect(invalidWeights).toBe(0); expect(nonFinite).toBe(0);
    expect(maximumX).toBeLessThan(.50);
    geometry.dispose(); rig.skeleton.dispose();
  });

  test(`${appearance.cast}: both shoulders remain clothed and have outward-facing surface normals`, () => {
    const rig = buildRig(bodyMetrics(appearance.body, appearance.female));
    const geometry = buildTailoredBody(appearance, rig), bvh = new MeshBVH(geometry, { indirect: true });
    const uv = geometry.getAttribute('uv');
    for (const side of [-1, 1]) {
      for (const x of [.11, .16, .20]) {
        const ray = new THREE.Ray(new THREE.Vector3(x * side, rig.metrics.shoulderY - .012, 1), new THREE.Vector3(0,0,-1));
        const hit = bvh.raycastFirst(ray, THREE.FrontSide);
        expect(hit).not.toBeNull();
        const slot = Math.floor(uv.getX(hit!.face!.a) * 16);
        expect(slot).toBe(appearance.outer === 'none' ? SLOT.TOP : SLOT.OUTER);
        expect(hit!.face!.normal.z).toBeGreaterThan(0);
      }
    }
    geometry.dispose(); rig.skeleton.dispose();
  });

  test(`${appearance.cast}: native body remains finite through locomotion and a seated driving pose`, () => {
    const rig = buildRig(bodyMetrics(appearance.body, appearance.female));
    const geometry = buildHumanoidGeometry(appearance, rig);
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
    mesh.add(rig.root); mesh.bind(rig.skeleton); mesh.updateMatrixWorld(true);
    const anim = new AnimationController(rig, 3); anim.handDetail = true;
    const position = geometry.getAttribute('position'), tmp = new THREE.Vector3();
    for (const state of ['walk', 'sprint', 'crouchIdle', 'drive'] as const) {
      for (let frame = 0; frame < 45; frame++) {
        anim.drive({ state: state === 'drive' ? 'idle' : state, speed: state === 'sprint' ? 7 : state === 'walk' ? 2 : 0,
          grounded: true, ...(state === 'drive' ? { board: { sit: 1, reach: .4, side: 1 as const, closing: false } } : {}) });
        anim.update(1/60);
      }
      anim.applyTo(rig); mesh.updateMatrixWorld(true); rig.skeleton.update();
      let nonFinite = 0, widest = 0, lowest = Infinity, highest = -Infinity;
      for (let i = 0; i < position.count; i++) {
        tmp.fromBufferAttribute(position, i); mesh.applyBoneTransform(i, tmp);
        if (![tmp.x, tmp.y, tmp.z].every(Number.isFinite)) nonFinite++;
        widest = Math.max(widest, Math.abs(tmp.x)); lowest = Math.min(lowest,tmp.y); highest = Math.max(highest,tmp.y);
      }
      expect(nonFinite).toBe(0); expect(widest).toBeLessThan(.90);
      expect(lowest).toBeGreaterThan(-.30); expect(highest).toBeLessThan(1.90);
      // Native fingers still follow the appended digit bones; the existing
      // body contract (hands at 9/13, toes at 17/21) remains unchanged.
    }
    geometry.dispose(); mesh.material.dispose(); rig.skeleton.dispose();
  });
}

test('jacket and suit hems overlap the trouser waist as separate cloth surfaces', () => {
  for (const appearance of [CAST_APPEARANCES.player, CAST_APPEARANCES.nicusor]) {
    const rig = buildRig(bodyMetrics(appearance.body, appearance.female));
    const geometry = buildTailoredBody(appearance, rig);
    const pos = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
    let hem = 0, underlyingTrouser = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i), x = Math.abs(pos.getX(i)), slot = Math.floor(uv.getX(i)*16);
      if (x < .20 && y > rig.metrics.hipY-.13 && y < rig.metrics.hipY-.025) {
        if (slot === SLOT.OUTER) hem++; if (slot === SLOT.LEGS) underlyingTrouser++;
      }
    }
    expect(hem).toBeGreaterThan(10); expect(underlyingTrouser).toBeGreaterThan(10);
    geometry.dispose(); rig.skeleton.dispose();
  }
});

test('short sleeves expose the entire forearm and suit shirts have a continuous insert', () => {
  for (const appearance of [CAST_APPEARANCES.ally, CAST_APPEARANCES.nicusor]) {
    const rig=buildRig(bodyMetrics(appearance.body,appearance.female));
    const g=buildTailoredBody(appearance,rig), bvh=new MeshBVH(g,{indirect:true}), uv=g.getAttribute('uv');
    const ray=new THREE.Ray(new THREE.Vector3(),new THREE.Vector3(0,0,-1));
    if(appearance.cast==='ally') {
      for(const side of ['L','R'] as const) for(const t of [.2,.5,.8]) {
        const point=rig.points.joint[`forearm${side}`].clone().lerp(rig.points.joint[`hand${side}`],t);
        ray.origin.set(point.x,point.y,1);
        const hit=bvh.raycastFirst(ray,THREE.FrontSide);
        expect(hit).not.toBeNull();
        expect(Math.floor(uv.getX(hit!.face!.a)*16)).toBe(SLOT.SKIN);
      }
    } else {
      for(const y of [rig.metrics.yokeY+.025,rig.metrics.yokeY-.03,rig.metrics.chestY+.025]) {
        ray.origin.set(0,y,1);
        const hit=bvh.raycastFirst(ray,THREE.FrontSide);
        expect(hit).not.toBeNull();
        expect(Math.floor(uv.getX(hit!.face!.a)*16)).toBe(SLOT.TOP);
      }
    }
    g.dispose();rig.skeleton.dispose();
  }
});

test('male chest cloth bridges the source pectoral hollows', () => {
  for(const appearance of Object.values(CAST_APPEARANCES)) {
    const rig=buildRig(bodyMetrics(appearance.body,appearance.female));
    const g=buildTailoredBody(appearance,rig),bvh=new MeshBVH(g,{indirect:true});
    const z = (x:number):number => bvh.raycastFirst(new THREE.Ray(
      new THREE.Vector3(x,rig.metrics.chestY+.105,1),new THREE.Vector3(0,0,-1)),THREE.FrontSide)!.point.z;
    const centre=z(0);
    expect(z(-.075)).toBeLessThan(centre+.012);
    expect(z(.075)).toBeLessThan(centre+.012);
    g.dispose();rig.skeleton.dispose();
  }
});

test('suit lapels and shirt details remain outside the native chest between their vertices', () => {
  const a = CAST_APPEARANCES.nicusor, rig = buildRig(bodyMetrics(a.body, a.female));
  const g = buildTailoredBody(a, rig), p = g.getAttribute('position');
  const detailStart = p.count - g.userData.tailoringVertices;
  const base = g.clone();
  const indices = Array.from(g.index!.array);
  base.setIndex(indices.filter((_, i) => indices[Math.floor(i / 3) * 3] < detailStart));
  const tree = new MeshBVH(base, { indirect: true });
  let probes = 0, intersections = 0;
  for (let i = 0; i < indices.length; i += 3) {
    if (indices[i] < detailStart) continue;
    const v = indices.slice(i, i + 3).map(index => new THREE.Vector3().fromBufferAttribute(p, index));
    const point = v[0].clone().add(v[1]).add(v[2]).multiplyScalar(1 / 3);
    if (point.y < rig.metrics.chestY || point.y > rig.metrics.neckY - .04 || point.z < .05) continue;
    const hit = tree.raycastFirst(new THREE.Ray(new THREE.Vector3(point.x, point.y, 1), new THREE.Vector3(0, 0, -1)), THREE.FrontSide);
    if (!hit) continue;
    probes++;
    if (point.z < hit.point.z + .002) intersections++;
  }
  expect(probes).toBeGreaterThan(40);
  expect(intersections).toBe(0);
  base.dispose(); g.dispose(); rig.skeleton.dispose();
});
