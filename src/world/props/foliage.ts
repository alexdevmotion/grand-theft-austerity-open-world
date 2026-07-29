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
 * FOLIAGE SHADING.
 *
 * A leaf is not an opaque surface. The sun in this game sits three degrees
 * above the horizon, so every street tree is lit from BEHIND: a physically
 * opaque crown renders as a black hole punched in a magenta sky, which is
 * exactly what the previous pass produced. Real late-autumn foliage backlit
 * like that is the brightest amber in the frame.
 *
 * Two mechanisms, and the split matters:
 *   `trans`     drives a real wrapped back-scatter + forward-scatter lobe in
 *               the prop shader (see `PropOpts.trans` in kit.ts). It responds
 *               to the sun's actual direction, so a crown lights up as you
 *               walk around it and goes dark when the sun is behind you.
 *   `emissive`  a small unconditional floor so a crown in full shadow still
 *               holds a dim olive rather than going to zero. Deliberately
 *               much smaller than it used to be: it is a floor, not the look.
 */
const leafOpt = (color: PropOpts['color'], gain = 0.12, trans = 0.85): PropOpts =>
  ({ color, mr: MR.leaf, emissive: [color.r * gain, color.g * gain, color.b * gain], trans });

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
  scale = 1, thin = rng.range(0.35, 0.78),
  /** 2 = full detail, 1 = mid, 0 = distant silhouette. Halves the cluster count. */
  lod: 0 | 1 | 2 = 2,
): void {
  /*
   * SCALE. A mature Bucharest street plane tree is 8-11 m to the crown top on a
   * 2.2-3.2 m clear trunk, with a crown 4-6 m ACROSS — not the 6 m radius the
   * previous authoring produced. Cross-checks that matter, because both are in
   * frame constantly: a 1.8 m person reaches a third of the way up the trunk,
   * and the 7.2-9.4 m lamp heads sit level with the top of the crown.
   */
  const h = rng.range(8.0, 11.0) * scale;
  const trunkH = rng.range(2.4, 3.4) * scale;
  const trunkR = 0.155 * scale;
  // A trunk backlit at three degrees is the same trap as the crown: a pure
  // albedo trunk goes to black. A little self-emissive keeps it a dark umber.
  const bark: PropOpts = {
    color: C.bark,
    mr: [0, 0.92],
    emissive: [C.bark.r * 0.12, C.bark.g * 0.12, C.bark.b * 0.12],
  };

  // Trunk, tapering, plus the root flare that plants it on the pavement.
  b.cyl(x, WALK_Y - 0.05, z, trunkR * 1.45, trunkR * 0.9, trunkH, 6, bark, false);
  b.cyl(x, WALK_Y - 0.06, z, trunkR * 2.1, trunkR * 1.4, 0.26, 6, bark, false);

  const crownY = WALK_Y + trunkH;
  const crownR = rng.range(2.2, 3.1) * scale;
  const crownH = h - trunkH;

  /*
   * REAL BRANCHING. The reference's trees are half bare: you see through them
   * to the sky, and the structure inside the crown is as visible as the leaves
   * on it. Three orders — limbs off the trunk, secondaries off those, twigs
   * off the secondaries — is the minimum that reads as a tree rather than as a
   * lollipop, and the twigs are what keep the silhouette from closing up.
   */
  const tips: Array<[number, number, number, number]> = [];   // x, y, z, order
  const nLimb = 3 + rng.int(0, 3);
  const lean = rng.range(0, Math.PI * 2);
  for (let i = 0; i < nLimb; i++) {
    const a = lean + (i / nLimb) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const reach = crownR * rng.range(0.42, 0.66);
    const rise = crownH * rng.range(0.30, 0.52);
    const lx = x + Math.cos(a) * reach;
    const lz = z + Math.sin(a) * reach;
    const ly = crownY + rise;
    b.tube(x, crownY - 0.25, z, lx, ly, lz, trunkR * 0.5, 4, bark);

    const nSec = 2 + rng.int(0, 2);
    for (let j = 0; j < nSec; j++) {
      const a2 = a + rng.range(-0.85, 0.85);
      const sx = lx + Math.cos(a2) * crownR * rng.range(0.26, 0.5);
      const sz = lz + Math.sin(a2) * crownR * rng.range(0.26, 0.5);
      const sy = ly + crownH * rng.range(0.14, 0.34);
      b.tube(lx, ly, lz, sx, sy, sz, trunkR * 0.26, 3, bark);
      tips.push([sx, sy, sz, 1]);
      // Bare twigs beyond the last leaf cluster: this is the fringe that stops
      // a crown reading as a hard-edged solid against a bright sky.
      if (lod === 2 && rng.bool(0.7)) {
        const a3 = a2 + rng.range(-1.1, 1.1);
        const tx = sx + Math.cos(a3) * crownR * rng.range(0.2, 0.38);
        const tz = sz + Math.sin(a3) * crownR * rng.range(0.2, 0.38);
        const ty = sy + crownH * rng.range(0.08, 0.26);
        b.tube(sx, sy, sz, tx, ty, tz, trunkR * 0.12, 3, bark);
        tips.push([tx, ty, tz, 2]);
      }
    }
  }
  // The leader.
  b.tube(x, crownY - 0.25, z, x + rng.range(-0.25, 0.25), crownY + crownH * 0.72, z + rng.range(-0.25, 0.25),
    trunkR * 0.42, 4, bark);

  /*
   * THE CANOPY. Small clusters hung on the branch ENDS only, never a solid
   * mass at the middle. Late autumn thins the crown by dropping whole clusters
   * rather than shrinking them, so `thin` gates the loop — at thin 0.78 you get
   * a mostly bare armature with a handful of clinging gold, which is exactly
   * what a Bucharest plane tree looks like in the reference.
   */
  const amberBias = rng.range(0.6, 0.98);
  const perTip = lod === 2 ? 4 : lod === 1 ? 2 : 1;
  for (let i = 0; i < tips.length; i++) {
    if (rng.next() < thin * 0.55) continue;
    const [tx, ty, tz, order] = tips[i];
    // Twig-order clusters are half the size of secondary-order ones, which is
    // what gives the crown a soft outer fringe and a denser core.
    // Absolute metres, not a fraction of the crown: a cluster of leaves is
     // 0.4-0.8 m across on a 3 m tree and on a 12 m one. Scaling it with the
     // crown is what made park trees (scale 1.5) grow 2 m cabbages.
     const cr = (order === 2 ? rng.range(0.30, 0.46) : rng.range(0.42, 0.68)) * scale;
    const leafC = rng.next() < amberBias
      ? rng.weighted([C.leafGold, C.leafAmber, C.leafPale, C.leafRust], [4, 3, 2, 2])
      : C.leafOlive;
    for (let k = 0; k < perTip; k++) {
      const kr = cr * (1.0 - k * 0.16);
      b.blob(
        tx + rng.range(-cr * 1.5, cr * 1.5),
        ty + rng.range(-cr * 0.8, cr * 1.6),
        tz + rng.range(-cr * 1.5, cr * 1.5),
        kr, kr * rng.range(0.66, 0.96), kr,
        leafOpt(k === 0 ? leafC : rng.weighted([C.leafGold, C.leafPale, C.leafRust], [3, 2, 2]),
          0.12, rng.range(0.7, 1.0)),
        0.55, 101 + i * 7 + k * 31, 2, LEAF_NORMAL_JITTER * 0.6,
      );
    }
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
      leafOpt(c, 0.10, 0.55), 0.35, 401 + i * 13, 2, LEAF_NORMAL_JITTER * 0.7,
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
      leafOpt(c, 0.10, 0.6), 0.5, 601 + i * 11, 2, LEAF_NORMAL_JITTER * 0.7,
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
      leafOpt(c, 0.09, 0.5), 0.6, 811 + i * 3, 1, LEAF_NORMAL_JITTER * 0.6);
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
      rng.range(0.075, 0.15), rng.range(0.055, 0.105), rng.range(0, Math.PI),
      leafOpt(c, 0.05, 0.0),
    );
  }
}

