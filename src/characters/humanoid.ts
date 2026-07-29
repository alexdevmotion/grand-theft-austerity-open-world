/**
 * HUMANOID — procedural skinned geometry, the shared factory, and the actor
 * every gameplay system drives.
 *
 * The mesh is generated as swept super-elliptical tubes along the bind-pose
 * skeleton: torso, neck, head, arms, hands, legs, shoes, hair, headwear and
 * accessories all land in ONE indexed BufferGeometry with ONE material, so a
 * character costs a single draw call. Clothing is not a separate layer — the
 * relevant tube is inflated and its texture slot swapped, and only silhouette
 * pieces (coat skirts, hi-vis shells, backpacks, harnesses) add geometry.
 *
 * COST MODEL
 *   - geometry cached by `appearanceGeoKey`  (mesh-changing traits only)
 *   - material + textures cached by `appearanceTexKey`
 *   - height is a uniform scale on the actor root, never a new geometry
 *   - skeletons are per-actor but their bind inverses are shared (see rig.ts)
 *   - skeleton updates are rate-limited by distance and skipped off-screen
 *
 * PUBLIC API — stable, the pedestrian/police systems build against this:
 *   const factory = CharacterFactory.of(ctx);
 *   const actor = factory.create(rollAppearance(rng, 'builder'));
 *   scene.add(actor.object);
 *   actor.setTransform(pos, yaw);
 *   actor.drive({ state: 'walk', speed: 1.8, grounded: true });
 *   actor.update(dt, ctx);
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import type { GameContext } from '../core/engine';
import { Rng } from '../core/rng';
import { Services, type LocomotionState } from '../core/services';
import type { PhysicsWorld } from '../physics/physics';
import { AnimationController, type Drive } from './animation';
import { Ragdoll } from './ik';
import {
  BI, BONE_COUNT, NOMINAL_HEIGHT, bodyMetrics, buildRig,
  type BodyMetrics, type Rig,
} from './rig';
import {
  SLOT, buildAppearanceTextures, slotU,
  appearanceGeoKey, appearanceTexKey,
  type Appearance, type AppearanceTextures, type SlotId,
} from './wardrobe';

const FRONT = new THREE.Vector3(0, 0, 1);
const UPV = new THREE.Vector3(0, 1, 0);

/* ------------------------------------------------------------------ */
/* Mesh builder                                                        */
/* ------------------------------------------------------------------ */

interface Ring {
  /** Ring centre, character space. */
  c: THREE.Vector3;
  /** Sweep direction (unit). */
  dir: THREE.Vector3;
  /** Half width along the ring's lateral axis. */
  rx: number;
  /** Half depth toward the ring reference axis (front). */
  rzF: number;
  /** Half depth away from it (back). Defaults to rzF. */
  rzB?: number;
  /** Super-ellipse exponent: 2 = ellipse, 4+ = rounded rectangle. */
  n?: number;
  /** Skin binding. */
  b0: number; w0: number; b1?: number; w1?: number;
  /** Texture v (0 = top of the atlas column). */
  v: number;
  /** Ring "front" reference; defaults to +Z. */
  ref?: THREE.Vector3;
}

interface TubeOpts {
  capStart?: boolean;
  capEnd?: boolean;
  /** Start angle; 0 puts vertex 0 at the front. */
  theta0?: number;
  /** Duplicate the first column at the end so UVs can wrap (heads). */
  seam?: boolean;
  /** Custom UV; receives the column index and ring. */
  uvFn?: (k: number, radial: number, ring: Ring) => [number, number];
}

class SkinBuilder {
  private pos: number[] = [];
  private uv: number[] = [];
  private si: number[] = [];
  private sw: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(p: THREE.Vector3, u: number, v: number, b0: number, w0: number, b1: number, w1: number): number {
    const i = this.pos.length / 3;
    this.pos.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    this.si.push(b0, b1, 0, 0);
    const s = w0 + w1 || 1;
    this.sw.push(w0 / s, w1 / s, 0, 0);
    return i;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /** Sweep a super-elliptical profile along a chain of rings. */
  tube(rings: Ring[], radial: number, slot: SlotId, opts: TubeOpts = {}): void {
    if (rings.length < 2) return;
    const seam = opts.seam === true;
    const cols = seam ? radial + 1 : radial;
    const theta0 = opts.theta0 ?? 0;
    const u0 = slotU(slot);
    const start: number[] = [];

    const zAxis = new THREE.Vector3();
    const xAxis = new THREE.Vector3();
    const p = new THREE.Vector3();

    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r];
      const ref = ring.ref ?? (Math.abs(ring.dir.dot(FRONT)) > 0.985 ? UPV : FRONT);
      zAxis.copy(ref).addScaledVector(ring.dir, -ref.dot(ring.dir));
      if (zAxis.lengthSq() < 1e-8) zAxis.set(0, 0, 1);
      zAxis.normalize();
      xAxis.crossVectors(ring.dir, zAxis).normalize();

      const n = ring.n ?? 2;
      const e = 2 / n;
      const rzB = ring.rzB ?? ring.rzF;
      start.push(this.vertexCount);

      for (let k = 0; k < cols; k++) {
        const th = theta0 + (k / radial) * Math.PI * 2;
        const cs = Math.cos(th);
        const sn = Math.sin(th);
        const fz = Math.sign(cs) * Math.pow(Math.abs(cs), e);
        const fx = Math.sign(sn) * Math.pow(Math.abs(sn), e);
        p.copy(ring.c)
          .addScaledVector(zAxis, (fz >= 0 ? ring.rzF : rzB) * fz)
          .addScaledVector(xAxis, ring.rx * fx);
        let u = u0;
        let v = 1 - ring.v;
        if (opts.uvFn) {
          const t = opts.uvFn(k, radial, ring);
          u = t[0];
          v = t[1];
        }
        this.vert(p, u, v, ring.b0, ring.w0, ring.b1 ?? ring.b0, ring.w1 ?? 0);
      }
    }

    for (let r = 0; r < rings.length - 1; r++) {
      const a0 = start[r];
      const b0 = start[r + 1];
      const lim = seam ? cols - 1 : cols;
      for (let k = 0; k < lim; k++) {
        const k1 = seam ? k + 1 : (k + 1) % cols;
        this.quad(a0 + k, a0 + k1, b0 + k1, b0 + k);
      }
    }

    if (opts.capStart) this.cap(rings[0], start[0], cols, radial, seam, slot, true, opts);
    if (opts.capEnd) {
      this.cap(rings[rings.length - 1], start[rings.length - 1], cols, radial, seam, slot, false, opts);
    }
  }

  private cap(
    ring: Ring, first: number, cols: number, radial: number,
    seam: boolean, slot: SlotId, isStart: boolean, opts: TubeOpts,
  ): void {
    let u = slotU(slot);
    let v = 1 - ring.v;
    if (opts.uvFn) {
      const t = opts.uvFn(0, radial, ring);
      u = t[0];
      v = t[1];
    }
    const centre = this.vert(ring.c, u, v, ring.b0, ring.w0, ring.b1 ?? ring.b0, ring.w1 ?? 0);
    const lim = seam ? cols - 1 : cols;
    for (let k = 0; k < lim; k++) {
      const k1 = seam ? k + 1 : (k + 1) % cols;
      if (isStart) this.tri(centre, first + k1, first + k);
      else this.tri(centre, first + k, first + k1);
    }
  }

  /** A capped constant-section sweep — straps, belts, buckles, bags. */
  slab(
    a: THREE.Vector3, b: THREE.Vector3, halfX: number, halfZ: number,
    slot: SlotId, bone: number, v0: number, v1: number,
    ref?: THREE.Vector3, n = 4,
  ): void {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-5) return;
    dir.divideScalar(len);
    const mk = (c: THREE.Vector3, v: number): Ring => ({
      c: c.clone(), dir, rx: halfX, rzF: halfZ, n, b0: bone, w0: 1, v, ref,
    });
    this.tube([mk(a, v0), mk(b, v1)], 8, slot, { capStart: true, capEnd: true });
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    // Animation moves vertices well outside the bind pose; give the cull
    // sphere enough slack that a sprinting or ragdolled body never pops.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, NOMINAL_HEIGHT * 0.5, 0), NOMINAL_HEIGHT * 0.95);
    g.boundingBox = new THREE.Box3(
      new THREE.Vector3(-1.1, -0.4, -1.1),
      new THREE.Vector3(1.1, NOMINAL_HEIGHT + 0.4, 1.1),
    );
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* Garment tables                                                      */
/* ------------------------------------------------------------------ */

