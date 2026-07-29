/**
 * THE BOOTSTRAPPED DACIA 1300.
 *
 * A real 1970s three-box saloon built entirely from code: lofted lower body
 * with pressed wheel arches, upright greenhouse on slim pillars, round twin
 * headlights in chrome bezels, chrome bumpers/grille/window trim, small steel
 * wheels with hubcaps — then wrecked: mismatched purple panels over the yellow,
 * rust blooms, dents, a taped-on front bumper, sticker decals and filthy glass.
 *
 * Local frame: +Z forward, +X right, origin at the rigid body centre.
 * `GROUND` is the ground plane in that frame.
 */

import * as THREE from 'three';
import { GeoBuilder, T, type LightWeights, type Surf } from './builder';
import { UV } from './texture';
import { Palette } from '../artDirection';
import { Rng } from '../core/rng';
import type { BodyBuild } from './bodies';

const lin = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();

/* ---------------- shared palette ---------------- */

export const CHROME = lin(0xd9dfee);
export const CHROME_DULL = lin(0x9aa0b2);
export const BLACK_TRIM = lin(0x14141a);
export const RUBBER = lin(0x0f0f13);
export const LENS_RED = lin(0xd8122a);
export const LENS_AMBER = lin(0xff9a20);
export const LENS_CLEAR = lin(0xe8eef6);
export const LAMP_WHITE = lin(0xfff3d8);
export const GLASS = lin(0x2c3550);
export const INTERIOR_DARK = lin(0x3a2f44);

/* ---------------- emissive channel presets ---------------- */

export const L = {
  none: [0, 0, 0, 0, 0, 0, 0, 0] as LightWeights,
  head: [1, 0, 0, 0, 0, 0, 0, 0] as LightWeights,
  tail: [0, 1, 0.9, 0, 0, 0, 0, 0] as LightWeights,
  brake: [0, 0.2, 1, 0, 0, 0, 0, 0] as LightWeights,
  reverse: [0, 0, 0, 1, 0, 0, 0, 0] as LightWeights,
  indL: [0, 0, 0, 0, 1, 0, 0, 0] as LightWeights,
  indR: [0, 0, 0, 0, 0, 1, 0, 0] as LightWeights,
  cabin: [0, 0, 0, 0, 0, 0, 1, 0] as LightWeights,
  aux: [0, 0, 0, 0, 0, 0, 0, 1] as LightWeights,
} as const;

/* ---------------- dimensions ---------------- */

export const DACIA = {
  length: 4.35,
  width: 1.64,
  height: 1.44,
  frontAxleZ: 1.32,
  rearAxleZ: -1.12,
  wheelRadius: 0.30,
  tyreWidth: 0.175,
  trackHalf: 0.665,
  /** Body origin above the ground plane at rest. */
  rideHeight: 0.62,
} as const;

const G = -DACIA.rideHeight; // ground plane in local space
const y = (aboveGround: number) => G + aboveGround;

const NOSE = 2.17;
const TAIL = -2.18;
const BELT = 0.90;
const ROOF = 1.435;
const SILL = 0.235;
const HW = 0.82;

/* ---------------- paint schemes ---------------- */

export interface DaciaScheme {
  base: THREE.Color;
  alt: THREE.Color;
  faded: THREE.Color;
  /** 0..1 — how wrecked. Drives dents, rust decals and tape. */
  wear: number;
  interior: THREE.Color;
}

export function heroScheme(): DaciaScheme {
  return {
    base: Palette.daciaYellow.clone().offsetHSL(0.005, 0.20, 0.03),
    alt: Palette.daciaPurple.clone().offsetHSL(0.01, 0.16, 0.045),
    faded: Palette.daciaYellow.clone().lerp(lin(0x9a8f60), 0.35),
    wear: 1,
    interior: lin(0x6d5540),
  };
}

/**
 * Communist-era Dacia colours, and deliberately spread right across the hue
 * wheel. A street full of cars that all sit in the same 20 degrees of muddy
 * red is the single loudest "procedurally generated" tell there is.
 */
const TRAFFIC_SCHEMES: Array<[number, number, number]> = [
  [0xd8d4c8, 0xa9a496, 0x2c2a26], // ivory white
  [0x2f6fb0, 0x24578a, 0x1c2430], // bright ministry blue
  [0xc23a2a, 0x93291d, 0x2a1e1c], // signal red
  [0x3f8a52, 0x2e6a3d, 0x1e2420], // dacia green
  [0xe0b62c, 0xb08e1e, 0x2e2820], // taxi ochre
  [0x9a5ba8, 0x764585, 0x241c2a], // faded lilac
  [0x2fa9a0, 0x22807a, 0x1a2626], // turquoise
  [0xb8b3a8, 0x8c877c, 0x2a2730], // dusty beige
  [0x6d7f92, 0x54637a, 0x22262e], // pale blue-grey
  [0xe2762c, 0xb15920, 0x2e2318], // orange
  [0x8a2f52, 0x69223c, 0x281a20], // maroon
  [0x4a5566, 0x37404e, 0x1e2228], // slate
];

