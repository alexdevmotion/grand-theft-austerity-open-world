/**
 * HUMANOID — skinned geometry, the shared factory, and the actor
 * every gameplay system drives.
 *
 * Named characters use the continuous CC0 anatomical body and authored weights
 * from tailoredBody.ts. Crowd bodies use smaller swept meshes. Both share
 * seated garment panels, layered shoe soles, the atlas, and the same skeleton.
 * Body and garment geometry merge into one skinned draw; fitted heads keep
 * their separate skin, eye and hair materials.
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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GameContext } from '../core/engine';
import { Rng } from '../core/rng';
import { Services, type LocomotionState } from '../core/services';
import type { PhysicsWorld } from '../physics/physics';
import { AnimationController, type Drive } from './animation';
import { CAST, HeroHead } from './face/heroHead';
import { Ragdoll } from './ik';
import { prof } from './profile';
import { addGarmentDetails, buildTailoredBody } from './tailoredBody';
import {
  BI, BONE_COUNT, DIGIT_NAMES, NOMINAL_HEIGHT, bodyMetrics, buildRig,
  type BodyMetrics, type Rig, type RigPoints,
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

/**
 * One ring of the arm sweep: [t, radius, boneA, weightA, boneB].
 * `t` is 0..1 along the upper arm and 1..2 along the forearm, so the elbow is
 * exactly 1 and the sleeve cut is a single number on the same scale.
 */