/** How much the outer garment inflates the torso, in metres. */
const OUTER_BULK: Record<string, number> = {
  none: 0, jacket: 0.024, denimJacket: 0.028, coat: 0.032, longCoat: 0.034,
  suit: 0.020, hiVis: 0.030, puffer: 0.055, apron: 0.012, uniform: 0.024,
};

/** Does the outer garment have sleeves? */
const OUTER_SLEEVES: Record<string, boolean> = {
  none: false, jacket: true, denimJacket: true, coat: true, longCoat: true,
  suit: true, hiVis: false, puffer: true, apron: false, uniform: true,
};

/** Hem height as a fraction of the hip-to-knee span (0 = at the hip). */
const OUTER_HEM: Record<string, number> = {
  none: 0, jacket: 0.16, denimJacket: 0.08, coat: 0.62, longCoat: 0.95,
  suit: 0.38, hiVis: 0.14, puffer: 0.30, apron: 0.72, uniform: 0.22,
};

/* ------------------------------------------------------------------ */
/* Geometry assembly                                                   */
/* ------------------------------------------------------------------ */

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Head silhouette, sampled from the jaw (t = 0) to the crown (t = 1).
 * [t, widthScale, depthScale, forwardOffset] — an egg, not a sphere: a real
 * jaw at the bottom rather than a cone, which is what made the first pass look
 * like a balloon on a stick. Shared by the skull, hair and headwear so hats
 * always sit exactly on the skull.
 */
const HEAD_PROFILE: Array<[number, number, number, number]> = [
  [0.00, 0.50, 0.62, 0.075],
  [0.09, 0.68, 0.78, 0.055],
  [0.21, 0.84, 0.90, 0.030],
  [0.35, 0.94, 0.97, 0.012],
  [0.50, 1.00, 1.00, 0.000],
  [0.64, 1.00, 0.99, -0.006],
  [0.78, 0.94, 0.94, -0.012],
  [0.89, 0.79, 0.81, -0.016],
  [0.96, 0.58, 0.60, -0.018],
  [1.00, 0.24, 0.26, -0.018],
];

interface HeadPoint { y: number; z: number; rx: number; rzF: number; rzB: number }

function headProfile(m: BodyMetrics, t: number, jaw: number, grow = 0): HeadPoint {
  const chinY = m.headY - 0.010;
  const crownY = m.headTopY;
  const tc = THREE.MathUtils.clamp(t, 0, 1);
  let i = 0;
  while (i < HEAD_PROFILE.length - 2 && HEAD_PROFILE[i + 1][0] < tc) i++;
  const [t0, w0, d0, z0] = HEAD_PROFILE[i];
  const [t1, w1, d1, z1] = HEAD_PROFILE[i + 1];
  const k = t1 > t0 ? (tc - t0) / (t1 - t0) : 0;
  // Square jaws stay wide low down; narrow ones taper.
  const jawK = 1 - (1 - jaw) * 0.22 * Math.max(0, 1 - tc / 0.42);
  const w = lerp(w0, w1, k) * jawK;
  const d = lerp(d0, d1, k);
  return {
    y: chinY + tc * (crownY - chinY),
    z: lerp(z0, z1, k) * m.headD + 0.004,
    rx: m.headW * w + grow,
    rzF: m.headD * d * (1 + (1 - tc) * 0.06) + grow,
    rzB: m.headD * d + grow,
  };
}

/** Blend weights for a point at height `y` along the spine. */
function spineWeights(y: number, m: BodyMetrics): [number, number, number, number] {
  const stops: Array<[number, number]> = [
    [m.hipY - 0.10, BI.hips],
    [m.hipY, BI.hips],
    [m.spineY, BI.spine],
    [m.chestY, BI.chest],
    [m.yokeY, BI.upperChest],
    [m.neckY + 0.02, BI.upperChest],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [y0, b0] = stops[i];
    const [y1, b1] = stops[i + 1];
    if (y <= y1 || i === stops.length - 2) {
      const t = y1 > y0 ? THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1) : 0;
      return [b0, 1 - t, b1, t];
    }
  }
  return [BI.hips, 1, BI.hips, 0];
}