export function trafficScheme(rng: Rng): DaciaScheme {
  const [a, b, c] = rng.pick(TRAFFIC_SCHEMES);
  return {
    base: lin(a),
    alt: lin(b),
    faded: lin(a).lerp(lin(0x7a7568), 0.3),
    wear: rng.range(0.15, 0.55),
    interior: lin(c),
  };
}

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

/** Wheel-arch top line, in ground-relative metres. */
function archY(z: number): number {
  let best = SILL;
  for (const [ax, r] of [[DACIA.frontAxleZ, 0.46], [DACIA.rearAxleZ, 0.46]] as const) {
    const dz = z - ax;
    if (Math.abs(dz) < r) {
      const cy = 0.235;
      const v = cy + Math.sqrt(Math.max(0, r * r - dz * dz)) * 0.98;
      if (v > best) best = v;
    }
  }
  return Math.min(best, 0.70);
}

function bodyHalfWidth(z: number): number {
  let hw = HW;
  if (z > 1.86) hw -= (z - 1.86) * 0.5;
  if (z < -1.9) hw -= (-1.9 - z) * 0.38;
  // Blistered arches.
  for (const ax of [DACIA.frontAxleZ, DACIA.rearAxleZ]) {
    const t = Math.max(0, 1 - Math.abs(z - ax) / 0.55);
    hw += 0.016 * t * t;
  }
  return hw;
}

function bodyTopY(z: number): number {
  if (z > 2.02) return 0.905 - (z - 2.02) * 0.62;      // rounded nose
  if (z > 0.9) return 0.905 - (z - 0.9) * 0.022;        // bonnet, slight rake
  if (z > -1.5) return 0.90;                            // cowl / cabin base
  if (z > -2.02) return 0.905 + (-1.5 - z) * 0.055;     // boot lid rises
  return 0.933 - (-2.02 - z) * 0.55;                    // rounded tail
}

function bodyStations(): Array<{ z: number; hw: number; yTop: number; yBottom: number; rTop: number; rBottom: number }> {
  const zs: number[] = [];
  const push = (a: number, b: number, n: number) => {
    for (let i = 0; i <= n; i++) zs.push(a + ((b - a) * i) / n);
  };
  push(TAIL, -2.02, 2);
  push(-2.02, -1.6, 2);
  push(-1.6, -0.66, 4);
  push(-0.66, 0.86, 5);
  push(0.86, 1.86, 5);
  push(1.86, NOSE, 3);
  // de-dup + sort
  const uniq = Array.from(new Set(zs.map((v) => Math.round(v * 1000) / 1000))).sort((a, b) => a - b);
  return uniq.map((z) => ({
    z,
    hw: bodyHalfWidth(z),
    yTop: y(bodyTopY(z)),
    yBottom: y(archY(z)),
    rTop: 0.085,
    rBottom: 0.05,
  }));
}

/** Panel-level paint: this is where the mismatched purple doors come from. */
function paintFn(s: DaciaScheme, hero: boolean) {
  const base = s.base, alt = s.alt, faded = s.faded;
  return (x: number, yy: number, z: number, out: THREE.Color): void => {
    const h = yy - G;
    if (!hero) {
      out.copy(h > BELT - 0.02 && z < 0.9 && z > -1.5 ? faded : base);
      return;
    }
    // Donor rear doors and rear quarters — the mismatched purple panels.
    if (z < -0.14 && z > -1.66) { out.copy(alt); return; }
    // Boot lid + rear panel.
    if (z < -1.5) { out.copy(alt); return; }
    // Left front wing: a second, greyer donor panel.
    if (x < -0.2 && z > 0.72 && z < 1.86) { out.copy(faded); return; }
    // Sun-bleached bonnet and roof.
    if (h > BELT - 0.03 && z > 0.9) { out.copy(faded); return; }
    out.copy(base);
  };
}

/* ------------------------------------------------------------------ */
/* Main builder                                                        */
/* ------------------------------------------------------------------ */

