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
  hairline: hairlineFn(37 * DEG, 46 * DEG, 6 * DEG, -18 * DEG),
  volume: (az, el) => {
    const a = Math.abs(wrapAz(az)) / Math.PI;
    // Close at the sides, a little more on top — a real short back and sides.
    const top = smoothstep(30 * DEG, 70 * DEG, el);
    return 0.016 + 0.030 * top * (1 - 0.45 * smoothstep(0.25, 0.6, a) * (1 - top));
  },
  cards: 240,
  cardSpan: 26 * DEG,
  cardHalf: 0.0042,
  wander: 9 * DEG,
  curl: 0.006,
  curlFreq: 2.2,
  lift: 0.008,
  flyaways: 46,
  greyTemple: 0.40,
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
  cards: 420,
  cardSpan: 34 * DEG,
  cardHalf: 0.0046,
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
  cards: 300,
  cardSpan: 32 * DEG,
  cardHalf: 0.0044,
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

  const emit = (az0: number, el0: number, half: number, span: number, lift: number, curl: number, flyaway: boolean) => {
    const pts: THREE.Vector3[] = [];
    const halves: number[] = [];
    const normals: THREE.Vector3[] = [];
    const wander = rng.range(-spec.wander, spec.wander);
    const phase = rng.range(0, Math.PI * 2);
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      const az = az0 + wander * t;
      const el = Math.min(89 * DEG, el0 + span * t);
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
}

export const HEAVY_BROW: BrowSpec = { thickness: 0.0031, angle: 0.0055, innerDrop: 0.0022, hairs: 96, extend: 0.10 };
export const LEAN_BROW: BrowSpec = { thickness: 0.0021, angle: 0.0018, innerDrop: 0.0010, hairs: 68, extend: 0.06 };
export const SOFT_BROW: BrowSpec = { thickness: 0.0019, angle: 0.000, innerDrop: 0.0008, hairs: 62, extend: 0.05 };

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
      return q;
    });

    for (let layer = 0; layer < 2; layer++) {
      const pts = shaped.map((p, i) => {
        const t = i / (shaped.length - 1);
        return p.clone().add(new THREE.Vector3(0, -spec.thickness * (layer * 0.75 - 0.1) * (0.6 + t * 0.6), 0));
      });
      rb.add({
        pts,
        half: pts.map((_, i) => {
          const t = i / (pts.length - 1);
          return spec.thickness * (0.55 + 1.05 * Math.sin(Math.PI * Math.min(1, Math.max(0, t * 0.9 + 0.05))));
        }),
        normal: pts.map((p) => p.clone().sub(centre).normalize()),
        grey: 0,
        repeat: 3,
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

  /* The beard line is not a band of constant height: it runs low across the
   * chin, climbs the jaw, and meets the sideburn in front of the ear. Spraying
   * it evenly over an elevation range buries the mouth and the base of the nose,
   * which is exactly what kills the middle of the face. */
  const beardTop = (az: number): number => {
    const a = Math.abs(az) / (72 * DEG);
    // Trimmed, not a ruff: the cheeks stay bare well past the mouth corner and
    // the line only climbs to meet the sideburn in front of the ear.
    return (-43 + 27 * smoothstep(0.38, 1.0, a)) * DEG;
  };
  const beardBottom = (az: number): number => {
    const a = Math.abs(az) / (72 * DEG);
    return (-60 + 14 * smoothstep(0.3, 1.0, a)) * DEG;
  };

  const emit = (az: number, el: number, len: number, grey: number): void => {
    anchors.surface(az, el, 0.004, p);
    const n = p.clone().sub(centre).normalize();
    const dir = n.clone().multiplyScalar(0.5);
    dir.y -= 0.85;
    dir.normalize();
    const tip = p.clone().addScaledVector(dir, len).addScaledVector(n, len * 0.22);
    const mid = p.clone().lerp(tip, 0.5).addScaledVector(n, len * 0.16);
    rb.add({
      pts: [p.clone(), mid, tip],
      half: [0.0016, 0.0012, 0.0004],
      normal: [n, n, n],
      grey: Math.max(0, Math.min(1, grey)),
      repeat: 0.6,
    });
  };

  const count = Math.round(340 * spec.density);
  for (let i = 0; i < count; i++) {
    const az = rng.range(-76 * DEG, 76 * DEG);
    const top = beardTop(az);
    const bot = beardBottom(az);
    const el = bot + (top - bot) * Math.pow(rng.next(), 0.75);
    emit(az, el, spec.length * rng.range(0.55, 1.35), spec.grey + rng.range(-0.22, 0.30));
  }

  /* Moustache: a separate patch above the lip, never on it. */
  const stache = Math.round(90 * spec.density);
  for (let i = 0; i < stache; i++) {
    const az = rng.range(-22 * DEG, 22 * DEG);
    if (Math.abs(az) < 2.5 * DEG && rng.bool(0.6)) continue;   // the philtrum groove
    const el = rng.range(-25.5 * DEG, -21.0 * DEG);
    emit(az, el, spec.length * rng.range(0.5, 1.0), spec.grey + rng.range(-0.15, 0.25));
  }

  /* A soul patch under the lower lip, which is where a trimmed beard is
   * heaviest and what makes the chin read as bearded rather than shaded. */
  const patch = Math.round(70 * spec.density);
  for (let i = 0; i < patch; i++) {
    const az = rng.range(-18 * DEG, 18 * DEG);
    const el = rng.range(-46 * DEG, -38 * DEG);
    emit(az, el, spec.length * rng.range(0.7, 1.3), spec.grey + rng.range(-0.2, 0.3));
  }

  return rb.build();
}