export function buildHumanoidGeometry(a: Appearance, rig: Rig): THREE.BufferGeometry {
  const m = rig.metrics;
  const P = rig.points.joint;
  const b = new SkinBuilder();
  const rng = new Rng(`${appearanceGeoKey(a)}|geo`);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  const hasOuter = a.outer !== 'none';
  const bulk = OUTER_BULK[a.outer] ?? 0;
  const torsoSlot: SlotId = hasOuter ? SLOT.OUTER : SLOT.TOP;
  const sleeveSlot: SlotId = hasOuter && OUTER_SLEEVES[a.outer] ? SLOT.OUTER : SLOT.TOP;
  const sleeveBulk = sleeveSlot === SLOT.OUTER ? bulk * 0.75 : 0.006;

  /* ---------------- torso ---------------- */
  {
    const hipToKnee = m.hipY - m.kneeY;
    const hem = OUTER_HEM[a.outer] ?? 0;
    const bottomY = m.hipY - 0.075 - hipToKnee * hem;
    const skirtOut = hem > 0.4 ? 0.028 + hem * 0.02 : 0;
    const shape = hasOuter ? 2.5 : 2.2;

    interface Prof { y: number; w: number; d: number; back: number; v: number }
    const profile: Prof[] = [
      { y: bottomY, w: m.pelvisW * (hem > 0.4 ? 1.06 : 0.94) + skirtOut, d: m.pelvisD * 0.94 + skirtOut, back: m.pelvisD * 0.98 + skirtOut, v: 0.50 },
      { y: m.hipY - 0.02, w: m.pelvisW, d: m.pelvisD + m.bellyPush * 0.7, back: m.pelvisD, v: 0.40 },
      { y: lerp(m.hipY, m.spineY, 0.55), w: m.waistW * 1.03, d: m.waistD + m.bellyPush, back: m.waistD * 0.96, v: 0.33 },
      { y: m.spineY + 0.03, w: m.waistW, d: m.waistD + m.bellyPush * 0.85, back: m.waistD, v: 0.27 },
      { y: m.chestY, w: lerp(m.waistW, m.chestW, 0.62), d: lerp(m.waistD, m.chestD, 0.7) + m.bustPush * 0.6, back: lerp(m.waistD, m.chestD, 0.6), v: 0.19 },
      { y: lerp(m.chestY, m.yokeY, 0.55), w: m.chestW, d: m.chestD + m.bustPush, back: m.chestD * 0.94, v: 0.12 },
      { y: m.yokeY + 0.012, w: m.yokeW, d: m.yokeD, back: m.yokeD * 1.02, v: 0.06 },
      { y: m.neckY + 0.012, w: m.yokeW * 0.66, d: m.yokeD * 0.80, back: m.yokeD * 0.86, v: 0.015 },
    ];

    const rings: Ring[] = profile.map((pr, i) => {
      const w = spineWeights(pr.y, m);
      const inflate = i === 0 ? bulk * 0.8 : bulk;
      return {
        c: V(0, pr.y, 0),
        dir: UPV,
        rx: pr.w + inflate,
        rzF: pr.d + inflate,
        rzB: pr.back + inflate,
        n: shape,
        b0: w[0], w0: w[1], b1: w[2], w1: w[3],
        v: pr.v,
      };
    });
    b.tube(rings, 12, torsoSlot, { capStart: hem < 0.4, capEnd: true });

    // Open coat/apron hem: a short inner skirt so the silhouette has depth.
    if (hem > 0.4) {
      const inner = rings[0];
      b.tube(
        [
          { ...inner, rx: inner.rx * 0.86, rzF: inner.rzF * 0.86, rzB: (inner.rzB ?? inner.rzF) * 0.86, v: 0.52 },
          { ...rings[1], rx: rings[1].rx * 0.9, rzF: rings[1].rzF * 0.9, rzB: (rings[1].rzB ?? rings[1].rzF) * 0.9, v: 0.42 },
        ],
        12, torsoSlot, { capStart: true },
      );
    }

    // Collar / visible shirt at the neck when something is worn over it.
    if (hasOuter) {
      const y0 = m.neckY - 0.02;
      const w = spineWeights(y0, m);
      b.tube(
        [
          { c: V(0, y0, 0.006), dir: UPV, rx: m.neckR * 1.55, rzF: m.neckR * 1.5, n: 2.4, b0: w[0], w0: w[1], b1: w[2], w1: w[3], v: 0.03 },
          { c: V(0, m.neckY + 0.045, 0.004), dir: UPV, rx: m.neckR * 1.22, rzF: m.neckR * 1.2, n: 2.2, b0: BI.neck, w0: 1, v: 0.005 },
        ],
        10, SLOT.TOP, {},
      );
    }
  }

  /* ---------------- neck ---------------- */
  const chinY = m.headY - 0.010;
  const crownY = m.headTopY;
  {
    b.tube(
      [
        { c: V(0, m.neckY - 0.035, -0.006), dir: UPV, rx: m.neckR * 1.22, rzF: m.neckR * 1.18, b0: BI.upperChest, w0: 0.55, b1: BI.neck, w1: 0.45, v: 0.62 },
        { c: V(0, m.neckY + 0.030, -0.003), dir: UPV, rx: m.neckR, rzF: m.neckR * 1.02, b0: BI.neck, w0: 1, v: 0.56 },
        { c: V(0, chinY + 0.020, 0.004), dir: UPV, rx: m.neckR * 1.06, rzF: m.neckR * 1.12, b0: BI.neck, w0: 0.35, b1: BI.head, w1: 0.65, v: 0.5 },
      ],
      10, SLOT.SKIN, {},
    );
  }

  /* ---------------- head ---------------- */
  {
    const jaw = a.face.jaw;
    const rings: Ring[] = HEAD_PROFILE.map(([t]) => {
      const p = headProfile(m, t, jaw);
      return {
        c: V(0, p.y, p.z),
        dir: UPV,
        rx: p.rx,
        rzF: p.rzF,
        rzB: p.rzB,
        n: 2 + (1 - t) * 0.8,
        b0: BI.head,
        w0: 1,
        v: 1 - t,
      };
    });
    b.tube(rings, 14, SLOT.SKIN, {
      theta0: Math.PI,
      seam: true,
      capStart: true,
      capEnd: true,
      uvFn: (k, rad, ring) => {
        const sw = -1 + (2 * k) / rad;
        const u = 0.5 + 0.25 * (1 + Math.sign(sw) * Math.pow(Math.abs(sw), 0.55));
        return [u, 1 - ring.v * 0.5];
      },
    });

    // nose — small, it only needs to break the silhouette
    const nw = m.headW * (0.130 + a.face.noseWidth * 0.055);
    const pTop = headProfile(m, 0.545, jaw);
    const pBot = headProfile(m, 0.375, jaw);
    const out = 0.008 + a.face.noseLength * 0.007;
    b.tube(
      [
        { c: V(0, pTop.y, pTop.rzF * 0.80), dir: V(0, -1, 0.30).normalize(), rx: nw * 0.42, rzF: nw * 0.22, n: 2.4, b0: BI.head, w0: 1, v: 0.30 },
        { c: V(0, pBot.y + 0.012, pBot.rzF * 0.90 + out), dir: V(0, -1, 0.18).normalize(), rx: nw, rzF: nw * 0.55, n: 2.6, b0: BI.head, w0: 1, v: 0.34 },
        { c: V(0, pBot.y - 0.006, pBot.rzF * 0.76), dir: V(0, -1, -0.3).normalize(), rx: nw * 0.88, rzF: nw * 0.34, n: 2.6, b0: BI.head, w0: 1, v: 0.38 },
      ],
      7, SLOT.SKIN, { capStart: true, capEnd: true },
    );

    // ears
    for (const s of [1, -1] as const) {
      const pe = headProfile(m, 0.50, jaw);
      b.slab(
        V(s * pe.rx * 0.92, pe.y, -0.006),
        V(s * pe.rx * 1.09, pe.y + 0.004, -0.008),
        0.021, 0.009, SLOT.SKIN, BI.head, 0.44, 0.46,
        V(s, 0, 0), 3,
      );
    }
  }

  /* ---------------- hair + headwear ---------------- */
  buildHair(b, a, m, chinY, crownY);
  buildHeadwear(b, a, m, chinY, crownY);

  /* ---------------- arms ---------------- */
  for (const s of [1, -1] as const) {
    const L = s > 0 ? 'L' : 'R';
    const shoulder = P[`upperArm${L}` as 'upperArmL'];
    const elbow = P[`forearm${L}` as 'forearmL'];
    const wrist = P[`hand${L}` as 'handL'];
    const upper = BI[`upperArm${L}` as 'upperArmL'];
    const fore = BI[`forearm${L}` as 'forearmL'];
    const hand = BI[`hand${L}` as 'handL'];
    const clav = BI[`clavicle${L}` as 'clavicleL'];

    const dUp = elbow.clone().sub(shoulder).normalize();
    const dLo = wrist.clone().sub(elbow).normalize();
    const bare = a.shortSleeve;
    const cuffT = bare ? 0.42 : 1.0;

    const at = (from: THREE.Vector3, d: THREE.Vector3, t: number, len: number) =>
      from.clone().addScaledVector(d, t * len);

    const upLen = m.upperArmLen;
    const loLen = m.forearmLen;
    const sleeveEndT = bare ? 0.45 : 1.0;
    const inflate = (t: number) => (t <= sleeveEndT ? sleeveBulk : 0.0);
    const slotAt = (t: number): SlotId => (t <= sleeveEndT ? sleeveSlot : SLOT.SKIN);
    // Sleeve v: 0.60 at the shoulder seam .. 0.79 at the elbow .. 0.99 cuff.
    const vAt = (t: number) => (t <= sleeveEndT ? 0.60 + t * 0.19 : 0.30 + t * 0.16);

    // Deltoid + upper arm (sleeve or skin). The first ring is buried inside the
    // torso so the shoulder reads as a joint, not a pauldron.
    const upperRings: Ring[] = [
      { c: shoulder.clone().addScaledVector(dUp, -0.052), dir: dUp, rx: m.deltoidR * 0.70 + inflate(0), rzF: m.deltoidR * 0.76 + inflate(0), n: 2.2, b0: clav, w0: 0.45, b1: upper, w1: 0.55, v: vAt(0) },
      { c: shoulder.clone().addScaledVector(dUp, -0.012), dir: dUp, rx: m.deltoidR * 0.94 + inflate(0.05), rzF: m.deltoidR * 0.94 + inflate(0.05), n: 2.15, b0: clav, w0: 0.25, b1: upper, w1: 0.75, v: vAt(0.05) },
      { c: at(shoulder, dUp, 0.22, upLen), dir: dUp, rx: m.deltoidR * 0.94 + inflate(0.22), rzF: m.deltoidR * 0.90 + inflate(0.22), n: 2.1, b0: upper, w0: 1, v: vAt(0.22) },
      { c: at(shoulder, dUp, 0.58, upLen), dir: dUp, rx: m.upperArmR + inflate(0.58), rzF: m.upperArmR + inflate(0.58), n: 2, b0: upper, w0: 1, v: vAt(0.58) },
      { c: at(shoulder, dUp, 0.95, upLen), dir: dUp, rx: m.elbowR * 1.05 + inflate(0.95), rzF: m.elbowR * 1.05 + inflate(0.95), n: 2, b0: upper, w0: 0.6, b1: fore, w1: 0.4, v: vAt(0.95) },
    ];
    b.tube(upperRings, 7, slotAt(0), { capStart: true });

    if (bare) {
      // Sleeve stops mid-upper-arm; the rest of the arm is skin.
      const tCut = 0.45;
      const cut = at(shoulder, dUp, tCut, upLen);
      b.tube(
        [
          { c: cut, dir: dUp, rx: m.upperArmR * 1.02, rzF: m.upperArmR * 1.02, b0: upper, w0: 1, v: 0.30 },
          { c: at(shoulder, dUp, 0.96, upLen), dir: dUp, rx: m.elbowR, rzF: m.elbowR, b0: upper, w0: 0.6, b1: fore, w1: 0.4, v: 0.36 },
        ],
        7, SLOT.SKIN, {},
      );
    }

    const foreSlot: SlotId = bare ? SLOT.SKIN : sleeveSlot;
    const foreInflate = bare ? 0 : sleeveBulk * 0.8;
    b.tube(
      [
        { c: elbow.clone().addScaledVector(dLo, -0.012), dir: dLo, rx: m.elbowR + foreInflate, rzF: m.elbowR + foreInflate, b0: upper, w0: 0.35, b1: fore, w1: 0.65, v: bare ? 0.37 : 0.790 },
        { c: at(elbow, dLo, 0.30, loLen), dir: dLo, rx: m.forearmR + foreInflate, rzF: m.forearmR * 0.94 + foreInflate, b0: fore, w0: 1, v: bare ? 0.41 : 0.855 },
        { c: at(elbow, dLo, 0.80, loLen), dir: dLo, rx: m.wristR * 1.20 + foreInflate * cuffT, rzF: m.wristR * 1.1 + foreInflate * cuffT, b0: fore, w0: 1, v: bare ? 0.46 : 0.955 },
        { c: at(elbow, dLo, 1.0, loLen), dir: dLo, rx: m.wristR, rzF: m.wristR * 0.86, b0: fore, w0: 0.5, b1: hand, w1: 0.5, v: bare ? 0.49 : 0.99 },
      ],
      7, foreSlot, {},
    );

    // hand: palm block + thumb
    const tip = (s > 0 ? rig.points.handTipL : rig.points.handTipR);
    const dH = tip.clone().sub(wrist).normalize();
    b.tube(
      [
        { c: wrist.clone().addScaledVector(dH, 0.006), dir: dH, rx: m.handW * 0.80, rzF: m.handT * 1.05, n: 3, b0: hand, w0: 1, v: 0.50 },
        { c: at(wrist, dH, 0.42, m.handLen), dir: dH, rx: m.handW, rzF: m.handT, n: 3.2, b0: hand, w0: 1, v: 0.55 },
        { c: at(wrist, dH, 0.86, m.handLen), dir: dH, rx: m.handW * 0.92, rzF: m.handT * 0.86, n: 3.2, b0: hand, w0: 1, v: 0.60 },
        { c: at(wrist, dH, 1.0, m.handLen), dir: dH, rx: m.handW * 0.62, rzF: m.handT * 0.62, n: 3, b0: hand, w0: 1, v: 0.62 },
      ],
      8, SLOT.SKIN, { capStart: true, capEnd: true },
    );
    const thumbBase = at(wrist, dH, 0.26, m.handLen).add(V(-s * m.handW * 0.55, 0, m.handT * 0.2));
    const thumbTip = thumbBase.clone().addScaledVector(dH, m.handLen * 0.42).add(V(-s * m.handW * 0.30, 0, 0));
    b.slab(thumbBase, thumbTip, m.handT * 0.95, m.handT * 0.85, SLOT.SKIN, hand, 0.52, 0.58, undefined, 3);
  }

  /* ---------------- legs ---------------- */
  const skirt = a.legs === 'skirt' || a.legs === 'longSkirt';
  const shorts = a.legs === 'shorts';
  for (const s of [1, -1] as const) {
    const L = s > 0 ? 'L' : 'R';
    const hip = P[`thigh${L}` as 'thighL'];
    const knee = P[`shin${L}` as 'shinL'];
    const ankle = P[`foot${L}` as 'footL'];
    const thigh = BI[`thigh${L}` as 'thighL'];
    const shin = BI[`shin${L}` as 'shinL'];
    const foot = BI[`foot${L}` as 'footL'];

    const dT = knee.clone().sub(hip).normalize();
    const dS = ankle.clone().sub(knee).normalize();
    const thighLen = hip.distanceTo(knee);
    const shinLen = knee.distanceTo(ankle);
    const at = (f: THREE.Vector3, d: THREE.Vector3, t: number, l: number) => f.clone().addScaledVector(d, t * l);

    // Where trousers stop and skin starts.
    const clothEnd = skirt ? 0.0 : shorts ? 0.55 : 2.0;
    const trouser = 0.014;

    const legRing = (c: THREE.Vector3, dir: THREE.Vector3, r: number, t: number, b0: number, w0: number, b1: number, w1: number): Ring => {
      const clothed = t <= clothEnd;
      return {
        c, dir,
        rx: r + (clothed ? trouser : 0),
        rzF: r * 0.96 + (clothed ? trouser : 0),
        rzB: r * 1.02 + (clothed ? trouser : 0),
        n: clothed ? 2.3 : 2,
        b0, w0, b1, w1,
        v: clothed ? t * 0.40 : 0.30 + t * 0.16,
      };
    };

    if (!skirt) {
      const rings: Ring[] = [
        legRing(hip.clone().addScaledVector(dT, -0.055), dT, m.thighR * 1.02, 0.02, BI.hips, 0.6, thigh, 0.4),
        legRing(at(hip, dT, 0.14, thighLen), dT, m.thighR, 0.14, thigh, 1, thigh, 0),
        legRing(at(hip, dT, 0.55, thighLen), dT, lerp(m.thighR, m.kneeR, 0.55), 0.55, thigh, 1, thigh, 0),
        legRing(at(hip, dT, 0.95, thighLen), dT, m.kneeR * 1.06, 0.95, thigh, 0.55, shin, 0.45),
        legRing(at(knee, dS, 0.06, shinLen), dS, m.kneeR * 1.02, 1.06, shin, 1, shin, 0),
        legRing(at(knee, dS, 0.30, shinLen), dS, m.calfR, 1.30, shin, 1, shin, 0),
        legRing(at(knee, dS, 0.72, shinLen), dS, lerp(m.calfR, m.ankleR, 0.72), 1.72, shin, 1, shin, 0),
        legRing(at(knee, dS, 1.0, shinLen), dS, m.ankleR, 2.0, shin, 0.5, foot, 0.5),
      ];
      // Re-key the v ramp so trousers run 0 -> 0.78 down the column.
      for (const r of rings) r.v = THREE.MathUtils.clamp(r.v <= 0.9 ? r.v * 0.39 : 0.30 + (r.v - 1) * 0.14, 0, 0.99);
      const trouserRings = rings.filter((_, i) => i <= (shorts ? 3 : 7));
      b.tube(trouserRings, 9, shorts ? SLOT.LEGS : SLOT.LEGS, { capStart: true });
      if (shorts) {
        const bare = rings.slice(3).map((r) => ({ ...r, rx: r.rx - trouser, rzF: r.rzF - trouser, rzB: (r.rzB ?? r.rzF) - trouser, v: 0.30 + (r.v) * 0.2 }));
        b.tube(bare, 9, SLOT.SKIN, {});
      }
    } else {
      // Bare leg under the skirt.
      const bareRings: Ring[] = [
        legRing(at(hip, dT, 0.35, thighLen), dT, lerp(m.thighR, m.kneeR, 0.35) * 0.95, 3, thigh, 1, thigh, 0),
        legRing(at(hip, dT, 0.95, thighLen), dT, m.kneeR, 3, thigh, 0.55, shin, 0.45),
        legRing(at(knee, dS, 0.30, shinLen), dS, m.calfR * 0.95, 3, shin, 1, shin, 0),
        legRing(at(knee, dS, 1.0, shinLen), dS, m.ankleR, 3, shin, 0.5, foot, 0.5),
      ];
      for (const r of bareRings) r.v = 0.34;
      b.tube(bareRings, 8, SLOT.SKIN, { capStart: true });
    }

    // shoe
    const heel = ankle.clone().add(V(0, -m.ankleY + 0.012, -m.heelBack));
    const toe = ankle.clone().add(V(0, -m.ankleY + 0.026, m.footLen * 0.62));
    const dF = V(0, 0.06, 1).normalize();
    const bootTop = a.shoes === 'workBoots' || a.shoes === 'boots';
    b.tube(
      [
        { c: heel, dir: dF, rx: m.footW * 0.82, rzF: 0.030, rzB: 0.026, n: 3, b0: foot, w0: 1, v: 0.30, ref: UPV },
        { c: ankle.clone().add(V(0, -m.ankleY * 0.45, -m.heelBack * 0.30)), dir: dF, rx: m.footW * 0.92, rzF: 0.052, rzB: 0.036, n: 3.2, b0: foot, w0: 1, v: 0.16, ref: UPV },
        { c: ankle.clone().add(V(0, -m.ankleY * 0.52, m.footLen * 0.10)), dir: dF, rx: m.footW, rzF: 0.048, rzB: 0.034, n: 3.4, b0: foot, w0: 1, v: 0.36, ref: UPV },
        { c: ankle.clone().add(V(0, -m.ankleY * 0.62, m.footLen * 0.40)), dir: dF, rx: m.footW * 0.95, rzF: 0.034, rzB: 0.030, n: 3.4, b0: foot, w0: 0.45, b1: BI[`toe${L}` as 'toeL'], w1: 0.55, v: 0.70, ref: UPV },
        { c: toe.clone().add(V(0, 0, m.footLen * 0.06)), dir: dF, rx: m.footW * 0.66, rzF: 0.020, rzB: 0.022, n: 3.2, b0: BI[`toe${L}` as 'toeL'], w0: 1, v: 0.86, ref: UPV },
      ],
      8, SLOT.SHOES, { capStart: true, capEnd: true },
    );
    if (bootTop) {
      b.tube(
        [
          { c: ankle.clone().add(V(0, -m.ankleY * 0.2, -0.004)), dir: UPV, rx: m.ankleR * 1.30, rzF: m.ankleR * 1.30, n: 2.4, b0: foot, w0: 0.7, b1: shin, w1: 0.3, v: 0.14 },
          { c: ankle.clone().add(V(0, 0.055, -0.004)), dir: UPV, rx: m.ankleR * 1.34, rzF: m.ankleR * 1.34, n: 2.4, b0: shin, w0: 1, v: 0.04 },
        ],
        8, SLOT.SHOES, { capEnd: true },
      );
    }
  }

  /* ---------------- accessories ---------------- */
  buildAccessory(b, a, m, rng);

  return b.build();
}