export function buildDacia(scheme: DaciaScheme, rng: Rng, hero: boolean): BodyBuild {
  const shell = new GeoBuilder();
  const glass = new GeoBuilder();

  const paint = paintFn(scheme, hero);
  // Lacquered paint is a dielectric with a very sharp coat on top: low base
  // roughness, ZERO metalness, full clearcoat. Metalness on paint is what was
  // killing the sun lobe — a metal surface has no diffuse and its specular is
  // tinted by the albedo, so the highlight vanished into the yellow.
  const bodySurf: Surf = {
    colorFn: paint,
    rough: 0.30,
    metal: 0,
    coat: 1,
    uv: hero ? UV.bodyBattered : UV.bodyClean,
  };
  const chrome: Surf = { color: CHROME, rough: 0.075, metal: 1, coat: 0.35 };
  const chromeDull: Surf = { color: CHROME_DULL, rough: 0.20, metal: 0.95, coat: 0.25 };
  const trim: Surf = { color: BLACK_TRIM, rough: 0.60, metal: 0.10, coat: 0.30 };
  const rubber: Surf = { color: RUBBER, rough: 0.92, metal: 0.02, coat: 0 };

  /* ---- lower body ---- */
  shell.loft(bodyStations(), bodySurf, { vScale: 1 });

  /* ---- underbody floor so you never see inside the shell ---- */
  shell.box(1.5, 0.06, 3.6, T(0, y(0.22), -0.1), { color: lin(0x121016), rough: 0.95, metal: 0.05 });

  /* ---- greenhouse ---- */
  buildGreenhouse(shell, glass, scheme, hero, chrome, trim);

  /* ---- interior ---- */
  buildInterior(shell, scheme);

  /* ---- front end ---- */
  buildFrontEnd(shell, chrome, chromeDull, trim, rubber, hero);

  /* ---- rear end ---- */
  buildRearEnd(shell, chrome, chromeDull, trim, hero);

  /* ---- side detail ---- */
  buildSides(shell, chrome, trim, rubber, scheme, hero);

  /* ---- decals ---- */
  if (hero) buildDecals(shell, rng);

  const shellGeo = shell.build();
  const glassGeo = glass.build();

  return {
    shell: shellGeo,
    glass: glassGeo,
    anchors: {
      headlights: [new THREE.Vector3(-0.5, y(0.665), NOSE - 0.02), new THREE.Vector3(0.5, y(0.665), NOSE - 0.02)],
      taillights: [new THREE.Vector3(-0.58, y(0.78), TAIL + 0.02), new THREE.Vector3(0.58, y(0.78), TAIL + 0.02)],
      exhaust: [new THREE.Vector3(-0.42, y(0.22), TAIL - 0.03)],
      interior: new THREE.Vector3(0, y(1.05), -0.2),
    },
  };
}

/* ---------------- greenhouse ---------------- */

