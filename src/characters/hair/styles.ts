/**
 * HAIR STYLES — the guides that make each cast member's silhouette.
 *
 * Recognition at gameplay distance comes from silhouette, hairline, brow and
 * build long before it comes from skin pores, so this file carries as much of
 * the likeness as the deformed head does:
 *
 *   player    cropped dark hair, close at the sides, greying hard at the
 *             temples, with the hairline pushed back toward Bolojan's without
 *             going bald; heavy dark angled brows; short salt-and-pepper beard
 *   nicusor   the defining feature is HAIR VOLUME — a thick curly mop sitting
 *             high off the skull with the temples deeply receded, so the mass
 *             reads as two lobes over a high forehead
 *   ally      tousled wavy hair swept back and up, clean-shaven with a faint
 *             stubble shadow
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { HeadAnchors } from '../face/headMesh';
import { RibbonBuilder, type Guide } from './hair';

const DEG = Math.PI / 180;

export interface HairSpec {
  /** Hairline elevation (radians) as a function of azimuth. */
  hairline: (az: number) => number;
  /** Shell thickness in fitted units at a scalp point. */
  volume: (az: number, el: number) => number;
  /** Number of surface cards. */
  cards: number;
  /** Card length, in elevation radians travelled. */
  cardSpan: number;
  cardHalf: number;
  /** Sideways wander of a card, radians of azimuth. */
  wander: number;
  /** Curl amplitude in fitted units and its frequency along the card. */
  curl: number;
  curlFreq: number;
  /** Cards lift off the scalp by this much extra at their tip. */
  lift: number;
  flyaways: number;
  /** 0..1 grey at the temples and overall. */
  greyTemple: number;
  greyOverall: number;
  /** Sideburn depth below the ear line, radians. */
  sideburn: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Wrap an azimuth into [-PI, PI]. */