/* ---------------- hair ---------------- */

function buildHair(
  b: SkinBuilder, a: Appearance, m: BodyMetrics, chinY: number, crownY: number,
): void {
  if (a.hair === 'bald') return;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const jaw = a.face.jaw;

  const style = a.hair;
  const thick =
    style === 'buzz' ? 0.005 :
    style === 'short' ? 0.011 :
    style === 'sweptShort' ? 0.016 :
    style === 'medium' ? 0.021 : 0.025;
  // Hairline height as a fraction from jaw (0) to crown (1). Anything below
  // ~0.62 reads as a hood pulled over the eyes.
  const start =
    style === 'buzz' ? 0.665 :
    style === 'short' ? 0.660 :
    style === 'sweptShort' ? 0.685 :
    style === 'medium' ? 0.640 :
    style === 'bun' || style === 'ponytail' ? 0.655 : 0.615;

  const lats = 5;
  const rings: Ring[] = [];
  for (let i = 0; i <= lats; i++) {
    const k = i / lats;
    const t = lerp(start, 0.998, k);
    const grow = thick * (0.6 + 0.4 * (1 - k));
    const p = headProfile(m, t, jaw, grow);
    // The face side is a hairline; the back of the head carries the volume.
    rings.push({
      c: V(0, p.y, p.z),
      dir: UPV,
      rx: p.rx,
      rzF: p.rzF - grow * (style === 'sweptShort' ? 0.1 : 0.35),
      rzB: p.rzB + grow * (style === 'long' || style === 'medium' ? 1.4 : 0.6),
      n: 2.1,
      b0: BI.head, w0: 1,
      v: 0.06 + (1 - k) * 0.68,
    });
  }
  b.tube(rings, 12, SLOT.HAIR, { capStart: true, capEnd: true });

  if (style === 'bun') {
    const y = lerp(chinY, crownY, 0.80);
    b.tube(
      [
        { c: V(0, y, -m.headD * 0.86), dir: V(0, 0.2, -1).normalize(), rx: 0.036, rzF: 0.030, b0: BI.head, w0: 1, v: 0.2, ref: UPV },
        { c: V(0, y + 0.012, -m.headD * 1.28), dir: V(0, 0.2, -1).normalize(), rx: 0.044, rzF: 0.040, b0: BI.head, w0: 1, v: 0.5, ref: UPV },
        { c: V(0, y + 0.006, -m.headD * 1.52), dir: V(0, 0.2, -1).normalize(), rx: 0.020, rzF: 0.018, b0: BI.head, w0: 1, v: 0.8, ref: UPV },
      ],
      8, SLOT.HAIR, { capStart: true, capEnd: true },
    );
  }
  if (style === 'ponytail') {
    const y = lerp(chinY, crownY, 0.74);
    b.tube(
      [
        { c: V(0, y, -m.headD * 0.92), dir: V(0, -1, -0.55).normalize(), rx: 0.030, rzF: 0.026, b0: BI.head, w0: 1, v: 0.12 },
        { c: V(0, y - 0.075, -m.headD * 1.35), dir: V(0, -1, -0.30).normalize(), rx: 0.034, rzF: 0.030, b0: BI.head, w0: 1, v: 0.5 },
        { c: V(0, y - 0.165, -m.headD * 1.42), dir: V(0, -1, -0.1).normalize(), rx: 0.018, rzF: 0.016, b0: BI.head, w0: 1, v: 0.9 },
      ],
      7, SLOT.HAIR, { capStart: true, capEnd: true },
    );
  }
  if (style === 'long') {
    const top = lerp(chinY, crownY, 0.58);
    const bot = m.neckY - 0.06;
    b.tube(
      [
        { c: V(0, top, -0.010), dir: UPV, rx: m.headW * 0.98, rzF: m.headD * 0.55, rzB: m.headD * 1.10, n: 2.2, b0: BI.head, w0: 1, v: 0.3 },
        { c: V(0, lerp(top, bot, 0.55), -0.020), dir: UPV, rx: m.headW * 1.10, rzF: m.headD * 0.42, rzB: m.headD * 1.18, n: 2.3, b0: BI.head, w0: 0.7, b1: BI.neck, w1: 0.3, v: 0.6 },
        { c: V(0, bot, -0.024), dir: UPV, rx: m.headW * 0.95, rzF: m.headD * 0.36, rzB: m.headD * 1.05, n: 2.4, b0: BI.head, w0: 0.45, b1: BI.neck, w1: 0.55, v: 0.92 },
      ],
      12, SLOT.HAIR, { capStart: true },
    );
  }
}

