/**
 * HEAD MESH — one shared topology, deformed toward each subject.
 *
 * The base is an analytic skull ellipsoid sampled on a graded (azimuth,
 * elevation) grid. The grading is not cosmetic: rows land exactly on the brow,
 * the lid crease, the lash line, the nose base and both vermilion borders, and
 * columns land on the inner and outer canthus and the mouth corners, so the
 * mesh carries real edge loops around the eyes and the mouth and its density
 * follows curvature instead of being uniform.
 *
 * That base is then pushed onto a subject by the displacement field in
 * `deform.ts`, built from the de-rotated landmark cloud. Every cast member goes
 * through the identical grid, so vertex i is the same anatomical point on all
 * of them — one rig, one shader, one set of eye/brow/lash attachments.
 *
 * Everything a face needs beyond position is baked per vertex rather than into
 * a texture atlas: curvature (the second axis of the pre-integrated scattering
 * LUT), thickness (back-lit transmission through ears, nostrils and lips),
 * cavity (nasolabial folds, eye corners, under the brow) and roughness (a real
 * oily T-zone against matte cheeks). The landmarks say where every feature is,
 * so none of it needs a UV layout and none of it can drift out of register.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { Rng, valueNoise2D } from '../../core/rng';
import { SKULL_AXIS, sculpt, type Sculpt, type SculptOptions } from './anatomy';
import { buildField, distToPolyline, nearestDist } from './deform';
import { MEAN_CLOUD, type Cloud } from './fitData';
import {
  BROW_L_BOTTOM, BROW_L_TOP, BROW_R_BOTTOM, BROW_R_TOP, EYE_L_RING, EYE_R_RING,
  FACE_OVAL, IRIS_L, IRIS_R, L, LIPS_INNER, LIPS_OUTER, NASOLABIAL_L,
  NASOLABIAL_R, NOSE_BRIDGE,
} from './landmarks';

/* ------------------------------------------------------------------ */
/* The analytic skull                                                  */
/* ------------------------------------------------------------------ */

/**
 * Base ellipsoid, in fitted-face units, chosen to pass through the mean cloud's
 * forehead, cheeks and temples so the landmark displacement only has to carve
 * features (nose, lips, sockets) rather than rebuild the skull.
 */
const SKULL = {
  cx: SKULL_AXIS.x, cy: -0.055, cz: SKULL_AXIS.z,
  // Breadth and depth were 0.424 and 0.470/0.545. Raising `HEAD_SCALE_TRIM` to
  // absorb the vault cut scales both up with it, so they were brought down to
  // hold the finished head at an adult male's 152 mm across and 196 deep —
  // `measureProportions` bounds both. Depth needed a second trim after the
  // nasal projection in `anatomy.ts` pushed the front of the head forward.
  rx: 0.392, ry: 0.672,
  rzF: 0.424, rzB: 0.482,
};

/** Mean chin and crown in fitted units — the span the head is scaled by. */
const FIT_CHIN_Y = -0.683;
const FIT_CROWN_Y = SKULL.cy + SKULL.ry;
const FIT_SPAN = FIT_CROWN_Y - FIT_CHIN_Y;

/** Midline x of the mean cloud; subtracted so the head is centred but not mirrored. */
const FIT_MIDLINE_X = -0.005;

/**
 * Head size, as a fraction of the chin-to-crown span the rig hands us.
 *
 * CANONICAL PROPORTION: an adult male head is 1/7.5 of standing height. The rig
 * puts the chin at `headY - 0.010` and the crown at full height, which spans
 * 1/6.96 — a head 8% too tall for the body before anything else happens, and on
 * a narrow pair of shoulders that reads as a bobblehead immediately. This trim
 * lands it on 1/7.5 exactly; `measureProportions` in `checks.ts` fails the
 * build if it drifts.
 *
 * It was raised from 0.928 when `anatomy.ts` cut 0.105 fitted units off the
 * cranial vault. The two changes together are deliberately height-neutral: the
 * head still measures 1/7.5, but the height that used to be bare domed cranium
 * above the brow is now face. That reallocation — not a smaller head — is what
 * stops it reading oversized, and it is why the trim and the vault cut have to
 * move as a pair.
 */
const HEAD_SCALE_TRIM = 0.978;

/** Target head height as a fraction of body height, and the tolerance on it. */
export const HEAD_TO_BODY = 1 / 7.5;

export interface HeadFrame {
  /** Metres per fitted-face unit. */
  scale: number;
  /** Character-space position of fitted origin (the eye-corner midpoint). */
  ox: number; oy: number; oz: number;
}

export function headFrame(chinY: number, crownY: number): HeadFrame {
  const scale = ((crownY - chinY) / FIT_SPAN) * HEAD_SCALE_TRIM;
  return {
    scale,
    ox: -FIT_MIDLINE_X * scale,
    oy: chinY - FIT_CHIN_Y * scale,
    oz: -SKULL.cz * scale,
  };
}

/** Fitted-space point -> character space. */
export function toChar(f: HeadFrame, x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(x * f.scale + f.ox, y * f.scale + f.oy, z * f.scale + f.oz);
}

/* ------------------------------------------------------------------ */
/* Graded axis sampling                                                */
/* ------------------------------------------------------------------ */

interface Peak { at: number; width: number; weight: number }

/**
 * Monotone samples across [lo, hi] whose spacing is inversely proportional to a
 * density built from `peaks`. This is what puts edge loops on the features
 * instead of spreading them evenly over a sphere.
 */
function gradedAxis(count: number, lo: number, hi: number, base: number, peaks: Peak[]): Float64Array {
  const RES = 2048;
  const cdf = new Float64Array(RES + 1);
  for (let i = 0; i < RES; i++) {
    const t = lo + ((i + 0.5) / RES) * (hi - lo);
    let d = base;
    for (const p of peaks) {
      const u = (t - p.at) / p.width;
      d += p.weight * Math.exp(-u * u);
    }
    cdf[i + 1] = cdf[i] + d;
  }
  const total = cdf[RES];
  const out = new Float64Array(count);
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / (count - 1 || 1)) * total;
    while (j < RES && cdf[j + 1] < target) j++;
    const span = cdf[j + 1] - cdf[j];
    const f = span > 1e-12 ? (target - cdf[j]) / span : 0;
    out[k] = lo + ((j + f) / RES) * (hi - lo);
  }
  out[count - 1] = hi;
  return out;
}

const DEG = Math.PI / 180;

/** Elevation rows. Peaks are at the brow, the lids, the nose base and the lips. */
function elevationRows(count: number): Float64Array {
  return gradedAxis(count, -88 * DEG, 88 * DEG, 0.30, [
    { at: 13 * DEG, width: 5 * DEG, weight: 1.5 },   // brow ridge
    { at: 7 * DEG, width: 3.0 * DEG, weight: 2.2 },  // upper lid crease + lash
    { at: 2 * DEG, width: 3.0 * DEG, weight: 1.9 },  // lower lid
    { at: -12 * DEG, width: 6 * DEG, weight: 0.9 },  // mid nose
    { at: -20 * DEG, width: 4 * DEG, weight: 1.8 },  // nose base / ala
    { at: -27 * DEG, width: 3 * DEG, weight: 1.7 },  // upper vermilion
    { at: -31 * DEG, width: 2.2 * DEG, weight: 2.0 }, // lip line
    { at: -35 * DEG, width: 3 * DEG, weight: 1.5 },  // lower vermilion
    { at: -45 * DEG, width: 7 * DEG, weight: 0.8 },  // chin / mentolabial
    { at: -58 * DEG, width: 9 * DEG, weight: 0.6 },  // jaw
    { at: 30 * DEG, width: 12 * DEG, weight: 0.5 },  // forehead
  ]);
}