function buildGreenhouse(
  b: GeoBuilder, g: GeoBuilder, s: DaciaScheme, hero: boolean, chrome: Surf, trim: Surf,
): void {
  const paint = paintFn(s, hero);
  const pillarSurf: Surf = { colorFn: paint, rough: 0.30, metal: 0, coat: 1, uv: hero ? UV.bodyBattered : UV.bodyClean };
  const roofSurf: Surf = { colorFn: paint, rough: 0.30, metal: 0, coat: 1, uv: hero ? UV.bodyBattered : UV.bodyClean };
  const glassSurf: Surf = { color: GLASS, rough: 0.045, metal: 0, coat: 0, uv: UV.glassGrime };

  /* Greenhouse plan. Everything below is derived from these five numbers, so
   * the pillars, rails, roof and glass can never disagree with each other. */
  const wsBase = 0.955, wsTop = 0.600;   // windscreen z at the scuttle / at the roof
  const rsBase = -1.525, rsTop = -1.265; // rear screen
  const bZ = -0.17;                      // B pillar
  const GTOP = ROOF - 0.075;             // where the pillars meet the roof rail
  const GLASS_TOP = ROOF - 0.105;        // top edge of the glass
  const GLASS_BOT = BELT + 0.050;        // bottom edge of the glass
  /** Half width of the greenhouse at the roof rail and at the belt. */
  const hwTop = 0.706, hwBelt = 0.772;
  const gx = 0.742;                      // side glass plane — inboard of the pillars

  const V = (x: number, yy: number, z: number) => new THREE.Vector3(x, y(yy), z);

  /* ---- roof panel, slightly crowned, with the drip rail built in ---- */
  const roofStations = [
    { z: rsTop - 0.03, hw: hwTop - 0.045, yTop: y(ROOF - 0.022), yBottom: y(ROOF - 0.125), rTop: 0.055, rBottom: 0.03 },
    { z: -0.90, hw: hwTop, yTop: y(ROOF - 0.002), yBottom: y(ROOF - 0.125), rTop: 0.06, rBottom: 0.03 },
    { z: -0.15, hw: hwTop + 0.012, yTop: y(ROOF + 0.004), yBottom: y(ROOF - 0.125), rTop: 0.06, rBottom: 0.03 },
    { z: 0.32, hw: hwTop, yTop: y(ROOF - 0.002), yBottom: y(ROOF - 0.125), rTop: 0.06, rBottom: 0.03 },
    { z: wsTop + 0.03, hw: hwTop - 0.045, yTop: y(ROOF - 0.022), yBottom: y(ROOF - 0.125), rTop: 0.055, rBottom: 0.03 },
  ];
  b.loft(roofStations, roofSurf);

  /*
   * Pillars. `strut` derives the orientation from the two endpoints, so an
   * A-pillar that runs from the scuttle back and up to the roof rail can only
   * ever lean backwards. The previous hand-rolled Euler had the sign inverted,
   * which threw both pillars forward and X-braced them across the door glass.
   */
  for (const sx of [-1, 1]) {
    // A pillar: scuttle → roof rail, leaning back.
    b.strut(V(sx * (hwBelt - 0.030), BELT - 0.02, wsBase), V(sx * (hwTop - 0.010), GTOP, wsTop), 0.045, 0.082, pillarSurf);
    // B pillar: dead upright, the thickest of the three.
    b.strut(V(sx * hwBelt, BELT - 0.03, bZ), V(sx * (hwTop + 0.006), GTOP, bZ), 0.048, 0.098, pillarSurf);
    // C pillar: boot → roof rail, leaning forward. Wide, as on the real car.
    b.strut(V(sx * (hwBelt - 0.012), BELT - 0.02, rsBase), V(sx * (hwTop - 0.020), GTOP, rsTop), 0.045, 0.175, pillarSurf);
  }

  /* header rail along the top of the side glass, tying the pillars together */
  for (const sx of [-1, 1]) {
    b.strut(V(sx * (hwTop + 0.004), GTOP - 0.012, wsTop - 0.02), V(sx * (hwTop + 0.004), GTOP - 0.012, rsTop + 0.02), 0.052, 0.052, pillarSurf);
    // belt rail below the side glass — the top of the door skin
    b.strut(V(sx * hwBelt, BELT + 0.012, wsBase - 0.03), V(sx * hwBelt, BELT + 0.012, rsBase + 0.03), 0.056, 0.062, pillarSurf);
    // rain gutter along the roof edge
    b.strut(V(sx * (hwTop + 0.020), ROOF - 0.052, rsTop - 0.02), V(sx * (hwTop + 0.020), ROOF - 0.052, wsTop + 0.02), 0.028, 0.028, trim);
  }

  /* chrome window surrounds — a bright frame is what makes an aperture read
   * as a glazed window rather than a hole */
  for (const sx of [-1, 1]) {
    // belt-line brightwork and header brightwork
    b.strut(V(sx * (hwBelt + 0.020), BELT + 0.042, wsBase - 0.05), V(sx * (hwBelt + 0.020), BELT + 0.042, rsBase + 0.05), 0.020, 0.026, chrome);
    b.strut(V(sx * (hwTop + 0.022), GTOP - 0.030, wsTop + 0.01), V(sx * (hwTop + 0.022), GTOP - 0.030, rsTop - 0.01), 0.020, 0.024, chrome);
    // vertical chrome down the B pillar and the leading edge of the A pillar
    b.strut(V(sx * (hwBelt + 0.012), BELT + 0.03, bZ), V(sx * (hwTop + 0.020), GTOP - 0.03, bZ), 0.022, 0.024, chrome);
    b.strut(V(sx * (hwBelt - 0.022), BELT + 0.02, wsBase + 0.012), V(sx * (hwTop - 0.004), GTOP - 0.02, wsTop + 0.012), 0.022, 0.024, chrome);
    b.strut(V(sx * (hwBelt - 0.006), BELT + 0.02, rsBase - 0.012), V(sx * (hwTop - 0.014), GTOP - 0.02, rsTop - 0.012), 0.022, 0.024, chrome);
  }
  // windscreen and backlight surrounds, across the car
  b.strut(V(-0.64, BELT + 0.028, wsBase + 0.012), V(0.64, BELT + 0.028, wsBase + 0.012), 0.024, 0.026, chrome);
  b.strut(V(-0.60, GTOP - 0.022, wsTop + 0.012), V(0.60, GTOP - 0.022, wsTop + 0.012), 0.024, 0.026, chrome);
  b.strut(V(-0.655, BELT + 0.028, rsBase - 0.012), V(0.655, BELT + 0.028, rsBase - 0.012), 0.024, 0.026, chrome);
  b.strut(V(-0.615, GTOP - 0.022, rsTop - 0.012), V(0.615, GTOP - 0.022, rsTop - 0.012), 0.024, 0.026, chrome);

  /* ---- glass ---- */
  // Windscreen — one pane, wound so the outward face points forward.
  g.quad(
    V(-0.618, GLASS_BOT, wsBase), V(0.618, GLASS_BOT, wsBase),
    V(0.585, GLASS_TOP, wsTop), V(-0.585, GLASS_TOP, wsTop), glassSurf,
  );
  // Rear screen.
  g.quad(
    V(0.636, GLASS_BOT, rsBase), V(-0.636, GLASS_BOT, rsBase),
    V(-0.596, GLASS_TOP, rsTop), V(0.596, GLASS_TOP, rsTop), glassSurf,
  );
  // Side glass: front door and rear door, each side, sitting just inboard of
  // the pillars so the pillars visibly frame them.
  for (const sx of [-1, 1]) {
    const x = sx * gx;
    const front = [
      V(x, GLASS_BOT, bZ - 0.030), V(x, GLASS_BOT, wsBase - 0.055),
      V(x, GLASS_TOP, wsTop + 0.055), V(x, GLASS_TOP, bZ - 0.030),
    ] as const;
    const rear = [
      V(x, GLASS_BOT, rsBase + 0.060), V(x, GLASS_BOT, bZ + 0.030),
      V(x, GLASS_TOP, bZ + 0.030), V(x, GLASS_TOP, rsTop + 0.030),
    ] as const;
    if (sx > 0) {
      g.quad(front[0], front[1], front[2], front[3], glassSurf);
      g.quad(rear[0], rear[1], rear[2], rear[3], glassSurf);
    } else {
      g.quad(front[3], front[2], front[1], front[0], glassSurf);
      g.quad(rear[3], rear[2], rear[1], rear[0], glassSurf);
    }
    // quarter-light divider in the front door, a 1300 signature
    b.strut(V(sx * (gx + 0.020), GLASS_BOT - 0.01, wsBase - 0.30), V(sx * (gx + 0.020), GLASS_TOP + 0.01, wsTop + 0.30), 0.018, 0.022, chrome);
  }

  /* wipers + mirror */
  for (const wx of [-0.30, 0.22]) {
    b.box(0.016, 0.012, 0.44, T(wx, y(BELT + 0.055), wsBase - 0.16, -0.35, 0.22, 0), { color: BLACK_TRIM, rough: 0.55, metal: 0.2, coat: 0.2 });
  }
  b.box(0.055, 0.07, 0.11, T(-0.755, y(BELT + 0.13), 0.70), { color: CHROME_DULL, rough: 0.16, metal: 0.95, coat: 0.4 });
  b.box(0.02, 0.05, 0.055, T(-0.80, y(BELT + 0.13), 0.70), { color: lin(0x9fb3d0), rough: 0.04, metal: 1, coat: 0.6 });
}