/* ---------------- headwear ---------------- */

function buildHeadwear(
  b: SkinBuilder, a: Appearance, m: BodyMetrics, chinY: number, crownY: number,
): void {
  if (a.headwear === 'none') return;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const jaw = a.face.jaw;
  const slot: SlotId = a.headwear === 'hardHat' ? SLOT.ACCENT : SLOT.DETAIL;
  const dome = (t: number, grow: number) => headProfile(m, t, jaw, grow);

  if (a.headwear === 'cap' || a.headwear === 'peakedCap') {
    const grow = 0.011;
    const rings: Ring[] = [];
    for (let i = 0; i <= 4; i++) {
      const f = 0.70 + (i / 4) * 0.295;
      const d = dome(f, grow * (1 - i * 0.1));
      rings.push({ c: V(0, d.y, d.z), dir: UPV, rx: d.rx, rzF: d.rzF, rzB: d.rzB, n: 2.1, b0: BI.head, w0: 1, v: 0.1 + (1 - i / 4) * 0.6 });
    }
    b.tube(rings, 12, slot, { capStart: true, capEnd: true });
    // peak
    const p = dome(0.72, grow);
    b.tube(
      [
        { c: V(0, p.y + 0.004, p.rzF * 0.55), dir: V(0, -0.16, 1).normalize(), rx: p.rx * 0.84, rzF: 0.007, n: 4, b0: BI.head, w0: 1, v: 0.72, ref: UPV },
        { c: V(0, p.y - 0.014, p.rzF + (a.headwear === 'peakedCap' ? 0.054 : 0.066)), dir: V(0, -0.16, 1).normalize(), rx: p.rx * 0.70, rzF: 0.005, n: 4, b0: BI.head, w0: 1, v: 0.9, ref: UPV },
      ],
      8, slot, { capStart: true, capEnd: true },
    );
    if (a.headwear === 'peakedCap') {
      const bd = dome(0.715, grow + 0.004);
      b.tube(
        [
          { c: V(0, bd.y - 0.004, bd.z), dir: UPV, rx: bd.rx * 1.02, rzF: bd.rzF * 1.02, rzB: bd.rzB * 1.02, n: 2.1, b0: BI.head, w0: 1, v: 0.5 },
          { c: V(0, bd.y + 0.018, bd.z), dir: UPV, rx: bd.rx * 1.02, rzF: bd.rzF * 1.02, rzB: bd.rzB * 1.02, n: 2.1, b0: BI.head, w0: 1, v: 0.5 },
        ],
        12, SLOT.ACCENT, {},
      );
    }
    return;
  }

  if (a.headwear === 'beanie') {
    const rings: Ring[] = [];
    for (let i = 0; i <= 5; i++) {
      const f = 0.645 + (i / 5) * 0.35;
      const d = dome(f, 0.013 + (i / 5) * 0.006);
      rings.push({ c: V(0, d.y, d.z), dir: UPV, rx: d.rx, rzF: d.rzF, rzB: d.rzB, n: 2.1, b0: BI.head, w0: 1, v: 0.08 + (1 - i / 5) * 0.55 });
    }
    b.tube(rings, 12, slot, { capStart: true, capEnd: true });
    const cuff = dome(0.655, 0.019);
    b.tube(
      [
        { c: V(0, cuff.y - 0.012, cuff.z), dir: UPV, rx: cuff.rx, rzF: cuff.rzF, rzB: cuff.rzB, n: 2.1, b0: BI.head, w0: 1, v: 0.78 },
        { c: V(0, cuff.y + 0.024, cuff.z), dir: UPV, rx: cuff.rx * 1.01, rzF: cuff.rzF * 1.01, rzB: cuff.rzB * 1.01, n: 2.1, b0: BI.head, w0: 1, v: 0.7 },
      ],
      12, slot, {},
    );
    return;
  }

  // hard hat
  {
    const rings: Ring[] = [];
    for (let i = 0; i <= 4; i++) {
      const f = 0.72 + (i / 4) * 0.275;
      const d = dome(Math.min(f, 0.995), 0.019 + (i / 4) * 0.009);
      rings.push({ c: V(0, d.y + 0.012, d.z), dir: UPV, rx: d.rx, rzF: d.rzF, rzB: d.rzB, n: 2.05, b0: BI.head, w0: 1, v: 0.1 + (1 - i / 4) * 0.5 });
    }
    b.tube(rings, 12, SLOT.ACCENT, { capStart: true, capEnd: true });
    const brim = dome(0.725, 0.021);
    b.tube(
      [
        { c: V(0, brim.y + 0.004, brim.z), dir: UPV, rx: brim.rx * 1.02, rzF: brim.rzF * 1.02, rzB: brim.rzB * 1.02, n: 2.1, b0: BI.head, w0: 1, v: 0.66 },
        { c: V(0, brim.y + 0.016, brim.z + 0.008), dir: UPV, rx: brim.rx * 1.24, rzF: brim.rzF * 1.30, rzB: brim.rzB * 1.24, n: 2.2, b0: BI.head, w0: 1, v: 0.74 },
        { c: V(0, brim.y + 0.010, brim.z + 0.008), dir: UPV, rx: brim.rx * 1.22, rzF: brim.rzF * 1.28, rzB: brim.rzB * 1.22, n: 2.2, b0: BI.head, w0: 1, v: 0.8 },
      ],
      12, SLOT.ACCENT, {},
    );
  }
}