/** Azimuth columns. 0 is dead ahead; peaks sit on the canthi and mouth corners. */
function azimuthCols(count: number): Float64Array {
  const peaks: Peak[] = [
    { at: 0, width: 7 * DEG, weight: 1.6 },
    { at: 14 * DEG, width: 6 * DEG, weight: 1.3 },
    { at: -14 * DEG, width: 6 * DEG, weight: 1.3 },
    { at: 25 * DEG, width: 6 * DEG, weight: 1.4 },
    { at: -25 * DEG, width: 6 * DEG, weight: 1.4 },
    { at: 39 * DEG, width: 7 * DEG, weight: 1.3 },
    { at: -39 * DEG, width: 7 * DEG, weight: 1.3 },
    { at: 60 * DEG, width: 16 * DEG, weight: 0.5 },
    { at: -60 * DEG, width: 16 * DEG, weight: 0.5 },
  ];
  // Sampled over a full turn starting behind the head so the seam lands at the
  // back, where nothing is ever looked at.
  return gradedAxis(count + 1, -180 * DEG, 180 * DEG, 0.30, peaks);
}

/* ------------------------------------------------------------------ */
/* Anchors handed to the eyes, brows, lashes and hair                  */
/* ------------------------------------------------------------------ */

export interface EyeAnchor {
  /** Eyeball centre, character space. */
  centre: THREE.Vector3;
  /** Eyeball radius, metres. */
  radius: number;
  /** Iris radius, metres. */
  irisRadius: number;
  /** Outward normal of the eye's optical axis. */
  forward: THREE.Vector3;
  /** Lid ring, character space, used to seat lashes and the wet meniscus. */
  ring: THREE.Vector3[];
}

export interface HeadAnchors {
  frame: HeadFrame;
  eyeL: EyeAnchor;
  eyeR: EyeAnchor;
  browL: THREE.Vector3[];
  browR: THREE.Vector3[];
  /** Outer lip border, character space. */
  lips: THREE.Vector3[];
  /** Face silhouette, character space — the hairline is derived from its top. */
  oval: THREE.Vector3[];
  /** Skull surface point for a given azimuth/elevation, for hair cards. */
  surface(az: number, el: number, grow: number, out: THREE.Vector3): THREE.Vector3;
  chinY: number;
  crownY: number;
  /** Half-width of the skull at the temples, metres. */
  templeHalf: number;
  headDepth: number;
  /**
   * How many vertices of the head geometry belong to the skull grid. The ears
   * are welded into the same buffer after it and stand proud of the skull by
   * design, so any measurement of skull width has to stop here or it measures
   * the ears instead.
   */
  skullVertexCount: number;
}

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

export interface HeadBuildOptions {
  /** Deformation target — the subject's landmark cloud. */
  cloud: Cloud;
  chinY: number;
  crownY: number;
  /** Base skin albedo (de-lit, authored — never sampled from a photograph). */
  skin: number;
  /** 0..1 stubble / beard coverage on the jaw. */
  beard: number;
  /** Beard colour, used only for the albedo shadow the stubble casts. */
  beardColor: number;
  /**
   * Hair colour, used only to darken the scalp underneath it.
   *
   * Hair cards and a shell never fully cover a scalp, and bright skin showing
   * between the strands is most of why hair reads as a thin pale scribble
   * instead of a mass. Painting the scalp dark costs nothing and does more for
   * the silhouette than another two hundred cards.
   */
  hairColor?: number;
  /** 0..1 how sunken and shadowed the eyes read. */
  tired: number;
  /** 0..1 how deep the nasolabial folds and forehead lines are cut. */
  age: number;
  /** Extra jaw width, in fitted units — Bolojan's heavy lower face. */
  jawPush: number;
  /** Extra brow ridge projection, fitted units. */
  browPush: number;
  /**
   * The hair style's hairline, elevation as a function of azimuth.
   *
   * The scalp under the hair has to go dark exactly where the hair starts, and
   * "exactly" is the operative word: a single y threshold cannot follow a
   * hairline that sits at 33 degrees dead ahead and 52 at the temple, so the
   * previous approximation left a pale crescent of forehead skin showing
   * through the hair at each temple and a soft fade instead of an edge. Handing
   * the real curve over costs nothing and is most of what makes the hairline
   * read as a boundary rather than a gradient.
   */
  hairline?: (az: number) => number;
  /**
   * The beard style's upper boundary, elevation as a function of azimuth.
   *
   * Same contract, same reason: the stubble tone painted here and the beard
   * cards built in `hair/styles.ts` have to land on the same jaw, or the beard
   * reads as a smudge with hairs somewhere near it.
   */
  beardLine?: (az: number) => number;
  /** Grid resolution. */
  cols?: number;
  rows?: number;
  seed?: number;
}

export interface HeadResult {
  geometry: THREE.BufferGeometry;
  anchors: HeadAnchors;
}

/* ------------------------------------------------------------------ */
/* Build                                                               */
/* ------------------------------------------------------------------ */

const _v = new THREE.Vector3();