/* ---------------- interior ---------------- */

function buildInterior(b: GeoBuilder, s: DaciaScheme): void {
  const seatSurf: Surf = { color: s.interior, rough: 0.82, metal: 0.02, uv: UV.fabric };
  const dashSurf: Surf = { color: lin(0x4a3d52), rough: 0.7, metal: 0.05, uv: UV.dash };
  const carpet: Surf = { color: lin(0x3a3042), rough: 0.95, metal: 0, uv: UV.carpet };
  const plastic: Surf = { color: lin(0x1b1620), rough: 0.75, metal: 0.05 };

  // floor + rear parcel shelf
  b.box(1.36, 0.04, 2.5, T(0, y(0.33), -0.35), carpet);
  b.box(1.24, 0.035, 0.44, T(0, y(BELT - 0.02), -1.28), { color: s.interior, rough: 0.85, metal: 0.02, uv: UV.carpet });

  // dashboard + parcel tray, glowing faintly from the instrument lights
  b.box(1.42, 0.20, 0.30, T(0, y(0.80), 0.78, 0.22, 0, 0), dashSurf);
  b.box(1.42, 0.06, 0.22, T(0, y(0.70), 0.66), plastic);
  b.box(0.44, 0.13, 0.02, T(-0.34, y(0.815), 0.635), {
    color: lin(0xffb060), rough: 0.4, metal: 0, uv: UV.dash, light: L.cabin,
  });

  // steering wheel (LHD) — rim + spokes + column
  const wx = -0.34, wy = y(0.79), wz = 0.50;
  b.torus(0.165, 0.017, 6, 18, Math.PI * 2, T(wx, wy, wz, Math.PI / 2 - 0.42, 0, 0), { color: lin(0x171219), rough: 0.6, metal: 0.05 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    b.box(0.022, 0.16, 0.012, T(wx + Math.cos(a) * 0.08, wy + Math.sin(a) * 0.075, wz + Math.sin(a) * 0.032, Math.PI / 2 - 0.42, 0, a),
      { color: lin(0x2a2430), rough: 0.5, metal: 0.3 });
  }
  b.cyl(0.028, 0.032, 0.30, 8, T(wx, wy - 0.10, wz + 0.09, 0.42, 0, 0), plastic);

  // seats: two front buckets + a rear bench
  const seat = (sx: number, sz: number, w: number, backH: number) => {
    b.box(w, 0.14, 0.48, T(sx, y(0.46), sz), seatSurf);
    b.box(w, backH, 0.14, T(sx, y(0.46 + backH * 0.5), sz - 0.26, -0.16, 0, 0), seatSurf);
    b.box(w * 0.6, 0.13, 0.11, T(sx, y(0.5 + backH), sz - 0.32), seatSurf);
  };
  seat(-0.34, 0.10, 0.46, 0.46);
  seat(0.34, 0.10, 0.46, 0.46);
  b.box(1.28, 0.14, 0.46, T(0, y(0.44), -0.78), seatSurf);
  b.box(1.28, 0.46, 0.14, T(0, y(0.67), -1.03, -0.14, 0, 0), seatSurf);

  // transmission tunnel, gear lever, handbrake
  b.box(0.26, 0.18, 1.5, T(0, y(0.36), 0.05), carpet);
  b.cyl(0.014, 0.018, 0.24, 6, T(0.0, y(0.56), 0.30, 0.2, 0, 0), plastic);
  b.sphere(0.026, 8, T(0.0, y(0.67), 0.325), { color: lin(0x0f0c12), rough: 0.5, metal: 0.1 });
  b.box(0.03, 0.03, 0.26, T(0.08, y(0.5), 0.06, -0.5, 0, 0), plastic);

  // door cards (visible through the glass)
  for (const sx of [-1, 1]) {
    b.box(0.035, 0.42, 2.2, T(sx * 0.66, y(0.66), -0.28), { color: s.interior, rough: 0.85, metal: 0.02, uv: UV.fabric });
  }
  // headliner
  b.box(1.28, 0.03, 1.85, T(0, y(ROOF - 0.115), -0.33), { color: lin(0x3c3444), rough: 0.9, metal: 0 });
  // rear-view mirror
  b.box(0.19, 0.05, 0.02, T(0, y(ROOF - 0.19), 0.66, -0.2, 0, 0), { color: lin(0x1a1620), rough: 0.5, metal: 0.2 });
}

/* ---------------- front end ---------------- */

function buildFrontEnd(b: GeoBuilder, chrome: Surf, chromeDull: Surf, trim: Surf, rubber: Surf, hero: boolean): void {
  // Front furniture must sit PROUD of the loft's end cap at z = NOSE,
  // otherwise the lamps and grille end up buried inside the bodywork.
  const zF = NOSE + 0.06;

  // Grille panel between the lamps.
  b.box(0.95, 0.22, 0.05, T(0, y(0.665), zF - 0.03), { color: BLACK_TRIM, rough: 0.52, metal: 0.35, coat: 0.3, uv: UV.grille });
  // Chrome grille surround.
  b.box(1.02, 0.035, 0.06, T(0, y(0.785), zF - 0.02), chrome);
  b.box(1.02, 0.035, 0.06, T(0, y(0.552), zF - 0.02), chrome);
  for (const sx of [-1, 1]) b.box(0.035, 0.26, 0.06, T(sx * 0.495, y(0.665), zF - 0.02), chrome);
  // Centre badge bar.
  b.box(0.9, 0.02, 0.05, T(0, y(0.665), zF - 0.005), chromeDull);

  // Round twin headlights: chrome bezel + fluted lens.
  for (const sx of [-1, 1]) {
    const x = sx * 0.50;
    b.torus(0.098, 0.022, 6, 16, Math.PI * 2, T(x, y(0.665), zF - 0.005), chrome);
    b.cyl(0.092, 0.088, 0.05, 16, T(x, y(0.665), zF - 0.03, Math.PI / 2, 0, 0), {
      color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
    });
    // reflector bowl behind the lens
    b.sphere(0.085, 10, T(x, y(0.665), zF - 0.10, 0, 0, 0, 1, 1, 0.8), { color: lin(0xc9cede), rough: 0.10, metal: 1, coat: 0.3 });
    // small round indicator/foglight inboard
    b.torus(0.045, 0.014, 5, 12, Math.PI * 2, T(sx * 0.655, y(0.60), zF - 0.02, 0, 0, 0), chromeDull);
    b.cyl(0.042, 0.04, 0.04, 12, T(sx * 0.655, y(0.60), zF - 0.035, Math.PI / 2, 0, 0), {
      color: LENS_AMBER, rough: 0.10, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: sx < 0 ? L.indL : L.indR,
    });
  }

  // Chrome front bumper — bent, and on the hero car held on with tape.
  const bumperTilt = hero ? 0.06 : 0;
  b.box(1.60, 0.105, 0.10, T(0.02, y(0.475), zF + 0.045, 0, bumperTilt * 0.4, bumperTilt), chrome);
  b.box(1.60, 0.045, 0.05, T(0.02, y(0.42), zF + 0.03, 0, bumperTilt * 0.4, bumperTilt), chromeDull);
  for (const sx of [-1, 1]) {
    // over-riders
    b.box(0.085, 0.20, 0.09, T(sx * 0.36 + 0.02, y(0.50), zF + 0.05, 0, 0, bumperTilt), chrome);
    // bumper end caps wrapping round the corners
    b.box(0.10, 0.105, 0.22, T(sx * 0.755, y(0.475), zF - 0.06), chromeDull);
  }
  // valance under the bumper
  b.box(1.44, 0.14, 0.06, T(0, y(0.36), zF - 0.01), trim);
  // number plate
  b.box(0.46, 0.115, 0.012, T(0.06, y(0.40), zF + 0.075), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });

  // bonnet shut line + windscreen washer nozzles
  b.box(1.30, 0.008, 0.012, T(0, y(0.912), 1.30), trim);
  b.box(0.012, 0.008, 1.05, T(-0.62, y(0.905), 1.42), trim);
  b.box(0.012, 0.008, 1.05, T(0.62, y(0.905), 1.42), trim);

  // wing-mounted aerial
  b.cyl(0.006, 0.008, 0.62, 5, T(-0.66, y(1.18), 1.30, 0.12, 0, 0.1), chromeDull);
  void rubber;
}

