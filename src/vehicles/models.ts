/**
 * THE FLEET.
 *
 * Every vehicle in the city is one of these models. A model owns its own
 * dimensions, its own body, its own paint palette and (optionally) its own
 * handling deltas — the `VehicleClass` it reports is only what the physics and
 * the traffic AI need to know about it, not what it looks like.
 *
 * The period mix is the point. Twenty-year-old 1300s and 1310s share the
 * street with Supernovas, Logans, Sanderos and Dusters; ARO 24s and drop-side
 * 1304 pick-ups work the industrial edges; the Logan is the taxi.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng';
import { Palette } from '../artDirection';
import { GeoBuilder, T, type ColorFn, type Surf } from './builder';
import { UV } from './texture';
import type { VehicleClass } from '../core/services';
import {
  CHROME, CHROME_DULL, BLACK_TRIM, DARK_PLASTIC, L, LENS_AMBER, LENS_CLEAR, LENS_RED,
  buildCarBody, car, lin,
  type BodyBuild, type CarDesign, type PaintScheme, type VehicleSpec,
} from './carkit';
import { buildAro, buildBus, buildPanelVan, buildPickup, buildScooter, buildTram, buildTruck } from './heavy';

/* ------------------------------------------------------------------ */
/* Handling deltas                                                     */
/* ------------------------------------------------------------------ */

export interface ModelHandling {
  mass?: number;
  engineForce?: number;
  topSpeed?: number;
  gripFront?: number;
  gripRear?: number;
  rearGripFade?: number;
  maxSteerRad?: number;
  suspensionStiffness?: number;
  rollGain?: number;
  pitchGain?: number;
  brakeForce?: number;
  handbrakeForce?: number;
  antiRoll?: number;
  downforce?: number;
}

export interface VehicleModel {
  id: string;
  cls: VehicleClass;
  label: string;
  spec: VehicleSpec;
  handling?: ModelHandling;
  build(variant: number, hero: boolean): BodyBuild;
}

/* ------------------------------------------------------------------ */
/* Paint                                                               */
/* ------------------------------------------------------------------ */

/**
 * Communist-era Dacia colours, spread right across the hue wheel. A street
 * full of cars sitting in the same 20 degrees of muddy red is the single
 * loudest "procedurally generated" tell there is.
 */
