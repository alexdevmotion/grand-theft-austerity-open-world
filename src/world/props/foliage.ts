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
const leafOpt = (color: PropOpts['color'], gain = 0.12, trans = 0.85, wind = 0): PropOpts =>
  ({
    color,
    // Keep the stylised amber response, but do not let the low-poly lobes pick
    // up a hard environment glint on every facet. Leaf roughness is deliberately
    // a little higher than the shared foliage preset used by small shrubs.
    mr: [MR.leaf[0], 0.76],
    emissive: [color.r * gain, color.g * gain, color.b * gain], trans, wind,
  });

/**
 * Radians of normal scatter applied to every leaf cluster. About 18 degrees is
 * enough to break uniform shading without turning each low-poly lobe into a
 * fan of unrelated folded cards.
 */
const LEAF_NORMAL_JITTER = 0.32;

/** Neighbouring clusters share one seasonal family instead of rainbow noise. */
const TREE_PALETTES = [
  { tones: [C.leafAmber, C.leafGold, C.leafPale], weights: [6, 3, 0.7] },
  { tones: [C.leafRust, C.leafAmber, C.leafGold], weights: [5, 2.2, 0.8] },
  { tones: [C.leafOlive, C.leafAmber, C.leafGold], weights: [6, 2.0, 0.5] },
] as const;

/* ------------------------------------------------------------------ */
/* Trees                                                               */
/* ------------------------------------------------------------------ */

/**
 * Autumn street tree. `thin` 0..1 controls how much of the crown has already
 * dropped: at 1 you get bare branches with a few clinging clusters.
 * Roughly 1.5-2.3k triangles at full detail (branches, shell and fringe),
 * merged into the owning tile's single prop draw.
 */