/* ---------------- rear end ---------------- */

function buildRearEnd(b: GeoBuilder, chrome: Surf, chromeDull: Surf, trim: Surf, hero: boolean): void {
  const zR = TAIL - 0.05;

  // Rear panel between the lamps.
  b.box(1.06, 0.24, 0.05, T(0, y(0.76), zR + 0.02), { color: BLACK_TRIM, rough: 0.65, metal: 0.2 });

  // Three-segment tail lamps: amber indicator / red stop-tail / white reverse.
  for (const sx of [-1, 1]) {
    const x = sx * 0.585;
    b.box(0.30, 0.185, 0.055, T(x, y(0.78), zR - 0.005), { color: BLACK_TRIM, rough: 0.6, metal: 0.3 });
    b.box(0.285, 0.10, 0.045, T(x, y(0.815), zR - 0.02), {
      color: LENS_RED, rough: 0.09, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
    });
    b.box(0.135, 0.062, 0.045, T(x - sx * 0.072, y(0.725), zR - 0.02), {
      color: LENS_AMBER, rough: 0.10, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: sx < 0 ? L.indL : L.indR,
    });
    b.box(0.115, 0.062, 0.045, T(x + sx * 0.082, y(0.725), zR - 0.02), {
      color: LENS_CLEAR, rough: 0.09, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.reverse,
    });
    // chrome lamp surround
    b.box(0.315, 0.02, 0.05, T(x, y(0.878), zR - 0.012), chromeDull);
  }

  // Rear bumper.
  b.box(1.58, 0.10, 0.095, T(0, y(0.50), zR - 0.04), chrome);
  b.box(1.58, 0.04, 0.05, T(0, y(0.448), zR - 0.03), chromeDull);
  for (const sx of [-1, 1]) {
    b.box(0.085, 0.19, 0.085, T(sx * 0.38, y(0.525), zR - 0.045), chrome);
    b.box(0.10, 0.10, 0.22, T(sx * 0.745, y(0.50), zR + 0.06), chromeDull);
  }
  // plate + lamp
  b.box(0.46, 0.115, 0.012, T(0, y(0.60), zR - 0.06), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });
  b.box(0.09, 0.03, 0.03, T(0, y(0.675), zR - 0.05), { color: LENS_CLEAR, rough: 0.2, metal: 0.1, light: L.tail });

  // boot shut line + badge
  b.box(1.20, 0.008, 0.012, T(0, y(0.94), -1.52), trim);
  b.box(0.30, 0.026, 0.014, T(0.30, y(0.70), zR - 0.02), chromeDull);

  // exhaust
  b.cyl(0.030, 0.030, 0.36, 8, T(-0.42, y(0.235), TAIL + 0.10, Math.PI / 2, 0, 0), { color: lin(0x4a4a52), rough: 0.5, metal: 0.85 });
  b.cyl(0.038, 0.034, 0.09, 8, T(-0.42, y(0.235), TAIL - 0.06, Math.PI / 2, 0, 0), { color: lin(0x2c2c33), rough: 0.62, metal: 0.7 });

  if (hero) {
    // A dented, half-hanging rear valance.
    b.box(1.30, 0.13, 0.05, T(0.03, y(0.375), zR + 0.01, 0, 0.03, -0.05), trim);
  }
}