function wrapAz(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/**
 * A hairline built from four control heights: front centre, temple (the recess),
 * the side above the ear, and the nape. `temple` is what carries a receding
 * hairline, and both the player and Nicusor are defined by it.
 */
export function hairlineFn(front: number, temple: number, side: number, nape: number) {
  return (az: number): number => {
    const a = Math.abs(wrapAz(az)) / Math.PI;   // 0 front .. 1 back
    if (a < 0.22) return front + (temple - front) * smoothstep(0.05, 0.22, a);
    if (a < 0.45) return temple + (side - temple) * smoothstep(0.22, 0.45, a);
    return side + (nape - side) * smoothstep(0.45, 1.0, a);
  };
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/**
 * The player: the `ref-lead-head` crop's cropped dark hair, with Bolojan's
 * higher, more receding hairline pushed into it — he has to nod at the bald
 * crown without stopping being the man in the target frame.
 */
export const PLAYER_HAIR: HairSpec = {
  // Higher and more receded at the temple than the target frame alone shows —
  // the Bolojan half of the fusion, nodding at his bald crown. The front stays
  // where the frame puts it, because pushing both back leaves a forehead with
  // nothing on it, which is the failure the last pass had.
  /* HAIRLINE. Bolojan's recession has to show, and the obvious way to author it
   * — a low front and a high temple — is the wrong one. `hairlineFn` moves the
   * whole front-to-temple difference between about 9 and 40 degrees of azimuth,
   * so any large gap becomes a sharp central peak with a bright wedge of
   * forehead either side of it: devil horns, not a receding hairline. Recession
   * reads far better as a UNIFORMLY higher line with only a few degrees of
   * temple lift, which is also what the reference frame actually shows. */
  hairline: hairlineFn(33 * DEG, 37 * DEG, 4 * DEG, -18 * DEG),
  volume: (az, el) => {
    const a = Math.abs(wrapAz(az)) / Math.PI;
    // Close at the sides, a little more on top — a real short back and sides.
    // The first pass gave 3 mm of shell, which at head scale is a shaved scalp
    // with a scribble on it rather than cropped hair.
    const top = smoothstep(26 * DEG, 68 * DEG, el);
    return 0.034 + 0.052 * top * (1 - 0.45 * smoothstep(0.25, 0.6, a) * (1 - top));
  },
  /* 460 cards over a whole scalp is one strand every few millimetres, which is
   * what "thin and wispy" measures: the shell shows through everywhere between
   * them and the silhouette is a scribble rather than a mass. A dense short
   * crop needs the cards to OVERLAP, so the count is tripled and each card is
   * wider — and the flyaway count comes DOWN, because flyaways are what make
   * sparse hair look sparse rather than what makes dense hair look real. */
  cards: 1500,
  cardSpan: 24 * DEG,
  cardHalf: 0.0058,
  wander: 8 * DEG,
  curl: 0.005,
  curlFreq: 2.2,
  lift: 0.006,
  flyaways: 34,
  greyTemple: 0.34,
  greyOverall: 0.07,
  sideburn: -16 * DEG,
};

/**
 * Nicusor: hair volume is the whole likeness. A thick curly mop sitting high,
 * temples cut away so the mass reads as two lobes over a tall forehead, which
 * is what makes him silhouette-distinct from the player at a glance.
 */
export const NICUSOR_HAIR: HairSpec = {
  hairline: hairlineFn(36 * DEG, 55 * DEG, 2 * DEG, -20 * DEG),
  volume: (az, el) => {
    const a = Math.abs(wrapAz(az)) / Math.PI;
    const top = smoothstep(18 * DEG, 62 * DEG, el);
    // Two lobes: the mass is heaviest just behind the temple recess.
    const lobe = Math.exp(-Math.pow((a - 0.33) / 0.24, 2));
    return 0.040 + 0.185 * top * (0.55 + 0.85 * lobe);
  },
  cards: 1250,
  cardSpan: 34 * DEG,
  cardHalf: 0.0056,
  wander: 22 * DEG,
  curl: 0.030,
  curlFreq: 4.6,
  lift: 0.048,
  flyaways: 90,
  greyTemple: 0.48,
  greyOverall: 0.30,
  sideburn: -8 * DEG,
};

/** Alex: tousled dark wavy hair swept back and up, loose strands at the front. */
export const ALLY_HAIR: HairSpec = {
  hairline: hairlineFn(33 * DEG, 41 * DEG, 4 * DEG, -18 * DEG),
  volume: (az, el) => {
    const a = Math.abs(wrapAz(az)) / Math.PI;
    const top = smoothstep(24 * DEG, 66 * DEG, el);
    return 0.020 + 0.062 * top * (1 - 0.30 * smoothstep(0.3, 0.7, a));
  },
  cards: 950,
  cardSpan: 32 * DEG,
  cardHalf: 0.0054,
  wander: 15 * DEG,
  curl: 0.016,
  curlFreq: 3.0,
  lift: 0.030,
  flyaways: 70,
  greyTemple: 0.10,
  greyOverall: 0.04,
  sideburn: -14 * DEG,
};

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/**
 * The scalp-hugging mass. Its lower edge lands on the hairline and fades out
 * through the strand texture's tip, so the hair never ends in a hard rim
 * against the forehead — which is exactly what makes cheap hair read as a cap.
 */
export function buildHairShell(anchors: HeadAnchors, spec: HairSpec): THREE.BufferGeometry {
  const AZ = 56;
  const EL = 16;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const tan: number[] = [];
  const info: number[] = [];
  const idx: number[] = [];

  const p = new THREE.Vector3();
  const pUp = new THREE.Vector3();
  const centre = new THREE.Vector3(0, (anchors.chinY + anchors.crownY) * 0.5, -anchors.headDepth * 0.12);

  for (let j = 0; j <= EL; j++) {
    const t = j / EL;
    for (let i = 0; i <= AZ; i++) {
      const az = -Math.PI + (i / AZ) * Math.PI * 2;
      const el0 = spec.hairline(az);
      const el = el0 + (88 * DEG - el0) * t;
      const grow = spec.volume(az, el) * (0.35 + 0.65 * smoothstep(0, 0.30, t));
      anchors.surface(az, el, grow, p);
      anchors.surface(az, Math.min(88 * DEG, el + 3 * DEG), grow, pUp);
      const n = p.clone().sub(centre).normalize();
      const tg = pUp.sub(p).normalize();
      pos.push(p.x, p.y, p.z);
      nrm.push(n.x, n.y, n.z);
      // Solid through the mass, dissolving at the hairline. `flipY` puts the
      // texture's solid end at v = 1, so v has to RISE toward the crown.
      uv.push((i / AZ) * 14, 0.08 + t * 0.92);
      tan.push(tg.x, tg.y, tg.z);
      const templeGrey = Math.exp(-Math.pow((Math.abs(wrapAz(az)) / Math.PI - 0.26) / 0.15, 2)) *
        (1 - smoothstep(0.1, 0.5, t));
      info.push(0.25 + 0.75 * t, Math.min(1, spec.greyOverall + spec.greyTemple * templeGrey));
    }
  }
  for (let j = 0; j < EL; j++) {
    for (let i = 0; i < AZ; i++) {
      const a = j * (AZ + 1) + i;
      const b = a + 1;
      const c = a + AZ + 1;
      const d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aStrandTangent', new THREE.Float32BufferAttribute(tan, 3));
  g.setAttribute('aStrandInfo', new THREE.Float32BufferAttribute(info, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/* ------------------------------------------------------------------ */
/* Cards + flyaways                                                    */
/* ------------------------------------------------------------------ */

export function buildHairCards(anchors: HeadAnchors, spec: HairSpec, seed: string): THREE.BufferGeometry | null {
  const rng = new Rng(seed);
  const rb = new RibbonBuilder();
  const p = new THREE.Vector3();
  const centre = new THREE.Vector3(0, (anchors.chinY + anchors.crownY) * 0.5, -anchors.headDepth * 0.12);
  const metres = anchors.frame.scale;
  const SEG = 6;

  /**
   * The hairline, as a hard floor on where any strand vertex may sit.
   *
   * Cards grow upward from their root, so in principle none of them can reach
   * the forehead — but `wander` moves a card sideways as it grows, and the
   * hairline is much higher at the temple than at the front, so a card rooted
   * at the front centre and wandering outward ends up *below* the hairline it
   * has moved into and lands on the temple as a scratch across skin. Flyaways,
   * with two to four times the lift and up to twice the span, arc over the brow
   * outright. Clamping per sample rather than per card is what makes it a
   * guarantee instead of a tendency; `measureHairClearance` checks it.
   */
  const floor = (az: number, flyaway: boolean): number => {
    const w = Math.abs(wrapAz(az));
    // Past the temple we are in front of the ear, where a sideburn belongs and
    // a low strand is not on the face at all. Release the floor there.
    if (w > 58 * DEG) return -90 * DEG;
    const line = spec.hairline(az);
    const a = w / Math.PI;
    // A fringe may hang a little into the upper forehead dead ahead, and none
    // at all once we are round at the temple.
    const fringe = (flyaway ? 3.5 : 6.0) * DEG * (1 - smoothstep(0.05, 0.20, a));
    const release = smoothstep(48 * DEG, 58 * DEG, w);
    return (line - fringe) * (1 - release) + -90 * DEG * release;
  };

  const emit = (az0: number, el0: number, half: number, span: number, lift: number, curl: number, flyaway: boolean) => {
    const pts: THREE.Vector3[] = [];
    const halves: number[] = [];
    const normals: THREE.Vector3[] = [];
    const wander = rng.range(-spec.wander, spec.wander);
    const phase = rng.range(0, Math.PI * 2);
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const az = az0 + wander * t;
      const el = Math.max(floor(az, flyaway), Math.min(89 * DEG, el0 + span * t));
      const base = spec.volume(az, el);
      const grow = base * (0.55 + 0.55 * t) + lift * t * t +
        Math.sin(phase + t * spec.curlFreq * Math.PI) * curl * t;
      anchors.surface(az, el, grow, p);
      const q = p.clone();
      // Curl also swings sideways, otherwise a "curly" head is just a wavy one.
      // `curl` is in fitted units like `grow`, so it has to be scaled to metres.
      q.x += Math.cos(phase * 1.7 + t * spec.curlFreq * Math.PI * 0.8) * curl * 0.9 * t * metres;
      pts.push(q);
      halves.push(half * (1 - 0.45 * t) * (flyaway ? 0.22 : 1));
      normals.push(q.clone().sub(centre).normalize());
    }
    const a = Math.abs(wrapAz(az0)) / Math.PI;
    const templeGrey = Math.exp(-Math.pow((a - 0.26) / 0.15, 2)) * (1 - smoothstep(4 * DEG, 40 * DEG, el0 - spec.hairline(az0)));
    const grey = Math.min(1, spec.greyOverall + spec.greyTemple * templeGrey + rng.range(-0.08, 0.14));
    rb.add({ pts, half: halves, normal: normals, grey: Math.max(0, grey), repeat: flyaway ? 0.2 : 1 } as Guide);
  };

  for (let i = 0; i < spec.cards; i++) {
    const az = rng.range(-Math.PI, Math.PI);
    const line = spec.hairline(az);
    // Roots are spread over the whole scalp, biased toward the hairline where
    // the silhouette actually needs breaking up.
    const u = Math.pow(rng.next(), 1.5);
    const el = line + (86 * DEG - line) * u;
    emit(az, el, spec.cardHalf * rng.range(0.7, 1.3), spec.cardSpan * rng.range(0.6, 1.25),
      spec.lift * rng.range(0.5, 1.4), spec.curl * rng.range(0.5, 1.5), false);
  }
  for (let i = 0; i < spec.flyaways; i++) {
    const az = rng.range(-Math.PI, Math.PI);
    const line = spec.hairline(az);
    const el = line + (86 * DEG - line) * rng.next();
    emit(az, el, spec.cardHalf * 0.9, spec.cardSpan * rng.range(1.2, 2.0),
      spec.lift * rng.range(2.0, 4.5), spec.curl * rng.range(1.5, 3.0), true);
  }
  // Sideburns: short, dense, and they matter — they are where the hairline
  // meets the jaw and a head without them reads as a helmet.
  for (let i = 0; i < 60; i++) {
    const side = i < 30 ? 1 : -1;
    const az = side * rng.range(64 * DEG, 86 * DEG);
    const el = rng.range(spec.sideburn, spec.sideburn + 18 * DEG);
    emit(az, el, spec.cardHalf * 0.55, 14 * DEG, 0.002, 0.002, false);
  }

  return rb.build();
}

/* ------------------------------------------------------------------ */
/* Brows, lashes, beard                                                */
/* ------------------------------------------------------------------ */

export interface BrowSpec {
  /** Half-thickness of the brow mass, metres. */
  thickness: number;
  /** Positive tilts the outer end down — Bolojan's angled brows. */
  angle: number;
  /** How far the brow is dragged toward the nose, metres. */
  innerDrop: number;
  hairs: number;
  /** Extra length past the fitted brow curve. */
  extend: number;
  /**
   * How much lower the character's right brow sits than the left, metres.
   *
   * A matched pair of brows is a symmetry the face cannot recover from: it is
   * read as CG instantly, and on a face whose defining expression is a permanent
   * frown it also throws away the expression, because a real furrow is
   * lopsided — one corrugator pulls harder than the other. The reference's right
   * brow is visibly lower and more knotted than his left.
   */
  asymmetry?: number;
}

/**
 * Bolojan's. Heavy, dark, angled — his single most recognisable feature, and
 * the one the brief insists must be geometry rather than paint.
 *
 * At 0.0031 half-thickness the mass ribbons were 5 mm tall against a real
 * brow's 9-11, and 96 scattered hairs over 40 mm of arc left daylight between
 * them, so what rendered was a pencil line that the skin's own highlight then
 * washed out. This is the same shape, given the mass it needs to survive a key
 * light pointed straight at it.
 */
export const HEAVY_BROW: BrowSpec = { thickness: 0.0046, angle: 0.0062, innerDrop: 0.0026, hairs: 300, extend: 0.11, asymmetry: 0.0022 };
export const LEAN_BROW: BrowSpec = { thickness: 0.0021, angle: 0.0018, innerDrop: 0.0010, hairs: 68, extend: 0.06, asymmetry: 0.0008 };
export const SOFT_BROW: BrowSpec = { thickness: 0.0019, angle: 0.000, innerDrop: 0.0008, hairs: 62, extend: 0.05, asymmetry: 0.0006 };

function resample(curve: THREE.Vector3[], n: number, extend: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const m = curve.length - 1;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (1 + extend * 2) - extend;
    const f = Math.min(m - 1e-4, Math.max(0, t * m));
    const j = Math.floor(f);
    const k = f - j;
    const a = curve[Math.max(0, Math.min(m, j))];
    const b = curve[Math.max(0, Math.min(m, j + 1))];
    out.push(a.clone().lerp(b, k));
  }
  return out;
}

/**
 * Brows as real alpha geometry, layered: two broad ribbons for the mass and a
 * scatter of individual hairs over them. Bolojan's brows are heavy, dark and
 * angled and stay dark as the hair greys — painting them on the skin would lose
 * the one feature that identifies him instantly.
 */
export function buildBrows(anchors: HeadAnchors, spec: BrowSpec, seed: string): THREE.BufferGeometry | null {
  const rng = new Rng(seed);
  const rb = new RibbonBuilder();
  const centre = new THREE.Vector3(0, (anchors.chinY + anchors.crownY) * 0.5, -anchors.headDepth * 0.12);

  for (const [curve, side] of [[anchors.browL, -1], [anchors.browR, 1]] as Array<[THREE.Vector3[], number]>) {
    const line = resample(curve, 11, spec.extend);
    // The fitted brow curve is the upper edge of the hair, so drop it onto the
    // ridge and tilt the outer end.
    const shaped = line.map((p, i) => {
      const t = i / (line.length - 1);
      const q = p.clone();
      const n = q.clone().sub(centre).normalize();
      q.addScaledVector(n, 0.0022);
      q.y -= spec.innerDrop * (1 - t) + spec.angle * t * t;
      /* The lopsided set. `side` is +1 for the character's right, and the pull
       * is weighted toward the inner end because that is where a corrugator
       * acts — a brow lowered bodily reads as a droop, a brow knotted at its
       * head reads as a frown. */
      const asym = spec.asymmetry ?? 0;
      if (asym !== 0) q.y -= (side > 0 ? asym : -asym * 0.35) * (0.45 + 0.55 * (1 - t));
      return q;
    });

    // Three stacked ribbons rather than two: with two, the alpha test punched
    // holes clean through the mass wherever the strand texture's gaps lined up.
    for (let layer = 0; layer < 3; layer++) {
      const pts = shaped.map((p, i) => {
        const t = i / (shaped.length - 1);
        return p.clone().add(new THREE.Vector3(0, -spec.thickness * (layer * 0.62 - 0.28) * (0.6 + t * 0.6), 0));
      });
      rb.add({
        pts,
        half: pts.map((_, i) => {
          const t = i / (pts.length - 1);
          return spec.thickness * (0.55 + 1.05 * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.9 + 0.05))));
        }),
        normal: pts.map((p) => p.clone().sub(centre).normalize()),
        grey: 0,
        // The strand texture carries 22 columns per tile. At repeat 3 that is
        // 66 strands across a 4.6 mm ribbon — 0.07 mm each, an order of
        // magnitude under a pixel at this range — so the alpha test dissolved
        // them into a uniform grey haze and the heaviest brows in the cast
        // rendered as a pencil smudge. One strand has to be worth about half a
        // millimetre for the mass to read as hair.
        repeat: 0.5,
      });
    }

    // Individual hairs, angled outward along the brow, denser at the head.
    for (let i = 0; i < spec.hairs; i++) {
      const t = Math.pow(rng.next(), 0.7);
      const f = Math.min(shaped.length - 1.001, t * (shaped.length - 1));
      const j = Math.floor(f);
      const p0 = shaped[j].clone().lerp(shaped[j + 1], f - j);
      const dir = shaped[Math.min(shaped.length - 1, j + 1)].clone().sub(shaped[Math.max(0, j - 1)]).normalize();
      const n = p0.clone().sub(centre).normalize();
      const up = new THREE.Vector3(0, 1, 0);
      const len = spec.thickness * rng.range(2.4, 5.0);
      const tip = p0.clone()
        .addScaledVector(dir, side * len * rng.range(0.3, 1.0) * -1)
        .addScaledVector(up, len * rng.range(0.25, 0.9) * (1 - t * 0.8))
        .addScaledVector(n, len * 0.25);
      const mid = p0.clone().lerp(tip, 0.5).addScaledVector(n, len * 0.15);
      p0.addScaledVector(n, 0.0006);
      p0.y -= spec.thickness * rng.range(-0.6, 0.9);
      rb.add({
        pts: [p0, mid, tip],
        half: [spec.thickness * 0.16, spec.thickness * 0.13, spec.thickness * 0.05],
        normal: [n, n, n],
        grey: rng.bool(0.10) ? rng.range(0.3, 0.8) : 0,
        repeat: 0.25,
      });
    }
  }
  return rb.build();
}

/** Lashes: short dark alpha strips along the upper lid, plus a sparse lower set. */
export function buildLashes(anchors: HeadAnchors, seed: string): THREE.BufferGeometry | null {
  const rng = new Rng(seed);
  const rb = new RibbonBuilder();
  const centre = new THREE.Vector3(0, (anchors.chinY + anchors.crownY) * 0.5, -anchors.headDepth * 0.12);

  for (const eye of [anchors.eyeL, anchors.eyeR]) {
    const ring = eye.ring;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const out = p.clone().sub(eye.centre).normalize();
      const upper = out.y > -0.15;
      const count = upper ? 4 : 2;
      for (let k = 0; k < count; k++) {
        const root = p.clone().addScaledVector(out, 0.0004);
        const len = (upper ? 0.0042 : 0.0022) * rng.range(0.7, 1.35);
        const dir = out.clone().multiplyScalar(0.55);
        dir.y += upper ? 0.75 : -0.55;
        dir.z += 0.45;
        dir.normalize();
        const tip = root.clone().addScaledVector(dir, len);
        const n = root.clone().sub(centre).normalize();
        rb.add({
          pts: [root, root.clone().lerp(tip, 0.55), tip],
          half: [0.00055, 0.00042, 0.00016],
          normal: [n, n, n],
          grey: 0,
          repeat: 0.2,
        });
      }
    }
  }
  return rb.build();
}

export interface BeardSpec {
  /** 0..1 coverage. */
  density: number;
  /** Card length in metres. */
  length: number;
  /** 0..1 grey mix — the hero's beard is much greyer than his hair. */
  grey: number;
}

/**
 * The beard's upper boundary, elevation as a function of azimuth.
 *
 * Shared with the albedo layer in `headMesh.ts`, which paints the shadow the
 * beard casts into the skin underneath it. When the two disagree the stubble
 * tone and the cards land on different parts of the jaw and the beard reads as
 * a smudge with hairs near it — which is what it was doing.
 *
 * The previous curve ran from -43 degrees at the chin to -16 at the ear, and
 * -43 degrees is BELOW the lower lip: the "beard" was a patch on the point of
 * the chin and nothing else, which is the whole of "patchy stubble". A trimmed
 * beard reaches well up the cheek. It still has to dip hard at the front, since
 * at zero azimuth this elevation band is the mouth.
 */
export function BEARD_TOP(az: number): number {
  const a = Math.abs(wrapAz(az)) / (78 * DEG);
  /* The upper boundary on the cheek was -21 degrees of elevation at the side,
   * which puts it level with the base of the nose — a FULL beard, and the
   * reference's is trimmed: it sits well below the cheekbone, roughly level with
   * the mouth corner, and the mass is carried on the chin and the moustache
   * rather than up the face.
   *
   * -29 was too far. The beard's visible mass is mostly the albedo band painted
   * under the cards, not the cards themselves, so lowering the boundary lowers
   * the MASS with it, and at -29 the cheek went bare all the way down to the
   * mouth corner and the beard stopped reading as a beard at all. -25 takes
   * about 11 mm off the cheek and still meets the moustache at the corner, which
   * is the shape the reference has. The moustache and the soul patch are emitted
   * separately below and are unaffected either way; the chin keeps its weight
   * because the curve near az = 0 is unchanged. */
  return (-40 + 15 * smoothstep(0.18, 0.78, a)) * DEG;
}

/**
 * A short, well-trimmed beard as geometry rather than paint. The albedo layer in
 * `headMesh.ts` already carries the stubble shadow; this is the part that
 * breaks the jaw's silhouette and catches the key light.
 */
export function buildBeard(anchors: HeadAnchors, spec: BeardSpec, seed: string): THREE.BufferGeometry | null {
  if (spec.density <= 0.02) return null;
  const rng = new Rng(seed);
  const rb = new RibbonBuilder();
  const centre = new THREE.Vector3(0, (anchors.chinY + anchors.crownY) * 0.5, -anchors.headDepth * 0.12);
  const p = new THREE.Vector3();

  const beardTop = BEARD_TOP;
  const beardBottom = (az: number): number => {
    const a = Math.abs(az) / (78 * DEG);
    return (-60 + 14 * smoothstep(0.3, 1.0, a)) * DEG;
  };

  const emit = (az: number, el: number, len: number, grey: number, half: number): void => {
    anchors.surface(az, el, 0.004, p);
    const n = p.clone().sub(centre).normalize();
    const dir = n.clone().multiplyScalar(0.5);
    dir.y -= 0.85;
    dir.normalize();
    const tip = p.clone().addScaledVector(dir, len).addScaledVector(n, len * 0.22);
    const mid = p.clone().lerp(tip, 0.5).addScaledVector(n, len * 0.16);
    rb.add({
      pts: [p.clone(), mid, tip],
      half: [half, half * 0.78, half * 0.28],
      normal: [n, n, n],
      grey: Math.max(0, Math.min(1, grey)),
      // Same sub-pixel-strand problem as the brows, at a smaller scale.
      repeat: 0.25,
    });
  };

  /* WHY THE COUNTS ARE WHAT THEY ARE.
   *
   * A trimmed beard is a CONTINUOUS mass with a hard edge along its upper
   * boundary. Cards that do not overlap render as a scatter of specks, and
   * every previous pass at this — 340 cards, then 2200 — was still below the
   * overlap threshold. At 0.85 mm half-width a card covers about 1.7 mm of
   * jaw; the beard region is roughly 90 x 45 mm of surface, so continuous
   * coverage at one layer needs order 1500 cards and a mass that survives the
   * alpha test needs three layers of that. The cards are also wider now, which
   * buys coverage far more cheaply than count does.
   *
   * The distribution is stratified in azimuth rather than uniformly random, so
   * no band is left bald by chance — with 44 bands and uniform sampling the
   * emptiest band routinely came out at half the mean. */
  const count = Math.round(6200 * spec.density);
  const AZ_BANDS = 56;
  for (let i = 0; i < count; i++) {
    const band = i % AZ_BANDS;
    const az = (-80 + (band + rng.next()) * (160 / AZ_BANDS)) * DEG;
    const top = beardTop(az);
    const bot = beardBottom(az);
    // Bias toward the top of the band so the mass is densest just under the
    // jawline edge, which is where a trimmed beard actually is.
    const el = bot + (top - bot) * Math.pow(rng.next(), 0.6);
    emit(az, el, spec.length * rng.range(0.7, 1.25), spec.grey + rng.range(-0.20, 0.26), 0.00125);
  }

  /* Moustache: a separate patch above the lip, never on it, and connected to
   * the beard at the corners of the mouth — an unconnected moustache is the
   * loudest thing wrong with a CG beard. */
  const stache = Math.round(1700 * spec.density);
  for (let i = 0; i < stache; i++) {
    const az = rng.range(-27 * DEG, 27 * DEG);
    if (Math.abs(az) < 2.0 * DEG && rng.bool(0.5)) continue;   // the philtrum groove
    // The band drops away from the septum toward the mouth corners, following
    // the lip, so the moustache meets the beard rather than floating over it.
    const drop = Math.pow(Math.abs(az) / (27 * DEG), 1.6) * 5 * DEG;
    const el = rng.range(-24.5 * DEG, -19.0 * DEG) - drop;
    /* Cards hang DOWNWARD from their root, so a moustache rooted level with the
     * upper vermilion drapes its full length straight over the mouth — which is
     * why the front view had no mouth at all. The band is raised to clear the
     * lip and the cards are shortened to two thirds, which is also what a
     * trimmed moustache is: shorter than the beard, not the same length. */
    emit(az, el, spec.length * rng.range(0.42, 0.72), spec.grey + rng.range(-0.18, 0.28), 0.00105);
  }

  /* A soul patch under the lower lip, which is where a trimmed beard is
   * heaviest and what makes the chin read as bearded rather than shaded. */
  const patch = Math.round(1400 * spec.density);
  for (let i = 0; i < patch; i++) {
    const az = rng.range(-21 * DEG, 21 * DEG);
    const el = rng.range(-47 * DEG, -37 * DEG);
    emit(az, el, spec.length * rng.range(0.7, 1.3), spec.grey + rng.range(-0.22, 0.32), 0.00125);
  }

  return rb.build();
}
