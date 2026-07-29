/**
 * Bodywork for every vehicle class except the Dacia (see dacia.ts).
 *
 * Each class has a deliberately different silhouette — a low three-box sedan, a
 * stubby hatch, a tall slab-sided van, a cab-over truck, a long bus, the
 * Ministry's liveried police sedan, an articulated tram under catenary, and the
 * acid-green e-scooter from the reference frame.
 *
 * Every class is built through the same lofted-section pipeline as the Dacia,
 * so they share one material, one atlas and one shader program.
 */

import * as THREE from 'three';
import { GeoBuilder, T, type Surf } from './builder';
import { UV } from './texture';
import { Rng } from '../core/rng';
import { Palette } from '../artDirection';
import type { VehicleClass } from '../core/services';
import type { WheelStyle } from './wheels';
import {
  BLACK_TRIM, CHROME, CHROME_DULL, GLASS, L, LENS_AMBER, LENS_CLEAR, LENS_RED, LAMP_WHITE,
  RUBBER, buildDacia, heroScheme, trafficScheme,
} from './dacia';

const lin = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();

export interface BodyAnchors {
  headlights: THREE.Vector3[];
  taillights: THREE.Vector3[];
  exhaust: THREE.Vector3[];
  interior: THREE.Vector3;
  beacons?: THREE.Vector3[];
}

export interface BodyBuild {
  shell: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  anchors: BodyAnchors;
}

/* ------------------------------------------------------------------ */
/* Per-class physical spec — mesh and physics read the same numbers     */
/* ------------------------------------------------------------------ */

export interface VehicleSpec {
  length: number;
  width: number;
  height: number;
  frontAxleZ: number;
  rearAxleZ: number;
  wheelRadius: number;
  tyreWidth: number;
  trackHalf: number;
  /** Body origin above the ground plane at rest. */
  rideHeight: number;
  wheelStyle: WheelStyle;
  seats: number;
  /** Only two wheels (scooter). */
  twoWheeled?: boolean;
}

export const SPECS: Record<VehicleClass, VehicleSpec> = {
  dacia: { length: 4.35, width: 1.64, height: 1.44, frontAxleZ: 1.32, rearAxleZ: -1.12, wheelRadius: 0.30, tyreWidth: 0.175, trackHalf: 0.665, rideHeight: 0.62, wheelStyle: 'hubcap', seats: 4 },
  sedan: { length: 4.62, width: 1.78, height: 1.42, frontAxleZ: 1.40, rearAxleZ: -1.34, wheelRadius: 0.33, tyreWidth: 0.21, trackHalf: 0.73, rideHeight: 0.60, wheelStyle: 'alloy', seats: 4 },
  hatch: { length: 3.86, width: 1.70, height: 1.48, frontAxleZ: 1.14, rearAxleZ: -1.12, wheelRadius: 0.30, tyreWidth: 0.19, trackHalf: 0.70, rideHeight: 0.60, wheelStyle: 'alloy', seats: 4 },
  // trackHalf on the boxy classes must put the *outer* face of the tyre at or
  // just inside the body side, or the slab flanks swallow the wheels whole and
  // the vehicle appears to have none at all.
  van: { length: 5.10, width: 1.98, height: 2.42, frontAxleZ: 1.45, rearAxleZ: -1.45, wheelRadius: 0.36, tyreWidth: 0.22, trackHalf: 0.87, rideHeight: 0.66, wheelStyle: 'steel', seats: 3 },
  truck: { length: 7.40, width: 2.42, height: 3.10, frontAxleZ: 2.30, rearAxleZ: -1.95, wheelRadius: 0.50, tyreWidth: 0.30, trackHalf: 1.06, rideHeight: 0.86, wheelStyle: 'truck', seats: 2 },
  bus: { length: 11.6, width: 2.52, height: 3.16, frontAxleZ: 3.85, rearAxleZ: -3.35, wheelRadius: 0.52, tyreWidth: 0.30, trackHalf: 1.11, rideHeight: 0.72, wheelStyle: 'truck', seats: 30 },
  police: { length: 4.72, width: 1.82, height: 1.46, frontAxleZ: 1.44, rearAxleZ: -1.36, wheelRadius: 0.34, tyreWidth: 0.22, trackHalf: 0.75, rideHeight: 0.60, wheelStyle: 'alloy', seats: 4 },
  tram: { length: 15.2, width: 2.46, height: 3.35, frontAxleZ: 5.4, rearAxleZ: -5.4, wheelRadius: 0.36, tyreWidth: 0.16, trackHalf: 0.72, rideHeight: 0.60, wheelStyle: 'steel', seats: 60 },
  scooter: { length: 1.18, width: 0.52, height: 1.22, frontAxleZ: 0.50, rearAxleZ: -0.50, wheelRadius: 0.135, tyreWidth: 0.075, trackHalf: 0.0, rideHeight: 0.18, wheelStyle: 'scooter', seats: 1, twoWheeled: true },
};

/* ------------------------------------------------------------------ */
/* Colour variation                                                    */
/* ------------------------------------------------------------------ */

/**
 * Civic traffic palette, spread over the full hue wheel on purpose.
 *
 * The previous list was twelve variations on "dusty grey-brown", so twenty
 * spawned cars came out as one colour and the street read as a single
 * procedurally-generated object. Real traffic has silver and white in the
 * majority but always a scattering of saturated red, blue, green and yellow,
 * and it is those few that sell the crowd.
 */
const CIVIC_COLOURS = [
  0xd6d8dc, 0xb4b8c0, 0x8e939c, 0x4c515c, 0x23262d, // the neutral majority
  0x1f4f96, 0x2d78c4, 0x3fa0c8,                     // blues
  0xa8231f, 0xd0442c, 0x8c2140,                     // reds
  0x2c6b3c, 0x5a8a3a, 0x1f6f66,                     // greens
  0xd8a521, 0xe07a1e, 0xb56526,                     // warm
  0x6b3f8a, 0x9a5ba8,                               // purples
  0x7d4a3c, 0xa8763f,                               // browns
];

