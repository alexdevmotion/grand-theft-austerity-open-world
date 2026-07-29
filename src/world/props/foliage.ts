/**
 * Foliage: late-autumn Bucharest. Thinning amber crowns, bare inner branches,
 * clipped hedges, planters, verges and the leaf litter that ends up all over
 * the wet pavement.
 *
 * Trees are built from a trunk, real branches and a handful of low-poly leaf
 * clusters rather than one cone, because against a bright magenta sky a cone
 * reads as a dark kite on a stick — the single most common giveaway that a
 * street is procedural.
 *
 * OWNER: props / street-dressing agent.
 */

import * as THREE from 'three';
import type { Rng } from '../../core/rng';
import { MR, PropBuilder, PropColor as C, type PropOpts } from './kit';
import { WALK_Y } from './streetFurniture';

const opt = (color: PropOpts['color'], mr: PropOpts['mr']): PropOpts => ({ color, mr });

/**
 * Foliage carries a small self-emissive term. The sun in this game sits three
 * degrees above the horizon and BEHIND the camera-facing side of every street
 * tree, so a physically-correct crown renders as a black hole punched in a
 * magenta sky. The reference frame's trees are dark but they are not black —
 * they hold a dim amber. This is the cheapest way to get that, and it costs
 * nothing per frame.
 */
const leafOpt = (color: PropOpts['color'], gain = 0.35): PropOpts =>
  ({ color, mr: MR.leaf, emissive: [color.r * gain, color.g * gain, color.b * gain] });

/**
 * Radians of normal scatter applied to every leaf cluster. +-40 degrees, which
 * is enough that a crown backlit by the sunset breaks into lit and unlit facets
 * instead of turning into a single black octagon.
 */
const LEAF_NORMAL_JITTER = 0.7;

/* ------------------------------------------------------------------ */
/* Trees                                                               */
/* ------------------------------------------------------------------ */

/**
 * Autumn street tree. `thin` 0..1 controls how much of the crown has already
 * dropped: at 1 you get bare branches with a few clinging clusters.
 * ~230 triangles at full crown.
 */
export function autumnTree(
  b: PropBuilder, x: number, z: number, rng: Rng,
  scale = 1, thin = rng.range(0.25, 0.7),
): void {
  const h = rng.range(6.0, 9.5) * scale;
  const trunkH = h * 0.42;
  const trunkR = 0.19 * scale;
  // A trunk backlit at three degrees is the same trap as the crown: a pure
  // albedo trunk goes to black. A little self-emissive keeps it a dark umber.
  const bark: PropOpts = { color: C.bark, mr: [0, 0.9], emissive: [C.bark.r * 0.22, C.bark.g * 0.22, C.bark.b * 0.22] };

  b.cyl(x, WALK_Y - 0.05, z, trunkR * 1.5, trunkR * 0.82, trunkH, 6, bark, false);
  // Root flare.
  b.cyl(x, WALK_Y - 0.06, z, trunkR * 2.0, trunkR * 1.45, 0.22, 6, bark, false);

  const crownY = WALK_Y + trunkH;
  const crownR = rng.range(1.9, 3.0) * scale;
  const crownH = h - trunkH;

  // Primary branches radiating out and up.
  const nBranch = 4 + rng.int(0, 3);
  const tips: Array<[number, number, number]> = [];
  for (let i = 0; i < nBranch; i++) {
    const a = (i / nBranch) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const reach = crownR * rng.range(0.55, 0.95);
    const rise = crownH * rng.range(0.4, 0.75);
    const tx = x + Math.cos(a) * reach;
    const tz = z + Math.sin(a) * reach;
    const ty = crownY + rise;
    b.tube(x, crownY - 0.2, z, tx, ty, tz, trunkR * 0.42, 4, bark);
    tips.push([tx, ty, tz]);
    // One fork per branch.
    if (rng.bool(0.7)) {
      const fx = tx + Math.cos(a + rng.range(-0.9, 0.9)) * crownR * 0.4;
      const fz = tz + Math.sin(a + rng.range(-0.9, 0.9)) * crownR * 0.4;
      const fy = ty + crownH * 0.22;
      b.tube(tx, ty, tz, fx, fy, fz, trunkR * 0.24, 3, bark);
      tips.push([fx, fy, fz]);
    }
  }
  // A leader through the middle.
  b.tube(x, crownY - 0.2, z, x + rng.range(-0.3, 0.3), crownY + crownH * 0.85, z + rng.range(-0.3, 0.3),
    trunkR * 0.5, 4, bark);

  // Leaf clusters hung on the branch tips. Thinning drops clusters entirely
  // rather than shrinking them, which is what real late-autumn crowns do.
  // Colour: the crown is backlit by a magenta sky, so the outer clusters have
  // to be genuinely GOLD, not brown. A crown authored at the palette's amber
  // reads as a dark maroon lump against the sunset — the exact failure the
  // reference frame does not have.
  const amberBias = rng.range(0.55, 0.98);
  for (let i = 0; i < tips.length; i++) {
    if (rng.next() < thin * 0.5) continue;
    const [tx, ty, tz] = tips[i];
    const cr = crownR * rng.range(0.36, 0.62);
    const leafC = rng.next() < amberBias
      ? rng.weighted([C.leafGold, C.leafAmber, C.leafPale, C.leafRust], [4, 3, 2, 2])
      : C.leafOlive;
    // TWO small clusters per tip rather than one large one, at the same
    // triangle cost. A single blob per branch gives a crown made of clean
    // octagons; two overlapping ones give a ragged edge, and silhouette is
    // the only thing that reads on a tree backlit by a magenta sky.
    for (let k = 0; k < 2; k++) {
      const kr = cr * (k === 0 ? 0.82 : 0.62);
      b.blob(
        tx + rng.range(-0.45, 0.45), ty + rng.range(-0.1, 0.6), tz + rng.range(-0.45, 0.45),
        kr, kr * rng.range(0.6, 0.95), kr,
        leafOpt(k === 0 ? leafC : rng.weighted([C.leafGold, C.leafPale, C.leafRust], [3, 2, 2]), 0.38),
        0.75, 101 + i * 7 + k * 31, 1, LEAF_NORMAL_JITTER,
      );
    }
  }
  // A looser mass at the centre so the crown is not see-through from every
  // angle. Kept smaller and lighter than the ring of clusters, so it fills
  // rather than dominating the silhouette.
  if (thin < 0.6) {
    const cr = crownR * 0.6;
    b.blob(x, crownY + crownH * 0.46, z, cr, cr * 0.66, cr,
      leafOpt(rng.bool(0.35) ? C.leafOlive : C.leafGold, 0.30), 0.55, 77, 2, LEAF_NORMAL_JITTER);
  }
}