/* ---------------- accessories ---------------- */

function buildAccessory(b: SkinBuilder, a: Appearance, m: BodyMetrics, rng: Rng): void {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const bulk = OUTER_BULK[a.outer] ?? 0;
  const chestF = m.chestD + bulk + 0.012;
  const waistY = lerp(m.hipY, m.spineY, 0.35);

  const belt = (slot: SlotId, y: number, grow: number, v0: number, v1: number, bone: number) => {
    const w = spineWeights(y, m);
    const rx = lerp(m.pelvisW, m.waistW, 0.4) + bulk + grow;
    const rz = lerp(m.pelvisD, m.waistD, 0.4) + bulk + grow;
    b.tube(
      [
        { c: V(0, y - 0.022, 0), dir: UPV, rx, rzF: rz, n: 2.4, b0: bone >= 0 ? bone : w[0], w0: bone >= 0 ? 1 : w[1], b1: w[2], w1: bone >= 0 ? 0 : w[3], v: v0 },
        { c: V(0, y + 0.022, 0), dir: UPV, rx, rzF: rz, n: 2.4, b0: bone >= 0 ? bone : w[0], w0: bone >= 0 ? 1 : w[1], b1: w[2], w1: bone >= 0 ? 0 : w[3], v: v1 },
      ],
      12, slot, {},
    );
  };

  switch (a.accessory) {
    case 'builderHarness': {
      // Two chest straps crossing to the hips, plus a wide belt and a buckle.
      // Deliberately oversized — this is the hero's one loud purple signature.
      for (const s of [1, -1] as const) {
        const top = V(s * m.yokeW * 0.48, m.yokeY + 0.022, chestF * 0.40);
        const bot = V(-s * m.pelvisW * 0.26, waistY + 0.028, m.pelvisD + bulk + 0.004);
        b.slab(top, bot, 0.024, 0.008, SLOT.ACCENT, BI.chest, 0.12, 0.5, FRONT, 4);
        const btop = V(s * m.yokeW * 0.46, m.yokeY + 0.020, -chestF * 0.40);
        const bbot = V(-s * m.pelvisW * 0.24, waistY + 0.028, -(m.pelvisD + bulk));
        b.slab(btop, bbot, 0.021, 0.007, SLOT.ACCENT, BI.chest, 0.12, 0.5, FRONT, 4);
        // shoulder loop over the trapezius — a strap, not armour
        b.slab(
          V(s * m.yokeW * 0.47, m.yokeY + 0.026, chestF * 0.34),
          V(s * m.yokeW * 0.48, m.yokeY + 0.024, -chestF * 0.36),
          0.024, 0.008, SLOT.ACCENT, BI.upperChest, 0.15, 0.2, UPV, 4,
        );
      }
      belt(SLOT.ACCENT, waistY, 0.008, 0.62, 0.70, -1);
      // buckle
      b.slab(
        V(0, waistY, m.waistD + bulk + 0.004),
        V(0, waistY, m.waistD + bulk + 0.022),
        0.030, 0.026, SLOT.ACCENT, BI.hips, 0.2, 0.25, UPV, 5,
      );
      // hip tool loops
      for (const s of [1, -1] as const) {
        b.slab(
          V(s * (m.pelvisW + bulk + 0.002), waistY - 0.02, 0.01),
          V(s * (m.pelvisW + bulk + 0.002), waistY - 0.09, 0.012),
          0.024, 0.017, SLOT.ACCENT, BI.hips, 0.55, 0.66, FRONT, 4,
        );
      }
      break;
    }
    case 'toolBelt': {
      belt(SLOT.DETAIL, waistY - 0.01, 0.010, 0.3, 0.36, -1);
      for (const s of [1, -1] as const) {
        b.slab(
          V(s * m.pelvisW * 0.72, waistY - 0.030, m.pelvisD * 0.55 + bulk),
          V(s * m.pelvisW * 0.78, waistY - 0.115, m.pelvisD * 0.60 + bulk),
          0.036, 0.024, SLOT.DETAIL, BI.hips, 0.4, 0.6, FRONT, 4,
        );
      }
      break;
    }
    case 'lanyard': {
      for (const s of [1, -1] as const) {
        b.slab(
          V(s * m.neckR * 1.15, m.neckY + 0.02, 0.004),
          V(s * 0.030, m.chestY + 0.02, m.chestD + bulk),
          0.008, 0.004, SLOT.ACCENT, BI.chest, 0.1, 0.4, FRONT, 3,
        );
      }
      b.slab(
        V(0, m.chestY - 0.005, m.chestD + bulk + 0.004),
        V(0, m.chestY - 0.005, m.chestD + bulk + 0.010),
        0.026, 0.036, SLOT.DETAIL, BI.chest, 0.42, 0.5, UPV, 6,
      );
      break;
    }
    case 'backpack': {
      const zb = -(m.chestD + bulk);
      b.tube(
        [
          { c: V(0, lerp(waistY, m.chestY, 0.35), zb - 0.055), dir: UPV, rx: m.chestW * 0.68, rzF: 0.070, n: 3.2, b0: BI.chest, w0: 1, v: 0.7 },
          { c: V(0, m.chestY + 0.05, zb - 0.070), dir: UPV, rx: m.chestW * 0.74, rzF: 0.082, n: 3.2, b0: BI.chest, w0: 1, v: 0.4 },
          { c: V(0, m.yokeY + 0.03, zb - 0.055), dir: UPV, rx: m.chestW * 0.64, rzF: 0.062, n: 3.2, b0: BI.upperChest, w0: 1, v: 0.15 },
        ],
        10, SLOT.DETAIL, { capStart: true, capEnd: true },
      );
      for (const s of [1, -1] as const) {
        b.slab(
          V(s * m.yokeW * 0.46, m.yokeY + 0.030, -0.01),
          V(s * m.chestW * 0.52, m.chestY - 0.02, m.chestD + bulk),
          0.026, 0.010, SLOT.DETAIL, BI.chest, 0.2, 0.55, FRONT, 4,
        );
      }
      break;
    }
    case 'satchel': {
      const s = rng.bool() ? 1 : -1;
      b.slab(
        V(-s * m.yokeW * 0.44, m.yokeY + 0.030, 0.0),
        V(s * (m.pelvisW + bulk + 0.03), waistY - 0.04, 0.0),
        0.024, 0.010, SLOT.DETAIL, BI.chest, 0.15, 0.5, FRONT, 4,
      );
      b.tube(
        [
          { c: V(s * (m.pelvisW + bulk + 0.055), waistY - 0.075, 0.01), dir: UPV, rx: 0.055, rzF: 0.075, n: 3.4, b0: BI.hips, w0: 1, v: 0.8 },
          { c: V(s * (m.pelvisW + bulk + 0.055), waistY + 0.025, 0.01), dir: UPV, rx: 0.058, rzF: 0.078, n: 3.4, b0: BI.hips, w0: 1, v: 0.55 },
        ],
        10, SLOT.DETAIL, { capStart: true, capEnd: true },
      );
      break;
    }
    case 'hipBag': {
      belt(SLOT.DETAIL, waistY, 0.006, 0.3, 0.34, -1);
      b.slab(
        V(-0.05, waistY - 0.02, m.waistD + bulk + 0.008),
        V(0.09, waistY - 0.02, m.waistD + bulk + 0.030),
        0.040, 0.032, SLOT.DETAIL, BI.hips, 0.45, 0.6,
        new THREE.Vector3(0, 0, 1), 4,
      );
      break;
    }
    default:
      break;
  }

  // A plain belt for trousers when nothing else covers the waist.
  if (
    a.accessory !== 'toolBelt' && a.accessory !== 'builderHarness' && a.accessory !== 'hipBag' &&
    (OUTER_HEM[a.outer] ?? 0) < 0.2 && a.legs !== 'skirt' && a.legs !== 'longSkirt'
  ) {
    belt(SLOT.DETAIL, m.hipY + 0.020, 0.004, 0.3, 0.34, -1);
  }
}

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