export function bodyColour(rng: Rng): THREE.Color {
  const base = lin(rng.pick(CIVIC_COLOURS));
  // Sun-faded, dusty city cars — but only lightly, or every hue collapses back
  // toward the same grey.
  return base.lerp(lin(0x6a6470), rng.range(0.0, 0.18));
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

const cache = new Map<string, BodyBuild>();

export function buildBody(kind: VehicleClass, variant: number, hero: boolean): BodyBuild {
  const key = `${kind}|${variant}|${hero ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const rng = new Rng(`${kind}-${variant}`);
  let built: BodyBuild;
  switch (kind) {
    case 'dacia':
      built = buildDacia(hero ? heroScheme() : trafficScheme(rng), rng, hero);
      break;
    case 'police':
      built = buildCar(SPECS.police, lin(0xe9ecf2), rng, { police: true, boot: true });
      break;
    case 'sedan':
      built = buildCar(SPECS.sedan, bodyColour(rng), rng, { boot: true });
      break;
    case 'hatch':
      built = buildCar(SPECS.hatch, bodyColour(rng), rng, { boot: false });
      break;
    case 'van':
      built = buildVan(rng);
      break;
    case 'truck':
      built = buildTruck(rng);
      break;
    case 'bus':
      built = buildBus(rng);
      break;
    case 'tram':
      built = buildTram(rng);
      break;
    case 'scooter':
      built = buildScooter(rng);
      break;
  }
  cache.set(key, built);
  return built;
}

/** How many distinct paint/geometry variants exist per class. */
export const VARIANTS: Record<VehicleClass, number> = {
  dacia: 12, sedan: 16, hatch: 16, van: 8, truck: 6, bus: 5, police: 2, tram: 2, scooter: 4,
};

/* ------------------------------------------------------------------ */
/* Generic modern car (sedan / hatch / police)                          */
/* ------------------------------------------------------------------ */

function buildCar(
  spec: VehicleSpec,
  colour: THREE.Color,
  rng: Rng,
  o: { boot: boolean; police?: boolean },
): BodyBuild {
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;

  const nose = spec.length * 0.5;
  const tail = -spec.length * 0.5;
  const hw = spec.width * 0.5;
  const belt = spec.height * 0.62;
  const roof = spec.height;
  const sill = 0.22;

  const paint: Surf = { color: colour, rough: 0.28, metal: 0, coat: 1, uv: UV.bodyClean };
  const trim: Surf = { color: BLACK_TRIM, rough: 0.60, metal: 0.12, coat: 0.35 };
  const glassSurf: Surf = { color: GLASS, rough: 0.045, metal: 0, coat: 0, uv: UV.glassGrime };
  const chrome: Surf = { color: CHROME_DULL, rough: 0.14, metal: 1, coat: 0.35 };

  const archY = (z: number) => {
    let v = sill;
    for (const ax of [spec.frontAxleZ, spec.rearAxleZ]) {
      const dz = z - ax;
      const r = spec.wheelRadius * 1.5;
      if (Math.abs(dz) < r) v = Math.max(v, 0.2 + Math.sqrt(r * r - dz * dz) * 0.95);
    }
    return Math.min(v, belt - 0.12);
  };

  const bonnetZ = nose - spec.length * (o.boot ? 0.28 : 0.24);
  const bootZ = o.boot ? tail + spec.length * 0.24 : tail + spec.length * 0.06;

  const topY = (z: number) => {
    if (z > nose - 0.24) return belt - (z - (nose - 0.24)) * 0.9;
    if (z > bonnetZ) return belt - 0.01;
    if (z > bootZ) return belt;
    if (o.boot) {
      if (z > tail + 0.2) return belt + 0.02;
      return belt + 0.02 - (tail + 0.2 - z) * 0.7;
    }
    return belt + 0.02 - Math.max(0, tail + 0.16 - z) * 0.6;
  };

  const stations: Array<{ z: number; hw: number; yTop: number; yBottom: number; rTop: number; rBottom: number }> = [];
  const N = 26;
  for (let i = 0; i <= N; i++) {
    const z = tail + ((nose - tail) * i) / N;
    let w = hw;
    if (z > nose - 0.5) w -= (z - (nose - 0.5)) * 0.42;
    if (z < tail + 0.5) w -= (tail + 0.5 - z) * 0.36;
    stations.push({ z, hw: w, yTop: y(topY(z)), yBottom: y(archY(z)), rTop: 0.16, rBottom: 0.07 });
  }
  b.loft(stations, paint);
  b.box(hw * 1.7, 0.05, spec.length * 0.8, T(0, y(0.2), 0), { color: lin(0x0e0d12), rough: 0.95, metal: 0 });

  /* greenhouse: fastback-ish roof for modern cars */
  const rf = bonnetZ - 0.5;
  const rr = bootZ + (o.boot ? 0.30 : 0.02);
  const roofStations = [
    { z: rr - 0.05, hw: hw * 0.70, yTop: y(roof - 0.03), yBottom: y(belt), rTop: 0.14, rBottom: 0.06 },
    { z: rr + 0.4, hw: hw * 0.80, yTop: y(roof), yBottom: y(belt), rTop: 0.15, rBottom: 0.06 },
    { z: (rr + rf) * 0.5, hw: hw * 0.82, yTop: y(roof), yBottom: y(belt), rTop: 0.15, rBottom: 0.06 },
    { z: rf - 0.15, hw: hw * 0.79, yTop: y(roof - 0.005), yBottom: y(belt), rTop: 0.15, rBottom: 0.06 },
    { z: rf + 0.05, hw: hw * 0.70, yTop: y(roof - 0.05), yBottom: y(belt), rTop: 0.14, rBottom: 0.06 },
  ];
  b.loft(roofStations, paint);

  /* glass — inset panels punched into the greenhouse */
  const V = (x: number, h: number, z: number) => new THREE.Vector3(x, y(h), z);
  g.quad(V(-hw * 0.62, belt + 0.05, bonnetZ), V(hw * 0.62, belt + 0.05, bonnetZ), V(hw * 0.56, roof - 0.06, rf), V(-hw * 0.56, roof - 0.06, rf), glassSurf);
  g.quad(V(hw * 0.62, belt + 0.05, bootZ + 0.06), V(-hw * 0.62, belt + 0.05, bootZ + 0.06), V(-hw * 0.56, roof - 0.06, rr), V(hw * 0.56, roof - 0.06, rr), glassSurf);
  for (const sx of [-1, 1]) {
    const x = sx * hw * 0.845;
    const a = V(x, belt + 0.05, rr + 0.1);
    const bb = V(x, belt + 0.05, rf - 0.05);
    const c = V(x, roof - 0.09, rf - 0.2);
    const d = V(x, roof - 0.09, rr + 0.22);
    if (sx > 0) g.quad(a, bb, c, d, glassSurf); else g.quad(d, c, bb, a, glassSurf);
    // black window surround so the glass reads as inset
    b.box(0.02, 0.02, Math.abs(rf - rr), T(x - sx * 0.01, y(belt + 0.03), (rf + rr) * 0.5), trim);
  }

  /* interior blocks visible through the glass */
  b.box(hw * 1.4, 0.16, 0.34, T(0, y(belt - 0.06), bonnetZ - 0.28, 0.2, 0, 0), { color: lin(0x1b1720), rough: 0.75, metal: 0.05, uv: UV.dash });
  for (const sx of [-1, 1]) {
    b.box(0.44, 0.12, 0.46, T(sx * hw * 0.42, y(belt - 0.3), (rf + rr) * 0.5 + 0.35), { color: lin(0x2a2430), rough: 0.85, metal: 0.02, uv: UV.fabric });
    b.box(0.44, 0.5, 0.12, T(sx * hw * 0.42, y(belt - 0.06), (rf + rr) * 0.5 + 0.1, -0.16, 0, 0), { color: lin(0x2a2430), rough: 0.85, metal: 0.02, uv: UV.fabric });
  }
  b.torus(0.16, 0.016, 5, 14, Math.PI * 2, T(-hw * 0.42, y(belt - 0.10), bonnetZ - 0.52, Math.PI / 2 - 0.4, 0, 0), { color: lin(0x141018), rough: 0.6, metal: 0.05 });

  /* lights */
  for (const sx of [-1, 1]) {
    b.box(0.34, 0.13, 0.10, T(sx * (hw - 0.30), y(belt - 0.30), nose + 0.02, 0, sx * 0.16, 0), {
      color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
    });
    b.box(0.30, 0.13, 0.09, T(sx * (hw - 0.28), y(belt - 0.20), tail - 0.02, 0, sx * 0.14, 0), {
      color: LENS_RED, rough: 0.08, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
    });
    b.box(0.10, 0.09, 0.07, T(sx * (hw - 0.52), y(belt - 0.20), tail - 0.02), {
      color: LENS_CLEAR, rough: 0.1, metal: 0.06, light: L.reverse,
    });
    b.box(0.09, 0.09, 0.07, T(sx * (hw - 0.08), y(belt - 0.24), tail - 0.02), {
      color: LENS_AMBER, rough: 0.12, metal: 0.06, light: sx < 0 ? L.indL : L.indR,
    });
    b.box(0.09, 0.08, 0.07, T(sx * (hw - 0.06), y(belt - 0.32), nose + 0.01), {
      color: LENS_AMBER, rough: 0.12, metal: 0.06, light: sx < 0 ? L.indL : L.indR,
    });
    // mirrors
    b.box(0.06, 0.07, 0.14, T(sx * (hw + 0.05), y(belt + 0.02), rf - 0.05), { color: colour, rough: 0.3, metal: 0.5 });
  }
  // grille + bumpers
  b.box(hw * 1.15, 0.15, 0.07, T(0, y(belt - 0.32), nose + 0.02), { color: lin(0x15151b), rough: 0.5, metal: 0.4, coat: 0.3, uv: UV.grille });
  b.box(hw * 1.85, 0.24, 0.14, T(0, y(belt - 0.52), nose + 0.0), trim);
  b.box(hw * 1.85, 0.22, 0.14, T(0, y(belt - 0.46), tail - 0.0), trim);
  b.box(0.44, 0.11, 0.012, T(0, y(belt - 0.55), nose + 0.07), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });
  b.box(0.44, 0.11, 0.012, T(0, y(belt - 0.48), tail - 0.07), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });
  b.cyl(0.032, 0.032, 0.12, 8, T(sxSign(rng) * 0.4, y(0.18), tail + 0.02, Math.PI / 2, 0, 0), { color: lin(0x3a3a42), rough: 0.5, metal: 0.8 });
  for (const sx of [-1, 1]) {
    b.box(0.02, 0.05, spec.length * 0.62, T(sx * (hw + 0.005), y(belt - 0.36), 0), trim);
    for (const z of [rf - 0.5, rr + 0.6]) b.box(0.03, 0.03, 0.12, T(sx * (hw + 0.012), y(belt - 0.06), z), chrome);
  }

  const anchors: BodyAnchors = {
    headlights: [new THREE.Vector3(-(hw - 0.3), y(belt - 0.3), nose - 0.05), new THREE.Vector3(hw - 0.3, y(belt - 0.3), nose - 0.05)],
    taillights: [new THREE.Vector3(-(hw - 0.28), y(belt - 0.2), tail + 0.05), new THREE.Vector3(hw - 0.28, y(belt - 0.2), tail + 0.05)],
    exhaust: [new THREE.Vector3(0.4, y(0.18), tail - 0.04)],
    interior: new THREE.Vector3(0, y(belt + 0.1), 0),
  };

  if (o.police) {
    // Ministry livery: blue band down the flanks + roof bar with strobes.
    for (const sx of [-1, 1]) {
      const x = sx * (hw + 0.008);
      const q = (z0: number, z1: number, h0: number, h1: number) => {
        const A = new THREE.Vector3(x, y(h0), z0), B = new THREE.Vector3(x, y(h0), z1);
        const C = new THREE.Vector3(x, y(h1), z1), D = new THREE.Vector3(x, y(h1), z0);
        const s: Surf = { color: new THREE.Color(1, 1, 1), rough: 0.28, metal: 0, coat: 1, uv: UV.liveryStripe };
        if (sx > 0) b.quad(D, C, B, A, s); else b.quad(A, B, C, D, s);
      };
      q(tail + 0.5, nose - 0.5, belt - 0.44, belt - 0.06);
    }
    // light bar
    b.box(hw * 1.3, 0.055, 0.20, T(0, y(roof + 0.045), (rf + rr) * 0.5 + 0.1), { color: lin(0x18181e), rough: 0.5, metal: 0.3 });
    for (const sx of [-1, 1]) {
      b.box(hw * 0.5, 0.075, 0.17, T(sx * hw * 0.36, y(roof + 0.10), (rf + rr) * 0.5 + 0.1), {
        color: sx < 0 ? lin(0x2b6cff) : lin(0xff2020), rough: 0.08, metal: 0.05,
        light: sx < 0 ? L.indL : L.indR,
      });
    }
    b.box(hw * 1.32, 0.055, 0.21, T(0, y(roof + 0.145), (rf + rr) * 0.5 + 0.1), { color: lin(0x18181e), rough: 0.5, metal: 0.3 });
    // grille strobes
    for (const sx of [-1, 1]) {
      b.box(0.16, 0.05, 0.05, T(sx * 0.3, y(belt - 0.18), nose + 0.03), {
        color: sx < 0 ? lin(0x2b6cff) : lin(0xff2020), rough: 0.1, metal: 0.05,
        light: sx < 0 ? L.indL : L.indR,
      });
    }
    anchors.beacons = [
      new THREE.Vector3(-hw * 0.36, y(roof + 0.12), (rf + rr) * 0.5 + 0.1),
      new THREE.Vector3(hw * 0.36, y(roof + 0.12), (rf + rr) * 0.5 + 0.1),
    ];
  }

  return { shell: b.build(), glass: g.build(), anchors };
}

function sxSign(rng: Rng): number {
  return rng.bool() ? 1 : -1;
}

/* ------------------------------------------------------------------ */
/* Boxy vehicles: van / truck / bus / tram                              */
/* ------------------------------------------------------------------ */

interface BoxOpts {
  spec: VehicleSpec;
  colour: THREE.Color;
  /** Z of the windscreen base (cab front). */
  windscreenZ: number;
  cabRoofZ: number;
  /**
   * Side window band along the body. `y0`/`y1` are ground-relative heights;
   * without them the "band" ran from the skirt to the gutter and the whole
   * flank came out as one sheet of glass.
   */
  sideWindows: { from: number; to: number; count: number; y0: number; y1: number } | null;
  roundEnds?: boolean;
  lowFloor?: boolean;
}

function buildBoxy(o: BoxOpts, rng: Rng): { b: GeoBuilder; g: GeoBuilder; anchors: BodyAnchors } {
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const spec = o.spec;
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const nose = spec.length * 0.5;
  const tail = -spec.length * 0.5;
  const hw = spec.width * 0.5;
  const roof = spec.height;
  const floor = o.lowFloor ? 0.34 : 0.5;

  const paint: Surf = { color: o.colour, rough: 0.32, metal: 0, coat: 1, uv: UV.bodyClean };
  const trim: Surf = { color: BLACK_TRIM, rough: 0.62, metal: 0.12, coat: 0.35 };
  const glassSurf: Surf = { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime };
  const chrome: Surf = { color: CHROME_DULL, rough: 0.16, metal: 0.95, coat: 0.3 };

  /**
   * Underside line, with a real arch cut over each axle. Without this the flat
   * flank runs straight down past the hubs and the wheels are simply invisible.
   */
  const archY = (z: number): number => {
    let v = floor - 0.24;
    const r = spec.wheelRadius * 1.24;
    for (const ax of [spec.frontAxleZ, spec.rearAxleZ]) {
      const dz = z - ax;
      if (Math.abs(dz) < r) {
        v = Math.max(v, spec.rideHeight - 0.12 + Math.sqrt(r * r - dz * dz) * 0.55);
      }
    }
    return Math.min(v, floor + 0.16);
  };

  const N = 40;
  const stations: Array<{ z: number; hw: number; yTop: number; yBottom: number; rTop: number; rBottom: number }> = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = tail + (nose - tail) * t;
    let w = hw;
    let top = roof;
    const endT = o.roundEnds ? 0.9 : 0.34;
    const dNose = (nose - z) / spec.length;
    const dTail = (z - tail) / spec.length;
    const edge = Math.min(dNose, dTail);
    if (edge < 0.035) {
      const k = 1 - edge / 0.035;
      w -= hw * 0.30 * k * endT;
      top -= (roof - floor) * 0.14 * k * endT;
    }
    // Blistered arch so the tyre sits under bodywork rather than beside it.
    for (const ax of [spec.frontAxleZ, spec.rearAxleZ]) {
      const k = Math.max(0, 1 - Math.abs(z - ax) / (spec.wheelRadius * 1.5));
      w += 0.03 * k * k;
    }
    stations.push({ z, hw: w, yTop: y(top), yBottom: y(archY(z) - 0.24), rTop: o.roundEnds ? 0.4 : 0.18, rBottom: 0.12 });
  }
  b.loft(stations, paint);

  // Dark arch liners so you never see daylight through the wheel well.
  for (const sx of [-1, 1]) {
    for (const az of [spec.frontAxleZ, spec.rearAxleZ]) {
      b.cyl(spec.wheelRadius * 1.22, spec.wheelRadius * 1.22, 0.10, 14,
        T(sx * (hw - 0.06), y(spec.rideHeight - 0.02), az, 0, 0, Math.PI / 2), trim, true);
      b.box(0.06, spec.wheelRadius * 2.5, spec.wheelRadius * 2.5,
        T(sx * (hw - 0.16), y(spec.rideHeight - 0.30), az), { color: lin(0x08080b), rough: 0.95, metal: 0, coat: 0 });
    }
  }

  // Skirt / rubbing strip along the flanks, and a cornice at the roof edge —
  // two horizontal breaks are all it takes to stop a slab reading as a box.
  for (const sx of [-1, 1]) {
    b.box(0.05, 0.09, spec.length * 0.94, T(sx * (hw + 0.005), y(floor - 0.16), 0), trim);
    b.box(0.05, 0.07, spec.length * 0.95, T(sx * (hw + 0.002), y(roof - 0.085), 0), trim);
    b.box(0.03, 0.035, spec.length * 0.9, T(sx * (hw + 0.02), y(floor + 0.40), 0), chrome);
  }

  const V = (x: number, h: number, z: number) => new THREE.Vector3(x, y(h), z);

  // windscreen
  g.quad(V(-hw * 0.88, floor + 1.06, o.windscreenZ), V(hw * 0.88, floor + 1.06, o.windscreenZ),
    V(hw * 0.86, roof - 0.30, o.cabRoofZ), V(-hw * 0.86, roof - 0.30, o.cabRoofZ), glassSurf);
  // rear window
  g.quad(V(hw * 0.82, floor + 1.10, tail + 0.06), V(-hw * 0.82, floor + 1.10, tail + 0.06),
    V(-hw * 0.80, roof - 0.34, tail + 0.1), V(hw * 0.80, roof - 0.34, tail + 0.1), glassSurf);

  if (o.sideWindows) {
    const { from, to, count, y0, y1 } = o.sideWindows;
    const span = (to - from) / count;
    for (const sx of [-1, 1]) {
      const x = sx * (hw + 0.005);
      for (let i = 0; i < count; i++) {
        const z0 = from + span * i + span * 0.07;
        const z1 = from + span * (i + 1) - span * 0.07;
        const a = V(x, y0, z0), bb = V(x, y0, z1);
        const c = V(x, y1, z1), d = V(x, y1, z0);
        if (sx > 0) g.quad(a, bb, c, d, glassSurf); else g.quad(d, c, bb, a, glassSurf);
        // pillar between panes
        b.box(0.045, y1 - y0 + 0.10, span * 0.15, T(x - sx * 0.012, y((y0 + y1) * 0.5), z1 + span * 0.07), trim);
      }
      // top and bottom rails of the glazing band
      b.box(0.04, 0.075, to - from, T(x - sx * 0.008, y(y1 + 0.035), (from + to) * 0.5), trim);
      b.box(0.04, 0.075, to - from, T(x - sx * 0.008, y(y0 - 0.035), (from + to) * 0.5), trim);
    }
  }

  // headlights / taillights
  for (const sx of [-1, 1]) {
    b.box(0.30, 0.18, 0.10, T(sx * (hw - 0.34), y(floor + 0.02), nose + 0.03), {
      color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
    });
    b.box(0.16, 0.30, 0.09, T(sx * (hw - 0.24), y(floor + 0.10), tail - 0.03), {
      color: LENS_RED, rough: 0.08, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
    });
    b.box(0.14, 0.10, 0.07, T(sx * (hw - 0.24), y(floor - 0.10), tail - 0.03), {
      color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx < 0 ? L.indL : L.indR,
    });
    b.box(0.14, 0.10, 0.07, T(sx * (hw - 0.06), y(floor + 0.02), nose + 0.03), {
      color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx < 0 ? L.indL : L.indR,
    });
    // mirrors on stalks
    b.box(0.07, 0.26, 0.09, T(sx * (hw + 0.16), y(roof - 0.62), o.windscreenZ - 0.1), trim);
  }
  // bumpers
  b.box(hw * 1.95, 0.22, 0.16, T(0, y(floor - 0.28), nose + 0.02), trim);
  b.box(hw * 1.95, 0.20, 0.14, T(0, y(floor - 0.26), tail - 0.02), trim);
  b.box(0.46, 0.12, 0.012, T(0, y(floor - 0.30), nose + 0.09), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });

  void rng;

  return {
    b, g,
    anchors: {
      headlights: [new THREE.Vector3(-(hw - 0.34), y(floor), nose - 0.03), new THREE.Vector3(hw - 0.34, y(floor), nose - 0.03)],
      taillights: [new THREE.Vector3(-(hw - 0.24), y(floor + 0.1), tail + 0.03), new THREE.Vector3(hw - 0.24, y(floor + 0.1), tail + 0.03)],
      exhaust: [new THREE.Vector3(-hw * 0.6, y(0.22), tail + 0.4)],
      interior: new THREE.Vector3(0, y(roof - 0.5), 0),
    },
  };
}

function buildVan(rng: Rng): BodyBuild {
  const spec = SPECS.van;
  const colour = lin(rng.pick([0xd8d4cc, 0x8e97a6, 0xb0522f, 0x5a6b7d, 0xc9c3b4]));
  const { b, g, anchors } = buildBoxy({
    spec, colour,
    windscreenZ: spec.length * 0.5 - 0.62,
    cabRoofZ: spec.length * 0.5 - 1.05,
    sideWindows: { from: spec.length * 0.5 - 1.86, to: spec.length * 0.5 - 1.02, count: 1, y0: 1.32, y1: 2.02 },
  }, rng);
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  // roof rack + cargo ribs
  for (let i = 0; i < 5; i++) {
    b.box(spec.width * 0.98, 0.05, 0.05, T(0, y(spec.height + 0.02), -1.9 + i * 0.62), { color: BLACK_TRIM, rough: 0.7, metal: 0.3 });
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.box(0.04, 1.3, 0.06, T(sx * (hw + 0.01), y(1.3), -2.0 + i * 0.66), { color: colour, rough: 0.45, metal: 0.4 });
    }
    b.box(0.03, 0.05, 0.12, T(sx * (hw + 0.02), y(1.06), spec.length * 0.5 - 1.6), { color: CHROME_DULL, rough: 0.3, metal: 0.9 });
  }
  // rear doors
  b.box(0.02, 1.5, 0.02, T(0, y(1.25), -spec.length * 0.5 + 0.02), { color: BLACK_TRIM, rough: 0.8, metal: 0.1 });
  return { shell: b.build(), glass: g.build(), anchors };
}

function buildTruck(rng: Rng): BodyBuild {
  const spec = SPECS.truck;
  const colour = lin(rng.pick([0x8a3d2e, 0x35506b, 0x6d6a60, 0x2f3a44]));
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  const nose = spec.length * 0.5;
  const tail = -spec.length * 0.5;

  const paint: Surf = { color: colour, rough: 0.34, metal: 0, coat: 0.9, uv: UV.bodyClean };
  const trim: Surf = { color: BLACK_TRIM, rough: 0.62, metal: 0.12, coat: 0.3 };
  const glassSurf: Surf = { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime };
  const V = (x: number, h: number, z: number) => new THREE.Vector3(x, y(h), z);

  // cab-over cab
  const cabRear = nose - 2.1;
  const cabStations = [];
  for (let i = 0; i <= 24; i++) {
    const z = cabRear + ((nose - cabRear) * i) / 24;
    const k = Math.max(0, (z - (nose - 0.3)) / 0.3);
    // Front wheel arch cut into the cab side, or the tyre sits buried in it.
    const ar = spec.wheelRadius * 1.22;
    const dz = z - spec.frontAxleZ;
    let bottom = 0.72;
    if (Math.abs(dz) < ar) bottom = Math.max(bottom, 0.50 + Math.sqrt(ar * ar - dz * dz) * 0.92);
    const blister = 0.045 * Math.max(0, 1 - Math.abs(dz) / (ar * 1.35)) ** 2;
    cabStations.push({ z, hw: hw - k * 0.12 + blister, yTop: y(3.02 - k * 0.16), yBottom: y(bottom), rTop: 0.24, rBottom: 0.14 });
  }
  b.loft(cabStations, paint);
  // Arch liner behind the cut.
  for (const sx of [-1, 1]) {
    b.cyl(spec.wheelRadius * 1.2, spec.wheelRadius * 1.2, 0.10, 14,
      T(sx * (hw - 0.08), y(spec.rideHeight - 0.36), spec.frontAxleZ, 0, 0, Math.PI / 2), trim, true);
  }
  // chassis + flatbed body
  b.box(spec.width * 0.86, 0.24, spec.length * 0.72, T(0, y(0.86), -0.6), { color: lin(0x24242c), rough: 0.8, metal: 0.4 });
  const bedZ0 = tail + 0.1, bedZ1 = cabRear - 0.12;
  b.box(spec.width, 0.10, bedZ1 - bedZ0, T(0, y(1.0), (bedZ0 + bedZ1) / 2), { color: lin(0x4a3c2c), rough: 0.9, metal: 0.05, uv: UV.carpet });
  for (const sx of [-1, 1]) {
    b.box(0.09, 1.05, bedZ1 - bedZ0, T(sx * (hw - 0.05), y(1.56), (bedZ0 + bedZ1) / 2), paint);
    for (let i = 0; i < 6; i++) {
      b.box(0.12, 1.0, 0.09, T(sx * (hw - 0.02), y(1.56), bedZ0 + 0.4 + i * ((bedZ1 - bedZ0 - 0.8) / 5)), trim);
    }
  }
  b.box(spec.width, 1.05, 0.09, T(0, y(1.56), bedZ0), paint);
  // tarpaulin hoops
  for (let i = 0; i < 5; i++) {
    const z = bedZ0 + 0.35 + i * ((bedZ1 - bedZ0 - 0.7) / 4);
    b.torus(hw - 0.06, 0.035, 5, 12, Math.PI, T(0, y(2.06), z, 0, Math.PI / 2, 0), trim);
  }
  // windscreen + side glass
  g.quad(V(-hw * 0.86, 1.9, nose - 0.14), V(hw * 0.86, 1.9, nose - 0.14), V(hw * 0.84, 2.88, nose - 0.36), V(-hw * 0.84, 2.88, nose - 0.36), glassSurf);
  for (const sx of [-1, 1]) {
    const x = sx * (hw + 0.005);
    const a = V(x, 1.95, cabRear + 0.25), bb = V(x, 1.95, nose - 0.4);
    const c = V(x, 2.84, nose - 0.5), d = V(x, 2.84, cabRear + 0.25);
    if (sx > 0) g.quad(a, bb, c, d, glassSurf); else g.quad(d, c, bb, a, glassSurf);
  }
  // lights, grille, bumper, stack
  for (const sx of [-1, 1]) {
    b.box(0.36, 0.24, 0.12, T(sx * (hw - 0.4), y(1.10), nose + 0.04), { color: LAMP_WHITE, rough: 0.1, metal: 0.1, uv: UV.headlampGlass, light: L.head });
    b.box(0.18, 0.34, 0.10, T(sx * (hw - 0.26), y(1.24), tail - 0.04), { color: LENS_RED, rough: 0.12, metal: 0.06, uv: UV.tailLens, light: L.tail });
    b.box(0.16, 0.12, 0.08, T(sx * (hw - 0.1), y(1.34), nose + 0.03), { color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx < 0 ? L.indL : L.indR });
    b.box(0.16, 0.12, 0.08, T(sx * (hw - 0.26), y(0.98), tail - 0.03), { color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx < 0 ? L.indL : L.indR });
    b.box(0.08, 0.5, 0.16, T(sx * (hw + 0.14), y(2.4), nose - 0.5), trim);
  }
  // Grille: a real slatted panel in a chrome surround, plus a chrome bumper
  // and headlamp bezels — the cab used to be a bare painted box with a decal.
  b.box(spec.width * 0.78, 0.52, 0.08, T(0, y(1.5), nose + 0.03), { color: lin(0x1a1a20), rough: 0.5, metal: 0.5, coat: 0.3, uv: UV.grille });
  for (let i = 0; i < 5; i++) {
    b.box(spec.width * 0.80, 0.035, 0.10, T(0, y(1.28 + i * 0.11), nose + 0.05), { color: CHROME_DULL, rough: 0.22, metal: 0.95, coat: 0.3 });
  }
  b.box(spec.width * 0.84, 0.06, 0.11, T(0, y(1.78), nose + 0.05), { color: CHROME_DULL, rough: 0.18, metal: 1, coat: 0.35 });
  b.box(spec.width * 0.84, 0.06, 0.11, T(0, y(1.22), nose + 0.05), { color: CHROME_DULL, rough: 0.18, metal: 1, coat: 0.35 });
  for (const sx of [-1, 1]) {
    b.box(0.42, 0.30, 0.06, T(sx * (hw - 0.4), y(1.10), nose + 0.06), { color: CHROME_DULL, rough: 0.18, metal: 1, coat: 0.35 });
    // step and mud flap
    b.box(0.10, 0.05, 0.42, T(sx * (hw - 0.02), y(0.52), nose - 1.0), { color: lin(0x3a3a44), rough: 0.5, metal: 0.7, coat: 0.2 });
    b.box(0.03, 0.34, 0.26, T(sx * (hw - 0.10), y(0.28), tail + 0.35), { color: RUBBER, rough: 0.92, metal: 0.02, coat: 0 });
  }
  b.box(spec.width * 1.0, 0.22, 0.22, T(0, y(0.82), nose + 0.04), { color: CHROME_DULL, rough: 0.2, metal: 0.95, coat: 0.3 });
  b.box(spec.width * 1.0, 0.16, 0.16, T(0, y(0.62), nose + 0.0), trim);
  b.cyl(0.09, 0.09, 1.7, 8, T(hw - 0.08, y(2.4), cabRear + 0.05), { color: lin(0x8e929e), rough: 0.24, metal: 1, coat: 0.3 });
  // marker lamps along the roof
  for (let i = -2; i <= 2; i++) {
    b.box(0.09, 0.05, 0.05, T(i * 0.36, y(3.06), nose - 0.4), { color: LENS_AMBER, rough: 0.2, metal: 0.05, coat: 0.8, light: L.aux });
  }

  return {
    shell: b.build(), glass: g.build(),
    anchors: {
      headlights: [new THREE.Vector3(-(hw - 0.4), y(1.1), nose - 0.02), new THREE.Vector3(hw - 0.4, y(1.1), nose - 0.02)],
      taillights: [new THREE.Vector3(-(hw - 0.26), y(1.24), tail + 0.02), new THREE.Vector3(hw - 0.26, y(1.24), tail + 0.02)],
      exhaust: [new THREE.Vector3(hw - 0.08, y(3.3), cabRear + 0.05)],
      interior: new THREE.Vector3(0, y(2.4), nose - 0.7),
    },
  };
}

function buildBus(rng: Rng): BodyBuild {
  const spec = SPECS.bus;
  const colour = lin(rng.pick([0xc4442e, 0x2f6ea8, 0xd8d2c6, 0xe0a520, 0x2f8a62]));
  const bandColour = lin(rng.pick([0xd8d2c6, 0x1c2028, 0xe8e4d8]));
  const { b, g, anchors } = buildBoxy({
    spec, colour,
    windscreenZ: spec.length * 0.5 - 0.5,
    cabRoofZ: spec.length * 0.5 - 0.95,
    sideWindows: { from: -spec.length * 0.5 + 0.7, to: spec.length * 0.5 - 1.1, count: 7, y0: 1.42, y1: 2.62 },
    lowFloor: true,
  }, rng);
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  const floor = 0.34;
  const trim: Surf = { color: BLACK_TRIM, rough: 0.6, metal: 0.15, coat: 0.3 };

  // Destination blind, lit.
  b.box(spec.width * 0.7, 0.26, 0.05, T(0, y(spec.height - 0.28), spec.length * 0.5 - 0.42), {
    color: lin(0x101018), rough: 0.4, metal: 0.1, coat: 0.4, light: L.aux,
  });
  b.box(spec.width * 0.74, 0.32, 0.03, T(0, y(spec.height - 0.28), spec.length * 0.5 - 0.40), trim);

  /* Two recessed double doors per side: a dark inset panel, a bright rubber
   * seal down the middle and a glazed upper half. Doors are the single most
   * recognisable thing about a bus and this one had none. */
  const doorZ = [spec.length * 0.5 - 2.05, -0.5, -spec.length * 0.5 + 1.75];
  for (const sx of [-1, 1]) {
    for (const z of doorZ) {
      const x = sx * (hw + 0.012);
      const dTop = 2.66, dBot = 0.42;
      // recess
      b.box(0.05, dTop - dBot, 1.28, T(sx * (hw - 0.03), y((dTop + dBot) * 0.5), z), { color: lin(0x14141b), rough: 0.8, metal: 0.05, coat: 0.15 });
      // leaves + centre seal + verticals
      b.box(0.035, dTop - dBot, 0.05, T(x, y((dTop + dBot) * 0.5), z), trim);
      for (const e of [-0.64, 0.64]) b.box(0.035, dTop - dBot, 0.06, T(x, y((dTop + dBot) * 0.5), z + e), trim);
      b.box(0.035, 0.06, 1.30, T(x, y(dTop), z), trim);
      b.box(0.035, 0.06, 1.30, T(x, y(dBot), z), trim);
      // door glass — same band as the passenger windows
      const V = (h: number, zz: number) => new THREE.Vector3(sx * (hw + 0.004), y(h), zz);
      for (const e of [-0.31, 0.31]) {
        const a = V(1.42, z + e - 0.25), bb = V(1.42, z + e + 0.25);
        const c = V(2.58, z + e + 0.25), d = V(2.58, z + e - 0.25);
        if (sx > 0) g.quad(a, bb, c, d, { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime });
        else g.quad(d, c, bb, a, { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime });
      }
    }
    // Livery band along the flank, below the glass.
    b.box(0.03, 0.30, spec.length * 0.93, T(sx * (hw + 0.018), y(floor + 0.16), 0), {
      color: bandColour, rough: 0.3, metal: 0, coat: 1, uv: UV.bodyClean,
    });
    // Roof-edge gutter.
    b.box(0.045, 0.045, spec.length * 0.94, T(sx * (hw + 0.008), y(spec.height - 0.03), 0), trim);
  }

  // Roof pods: ventilation hatches and an air-conditioning unit.
  for (let i = 0; i < 3; i++) {
    b.box(spec.width * 0.62, 0.14, 0.95, T(0, y(spec.height + 0.06), -3 + i * 2.6), { color: lin(0xd8d8dc), rough: 0.55, metal: 0.2, coat: 0.3 });
  }
  b.box(spec.width * 0.8, 0.26, 2.1, T(0, y(spec.height + 0.12), spec.length * 0.5 - 2.6), { color: lin(0xc8c8cc), rough: 0.6, metal: 0.25, coat: 0.25 });
  for (let i = 0; i < 6; i++) {
    b.box(spec.width * 0.78, 0.03, 0.07, T(0, y(spec.height + 0.26), spec.length * 0.5 - 3.4 + i * 0.3), trim);
  }

  // Front grille under the windscreen, and a chrome bumper bar.
  b.box(spec.width * 0.62, 0.30, 0.06, T(0, y(floor - 0.02), spec.length * 0.5 + 0.03), {
    color: lin(0x14141a), rough: 0.5, metal: 0.4, coat: 0.3, uv: UV.grille,
  });
  b.box(spec.width * 0.96, 0.10, 0.12, T(0, y(floor - 0.36), spec.length * 0.5 + 0.04), { color: CHROME_DULL, rough: 0.2, metal: 0.95, coat: 0.3 });
  return { shell: b.build(), glass: g.build(), anchors };
}

function buildTram(rng: Rng): BodyBuild {
  const spec = SPECS.tram;
  const colour = lin(rng.pick([0xd8c23a, 0xb8452e]));
  const { b, g, anchors } = buildBoxy({
    spec, colour,
    windscreenZ: spec.length * 0.5 - 0.35,
    cabRoofZ: spec.length * 0.5 - 0.9,
    sideWindows: { from: -spec.length * 0.5 + 1.0, to: spec.length * 0.5 - 1.1, count: 9, y0: 1.46, y1: 2.78 },
    roundEnds: true,
    lowFloor: true,
  }, rng);
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  // articulation bellows in the middle
  for (let i = -2; i <= 2; i++) {
    b.box(spec.width * 1.01, spec.height * 0.62, 0.09, T(0, y(spec.height * 0.52), i * 0.13), { color: lin(0x18181e), rough: 0.9, metal: 0.05 });
  }
  // pantograph
  b.box(1.5, 0.08, 0.5, T(0, y(spec.height + 0.06), 1.6), { color: lin(0x2a2a32), rough: 0.6, metal: 0.6 });
  b.box(0.07, 0.9, 0.07, T(-0.3, y(spec.height + 0.5), 1.6, 0.5, 0, 0), { color: lin(0x8a8a96), rough: 0.4, metal: 0.9 });
  b.box(0.07, 0.9, 0.07, T(0.3, y(spec.height + 0.5), 1.6, 0.5, 0, 0), { color: lin(0x8a8a96), rough: 0.4, metal: 0.9 });
  b.box(1.3, 0.05, 0.09, T(0, y(spec.height + 0.92), 1.18), { color: lin(0x6a6a76), rough: 0.35, metal: 0.95 });
  // route number box
  b.box(0.7, 0.24, 0.04, T(0, y(spec.height - 0.34), spec.length * 0.5 - 0.28), {
    color: lin(0x0d0d14), rough: 0.5, metal: 0.1, light: L.aux,
  });
  // skirts hiding the bogies
  for (const sx of [-1, 1]) {
    b.box(0.06, 0.5, spec.length * 0.9, T(sx * (hw - 0.01), y(0.24), 0), { color: lin(0x1a1a22), rough: 0.85, metal: 0.1 });
  }
  return { shell: b.build(), glass: g.build(), anchors };
}

function buildScooter(rng: Rng): BodyBuild {
  const spec = SPECS.scooter;
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const green: Surf = { color: Palette.scooterGreen.clone(), rough: 0.28, metal: 0, coat: 1 };
  const dark: Surf = { color: lin(0x15151a), rough: 0.6, metal: 0.35 };
  const metal: Surf = { color: lin(0x8d919c), rough: 0.16, metal: 1, coat: 0.35 };

  // deck + frame
  b.box(0.20, 0.06, 0.86, T(0, y(0.13), 0), green);
  b.box(0.23, 0.03, 0.90, T(0, y(0.165), 0), { color: lin(0x1c1c22), rough: 0.9, metal: 0.05, uv: UV.tread });
  b.box(0.10, 0.10, 0.30, T(0, y(0.12), -0.42), green);
  // steering column
  b.box(0.07, 1.02, 0.09, T(0, y(0.62), 0.44, -0.16, 0, 0), metal);
  b.box(0.52, 0.045, 0.05, T(0, y(1.10), 0.36), dark);
  for (const sx of [-1, 1]) b.cyl(0.026, 0.026, 0.12, 8, T(sx * 0.22, y(1.10), 0.36, 0, 0, Math.PI / 2), dark);
  // display + lamps
  b.box(0.11, 0.07, 0.03, T(0, y(1.16), 0.40, 0.4, 0, 0), { color: lin(0x1a2a1a), rough: 0.3, metal: 0.1, light: L.aux });
  b.cyl(0.035, 0.035, 0.03, 10, T(0, y(0.98), 0.47, Math.PI / 2, 0, 0), { color: LAMP_WHITE, rough: 0.1, metal: 0.1, light: L.head });
  b.box(0.07, 0.04, 0.02, T(0, y(0.20), -0.55), { color: LENS_RED, rough: 0.14, metal: 0.05, light: L.tail });
  // mudguards + kickstand
  for (const az of [0.5, -0.5]) {
    b.torus(0.17, 0.02, 4, 10, Math.PI * 0.7, T(0, y(0.18), az, 0, Math.PI / 2, 0.4), green);
  }
  b.box(0.03, 0.20, 0.03, T(-0.11, y(0.08), -0.26, 0, 0, 0.5), metal);
  void rng;
  return {
    shell: b.build(), glass: g.build(),
    anchors: {
      headlights: [new THREE.Vector3(0, y(0.98), 0.5)],
      taillights: [new THREE.Vector3(0, y(0.2), -0.56)],
      exhaust: [],
      interior: new THREE.Vector3(0, y(1.1), 0.4),
    },
  };
}

/* Re-exported so vehicleSystem can build materials without importing dacia. */
export { CHROME, RUBBER, BLACK_TRIM, LENS_RED, LENS_AMBER, GLASS, CHROME_DULL, LENS_CLEAR, LAMP_WHITE };