const ERA_COLOURS: Array<[number, number, number]> = [
  [0xd8d4c8, 0xa9a496, 0x2c2a26], // ivory white
  [0x2f6fb0, 0x24578a, 0x1c2430], // ministry blue
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

const MODERN_COLOURS: Array<[number, number, number]> = [
  [0xd6d8dc, 0xb0b3ba, 0x24242a],
  [0xb4b8c0, 0x8e929c, 0x24242a],
  [0x8e939c, 0x6e727c, 0x22222a],
  [0x4c515c, 0x383c46, 0x1e1e26],
  [0x23262d, 0x16181e, 0x1a1a20],
  [0x1f4f96, 0x173c74, 0x1c2028],
  [0x2d78c4, 0x225c98, 0x1c2028],
  [0xa8231f, 0x821a17, 0x241a1a],
  [0xd0442c, 0xa23522, 0x241a1a],
  [0x2c6b3c, 0x21522e, 0x1c2420],
  [0x1f6f66, 0x17544e, 0x1a2422],
  [0xd8a521, 0xaa811a, 0x2a2620],
  [0x7d4a3c, 0x5f382e, 0x241c18],
  [0x6b3f8a, 0x52306a, 0x241c2a],
];

function scheme(rng: Rng, table: Array<[number, number, number]>, wear: [number, number]): PaintScheme {
  const [a, b, c] = rng.pick(table);
  const base = lin(a);
  return {
    base,
    alt: lin(b),
    faded: base.clone().lerp(lin(0x7a7568), rng.range(0.2, 0.42)),
    interior: lin(c),
    wear: rng.range(wear[0], wear[1]),
  };
}

/** The hero car: battered yellow with mismatched purple donor panels. */
export function heroScheme(): PaintScheme {
  return {
    base: Palette.daciaYellow.clone().offsetHSL(0.004, 0.30, 0.12),
    alt: Palette.daciaPurple.clone().offsetHSL(0.01, 0.22, 0.08),
    faded: Palette.daciaYellow.clone().offsetHSL(0.004, 0.10, 0.16).lerp(lin(0xbdb083), 0.28),
    interior: lin(0x6d5540),
    wear: 1,
  };
}

/**
 * Panel map for the hero 1300. Donor rear doors and quarters in purple, one
 * greyer front wing, sun-bleached bonnet and roof — the reference frame's car.
 */
function heroPanels(d: CarDesign, s: PaintScheme): ColorFn {
  const G = -d.rideHeight;
  const beltY = G + d.belt;
  return (x, yy, z, out) => {
    // The greenhouse and roof are one sun-bleached yellow shell; the donor
    // panels are DOORS and QUARTERS, which all sit below the belt line.
    if (yy > beltY + 0.06) { out.copy(s.faded); return; }
    if (z < -0.14 && z > -1.62) { out.copy(s.alt); return; }
    if (z < -1.30) { out.copy(s.alt); return; }
    if (x < -0.2 && z > 0.72 && z < 1.86) { out.copy(s.faded); return; }
    if (yy > beltY - 0.03 && z > 0.9) { out.copy(s.faded); return; }
    out.copy(s.base);
  };
}

/* ------------------------------------------------------------------ */
/* Car designs                                                         */
/* ------------------------------------------------------------------ */

const dacia1300 = car({
  id: 'dacia1300', cls: 'dacia', label: 'Dacia 1300',
  length: 4.35, width: 1.64, height: 1.44,
  frontAxleZ: 1.32, rearAxleZ: -1.12,
  wheelRadius: 0.30, tyreWidth: 0.175, rideHeight: 0.62,
  wheelStyle: 'hubcap', seats: 4,
  sill: 0.235, belt: 0.90, bonnetY: 0.905, bonnetRake: -0.022,
  noseY: 0.795, tailY: 0.855, bootY: 0.938,
  noseRound: 0.17, tailRound: 0.17,
  halfWidth: 0.82, noseTaper: 0.30, tailTaper: 0.26,
  archBlister: 0.016,
  wsBase: 0.955, wsTop: 0.600, rsBase: -1.285, rsTop: -1.010, bPillarZ: -0.135,
  hwTop: 0.732, hwBelt: 0.786, glassX: 0.756, roofCrown: 0.006,
  rear: 'saloon',
  doorRows: 2, frontDoorZ: [-0.080, 0.895], rearDoorZ: [-1.215, -0.190],
  lamps: 'rect1300', grille: 'fineSlats', bumpers: 'chrome',
  brightwork: true, rubStrip: false, cowlVents: true, quarterLight: true,
});

const dacia1310 = car({
  ...dacia1300,
  id: 'dacia1310', label: 'Dacia 1310',
  length: 4.42, height: 1.445,
  noseY: 0.775, tailY: 0.845,
  wheelStyle: 'steel',
  lamps: 'rect1310', grille: 'blackSlats', bumpers: 'blackPlastic',
  brightwork: false, rubStrip: true, quarterLight: false, cowlVents: true,
});

const dacia1310Break = car({
  ...dacia1300,
  id: 'dacia1310break', label: 'Dacia 1310 Break',
  length: 4.51, height: 1.505,
  belt: 0.905, bonnetY: 0.910,
  rear: 'estate',
  rsBase: -2.02, rsTop: -1.90, tailY: 0.885, tailRound: 0.11, tailTaper: 0.16,
  hwTop: 0.716,
  rearDoorZ: [-1.68, -0.225],
  wheelStyle: 'steel',
  lamps: 'rect1310', grille: 'blackSlats', bumpers: 'blackPlastic',
  brightwork: false, rubStrip: true, quarterLight: false, roofRails: true, towbar: true,
});

const oltcit = car({
  id: 'oltcit', cls: 'hatch', label: 'Oltcit Club',
  length: 3.66, width: 1.53, height: 1.36,
  frontAxleZ: 1.10, rearAxleZ: -1.20,
  wheelRadius: 0.275, tyreWidth: 0.165, rideHeight: 0.565,
  wheelStyle: 'steel', seats: 4,
  sill: 0.215, belt: 0.835, bonnetY: 0.828, bonnetRake: -0.03,
  noseY: 0.715, tailY: 0.770,
  noseRound: 0.16, tailRound: 0.14,
  halfWidth: 0.765, noseTaper: 0.26, tailTaper: 0.18,
  wsBase: 0.72, wsTop: 0.30, rsBase: -1.28, rsTop: -0.80, bPillarZ: -0.30,
  hwTop: 0.645, hwBelt: 0.715, glassX: 0.690,
  rear: 'hatch',
  doorRows: 1, frontDoorZ: [-0.34, 0.665], rearDoorZ: [-1.20, -0.36],
  lamps: 'rect1310', grille: 'blackSlats', bumpers: 'blackPlastic',
  brightwork: false, rubStrip: true, cowlVents: true,
});

const supernova = car({
  id: 'supernova', cls: 'hatch', label: 'Dacia Supernova',
  length: 3.99, width: 1.63, height: 1.44,
  frontAxleZ: 1.24, rearAxleZ: -1.22,
  wheelRadius: 0.29, tyreWidth: 0.175, rideHeight: 0.60,
  wheelStyle: 'hubcap', seats: 4,
  sill: 0.225, belt: 0.885, bonnetY: 0.875, bonnetRake: -0.028,
  noseY: 0.760, tailY: 0.830,
  noseRound: 0.20, tailRound: 0.15,
  halfWidth: 0.815, noseTaper: 0.32, tailTaper: 0.22,
  wsBase: 0.80, wsTop: 0.36, rsBase: -1.36, rsTop: -0.86, bPillarZ: -0.24,
  hwTop: 0.688, hwBelt: 0.760, glassX: 0.735,
  rear: 'hatch',
  doorRows: 2, frontDoorZ: [-0.19, 0.745], rearDoorZ: [-1.30, -0.30],
  lamps: 'ovalSoft', grille: 'plasticMesh', bumpers: 'bodyPlastic',
  brightwork: false, rubStrip: true,
});

const sandero = car({
  id: 'sandero', cls: 'hatch', label: 'Dacia Sandero',
  length: 4.02, width: 1.75, height: 1.53,
  frontAxleZ: 1.30, rearAxleZ: -1.29,
  wheelRadius: 0.31, tyreWidth: 0.195, rideHeight: 0.635,
  wheelStyle: 'alloy', seats: 5,
  sill: 0.235, belt: 0.955, bonnetY: 0.935, bonnetRake: -0.035,
  noseY: 0.805, tailY: 0.905,
  noseRound: 0.24, tailRound: 0.14,
  halfWidth: 0.875, noseTaper: 0.36, tailTaper: 0.24,
  wsBase: 0.72, wsTop: 0.20, rsBase: -1.36, rsTop: -0.84, bPillarZ: -0.30,
  hwTop: 0.735, hwBelt: 0.815, glassX: 0.790,
  rear: 'hatch',
  doorRows: 2, frontDoorZ: [-0.25, 0.665], rearDoorZ: [-1.30, -0.36],
  lamps: 'sweptModern', grille: 'modernBar', bumpers: 'bodyPlastic',
  rubStrip: true,
});

const duster = car({
  id: 'duster', cls: 'hatch', label: 'Dacia Duster',
  length: 4.31, width: 1.82, height: 1.71,
  frontAxleZ: 1.38, rearAxleZ: -1.30,
  wheelRadius: 0.365, tyreWidth: 0.225, rideHeight: 0.775,
  wheelStyle: 'alloy', seats: 5,
  sill: 0.335, belt: 1.075, bonnetY: 1.075, bonnetRake: -0.03,
  noseY: 0.945, tailY: 1.035,
  noseRound: 0.22, tailRound: 0.13,
  halfWidth: 0.91, noseTaper: 0.34, tailTaper: 0.22,
  archBlister: 0.032, archLift: 1.02,
  wsBase: 0.80, wsTop: 0.28, rsBase: -1.44, rsTop: -1.24, bPillarZ: -0.28,
  hwTop: 0.765, hwBelt: 0.855, glassX: 0.825,
  rear: 'suv',
  doorRows: 2, frontDoorZ: [-0.22, 0.745], rearDoorZ: [-1.38, -0.34],
  lamps: 'suvStack', grille: 'suvBar', bumpers: 'cladding',
  rubStrip: false, cladding: true, roofRails: true, towbar: true,
});

const logan = car({
  id: 'logan', cls: 'sedan', label: 'Dacia Logan',
  length: 4.25, width: 1.74, height: 1.53,
  frontAxleZ: 1.36, rearAxleZ: -1.26,
  wheelRadius: 0.305, tyreWidth: 0.185, rideHeight: 0.625,
  wheelStyle: 'hubcap', seats: 5,
  sill: 0.235, belt: 0.955, bonnetY: 0.935, bonnetRake: -0.035,
  noseY: 0.800, tailY: 0.905, bootY: 0.985,
  noseRound: 0.23, tailRound: 0.15,
  halfWidth: 0.87, noseTaper: 0.36, tailTaper: 0.28,
  wsBase: 0.70, wsTop: 0.20, rsBase: -1.10, rsTop: -0.78, bPillarZ: -0.28,
  hwTop: 0.730, hwBelt: 0.810, glassX: 0.786,
  rear: 'saloon',
  doorRows: 2, frontDoorZ: [-0.22, 0.645], rearDoorZ: [-1.04, -0.34],
  lamps: 'sweptModern', grille: 'modernBar', bumpers: 'bodyPlastic',
  rubStrip: true,
});

const modernSedan = car({
  id: 'sedanModern', cls: 'sedan', label: 'saloon',
  length: 4.62, width: 1.78, height: 1.42,
  frontAxleZ: 1.42, rearAxleZ: -1.34,
  wheelRadius: 0.325, tyreWidth: 0.205, rideHeight: 0.635,
  wheelStyle: 'alloy', seats: 5,
  sill: 0.235, belt: 0.885, bonnetY: 0.855, bonnetRake: -0.045,
  noseY: 0.735, tailY: 0.845, bootY: 0.905,
  noseRound: 0.28, tailRound: 0.20,
  halfWidth: 0.89, noseTaper: 0.42, tailTaper: 0.34,
  wsBase: 0.76, wsTop: 0.12, rsBase: -1.10, rsTop: -0.62, bPillarZ: -0.26,
  hwTop: 0.720, hwBelt: 0.828, glassX: 0.800, roofCrown: 0.02,
  rear: 'saloon',
  doorRows: 2, frontDoorZ: [-0.20, 0.705], rearDoorZ: [-1.04, -0.32],
  lamps: 'sweptModern', grille: 'modernBar', bumpers: 'bodyPlastic',
  rubStrip: true,
});

const ministry = car({
  ...modernSedan,
  id: 'ministry', cls: 'police', label: 'Ministry pursuit',
  length: 4.72, width: 1.82, height: 1.46,
  frontAxleZ: 1.44, rearAxleZ: -1.36,
  wheelRadius: 0.335, tyreWidth: 0.215, trackHalf: 0.7725, rideHeight: 0.645,
  halfWidth: 0.91, hwTop: 0.735, hwBelt: 0.845, glassX: 0.818,
  belt: 0.905, bonnetY: 0.875, bootY: 0.925, noseY: 0.755, tailY: 0.865,
});

/* ------------------------------------------------------------------ */
/* Model-specific decoration                                           */
/* ------------------------------------------------------------------ */

/** Round sticker decals, rust blooms and the taped-on bumper of the hero car. */
function heroDecals(b: GeoBuilder, d: CarDesign, rng: Rng): void {
  const G = -d.rideHeight;
  const y = (h: number) => G + h;
  const V = (x: number, yy: number, z: number) => new THREE.Vector3(x, yy, z);
  const sideDecal = (sx: number, cz: number, cy: number, size: number, uv: readonly [number, number, number, number], tilt = 0) => {
    const x = sx * (d.halfWidth + 0.026);
    const hz = size * 0.5, hy = size * 0.5;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const p = (dz: number, dy: number) => V(x, cy + dy * ct - dz * st, cz + dz * ct + dy * st);
    const a = p(-hz, -hy), bb = p(hz, -hy), c = p(hz, hy), dd = p(-hz, hy);
    const surf: Surf = { color: new THREE.Color(1, 1, 1), rough: 0.34, metal: 0, coat: 0.95, uv };
    if (sx > 0) b.quad(dd, c, bb, a, surf); else b.quad(a, bb, c, dd, surf);
  };
  sideDecal(1, -1.62, y(0.66), 0.30, UV.stickerBolt, rng.range(-0.1, 0.1));
  sideDecal(1, -1.80, y(0.44), 0.22, UV.stickerCircle, 0.12);
  sideDecal(-1, -1.72, y(0.62), 0.24, UV.stickerArrow, 0.05);
  const rust = (sx: number, cz: number, cy: number, size: number) => sideDecal(sx, cz, cy, size, UV.rustPatch);
  rust(1, 1.32, y(0.60), 0.46);
  rust(-1, 1.22, y(0.34), 0.40);
  rust(1, -1.12, y(0.36), 0.44);
  rust(-1, -1.34, y(0.66), 0.38);

  // Duct tape holding the front bumper on.
  const zT = d.length * 0.5 + 0.15;
  const tapeSurf: Surf = { color: new THREE.Color(1, 1, 1), rough: 0.8, metal: 0.02, uv: UV.tape };
  b.quad(V(-0.72, y(0.40), zT), V(-0.20, y(0.40), zT), V(-0.20, y(0.56), zT), V(-0.72, y(0.56), zT), tapeSurf);
  b.quad(V(-0.60, y(0.34), zT - 0.001), V(-0.44, y(0.34), zT - 0.001), V(-0.44, y(0.64), zT - 0.001), V(-0.60, y(0.64), zT - 0.001), tapeSurf);
  // Boot-lid decal.
  const zB = -d.length * 0.5 - 0.02;
  b.quad(V(0.10, y(0.86), zB), V(-0.16, y(0.86), zB), V(-0.16, y(1.0), zB), V(0.10, y(1.0), zB), tapeSurf);
}

/** Bucharest taxi: roof sign, door chequer, meter on the dash. */
function taxiKit(b: GeoBuilder, d: CarDesign): void {
  const G = -d.rideHeight;
  const y = (h: number) => G + h;
  const signZ = (d.wsTop + d.rsTop) * 0.5 + 0.28;
  b.box(0.66, 0.20, 0.20, T(0, y(d.height + 0.115), signZ), {
    color: lin(0xf2e8c8), rough: 0.35, metal: 0.02, coat: 0.6, light: L.aux,
  });
  b.box(0.70, 0.055, 0.24, T(0, y(d.height + 0.02), signZ), { color: DARK_PLASTIC, rough: 0.7, metal: 0.1 });
  b.box(0.60, 0.10, 0.008, T(0, y(d.height + 0.115), signZ + 0.104), {
    color: lin(0x101014), rough: 0.5, metal: 0, uv: UV.plate,
  });
  // Chequer band along the doors and a phone number panel.
  for (const sx of [-1, 1]) {
    const x = sx * (d.halfWidth + 0.012);
    for (let i = 0; i < 14; i++) {
      b.box(0.012, 0.062, 0.088, T(x, y(d.belt - 0.24), -1.0 + i * 0.13), {
        color: i % 2 === 0 ? lin(0x101014) : lin(0xf0f0f0), rough: 0.4, metal: 0, coat: 0.7,
      });
    }
  }
  // Meter.
  b.box(0.10, 0.07, 0.09, T(0.02, y(d.belt - 0.05), d.wsBase - 0.30), {
    color: lin(0x14141a), rough: 0.5, metal: 0.1, light: L.cabin,
  });
}

/** Ministry livery: flank band, roof bar, grille strobes. */
function ministryKit(b: GeoBuilder, d: CarDesign): THREE.Vector3[] {
  const G = -d.rideHeight;
  const y = (h: number) => G + h;
  const hw = d.halfWidth;
  const roofZ = (d.wsTop + d.rsTop) * 0.5;
  for (const sx of [-1, 1] as const) {
    const x = sx * (hw + 0.014);
    const A = new THREE.Vector3(x, y(d.belt - 0.42), -d.length * 0.5 + 0.5);
    const B = new THREE.Vector3(x, y(d.belt - 0.42), d.length * 0.5 - 0.5);
    const C = new THREE.Vector3(x, y(d.belt - 0.06), d.length * 0.5 - 0.5);
    const D = new THREE.Vector3(x, y(d.belt - 0.06), -d.length * 0.5 + 0.5);
    const s: Surf = { color: new THREE.Color(1, 1, 1), rough: 0.28, metal: 0, coat: 1, uv: UV.liveryStripe };
    if (sx > 0) b.quad(D, C, B, A, s); else b.quad(A, B, C, D, s);
  }
  b.box(hw * 1.3, 0.055, 0.20, T(0, y(d.height + 0.045), roofZ), { color: lin(0x18181e), rough: 0.5, metal: 0.3 });
  for (const sx of [-1, 1]) {
    b.box(hw * 0.5, 0.075, 0.17, T(sx * hw * 0.36, y(d.height + 0.10), roofZ), {
      color: sx < 0 ? lin(0x2b6cff) : lin(0xff2020), rough: 0.08, metal: 0.05,
      light: sx < 0 ? L.indL : L.indR,
    });
    b.box(0.16, 0.05, 0.05, T(sx * 0.3, y(d.belt - 0.24), d.length * 0.5 + 0.05), {
      color: sx < 0 ? lin(0x2b6cff) : lin(0xff2020), rough: 0.1, metal: 0.05,
      light: sx < 0 ? L.indL : L.indR,
    });
  }
  b.box(hw * 1.32, 0.055, 0.21, T(0, y(d.height + 0.145), roofZ), { color: lin(0x18181e), rough: 0.5, metal: 0.3 });
  b.box(0.08, 0.14, 0.14, T(hw * 0.7, y(d.belt + 0.16), d.wsBase + 0.1), { color: lin(0xdfe4ee), rough: 0.15, metal: 0.6, coat: 0.5, light: L.aux });
  return [
    new THREE.Vector3(-hw * 0.36, y(d.height + 0.12), roofZ),
    new THREE.Vector3(hw * 0.36, y(d.height + 0.12), roofZ),
  ];
}

/** Deterministic factory-fresh-off-a-cliff damage baked into the hero car. */
export function heroDents(rng: Rng): Array<{ p: THREE.Vector3; r: number; d: number }> {
  const y = (h: number) => -0.62 + h;
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

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

type Era = 'era' | 'modern';

function carModel(
  d: CarDesign,
  era: Era,
  wear: [number, number],
  opts: { handling?: ModelHandling; decorate?: (b: GeoBuilder, d: CarDesign) => THREE.Vector3[] | void } = {},
): VehicleModel {
  return {
    id: d.id, cls: d.cls, label: d.label, spec: d, handling: opts.handling,
    build(variant: number, hero: boolean): BodyBuild {
      const rng = new Rng(`${d.id}-${variant}`);
      const s = hero ? heroScheme() : scheme(rng, era === 'era' ? ERA_COLOURS : MODERN_COLOURS, wear);
      let beacons: THREE.Vector3[] | undefined;
      const design: CarDesign = {
        ...d,
        extra: (b, _g, dd, _s, r) => {
          if (hero) heroDecals(b, dd, r);
          const res = opts.decorate?.(b, dd);
          if (res) beacons = res;
        },
      };
      if (hero) s.panels = heroPanels(design, s);
      const build = buildCarBody(design, s, rng, hero);
      if (beacons) build.anchors.beacons = beacons;
      return build;
    },
  };
}

/** The taxi wants a fixed yellow, not a random one. */
function taxiModel(d: CarDesign): VehicleModel {
  const design: CarDesign = { ...d, id: 'loganTaxi', label: 'Logan taxi' };
  return {
    id: design.id, cls: design.cls, label: design.label, spec: design,
    build(variant: number): BodyBuild {
      const rng = new Rng(`taxi-${variant}`);
      const base = lin(0xe8b31c).lerp(lin(0xd8a018), rng.range(0, 0.4));
      const s: PaintScheme = {
        base, alt: lin(0x101014),
        faded: base.clone().lerp(lin(0x8a8070), 0.26),
        interior: lin(0x22222a), wear: 0.42,
      };
      return buildCarBody({ ...design, extra: (b, _g, dd) => taxiKit(b, dd) }, s, rng, false);
    },
  };
}

function ministryModel(d: CarDesign): VehicleModel {
  return {
    id: d.id, cls: d.cls, label: d.label, spec: d,
    build(variant: number): BodyBuild {
      const rng = new Rng(`ministry-${variant}`);
      const s: PaintScheme = {
        base: lin(0xe9ecf2), alt: lin(0x0d2f96),
        faded: lin(0xdfe2ea), interior: lin(0x1a1a22), wear: 0.18,
      };
      let beacons: THREE.Vector3[] = [];
      const build = buildCarBody({ ...d, extra: (b, _g, dd) => { beacons = ministryKit(b, dd); } }, s, rng, false);
      build.anchors.beacons = beacons;
      return build;
    },
  };
}

function heavyModel(
  id: string, cls: VehicleClass, label: string, spec: VehicleSpec,
  build: (spec: VehicleSpec, rng: Rng) => BodyBuild,
  handling?: ModelHandling,
): VehicleModel {
  return {
    id, cls, label, spec, handling,
    build: (variant: number) => build(spec, new Rng(`${id}-${variant}`)),
  };
}

const aroSpec: VehicleSpec = {
  length: 4.44, width: 1.80, height: 1.98,
  frontAxleZ: 1.35, rearAxleZ: -1.14,
  wheelRadius: 0.375, tyreWidth: 0.225, trackHalf: 0.78, rideHeight: 0.80,
  wheelStyle: 'steel', seats: 4,
};

const pickupSpec: VehicleSpec = {
  length: 4.72, width: 1.66, height: 1.80,
  frontAxleZ: 1.42, rearAxleZ: -1.20,
  wheelRadius: 0.315, tyreWidth: 0.185, trackHalf: 0.685, rideHeight: 0.66,
  wheelStyle: 'steel', seats: 2,
};

const vanSpec: VehicleSpec = {
  length: 5.10, width: 1.98, height: 2.42,
  frontAxleZ: 1.45, rearAxleZ: -1.45,
  wheelRadius: 0.36, tyreWidth: 0.22, trackHalf: 0.87, rideHeight: 0.66,
  wheelStyle: 'steel', seats: 3,
};

const truckSpec: VehicleSpec = {
  length: 7.40, width: 2.42, height: 3.10,
  frontAxleZ: 2.30, rearAxleZ: -1.95,
  wheelRadius: 0.50, tyreWidth: 0.30, trackHalf: 1.06, rideHeight: 0.86,
  wheelStyle: 'truck', seats: 2,
  extraAxles: [-2.95],
};

const busSpec: VehicleSpec = {
  length: 11.6, width: 2.52, height: 3.16,
  frontAxleZ: 3.85, rearAxleZ: -3.35, extraAxles: [-4.55],
  wheelRadius: 0.52, tyreWidth: 0.30, trackHalf: 1.11, rideHeight: 0.72,
  wheelStyle: 'truck', seats: 30,
};

const tramSpec: VehicleSpec = {
  length: 15.2, width: 2.46, height: 3.35,
  frontAxleZ: 5.4, rearAxleZ: -5.4, extraAxles: [1.9, -1.9, 6.9, -6.9],
  wheelRadius: 0.36, tyreWidth: 0.16, trackHalf: 1.02, rideHeight: 0.60,
  wheelStyle: 'steel', seats: 60,
  railed: true,
};

const scooterSpec: VehicleSpec = {
  length: 1.18, width: 0.52, height: 1.22,
  frontAxleZ: 0.50, rearAxleZ: -0.50,
  wheelRadius: 0.135, tyreWidth: 0.075, trackHalf: 0.0, rideHeight: 0.18,
  wheelStyle: 'scooter', seats: 1, twoWheeled: true,
};

export const MODELS: Record<string, VehicleModel> = {};
function reg(m: VehicleModel): VehicleModel {
  MODELS[m.id] = m;
  return m;
}

reg(carModel(dacia1300, 'era', [0.25, 0.62], { handling: { mass: 950, engineForce: 6200, topSpeed: 34 } }));
reg(carModel(dacia1310, 'era', [0.30, 0.68], { handling: { mass: 970, engineForce: 6500, topSpeed: 35 } }));
reg(carModel(dacia1310Break, 'era', [0.30, 0.70], { handling: { mass: 1030, engineForce: 6500, topSpeed: 33, rollGain: 1.15 } }));
reg(carModel(oltcit, 'era', [0.30, 0.72], { handling: { mass: 820, engineForce: 5400, topSpeed: 31, maxSteerRad: 0.66 } }));
reg(carModel(supernova, 'era', [0.20, 0.55], { handling: { mass: 940, engineForce: 7200, topSpeed: 37 } }));
reg(carModel(sandero, 'modern', [0.08, 0.34], { handling: { mass: 1060, engineForce: 8400, topSpeed: 41 } }));
reg(carModel(duster, 'modern', [0.12, 0.42], { handling: { mass: 1300, engineForce: 9600, topSpeed: 40, rollGain: 1.15, antiRoll: 1.5 } }));
reg(carModel(logan, 'modern', [0.10, 0.40], { handling: { mass: 1120, engineForce: 8600, topSpeed: 42 } }));
reg(taxiModel(logan));
reg(carModel(modernSedan, 'modern', [0.06, 0.30], { handling: { mass: 1320, engineForce: 9600, topSpeed: 44 } }));
reg(ministryModel(ministry));
reg(heavyModel('aro24', 'van', 'ARO 24', aroSpec, buildAro, { mass: 1650, engineForce: 10500, topSpeed: 32, rollGain: 1.2, antiRoll: 1.5 }));
reg(heavyModel('dacia1304', 'van', 'Dacia 1304', pickupSpec, buildPickup, { mass: 1240, engineForce: 8200, topSpeed: 33, rollGain: 1.0 }));
reg(heavyModel('panelVan', 'van', 'panel van', vanSpec, buildPanelVan, { mass: 1980, engineForce: 11500, topSpeed: 35 }));
reg(heavyModel('roman', 'truck', 'Roman flatbed', truckSpec, buildTruck));
reg(heavyModel('ratb', 'bus', 'RATB bus', busSpec, buildBus));
reg(heavyModel('tram', 'tram', 'tram', tramSpec, buildTram));
reg(heavyModel('escooter', 'scooter', 'e-scooter', scooterSpec, buildScooter));

/**
 * Weighted pick list per class. Repeats are the weights: on a Bucharest street
 * the 1300 and the 1310 dominate the old stock and the Logan the new.
 */
export const CLASS_MODELS: Record<VehicleClass, string[]> = {
  dacia: ['dacia1300', 'dacia1300', 'dacia1310', 'dacia1310', 'dacia1310break'],
  hatch: ['supernova', 'supernova', 'sandero', 'sandero', 'oltcit', 'duster'],
  sedan: ['logan', 'loganTaxi', 'logan', 'sedanModern'],
  van: ['dacia1304', 'aro24', 'panelVan'],
  truck: ['roman'],
  bus: ['ratb'],
  police: ['ministry'],
  tram: ['tram'],
  scooter: ['escooter'],
};

/** How many distinct paint/geometry variants exist per class. */
export const VARIANTS: Record<VehicleClass, number> = {
  dacia: CLASS_MODELS.dacia.length * 3,
  hatch: CLASS_MODELS.hatch.length * 3,
  sedan: CLASS_MODELS.sedan.length * 3,
  van: CLASS_MODELS.van.length * 3,
  truck: 4,
  bus: 4,
  police: 2,
  tram: 2,
  scooter: 3,
};

/** The model a (class, variant) pair resolves to. */
export function modelFor(kind: VehicleClass, variant: number, hero: boolean): VehicleModel {
  if (hero && kind === 'dacia') return MODELS.dacia1300;
  const list = CLASS_MODELS[kind];
  const id = list[((variant % list.length) + list.length) % list.length];
  return MODELS[id] ?? MODELS.dacia1300;
}

export { CHROME, CHROME_DULL, BLACK_TRIM, LENS_RED, LENS_AMBER, LENS_CLEAR };