function buildCharacterMaterial(a: Appearance, tex: AppearanceTextures): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: tex.map,
    roughnessMap: tex.mra,
    metalnessMap: tex.mra,
    roughness: 1,
    metalness: 1,
    emissive: tex.emissive ? new THREE.Color(0xffffff) : new THREE.Color(0x000000),
    emissiveMap: tex.emissive ?? null,
    emissiveIntensity: tex.emissive ? a.glow : 0,
    side: THREE.FrontSide,
    dithering: true,
  });
}

/* ------------------------------------------------------------------ */
/* Actor                                                               */
/* ------------------------------------------------------------------ */

export interface CharacterActorOptions {
  /** Never LOD out; always full-rate animation and foot IK. */
  hero?: boolean;
  seed?: number;
  castShadow?: boolean;
}

export type FootfallListener = (foot: 'left' | 'right', worldPos: THREE.Vector3, intensity: number) => void;

/** Distance bands (metres) for skeleton update rate. */
const LOD_FULL = 22;
const LOD_HALF = 55;
const LOD_QUARTER = 110;

const _camPos = new THREE.Vector3();
const _actorPos = new THREE.Vector3();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
let _cullFrame = -1;

function refreshCull(ctx: GameContext): void {
  if (_cullFrame === ctx.time.frame) return;
  _cullFrame = ctx.time.frame;
  ctx.camera.getWorldPosition(_camPos);
  _projScreen.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projScreen);
}

