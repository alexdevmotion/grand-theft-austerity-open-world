/** Browser-free export of the runtime cast bodies, fitted heads and animation. */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { buildHumanoidGeometry } from '../../src/characters/humanoid';
import { CAST_APPEARANCES } from '../../src/characters/wardrobe';
import { BONE_NAMES, BI, bodyMetrics, buildRig, NOMINAL_HEIGHT, parentOf } from '../../src/characters/rig';
import { AnimationController } from '../../src/characters/animation';
import { CAST } from '../../src/characters/face/heroHead';
import { buildHeadGeometry } from '../../src/characters/face/headMesh';
import { buildAnatomicalHead, type AnatomicalCast } from '../../src/characters/face/anatomicalHead';
import anatomicalCook from '../../src/characters/face/generated/anatomical-cast.json';
import { BEARD_TOP, buildHairShell, buildHairCards, buildBrows, buildLashes, buildBeard } from '../../src/characters/hair/styles';
import { eyeLayerGeometries } from '../../src/characters/face/eyes';
import type { CastId } from '../../src/characters/face/fitData';

const round = (n: number) => Math.round(n * 1e8) / 1e8;
function mesh(name: string, geo: THREE.BufferGeometry, kind: string, tint?: number) {
  const attr = (key: string) => geo.getAttribute(key) ? Array.from(geo.getAttribute(key).array, round) : undefined;
  return { name, kind, tint, position: attr('position')!, normal: attr('normal'), uv: attr('uv'),
    color: attr('color'), strand: attr('aStrandInfo'), skinIndex: attr('skinIndex'), skinWeight: attr('skinWeight'),
    index: geo.index ? Array.from(geo.index.array) : Array.from({ length: geo.getAttribute('position').count }, (_, i) => i),
    blink: geo.morphAttributes.position?.[0] ? Array.from(geo.morphAttributes.position[0].array, round) : undefined };
}

const assets = [];
for (const id of ['player', 'nicusor', 'ally'] as CastId[]) {
  const a = CAST_APPEARANCES[id], cfg = CAST[id];
  const rig = buildRig(bodyMetrics(a.body, a.female)), m = rig.metrics;
  const body = buildHumanoidGeometry(a, rig);
  const bones = BONE_NAMES.map((name, i) => ({ name, parent: parentOf(name),
    matrix: rig.bones[i].matrixWorld.toArray().map(round), length: rig.points.len[name] }));
  const fallback = buildHeadGeometry({ cloud: cfg.cloud(), chinY: m.headY - .010, crownY: m.headTopY,
    skin: cfg.skin, beard: cfg.beardShade, beardColor: cfg.beardColor, hairColor: cfg.hairColor,
    tired: cfg.tired, age: cfg.age, jawPush: cfg.jawPush, browPush: cfg.browPush,
    hairline: cfg.hair.hairline, beardLine: BEARD_TOP, cols: id === 'player' ? 108 : 86,
    rows: id === 'player' ? 84 : 67, seed: 0 });
  const head = buildAnatomicalHead((anatomicalCook.casts as unknown as Record<CastId, AnatomicalCast>)[id], cfg, fallback);
  if (!head) throw new Error(`Missing anatomical head ${id}`);
  fallback.geometry.dispose();
  const parts = [mesh('body', body, 'body'), mesh('head', head.geometry, 'skin')];
  for (const [name, geometry, color] of [
    ['hair-shell', buildHairShell(head.anchors, cfg.hair), cfg.hairColor],
    ['hair-cards', buildHairCards(head.anchors, cfg.hair, `hair|${id}|0`), cfg.hairColor],
    ['brows', buildBrows(head.anchors, cfg.brow, `brow|${id}|0`), cfg.browColor],
    ['lashes', buildLashes(head.anchors, `lash|${id}|0`), 0x1a1512],
    ['beard', buildBeard(head.anchors, cfg.beard, `beard|${id}|0`), cfg.beardCardColor],
  ] as const) if (geometry) { parts.push(mesh(name, geometry, 'hair', color)); geometry.dispose(); }
  for (const [side, anchor, yaw] of [['L', head.anchors.eyeL, .048], ['R', head.anchors.eyeR, -.048]] as const) {
    const layers = eyeLayerGeometries(anchor, yaw);
    parts.push(mesh(`eye.${side}`, layers.globe, 'eye', cfg.irisColor), mesh(`cornea.${side}`, layers.cornea, 'cornea', 0xffffff));
    layers.globe.dispose(); layers.cornea.dispose();
  }
  // Same fixed head set as HeroHead.group, applied about the head-bone origin.
  // All resulting vertices remain in character bind space for one armature.
  const origin = rig.points.joint.head;
  const headTransform = new THREE.Matrix4().makeTranslation(...origin.toArray()).multiply(
    new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(.022, -.062, .020))).multiply(
      new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
  const headRotation = new THREE.Matrix3().setFromMatrix4(headTransform);
  const v = new THREE.Vector3();
  for (const part of parts.slice(1)) {
    for (let i = 0; i < part.position.length; i += 3) {
      v.fromArray(part.position, i).applyMatrix4(headTransform).toArray(part.position, i);
      if (part.normal) v.fromArray(part.normal, i).applyMatrix3(headRotation).toArray(part.normal, i);
      if (part.blink) v.fromArray(part.blink, i).applyMatrix3(headRotation).toArray(part.blink, i);
    }
  }
  const skinned = new THREE.SkinnedMesh(body, new THREE.MeshBasicMaterial());
  skinned.add(rig.root); skinned.bind(rig.skeleton, new THREE.Matrix4());
  const restLocal = rig.bones.map(b => b.matrix.clone().invert());
  const anim = new AnimationController(rig, 0, 0); anim.handDetail = true;
  const frames = [];
  for (let f = 0; f < 90; f++) {
    anim.drive({ state: 'walk', speed: 1.6, grounded: true });
    anim.update(1 / 30); anim.applyTo(rig); rig.root.updateMatrixWorld(true); rig.skeleton.update();
    if (f < 30) continue;
    frames.push({ frame: f - 29, basis: rig.bones.map((b, i) => restLocal[i].clone().multiply(b.matrix).toArray().map(round)),
      probes: f === 30 || f === 59 || f === 89 ? Array.from({ length: 48 }, (_, n) => {
        const index = Math.floor(n * (body.getAttribute('position').count - 1) / 47);
        v.fromBufferAttribute(body.getAttribute('position'), index); skinned.applyBoneTransform(index, v);
        return { index, position: v.toArray().map(round) };
      }) : undefined });
  }
  assets.push({ id, label: a.id, scale: a.height / NOMINAL_HEIGHT, colors: a.colors, bones, parts, frames, headBone: BI.head });
  body.dispose(); head.geometry.dispose(); (skinned.material as THREE.Material).dispose(); rig.skeleton.dispose();
}
mkdirSync('tools/blender/input', { recursive: true });
writeFileSync('tools/blender/input/bodies.json', JSON.stringify({ version: 1, up: 'Y', units: 'metres', fps: 30, assets }));
console.log(`Exported ${assets.length} full bodies, fitted head assemblies and 42-bone walk actions.`);
