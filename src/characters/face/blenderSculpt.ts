import * as THREE from 'three';
import cooked from './generated/cast-sculpts.json';
import type { CastId } from './fitData';
import type { HeadFrame } from './headMesh';

type Offset = [number, number, number, number];
interface Sculpt { vertices: number; sculpt: Offset[]; blink: Offset[] }
const SCULPTS = cooked.heads as unknown as Record<string, Sculpt>;

/** Blender keeps vertex order and cooks offsets in fitted units. The actor's
 * head frame supplies scale, so the same sculpt fits every supported body. */
export function applyBlenderSculpt(geometry: THREE.BufferGeometry, id: CastId, detail: number, frame: HeadFrame): boolean {
  const asset = SCULPTS[`${id}:${detail}`];
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (!asset || asset.vertices !== position.count) return false;
  for (const [i, x, y, z] of asset.sculpt) {
    position.setXYZ(i, position.getX(i) + x * frame.scale, position.getY(i) + y * frame.scale, position.getZ(i) + z * frame.scale);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  const delta = new Float32Array(position.count * 3);
  for (const [i, x, y, z] of asset.blink) {
    delta[i * 3] = x * frame.scale;
    delta[i * 3 + 1] = y * frame.scale;
    delta[i * 3 + 2] = z * frame.scale;
  }
  const blink = new THREE.BufferAttribute(delta, 3);
  blink.name = 'Blink';
  geometry.morphAttributes.position = [blink];
  geometry.morphTargetsRelative = true;
  geometry.computeBoundingSphere();
  geometry.userData.blenderSculpt = `${id}:${detail}`;
  return true;
}

/** Short asymmetric closure/reopening, with per-actor phase to avoid a
 * synchronized cast. Elapsed time freezes with the game's pause state. */
export function blinkWeight(elapsed: number, phase: number): number {
  const cycle = 3.7 + phase * 1.8;
  const t = ((elapsed + phase * cycle) % cycle + cycle) % cycle;
  if (t > 0.19) return 0;
  const x = t < 0.065 ? t / 0.065 : 1 - (t - 0.065) / 0.125;
  return x * x * (3 - 2 * x);
}
