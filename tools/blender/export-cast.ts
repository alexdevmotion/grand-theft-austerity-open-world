/** Export the runtime topology, in metres, for the reproducible Blender sculpt. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { CAST } from '../../src/characters/face/heroHead';
import { buildHeadGeometry } from '../../src/characters/face/headMesh';
import { BEARD_TOP, buildHairShell, buildHairCards, buildBrows, buildLashes, buildBeard } from '../../src/characters/hair/styles';
import { eyeLayerGeometries } from '../../src/characters/face/eyes';
import { bodyMetrics } from '../../src/characters/rig';
import type { CastId } from '../../src/characters/face/fitData';

const m = bodyMetrics('average', false);
function assemblyPart(name: string, geo: THREE.BufferGeometry, color: number, kind: 'hair' | 'eye' | 'cornea', rootDark = 0) {
  const attr = (key: string) => geo.getAttribute(key) ? Array.from(geo.getAttribute(key).array) : undefined;
  const uv = geo.getAttribute('uv');
  const strand = geo.getAttribute('aStrandInfo');
  const rgb: number[] = [];
  const base = new THREE.Color(color);
  for (let i = 0; i < geo.getAttribute('position').count; i++) {
    const c = base.clone();
    if (kind === 'eye') {
      const u = uv.getX(i), v = uv.getY(i);
      if (u <= 0.5) c.setHex(0xc9c0b2);
      else {
        const r = Math.hypot(u - 0.75, v - 0.5) / 0.235;
        const angle = Math.atan2(v - 0.5, u - 0.75);
        if (r < 0.25) c.setRGB(0.002, 0.002, 0.002);
        else c.multiplyScalar((r > 0.88 ? 0.36 : 0.74) + Math.sin(angle * 38) * 0.10);
      }
    } else if (strand) {
      c.multiplyScalar(1 - rootDark + rootDark * strand.getX(i));
      c.lerp(new THREE.Color(0.115, 0.112, 0.108), strand.getY(i));
    }
    rgb.push(c.r, c.g, c.b);
  }
  return { name, kind, position: attr('position')!, normal: attr('normal'), uv: attr('uv'), color: rgb,
    strandInfo: attr('aStrandInfo'), index: geo.index ? Array.from(geo.index.array) : undefined };
}
const assets = [];
for (const id of Object.keys(CAST) as CastId[]) {
  const cfg = CAST[id];
  for (const detail of [1, 0.8]) {
    const { geometry, anchors } = buildHeadGeometry({
      cloud: cfg.cloud(), chinY: m.headY - 0.010, crownY: m.headTopY,
      skin: cfg.skin, beard: cfg.beardShade, beardColor: cfg.beardColor,
      hairColor: cfg.hairColor, tired: cfg.tired, age: cfg.age,
      jawPush: cfg.jawPush, browPush: cfg.browPush,
      hairline: cfg.hair.hairline, beardLine: BEARD_TOP,
      cols: Math.round(108 * detail), rows: Math.round(84 * detail), seed: 0,
    });
    const attribute = (name: string) => Array.from(geometry.getAttribute(name).array);
    const assembly: ReturnType<typeof assemblyPart>[] = [];
    if (detail === 1) {
      for (const [name, geo, color, rootDark] of [
        ['hair-shell', buildHairShell(anchors, cfg.hair), cfg.hairColor, 0.34],
        ['hair-cards', buildHairCards(anchors, cfg.hair, `hair|${cfg.id}|0`), cfg.hairColor, 0.30],
        ['brows', buildBrows(anchors, cfg.brow, `brow|${cfg.id}|0`), cfg.browColor, 0.10],
        ['lashes', buildLashes(anchors, `lash|${cfg.id}|0`), 0x1a1512, 0],
        ['beard', buildBeard(anchors, cfg.beard, `beard|${cfg.id}|0`), cfg.beardCardColor, 0.22],
      ] as const) {
        if (geo) { assembly.push(assemblyPart(name, geo, color, 'hair', rootDark)); geo.dispose(); }
      }
      for (const [side, anchor, yaw] of [['left', anchors.eyeL, 0.048], ['right', anchors.eyeR, -0.048]] as const) {
        const layers = eyeLayerGeometries(anchor, yaw);
        assembly.push(assemblyPart(`eye.${side}`, layers.globe, cfg.irisColor, 'eye'));
        assembly.push(assemblyPart(`cornea.${side}`, layers.cornea, 0xffffff, 'cornea'));
        layers.globe.dispose(); layers.cornea.dispose();
      }
    }
    assets.push({ id, detail, frame: anchors.frame,
      fitCloud: Array.from(cfg.cloud()),
      castAppearance: { skin: cfg.skin, irisColor: cfg.irisColor, hairColor: cfg.hairColor, browColor: cfg.browColor },
      position: attribute('position'), color: attribute('color'),
      skin: attribute('aSkin'), uv: attribute('uv'),
      index: Array.from(geometry.index!.array),
      eyes: [anchors.eyeL, anchors.eyeR].map(e => ({ centre: e.centre.toArray(), radius: e.radius })),
      assembly,
    });
    geometry.dispose();
  }
}
const out = resolve('tools/blender/input/cast.json');
mkdirSync(resolve('tools/blender/input'), { recursive: true });
writeFileSync(out, JSON.stringify({ version: 1, units: 'metres', up: 'Y', assets }));
console.log(`Exported ${assets.length} cast heads to ${out}`);