/** Cast-iron tree grate + guard around a street tree. */
export function treeGrate(b: PropBuilder, x: number, z: number, rng: Rng): void {
  const iron = opt(C.steelDark, MR.metal);
  b.ground(x, WALK_Y + 0.005, z, 1.5, 1.5, 0, opt(C.bitumen, [0.2, 0.8]));
  for (let i = 0; i < 4; i++) {
    const t = (i - 1.5) * 0.36;
    b.box(x + t, WALK_Y + 0.02, z, 0.05, 0.03, 1.5, 0, iron);
  }
  if (rng.bool(0.45)) {
    // Hooped guard.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.box(x + Math.cos(a) * 0.5, WALK_Y + 0.4, z + Math.sin(a) * 0.5, 0.04, 0.8, 0.04, a, iron);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Hedges, planters, verges                                            */
/* ------------------------------------------------------------------ */

/**
 * Clipped hedge run. Built as overlapping blobs so the top is ragged rather
 * than a green brick.
 */
export function hedgeRow(
  b: PropBuilder,
  x: number, z: number,
  dirX: number, dirZ: number,
  length: number, height: number,
  rng: Rng,
): void {
  const n = Math.max(2, Math.round(length / 1.25));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) * (length / n);
    const px = x + dirX * t;
    const pz = z + dirZ * t;
    const c = rng.bool(0.28) ? C.leafRust : C.leafOlive;
    b.blob(
      px, WALK_Y + height * 0.5, pz,
      0.55, height * rng.range(0.48, 0.58), 0.55,
      leafOpt(c, 0.24), 0.35, 401 + i * 13, 2, LEAF_NORMAL_JITTER * 0.7,
    );
  }
  // Low kerb the hedge sits in.
  b.box(x + dirX * length / 2, WALK_Y + 0.09, z + dirZ * length / 2,
    Math.abs(dirX) > 0.5 ? length : 1.1, 0.18, Math.abs(dirX) > 0.5 ? 1.1 : length, 0,
    opt(C.concreteDark, MR.stone));
}

/** Concrete planter with a shrub and a few cigarette ends in the soil. */
export function planter(b: PropBuilder, x: number, z: number, rng: Rng): void {
  const w = rng.range(1.0, 1.6);
  const h = rng.range(0.5, 0.75);
  const yaw = rng.range(0, Math.PI);
  b.openBox(x, WALK_Y + h / 2, z, w, h, w, yaw, opt(C.concrete, MR.stone));
  b.box(x, WALK_Y + h - 0.06, z, w - 0.16, 0.1, w - 0.16, yaw, opt(C.bark, [0, 0.96]));
  const shrubs = 1 + rng.int(0, 3);
  for (let i = 0; i < shrubs; i++) {
    const c = rng.weighted([C.leafOlive, C.leafAmber, C.leafRust], [3, 2, 1]);
    b.blob(
      x + rng.range(-w * 0.22, w * 0.22), WALK_Y + h + rng.range(0.18, 0.42), z + rng.range(-w * 0.22, w * 0.22),
      rng.range(0.22, 0.4), rng.range(0.2, 0.36), rng.range(0.22, 0.4),
      leafOpt(c, 0.26), 0.5, 601 + i * 11, 2, LEAF_NORMAL_JITTER * 0.7,
    );
  }
}