export function buildHeadGeometry(opts: HeadBuildOptions): HeadResult {
  const COLS = opts.cols ?? 108;
  const ROWS = opts.rows ?? 84;
  const rng = new Rng(opts.seed ?? 0x51a5e);
  const frame = headFrame(opts.chinY, opts.crownY);

  /* ---- displacement field: mean skull -> this subject ---------------- */
  const target = opts.cloud;
  // The iris landmarks (468..477) describe the EYEBALL, not the skin. Letting
  // them into the field makes the face grow a bubble over each eye that the
  // real eyeball then pokes through, so the field is built from the 468 mesh
  // landmarks only and the socket is carved separately below.
  const SKIN_LM = 468;
  const srcPts = new Float32Array(SKIN_LM * 3);
  for (let i = 0; i < SKIN_LM; i++) {
    projectToSkull(MEAN_CLOUD[i * 3], MEAN_CLOUD[i * 3 + 1], MEAN_CLOUD[i * 3 + 2], srcPts, i * 3);
  }
  const field = buildField(srcPts, target.subarray(0, SKIN_LM * 3) as Float32Array);
  const seats = eyeSeats(target);

  /* ---- grid ---------------------------------------------------------- */
  const el = elevationRows(ROWS);
  const az = azimuthCols(COLS);
  const vcols = COLS + 1;                 // duplicated seam column
  const ringCount = ROWS;
  const vertCount = vcols * ringCount + 2; // + two pole vertices

  const pos = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);
  /** x curvature, y thickness, z cavity, w roughness. */
  const attr = new Float32Array(vertCount * 4);
  const col = new Float32Array(vertCount * 3);
  /** Fitted-space copy, kept for the mask evaluation below. */
  const fit = new Float32Array(vertCount * 3);

  const disp = new Float32Array(3);
  const asym = asymmetry(rng);

  for (let r = 0; r < ringCount; r++) {
    const phi = el[r];
    for (let c = 0; c < vcols; c++) {
      const theta = az[c];
      const i = r * vcols + c;
      surfacePoint(theta, phi, field, disp, opts, asym, seats, fit, i * 3);
      uv[i * 2] = c / COLS;
      uv[i * 2 + 1] = (phi / Math.PI) + 0.5;
    }
  }
  // Poles: average the adjacent ring so the cap closes without a spike.
  const southIdx = ringCount * vcols;
  const northIdx = southIdx + 1;
  // The rings stop at +/-88 degrees, so the caps close over the last 2 degrees:
  // ry * (1 - sin 88) = 0.0004 in fitted units. Anything larger is a spike.
  const CAP_EXTEND = SKULL.ry * (1 - Math.sin(88 * DEG));
  poleFrom(fit, 0, vcols, southIdx * 3, -CAP_EXTEND);
  poleFrom(fit, (ringCount - 1) * vcols, vcols, northIdx * 3, CAP_EXTEND);
  uv[southIdx * 2] = 0.5; uv[southIdx * 2 + 1] = 0;
  uv[northIdx * 2] = 0.5; uv[northIdx * 2 + 1] = 1;

  /* ---- indices -------------------------------------------------------
   *
   * WINDING. This is the single most expensive line in the file to get wrong,
   * and it was wrong.
   *
   * Rows run up in elevation (+Y at the front of the face) and columns run
   * with azimuth (+X at the front). So at the front, edge a->d is +Y and edge
   * a->b is +X, and the triangle (a, d, e) has normal (+Y) x (+X + Y) = -Z:
   * pointing INTO the skull. With the material's default `FrontSide` culling,
   * that means every triangle of the face is discarded and the renderer draws
   * the inside of the back of the cranium instead — which is exactly why the
   * head shipped as a smooth featureless egg with the eyeballs apparently
   * floating outside it. The lids were there; they were being culled. The nose
   * was there; a profile render "proved" it, because a silhouette is the same
   * whichever way the triangles face, which is why it survived review.
   *
   * `computeVertexNormals` derives normals from this winding too, so every
   * normal on the head pointed inward as well and no amount of shading work
   * could have rescued it.
   *
   * `measureOrientation` in `checks.ts` now asserts the mesh's signed volume is
   * positive, which is exactly the statement "the normals point outward".
   */
  const idx: number[] = [];
  for (let r = 0; r < ringCount - 1; r++) {
    for (let c = 0; c < COLS; c++) {
      const a = r * vcols + c;
      const b = r * vcols + c + 1;
      const d = (r + 1) * vcols + c;
      const e = (r + 1) * vcols + c + 1;
      idx.push(a, e, d, a, b, e);
    }
  }
  for (let c = 0; c < COLS; c++) {
    idx.push(southIdx, c, c + 1);
    const top = (ringCount - 1) * vcols;
    idx.push(northIdx, top + c + 1, top + c);
  }

  /* ---- character space ----------------------------------------------- */
  for (let i = 0; i < vertCount; i++) {
    pos[i * 3] = fit[i * 3] * frame.scale + frame.ox;
    pos[i * 3 + 1] = fit[i * 3 + 1] * frame.scale + frame.oy;
    pos[i * 3 + 2] = fit[i * 3 + 2] * frame.scale + frame.oz;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  // Weld the seam so the two duplicated columns share one normal.
  for (let r = 0; r < ringCount; r++) {
    const a = r * vcols;
    const b = r * vcols + COLS;
    const nx = (nrm.getX(a) + nrm.getX(b)) * 0.5;
    const ny = (nrm.getY(a) + nrm.getY(b)) * 0.5;
    const nz = (nrm.getZ(a) + nrm.getZ(b)) * 0.5;
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(a, nx / l, ny / l, nz / l);
    nrm.setXYZ(b, nx / l, ny / l, nz / l);
  }

  /* ---- per-vertex curvature ------------------------------------------ */
  const curv = new Float32Array(vertCount);
  computeCurvature(pos, nrm, vcols, ringCount, curv);

  /* ---- baked occlusion -----------------------------------------------
   * The sunset key is low and often behind the head, so most of the time a
   * face is lit by sky ambient alone. Ambient with no occlusion is perfectly
   * flat, and a flat face is a mask however good the direct lighting is. This
   * measures how far each vertex is recessed below a smoothed version of its
   * own surface at two scales — wide for the sockets, temples and the shelf
   * under the jaw, narrow for the nasolabial folds, the philtrum and the lid
   * creases — which is a cavity map computed from the geometry rather than
   * guessed at. */
  const ao = new Float32Array(vertCount);
  computeOcclusion(fit, vcols, ringCount, ao);

  /* ---- per-vertex masks, roughness, thickness, cavity, albedo -------- */
  paintVertices(opts, target, fit, nrm, curv, ao, vertCount, attr, col, rng);

  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSkin', new THREE.BufferAttribute(attr, 4));

  // Ears are separate geometry welded into the same buffer: MediaPipe has no
  // landmarks for them, and they are the thinnest part of a head — the place
  // where back-lit transmission is most obviously right or wrong.
  appendEars(geo, frame, opts);

  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  const anchors = buildAnchors(frame, target, opts, field, seats, vertCount);
  return { geometry: geo, anchors };
}


/* ------------------------------------------------------------------ */
/* Ears                                                                */
/* ------------------------------------------------------------------ */

/** Ear outline in the (y, z) plane, fitted units, from helix top to lobe. */
function earOutline(t: number): [number, number] {
  const a = t * Math.PI * 2;
  // An ellipse pulled forward at the tragus and drooped at the lobe: a plain
  // ellipse reads as a coin stuck to the skull.
  const ry = 0.115;
  const rz = 0.068;
  const y = Math.cos(a) * ry - (1 - Math.cos(a)) * 0.012;
  const z = Math.sin(a) * rz * (a > Math.PI ? 0.86 : 1.0);
  return [y, z];
}

function appendEars(geo: THREE.BufferGeometry, frame: HeadFrame, opts: HeadBuildOptions): void {
  const RING = 24;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const attr: number[] = [];
  const idx: number[] = [];

  const base = hexToRgb(opts.skin);
  // Ears run hot: thin, well supplied with blood, always the reddest part of a
  // face, and the first place back-lighting shows.
  // Warmer than the face, but the previous +0.06 lift on an already bright skin
  // pushed the ears to a saturated orange that read as a lighting bug.
  const ear: [number, number, number] = [
    Math.min(1, base[0] * 1.04 + 0.022), base[1] * 0.95, base[2] * 0.93,
  ];

  /** Skull half-width at a (y, z) on the head's side. */
  const skullX = (y: number, z: number): number => {
    const dy = (y - SKULL.cy) / SKULL.ry;
    const dz = (z - SKULL.cz) / (z >= SKULL.cz ? SKULL.rzF : SKULL.rzB);
    const k = 1 - dy * dy - dz * dz;
    return SKULL.rx * Math.sqrt(Math.max(0.04, k));
  };

  // attachment -> helix rim (proud) -> antihelix -> concha floor (recessed)
  // `out` is how far each loop stands proud of the skull, in fitted units: the
  // helix rim was 0.056, which is 10.6 mm of ear sticking out of the side of the
  // head. A real helix stands 15-20 mm from the mastoid but the skull surface
  // here is already at the temporal plane, so the visible protrusion has to be
  // about half that or the ears read as handles.
  const LOOPS: Array<{ scale: number; out: number; thick: number; cav: number; rough: number }> = [
    { scale: 1.02, out: -0.004, thick: 0.35, cav: 0.68, rough: 0.50 },
    { scale: 0.99, out: 0.036, thick: 0.95, cav: 1.00, rough: 0.44 },
    { scale: 0.66, out: 0.024, thick: 0.90, cav: 0.60, rough: 0.48 },
    { scale: 0.34, out: 0.004, thick: 0.60, cav: 0.36, rough: 0.52 },
  ];

  const EAR_Y = -0.030;
  const EAR_Z = -0.360;

  for (const side of [1, -1] as const) {
    const first = pos.length / 3;
    for (let l = 0; l < LOOPS.length; l++) {
      const L = LOOPS[l];
      for (let i = 0; i <= RING; i++) {
        const t = i / RING;
        const [oy, oz] = earOutline(t);
        const y = EAR_Y + oy * L.scale;
        // Ears rake back and the helix leans out further at the top.
        const z = EAR_Z + oz * L.scale - 0.035 * (oy / 0.115);
        const lean = 1 + 0.45 * Math.max(0, oy / 0.115);
        const x = side * (skullX(y, z) + L.out * lean);
        const p = new THREE.Vector3();
        toChar(frame, x, y, z, p);
        pos.push(p.x, p.y, p.z);
        nrm.push(side * 0.94, 0.18, -0.28);
        uv.push(t, l / (LOOPS.length - 1));
        col.push(toLinear(ear[0]), toLinear(ear[1]), toLinear(ear[2]));
        attr.push(30 + l * 30, L.thick, L.cav, L.rough);
      }
    }
    const stride = RING + 1;
    for (let l = 0; l < LOOPS.length - 1; l++) {
      for (let i = 0; i < RING; i++) {
        const a = first + l * stride + i;
        const b = a + 1;
        const c = a + stride;
        const d = c + 1;
        if (side > 0) idx.push(a, c, d, a, d, b);
        else idx.push(a, d, c, a, b, d);
      }
    }
  }

  const n = (name: string): THREE.BufferAttribute => geo.getAttribute(name) as THREE.BufferAttribute;
  const offset = n('position').count;
  const merge = (name: string, extra: number[], size: number): void => {
    const a = n(name);
    const out = new Float32Array(a.count * size + extra.length);
    out.set(a.array as Float32Array, 0);
    out.set(extra, a.count * size);
    geo.setAttribute(name, new THREE.BufferAttribute(out, size));
  };
  merge('position', pos, 3);
  merge('normal', nrm, 3);
  merge('uv', uv, 2);
  merge('color', col, 3);
  merge('aSkin', attr, 4);

  const old = geo.getIndex()!;
  const list: number[] = [];
  for (let i = 0; i < old.count; i++) list.push(old.getX(i));
  for (const i of idx) list.push(i + offset);
  geo.setIndex(list);
  geo.computeVertexNormals();
}