export class CharacterActor {
  readonly object = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly rig: Rig;
  readonly anim: AnimationController;
  readonly appearance: Appearance;
  readonly height: number;
  readonly scale: number;

  onFootfall: FootfallListener | null = null;

  /** Foot IK is on for the hero and the nearest peds; the rest plant blind. */
  footIk = false;

  private hero: boolean;
  private ragdollSim: Ragdoll | null = null;
  private accum = 0;
  private lastLodDt = 0;
  private disposed = false;
  private phys: PhysicsWorld | null = null;
  private readonly factory: CharacterFactory;
  private readonly texKey: string;
  private readonly geoKey: string;
  private _visible = true;

  constructor(
    factory: CharacterFactory,
    appearance: Appearance,
    geo: THREE.BufferGeometry,
    mat: THREE.MeshStandardMaterial,
    geoKey: string,
    texKey: string,
    opts: CharacterActorOptions = {},
  ) {
    this.factory = factory;
    this.appearance = appearance;
    this.geoKey = geoKey;
    this.texKey = texKey;
    this.hero = opts.hero === true;
    this.height = appearance.height;
    this.scale = appearance.height / NOMINAL_HEIGHT;

    this.rig = buildRig(bodyMetrics(appearance.body, appearance.female));
    this.mesh = new THREE.SkinnedMesh(geo, mat);
    this.mesh.castShadow = opts.castShadow !== false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
    this.mesh.add(this.rig.root);
    this.mesh.bind(this.rig.skeleton, new THREE.Matrix4());

    this.object.add(this.mesh);
    this.object.scale.setScalar(this.scale);
    this.object.name = `char:${appearance.id}`;

    this.anim = new AnimationController(this.rig, opts.seed ?? 0);
    this.anim.onFootfall = (foot, local, intensity) => {
      if (!this.onFootfall) return;
      _tmpV.copy(local).applyMatrix4(this.object.matrixWorld);
      this.onFootfall(foot, _tmpV, intensity);
    };
    this.footIk = this.hero;
  }

  /* ---- transform ---- */

  setTransform(position: THREE.Vector3, yaw: number): void {
    this.object.position.copy(position);
    this.object.rotation.set(0, yaw, 0);
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  setVisible(v: boolean): void {
    this._visible = v;
    this.object.visible = v;
  }

  get visible(): boolean {
    return this._visible;
  }

  /* ---- animation ---- */

  drive(d: Drive): void {
    this.anim.drive(d);
  }

  playState(s: LocomotionState): void {
    this.anim.request(s);
  }

  /** Additive head/eye tracking. Pass null to release. */
  lookAt(target: THREE.Vector3 | null, weight = 1): void {
    this.anim.setLookTarget(target, weight);
  }

  /** Collapse into a physical ragdoll. `impulse` is in world units/second. */
  ragdoll(impulse?: THREE.Vector3): void {
    if (this.ragdollSim) return;
    this.object.updateMatrixWorld(true);
    this.ragdollSim = new Ragdoll(this.rig, this.object, impulse);
    this.anim.request('ragdoll');
  }

  revive(): void {
    this.ragdollSim = null;
    this.anim.reset('idle');
  }

  get isRagdolling(): boolean {
    return this.ragdollSim !== null;
  }

  /** World-space position of the ragdoll's hips (for respawn / body pickup). */
  get ragdollHips(): THREE.Vector3 | null {
    return this.ragdollSim ? this.ragdollSim.hipsWorld : null;
  }

  /* ---- per-frame ---- */

  update(dt: number, ctx: GameContext): void {
    if (this.disposed || !this._visible) return;
    if (!this.phys) this.phys = ctx.tryGet(Services.Physics) ?? null;

    refreshCull(ctx);
    // The actor may be parented under a mover (the player rig), so LOD has to
    // work off the world transform, not the local one.
    this.object.updateWorldMatrix(true, false);
    _actorPos.setFromMatrixPosition(this.object.matrixWorld);
    const dist = _camPos.distanceTo(_actorPos);

    let rate = 1;
    if (!this.hero) {
      _sphere.center.copy(_actorPos);
      _sphere.center.y += this.height * 0.5;
      _sphere.radius = this.height * 0.7;
      const onScreen = _frustum.intersectsSphere(_sphere);
      if (!onScreen && dist > 6) {
        // Off-screen: freeze the skeleton entirely, but keep the clock running
        // so the character does not snap when it comes back into view.
        this.anim.advanceClockOnly(dt);
        return;
      }
      rate = dist < LOD_FULL ? 1 : dist < LOD_HALF ? 2 : dist < LOD_QUARTER ? 4 : 8;
    }

    this.lastLodDt += dt;
    if (rate > 1 && this.lastLodDt < rate / 60) return;
    const useDt = this.lastLodDt;
    this.lastLodDt = 0;

    if (this.ragdollSim) {
      this.ragdollSim.update(useDt, this.phys);
      this.ragdollSim.apply();
      return;
    }

    this.anim.update(useDt);
    this.anim.applyTo(this.rig);

    const wantIk = this.footIk && (this.hero || dist < LOD_FULL);
    if (wantIk && this.phys && this.anim.groundedPose) {
      this.object.updateMatrixWorld(true);
      this.anim.solveFootIk(this.rig, this.object, this.phys);
    }
  }

  /** Advance nothing but the internal clock (used when culled). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    this.factory.release(this.geoKey, this.texKey);
  }
}

const _tmpV = new THREE.Vector3();

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

interface GeoEntry { geo: THREE.BufferGeometry; refs: number }
interface MatEntry { mat: THREE.MeshStandardMaterial; tex: AppearanceTextures; refs: number }

const FACTORIES = new WeakMap<object, CharacterFactory>();

export class CharacterFactory {
  private geos = new Map<string, GeoEntry>();
  private mats = new Map<string, MatEntry>();
  private actors: CharacterActor[] = [];

  /** One factory per game context so every system shares the caches. */
  static of(ctx: GameContext): CharacterFactory {
    let f = FACTORIES.get(ctx);
    if (!f) {
      f = new CharacterFactory();
      FACTORIES.set(ctx, f);
    }
    return f;
  }

  create(appearance: Appearance, opts: CharacterActorOptions = {}): CharacterActor {
    const geoKey = appearanceGeoKey(appearance);
    const texKey = appearanceTexKey(appearance);

    let ge = this.geos.get(geoKey);
    if (!ge) {
      const rig = buildRig(bodyMetrics(appearance.body, appearance.female));
      ge = { geo: buildHumanoidGeometry(appearance, rig), refs: 0 };
      this.geos.set(geoKey, ge);
    }
    ge.refs++;

    let me = this.mats.get(texKey);
    if (!me) {
      const tex = buildAppearanceTextures(appearance);
      me = { mat: buildCharacterMaterial(appearance, tex), tex, refs: 0 };
      this.mats.set(texKey, me);
    }
    me.refs++;

    const actor = new CharacterActor(this, appearance, ge.geo, me.mat, geoKey, texKey, opts);
    this.actors.push(actor);
    return actor;
  }

  release(geoKey: string, texKey: string): void {
    const ge = this.geos.get(geoKey);
    if (ge && --ge.refs <= 0 && this.geos.size > 48) {
      ge.geo.dispose();
      this.geos.delete(geoKey);
    }
    const me = this.mats.get(texKey);
    if (me && --me.refs <= 0 && this.mats.size > 40) {
      me.mat.dispose();
      me.tex.dispose();
      this.mats.delete(texKey);
    }
  }

  /** Convenience tick for owners that keep a pool of actors. */
  updateAll(dt: number, ctx: GameContext): void {
    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i];
      a.update(dt, ctx);
    }
  }

  get stats(): { geometries: number; materials: number; actors: number } {
    return { geometries: this.geos.size, materials: this.mats.size, actors: this.actors.length };
  }
}