type ArmRow = [number, number, number, number, number];

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
  // Named cast is inspected close up; crowd geometry keeps its existing cost.
  const torsoRadial = a.cast ? 32 : 12;
  const collarRadial = a.cast ? 28 : 10;
  const armRadial = a.cast ? 20 : 8;
  const anatomical = !!a.cast;

  /* ---------------- torso ---------------- */
  {
    const hipToKnee = m.hipY - m.kneeY;
    const hem = OUTER_HEM[a.outer] ?? 0;
    const bottomY = m.hipY - 0.075 - hipToKnee * hem;
    const skirtOut = hem > 0.4 ? 0.028 + hem * 0.02 : 0;
    const shape = hasOuter ? 2.5 : 2.2;

    interface Prof { y: number; w: number; d: number; back: number; v: number; n?: number }

    /* THE SHOULDER YOKE — why there are four rings up here and not two.
     *
     * The torso used to jump straight from the armpit ring (`yokeY + 12 mm`,
     * half-width `yokeW`) to a neck-root ring at `neckY + 12 mm`, 176 mm above
     * it. The arm's first ring is buried 30-50 mm ABOVE the shoulder joint by
     * design, and at that height the linear interpolation between those two
     * rings had already collapsed the torso to ~117 mm half-width while the
     * deltoid's inner edge sat at 147 mm. Thirty millimetres of nothing, on both
     * sides, exactly where the playtest saw daylight through the shoulder.
     *
     * The fix is anatomical rather than numerical: a body does not taper
     * straight from armpit to neck, it carries an ACROMION (the widest point of
     * the frame, level with the shoulder joint) and then a TRAPEZIUS that slopes
     * up and in to the neck. Both of those rings overlap the deltoid by 40 mm or
     * more, so the arm now emerges from the torso instead of floating beside it.
     * `n` is also relaxed toward a true ellipse as the profile climbs: a 2.5
     * super-ellipse is right for a ribcage under a jacket and gives square,
     * armoured corners on a shoulder. */
    const profile: Prof[] = [
      { y: bottomY, w: m.pelvisW * (hem > 0.4 ? 1.06 : 0.94) + skirtOut, d: m.pelvisD * 0.94 + skirtOut, back: m.pelvisD * 0.98 + skirtOut, v: 0.50 },
      { y: m.hipY - 0.02, w: m.pelvisW, d: m.pelvisD + m.bellyPush * 0.7, back: m.pelvisD, v: 0.40 },
      { y: lerp(m.hipY, m.spineY, 0.55), w: m.waistW * 1.03, d: m.waistD + m.bellyPush, back: m.waistD * 0.96, v: 0.33 },
      { y: m.spineY + 0.03, w: m.waistW, d: m.waistD + m.bellyPush * 0.85, back: m.waistD, v: 0.27 },
      { y: m.chestY, w: lerp(m.waistW, m.chestW, 0.62), d: lerp(m.waistD, m.chestD, 0.7) + m.bustPush * 0.6, back: lerp(m.waistD, m.chestD, 0.6), v: 0.19 },
      { y: lerp(m.chestY, m.yokeY, 0.55), w: m.chestW, d: m.chestD + m.bustPush, back: m.chestD * 0.94, v: 0.12 },
      // armpit
      { y: m.yokeY + 0.012, w: m.yokeW * 0.92, d: m.yokeD, back: m.yokeD * 1.02, v: 0.06, n: shape - 0.2 },
      // deltoid shelf — the torso starts flaring toward the joint
      { y: m.shoulderY - 0.020, w: m.yokeW * 1.02, d: m.yokeD * 0.98, back: m.yokeD * 1.02, v: 0.048, n: 2.2 },
      // ACROMION. The widest ring on the body and the one that does the work.
      //
      // It has to reach further out than the top of the deltoid's own capped
      // root ring, or the two silhouettes come apart above the joint and that
      // notch is the daylight. So it is DERIVED from where the arm actually
      // starts rather than picked as a fraction of the yoke: a fixed multiple
      // of `yokeW` holds on 'average' and fails on 'slim' and 'tall', whose
      // yoke narrows with girth while their shoulder joints and deltoids do
      // not. `shoulderHalf + 0.62 * deltoidR` is the arm root's outer edge; the
      // 8 mm covers the sleeve's own bulk on an unjacketed build. Asserted per
      // body type by the silhouette raster in body.test.ts.
      { y: m.shoulderY + 0.014, w: Math.max(m.yokeW * 1.02, m.shoulderHalf + m.deltoidR * 0.62 + 0.008), d: m.yokeD * 0.94, back: m.yokeD * 0.98, v: 0.040, n: 2.15 },
      // trapezius, sloping up and in to the neck
      { y: m.shoulderY + 0.040, w: m.yokeW * 0.78, d: m.yokeD * 0.84, back: m.yokeD * 0.92, v: 0.028, n: 2.1 },
      // neck root
      { y: m.neckY + 0.014, w: m.yokeW * 0.50, d: m.yokeD * 0.72, back: m.yokeD * 0.80, v: 0.015, n: 2.05 },
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
        n: pr.n ?? shape,
        b0: w[0], w0: w[1], b1: w[2], w1: w[3],
        v: pr.v,
      };
    });
    if (!anatomical) b.tube(rings, torsoRadial, torsoSlot, { capStart: hem < 0.4, capEnd: true });

    // Open coat/apron hem: a short inner skirt so the silhouette has depth.
    if (hem > 0.4 && !anatomical) {
      const inner = rings[0];
      b.tube(
        [
          { ...inner, rx: inner.rx * 0.86, rzF: inner.rzF * 0.86, rzB: (inner.rzB ?? inner.rzF) * 0.86, v: 0.52 },
          { ...rings[1], rx: rings[1].rx * 0.9, rzF: rings[1].rzF * 0.9, rzB: (rings[1].rzB ?? rings[1].rzF) * 0.9, v: 0.42 },
        ],
        torsoRadial, torsoSlot, { capStart: true },
      );
    }

    // Collar / visible shirt at the neck when something is worn over it.
    if (hasOuter && !anatomical) {
      const y0 = m.neckY - 0.02;
      const w = spineWeights(y0, m);
      // A raised cast collar has one exposed rim. The taller shirt tube
      // otherwise cuts across it as the neck and upper-chest weights diverge.
      if (!(a.cast && a.collarUp)) {
        b.tube(
          [
            { c: V(0, y0, 0.006), dir: UPV, rx: m.neckR * 1.55, rzF: m.neckR * 1.5, n: 2.4, b0: w[0], w0: w[1], b1: w[2], w1: w[3], v: 0.03 },
            { c: V(0, m.neckY + 0.045, 0.004), dir: UPV, rx: m.neckR * 1.22, rzF: m.neckR * 1.2, n: 2.2, b0: BI.neck, w0: 1, v: 0.005 },
          ],
          collarRadial, SLOT.TOP, {},
        );
      }

      /* COLLAR UP. The shirt neckline above tops out 25 mm below the chin, which
       * on a bearded man leaves a bare column of neck as the brightest thing in
       * a portrait — see `Appearance.collarUp`.
       *
       * A popped collar is not the same tube made taller. It rises to the jaw,
       * it FLARES outward as it rises instead of tapering (that is the whole
       * difference between a collar standing up and one lying down), and it is
       * cut from the OUTER slot, because the thing standing up is the jacket and
       * not the tee underneath it. It stops short of the chin at the front and
       * carries its full height at the sides and back, which is how a real
       * turned-up collar sits and also leaves the beard somewhere to end. */
      if (a.collarUp) {
        /* HOW HIGH. The first pass took the collar to `chin - 12 mm`, which on
         * this rig is 60 of the 70 mm between the neck root and the jaw: the
         * head then sat straight on the jacket and the playtest reported "no
         * neck". A turned-up collar stops at the base of the ear, not under the
         * lip. Topping out 55% of the way to the chin leaves ~32 mm of lit neck
         * column under the jaw — enough to read as a neck at gameplay distance,
         * short enough that the beard still ends somewhere. */
        const chin = m.headY - 0.010;
        const top = lerp(m.neckY, chin, 0.55);
        const wl = spineWeights(m.neckY - 0.01, m);
        b.tube(
          [
            { c: V(0, m.neckY - 0.014, 0.004), dir: UPV, rx: m.neckR * 1.66, rzF: m.neckR * 1.58, rzB: m.neckR * 1.70, n: 2.4, b0: wl[0], w0: wl[1], b1: wl[2], w1: wl[3], v: 0.03 },
            { c: V(0, lerp(m.neckY, top, 0.5), -0.002), dir: UPV, rx: m.neckR * 1.52, rzF: m.neckR * 1.42, rzB: m.neckR * 1.62, n: 2.3, b0: BI.neck, w0: 0.85, b1: BI.upperChest, w1: 0.15, v: 0.02 },
            { c: V(0, top, -0.008), dir: UPV, rx: m.neckR * 1.70, rzF: m.neckR * 1.40, rzB: m.neckR * 1.82, n: 2.2, b0: BI.neck, w0: 1, v: 0.008 },
          ],
          a.cast ? collarRadial : 12, SLOT.OUTER, {},
        );
      }
    }
  }

  /* ---------------- neck ----------------
   * A COLUMN, not a peg. Three rings was enough shape but not enough overlap:
   * the bottom ring started 35 mm below the neck joint, which is inside the
   * trapezius shelf, and the whole thing was then hidden by the collar. It now
   * starts lower and wider (that flare IS the sternocleidomastoid running down
   * to the collarbones — the thing that makes a neck read as attached), narrows
   * through the middle, and swells again where it meets the jaw. It also leans
   * very slightly forward, which every human neck does and which stops the head
   * from looking bolted on from the side. */
  const chinY = m.headY - 0.010;
  const crownY = m.headTopY;
  {
    b.tube(
      [
        { c: V(0, m.neckY - 0.058, -0.008), dir: UPV, rx: m.neckR * 1.46, rzF: m.neckR * 1.30, rzB: m.neckR * 1.34, n: 2.2, b0: BI.upperChest, w0: 0.80, b1: BI.neck, w1: 0.20, v: 0.66 },
        { c: V(0, m.neckY - 0.020, -0.006), dir: UPV, rx: m.neckR * 1.16, rzF: m.neckR * 1.12, rzB: m.neckR * 1.18, n: 2.1, b0: BI.upperChest, w0: 0.42, b1: BI.neck, w1: 0.58, v: 0.62 },
        { c: V(0, m.neckY + 0.030, -0.002), dir: UPV, rx: m.neckR, rzF: m.neckR * 1.02, b0: BI.neck, w0: 1, v: 0.56 },
        { c: V(0, chinY + 0.006, 0.005), dir: UPV, rx: m.neckR * 1.05, rzF: m.neckR * 1.10, b0: BI.neck, w0: 0.55, b1: BI.head, w1: 0.45, v: 0.52 },
        { c: V(0, chinY + 0.026, 0.006), dir: UPV, rx: m.neckR * 1.00, rzF: m.neckR * 1.08, b0: BI.neck, w0: 0.25, b1: BI.head, w1: 0.75, v: 0.5 },
      ],
      a.cast ? 28 : 10, SLOT.SKIN, {},
    );
  }

  /* ---------------- head ----------------
   * Named cast members get a landmark-fitted head parented to the head bone
   * instead (see face/heroHead.ts), so the low-poly skull, nose, ears and hair
   * are left out entirely rather than hidden inside it. */
  if (!a.cast) {
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
  if (!a.cast) buildHair(b, a, m, chinY, crownY);
  buildHeadwear(b, a, m, chinY, crownY);

  /* ---------------- arms ---------------- */
  if (!anatomical) for (const s of [1, -1] as const) {
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
    /** Direction through the elbow itself — the average of the two segments, so
     *  the ring sitting ON the joint belongs to both and neither pinches. */
    const dEl = dUp.clone().add(dLo).normalize();

    /* ONE ARM, NOT TWO CAPSULES.
     *
     * The upper arm and the forearm used to be two independent `tube()` calls
     * that met at the elbow. Independent tubes do not share vertices, so
     * `computeVertexNormals` gave the joint two opposing hard rims; the radii
     * either side of the seam disagreed by 5%; and the sweep direction stepped
     * discontinuously from `dUp` to `dLo`. All three cues say "two objects" and
     * the eye picks that up long before it can resolve an elbow — which is
     * exactly what the playtest reported.
     *
     * The whole limb is now a single ring chain from the buried shoulder root to
     * the wrist. One ring sits on the elbow with the averaged direction and a
     * 50/50 bind, so the surface is continuous through the joint in bind pose
     * AND stays continuous when the animation bends it.
     *
     * `t` runs 0..1 along the upper arm and 1..2 along the forearm, which keeps
     * the taper table readable and lets the sleeve cut be a single number.
     */
    const armPoint = (t: number): THREE.Vector3 =>
      t <= 1 ? at(shoulder, dUp, t, upLen) : at(elbow, dLo, t - 1, loLen);
    const armDir = (t: number): THREE.Vector3 =>
      t < 0.98 ? dUp : t > 1.02 ? dLo : dEl;

    // Sleeve v: 0.60 at the shoulder seam .. 0.80 at the elbow .. 0.99 cuff.
    // Bare skin runs the SKIN column's forearm band, 0.30 .. 0.49.
    // On the 0..2 scale a short sleeve stops just under halfway down the UPPER
    // arm — 0.45, not 1.45. (1.45 puts the cuff past the elbow, which both
    // looks wrong and splits the elbow across two surfaces.)
    const sleeveEndT = bare ? 0.45 : 2.0;
    const vAt = (t: number) => (t <= sleeveEndT ? 0.60 + t * 0.195 : 0.30 + (t - 1) * 0.19);

    /** [t, radius, boneA, weightA, boneB] — one row per ring. */
    const armTaper: ArmRow[] = [
      // The root ring is CAPPED, so its disc is the top of the arm's silhouette
      // and it must sit under the acromion ring of the torso. Small and barely
      // above the joint: a jacket's shoulder is carried by the torso's own
      // shoulder seam, and the sleeve head starts just below it. Pushing this
      // ring higher or fatter is precisely what tore the arm off the body.
      [-0.012, m.deltoidR * 0.60, clav, 0.55, upper],
      [0.060, m.deltoidR * 0.98, clav, 0.30, upper],
      [0.190, m.deltoidR * 1.00, upper, 0.92, clav],
      [0.360, m.deltoidR * 0.86, upper, 1, upper],
      [0.620, m.upperArmR * 1.02, upper, 1, upper],
      [0.880, m.elbowR * 1.10, upper, 0.86, fore],
      // the joint
      [1.000, m.elbowR * 1.14, upper, 0.5, fore],
      [1.120, m.elbowR * 1.08, fore, 0.86, upper],
      [1.320, m.forearmR, fore, 1, fore],
      [1.640, lerp(m.forearmR, m.wristR, 0.62), fore, 1, fore],
      [1.860, m.wristR * 1.14, fore, 1, fore],
      [2.000, m.wristR * 0.98, fore, 0.5, hand],
    ];

    const armRing = (row: ArmRow): Ring => {
      const [t, r, b0, w0, b1] = row;
      const clothed = t <= sleeveEndT;
      // The cuff keeps its bulk; a rolled sleeve loses it over the last 10%.
      const inf = clothed ? sleeveBulk * (t > 1.86 ? cuffT : 1) : 0;
      return {
        c: armPoint(t), dir: armDir(t),
        rx: r + inf, rzF: r * 0.97 + inf, rzB: r * 1.02 + inf,
        n: t < 0.35 ? 2.15 : 2,
        b0, w0, b1, w1: 1 - w0,
        v: vAt(t),
      };
    };

    if (!bare) {
      // Long sleeve: shoulder to cuff, one surface, one slot.
      b.tube(armTaper.map(armRing), armRadial, sleeveSlot, { capStart: true });
    } else {
      /* A short sleeve is a real edge in the world, so it gets a real seam here.
       * The two chains share the cut ring exactly (same centre, same direction,
       * the sleeve's copy only carries the cloth's bulk), and — the part that
       * matters — the SKIN chain still runs unbroken from the cut through the
       * elbow to the wrist. The elbow is interior to one chain either way, which
       * is the whole point of this rewrite. */
      const cutT = sleeveEndT;
      const cutRow: ArmRow = [cutT, m.upperArmR * 1.02, upper, 1, upper];
      const sleeve = armTaper.filter((r) => r[0] < cutT).map(armRing);
      sleeve.push(armRing(cutRow));
      b.tube(sleeve, armRadial, sleeveSlot, { capStart: true });

      const skin = [cutRow, ...armTaper.filter((r) => r[0] > cutT)].map((row) => {
        const ring = armRing(row);
        // Same centres, no cloth bulk, and the SKIN column's own v ramp.
        return { ...ring, rx: row[1], rzF: row[1] * 0.97, rzB: row[1] * 1.02, v: 0.30 + (row[0] - 1) * 0.19 };
      });
      b.tube(skin, armRadial, SLOT.SKIN, {});
    }

    buildHand(b, m, rig, L, hand);
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

    if (!skirt && !anatomical) {
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
      /* Re-key the v ramp so trousers run 0 -> 0.78 down the column — which the
       * comment always claimed and the arithmetic never did. `t` reaches 2.0 at
       * the ankle, so a 0.39 factor topped the leg out at v = 0.37: the whole
       * garment lived in the pale first third of its own column, the base colour
       * at v = 0.5 was never reached at all, and the two features `legStyle`
       * paints below that — the knee fade at 0.40 and the dark cuff at 0.78 —
       * landed on nothing. That is why dark denim rendered as pale grey with no
       * shading down the leg. */
      for (const r of rings) r.v = THREE.MathUtils.clamp(r.v * 0.975, 0, 0.99);
      const trouserRings = rings.filter((_, i) => i <= (shorts ? 3 : 7));
      b.tube(trouserRings, 9, shorts ? SLOT.LEGS : SLOT.LEGS, { capStart: true });
      if (shorts) {
        const bare = rings.slice(3).map((r) => ({ ...r, rx: r.rx - trouser, rzF: r.rzF - trouser, rzB: (r.rzB ?? r.rzF) - trouser, v: 0.30 + (r.v) * 0.2 }));
        b.tube(bare, 9, SLOT.SKIN, {});
      }
    } else if (!anatomical) {
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
      a.cast ? 16 : 10, SLOT.SHOES, { capStart: true, capEnd: true },
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
    // An outsole has its own silhouette and welt. It must not be a white
    // texture stripe wrapped around the toe of the upper.
    const soleV = a.shoes === 'sneakers' ? .76 : .91;
    const soleRows: Array<[number, number]> = [[-m.heelBack,.82],[-.018,.98],[m.footLen*.24,1.05],[m.footLen*.48,.99],[m.footLen*.68,.65]];
    b.tube(soleRows.map(([z,w]) => ({
      c: V(ankle.x,.011,ankle.z+z), dir: FRONT, ref: UPV,
      rx:m.footW*w+.003,rzF:.010,rzB:.010,n:3.7,
      b0:foot,w0:1,v:soleV,
    })), a.cast ? 16 : 10, SLOT.SHOES, {capStart:true,capEnd:true});
    if (a.cast) {
      // Facing quarters and paired laces follow the instep rather than drawing
      // decoration around the entire boot as a latitude band.
      for (let k=0;k<5;k++) {
        const z=ankle.z+.004+k*.014;
        const y=.095-k*.005;
        b.slab(V(ankle.x-.020,y,z),V(ankle.x+.020,y-.001,z+.006),.0011,.0011,SLOT.DETAIL,foot,.32,.32,UPV,3);
      }
      for (const side of [-1,1]) {
        b.slab(V(ankle.x+side*.024,.100,ankle.z-.002),V(ankle.x+side*.027,.068,ankle.z+.068),.0015,.0013,SLOT.SHOES,foot,.50,.50,UPV,3);
      }
    }
  }

  /* ---------------- skirt ----------------
   *
   * A SKIRT IS A GARMENT AND HAS TO BE BUILT.
   *
   * It never was. `legs: 'skirt' | 'longSkirt'` only ever DELETED the trouser
   * tube and replaced the leg with a bare `SLOT.SKIN` column (see the `skirt`
   * branch above) — nothing anywhere added a skirt. The single thing that
   * covered the gap was `OUTER_HEM`, which is keyed on `a.outer` and knows
   * nothing about what the legs are wearing, so a skirt-wearer in a jacket
   * (hem 0.16), a denim jacket (0.08) or no outer garment at all (0) walked
   * the street bare from the hip to the ankle.
   *
   * That was 2.3% of every appearance rolled across all eight archetypes, and
   * 100% of those were skirt-wearers — a routine, common, fully-clothed-looking
   * wardrobe roll producing a nude pedestrian. `body.test.ts` now asserts the
   * mid-thigh is covered for every archetype, body type, sex and seed.
   *
   * The skirt hangs from the waist off the HIPS bone alone. It deliberately
   * does not blend into the thighs: a skirt is not skinned to the legs, and
   * weighting the hem to them is what makes one shear open mid-stride. The
   * flare is what keeps the legs inside it instead.
   */
  if (skirt) {
    const hipToKnee = m.hipY - m.kneeY;
    const long = a.legs === 'longSkirt';
    const topY = lerp(m.hipY, m.spineY, 0.34);
    const hemY = m.hipY - hipToKnee * (long ? 1.32 : 0.54);
    const wTop = lerp(m.waistW, m.pelvisW, 0.75);
    const dTop = lerp(m.waistD, m.pelvisD, 0.75);
    // Widest at the hip, then falling to a hem wide enough to clear a stride.
    const flare = long ? 1.30 : 1.22;
    const wt = spineWeights(topY, m);
    const hipsOnly = { b0: BI.hips, w0: 1, b1: BI.hips, w1: 0 };

    b.tube(
      [
        { c: V(0, topY, 0), dir: UPV, rx: wTop, rzF: dTop, rzB: dTop * 1.02, n: 2.2, b0: wt[0], w0: wt[1], b1: wt[2], w1: wt[3], v: 0.03 },
        { c: V(0, m.hipY - 0.012, 0), dir: UPV, rx: m.pelvisW * 1.02, rzF: m.pelvisD * 1.0, rzB: m.pelvisD * 1.04, n: 2.3, ...hipsOnly, v: 0.18 },
        { c: V(0, lerp(m.hipY, hemY, 0.55), 0), dir: UPV, rx: m.pelvisW * lerp(1.02, flare, 0.55), rzF: m.pelvisD * lerp(1.0, flare, 0.55), rzB: m.pelvisD * lerp(1.04, flare, 0.55), n: 2.25, ...hipsOnly, v: 0.50 },
        { c: V(0, hemY, 0), dir: UPV, rx: m.pelvisW * flare, rzF: m.pelvisD * flare, rzB: m.pelvisD * flare * 1.03, n: 2.2, ...hipsOnly, v: 0.80 },
      ],
      12, SLOT.LEGS, { capStart: true, capEnd: true },
    );
  }

  /* ---------------- accessories ---------------- */
  if (!(anatomical && (a.accessory === 'sitePass' || a.accessory === 'lanyard'))) buildAccessory(b, a, m, rig.points, rng);

  const extras = b.build();
  if (!anatomical) {
    addGarmentDetails(extras, a, rig);
    return extras;
  }
  const body = buildTailoredBody(a, rig);
  const geometry = mergeGeometries([body, extras])!;
  geometry.userData = { ...body.userData };
  geometry.boundingBox = extras.boundingBox!.clone();
  geometry.boundingSphere = extras.boundingSphere!.clone();
  body.dispose(); extras.dispose();
  return geometry;
}

/* ---------------- hands ---------------- */

/**
 * A HAND, not a stump.
 *
 * What was here before was a four-ring tapered block with one slab glued to the
 * side for a thumb: from any distance the character had mittens, and at the
 * wheel he had two paddles resting on the rim. Hands are the second thing after
 * the face that an eye checks a humanoid against, and they are on screen
 * permanently in third person.
 *
 * This builds the real thing in the hand's own frame (`rig.points.hand`):
 *   - a PALM whose cross-section is wide across the knuckles and thin through
 *     the back, with a thenar bulge under the thumb, tapering toward the wrist
 *   - FOUR FINGERS, each two swept tapered tubes over its own two bones, with
 *     a visible knuckle swell and a rounded tip
 *   - an OPPOSED THUMB set low and forward on the palm, angled across it
 *
 * Every ring is bound to the bone that moves it, so the fingers articulate.
 * Radial resolution is deliberately low (5 columns per finger); at the size a
 * finger occupies on screen, its silhouette is carried by its taper and its
 * curl, and never by the number of sides on the tube.
 */
function buildHand(
  b: SkinBuilder, m: BodyMetrics, rig: Rig, L: 'L' | 'R', handBone: number,
): void {
  const P = rig.points.joint;
  const wrist = P[`hand${L}` as 'handL'];
  const f = rig.points.hand[L];
  const down = f.down;
  const across = f.across;   // toward the thumb
  const palmN = f.palmN;     // out of the palm

  // Palm thickness and half-width. `handW` is the half-width across the
  // knuckles, `handT` the half-thickness through the palm.
  const kW = m.handW;
  const kT = m.handT;
  const at = (t: number, a = 0, n = 0): THREE.Vector3 =>
    wrist.clone().addScaledVector(down, m.handLen * t)
      .addScaledVector(across, kW * a)
      .addScaledVector(palmN, kT * n);

  /* ---- palm ----
   * `ref: palmN` puts the ring's local +Z along the palm normal, so `rzF/rzB`
   * is the palm's THICKNESS and `rx` — the ring's other axis, `dir x ref` — is
   * the half-width ACROSS the knuckles. A palm is roughly twice as wide as it
   * is thick; getting these two the wrong way round is what turns a hand into
   * a bar of soap. */
  const palmRing = (t: number, halfAcross: number, halfThick: number, a: number, v: number): Ring => ({
    c: at(t, a, 0), dir: down, rx: halfAcross * kW, rzF: halfThick * kT, rzB: halfThick * kT,
    n: 3.0, b0: handBone, w0: 1, v, ref: palmN,
  });
  b.tube(
    [
      palmRing(0.02, 0.62, 0.74, 0.02, 0.50),
      palmRing(0.18, 0.82, 0.86, 0.06, 0.53),
      palmRing(0.38, 0.92, 0.80, 0.05, 0.56),
      palmRing(0.55, 0.90, 0.66, 0.00, 0.59),
    ],
    9, SLOT.SKIN, { capStart: true, capEnd: true },
  );
  // Thenar eminence — the muscle pad at the base of the thumb. Without it the
  // palm reads as a card with sticks on it.
  b.tube(
    [
      { c: at(0.08, 0.44, 0.26), dir: down, rx: kW * 0.24, rzF: kT * 0.52, n: 3, b0: handBone, w0: 1, v: 0.52, ref: palmN },
      { c: at(0.24, 0.54, 0.30), dir: down, rx: kW * 0.28, rzF: kT * 0.58, n: 3, b0: handBone, w0: 1, v: 0.55, ref: palmN },
      { c: at(0.42, 0.48, 0.16), dir: down, rx: kW * 0.22, rzF: kT * 0.44, n: 3, b0: handBone, w0: 1, v: 0.58, ref: palmN },
    ],
    7, SLOT.SKIN, { capStart: true, capEnd: true },
  );

  /* ---- digits ---- */
  for (let d = 0; d < DIGIT_NAMES.length; d++) {
    const name = DIGIT_NAMES[d];
    const prox = BI[`${name}0${L}` as 'index0L'];
    const dist = BI[`${name}1${L}` as 'index1L'];
    const j0 = P[`${name}0${L}` as 'index0L'];
    const j1 = P[`${name}1${L}` as 'index1L'];
    const tipDir = rig.points.dir[`${name}1${L}` as 'index1L'];
    const len1 = rig.points.len[`${name}1${L}` as 'index1L'];
    const d0 = j1.clone().sub(j0).normalize();
    const tip = j1.clone().addScaledVector(tipDir, len1);

    // Fingers taper from the knuckle to the nail; the thumb is thicker. The
    // four knuckles are 0.53 * handW apart, so anything above ~0.26 fuses the
    // fingers into a mitten.
    const base = (name === 'thumb' ? 0.30 : 0.245) * kW;
    const mid = base * 0.88;
    const end = base * 0.74;
    const R = (r: number): Partial<Ring> => ({ rx: r, rzF: r * 0.90, rzB: r * 0.90, ref: palmN });

    b.tube(
      [
        // buried a little inside the palm so the knuckle is a joint, not a peg
        { c: j0.clone().addScaledVector(d0, -m.handLen * 0.045), dir: d0, ...R(base * 1.02), n: 2.6, b0: handBone, w0: 0.6, b1: prox, w1: 0.4, v: 0.50 } as Ring,
        { c: j0.clone().addScaledVector(d0, m.handLen * 0.035), dir: d0, ...R(base), n: 2.6, b0: handBone, w0: 0.2, b1: prox, w1: 0.8, v: 0.53 } as Ring,
        { c: j1.clone().addScaledVector(d0, -m.handLen * 0.018), dir: d0, ...R(mid * 1.05), n: 2.5, b0: prox, w0: 0.6, b1: dist, w1: 0.4, v: 0.58 } as Ring,
        { c: j1.clone().addScaledVector(tipDir, len1 * 0.30), dir: tipDir, ...R(mid), n: 2.5, b0: dist, w0: 1, v: 0.62 } as Ring,
        { c: j1.clone().addScaledVector(tipDir, len1 * 0.82), dir: tipDir, ...R(end), n: 2.4, b0: dist, w0: 1, v: 0.66 } as Ring,
        { c: tip, dir: tipDir, ...R(end * 0.48), n: 2.4, b0: dist, w0: 1, v: 0.68 } as Ring,
      ],
      5, SLOT.SKIN, { capStart: true, capEnd: true },
    );
  }
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

function buildAccessory(
  b: SkinBuilder, a: Appearance, m: BodyMetrics, points: RigPoints, rng: Rng,
): void {
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
    case 'sitePass': {
      /* A SITE PASS ON A CORD, AND A WRISTBAND. That is the whole purple.
       *
       * What was here before was a full utility harness: braces over both
       * shoulders front and back, a belt, a buckle plate and two hip loops, all
       * in `accent` and all on a character whose accent is 0x7b3fd4. Measured
       * as area it was roughly a fifth of his front silhouette, and because
       * everything else he wears sits at 1-3% albedo it was also, by a wide
       * margin, the brightest and most saturated object on him. The reference
       * frame has no such thing: both men there are plain-clothed, and the only
       * saturated purple in the image is a car panel and the light coming out
       * of a building.
       *
       * The story note asks for ONE exaggerated purple builder accessory. A
       * pass on a cord is exactly that and reads harder for being small: it
       * says he is a man who has to badge into places, which is the character,
       * where a harness only said "hi-vis extra".
       *
       * The cord is a real loop — over the trapezius on both sides, down the
       * front to the badge — so it survives the shoulders moving under it. */
      const neckX = m.neckR * 1.02;
      const badgeY = lerp(m.chestY, waistY, 0.22);
      const chestZ = chestF - 0.004;
      /* A CORD IS ONLY A CORD IF IT IS ON THE CLOTH. The torso is ~135 mm deep
       * at the yoke once a jacket's bulk is on it, so anchoring the top of the
       * strap anywhere near the midline buries the whole upper half inside the
       * jacket and leaves two tabs floating above the badge — which is exactly
       * what the first cut of this looked like. Every point below is measured
       * off `yokeD`/`chestD` PLUS the garment bulk. */
      /* THE DEPTHS ARE THE WHOLE JOB. `yokeD` is a HALF-DEPTH: the cloth at the
       * shoulder sits at `yokeD + bulk` ≈ 137 mm from the midline, and the
       * first cut of this anchored the cord at 62% of `yokeD` — 94 mm — which
       * put its entire upper half inside the jacket and left two purple tabs
       * apparently growing out of the badge. Every anchor below is the ring's
       * own radius plus the garment bulk, trimmed by the few per cent the
       * super-ellipse loses at the strap's x. */
      const yokeR = m.yokeD + bulk;
      const chestR = m.chestD + bulk;
      const napeZ = -yokeR * 0.94;
      const collarZ = yokeR * 0.96;
      for (const s of [1, -1] as const) {
        // over the trapezius, nape to collarbone
        b.slab(
          V(s * neckX, m.neckY - 0.016, napeZ),
          V(s * (neckX + 0.014), m.shoulderY - 0.012, collarZ),
          0.008, 0.004, SLOT.ACCENT, BI.upperChest, 0.06, 0.22, UPV, 3,
        );
        // down the chest — in two runs, because the torso is deepest at the
        // sternum and a single straight chord sinks into it halfway down
        b.slab(
          V(s * (neckX + 0.014), m.shoulderY - 0.012, collarZ),
          V(s * 0.040, m.chestY + 0.010, chestR + 0.008),
          0.008, 0.004, SLOT.ACCENT, BI.chest, 0.22, 0.38, FRONT, 3,
        );
        b.slab(
          V(s * 0.040, m.chestY + 0.010, chestR + 0.008),
          V(s * 0.024, badgeY + 0.036, chestZ),
          0.008, 0.004, SLOT.ACCENT, BI.chest, 0.38, 0.5, FRONT, 3,
        );
      }
      // The pass itself — a plate, portrait, worn slightly proud of the jacket.
      b.slab(
        V(0, badgeY, chestZ + 0.002),
        V(0, badgeY, chestZ + 0.009),
        0.030, 0.040, SLOT.ACCENT, BI.chest, 0.42, 0.5, UPV, 6,
      );
      // Wristband on the off hand. Bound to the hand bone so it stays put.
      {
        const wrist = points.joint.handL;
        const down = points.dir.handL;
        b.tube(
          [
            { c: wrist.clone().addScaledVector(down, -0.014), dir: down, rx: m.wristR * 1.10, rzF: m.wristR * 0.94, n: 3.0, b0: BI.handL, w0: 1, v: 0.78 },
            { c: wrist.clone().addScaledVector(down, 0.020), dir: down, rx: m.wristR * 1.10, rzF: m.wristR * 0.94, n: 3.0, b0: BI.handL, w0: 1, v: 0.86 },
          ],
          10, SLOT.ACCENT, {},
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
    // `sitePass` is no longer on the list: it carries nothing at the waist, so
    // the trousers get their own plain belt back, in `detail` and not `accent`.
    a.accessory !== 'toolBelt' && a.accessory !== 'hipBag' &&
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
    bumpMap: tex.bump,
    bumpScale: a.cast ? .00045 : .00025,
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
/** Past this a finger is sub-pixel; the crowd leaves its hands in bind pose. */
const LOD_HANDS = 9;
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
  private ragdollAnchor: THREE.Vector3 | null = null;
  private accum = 0;
  private lastLodDt = 0;
  private disposed = false;
  private phys: PhysicsWorld | null = null;
  private readonly factory: CharacterFactory;
  private readonly texKey: string;
  private readonly geoKey: string;
  private _visible = true;
  /** Only ever non-null for the four named cast members. */
  private heroHead: HeroHead | null = null;

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

    if (appearance.cast) {
      const t = prof.begin();
      const m = this.rig.metrics;
      this.heroHead = new HeroHead(CAST[appearance.cast], {
        chinY: m.headY - 0.010,
        crownY: m.headTopY,
        boneOrigin: this.rig.points.joint.head,
        seed: opts.seed ?? 0,
        // The player is the one face the camera ever gets close to.
        detail: appearance.cast === 'player' ? 1 : 0.8,
      });
      this.heroHead.attachTo(this.rig.byName.head);
      prof.add('factory.heroHead', t);
      // Inspection hook: nothing in gameplay spawns the story cast yet, so this
      // is how Nicusor's and Alex's heads get looked at.
      const swap = (id: 'player' | 'nicusor' | 'ally'): void => {
        this.heroHead?.dispose();
        this.heroHead = new HeroHead(CAST[id], {
          chinY: m.headY - 0.010,
          crownY: m.headTopY,
          boneOrigin: this.rig.points.joint.head,
          seed: opts.seed ?? 0,
          detail: 1,
        });
        this.heroHead.attachTo(this.rig.byName.head);
        HeroHead.debugHook(this.heroHead, swap);
      };
      HeroHead.debugHook(this.heroHead, swap);
    }

    /* PER-PERSON GAIT. The crowd gets the full spread — that is the whole
     * point of it — but the hero is the one body the camera lives behind for
     * hours, and a quirk you cannot un-see is a different thing on him than it
     * is on a stranger crossing the road. He walks at 40% of the spread, which
     * still separates him from the pedestrian beside him, and `gaitStyleFor`
     * gates the limp on the same number so he never draws one. */
    this.anim = new AnimationController(this.rig, opts.seed ?? 0, this.hero ? 0.4 : 1);
    // The hero's hands are on screen permanently; everyone else's are earned by
    // distance. See `Pose.limit`.
    this.anim.handDetail = this.hero;
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

  /** Anchor a visual ragdoll to an authoritative external physics proxy. */
  anchorRagdollHips(position: THREE.Vector3 | null): void {
    if (!position) {
      this.ragdollAnchor = null;
      return;
    }
    (this.ragdollAnchor ??= new THREE.Vector3()).copy(position);
  }

  revive(): void {
    this.ragdollSim = null;
    this.ragdollAnchor = null;
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

    // The hero face runs its own distance LOD: full scattering and micro-detail
    // near the camera, standard material past ~30 m.
    if (this.heroHead) this.heroHead.update(ctx, dist);

    // Corpse motion is gameplay physics, not an animation LOD. It must keep
    // following its authoritative proxy even outside the camera frustum or it
    // will jump back through walls when it becomes visible again.
    if (this.ragdollSim) {
      this.ragdollSim.update(dt, this.phys, this.ragdollAnchor ?? undefined);
      this.ragdollSim.apply();
      return;
    }

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
      // Fingers are worth evaluating only when they cover more than a pixel.
      const wantHands = dist < LOD_HANDS;
      if (this.anim.handDetail !== wantHands) this.anim.handDetail = wantHands;
    }

    this.lastLodDt += dt;
    if (rate > 1 && this.lastLodDt < rate / 60) return;
    const useDt = this.lastLodDt;
    this.lastLodDt = 0;

    let tp = prof.begin();
    this.anim.update(useDt);
    prof.add('actor.anim', tp);

    tp = prof.begin();
    this.anim.applyTo(this.rig);
    prof.add('actor.applyTo', tp);

    const wantIk = this.footIk && (this.hero || dist < LOD_FULL);
    if (wantIk && this.phys && this.anim.groundedPose) {
      tp = prof.begin();
      this.object.updateMatrixWorld(true);
      prof.add('actor.matrixWorld', tp);
      tp = prof.begin();
      this.anim.solveFootIk(this.rig, this.object, this.phys);
      prof.add('actor.footIk', tp);
    }
  }

  /** Advance nothing but the internal clock (used when culled). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.object.removeFromParent();
    // The skeleton is per-actor (only its bind inverses are shared), and once
    // the actor has rendered once the renderer has attached a bone texture to
    // it. Neither is reachable from the geometry/material caches, so without
    // this every promote/demote cycle in the crowd leaks a 22-bone matrix
    // buffer and one GPU texture for the rest of the session.
    this.rig.skeleton.dispose();
    if (this.heroHead) {
      this.heroHead.dispose();
      this.heroHead = null;
    }
    this.factory.forget(this);
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
      const t = prof.begin();
      const rig = buildRig(bodyMetrics(appearance.body, appearance.female));
      ge = { geo: buildHumanoidGeometry(appearance, rig), refs: 0 };
      this.geos.set(geoKey, ge);
      prof.add('factory.geoMiss', t);
    } else {
      prof.count('factory.geoHit');
    }
    ge.refs++;

    let me = this.mats.get(texKey);
    if (!me) {
      const t = prof.begin();
      const tex = buildAppearanceTextures(appearance);
      me = { mat: buildCharacterMaterial(appearance, tex), tex, refs: 0 };
      this.mats.set(texKey, me);
      prof.add('factory.texMiss', t);
    } else {
      prof.count('factory.texHit');
    }
    me.refs++;

    const actor = new CharacterActor(this, appearance, ge.geo, me.mat, geoKey, texKey, opts);
    this.actors.push(actor);
    return actor;
  }

  /**
   * Drop a disposed actor from the live list.
   *
   * `create` pushes every actor here and nothing used to take them out, so the
   * array grew for the life of the session in the one system — crowd streaming
   * — that creates and destroys actors continuously. That made `stats.actors`
   * meaningless and turned `updateAll` into a loop over every actor ever made.
   */
  forget(actor: CharacterActor): void {
    const i = this.actors.indexOf(actor);
    if (i >= 0) {
      this.actors[i] = this.actors[this.actors.length - 1];
      this.actors.pop();
    }
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
