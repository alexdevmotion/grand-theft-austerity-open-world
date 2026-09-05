import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { CastConfig } from './heroHead';
import type { EyeAnchor, HeadResult } from './headMesh';
import { BROW_L_TOP, BROW_R_TOP, FACE_OVAL, LIPS_OUTER } from './landmarks';

export interface AnatomicalEye {
  centre: number[];
  radius: number;
  irisRadius: number;
  ring: number[][];
  forward?: number[];
}
export interface AnatomicalCast {
  position: number[];
  index: number[];
  uv?: number[];
  normal?: number[];
  blink?: number[];
  anchors: {
    eyeL: AnatomicalEye;
    eyeR: AnatomicalEye;
    chinY: number;
    crownY: number;
    templeHalf: number;
    headDepth: number;
    neckY: number;
  };
}

/** Native anatomical topology shares the existing head-bone frame. The old
 * procedural result supplies a safe fallback for missing or malformed cooks. */
export function buildAnatomicalHead(asset: AnatomicalCast | undefined, cfg: CastConfig, fallback: HeadResult): HeadResult | null {
  if (!asset || asset.position.length < 300 || asset.position.length % 3 ||
      !asset.position.every(Number.isFinite) || !asset.index.length) return null;
  const count = asset.position.length / 3;
  if (asset.index.some(i => !Number.isInteger(i) || i < 0 || i >= count)) return null;
  const f = fallback.anchors.frame;
  const pos = new Float32Array(asset.position.length);
  const color = new Float32Array(asset.position.length);
  const skin = new Float32Array(count * 4);
  const base = new THREE.Color(cfg.skin), hair = new THREE.Color(cfg.hairColor), beard = new THREE.Color(cfg.beardColor);
  const tint = new THREE.Color(), lip = base.clone().lerp(new THREE.Color(0x9b514d), 0.28);
  const cloud = cfg.cloud();
  const mouthY = (cloud[13 * 3 + 1] + cloud[14 * 3 + 1]) * 0.5;
  const mouthHalf = Math.abs(cloud[61 * 3] - cloud[291 * 3]) * 0.5;
  const smooth = (a: number, b: number, x: number): number => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < count; i++) {
    const x = asset.position[i * 3], y = asset.position[i * 3 + 1], z = asset.position[i * 3 + 2];
    pos[i * 3] = x * f.scale + f.ox;
    pos[i * 3 + 1] = y * f.scale + f.oy;
    pos[i * 3 + 2] = z * f.scale + f.oz;
    const az = Math.atan2((x - 0.006) / 0.392, (z + 0.290) / 0.424);
    const el = Math.atan2((y + 0.055) / 0.672, Math.hypot((x - 0.006) / 0.392, (z + 0.290) / 0.424));
    const scalp = smooth(cfg.hair.hairline(az) - 0.015, cfg.hair.hairline(az) + 0.025, el);
    const front = smooth(-0.13, 0.04, z);
    const lipMask = Math.exp(-Math.pow(x / Math.max(0.09, mouthHalf), 6) - Math.pow((y - mouthY) / 0.035, 4)) * front;
    const lowerFace = smooth(-0.29, -0.44, y);
    // Keep colour variation below the scale of the facial planes. Geometric
    // shadows and the skin shader supply the relief; no cavity is baked here.
    const mottle = Math.sin(x * 73 + y * 39) * Math.sin(y * 67 - z * 41) * 0.012;
    tint.copy(base).multiplyScalar(1 + mottle).lerp(lip, lipMask * 0.8);
    const beardMask = cfg.beardShade * lowerFace * (1 - smooth(-0.66, -0.80, y)) * (1 - lipMask) * smooth(-0.32, -0.12, z);
    tint.lerp(beard, beardMask * 0.72).lerp(hair, scalp * 0.96);
    color[i * 3] = tint.r; color[i * 3 + 1] = tint.g; color[i * 3 + 2] = tint.b;
    skin[i * 4] = 15;
    skin[i * 4 + 1] = Math.abs(x) > 0.36 ? 0.75 : 0.18;
    skin[i * 4 + 2] = 1;
    skin[i * 4 + 3] = 0.56 - lipMask * 0.14;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aSkin', new THREE.BufferAttribute(skin, 4));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(asset.uv?.length === count * 2 ? asset.uv : new Float32Array(count * 2), 2));
  geometry.setIndex(asset.index);
  if (asset.normal?.length === pos.length && asset.normal.every(Number.isFinite)) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(asset.normal, 3));
    geometry.normalizeNormals();
  } else geometry.computeVertexNormals();
  if (asset.blink?.length === pos.length && asset.blink.every(Number.isFinite)) {
    const blink = new THREE.Float32BufferAttribute(asset.blink.map(v => v * f.scale), 3);
    blink.name = 'Blink';
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [blink];
  }
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  geometry.userData.anatomicalCast = cfg.id;

  // Direct BVH queries stay in character-local metres and preserve triangle
  // ordering. No global Three prototypes or body-rig contracts are changed.
  const bvh = new MeshBVH(geometry, { indirect: true });
  const centre = new THREE.Vector3(f.ox + 0.006 * f.scale, f.oy - 0.055 * f.scale, f.oz - 0.290 * f.scale);
  const ray = new THREE.Ray(), direction = new THREE.Vector3();
  const surface = (az: number, el: number, grow: number, out: THREE.Vector3): THREE.Vector3 => {
    direction.set(0.392 * Math.cos(el) * Math.sin(az), 0.672 * Math.sin(el), 0.424 * Math.cos(el) * Math.cos(az)).normalize();
    ray.origin.copy(centre).addScaledVector(direction, f.scale * 2);
    ray.direction.copy(direction).negate();
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
    if (!hit) return fallback.anchors.surface(az, el, grow, out);
    return out.copy(hit.point).addScaledVector(direction, grow * f.scale);
  };
  const point = (p: number[]): THREE.Vector3 => new THREE.Vector3(p[0] * f.scale + f.ox, p[1] * f.scale + f.oy, p[2] * f.scale + f.oz);
  const eye = (a: AnatomicalEye): EyeAnchor => ({
    centre: point(a.centre), radius: a.radius * f.scale, irisRadius: a.irisRadius * f.scale,
    ring: a.ring.map(point), forward: new THREE.Vector3(...(a.forward ?? [0, 0, 1]) as [number, number, number]).normalize(),
  });
  const curve = (ids: readonly number[]): THREE.Vector3[] => ids.map(i => {
    const p = point(Array.from(cloud.subarray(i * 3, i * 3 + 3)));
    ray.origin.set(p.x, p.y, f.oz + f.scale * 2); ray.direction.set(0, 0, -1);
    return bvh.raycastFirst(ray, THREE.DoubleSide)?.point.clone() ?? p;
  });
  const anchors = {
    ...fallback.anchors, eyeL: eye(asset.anchors.eyeL), eyeR: eye(asset.anchors.eyeR),
    browL: curve(BROW_L_TOP), browR: curve(BROW_R_TOP), lips: curve(LIPS_OUTER), oval: curve(FACE_OVAL),
    surface, templeHalf: asset.anchors.templeHalf * f.scale, headDepth: asset.anchors.headDepth * f.scale,
    skullVertexCount: count,
  };
  return { geometry, anchors };
}