export function autumnTree(
  b: PropBuilder, x: number, z: number, rng: Rng,
  scale = 1, thin = rng.range(0.14, 0.34),
  /** 2 = full detail, 1 = mid, 0 = distant silhouette. Halves the cluster count. */
  lod: 0 | 1 | 2 = 2,
): void {
  const palette = rng.weighted(TREE_PALETTES, [5, 2.2, 1.8]);
  /*
   * SCALE. A mature Bucharest street plane tree is 8-11 m to the crown top on a
   * 2.2-3.2 m clear trunk, with a crown 4-6 m ACROSS — not the 6 m radius the
   * previous authoring produced. Cross-checks that matter, because both are in
   * frame constantly: a 1.8 m person reaches a third of the way up the trunk,
   * and the 7.2-9.4 m lamp heads sit level with the top of the crown.
   */
  const h = rng.range(8.0, 10.8) * scale;
  const trunkH = rng.range(2.6, 3.4) * scale;
  const trunkR = 0.16 * scale;
  /*
   * BARK, AUTHORED DARK. A trunk carries no translucency, so with the key three
   * degrees above the horizon it is the least forgiving surface on the tree:
   * at 0x5b4a3c with a 12% emissive floor on top, every plaza tree in the game
   * stood on a stick brighter than the pavement behind it, and a bright
   * vertical stroke under a thin crown is half of why the far field read as
   * coloured chips floating in the air.
   */
  const bark: PropOpts = {
    color: C.bark,
    mr: [0, 0.96],
    emissive: [C.bark.r * 0.03, C.bark.g * 0.03, C.bark.b * 0.03],
  };

  // Trunk in two segments with a lean between them, plus the root flare that
  // plants it on the pavement. A dead-vertical stick is the loudest possible
  // procedural tell on an object this familiar; the second segment costs 12
  // triangles.
  const leanA = rng.range(0, Math.PI * 2);
  const leanR = rng.range(0.04, 0.15) * trunkH;
  const cx = x + Math.cos(leanA) * leanR;
  const cz = z + Math.sin(leanA) * leanR;
  const trunkHeight = trunkH + 0.06;
  b.addCollisionCapsule(
    'tree',
    (x + cx) / 2, WALK_Y - 0.06 + trunkHeight / 2, (z + cz) / 2,
    trunkHeight, Math.max(trunkR * 2.1, trunkR + leanR / 2),
  );
  b.cyl(x, WALK_Y - 0.06, z, trunkR * 2.1, trunkR * 1.4, 0.26, 6, bark, false);
  b.cyl(x, WALK_Y - 0.05, z, trunkR * 1.4, trunkR * 1.05, trunkH * 0.5, 6, bark, false);
  b.tube(x, WALK_Y + trunkH * 0.5, z, cx, WALK_Y + trunkH, cz, trunkR * 0.98, 6, bark);

  const crownY = WALK_Y + trunkH;
  // Crown 3.6-4.8 m ACROSS, not 6 m in radius. A Bucharest street plane is
  // pollarded back off the trolleybus wires and simply does not carry the
  // crown this used to author — and the extra width is what put the leaf
  // clusters too far apart to ever merge into a canopy.
  const crownR = rng.range(1.8, 2.4) * scale;
  const crownH = h - trunkH;

  /*
   * REAL BRANCHING. The reference's trees are half bare: you see through them
   * to the sky, and the structure inside the crown is as visible as the leaves
   * on it. Three orders — limbs off the trunk, secondaries off those, twigs
   * off the secondaries — is the minimum that reads as a tree rather than as a
   * lollipop, and the twigs are what keep the silhouette from closing up.
   */
  const tips: number[] = [];                                  // flat x, y, z
  const nLimb = 3 + rng.int(0, 3);
  const lean = rng.range(0, Math.PI * 2);
  const limbOpt: PropOpts = { ...bark, wind: 0.006 * scale };
  const secOpt: PropOpts = { ...bark, wind: 0.018 * scale };
  /*
   * TWIGS ARE THE "WHITE HAIRS". Authored at trunkR * 0.12 a twig was a 19 mm
   * rod: under two pixels wide at twenty metres, so it never resolved as a
   * shaded cylinder and aliased into a hard bright line poking out of the
   * crown. Authored instead as what you actually see at street distance — a
   * BUNCH of twigs, ~5 cm, resolvable — and given a little translucency so it
   * glows the same warm amber as the leaves in the same light rather than
   * reading as a different material stuck on the outside.
   */
  const twigOpt: PropOpts = { ...bark, wind: 0.038 * scale, trans: 0.3 };
  for (let i = 0; i < nLimb; i++) {
    const a = lean + (i / nLimb) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const reach = crownR * rng.range(0.42, 0.66);
    const rise = crownH * rng.range(0.30, 0.52);
    const lx = cx + Math.cos(a) * reach;
    const lz = cz + Math.sin(a) * reach;
    const ly = crownY + rise;
    // Elbowed, not a straight rod: a limb leaves the fork steeply then flattens.
    const ex = cx + Math.cos(a) * reach * 0.42;
    const ez = cz + Math.sin(a) * reach * 0.42;
    const ey = crownY + rise * rng.range(0.62, 0.78);
    b.tube(cx, crownY - 0.25, cz, ex, ey, ez, trunkR * 0.56, 4, limbOpt);
    b.tube(ex, ey, ez, lx, ly, lz, trunkR * 0.4, 4, limbOpt);

    const nSec = 2 + rng.int(0, 2);
    for (let j = 0; j < nSec; j++) {
      const a2 = a + rng.range(-0.85, 0.85);
      const sx = lx + Math.cos(a2) * crownR * rng.range(0.26, 0.5);
      const sz = lz + Math.sin(a2) * crownR * rng.range(0.26, 0.5);
      const sy = ly + crownH * rng.range(0.14, 0.34);
      b.tube(lx, ly, lz, sx, sy, sz, trunkR * 0.32, 3, secOpt);
      // Bare twigs beyond the last leaf cluster: this is the fringe that stops
      // a crown reading as a hard-edged solid against a bright sky.
      if (lod >= 1 && rng.bool(0.7)) {
        const a3 = a2 + rng.range(-1.1, 1.1);
        const tx = sx + Math.cos(a3) * crownR * rng.range(0.2, 0.38);
        const tz = sz + Math.sin(a3) * crownR * rng.range(0.2, 0.38);
        const ty = sy + crownH * rng.range(0.08, 0.26);
        b.tube(sx, sy, sz, tx, ty, tz, trunkR * 0.20, 3, twigOpt);
        tips.push(tx, ty, tz);
      }
    }
  }
  // The leader.
  b.tube(cx, crownY - 0.25, cz,
    cx + rng.range(-0.25, 0.25), crownY + crownH * 0.72, cz + rng.range(-0.25, 0.25),
    trunkR * 0.42, 4, limbOpt);

  /*
   * THE CANOPY — a CLOSED SHELL OF SMALL LOBES, not four fat balloons per
   * branch tip.
   *
   * Hanging clusters on branch tips is the obvious construction and it is what
   * this function used to do. Tips are further apart than clusters are wide, so
   * the crown never closed: what reached the screen was a bare stick with a
   * handful of large opaque balloons stuck near the top — which is, word for
   * word, how a playtest described it. A crown is a MASS, and the size of the
   * pieces it is made of is not a free parameter. See the derivation on
   * `LOBE_COVER` in city/facades.ts; this mirrors it:
   *
   *     r = sqrt(COVER * crownR * crownHalfH / N)
   *
   * closes the side silhouette for any N, so the LOD tiers pick GRANULARITY and
   * never coverage — few big lobes far away, many small ones near, the same
   * solid mass either way, and no tier at which the crown comes apart.
   */
  // Near trees need a finer grain than the old 0.7 m-radius shell: at camera
  // distance that size resolves as a row of rocks. The cover is kept just
  // below one closed hull so the armature and late-autumn gaps survive instead
  // of becoming an opaque ball. Mid/far tiers retain almost the old count.
  const COVER = 3.2;
  const rWanted = lod === 2 ? 0.56 : lod === 1 ? 0.82 : 1.30;
  const crownHalfH = crownH * 0.34;
  const crownMidY = crownY + crownH * 0.46;
  const silh = crownR * crownHalfH;
  const nSurf = Math.max(6, Math.min(100, Math.round((COVER * silh) / (rWanted * rWanted))));
  const lobeR = Math.sqrt((COVER * silh) / nSurf);
  // Two scales — see the long note in city/facades.ts. These structural lobes
  // are the crown's MASS at 20-24 triangles each; the tuft pass at the bottom
  // skins their outside in 0.3 m single-ring lobes, and those are what the eye
  // resolves from the distance a third-person camera actually lives at.
  const rings = lod === 0 ? 1 : 2;
  const lobeSeg = lod === 0 || lod === 2 ? 6 : 5;
  const GOLD = Math.PI * (3 - Math.sqrt(5));
  const seedBase = (Math.round(cx * 13.7 + cz * 7.3) >>> 0) || 1;

  for (let i = 0; i < nSurf; i++) {
    const t = (i + 0.5) / nSurf;
    const cy = 1 - 2 * t;
    /*
     * Late autumn strips a crown from the INSIDE and the BOTTOM outwards — the
     * outer tips hold their leaves longest. Dropping clusters uniformly punches
     * holes straight through the silhouette, and a silhouette full of holes is
     * a handful of detached pieces rather than a thinning tree.
     */
    if (rng.next() < thin * (1.0 - cy)) continue;
    const sr = Math.sqrt(Math.max(0, 1 - cy * cy));
    /*
     * The spiral needs BREAKING, not just following. A golden-angle sequence
     * spreads points evenly, which on a tall narrow crown (a poplar) lays them
     * down as a visible helix — you can count the turns winding up the tree.
     * Nearly a radian of angular jitter plus a radial wobble costs nothing and
     * keeps the even spread while destroying the pattern.
     */
    const ang = i * GOLD + rng.range(-0.9, 0.9);
    const wob = rng.range(0.88, 1.12);
    const shell = rng.range(0.86, 1.06);
    const leafC = rng.weighted(palette.tones, palette.weights);
    // Lobes on the underside are shaded by the whole crown above them; the
    // shader cannot know that, so it is authored off height in the shell.
    const depth = 0.60 + 0.40 * (0.5 + 0.5 * cy);
    // Clusters HANG. Pulling every lobe down a fraction of its own radius is
    // most of the difference between a canopy and a ball of moss.
    const ly = crownMidY + cy * crownHalfH * shell - lobeR * 0.22;
    const r = lobeR * rng.range(0.8, 1.18);
    b.blob(
      cx + Math.cos(ang) * sr * crownR * shell * wob,
      ly,
      cz + Math.sin(ang) * sr * crownR * shell * wob,
      r, r * rng.range(0.7, 0.92), r * rng.range(0.86, 1.14),
      leafOpt(
        leafC.clone().multiplyScalar(depth), 0.1, rng.range(0.72, 1.0),
        0.035 + 0.11 * Math.max(0, (ly - crownY) / Math.max(crownH, 0.5)),
      ),
      // 0.32, not 0.5: on a five/six-segment two-ring lobe a vertex pulled to
      // 0.75r leaves its neighbours' quad nearly planar, and the structural
      // lobes flatten into hard cards. Raggedness is the tuft pass's job.
      0.32, 1 + ((i * 7919 + seedBase * 104729) >>> 0), rings, LEAF_NORMAL_JITTER * 0.55, lobeSeg,
    );
  }

  // Backing lobes: whatever shows through a thinned crown has to be more canopy
  // in shadow — never sky, and never the trunk.
  if (lod >= 1) {
    const nBacking = lod === 2 ? 4 : 5;
    for (let i = 0; i < nBacking; i++) {
      const cy = rng.range(-0.5, 0.7);
      const sr = Math.sqrt(Math.max(0, 1 - cy * cy));
      const ang = i * GOLD * 2.3 + rng.range(-0.28, 0.28);
      const shell = rng.range(0.28, 0.62);
      const r = lobeR * rng.range(0.72, 1.12);
      b.blob(
        cx + Math.cos(ang) * sr * crownR * shell,
        crownMidY + cy * crownHalfH * shell,
        cz + Math.sin(ang) * sr * crownR * shell,
        r, r * 0.72, r,
        leafOpt(palette.tones[0].clone().multiplyScalar(0.5), 0.08, 0.35, 0.03),
        0.45, 1 + ((i * 15486 + seedBase * 39769) >>> 0), 1, LEAF_NORMAL_JITTER * 0.4, 5,
      );
    }
  }

  /*
   * THE FRINGE, hung on the twig tips. Two jobs at once: it breaks the outline
   * at a finer scale than the main lobes can, and it buries the bare end of
   * every twig inside a cluster of leaves — which is where a real twig ends,
   * and which is what stops them reading as hairs sticking out of the crown.
   */
  const nTip = tips.length / 3;
  const nTuft = nTip + Math.round(nSurf * (lod === 2 ? 1.7 : lod === 1 ? 1.0 : 0));
  for (let i = 0; i < nTuft; i++) {
    const fr = lobeR * rng.range(0.28, 0.46);
    let fx: number;
    let fy: number;
    let fz: number;
    if (i < nTip) {
      fx = tips[i * 3] + rng.range(-0.12, 0.12);
      fy = tips[i * 3 + 1] - fr * 0.35;
      fz = tips[i * 3 + 2] + rng.range(-0.12, 0.12);
    } else {
      const a = rng.range(0, Math.PI * 2);
      const cy = rng.range(-0.7, 0.95);
      // Let the inner/bottom leaf fall expose the branch orders. Tips keep
      // their clusters, matching the way a real late-autumn crown thins.
      if (rng.next() < thin * (0.45 + 0.55 * (1 - cy)) * 0.65) continue;
      const sr = Math.sqrt(Math.max(0, 1 - cy * cy));
      // Radial and vertical overshoot together, never independently, or a
      // tuft near the poles floats clear of the crown it belongs to.
      const sh = rng.range(1.0, 1.13);
      fx = cx + Math.cos(a) * sr * crownR * sh;
      fz = cz + Math.sin(a) * sr * crownR * sh;
      fy = crownMidY + cy * crownHalfH * sh - fr * 0.3;
    }
    b.blob(
      fx, fy, fz, fr, fr * rng.range(0.6, 0.86), fr,
      leafOpt(rng.weighted(palette.tones, palette.weights),
        0.1, rng.range(0.9, 1.0), 0.15),
      0.6, 1 + ((i * 22691 + seedBase * 6353) >>> 0), 1, LEAF_NORMAL_JITTER * 0.55, 5,
    );
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
  const dirLength = Math.hypot(dirX, dirZ);
  if (dirLength > 1e-5) {
    b.addCollisionBox(
      'hedge',
      x + dirX * length / 2, WALK_Y + height / 2, z + dirZ * length / 2,
      length * dirLength, height, 1.1, Math.atan2(-dirZ, dirX),
    );
  } else {
    // Match the visual fallback below, which becomes a centred Z-aligned run.
    b.addCollisionBox('hedge', x, WALK_Y + height / 2, z, 1.1, height, length, 0);
  }
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
  b.addCollisionBox('planter', x, WALK_Y + h / 2, z, w, h, w, yaw);
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