/* ------------------------------------------------------------------ */
/* Drifting leaves in the wind                                         */
/* ------------------------------------------------------------------ */

const DRIFT_VERT = /* glsl */ `
uniform float uTime;
uniform vec3 uOrigin;
uniform float uGroundY;
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
  /*
   * THE FLOATING-LITTER BUG. This used to read p.y = uOrigin.y - 1.6 + ...,
   * where uOrigin is the CAMERA. Leaves were therefore pinned 1.6 m below the
   * lens whatever the lens was doing: from a street-level camera they looked
   * plausible, but from any elevated framing — the boulevard shot down the
   * Palace axis, a rooftop, a helicopter — six hundred leaves hung in the sky
   * at camera height and read as a field of white specks scattered across the
   * sunset. That is the "litter floating hundreds of metres in mid-air".
   *
   * Wind-blown leaves belong to the GROUND, so the slab is anchored to the
   * ground plane and the whole field fades out once the camera climbs away
   * from it — there is nothing to see from 200 m up anyway.
   */
  float bob = sin(t * 2.1 + aSeed.x * 40.0) * 0.5 + 0.5;
  p.y = uGroundY + 0.05 + bob * bob * (0.4 + aSeed.z * 3.0);
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
  // ...and fade with camera HEIGHT above the drift plane. A 20 cm leaf is not
  // resolvable from a rooftop, and leaving the field on is what put specks in
  // the sky of every elevated shot.
  vShade *= 1.0 - smoothstep(14.0, 34.0, uOrigin.y - uGroundY);
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
    uGroundY: { value: number };
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
      uGroundY: { value: 0 },
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

  /** `groundY` is the height of the pavement under the camera, not the camera. */
  update(time: number, camera: THREE.Object3D, groundY: number): void {
    this.uniforms.uTime.value = time;
    camera.getWorldPosition(this.uniforms.uOrigin.value);
    this.uniforms.uGroundY.value = groundY;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