/* ------------------------------------------------------------------ */
/* Surface evaluation                                                  */
/* ------------------------------------------------------------------ */

/** Radially project a fitted point onto the base ellipsoid. */
function projectToSkull(x: number, y: number, z: number, out: Float32Array, o: number): void {
  const dx = x - SKULL.cx;
  const dy = y - SKULL.cy;
  const dz = z - SKULL.cz;
  const rz = dz >= 0 ? SKULL.rzF : SKULL.rzB;
  const ux = dx / SKULL.rx;
  const uy = dy / SKULL.ry;
  const uz = dz / rz;
  const l = Math.hypot(ux, uy, uz) || 1;
  out[o] = SKULL.cx + (ux / l) * SKULL.rx;
  out[o + 1] = SKULL.cy + (uy / l) * SKULL.ry;
  out[o + 2] = SKULL.cz + (uz / l) * (dz >= 0 ? SKULL.rzF : SKULL.rzB);
}

interface Asym {
  browY: number; browX: number; mouthY: number; eyeY: number; noseX: number; jawZ: number;
}

/**
 * A perfectly mirrored face reads as CG instantly, so a small deterministic
 * left/right bias is baked in: the brows sit at slightly different heights, one
 * mouth corner is lower, one eye a hair higher, the nose leans.
 */
function asymmetry(rng: Rng): Asym {
  const r = rng.fork('asym');
  return {
    browY: r.range(0.006, 0.014),
    browX: r.range(-0.010, 0.010),
    mouthY: r.range(0.004, 0.010),
    eyeY: r.range(0.003, 0.008),
    noseX: r.range(-0.008, 0.008),
    jawZ: r.range(0.005, 0.014),
  };
}

/**
 * Where each eyeball sits, in fitted units, and the lid aperture around it.
 *
 * This is solved BEFORE the head mesh so the mesh can be built around the
 * globe: inside the aperture the skin drops behind it, outside it the lid
 * drapes OVER it. Get this wrong and the globes read as ping-pong balls glued
 * to the face, which is the classic dead-eye failure — and no amount of iris
 * detail rescues it.
 */
export interface EyeSeat {
  /** Globe centre. */
  cx: number; cy: number; cz: number;
  /** Globe radius. */
  r: number;
  /** Lid aperture half-extents and centre. */
  ax: number; ay: number; acx: number; acy: number;
}

/** An adult eyeball is ~12 mm in radius; in fitted units at head scale: */
const EYE_R_FIT = 0.066;
/**
 * How far the globe's apex is allowed to stand proud of the lid-ring plane.
 *
 * A real cornea does sit slightly ahead of the lid margins — that is where the
 * catchlight lands — but only by about a millimetre, and it must still be well
 * behind the line from the brow ridge to the cheekbone. The old value put it
 * 1.6 mm proud with no orbital recess behind it, which combined with the lid
 * covering only a thin annulus left most of the sphere exposed.
 */
const APEX_PROUD = 0.004;
/** How far the skin recedes behind the globe inside the aperture. */
const LID_RECESS = 0.020;
/** How proud of the globe the lid skin rides. */
const LID_THICK = 0.015;
/**
 * Where the lid's grip on the globe releases, as a fraction of the globe
 * radius. It has to reach past 1.0: the lid skin must still be in front of the
 * globe at its silhouette, or the sphere's edge pokes through the socket.
 */
const LID_RELEASE_IN = 1.00;
const LID_RELEASE_OUT = 1.22;

function eyeSeats(cloud: Cloud): EyeSeat[] {
  const of = (ring: readonly number[]): EyeSeat => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let cz = 0;
    for (const i of ring) {
      const x = cloud[i * 3], y = cloud[i * 3 + 1];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      cz += cloud[i * 3 + 2];
    }
    const acx = (minX + maxX) * 0.5;
    const acy = (minY + maxY) * 0.5;
    return {
      cx: acx,
      cy: acy,
      cz: cz / ring.length - EYE_R_FIT + APEX_PROUD,
      r: EYE_R_FIT,
      ax: (maxX - minX) * 0.5,
      // The fitted lid ring is the CLOSED-ish lid of whatever frame the photo
      // caught, so taking it literally gives a squint. An adult palpebral
      // fissure is 9-11 mm tall, which is 0.055 fitted units of full height;
      // the floor is the half of that, and `measureEyeSeating` bounds the
      // rendered result from both sides so it can neither squint nor stare.
      ay: Math.max((maxY - minY) * 0.5, 0.0292),
      acx,
      acy,
    };
  };
  return [of(EYE_L_RING), of(EYE_R_RING)];
}

const _sculpt: Sculpt = { dx: 0, dy: 0, dz: 0 };
const _sculptOpts: SculptOptions = { age: 0, browPush: 0, jawPush: 0 };

function sculptOpts(opts: HeadBuildOptions): SculptOptions {
  _sculptOpts.age = opts.age;
  _sculptOpts.browPush = opts.browPush;
  _sculptOpts.jawPush = opts.jawPush;
  return _sculptOpts;
}

const NECK_BLEND_START = -0.60;
const NECK_BLEND_END = -0.80;
const NECK_RADIUS_FIT = 0.30;
const NECK_Z_FIT = -0.30;