/* ---------------- sides ---------------- */

function buildSides(b: GeoBuilder, chrome: Surf, trim: Surf, rubber: Surf, s: DaciaScheme, hero: boolean): void {
  // Side jewellery sits just proud of the widest point of the body (the
  // blistered arches reach 0.836) so nothing ever z-fights the panels.
  for (const sx of [-1, 1]) {
    const x = sx * 0.848;
    // chrome side spear along the body
    b.box(0.020, 0.030, 3.1, T(x, y(0.66), -0.1), chrome);
    // door shut lines
    for (const z of [0.86, -0.17, -1.05]) {
      b.box(0.016, 0.44, 0.013, T(x, y(0.62), z), trim);
    }
    // door handles
    for (const z of [0.42, -0.55]) {
      b.box(0.03, 0.035, 0.135, T(x + sx * 0.014, y(0.79), z), chrome);
      b.box(0.022, 0.02, 0.05, T(x + sx * 0.028, y(0.79), z + 0.045), chrome);
    }
    // sill / rocker with heavy corrosion
    b.box(0.05, 0.10, 2.5, T(sx * 0.80, y(0.29), -0.1), {
      color: s.interior.clone().lerp(lin(0x3a2a1e), 0.6), rough: 0.9, metal: 0.1, uv: UV.bodyBattered,
    });
    // wheel-arch lips
    for (const az of [1.32, -1.12]) {
      b.torus(0.44, 0.022, 5, 14, Math.PI * 0.92, T(sx * 0.845, y(0.235), az, 0, Math.PI / 2 * sx, 0.04), trim);
    }
    // mud flaps behind the rear wheels
    if (hero) b.box(0.02, 0.16, 0.11, T(sx * 0.74, y(0.14), -1.60), rubber);
    // fuel filler on the left rear wing
    if (sx < 0) b.cyl(0.05, 0.05, 0.02, 10, T(-0.845, y(0.70), -1.72, 0, 0, Math.PI / 2), chrome);
  }
}

