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
  const brow = anchors.browL.reduce((a, p) => Math.max(a, p.y), -Infinity);
  return {
    headHeight,
    headOverBody: headHeight / bodyHeight,
    browOverHead: (brow - chin) / headHeight,
    eyeLineFrac: (anchors.eyeL.centre.y - chin) / headHeight,
    width: maxX - minX,
    depth: maxZ - minZ,
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