function surfacePoint(
  theta: number, phi: number, field: ReturnType<typeof buildField>,
  disp: Float32Array, opts: HeadBuildOptions, asym: Asym, seats: EyeSeat[],
  out: Float32Array, o: number,
): void {
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const rz = ct >= 0 ? SKULL.rzF : SKULL.rzB;

  let x = SKULL.cx + SKULL.rx * cp * st;
  let y = SKULL.cy + SKULL.ry * sp;
  let z = SKULL.cz + rz * cp * ct;

  field.sample(x, y, z, disp);
  x += disp[0];
  y += disp[1];
  z += disp[2];

  /* The landmark cloud says WHO this is; it does not say that a head is made of
   * bone. `anatomy.ts` adds the relief the cloud has none of — brow shelf,
   * cheekbone, sub-malar hollow, gonial angle, alar crease, nostrils, lip
   * vermilion, temporal fossa — without which the fit renders as a smooth egg
   * with a soft ridge down the middle. See that file's header. */
  sculpt(x, y, z, Math.max(0, ct), sculptOpts(opts), _sculpt);
  x += _sculpt.dx;
  y += _sculpt.dy;
  z += _sculpt.dz;

  /* Authored pushes on top of the fit: the player is a fusion, and a fusion
   * needs a heavier jaw and a heavier brow than either fit alone. */
  const side = x >= 0 ? 1 : -1;
  if (opts.jawPush !== 0) {
    // Widen the lower face; strongest at the gonial angle, gone by the eyes.
    const w = smooth(-0.18, -0.55, y) * (1 - smooth(-0.62, -0.78, y));
    x += side * opts.jawPush * w * Math.min(1, Math.abs(x) / 0.28);
    z += opts.jawPush * 0.25 * w * Math.max(0, ct);
  }
  if (opts.browPush !== 0) {
    const w = Math.exp(-Math.pow((y - 0.085) / 0.075, 2)) * Math.max(0, ct);
    z += opts.browPush * w;
    y -= opts.browPush * 0.20 * w;
  }

  /* Asymmetry — small, but it is what stops the face reading as mirrored.
   *
   * The left/right selector has to be a SMOOTH ramp through the midline. A hard
   * `x >= 0 ? +a : -a` steps the surface by up to two millimetres at x = 0, all
   * the way from the crown to the chin, and that reads as a seam welded down the
   * middle of the face — which is exactly what it was doing. It went unnoticed
   * because the head was rendering inside out, and the inside of a skull has no
   * midline to crease. */
  const lr = Math.tanh(x / 0.055);
  y += lr * asym.browY * 0.35 * Math.exp(-Math.pow((y - 0.09) / 0.10, 2));
  y -= lr * asym.mouthY * Math.exp(-Math.pow((y + 0.40) / 0.09, 2)) *
    smooth(0.06, 0.14, Math.abs(x));
  y += lr * asym.eyeY * 0.5 * Math.exp(-Math.pow((y - 0.01) / 0.06, 2));
  x += asym.noseX * Math.exp(-Math.pow((y + 0.12) / 0.18, 2)) * Math.max(0, ct);
  z += lr * asym.jawZ * 0.35 * smooth(-0.30, -0.60, y) * Math.max(0, ct);

  /* Seat the eyeballs. Inside the lid aperture the skin drops behind the globe
   * so the eye shows through an almond, not a circle; everywhere else within
   * the globe's silhouette the lid skin is lifted to ride OVER it, which is
   * what gives the upper lid its fold and stops the eyeball bulging out of the
   * face. */
  if (ct > 0) {
    for (const s of seats) {
      const gx = x - s.cx;
      const gy = y - s.cy;
      const g = Math.sqrt(gx * gx + gy * gy) / s.r;
      // Reach past the globe's silhouette: the lid has to be in FRONT of the
      // sphere all the way round its edge, otherwise the widest part of the
      // ball is the last thing covered and it reads as a bead sitting on the
      // face. Outside `LID_RELEASE_OUT` the socket takes over.
      if (g >= LID_RELEASE_OUT) continue;
      const rr = Math.max(0, s.r * s.r - gx * gx - gy * gy);
      // Beyond the silhouette there is no sphere left to sit on, so continue
      // the lid on the tangent plane through the globe's equator.
      const gz = s.cz + Math.sqrt(rr);
      // The palpebral fissure: about 28 mm wide and 10 mm tall on an adult, so
      // it is wider than the globe (24 mm) horizontally — the canthi sit beside
      // the ball, not on it — and covers a third of it vertically.
      const u = (x - s.acx) / (s.ax * 1.06);
      /* HEAVY-LIDDED. The reference has a tired, hooded set to the eyes: the
       * upper lid covers the top of the iris and the fold sits close to the
       * lash line. A symmetric aperture gives an alert, wide-open eye, which is
       * a different man's expression however correctly the fissure measures —
       * and the fissure measured correctly throughout.
       *
       * The obvious version of this, dropping the aperture centre, does not
       * work and `measureEyeSeating` says why: move the whole ellipse down and
       * its lower edge crosses into the globe's lower cap, so the bottom of the
       * ball comes out from under the lid and the eye is googly. The hooding
       * has to come from the TOP edge alone, which is what the asymmetric half
       * extents do. */
      const dyLid = y - s.acy;
      const v = dyLid / (s.ay * (dyLid > 0 ? 0.80 : 1.26));
      const d = Math.sqrt(u * u + v * v);
      const edge = 1 - smooth(LID_RELEASE_IN, LID_RELEASE_OUT, g);
      if (d < 1) {
        // Inside the aperture the skin drops behind the globe, so the eye shows
        // through an almond rather than a circle.
        const w = (1 - d) * (1 - d);
        z = Math.min(z, gz - LID_RECESS * w - 0.0015);
      } else {
        // Outside it the lid rides OVER the globe. The upper lid is thicker
        // than the lower and carries the fold that a real eye has above it.
        const upper = smooth(-0.10, 0.45, gy / s.r);
        const thick = LID_THICK * (0.72 + 0.55 * upper);
        z = z + Math.max(0, gz + thick - z) * edge;
      }
    }
  }

  /* Blend the underside of the head into the neck so the jaw flows down
   * instead of ending in a floating shell. */
  const nb = smooth(NECK_BLEND_START, NECK_BLEND_END, y);
  if (nb > 0) {
    const dx = x - 0;
    const dz = z - NECK_Z_FIT;
    const d = Math.hypot(dx, dz) || 1;
    const nx = (dx / d) * NECK_RADIUS_FIT;
    const nz = NECK_Z_FIT + (dz / d) * NECK_RADIUS_FIT;
    x += (nx - x) * nb;
    z += (nz - z) * nb;
  }

  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
}

/**
 * Close a cap by averaging the ring below it and extending a little past it.
 *
 * The y used to come from the analytic ellipsoid, which was safe only while the
 * sculpt left the crown where the ellipsoid put it. It no longer does — the
 * vault is cut by 0.105 — and an analytic pole above a sculpted ring is a spike
 * welded to the top of the skull. Averaging the ring instead is correct for any
 * sculpt; `extend` is the small residual so the cap still closes convexly
 * rather than as a flat lid.
 */
function poleFrom(fit: Float32Array, ringStart: number, vcols: number, o: number, extend: number): void {
  let x = 0, y = 0, z = 0;
  for (let c = 0; c < vcols - 1; c++) {
    x += fit[(ringStart + c) * 3];
    y += fit[(ringStart + c) * 3 + 1];
    z += fit[(ringStart + c) * 3 + 2];
  }
  const n = vcols - 1;
  fit[o] = x / n;
  fit[o + 1] = y / n + extend;
  fit[o + 2] = z / n;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Smooth |x|, matching `anatomy.ts`. Any painted term centred off the midline
 * has a corner there if it is written against `Math.abs`, which shows up as a
 * hairline notch down the middle of the face in whatever it paints. See the
 * midline note in `anatomy.ts`.
 */
const PAINT_MIDLINE_K = 0.012;
function sabs(x: number): number {
  return Math.sqrt(x * x + PAINT_MIDLINE_K * PAINT_MIDLINE_K) - PAINT_MIDLINE_K;
}

/* ------------------------------------------------------------------ */
/* Curvature                                                           */
/* ------------------------------------------------------------------ */

/**
 * The shortest neighbour separation the estimator will divide by twice, metres.
 *
 * `-(d.n) / len^2` is the right discrete mean curvature for a smooth surface and
 * a catastrophe for anything else: for a surface with a CORNER of slope s it
 * evaluates to s/len, which diverges as the grid gets finer, and for a smooth
 * surface carrying e metres of numerical wobble it reports e/len^2. The columns
 * straddling the midline are 1.45 mm apart — the tightest spacing anywhere on
 * the head, because `azimuthCols` puts its largest density peak at azimuth 0 —
 * so the midline is exactly where both failure modes are worst. That is how the
 * nose-bridge stripe got drawn: see the long note in `anatomy.ts`.
 *
 * The sculpt is now C1 through the midline, so the corner is gone at the source.
 * This is the second line of defence: below this separation the estimate is
 * taken at this length scale instead of at the grid's, which is also the honest
 * thing to report, since 2.5 mm is about the finest relief the scattering LUT
 * can express anything about.
 */
const CURV_LEN_FLOOR = 0.0025;

/**
 * Curvature is clamped to this, 1/m.
 *
 * The LUT's v axis tops out at 0.5 /mm = 500 /m, a 2 mm radius, which is already
 * tighter than anything on a face except a nostril rim. A vertex reporting more
 * than this is reporting a discretisation artifact, and because the attribute
 * indexes a texture row it turns that artifact into a hard colour boundary.
 */
const CURV_MAX = 400;

/**
 * Mean curvature at every vertex, from the grid neighbourhood. Positive is
 * convex (nose tip, cheekbone), negative concave (eye socket, nasolabial
 * fold). This is the second axis of the pre-integrated scattering lookup —
 * scattering is only visible where the incident light changes, which is where
 * the surface bends.
 */
function computeCurvature(
  pos: Float32Array, nrm: THREE.BufferAttribute, vcols: number, rows: number, out: Float32Array,
): void {
  const at = (r: number, c: number): number => r * vcols + ((c + vcols - 1) % (vcols - 1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < vcols; c++) {
      const i = r * vcols + c;
      const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
      const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      let acc = 0;
      let count = 0;
      const neigh = [
        at(r, c - 1), at(r, c + 1),
        r > 0 ? at(r - 1, c) : -1,
        r < rows - 1 ? at(r + 1, c) : -1,
      ];
      for (const j of neigh) {
        if (j < 0) continue;
        const dx = pos[j * 3] - px;
        const dy = pos[j * 3 + 1] - py;
        const dz = pos[j * 3 + 2] - pz;
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-7) continue;
        const one = -(dx * nx + dy * ny + dz * nz) / (len * Math.max(len, CURV_LEN_FLOOR));
        acc += one < -CURV_MAX ? -CURV_MAX : one > CURV_MAX ? CURV_MAX : one;
        count++;
      }
      out[i] = count > 0 ? acc / count : 0;
    }
  }
  // One smoothing pass: raw per-vertex curvature is noisy and the LUT axis
  // amplifies noise into blotches.
  const tmp = out.slice();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < vcols; c++) {
      const i = r * vcols + c;
      let s = tmp[i] * 2;
      let w = 2;
      const neigh = [
        at(r, c - 1), at(r, c + 1),
        r > 0 ? at(r - 1, c) : -1,
        r < rows - 1 ? at(r + 1, c) : -1,
      ];
      for (const j of neigh) {
        if (j < 0) continue;
        s += tmp[j];
        w++;
      }
      out[i] = s / w;
    }
  }
}

