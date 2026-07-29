/**
 * CHECKS — numeric assertions on a built head.
 *
 * Every defect this file guards against shipped once, and every one of them was
 * invisible to the code review that produced it: the eye seating "looked right"
 * in the source, the nose "was proved by a profile render", the proportions
 * "came from the fit". None of that survived contact with a frontal screenshot.
 * So the invariants are measured off the actual vertex buffers instead of being
 * argued about, and `bun test` fails if any of them regresses.
 *
 * The expensive ones (the eye-exposure rasterisation) run in the test only —
 * they are O(triangles) and have no business in a frame.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { A, sculpt, type Sculpt, type SculptOptions } from './anatomy';
import type { EyeAnchor, HeadAnchors } from './headMesh';

/* ------------------------------------------------------------------ */
/* Depth field                                                         */
/* ------------------------------------------------------------------ */

export interface DepthField {
  /** Frontmost surface z at (x, y), or -Infinity where nothing covers it. */
  at(x: number, y: number): number;
  cell: number;
}

/**
 * Rasterise the front-facing triangles of a mesh into a max-z height field.
 *
 * "Is the eyeball in front of the skin?" is a question about the *surface*, not
 * about vertices: sampling vertices alone leaves holes between them exactly
 * where a lid is thinnest, which is where the answer matters. So the triangles
 * go in properly, scan-converted.
 */
export function depthField(
  geo: THREE.BufferGeometry, box: THREE.Box2, cell = 0.0004,
): DepthField {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const index = geo.getIndex();
  const nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / cell));
  const ny = Math.max(1, Math.ceil((box.max.y - box.min.y) / cell));
  const grid = new Float32Array(nx * ny).fill(-Infinity);

  const tri = (a: number, b: number, c: number): void => {
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    const lo = Math.max(box.min.x, Math.min(ax, bx, cx));
    const hi = Math.min(box.max.x, Math.max(ax, bx, cx));
    const lo2 = Math.max(box.min.y, Math.min(ay, by, cy));
    const hi2 = Math.min(box.max.y, Math.max(ay, by, cy));
    if (hi < lo || hi2 < lo2) return;
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) return;
    const i0 = Math.max(0, Math.floor((lo - box.min.x) / cell));
    const i1 = Math.min(nx - 1, Math.ceil((hi - box.min.x) / cell));
    const j0 = Math.max(0, Math.floor((lo2 - box.min.y) / cell));
    const j1 = Math.min(ny - 1, Math.ceil((hi2 - box.min.y) / cell));
    for (let j = j0; j <= j1; j++) {
      const py = box.min.y + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = box.min.x + (i + 0.5) * cell;
        const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / det;
        const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * az + w1 * bz + w2 * cz;
        const k = j * nx + i;
        if (z > grid[k]) grid[k] = z;
      }
    }
  };

  if (index) {
    for (let i = 0; i < index.count; i += 3) tri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  } else {
    for (let i = 0; i < pos.count; i += 3) tri(i, i + 1, i + 2);
  }

  return {
    cell,
    at(x: number, y: number): number {
      const i = Math.floor((x - box.min.x) / cell);
      const j = Math.floor((y - box.min.y) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return -Infinity;
      return grid[j * nx + i];
    },
  };
}

/* ------------------------------------------------------------------ */
/* Eye seating                                                         */
/* ------------------------------------------------------------------ */

export interface EyeSeating {
  /** Fraction of the globe's frontal disc not covered by lid skin. */
  exposed: number;
  /**
   * Worst distance the globe stands in front of the skin across its upper and
   * lower caps, metres.
   *
   * This — not the exposure inside the aperture, which is the whole point of an
   * eye — is the googly-eye number. Horizontally the lid aperture is genuinely
   * wider than the globe (a 29 mm fissure over a 24 mm ball: the canthi sit
   * beside the eye, not on it), so sclera showing at the globe's left and right
   * extremes is correct. Vertically it is not: the lids close over the top and
   * bottom of the ball, and a ball whose upper and lower caps are visible is a
   * bead glued to a face. So the cap region is where the measurement is taken.
   */
  rimProtrusion: number;
  /** Bounding box of the exposed sclera, metres. */
  apertureW: number;
  apertureH: number;
  /** Globe apex z, and the brow-to-cheek chord z at the same (x, y). */
  apexZ: number;
  browCheekZ: number;
}