/** Rough grass verge tufts — cheap, for park edges and unloved corners. */
export function grassTufts(
  b: PropBuilder, x: number, z: number, radius: number, n: number, rng: Rng, y = WALK_Y,
): void {
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * radius;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    const c = rng.bool(0.3) ? C.leafAmber : C.leafOlive;
    b.blob(px, y + 0.1, pz, rng.range(0.16, 0.34), rng.range(0.1, 0.22), rng.range(0.16, 0.34),
      leafOpt(c, 0.2), 0.6, 811 + i * 3, 1, LEAF_NORMAL_JITTER * 0.6);
  }
}

/**
 * Fallen leaves. Flat quads lying in the gutter and drifted against kerbs —
 * the single cheapest thing that makes a wet pavement read as October.
 */
export function leafLitter(
  b: PropBuilder, x: number, z: number, radius: number, n: number, rng: Rng, y = WALK_Y,
): void {
  for (let i = 0; i < n; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * radius;
    const c = rng.weighted([C.leafGold, C.leafAmber, C.leafRust, C.leafOlive, C.paperDim], [5, 4, 3, 2, 1]);
    b.ground(
      x + Math.cos(a) * r, y + 0.006 + (i % 3) * 0.002, z + Math.sin(a) * r,
      rng.range(0.1, 0.2), rng.range(0.07, 0.14), rng.range(0, Math.PI),
      leafOpt(c, 0.22),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Drifting leaves in the wind                                         */
/* ------------------------------------------------------------------ */

const DRIFT_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uOrigin;
uniform float uRange;
attribute vec3 aSeed;
attribute vec3 aTint;
varying vec3 vTint;
varying float vShade;

void main() {
  float t = uTime * (0.4 + aSeed.z * 0.5);
  // Wrap a slab of world around the camera so the field is always populated.
  vec3 p;
  p.x = mod(aSeed.x * uRange + t * 5.2 - uOrigin.x + uRange * 0.5, uRange) + uOrigin.x - uRange * 0.5;
  p.z = mod(aSeed.y * uRange + t * 2.1 - uOrigin.z + uRange * 0.5, uRange) + uOrigin.z - uRange * 0.5;
  // Height: a slow bob plus a gust that lifts leaves off the ground.
  float bob = sin(t * 2.1 + aSeed.x * 40.0) * 0.5 + 0.5;
  p.y = uOrigin.y - 1.6 + bob * bob * (0.4 + aSeed.z * 3.4);
  p.x += sin(t * 1.7 + aSeed.y * 33.0) * 1.4;
  p.z += cos(t * 1.3 + aSeed.x * 21.0) * 1.2;

  // Tumble: build a rotating frame per leaf.
  float a = t * (2.0 + aSeed.z * 4.0) + aSeed.x * 12.0;
  float ca = cos(a);
  float sa = sin(a);
  vec3 right = normalize(vec3(ca, sa * 0.8, sa));
  vec3 up = normalize(cross(right, vec3(sa, ca, 0.3)));
  vec3 world = p + right * position.x * 0.095 + up * position.y * 0.055;

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  vTint = aTint;
  // Fake lighting: leaves flash as they present their face to the sun.
  vShade = 0.45 + 0.55 * abs(dot(normalize(cross(right, up)), normalize(vec3(-0.95, 0.06, -0.31))));
  // Fade at the edge of the slab so leaves do not pop.
  float d = length(p.xz - uOrigin.xz);
  vShade *= 1.0 - smoothstep(uRange * 0.32, uRange * 0.48, d);
}
`;

const DRIFT_FRAG = /* glsl */ `
varying vec3 vTint;
varying float vShade;
void main() {
  if (vShade < 0.02) discard;
  gl_FragColor = vec4(vTint * vShade, 1.0);
  #include <colorspace_fragment>
}
`;

/** A slab of wind-blown leaves that follows the camera. One draw call. */
export class LeafDrift {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: {
    uTime: { value: number };
    uOrigin: { value: THREE.Vector3 };
    uRange: { value: number };
  };

  constructor(count: number, range: number, rng: Rng) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.instanceCount = count;

    const seed = new Float32Array(count * 3);
    const tint = new Float32Array(count * 3);
    const cols = [C.leafGold, C.leafAmber, C.leafRust, C.leafPale, C.paperDim];
    for (let i = 0; i < count; i++) {
      seed[i * 3] = rng.next();
      seed[i * 3 + 1] = rng.next();
      seed[i * 3 + 2] = rng.next();
      const c = cols[rng.int(0, cols.length)];
      const k = rng.range(0.7, 1.25);
      tint[i * 3] = c.r * k;
      tint[i * 3 + 1] = c.g * k;
      tint[i * 3 + 2] = c.b * k;
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 3));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      uTime: { value: 0 },
      uOrigin: { value: new THREE.Vector3() },
      uRange: { value: range },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DRIFT_VERT,
      fragmentShader: DRIFT_FRAG,
      side: THREE.DoubleSide,
      transparent: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'props-leafdrift';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    base.dispose();
  }

  update(time: number, camera: THREE.Object3D): void {
    this.uniforms.uTime.value = time;
    camera.getWorldPosition(this.uniforms.uOrigin.value);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