/**
 * Multi-scale cavity occlusion, from the head's own radial profile.
 *
 * `r` is each vertex's distance from the head centre. Blurring it across the
 * grid gives the surface the head "would" have if its features were filled in;
 * where the real surface sits inside that, light is occluded. Two blur widths
 * catch two scales of feature, which is what separates a deep eye socket from
 * the fine crease at the corner of a nostril.
 */
function computeOcclusion(fit: Float32Array, vcols: number, rows: number, out: Float32Array): void {
  const n = rows * vcols;
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = fit[i * 3] - SKULL.cx;
    const dy = (fit[i * 3 + 1] - SKULL.cy) * (SKULL.rx / SKULL.ry);
    const dz = (fit[i * 3 + 2] - SKULL.cz) * (SKULL.rx / SKULL.rzF);
    r[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const blur = (src: Float32Array, iterations: number): Float32Array => {
    let a = src.slice();
    let b = new Float32Array(n);
    for (let it = 0; it < iterations; it++) {
      for (let row = 0; row < rows; row++) {
        for (let c = 0; c < vcols; c++) {
          const i = row * vcols + c;
          const cl = row * vcols + ((c + vcols - 2) % (vcols - 1));
          const cr = row * vcols + ((c + 1) % (vcols - 1));
          const up = row < rows - 1 ? i + vcols : i;
          const dn = row > 0 ? i - vcols : i;
          b[i] = (a[i] * 2 + a[cl] + a[cr] + a[up] + a[dn]) / 6;
        }
      }
      const t = a; a = b; b = t;
    }
    return a;
  };

  const wide = blur(r, 26);
  const narrow = blur(r, 6);

  for (let i = 0; i < n; i++) {
    const dWide = Math.max(0, wide[i] - r[i]);
    const dNarrow = Math.max(0, narrow[i] - r[i]);
    const occ = dWide * 7.5 + dNarrow * 16.0;
    out[i] = Math.max(0.22, 1 - Math.min(0.78, occ));
  }
  // Poles inherit the nearest ring.
  for (let i = n; i < out.length; i++) out[i] = 1;
}

/* ------------------------------------------------------------------ */
/* Per-vertex skin authoring                                           */
/* ------------------------------------------------------------------ */

function hexToRgb(h: number): [number, number, number] {
  return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
}

/** sRGB -> linear, because the material's vertex colours are consumed linearly. */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function paintVertices(
  opts: HeadBuildOptions, cloud: Cloud, fit: Float32Array,
  nrm: THREE.BufferAttribute, curv: Float32Array, ao: Float32Array, count: number,
  attr: Float32Array, col: Float32Array, rng: Rng,
): void {
  const base = hexToRgb(opts.skin);
  const beardCol = hexToRgb(opts.beardColor);
  const hairCol = hexToRgb(opts.hairColor ?? 0x2a211a);
  const hairline = opts.hairline;
  const beardLine = opts.beardLine;
  const noiseSeed = rng.fork('skin').int(0, 1 << 24);

  const lipsOuter = LIPS_OUTER as unknown as number[];
  const lipsInner = LIPS_INNER as unknown as number[];
  const eyeL = EYE_L_RING as unknown as number[];
  const eyeR = EYE_R_RING as unknown as number[];
  const nasoL = NASOLABIAL_L as unknown as number[];
  const nasoR = NASOLABIAL_R as unknown as number[];
  const browLB = BROW_L_BOTTOM as unknown as number[];
  const browRB = BROW_R_BOTTOM as unknown as number[];
  const bridge = NOSE_BRIDGE as unknown as number[];
  const noseAla = [L.noseLeftAla, L.noseRightAla, 98, 327, 115, 344];
  const nostril = [L.subnasale, 2, 97, 326, 64, 294];

  for (let i = 0; i < count; i++) {
    const x = fit[i * 3];
    const y = fit[i * 3 + 1];
    const z = fit[i * 3 + 2];
    const nz = nrm.getZ(i);
    const front = Math.max(0, nz);

    /* --- masks, all measured against the landmark cloud --- */
    const dLips = distToPolyline(cloud, lipsOuter, x, y, z, true);
    const dLipLine = distToPolyline(cloud, lipsInner, x, y, z, true);
    const dEye = Math.min(
      distToPolyline(cloud, eyeL, x, y, z, true),
      distToPolyline(cloud, eyeR, x, y, z, true),
    );
    const dNaso = Math.min(
      distToPolyline(cloud, nasoL, x, y, z),
      distToPolyline(cloud, nasoR, x, y, z),
    );
    const dBrow = Math.min(
      distToPolyline(cloud, browLB, x, y, z),
      distToPolyline(cloud, browRB, x, y, z),
    );
    const dBridge = distToPolyline(cloud, bridge, x, y, z);
    const dAla = nearestDist(cloud, noseAla, x, y, z);
    const dNostril = nearestDist(cloud, nostril, x, y, z);

    const mLips = 1 - smooth(0.0, 0.055, dLips);
    const mLipLine = 1 - smooth(0.0, 0.020, dLipLine);
    const mEyeRim = 1 - smooth(0.0, 0.028, dEye);
    const mNaso = (1 - smooth(0.0, 0.038, dNaso)) * smooth(0.25, 0.75, opts.age);
    const mBrowUnder = (1 - smooth(0.008, 0.048, dBrow)) * Math.max(0, -curvSign(curv[i]));
    const mTzone = Math.max(
      1 - smooth(0.02, 0.11, dBridge),
      Math.exp(-Math.pow((y - 0.22) / 0.16, 2)) * Math.exp(-Math.pow(x / 0.17, 2)),
    ) * front;
    const mAla = 1 - smooth(0.0, 0.055, dAla);
    const mNostril = 1 - smooth(0.0, 0.030, dNostril);

    /* Beard: the same boundary the cards are grown from, cut with a real edge
     * rather than a fade — a trimmed beard has a line you could draw, and a
     * gradient here is most of why it read as a shadow. `front` is deliberately
     * NOT a factor: a beard wraps round the jaw to the ear, and gating on the
     * surface normal deleted it exactly where the sideburn meets it. */
    const beardAz = Math.atan2(x - SKULL.cx, z - SKULL.cz);
    const beardTopEl = beardLine ? beardLine(beardAz) : -0.70;
    const beardTopY = SKULL.cy + SKULL.ry * Math.sin(beardTopEl);
    // A trimmed beard has a line you could draw, but not one you could cut
    // yourself on: above the boundary the hair thins out over about a
    // centimetre rather than stopping dead. At 5 mm of ramp the edge rendered
    // as a chinstrap moulded onto the face.
    const beardBand = smooth(beardTopY + 0.055, beardTopY - 0.040, y) *
      (1 - smooth(-0.60, -0.76, y)) *
      (1 - smooth(78 * DEG, 96 * DEG, Math.abs(beardAz)));
    /* MOUSTACHE MASS.
     *
     * `beardLine` has to dip hard at the front — at zero azimuth that elevation
     * band IS the mouth — so it leaves the moustache with no painted mass under
     * it, and `styles.ts` emits its moustache cards up there regardless. Cards
     * alone are alpha-tested strands with skin between them: sampled off the
     * render the moustache came back at 193/255 against the reference
     * photograph's 79, brighter than the cheek beside it. This is the same
     * "cards break the silhouette, albedo carries the mass" contract as the
     * beard proper, applied to the one patch the azimuth curve cannot reach.
     * The band matches the card emission in `buildBeard`: above the upper
     * vermilion, below the subnasale, fading out past the mouth corners. */
    const stache = smooth(-0.374, -0.352, y) * (1 - smooth(-0.292, -0.260, y)) *
      (1 - smooth(0.112, 0.172, sabs(x))) * front;
    const mBeard = Math.max(
      0,
      Math.min(1, beardBand + stache * 0.95) * opts.beard * (1 - mLips * 0.98),
    );
    // Ear region: the sides of the head at eye height, where the cloud stops.
    const mEar = smooth(0.30, 0.40, Math.abs(x)) * (1 - smooth(0.12, 0.34, Math.abs(y + 0.06)));

    /* --- curvature: normalise into the LUT's useful range --- */
    const k = curv[i];

    /* --- thickness: ears, nostrils and lips glow when back-lit --- */
    let thick = 0.06;
    thick = Math.max(thick, mEar * 0.85);
    thick = Math.max(thick, mAla * 0.55);
    thick = Math.max(thick, mNostril * 0.80);
    thick = Math.max(thick, mLips * 0.62);
    thick = Math.max(thick, mEyeRim * 0.45);
    // Convex thin edges generally transmit — the rim of the nose, the chin edge.
    thick = Math.max(thick, Math.min(0.5, Math.max(0, k) * 0.030));
    thick *= 1 - smooth(-0.55, -0.75, y) * 0.7;   // the neck is not thin

    /* --- cavity: creases that should stay dark whatever the key light does --- */
    let cav = 1;
    cav -= mNaso * 0.52;
    cav -= mLipLine * 0.78;
    cav -= mBrowUnder * 0.30;
    cav -= mNostril * 0.55;
    cav -= (1 - smooth(0.0, 0.045, dEye)) * 0.18 * (0.4 + opts.tired * 0.6);
    /* Concave skin self-shadows, but this coupling was unbounded: `k` is in 1/m
     * and a single outlier vertex — the negative ring that flanks any curvature
     * spike — took 0.4 out of cavity on its own and drew a one-vertex black line
     * down the midline. Curvature is clamped at the source now; this is bounded
     * as well, because a cavity term has no business being the widest-range
     * quantity in the shader. 0.12 is a genuinely deep crease and the terms
     * above already name every crease a face actually has. */
    cav -= Math.min(0.12, Math.max(0, -k) * 0.0035);
    // Forehead lines and the permanent glabellar frown.
    const foreheadLines = Math.exp(-Math.pow((x) / 0.24, 2)) *
      Math.max(0, Math.sin((y - 0.14) * 62)) * smooth(0.16, 0.34, y) *
      smooth(0.3, 0.9, opts.age) * front;
    cav -= foreheadLines * 0.10;
    /* Two furrows, one either side of the midline — and they have to STAY two.
     * Written against `Math.abs(x)` this has a corner at the midline worth a
     * tenth of its own depth, so the pair merged into a single band and read as
     * one dark stripe rather than as a frown. `sabs` is the same smoothed
     * absolute value the sculpt uses; the furrows are also pushed out from 0.030
     * to 0.034 and narrowed, because a corrugator furrow sits over the medial
     * brow, not on the midline. */
    const frown = Math.exp(-Math.pow((y - 0.10) / 0.045, 2)) *
      Math.exp(-Math.pow((sabs(x) - 0.034) / 0.016, 2)) * front;
    cav -= frown * 0.22 * opts.tired;
    // The alar crease: the groove that separates the wing of the nose from the
    // cheek. Front-on it is the only thing that says "nose" when the key light
    // is behind the camera, and it is the first casualty of a smooth fit.
    const alarCrease = Math.exp(-Math.pow((sabs(x) - 0.062) / 0.016, 2)) *
      Math.exp(-Math.pow((y + 0.252) / 0.046, 2)) * front;
    cav -= alarCrease * 0.24;
    // Philtrum: two ridges with a groove between them, under the septum.
    const philtrum = Math.exp(-Math.pow(x / 0.014, 2)) *
      Math.exp(-Math.pow((y + 0.325) / 0.030, 2)) * front;
    cav -= philtrum * 0.20;
    cav *= ao[i];
    cav = Math.max(0.22, cav);

    /* --- roughness: a real oily T-zone against matte cheeks --- */
    let rough = 0.47;
    rough -= mTzone * 0.10;
    rough += (1 - front) * 0.06;
    rough -= mLips * 0.20;
    rough += mBeard * 0.16;
    rough += mNaso * 0.05;
    rough -= mEyeRim * 0.06;
    // Roughness breakup at pore scale, not at cheek scale: a uniform roughness
    // is a lacquered surface however good its normal map is.
    rough += (valueNoise2D(x * 44, y * 44, noiseSeed) - 0.5) * 0.05;
    rough += (valueNoise2D(x * 170, y * 170, noiseSeed ^ 0x77) - 0.5) * 0.13;
    rough = Math.min(0.78, Math.max(0.16, rough));

    attr[i * 4] = k;
    attr[i * 4 + 1] = thick;
    attr[i * 4 + 2] = cav;
    attr[i * 4 + 3] = rough;

    /* --- albedo: authored, de-lit, never a photograph --- */
    let r = base[0], g = base[1], b = base[2];
    /* Three octaves, and the amplitudes matter more than they look. The
     * micro-NORMAL alone cannot rescue a waxy face: under a broad low key a
     * perturbed normal barely changes the diffuse term, so the relief it adds
     * is invisible while the surface is a single flat colour. What reads as
     * skin at half a metre is high-frequency ALBEDO variation — blotch,
     * capillary, sun damage — and it was running at a third of the amplitude
     * real skin has. In fitted units the head spans about 1.0, so 26 / 90 / 230
     * are roughly 6 mm, 1.7 mm and 0.7 mm features. */
    const mottle = (valueNoise2D(x * 26 + 11, y * 26 + 7, noiseSeed) - 0.5) * 0.085 +
      (valueNoise2D(x * 90, y * 90, noiseSeed ^ 0x5f) - 0.5) * 0.055 +
      // Nothing finer than this: the grid spacing on the face is 2-3 mm, so an
      // octave below about 6 mm aliases into per-vertex speckle instead of into
      // skin. Detail past that point is the micro-NORMAL's job, which is
      // evaluated per fragment.
      0;
    r += mottle * 1.20; g += mottle * 0.82; b += mottle * 0.70;

    // Vascular warmth: nose, ears, cheeks and eyelids run red; the forehead and
    // chin run a touch yellow. This is the low-frequency colour zoning that a
    // de-lit photo would have given us, authored instead.
    /* Halved, and the blue is no longer pulled down with the green.
     *
     * The old weights added 0.085 of red while REMOVING 0.030 of blue over the
     * nose, ears and most of the cheek, which is a saturation push dressed up as
     * a vascular one — it drove B/R down to 0.42 against the reference's 0.50-58
     * and put the last of the orange into exactly the features the eye lands on.
     * Real subdermal blood reddens skin; it does not desaturate the blue out of
     * it, and on an olive complexion the cool undertone survives the flush. */
    const redZone = Math.max(
      mAla * 0.9,
      Math.max(mEar * 0.7, Math.max(mEyeRim * 0.55, mNostril * 0.9)),
    ) + cheekBloom(x, y) * 0.38;
    r += redZone * 0.046;
    g -= redZone * 0.016;
    b -= redZone * 0.006;

    const yellowZone = mTzone * 0.6 + Math.max(0, smooth(-0.50, -0.66, y)) * 0.4;
    r += yellowZone * 0.012;
    g += yellowZone * 0.012;
    b -= yellowZone * 0.006;

    // Lips: desaturated brick, darker at the line, never lipstick. Applied
    // AFTER nothing and before the beard, but at enough strength to survive it
    // — a mouth that the moustache and the stubble tone between them erase is
    // a face with no mouth, which is what the front view had.
    if (mLips > 0) {
      const t = mLips * 0.95;
      r += (0.47 - r) * t * 0.72;
      g += (0.23 - g) * t * 0.72;
      b += (0.21 - b) * t * 0.72;
    }

    // Tired, darker orbital skin — the hero's defining expression.
    const orbital = (1 - smooth(0.010, 0.070, dEye)) * (0.35 + opts.tired * 0.65);
    r *= 1 - orbital * 0.16;
    g *= 1 - orbital * 0.19;
    b *= 1 - orbital * 0.16;

    // Scalp: dark under the hair, with a hard edge at the hairline. The mask
    // follows the style's own hairline curve when one is supplied, which is the
    // only way it can be right at the temple and at the front at once.
    /* `el` is recovered from the SCULPTED y, and the vault cut in `anatomy.ts`
     * lowers y most near the crown — so the recovered elevation runs a degree
     * or two under the parametric elevation the hair was grown at, and by more
     * at the temple than at the front. Comparing the two directly therefore
     * left the scalp pale exactly where the temple recession is deepest, which
     * rendered as two bright wedges of forehead poking up into the hair. The
     * band is biased below the hairline to swallow that error, which also gives
     * the shell's alpha dissolve something dark to fade into instead of bare
     * forehead. */
    const el = Math.asin(Math.max(-1, Math.min(1, (y - SKULL.cy) / SKULL.ry)));
    const scalpTop = hairline
      ? smooth(-0.075, -0.010, el - hairline(Math.atan2(x - SKULL.cx, z - SKULL.cz)))
      : smooth(0.20, 0.34, y);
    const scalpBack = smooth(-0.16, -0.42, z);
    const mScalp = Math.min(1, Math.max(scalpTop, scalpBack));
    if (mScalp > 0.004) {
      // Nearly opaque: hair cards and a shell never fully cover a scalp, and
      // bright skin between the strands is most of why hair reads as a pale
      // scribble. This is cheaper than another thousand cards and works better.
      const t = mScalp * 0.95;
      r += (hairCol[0] - r) * t;
      g += (hairCol[1] - g) * t;
      b += (hairCol[2] - b) * t;
    }

    // Stubble as albedo under the cards: the cards break the silhouette and
    // catch the key, this is the mass they sit in. Nearly opaque, for the same
    // reason the scalp is — pale skin between the strands is what makes hair of
    // any kind read as a scatter of specks.
    if (mBeard > 0.003) {
      const t = Math.min(0.96, mBeard);
      r += (beardCol[0] - r) * t * 0.92;
      g += (beardCol[1] - g) * t * 0.92;
      b += (beardCol[2] - b) * t * 0.94;
    }

    // Cavity is a shading term, not albedo — but a shallow amount of it in the
    // albedo keeps creases readable in flat ambient light.
    const cavAlbedo = 1 - (1 - cav) * 0.35;
    r *= cavAlbedo; g *= cavAlbedo; b *= cavAlbedo;

    col[i * 3] = toLinear(Math.min(1, Math.max(0, r)));
    col[i * 3 + 1] = toLinear(Math.min(1, Math.max(0, g)));
    col[i * 3 + 2] = toLinear(Math.min(1, Math.max(0, b)));
  }
}

function curvSign(k: number): number {
  return k > 0 ? 1 : -1;
}

function cheekBloom(x: number, y: number): number {
  const dx = (Math.abs(x) - 0.24) / 0.13;
  const dy = (y + 0.20) / 0.14;
  return Math.exp(-(dx * dx + dy * dy));
}

/* ------------------------------------------------------------------ */
/* Anchors                                                             */
/* ------------------------------------------------------------------ */

function buildAnchors(
  frame: HeadFrame, cloud: Cloud, opts: HeadBuildOptions,
  field: ReturnType<typeof buildField>, seats: EyeSeat[], skullVertexCount: number,
): HeadAnchors {
  const pts = (idx: readonly number[]): THREE.Vector3[] =>
    idx.map((i) => toChar(frame, cloud[i * 3], cloud[i * 3 + 1], cloud[i * 3 + 2], new THREE.Vector3()));

  const eye = (ring: readonly number[], iris: readonly number[], seat: EyeSeat): EyeAnchor => {
    const r = pts(ring);
    const ir = pts(iris);
    // The seat was solved before the mesh was built and the mesh was built
    // around it, so the globe goes exactly there and nowhere else.
    const centre = toChar(frame, seat.cx, seat.cy, seat.cz, new THREE.Vector3());
    let irisR = 0;
    for (let i = 1; i < ir.length; i++) irisR = Math.max(irisR, ir[i].distanceTo(ir[0]));
    irisR = Math.min(0.0074, Math.max(0.0056, irisR));
    const radius = seat.r * frame.scale;
    const forward = new THREE.Vector3(0, 0, 1);
    return { centre, radius, irisRadius: irisR, forward, ring: r };
  };

  const disp = new Float32Array(3);
  const surface = (azm: number, elev: number, grow: number, out: THREE.Vector3): THREE.Vector3 => {
    const cp = Math.cos(elev), sp = Math.sin(elev);
    const st = Math.sin(azm), ct = Math.cos(azm);
    const rz = ct >= 0 ? SKULL.rzF : SKULL.rzB;
    let x = SKULL.cx + SKULL.rx * cp * st;
    let y = SKULL.cy + SKULL.ry * sp;
    let z = SKULL.cz + rz * cp * ct;
    field.sample(x, y, z, disp);
    x += disp[0]; y += disp[1]; z += disp[2];
    // The same sculpt the mesh gets, or every attachment — hair roots, brows,
    // lashes, beard — would be seated on a surface that no longer exists.
    sculpt(x, y, z, Math.max(0, ct), sculptOpts(opts), _sculpt);
    x += _sculpt.dx; y += _sculpt.dy; z += _sculpt.dz;
    if (opts.browPush !== 0) {
      const w = Math.exp(-Math.pow((y - 0.085) / 0.075, 2)) * Math.max(0, ct);
      z += opts.browPush * w;
    }
    const nx = SKULL.rx * cp * st;
    const ny = SKULL.ry * sp;
    const nz = rz * cp * ct;
    const nl = Math.hypot(nx / SKULL.rx, ny / SKULL.ry, nz / rz) || 1;
    x += (nx / (SKULL.rx * SKULL.rx * nl)) * grow * SKULL.rx;
    y += (ny / (SKULL.ry * SKULL.ry * nl)) * grow * SKULL.ry;
    z += (nz / (rz * rz * nl)) * grow * rz;
    return toChar(frame, x, y, z, out);
  };

  const oval = pts(FACE_OVAL);
  const templeHalf = Math.abs(toChar(frame, SKULL.rx + SKULL.cx, 0, 0, _v).x);
  return {
    frame,
    eyeL: eye(EYE_L_RING, IRIS_L, seats[0]),
    eyeR: eye(EYE_R_RING, IRIS_R, seats[1]),
    browL: pts(BROW_L_TOP),
    browR: pts(BROW_R_TOP),
    lips: pts(LIPS_OUTER),
    oval,
    surface,
    chinY: opts.chinY,
    crownY: opts.crownY,
    templeHalf,
    headDepth: (SKULL.rzF + SKULL.rzB) * frame.scale,
    skullVertexCount,
  };
}