/* ---------------- decals ---------------- */

function buildDecals(b: GeoBuilder, rng: Rng): void {
  const V = (x: number, yy: number, z: number) => new THREE.Vector3(x, yy, z);
  /** Flat decal on a side panel, offset from the surface so it never z-fights. */
  const sideDecal = (sx: number, cz: number, cy: number, size: number, uv: readonly [number, number, number, number], tilt = 0) => {
    const x = sx * (bodyHalfWidth(cz) + 0.012);
    const hz = size * 0.5, hy = size * 0.5;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const p = (dz: number, dy: number) => V(x, cy + dy * ct - dz * st, cz + dz * ct + dy * st);
    const a = p(-hz, -hy), bb = p(hz, -hy), c = p(hz, hy), d = p(-hz, hy);
    const surf: Surf = { color: new THREE.Color(1, 1, 1), rough: 0.34, metal: 0, coat: 0.95, uv };
    if (sx > 0) b.quad(d, c, bb, a, surf);
    else b.quad(a, bb, c, d, surf);
  };

  // The purple rear door gets the round stickers, exactly as in the reference.
  sideDecal(1, -0.62, y(0.62), 0.30, UV.stickerBolt, rng.range(-0.1, 0.1));
  sideDecal(1, -1.05, y(0.76), 0.22, UV.stickerCircle, 0.12);
  sideDecal(1, -1.35, y(0.55), 0.26, UV.stickerStar, -0.08);
  sideDecal(-1, -0.95, y(0.66), 0.24, UV.stickerArrow, 0.05);
  sideDecal(-1, 0.40, y(0.55), 0.20, UV.stickerCircle, 0.3);

  // Rust decals over the arches and sills.
  const rustDecal = (sx: number, cz: number, cy: number, size: number) => sideDecal(sx, cz, cy, size, UV.rustPatch);
  rustDecal(1, 1.32, y(0.72), 0.46);
  rustDecal(-1, 1.20, y(0.34), 0.40);
  rustDecal(1, -1.12, y(0.36), 0.44);
  rustDecal(-1, -1.30, y(0.70), 0.38);
  rustDecal(-1, 0.10, y(0.30), 0.34);

  // Duct tape holding the front bumper on (front face, left side).
  const zT = NOSE + 0.135;
  const tapeSurf: Surf = { color: new THREE.Color(1, 1, 1), rough: 0.8, metal: 0.02, uv: UV.tape };
  b.quad(
    V(-0.72, y(0.40), zT), V(-0.20, y(0.40), zT), V(-0.20, y(0.56), zT), V(-0.72, y(0.56), zT),
    tapeSurf,
  );
  b.quad(
    V(-0.60, y(0.36), zT - 0.001), V(-0.44, y(0.36), zT - 0.001), V(-0.44, y(0.66), zT - 0.001), V(-0.60, y(0.66), zT - 0.001),
    tapeSurf,
  );

  // Boot-lid decal.
  const zB = TAIL - 0.02;
  b.quad(V(0.10, y(0.86), zB), V(-0.16, y(0.86), zB), V(-0.16, y(1.0), zB), V(0.10, y(1.0), zB), tapeSurf);
}

/* ---------------- dents ---------------- */

/** Deterministic factory-fresh-off-a-cliff damage baked into the hero car. */
export function heroDents(rng: Rng): Array<{ p: THREE.Vector3; r: number; d: number }> {
  const spots: Array<[number, number, number, number, number]> = [
    [0.80, y(0.60), -0.75, 0.42, 0.055],
    [-0.82, y(0.52), 1.05, 0.36, 0.045],
    [0.30, y(0.90), 1.70, 0.50, 0.035],
    [-0.55, y(0.80), -1.95, 0.34, 0.04],
    [0.78, y(0.44), 0.25, 0.30, 0.03],
  ];
  return spots.map(([x, yy, z, r, d]) => ({
    p: new THREE.Vector3(x, yy, z),
    r: r * rng.range(0.9, 1.15),
    d: d * rng.range(0.85, 1.2),
  }));
}