/** How far up and down the globe the lids must have closed over it. */
const CAP_FROM = 0.62;

/**
 * Measure how the globe actually sits in the finished head.
 *
 * The globe is sampled on a disc in the view plane; at each sample the sphere's
 * front surface is compared against the rasterised skin. `maxProtrusion` is the
 * number that matters — it is positive exactly when part of the ball is outside
 * the head, which is the googly-eye failure, and it must be at most the small
 * corneal proud-ness a real eye has.
 */
export function measureEyeSeating(headGeo: THREE.BufferGeometry, eye: EyeAnchor): EyeSeating {
  const c = eye.centre;
  const r = eye.radius;
  const pad = r * 1.6;
  const box = new THREE.Box2(
    new THREE.Vector2(c.x - pad, c.y - pad),
    new THREE.Vector2(c.x + pad, c.y + pad),
  );
  const df = depthField(headGeo, box, r / 90);

  const N = 220;
  let inside = 0;
  let exposed = 0;
  let rimProtrusion = -Infinity;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < N; j++) {
    const y = c.y - r + ((j + 0.5) / N) * 2 * r;
    for (let i = 0; i < N; i++) {
      const x = c.x - r + ((i + 0.5) / N) * 2 * r;
      const dx = x - c.x, dy = y - c.y;
      const rr = r * r - dx * dx - dy * dy;
      if (rr <= 0) continue;
      inside++;
      const gz = c.z + Math.sqrt(rr);
      const sz = df.at(x, y);
      const protrusion = gz - sz;
      if (Math.abs(dy) >= CAP_FROM * r && protrusion > rimProtrusion) rimProtrusion = protrusion;
      if (protrusion > 0) {
        exposed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // The brow-to-cheek chord: the line the cornea must not cross.
  const browZ = df.at(c.x, c.y + r * 1.45);
  const cheekZ = df.at(c.x, c.y - r * 1.45);

  return {
    exposed: inside > 0 ? exposed / inside : 0,
    rimProtrusion: isFinite(rimProtrusion) ? rimProtrusion : 0,
    apertureW: exposed > 0 ? maxX - minX : 0,
    apertureH: exposed > 0 ? maxY - minY : 0,
    apexZ: c.z + r,
    browCheekZ: (browZ + cheekZ) * 0.5,
  };
}

/* ------------------------------------------------------------------ */
/* Orientation                                                         */
/* ------------------------------------------------------------------ */

export interface Orientation {
  /** Signed volume of the closed surface, cubic metres. Positive is outward. */
  signedVolume: number;
  /** Fraction of front-of-face vertices whose normal has a positive z. */
  frontNormalsOutward: number;
}

/**
 * Which way the surface faces.
 *
 * The head shipped inside out: the grid's triangles wound clockwise as seen
 * from outside, so `FrontSide` culling discarded the entire face and the
 * renderer drew the interior of the cranium. The result was a smooth egg with
 * apparently unlidded eyeballs, and it survived review because a silhouette —
 * which is what a profile render shows — is identical either way round.
 *
 * The signed volume of a closed triangle mesh, by the divergence theorem, is
 * positive exactly when its normals point outward. That is the whole test, and
 * it costs one pass over the index buffer.
 *
 * `skullVertexCount` bounds the closed part: the ears are welded on after it as
 * open strips and would otherwise contribute garbage to the volume.
 */
export function measureOrientation(geo: THREE.BufferGeometry, skullVertexCount: number): Orientation {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const index = geo.getIndex()!;
  let vol = 0;
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    if (a >= skullVertexCount || b >= skullVertexCount || c >= skullVertexCount) continue;
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }

  let front = 0, outward = 0;
  if (nrm) {
    let maxZ = -Infinity;
    for (let i = 0; i < skullVertexCount; i++) maxZ = Math.max(maxZ, pos.getZ(i));
    for (let i = 0; i < skullVertexCount; i++) {
      if (pos.getZ(i) < maxZ * 0.55) continue;
      front++;
      if (nrm.getZ(i) > 0) outward++;
    }
  }
  return { signedVolume: vol, frontNormalsOutward: front > 0 ? outward / front : 0 };
}

/* ------------------------------------------------------------------ */
/* Proportions                                                         */
/* ------------------------------------------------------------------ */

export interface HeadProportions {
  /** Chin-to-crown, metres. */
  headHeight: number;
  /** Head height as a fraction of body height. */
  headOverBody: number;
  /** Brow-to-chin as a fraction of head height. */
  browOverHead: number;
  /**
   * Cranial vault above the brow ridge, as a fraction of head height.
   *
   * The complement of `browOverHead`, and worth naming separately because it is
   * the number the render is actually judged on. A head can sit at exactly
   * 1/7.5 of body height — this one always did — and still read as oversized,
   * because what the eye measures is how much bare cranium stands above the
   * face. An adult male carries about 90 mm of vault over a 232 mm head: 0.39.
   * The domed ellipsoid this started from carried 0.41 with the mass in the
   * wrong place, tapering to a point instead of turning a corner, which is why
   * `crownFlatness` is measured alongside it.
   */
  vaultOverHead: number;
  /**
   * How flat the top of the skull is: the skull's width at 92% of head height,
   * over its width at the widest point.
   *
   * A dome tapers to nothing at the crown and scores near zero; a real vault
   * has near-vertical parietal walls turning a rounded corner into a broad flat
   * top and scores well over half. This is the half of "the cranium is too
   * domed" that a height ratio cannot see — you can lower a dome and still have
   * a dome.
   */
  crownFlatness: number;
  /** Eye line's height above the chin, as a fraction of head height. */
  eyeLineFrac: number;
  /** Skull width and depth, metres (ears excluded from the width). */
  width: number;
  depth: number;
}

/**
 * The canonical proportions, measured off the anchors rather than assumed.
 *
 * All three of these were out on the head that shipped, and together they are
 * what "bobblehead" actually means numerically: a head 8% too tall for the
 * body, sitting on a cranium with no temporal flattening, with the eye line
 * above centre so the face reads as crammed into the lower third.
 */
export function measureProportions(
  geo: THREE.BufferGeometry, anchors: HeadAnchors, bodyHeight: number,
): HeadProportions {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  // Ears are welded into the same buffer after the skull grid and stand proud
  // of it by design, so measuring width over the whole buffer measures ears.
  const skullEnd = Math.min(pos.count, anchors.skullVertexCount);
  let maxY = -Infinity;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < skullEnd; i++) {
    const y = pos.getY(i);
    if (y > maxY) maxY = y;
    const z = pos.getZ(i);
    // The widest part of a head is at eye level; take the whole ring there.
    if (Math.abs(y - anchors.eyeL.centre.y) < 0.008) {
      const x = pos.getX(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const chin = anchors.chinY;
  const headHeight = maxY - chin;

  // Widest span across the vault, and the span near the crown. A second pass is
  // needed because both bands are defined relative to `headHeight`, which is
  // only known once the first pass has found `maxY`.
  let vaultHalf = 0;
  let crownHalf = 0;
  const crownBand = chin + headHeight * 0.92;
  for (let i = 0; i < skullEnd; i++) {
    const y = pos.getY(i);
    if (y < chin + headHeight * 0.55) continue;
    const ax = Math.abs(pos.getX(i));
    if (ax > vaultHalf) vaultHalf = ax;
    if (Math.abs(y - crownBand) < headHeight * 0.012 && ax > crownHalf) crownHalf = ax;
  }

  const brow = anchors.browL.reduce((a, p) => Math.max(a, p.y), -Infinity);
  return {
    headHeight,
    headOverBody: headHeight / bodyHeight,
    browOverHead: (brow - chin) / headHeight,
    vaultOverHead: (maxY - brow) / headHeight,
    crownFlatness: vaultHalf > 1e-6 ? crownHalf / vaultHalf : 0,
    eyeLineFrac: (anchors.eyeL.centre.y - chin) / headHeight,
    width: maxX - minX,
    depth: maxZ - minZ,
  };
}

/* ------------------------------------------------------------------ */
/* The midline                                                         */
/* ------------------------------------------------------------------ */

export interface MidlineSeam {
  /**
   * The worst jump in the sculpt's own lateral slope across x = 0, dimensionless.
   *
   * Measured on the analytic field rather than on the mesh, and that is the
   * point: the mesh is piecewise linear at 1.45 mm, so it cannot represent a
   * corner at all and the crease was never visible in its silhouette or in a
   * rasterised depth field. It lived in the FIELD, and it reached the screen only
   * because `computeCurvature` differentiates that field twice and the second
   * derivative of a corner is a delta function. Measuring the mesh therefore
   * misses the bug completely — which is exactly how it shipped three times.
   *
   * For any twice-differentiable sculpt this tends to zero with the sample step.
   * For a `|x|` term of slope s it sits at 2s no matter how finely it is
   * sampled — the definition of a C1 discontinuity.
   */
  sculptKink: number;
  /** The fitted-space y at which the worst kink was found. */
  worstY: number;
  /**
   * Peak |curvature| within 4 mm of the midline, over the median |curvature| of
   * the same horizontal band 8-45 mm out.
   *
   * This is the attribute that actually drew the stripe: it is the pre-integrated
   * scattering LUT's second axis, so an outlier here is a hard texture-row
   * boundary on screen. On a smooth face the midline is an ordinary part of the
   * surface and scores near 1.
   */
  curvatureRatio: number;
  /** Worst cavity deficit at the midline against its own horizontal band. */
  cavityDrop: number;
}

/**
 * Look for a seam down the middle of the face.
 *
 * Three midline seams have shipped in this codebase, each one a term written
 * against `|x|` and re-signed without being made smooth through zero, and each
 * one invisible to every other measurement here. See the long note at the top of
 * `anatomy.ts` for the mechanism. This is the check that would have caught all
 * three: it says nothing about what the face looks like, only that the midline
 * is an ordinary piece of surface rather than a welded join.
 */
export function measureMidlineSeam(
  geo: THREE.BufferGeometry, anchors: HeadAnchors, opts: SculptOptions,
): MidlineSeam {
  const f = anchors.frame;
  const fy = (v: number): number => v * f.scale + f.oy;
  // Brow down to just under the nose base: the span where a seam is on show.
  const yTop = fy(A.browY + 0.05);
  const yBot = fy(A.subnasaleY - 0.06);

  /* ---- the field: is it differentiable across the midline? ----
   *
   * `E` is a hundredth of the finest column spacing, so a term that is merely
   * steep near the midline contributes E * f'' and vanishes, while a term with a
   * corner contributes its full slope jump and does not. */
  const E = 0.00008;
  const out: Sculpt = { dx: 0, dy: 0, dz: 0 };
  const at = (x: number, y: number, comp: 'dx' | 'dz'): number => {
    // z on the front of the face at this height, so the sculpt is evaluated
    // where the surface actually is rather than at an arbitrary depth.
    sculpt(x, y, 0.16, 1, opts, out);
    return out[comp];
  };
  let sculptKink = 0;
  let worstY = 0;
  for (let y = A.subnasaleY - 0.06; y <= A.browY + 0.10; y += 0.004) {
    for (const comp of ['dx', 'dz'] as const) {
      const l = (at(0, y, comp) - at(-E, y, comp)) / E;
      const r = (at(E, y, comp) - at(0, y, comp)) / E;
      const kink = Math.abs(r - l);
      if (kink > sculptKink) { sculptKink = kink; worstY = y; }
    }
  }

  /* ---- the attributes the shader reads ---- */
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const skin = geo.getAttribute('aSkin') as THREE.BufferAttribute;
  const end = Math.min(pos.count, anchors.skullVertexCount);

  let curvatureRatio = 0;
  let cavityDrop = 0;
  const BAND = 0.006;
  for (let y = yBot; y <= yTop; y += BAND) {
    const mid: number[] = [];
    const midCav: number[] = [];
    const flank: number[] = [];
    const flankCav: number[] = [];
    for (let i = 0; i < end; i++) {
      if (nrm.getZ(i) < 0.35) continue;
      if (Math.abs(pos.getY(i) - y) > BAND * 0.5) continue;
      const ax = Math.abs(pos.getX(i) - f.ox);
      if (ax < 0.004) { mid.push(Math.abs(skin.getX(i))); midCav.push(skin.getZ(i)); }
      else if (ax < 0.045) { flank.push(Math.abs(skin.getX(i))); flankCav.push(skin.getZ(i)); }
    }
    if (mid.length === 0 || flank.length < 4) continue;
    // A floor on the denominator: on a genuinely flat band the ratio is not a
    // meaningful number and must not be allowed to blow up.
    const ref = Math.max(median(flank), 12);
    curvatureRatio = Math.max(curvatureRatio, Math.max(...mid) / ref);
    cavityDrop = Math.max(cavityDrop, median(flankCav) - Math.min(...midCav));
  }

  return { sculptKink, worstY, curvatureRatio, cavityDrop };
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[s.length >> 1];
}

/* ------------------------------------------------------------------ */
/* The nose                                                            */
/* ------------------------------------------------------------------ */

export interface NoseMetrics {
  /** Nasion-to-subnasale, along the dorsum, metres. */
  dorsalLength: number;
  /** Tip projection above the cheek plane, metres. */
  tipProjection: number;
  /** Full width across the wings at the alar base, metres. */
  alarWidth: number;
  /** Width across the dorsum at the rhinion (the bony/cartilage join). */
  bridgeWidth: number;
  /**
   * Alar footprint over nasal length.
   *
   * Deliberately NOT called the nasal index: the classical index is alare to
   * alare over nasion to subnasale, and `alarWidth` here is the 40%-relief
   * footprint, which sits inboard of the alare and therefore reads narrower. The
   * reference photo measures 0.52 for the true ratio; this metric runs about
   * three quarters of that on the same shape, so the useful band is 0.36-0.50.
   */
  alarOverLength: number;
  /**
   * The fraction of the nose's anatomical length over which it actually stands
   * proud of the face.
   *
   * This is what "the nose is too short" means when the landmarks say it is not:
   * nasion-to-subnasale is fixed by the fit and was never wrong, but if the
   * relief only appears in the bottom third then two thirds of the nose is a
   * flat ramp and it reads short. The reference's dorsum starts between the
   * brows.
   */
  lengthRatio: number;
  /** Bridge width over alar width. A narrow bridge over wide wings is low. */
  bridgeOverAlar: number;
  /** Goode's ratio: tip projection over nasal length. Normal is 0.55-0.60. */
  projectionRatio: number;
  /**
   * Peak deviation of the dorsal profile from the nasion-to-tip chord, as a
   * fraction of nasal length. Positive is a convex hump, negative a scooped
   * saddle. A straight nose is near zero and must not be allowed to go concave.
   */
  dorsalCamber: number;
}

/**
 * Measure the nose as anthropometric ratios rather than as absolute sizes.
 *
 * Ratios, because the head is scaled to the body and every absolute figure moves
 * with it. These are the four numbers that separate the reference's long,
 * narrow, straight, well-projected nose from the short broad ramp the landmark
 * cloud produces on its own, and they are measured off the rendered surface —
 * the previous pass's nose was correct in the landmark cloud and wrong on screen
 * because the cloud has no relief.
 */
export function measureNose(geo: THREE.BufferGeometry, anchors: HeadAnchors): NoseMetrics {
  const f = anchors.frame;
  const fy = (v: number): number => v * f.scale + f.oy;
  const yNasion = fy(A.eyeY + 0.030);
  const ySub = fy(A.subnasaleY);
  const yAla = fy(A.alaY);
  const yRhinion = yNasion + (ySub - yNasion) * 0.45;

  const box = new THREE.Box2(
    new THREE.Vector2(f.ox - 0.060, ySub - 0.020),
    new THREE.Vector2(f.ox + 0.060, yNasion + 0.020),
  );
  const df = depthField(geo, box, 0.0004);
  const zAt = (x: number, y: number): number => df.at(f.ox + x, y);

  /* THE SURFACE THE NOSE STANDS ON.
   *
   * A nose is not a bump on a plane, which is why the obvious references all
   * fail: sample the cheek at 45 mm and you measure the head's depth (the nose
   * "projects" 51 mm); sample it at 20 mm and you measure the midface's own
   * convexity (41 mm); pin it to the alar crease and you first have to find the
   * alar crease, which is the thing being measured.
   *
   * So the reference is the face's own low-frequency shape: a wide horizontal
   * blur of the depth field, and the nose is what stands proud of it. That is
   * the unsharp-mask definition of a feature — no landmarks, no fitted plane,
   * and it answers the question a front view actually asks, which is how far the
   * nose stands out of the face around it and how wide it reads doing so.
   *
   * SIGMA is 18 mm: wide enough to pass the midface's convexity through into the
   * reference and narrow enough that the nose itself barely contributes. */
  const SIGMA = 0.018;
  const lowFreq = (y: number): ((x: number) => number) => {
    const xs: number[] = [];
    const zs: number[] = [];
    for (let x = -0.058; x <= 0.058; x += 0.001) {
      const z = zAt(x, y);
      if (isFinite(z)) { xs.push(x); zs.push(z); }
    }
    return (x: number): number => {
      let s = 0, w = 0;
      for (let i = 0; i < xs.length; i++) {
        const d = (xs[i] - x) / SIGMA;
        const g = Math.exp(-0.5 * d * d);
        s += zs[i] * g; w += g;
      }
      return w > 0 ? s / w : NaN;
    };
  };
  /** How far the surface stands proud of the face's low-frequency shape. */
  const relief = (y: number): ((x: number) => number) => {
    const lf = lowFreq(y);
    return (x: number): number => zAt(x, y) - lf(x);
  };

  /* Tip projection: the peak relief anywhere in the lower third of the nose. */
  let tipProjection = 0;
  let yTip = fy(A.noseTipY);
  {
    const lo = ySub - 0.002;
    const hi = ySub + (yNasion - ySub) * 0.40;
    for (let y = lo; y <= hi; y += 0.0008) {
      const v = relief(y)(0);
      if (isFinite(v) && v > tipProjection) { tipProjection = v; yTip = y; }
    }
  }

  /** Full width where the relief has fallen to 40% of its midline peak. */
  const widthAt = (y: number): number => {
    const h = relief(y);
    const peak = h(0);
    if (!isFinite(peak) || peak <= 1e-4) return 0;
    const edge = (dir: 1 | -1): number => {
      let last = 0;
      for (let d = 0.0005; d < 0.050; d += 0.0005) {
        const v = h(dir * d);
        if (!isFinite(v)) break;
        if (v < peak * 0.40) return d;
        last = d;
      }
      return last;
    };
    return edge(1) + edge(-1);
  };

  const alarWidth = widthAt(yAla);
  const bridgeWidth = widthAt(yRhinion);

  /* How much of the nose's length carries relief at all. */
  let reliefLength = 0;
  {
    let lo = Infinity, hi = -Infinity;
    for (let y = ySub; y <= yNasion + 0.006; y += 0.0008) {
      const v = relief(y)(0);
      if (isFinite(v) && v >= tipProjection * 0.40) {
        if (y < lo) lo = y;
        if (y > hi) hi = y;
      }
    }
    if (isFinite(lo) && hi > lo) reliefLength = hi - lo;
  }

  /* Nasal height: nasion to subnasale, both taken from the fit's own anchors so
   * the number cannot drift with the sculpt. */
  const dorsalLength = yNasion - ySub;

  /* Straightness, measured on the midline profile itself rather than on the
   * height above a plane: "straight dorsum" is a statement about the side view,
   * and needs no reference surface to be well posed. Positive is a convex hump,
   * negative a scooped saddle.
   *
   * The chord runs RHINION to tip, not nasion to tip. Every nose has a radix
   * depression at the nasion — that is what the root of a nose is — so a chord
   * anchored there reports 6 mm of "scoop" on a dead-straight dorsum and the
   * metric measures the wrong thing at exactly the point it is trusted most.
   * The rhinion-to-tip segment is the one that carries a hump or a saddle. */
  let dorsalCamber = 0;
  const zTop = zAt(0, yRhinion);
  const zTip = zAt(0, yTip);
  if (isFinite(zTop) && isFinite(zTip) && yRhinion > yTip + 1e-4) {
    for (let y = yTip; y <= yRhinion; y += 0.0004) {
      const v = zAt(0, y);
      if (!isFinite(v)) continue;
      const t = (y - yTip) / (yRhinion - yTip);
      const chord = zTip + (zTop - zTip) * t;
      const d = v - chord;
      if (Math.abs(d) > Math.abs(dorsalCamber)) dorsalCamber = d;
    }
  }

  return {
    dorsalLength,
    tipProjection,
    alarWidth,
    bridgeWidth,
    alarOverLength: dorsalLength > 0 ? alarWidth / dorsalLength : 0,
    lengthRatio: dorsalLength > 0 ? reliefLength / dorsalLength : 0,
    bridgeOverAlar: alarWidth > 0 ? bridgeWidth / alarWidth : 0,
    projectionRatio: dorsalLength > 0 ? tipProjection / dorsalLength : 0,
    dorsalCamber: dorsalLength > 0 ? dorsalCamber / dorsalLength : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Hair clearance                                                      */
/* ------------------------------------------------------------------ */

export interface HairClearance {
  /** Number of hair vertices that lie on the face below the hairline. */
  onFace: number;
  /** Total vertices considered. */
  total: number;
  /** The lowest such vertex, metres above the chin, or null. */
  worstY: number | null;
}

/**
 * Hair on the face.
 *
 * A vertex counts as "on the face" when it is in the frontal quadrant, inside
 * the face's own width, and below the brow ridge — that is, in the zone where
 * a strand renders as a scratch across skin. A fringe is allowed to reach the
 * upper forehead; nothing may cross the brow.
 */
export function measureHairClearance(
  geos: Array<THREE.BufferGeometry | null>, anchors: HeadAnchors,
): HairClearance {
  const browY = anchors.browL.concat(anchors.browR).reduce((a, p) => Math.max(a, p.y), -Infinity);
  const half = anchors.templeHalf;
  let onFace = 0;
  let total = 0;
  let worstY: number | null = null;
  for (const g of geos) {
    if (!g) continue;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      total++;
      // Frontal, within the face's width, and below the brow line.
      if (z < anchors.frame.oz + half * 0.25) continue;
      if (Math.abs(x) > half * 0.86) continue;
      if (y > browY) continue;
      onFace++;
      if (worstY === null || y < worstY) worstY = y;
    }
  }
  return { onFace, total, worstY };
}
