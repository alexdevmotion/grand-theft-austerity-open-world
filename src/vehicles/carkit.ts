/**
 * THE CAR KIT.
 *
 * One parametric body builder that every four-wheeled car in the city goes
 * through. The point is NOT to recolour one shape: the descriptor drives the
 * whole side profile (sill, belt, bonnet height and rake, boot rise, nose and
 * tail rounding), the whole plan view (taper, tumblehome, arch blisters) and
 * the whole greenhouse (windscreen and backlight rake, pillar positions, roof
 * width and crown), so a 1972 Dacia 1300, a 2004 Logan and a Duster come out of
 * it with genuinely different silhouettes rather than different paint.
 *
 * On top of the shape sit *style* choices — lamp cluster, grille, bumper,
 * brightwork — which is what carries the period. A 1300 has rectangular lamps
 * with round auxiliaries under them in a fine-slat grille behind slim chrome
 * bumpers with overriders; a 1310 has the same body with squarer lamps and
 * black plastic bumpers; a Logan has a swept modern cluster and body-coloured
 * bumpers.
 *
 * Doors are real. `GeoBuilder.loft` routes the door-skin quads out of the body
 * and into their own builders, so an open door leaves an actual hole in the
 * flank with the interior behind it. See `DoorPart`.
 */

import * as THREE from 'three';
import { GeoBuilder, T, type ColorFn, type Station, type Surf } from './builder';
import { UV } from './texture';
import { Rng } from '../core/rng';
import type { WheelStyle } from './wheels';
import type { VehicleClass } from '../core/services';

const lin = (hex: number) => new THREE.Color(hex).convertSRGBToLinear();

/* ------------------------------------------------------------------ */
/* Shared palette + lamp channels                                      */
/* ------------------------------------------------------------------ */

export const CHROME = lin(0xd9dfee);
export const CHROME_DULL = lin(0x9aa0b2);
export const BLACK_TRIM = lin(0x14141a);
export const DARK_PLASTIC = lin(0x1d1d24);
export const RUBBER = lin(0x0f0f13);
export const LENS_RED = lin(0xd8122a);
export const LENS_AMBER = lin(0xff9a20);
export const LENS_CLEAR = lin(0xe8eef6);
export const LAMP_WHITE = lin(0xfff3d8);
export const GLASS = lin(0x2c3550);
export const CABIN_SHADOW = lin(0x0b0a10);

/** 8 emissive channels: head, tail, brake, reverse | indL, indR, interior, aux */
export const L = {
  none: [0, 0, 0, 0, 0, 0, 0, 0],
  head: [1, 0, 0, 0, 0, 0, 0, 0],
  tail: [0, 1, 0.9, 0, 0, 0, 0, 0],
  brake: [0, 0.2, 1, 0, 0, 0, 0, 0],
  reverse: [0, 0, 0, 1, 0, 0, 0, 0],
  indL: [0, 0, 0, 0, 1, 0, 0, 0],
  indR: [0, 0, 0, 0, 0, 1, 0, 0],
  cabin: [0, 0, 0, 0, 0, 0, 1, 0],
  aux: [0, 0, 0, 0, 0, 0, 0, 1],
} as const;

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type LampStyle =
  | 'rect1300'      // rectangular outboard lamp + round auxiliary below
  | 'rect1310'      // one wide squared-off lamp, 80s facelift
  | 'roundTwin'     // twin round lamps in chrome bezels (Oltcit, ARO)
  | 'ovalSoft'      // late-90s soft oval (Supernova / Solenza)
  | 'sweptModern'   // Logan / Sandero swept cluster
  | 'suvStack';     // Duster: tall cluster with a bar across

export type GrilleStyle = 'fineSlats' | 'blackSlats' | 'plasticMesh' | 'modernBar' | 'suvBar';
export type BumperStyle = 'chrome' | 'blackPlastic' | 'bodyPlastic' | 'cladding';
export type RearStyle = 'saloon' | 'hatch' | 'estate' | 'suv';

export interface PaintScheme {
  base: THREE.Color;
  /** Donor / secondary panel colour. */
  alt: THREE.Color;
  /** Sun-bleached horizontal surfaces. */
  faded: THREE.Color;
  interior: THREE.Color;
  /** 0..1 — how wrecked. Drives the battered atlas cell and rust decals. */
  wear: number;
  /** Optional per-position override; wins over everything. */
  panels?: ColorFn;
}

export interface DoorPart {
  id: string;
  side: -1 | 1;
  row: 0 | 1;
  /** Hinge position in body-local space; the door rotates about +Y here. */
  hinge: THREE.Vector3;
  /** Skin + frame, already translated so the hinge is the origin. */
  shell: THREE.BufferGeometry;
  /** Side glass for this door, same origin. */
  glass: THREE.BufferGeometry;
  /** Radians the door swings when fully open. */
  maxAngle: number;
  /** Where a character stands to work this door, body-local. */
  board: THREE.Vector3;
  /** Where the occupant ends up, body-local. */
  seat: THREE.Vector3;
}

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
  /** Openable doors. Empty for trams, scooters and the like. */
  doors?: DoorPart[];
  /** Driver bust, shown when the vehicle is occupied. */
  driver?: THREE.BufferGeometry;
  /** Triangle count of everything above, for the perf budget. */
  triangles?: number;
}

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
  twoWheeled?: boolean;
  /** Extra suspension rays for very long bodies (bus, tram). */
  extraAxles?: number[];
  /** Attitude-locked: pitch and roll are pinned. Rail vehicles. */
  railed?: boolean;
}

/** Everything the parametric builder needs. Most fields have defaults. */
export interface CarDesign extends VehicleSpec {
  id: string;
  cls: VehicleClass;
  label: string;

  /* side profile, heights above the ground plane */
  sill: number;
  belt: number;
  bonnetY: number;
  /** Bonnet height change per metre toward the nose (usually slightly down). */
  bonnetRake: number;
  /** Height at the very front / rear edge — how far the nose and tail drop. */
  noseY: number;
  tailY: number;
  /** Saloons only: boot lid height. */
  bootY: number;
  /** Metres over which the nose / tail round off. */
  noseRound: number;
  tailRound: number;

  /* plan view */
  halfWidth: number;
  noseTaper: number;
  tailTaper: number;
  archBlister: number;
  archRadius: number;
  archLift: number;

  /* greenhouse */
  wsBase: number;
  wsTop: number;
  rsBase: number;
  rsTop: number;
  bPillarZ: number;
  hwTop: number;
  hwBelt: number;
  glassX: number;
  roofCrown: number;
  rear: RearStyle;

  /* doors */
  doorRows: 1 | 2;
  frontDoorZ: [number, number];
  rearDoorZ: [number, number];

  /* styling */
  lamps: LampStyle;
  grille: GrilleStyle;
  bumpers: BumperStyle;
  /** Chrome side spear + window surrounds. */
  brightwork: boolean;
  /** Black rubbing strip along the flanks. */
  rubStrip: boolean;
  roofRails: boolean;
  /** Unpainted wheel-arch and sill cladding (Duster, ARO). */
  cladding: boolean;
  /** Bonnet vent slots at the base of the windscreen. */
  cowlVents: boolean;
  quarterLight: boolean;
  towbar: boolean;
  /** Extra decoration, run last with the shell builder. */
  extra?: (b: GeoBuilder, g: GeoBuilder, d: CarDesign, scheme: PaintScheme, rng: Rng) => void;
}

/* ------------------------------------------------------------------ */
/* Design factory                                                      */
/* ------------------------------------------------------------------ */

type CarInput = Partial<CarDesign> &
  Pick<CarDesign, 'id' | 'cls' | 'label' | 'length' | 'width' | 'height'>;

/**
 * Fill a design in from a handful of dimensions. Everything here is a *shape*
 * default; models override whatever gives them their character.
 */
export function car(i: CarInput): CarDesign {
  const length = i.length;
  const width = i.width;
  const height = i.height;
  const hw = i.halfWidth ?? width * 0.5;
  const nose = length * 0.5;
  const tail = -length * 0.5;
  const rear = i.rear ?? 'saloon';
  const belt = i.belt ?? height * 0.615;
  const wheelRadius = i.wheelRadius ?? 0.31;

  const bonnetLen = rear === 'suv' ? length * 0.26 : length * 0.28;
  const wsBase = i.wsBase ?? nose - bonnetLen;
  const cabinLen = rear === 'saloon' ? length * 0.36 : length * 0.40;
  const rsBase = i.rsBase ?? wsBase - cabinLen;

  return {
    id: i.id,
    cls: i.cls,
    label: i.label,
    length, width, height,
    frontAxleZ: i.frontAxleZ ?? nose - length * 0.20,
    rearAxleZ: i.rearAxleZ ?? tail + length * 0.20,
    wheelRadius,
    tyreWidth: i.tyreWidth ?? 0.19,
    // The outer face of the tyre sits just inside the flank. Anything more and
    // the wheels disappear into the arches and the car looks knock-kneed.
    trackHalf: i.trackHalf ?? hw - (i.tyreWidth ?? 0.19) * 0.5 - 0.03,
    rideHeight: i.rideHeight ?? wheelRadius * 2 + 0.02,
    wheelStyle: i.wheelStyle ?? 'alloy',
    seats: i.seats ?? 4,
    extraAxles: i.extraAxles,
    railed: i.railed,

    sill: i.sill ?? wheelRadius * 0.72,
    belt,
    bonnetY: i.bonnetY ?? belt + 0.005,
    bonnetRake: i.bonnetRake ?? -0.02,
    noseY: i.noseY ?? belt - 0.10,
    tailY: i.tailY ?? belt - 0.03,
    bootY: i.bootY ?? belt + 0.025,
    noseRound: i.noseRound ?? 0.18,
    tailRound: i.tailRound ?? 0.16,

    halfWidth: hw,
    noseTaper: i.noseTaper ?? 0.42,
    tailTaper: i.tailTaper ?? 0.36,
    archBlister: i.archBlister ?? 0.018,
    archRadius: i.archRadius ?? wheelRadius * 1.26,
    archLift: i.archLift ?? 1.0,

    wsBase,
    wsTop: i.wsTop ?? wsBase - (rear === 'suv' ? 0.34 : 0.36),
    rsBase,
    rsTop: i.rsTop ?? rsBase + (rear === 'hatch' ? 0.46 : rear === 'saloon' ? 0.28 : 0.14),
    bPillarZ: i.bPillarZ ?? (wsBase + rsBase) * 0.5 + 0.06,
    hwTop: i.hwTop ?? hw * 0.855,
    hwBelt: i.hwBelt ?? hw * 0.94,
    glassX: i.glassX ?? hw * 0.905,
    roofCrown: i.roofCrown ?? 0.012,
    rear,

    doorRows: i.doorRows ?? 2,
    frontDoorZ: i.frontDoorZ ?? [(i.bPillarZ ?? (wsBase + rsBase) * 0.5 + 0.06), wsBase - 0.06],
    rearDoorZ: i.rearDoorZ ?? [rsBase + 0.08, (i.bPillarZ ?? (wsBase + rsBase) * 0.5 + 0.06)],

    lamps: i.lamps ?? 'sweptModern',
    grille: i.grille ?? 'modernBar',
    bumpers: i.bumpers ?? 'bodyPlastic',
    brightwork: i.brightwork ?? false,
    rubStrip: i.rubStrip ?? true,
    roofRails: i.roofRails ?? false,
    cladding: i.cladding ?? false,
    cowlVents: i.cowlVents ?? false,
    quarterLight: i.quarterLight ?? false,
    towbar: i.towbar ?? false,
    extra: i.extra,
  };
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

/** Local helper bundle so every sub-builder shares the same frame. */
interface Ctx {
  d: CarDesign;
  s: PaintScheme;
  rng: Rng;
  hero: boolean;
  /** Ground plane in body space. */
  G: number;
  y: (aboveGround: number) => number;
  nose: number;
  tail: number;
  hw: number;
  b: GeoBuilder;
  g: GeoBuilder;
  paint: Surf;
  glassSurf: Surf;
  chrome: Surf;
  chromeDull: Surf;
  trim: Surf;
  rubber: Surf;
  V: (x: number, h: number, z: number) => THREE.Vector3;
}

export function buildCarBody(d: CarDesign, scheme: PaintScheme, rng: Rng, hero = false): BodyBuild {
  const G = -d.rideHeight;
  const y = (h: number) => G + h;
  const b = new GeoBuilder();
  const g = new GeoBuilder();

  const paintFn = scheme.panels ?? defaultPanels(d, scheme);
  const c: Ctx = {
    d, s: scheme, rng, hero, G, y,
    nose: d.length * 0.5,
    tail: -d.length * 0.5,
    hw: d.halfWidth,
    b, g,
    paint: {
      colorFn: paintFn, rough: 0.28 + scheme.wear * 0.14, metal: 0, coat: 1 - scheme.wear * 0.25,
      uv: scheme.wear > 0.5 ? UV.bodyBattered : UV.bodyClean,
    },
    glassSurf: { color: GLASS, rough: 0.045, metal: 0, coat: 0, uv: UV.glassGrime },
    chrome: { color: CHROME, rough: 0.085, metal: 1, coat: 0.35 },
    chromeDull: { color: CHROME_DULL, rough: 0.2, metal: 0.95, coat: 0.25 },
    trim: { color: BLACK_TRIM, rough: 0.6, metal: 0.1, coat: 0.3 },
    rubber: { color: RUBBER, rough: 0.92, metal: 0.02, coat: 0 },
    V: (x, h, z) => new THREE.Vector3(x, y(h), z),
  };

  const doors = lowerBody(c);
  greenhouse(c, doors);
  interior(c);
  frontEnd(c);
  rearEnd(c);
  sides(c);
  d.extra?.(b, g, d, scheme, rng);

  const doorParts = finishDoors(c, doors);
  const driver = buildDriver(c);

  const shell = b.build();
  const glass = g.build();
  let tris = b.triangles + g.triangles;
  for (const p of doorParts) {
    tris += (p.shell.attributes.position.count + p.glass.attributes.position.count) / 3;
  }

  return {
    shell, glass, doors: doorParts, driver,
    triangles: tris,
    anchors: anchors(c),
  };
}

/* ---------------- paint ---------------- */

function defaultPanels(d: CarDesign, s: PaintScheme): ColorFn {
  const G = -d.rideHeight;
  const beltY = G + d.belt;
  return (x, yy, _z, out) => {
    void x;
    // Sun bleaches the horizontal surfaces first: roof, bonnet, boot lid.
    out.copy(yy > beltY - 0.02 ? s.faded : s.base);
  };
}

/* ---------------- lower body ---------------- */

interface DoorSlot {
  id: string;
  side: -1 | 1;
  row: 0 | 1;
  z0: number;
  z1: number;
  skin: GeoBuilder;
  glassB: GeoBuilder;
}

/**
 * Wheel-arch opening. Centred on the HUB, not on the sill — an arch struck
 * from the sill line is a long shallow slot with the tyre sitting at the
 * bottom of a cave, which is what made every car look like it had bicycle
 * wheels. Struck from the hub with a radius just over the tyre's, the tyre
 * fills the opening the way it does on a real car.
 */
function archY(d: CarDesign, z: number): number {
  let best = d.sill;
  const r = d.archRadius;
  const cy = d.wheelRadius;
  for (const ax of [d.frontAxleZ, d.rearAxleZ]) {
    const dz = Math.abs(z - ax);
    if (dz >= r) continue;
    let v = cy + Math.sqrt(Math.max(0, r * r - dz * dz)) * d.archLift;
    // Feather to the sill at the mouth of the arch so the flank has no step.
    v = d.sill + (v - d.sill) * (1 - (dz / r) ** 5);
    if (v > best) best = v;
  }
  return Math.min(best, d.belt - 0.13);
}

function halfWidthAt(d: CarDesign, z: number): number {
  const nose = d.length * 0.5;
  const tail = -d.length * 0.5;
  let hw = d.halfWidth;
  const nFade = d.length * 0.14;
  const tFade = d.length * 0.13;
  if (z > nose - nFade) hw -= ((z - (nose - nFade)) / nFade) ** 1.6 * d.noseTaper * 0.5;
  if (z < tail + tFade) hw -= (((tail + tFade) - z) / tFade) ** 1.6 * d.tailTaper * 0.5;
  for (const ax of [d.frontAxleZ, d.rearAxleZ]) {
    const t = Math.max(0, 1 - Math.abs(z - ax) / (d.archRadius * 1.25));
    hw += d.archBlister * t * t;
  }
  return hw;
}

function topY(d: CarDesign, z: number): number {
  const nose = d.length * 0.5;
  const tail = -d.length * 0.5;
  if (z > nose - d.noseRound) {
    const t = (z - (nose - d.noseRound)) / d.noseRound;
    const bon = d.bonnetY + (nose - d.noseRound - d.wsBase) * d.bonnetRake;
    return bon + (d.noseY - bon) * t * t;
  }
  if (z > d.wsBase) return d.bonnetY + (z - d.wsBase) * d.bonnetRake;
  if (z > d.rsBase) return d.belt;
  if (d.rear === 'saloon') {
    if (z > tail + d.tailRound) {
      // Boot lid: rises a touch off the cabin floor line, then rounds down.
      const t = Math.min(1, (d.rsBase - z) / Math.max(0.2, d.rsBase - (tail + d.tailRound)));
      return d.belt + (d.bootY - d.belt) * Math.min(1, t * 2.2);
    }
    const t = (tail + d.tailRound - z) / d.tailRound;
    return d.bootY + (d.tailY - d.bootY) * t * t;
  }
  // hatch / estate / suv: the flank simply runs back at the belt and drops off
  // the very edge; the tailgate is the loft's rear cap.
  if (z > tail + d.tailRound) return d.belt;
  const t = (tail + d.tailRound - z) / d.tailRound;
  return d.belt + (d.tailY - d.belt) * t * t;
}

function bodyStations(d: CarDesign): Station[] {
  const nose = d.length * 0.5;
  const tail = -d.length * 0.5;
  const zs = new Set<number>();
  const push = (v: number) => zs.add(Math.round(v * 1000) / 1000);
  const range = (a: number, bb: number, n: number) => {
    for (let i = 0; i <= n; i++) push(a + ((bb - a) * i) / n);
  };
  range(tail, tail + d.tailRound, 2);
  range(tail + d.tailRound, d.rsBase, 4);
  range(d.rsBase, d.bPillarZ, 3);
  range(d.bPillarZ, d.wsBase, 3);
  range(d.wsBase, nose - d.noseRound, 4);
  range(nose - d.noseRound, nose, 2);
  // Stations exactly on the door edges, so the door cut has a clean seam.
  for (const zz of [...d.frontDoorZ, ...d.rearDoorZ]) push(zz);
  // Nine stations across each arch, not five. At five the opening is a coarse
  // polygon with a flat top, which reads as a slot cut in the flank rather than
  // as a pressed arch, and the corners of that polygon sit close enough to the
  // tyre to look like a skirt.
  for (const ax of [d.frontAxleZ, d.rearAxleZ]) {
    for (const f of [-1, -0.76, -0.5, -0.26, 0, 0.26, 0.5, 0.76, 1]) push(ax + d.archRadius * f);
  }
  return Array.from(zs)
    .filter((z) => z >= tail - 1e-6 && z <= nose + 1e-6)
    .sort((a, bb) => a - bb)
    .map((z) => ({
      z,
      hw: halfWidthAt(d, z),
      yTop: -d.rideHeight + topY(d, z),
      yBottom: -d.rideHeight + archY(d, z),
      rTop: 0.075,
      rBottom: 0.05,
    }));
}

function lowerBody(c: Ctx): DoorSlot[] {
  const { d, b } = c;
  const slots: DoorSlot[] = [];
  if (d.doorRows >= 1) {
    for (const side of [-1, 1] as const) {
      slots.push({ id: side < 0 ? 'frontLeft' : 'frontRight', side, row: 0, z0: d.frontDoorZ[0], z1: d.frontDoorZ[1], skin: new GeoBuilder(), glassB: new GeoBuilder() });
    }
  }
  if (d.doorRows >= 2) {
    for (const side of [-1, 1] as const) {
      slots.push({ id: side < 0 ? 'rearLeft' : 'rearRight', side, row: 1, z0: d.rearDoorZ[0], z1: d.rearDoorZ[1], skin: new GeoBuilder(), glassB: new GeoBuilder() });
    }
  }

  // The door skin is everything on the flank, between the sill lip and the
  // belt, inside the door's z span. Routed out of the loft entirely.
  const cutLow = c.y(d.sill + 0.055);
  const cutHigh = c.y(d.belt + 0.001);
  const route = (cx: number, cy: number, cz: number): GeoBuilder | null => {
    if (cy < cutLow || cy > cutHigh) return null;
    if (Math.abs(cx) < d.halfWidth * 0.72) return null;
    for (const s of slots) {
      if (Math.sign(cx) !== s.side) continue;
      if (cz > s.z0 && cz < s.z1) return s.skin;
    }
    return null;
  };

  b.loft(bodyStations(d), c.paint, { route });

  // Floor pan: without it the open door looks straight through the car.
  b.box(d.halfWidth * 1.62, 0.05, d.length * 0.78, T(0, c.y(d.sill + 0.03), -d.length * 0.02), {
    color: lin(0x121016), rough: 0.95, metal: 0.05,
  });

  // Wheel-well liners. An arch cut into a hollow lofted shell shows daylight
  // straight through the car; a dark liner behind the tyre is what makes the
  // arch read as a wheel well.
  // Not pure black: an arch that reads as a hole punched in the flank is as
  // wrong as one that shows daylight through the car. This is a dirty inner
  // wing that still takes a little bounce off the road.
  const liner: Surf = { color: lin(0x16141c), rough: 0.94, metal: 0.04, coat: 0 };
  for (const sx of [-1, 1]) {
    for (const az of [d.frontAxleZ, d.rearAxleZ]) {
      b.cyl(d.archRadius * 0.97, d.archRadius * 0.97, 0.09, 14,
        T(sx * (d.halfWidth - 0.055), c.y(d.wheelRadius), az, 0, 0, Math.PI / 2), liner, true);
      b.cyl(d.archRadius * 0.97, d.archRadius * 0.97, 0.02, 14,
        T(sx * (d.halfWidth - 0.10), c.y(d.wheelRadius), az, 0, 0, Math.PI / 2), liner);
    }
  }
  return slots;
}

/* ---------------- greenhouse ---------------- */

function greenhouse(c: Ctx, slots: DoorSlot[]): void {
  const { d, b, g, V } = c;
  const pillarSurf: Surf = { ...c.paint };
  const GTOP = d.height - 0.072;
  const GLASS_TOP = d.height - 0.10;
  const GLASS_BOT = d.belt + 0.045;
  const hwTop = d.hwTop;
  const hwBelt = d.hwBelt;

  /* roof panel, crowned, with the drip rail built in */
  const roofBackZ = d.rear === 'saloon' ? d.rsTop : d.rsTop - 0.04;
  const roofStations: Station[] = [
    { z: roofBackZ - 0.03, hw: hwTop - 0.05, yTop: c.y(d.height - 0.024), yBottom: c.y(d.height - 0.135), rTop: 0.055, rBottom: 0.03 },
    { z: roofBackZ + (d.wsTop - roofBackZ) * 0.22, hw: hwTop, yTop: c.y(d.height - 0.002), yBottom: c.y(d.height - 0.135), rTop: 0.06, rBottom: 0.03 },
    { z: (roofBackZ + d.wsTop) * 0.5, hw: hwTop + 0.010, yTop: c.y(d.height + d.roofCrown), yBottom: c.y(d.height - 0.135), rTop: 0.06, rBottom: 0.03 },
    { z: roofBackZ + (d.wsTop - roofBackZ) * 0.78, hw: hwTop, yTop: c.y(d.height - 0.002), yBottom: c.y(d.height - 0.135), rTop: 0.06, rBottom: 0.03 },
    { z: d.wsTop + 0.03, hw: hwTop - 0.05, yTop: c.y(d.height - 0.024), yBottom: c.y(d.height - 0.135), rTop: 0.055, rBottom: 0.03 },
  ];
  b.loft(roofStations, pillarSurf);

  const pillarW = d.brightwork ? 0.042 : 0.056;
  for (const sx of [-1, 1] as const) {
    // A pillar: scuttle → roof rail, leaning back. `strut` derives the lean
    // from the endpoints so it can never be inverted.
    b.strut(V(sx * (hwBelt - 0.028), d.belt - 0.02, d.wsBase), V(sx * (hwTop - 0.01), GTOP, d.wsTop), pillarW, pillarW * 1.8, pillarSurf);
    // B pillar: upright, thickest.
    if (d.doorRows >= 2) {
      b.strut(V(sx * hwBelt, d.belt - 0.03, d.bPillarZ), V(sx * (hwTop + 0.006), GTOP, d.bPillarZ), pillarW + 0.006, pillarW * 2.0, pillarSurf);
    }
    // C pillar: leans forward on a saloon, back on a hatch/estate.
    b.strut(V(sx * (hwBelt - 0.012), d.belt - 0.02, d.rsBase), V(sx * (hwTop - 0.02), GTOP, d.rsTop), pillarW, pillarW * (d.rear === 'saloon' ? 3.6 : 2.4), pillarSurf);
    // header rail + belt rail
    b.strut(V(sx * (hwTop + 0.004), GTOP - 0.012, d.wsTop - 0.02), V(sx * (hwTop + 0.004), GTOP - 0.012, d.rsTop + 0.02), 0.05, 0.05, pillarSurf);
    b.strut(V(sx * hwBelt, d.belt + 0.012, d.wsBase - 0.03), V(sx * hwBelt, d.belt + 0.012, d.rsBase + 0.03), 0.052, 0.058, pillarSurf);
    // rain gutter
    b.strut(V(sx * (hwTop + 0.019), d.height - 0.052, d.rsTop - 0.02), V(sx * (hwTop + 0.019), d.height - 0.052, d.wsTop + 0.02), 0.026, 0.026, c.trim);
  }

  if (d.brightwork) {
    for (const sx of [-1, 1] as const) {
      b.strut(V(sx * (hwBelt + 0.019), d.belt + 0.040, d.wsBase - 0.05), V(sx * (hwBelt + 0.019), d.belt + 0.040, d.rsBase + 0.05), 0.019, 0.024, c.chrome);
      b.strut(V(sx * (hwTop + 0.021), GTOP - 0.030, d.wsTop + 0.01), V(sx * (hwTop + 0.021), GTOP - 0.030, d.rsTop - 0.01), 0.019, 0.022, c.chrome);
      b.strut(V(sx * (hwBelt - 0.021), d.belt + 0.02, d.wsBase + 0.012), V(sx * (hwTop - 0.004), GTOP - 0.02, d.wsTop + 0.012), 0.021, 0.022, c.chrome);
      b.strut(V(sx * (hwBelt - 0.006), d.belt + 0.02, d.rsBase - 0.012), V(sx * (hwTop - 0.014), GTOP - 0.02, d.rsTop - 0.012), 0.021, 0.022, c.chrome);
    }
    b.strut(V(-hwTop * 0.86, d.belt + 0.026, d.wsBase + 0.012), V(hwTop * 0.86, d.belt + 0.026, d.wsBase + 0.012), 0.022, 0.024, c.chrome);
    b.strut(V(-hwTop * 0.82, GTOP - 0.022, d.wsTop + 0.012), V(hwTop * 0.82, GTOP - 0.022, d.wsTop + 0.012), 0.022, 0.024, c.chrome);
    b.strut(V(-hwTop * 0.88, d.belt + 0.026, d.rsBase - 0.012), V(hwTop * 0.88, d.belt + 0.026, d.rsBase - 0.012), 0.022, 0.024, c.chrome);
    b.strut(V(-hwTop * 0.84, GTOP - 0.022, d.rsTop - 0.012), V(hwTop * 0.84, GTOP - 0.022, d.rsTop - 0.012), 0.022, 0.024, c.chrome);
  } else {
    // Modern cars: black rubber surrounds instead of chrome.
    for (const sx of [-1, 1] as const) {
      b.strut(V(sx * (hwBelt + 0.012), d.belt + 0.038, d.wsBase - 0.05), V(sx * (hwBelt + 0.012), d.belt + 0.038, d.rsBase + 0.05), 0.016, 0.026, c.trim);
    }
  }

  /* glass
   *
   * The screens must reach the PILLARS. Cut them to a fraction of the roof
   * width and the gap between the glass edge and the A pillar is an open slot
   * you can see straight through into the cabin — which is exactly how this
   * car ended up looking as though it had no windscreen at all.
   */
  const wsBotHW = hwBelt - 0.030;
  const wsTopHW = hwTop - 0.028;
  g.quad(
    V(-wsBotHW, GLASS_BOT, d.wsBase), V(wsBotHW, GLASS_BOT, d.wsBase),
    V(wsTopHW, GLASS_TOP, d.wsTop), V(-wsTopHW, GLASS_TOP, d.wsTop), c.glassSurf,
  );
  const rsBotHW = hwBelt - 0.030;
  const rsTopHW = hwTop - 0.030;
  g.quad(
    V(rsBotHW, GLASS_BOT, d.rsBase), V(-rsBotHW, GLASS_BOT, d.rsBase),
    V(-rsTopHW, GLASS_TOP, d.rsTop), V(rsTopHW, GLASS_TOP, d.rsTop), c.glassSurf,
  );
  // Header and scuttle cross members, on every car — these are what close the
  // top and bottom of each screen aperture.
  b.strut(V(-wsBotHW, d.belt + 0.012, d.wsBase), V(wsBotHW, d.belt + 0.012, d.wsBase), 0.05, 0.055, pillarSurf);
  b.strut(V(-wsTopHW, GTOP - 0.012, d.wsTop), V(wsTopHW, GTOP - 0.012, d.wsTop), 0.05, 0.05, pillarSurf);
  b.strut(V(-rsBotHW, d.belt + 0.012, d.rsBase), V(rsBotHW, d.belt + 0.012, d.rsBase), 0.05, 0.055, pillarSurf);
  b.strut(V(-rsTopHW, GTOP - 0.012, d.rsTop), V(rsTopHW, GTOP - 0.012, d.rsTop), 0.05, 0.05, pillarSurf);

  /* side glass — it belongs to the DOORS, so it swings with them */
  const gx = d.glassX;
  const frameSurf: Surf = d.brightwork ? c.chrome : c.trim;
  for (const s of slots) {
    const x = s.side * gx;
    const z0 = s.z0 + (s.row === 1 ? 0.05 : 0.0);
    const z1 = s.z1 - 0.02;
    const topFront = s.row === 0
      ? d.wsTop + (d.wsBase - d.wsTop) * 0.10
      : d.bPillarZ;
    const topRear = s.row === 0 ? d.bPillarZ : d.rsTop + 0.02;
    const gb = s.glassB;
    const a = V(x, GLASS_BOT, z0), bb = V(x, GLASS_BOT, z1);
    const cc = V(x, GLASS_TOP, Math.min(z1, topFront));
    const dd = V(x, GLASS_TOP, Math.max(z0, topRear));
    if (s.side > 0) gb.quad(a, bb, cc, dd, c.glassSurf);
    else gb.quad(dd, cc, bb, a, c.glassSurf);
    // window frame around the pane, on the door
    const fx = s.side * (gx + 0.016);
    s.skin.strut(V(fx, GLASS_BOT - 0.012, z0), V(fx, GLASS_BOT - 0.012, z1), 0.016, 0.02, frameSurf);
    s.skin.strut(V(fx, GLASS_TOP + 0.008, Math.max(z0, topRear)), V(fx, GLASS_TOP + 0.008, Math.min(z1, topFront)), 0.016, 0.018, frameSurf);
    s.skin.strut(V(fx, GLASS_BOT, z0 + 0.006), V(fx, GLASS_TOP, Math.max(z0, topRear)), 0.016, 0.018, frameSurf);
    s.skin.strut(V(fx, GLASS_BOT, z1 - 0.006), V(fx, GLASS_TOP, Math.min(z1, topFront)), 0.016, 0.018, frameSurf);
  }

  // Three-door cars keep a fixed rear quarter window in the body.
  if (d.doorRows === 1) {
    const [qz0, qz1] = d.rearDoorZ;
    for (const sx of [-1, 1] as const) {
      const x = sx * gx;
      const a = V(x, GLASS_BOT, qz0 + 0.10), bb = V(x, GLASS_BOT, qz1);
      const cc = V(x, GLASS_TOP - 0.02, qz1), dd = V(x, GLASS_TOP - 0.06, qz0 + 0.26);
      if (sx > 0) g.quad(a, bb, cc, dd, c.glassSurf); else g.quad(dd, cc, bb, a, c.glassSurf);
      const fx = sx * (gx + 0.014);
      b.strut(V(fx, GLASS_BOT - 0.012, qz0 + 0.10), V(fx, GLASS_BOT - 0.012, qz1), 0.014, 0.02, frameSurf);
      b.strut(V(fx, GLASS_TOP - 0.06, qz0 + 0.26), V(fx, GLASS_TOP - 0.02, qz1), 0.014, 0.018, frameSurf);
      b.strut(V(fx, GLASS_BOT, qz0 + 0.11), V(fx, GLASS_TOP - 0.06, qz0 + 0.26), 0.014, 0.018, frameSurf);
    }
  }

  // Fixed quarter-light in the front door (a 1300 signature) sits on the door.
  if (d.quarterLight) {
    for (const s of slots) {
      if (s.row !== 0) continue;
      const zq = s.z1 - (s.z1 - s.z0) * 0.30;
      s.skin.strut(V(s.side * (gx + 0.018), GLASS_BOT - 0.01, zq), V(s.side * (gx + 0.018), GLASS_TOP + 0.01, zq + 0.055), 0.017, 0.02, frameSurf);
    }
  }

  /* wipers */
  for (const wx of [-0.34, 0.20]) {
    b.box(0.015, 0.011, d.width * 0.26, T(wx * d.width * 0.9, c.y(d.belt + 0.05), d.wsBase - 0.14, -0.32, 0.22, 0), {
      color: BLACK_TRIM, rough: 0.55, metal: 0.2, coat: 0.2,
    });
  }
}

/* ---------------- interior ---------------- */

function interior(c: Ctx): void {
  const { d, b, s } = c;
  const seatSurf: Surf = { color: s.interior, rough: 0.84, metal: 0.02, uv: UV.fabric };
  const dashSurf: Surf = { color: s.interior.clone().lerp(lin(0x141018), 0.62), rough: 0.72, metal: 0.05, uv: UV.dash };
  const carpet: Surf = { color: lin(0x2a2430), rough: 0.95, metal: 0, uv: UV.carpet };
  const plastic: Surf = { color: lin(0x1b1620), rough: 0.75, metal: 0.05 };
  const cabinZ = (d.wsBase + d.rsBase) * 0.5;
  const floor = d.sill + 0.10;
  const seatY = floor + 0.14;

  // Inner door cards + bulkheads. NOT a solid box: the seats live in here and
  // a box would swallow them. Two side panels and a rear bulkhead are enough
  // to stop an open door showing daylight through the far side of the car.
  const cardX = d.halfWidth - 0.15;
  const cabinLen = Math.abs(d.wsBase - d.rsBase);
  for (const sx of [-1, 1]) {
    b.box(0.035, d.belt - floor + 0.02, cabinLen + 0.4,
      T(sx * cardX, c.y((floor + d.belt) * 0.5 + 0.01), cabinZ),
      { color: s.interior.clone().lerp(lin(0x14111a), 0.35), rough: 0.86, metal: 0.02, uv: UV.fabric });
  }
  b.box(cardX * 2, d.belt - floor + 0.02, 0.05,
    T(0, c.y((floor + d.belt) * 0.5 + 0.01), d.rsBase - 0.02), { color: CABIN_SHADOW, rough: 0.95, metal: 0 });
  b.box(cardX * 2, d.belt - floor + 0.02, 0.05,
    T(0, c.y((floor + d.belt) * 0.5 + 0.01), d.wsBase + 0.06), { color: CABIN_SHADOW, rough: 0.95, metal: 0 });

  // carpet + parcel shelf
  b.box(d.halfWidth * 1.5, 0.035, Math.abs(d.wsBase - d.rsBase) + 0.6, T(0, c.y(floor + 0.03), cabinZ), carpet);
  if (d.rear === 'saloon') {
    b.box(d.halfWidth * 1.4, 0.03, 0.42, T(0, c.y(d.belt - 0.02), d.rsBase + 0.22), { ...seatSurf, uv: UV.carpet });
  }

  // dashboard, with a faintly glowing instrument pack
  b.box(d.halfWidth * 1.62, 0.19, 0.30, T(0, c.y(d.belt - 0.09), d.wsBase - 0.20, 0.22, 0, 0), dashSurf);
  b.box(d.halfWidth * 1.62, 0.06, 0.22, T(0, c.y(d.belt - 0.20), d.wsBase - 0.31), plastic);
  b.box(0.40, 0.12, 0.02, T(-d.halfWidth * 0.4, c.y(d.belt - 0.075), d.wsBase - 0.34), {
    color: lin(0xffb060), rough: 0.4, metal: 0, uv: UV.dash, light: L.cabin,
  });

  // steering wheel (LHD) + column
  const wx = -d.halfWidth * 0.42, wy = c.y(d.belt - 0.10), wz = d.wsBase - 0.46;
  b.torus(d.width * 0.098, 0.016, 5, 14, Math.PI * 2, T(wx, wy, wz, Math.PI / 2 - 0.42, 0, 0), { color: lin(0x171219), rough: 0.6, metal: 0.05 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    b.box(0.02, d.width * 0.09, 0.012, T(wx + Math.cos(a) * 0.075, wy + Math.sin(a) * 0.07, wz + Math.sin(a) * 0.03, Math.PI / 2 - 0.42, 0, a), plastic);
  }
  b.cyl(0.026, 0.03, 0.26, 6, T(wx, wy - 0.09, wz + 0.08, 0.42, 0, 0), plastic);

  // seats
  const seatX = d.halfWidth * 0.42;
  const seatW = Math.min(0.48, d.halfWidth * 0.62);
  const frontZ = cabinZ + (d.wsBase - d.rsBase) * 0.16;
  const seat = (sx: number, sz: number, backH: number) => {
    b.box(seatW, 0.13, 0.46, T(sx, c.y(seatY), sz), seatSurf);
    b.box(seatW, backH, 0.13, T(sx, c.y(seatY + backH * 0.5), sz - 0.25, -0.15, 0, 0), seatSurf);
    b.box(seatW * 0.58, 0.12, 0.10, T(sx, c.y(seatY + backH + 0.04), sz - 0.31), seatSurf);
  };
  seat(-seatX, frontZ, 0.46);
  seat(seatX, frontZ, 0.46);
  if (d.seats > 2) {
    const rearZ = cabinZ - (d.wsBase - d.rsBase) * 0.22;
    b.box(d.halfWidth * 1.4, 0.13, 0.44, T(0, c.y(seatY - 0.02), rearZ), seatSurf);
    b.box(d.halfWidth * 1.4, 0.44, 0.13, T(0, c.y(seatY + 0.20), rearZ - 0.24, -0.14, 0, 0), seatSurf);
  }

  // tunnel, lever, handbrake
  b.box(0.24, 0.16, Math.abs(d.wsBase - d.rsBase) * 0.8, T(0, c.y(floor + 0.09), cabinZ + 0.1), carpet);
  b.cyl(0.013, 0.017, 0.22, 6, T(0, c.y(floor + 0.24), frontZ + 0.20, 0.2, 0, 0), plastic);
  b.sphere(0.024, 8, T(0, c.y(floor + 0.35), frontZ + 0.22), { color: lin(0x0f0c12), rough: 0.5, metal: 0.1 });

  // headliner + mirror
  b.box(d.hwTop * 1.7, 0.028, Math.abs(d.wsTop - d.rsTop) * 0.94, T(0, c.y(d.height - 0.108), (d.wsTop + d.rsTop) * 0.5), { color: lin(0x3c3444), rough: 0.9, metal: 0 });
  b.box(0.17, 0.045, 0.02, T(0, c.y(d.height - 0.185), d.wsTop + (d.wsBase - d.wsTop) * 0.26, -0.2, 0, 0), { color: lin(0x1a1620), rough: 0.5, metal: 0.2 });
}

/* ---------------- front end ---------------- */

function frontEnd(c: Ctx): void {
  const { d, b, V } = c;
  const zF = c.nose + 0.045;
  const hw = halfWidthAt(d, c.nose - 0.10);
  const lampY = d.belt - (d.belt - d.sill) * 0.42;
  const chrome = c.chrome, chromeDull = c.chromeDull, trim = c.trim;
  const bumperChrome = d.bumpers === 'chrome';
  const bumperSurf: Surf = bumperChrome ? chrome
    : d.bumpers === 'bodyPlastic' ? { ...c.paint, coat: 0.7, rough: 0.36 }
      : { color: DARK_PLASTIC, rough: 0.72, metal: 0.06, coat: 0.12 };

  /* --- grille --- */
  const grilleW = hw * 1.34;
  const grilleH = d.grille === 'suvBar' ? 0.24 : d.grille === 'fineSlats' ? 0.22 : 0.17;
  const grilleY = lampY + (d.grille === 'modernBar' ? 0.02 : 0);
  b.box(grilleW, grilleH, 0.05, T(0, c.y(grilleY), zF - 0.03), {
    color: d.grille === 'fineSlats' ? lin(0x22222a) : lin(0x16161c),
    rough: 0.5, metal: 0.35, coat: 0.3, uv: UV.grille,
  });
  if (d.grille === 'fineSlats') {
    /**
     * Dacia 1300: a FINE horizontal-slat grille inside a bright chrome frame.
     *
     * The previous version had five slats across a near-black panel, which at
     * any real distance collapsed into one dark rectangle — the "dark slat
     * grille" the review objected to. A 1300's grille is charcoal, not black,
     * and the slat pitch is fine enough that it reads as texture rather than
     * as five bars.
     */
    b.box(grilleW + 0.07, 0.032, 0.058, T(0, c.y(grilleY + grilleH * 0.5 + 0.016), zF - 0.018), chrome);
    b.box(grilleW + 0.07, 0.032, 0.058, T(0, c.y(grilleY - grilleH * 0.5 - 0.016), zF - 0.018), chrome);
    for (const sx of [-1, 1]) b.box(0.028, grilleH + 0.064, 0.058, T(sx * (grilleW * 0.5 + 0.016), c.y(grilleY), zF - 0.018), chrome);
    const slats = 11;
    for (let i = 0; i < slats; i++) {
      const t = (i + 0.5) / slats - 0.5;
      b.box(grilleW * 0.985, 0.0065, 0.054, T(0, c.y(grilleY + t * grilleH * 0.92), zF - 0.016), chromeDull);
    }
    // Dacia badge: a black centre plinth flanked by two uprights, with a small
    // chrome shield on it — the 1300's grille is split down the middle.
    b.box(0.105, grilleH * 0.96, 0.052, T(0, c.y(grilleY), zF - 0.014), { color: lin(0x0b0b10), rough: 0.62, metal: 0.25 });
    for (const bx of [-1, 1]) {
      b.box(0.016, grilleH * 0.96, 0.05, T(bx * 0.068, c.y(grilleY), zF - 0.012), { color: lin(0x0b0b10), rough: 0.62, metal: 0.25 });
    }
    b.box(0.052, 0.062, 0.05, T(0, c.y(grilleY + grilleH * 0.12), zF - 0.004), chrome);
  } else if (d.grille === 'blackSlats') {
    for (let i = 0; i < 4; i++) {
      b.box(grilleW * 0.98, 0.013, 0.05, T(0, c.y(grilleY - grilleH * 0.34 + i * grilleH * 0.23), zF - 0.016), { color: lin(0x2a2a33), rough: 0.55, metal: 0.3 });
    }
    b.box(grilleW + 0.04, 0.022, 0.05, T(0, c.y(grilleY + grilleH * 0.5), zF - 0.02), trim);
  } else if (d.grille === 'modernBar') {
    b.box(grilleW, 0.045, 0.055, T(0, c.y(grilleY + grilleH * 0.16), zF - 0.012), chromeDull);
    b.box(0.13, 0.10, 0.05, T(0, c.y(grilleY + grilleH * 0.16), zF - 0.004), chrome);
    // lower intake in the bumper
    b.box(hw * 1.1, 0.13, 0.05, T(0, c.y(lampY - 0.34), zF - 0.02), { color: lin(0x101014), rough: 0.6, metal: 0.2, uv: UV.grille });
  } else if (d.grille === 'suvBar') {
    for (let i = 0; i < 3; i++) {
      b.box(grilleW * 0.97, 0.032, 0.056, T(0, c.y(grilleY - grilleH * 0.3 + i * grilleH * 0.3), zF - 0.012), chromeDull);
    }
    b.box(0.15, 0.11, 0.05, T(0, c.y(grilleY), zF - 0.004), chrome);
    b.box(hw * 1.2, 0.15, 0.05, T(0, c.y(lampY - 0.36), zF - 0.02), { color: lin(0x101014), rough: 0.6, metal: 0.2, uv: UV.grille });
  } else {
    b.box(grilleW, grilleH * 0.5, 0.05, T(0, c.y(grilleY), zF - 0.014), { color: lin(0x1a1a22), rough: 0.62, metal: 0.2, uv: UV.grille });
  }

  /* --- lamps --- */
  const lampX = hw - 0.20;
  for (const sx of [-1, 1] as const) {
    const x = sx * lampX;
    const indL = sx < 0 ? L.indL : L.indR;
    switch (d.lamps) {
      case 'rect1300': {
        /**
         * The 1300's face, per `docs/reference/world/dacia-1300.jpg`:
         * a RECTANGULAR outboard headlamp ringed by a BRIGHT CHROME SURROUND,
         * a ROUND auxiliary lamp standing proud of the grille below it, and an
         * amber indicator in the outer corner.
         *
         * The surround is built as four chrome bars around the aperture rather
         * than as one chrome slab behind the lens. A slab is hidden by the lens
         * it is supposed to frame, which is exactly how this ended up reading
         * as "a white block": no visible bezel, no lamp, just a pale rectangle.
         */
        const lw = 0.155, lh = 0.058;   // lens half-extents
        const bez = 0.020;              // chrome frame thickness
        const zBez = zF - 0.006;
        const ly = lampY + 0.035;
        // Four-sided chrome surround, standing 12 mm proud of the lens.
        b.box(lw * 2 + bez * 2, bez, 0.062, T(x, c.y(ly + lh + bez * 0.5), zBez), chrome);
        b.box(lw * 2 + bez * 2, bez, 0.062, T(x, c.y(ly - lh - bez * 0.5), zBez), chrome);
        for (const ex of [-1, 1]) {
          b.box(bez, lh * 2 + bez * 2, 0.062, T(x + ex * (lw + bez * 0.5), c.y(ly), zBez), chrome);
        }
        // Dark reflector housing, so the lens has something behind it and does
        // not float as a white rectangle painted on the wing.
        b.box(lw * 2, lh * 2, 0.05, T(x, c.y(ly), zF - 0.030), { color: lin(0x101016), rough: 0.35, metal: 0.5 });
        // Fluted glass. Dimmer than white by day — it is glass over a silvered
        // reflector, and the emissive channel is what makes it a LAMP at dusk.
        b.box(lw * 2 - 0.008, lh * 2 - 0.008, 0.052, T(x, c.y(ly), zF - 0.014), {
          color: lin(0xb9c2cf), rough: 0.055, metal: 0.15, coat: 0.95, uv: UV.headlampGlass, light: L.head,
        });
        // Chrome centre bar across the lens — the 1300's lamps are split.
        b.box(lw * 2 - 0.02, 0.008, 0.056, T(x, c.y(ly), zF - 0.004), chromeDull);

        // ROUND auxiliary lamp, inboard and low.
        //
        // It has to stand IN FRONT OF THE BUMPER, not level with the grille.
        // The chrome bumper face is 0.088 proud of `zF`, so an auxiliary at
        // `zF + 0.026` is buried in it up to its axle and renders as a chrome
        // semicircle — which is what it was doing.
        const auxX = x - sx * 0.062;
        const auxY = lampY - 0.115;
        const auxZ = zF + 0.086;
        b.box(0.026, 0.075, 0.05, T(auxX, c.y(auxY + 0.05), auxZ - 0.045), chromeDull);   // bracket
        b.torus(0.062, 0.017, 5, 14, Math.PI * 2, T(auxX, c.y(auxY), auxZ + 0.012), chrome);
        b.cyl(0.058, 0.050, 0.062, 14, T(auxX, c.y(auxY), auxZ - 0.012, Math.PI / 2, 0, 0), {
          color: lin(0xc6cfdd), rough: 0.06, metal: 0.1, coat: 0.95, uv: UV.headlampGlass, light: L.head,
        });
        // amber indicator in the outer corner, under the headlamp
        b.box(0.095, 0.07, 0.05, T(sx * (hw - 0.035), c.y(lampY - 0.055), zF - 0.010), {
          color: LENS_AMBER, rough: 0.12, metal: 0.03, coat: 0.85, uv: UV.tailLens, light: indL,
        });
        b.box(0.105, 0.012, 0.052, T(sx * (hw - 0.035), c.y(lampY - 0.096), zF - 0.010), chromeDull);
        break;
      }
      case 'rect1310': {
        b.box(0.36, 0.15, 0.05, T(x - sx * 0.02, c.y(lampY + 0.03), zF - 0.012), trim);
        b.box(0.325, 0.115, 0.06, T(x - sx * 0.02, c.y(lampY + 0.04), zF - 0.004), {
          color: LAMP_WHITE, rough: 0.07, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
        });
        b.box(0.325, 0.05, 0.055, T(x - sx * 0.02, c.y(lampY - 0.045), zF - 0.006), {
          color: LENS_AMBER, rough: 0.12, metal: 0.03, coat: 0.85, uv: UV.tailLens, light: indL,
        });
        break;
      }
      case 'roundTwin': {
        b.torus(0.098, 0.02, 5, 14, Math.PI * 2, T(x, c.y(lampY + 0.03), zF - 0.006), chrome);
        b.cyl(0.09, 0.086, 0.05, 14, T(x, c.y(lampY + 0.03), zF - 0.026, Math.PI / 2, 0, 0), {
          color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
        });
        b.box(0.11, 0.07, 0.045, T(sx * (hw - 0.045), c.y(lampY - 0.05), zF - 0.012), {
          color: LENS_AMBER, rough: 0.12, metal: 0.03, coat: 0.85, uv: UV.tailLens, light: indL,
        });
        break;
      }
      case 'ovalSoft': {
        b.box(0.34, 0.13, 0.05, T(x - sx * 0.01, c.y(lampY + 0.045), zF - 0.012, 0, sx * 0.10, sx * 0.05), trim);
        b.box(0.305, 0.10, 0.06, T(x - sx * 0.01, c.y(lampY + 0.05), zF - 0.004, 0, sx * 0.10, sx * 0.05), {
          color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
        });
        b.box(0.10, 0.07, 0.045, T(sx * (hw - 0.05), c.y(lampY - 0.01), zF - 0.014, 0, sx * 0.18, 0), {
          color: LENS_AMBER, rough: 0.12, metal: 0.03, coat: 0.85, uv: UV.tailLens, light: indL,
        });
        break;
      }
      case 'sweptModern': {
        // Long wrap-around cluster: clear lens, amber repeater at the outer end.
        b.box(0.40, 0.145, 0.10, T(x - sx * 0.02, c.y(lampY + 0.075), zF - 0.02, 0, sx * 0.20, sx * 0.06), trim);
        b.box(0.365, 0.115, 0.10, T(x - sx * 0.02, c.y(lampY + 0.08), zF - 0.012, 0, sx * 0.20, sx * 0.06), {
          color: LAMP_WHITE, rough: 0.055, metal: 0.02, coat: 0.95, uv: UV.headlampGlass, light: L.head,
        });
        b.box(0.10, 0.10, 0.08, T(sx * (hw - 0.055), c.y(lampY + 0.055), zF - 0.05, 0, sx * 0.34, 0), {
          color: LENS_AMBER, rough: 0.12, metal: 0.03, coat: 0.85, uv: UV.tailLens, light: indL,
        });
        // fog lamp in the bumper
        b.cyl(0.045, 0.043, 0.04, 10, T(sx * (hw - 0.26), c.y(lampY - 0.36), zF - 0.03, Math.PI / 2, 0, 0), {
          color: LENS_CLEAR, rough: 0.1, metal: 0.05, coat: 0.9, light: L.aux,
        });
        break;
      }
      case 'suvStack': {
        b.box(0.34, 0.24, 0.10, T(x - sx * 0.01, c.y(lampY + 0.10), zF - 0.02, 0, sx * 0.16, 0), trim);
        b.box(0.30, 0.135, 0.10, T(x - sx * 0.01, c.y(lampY + 0.145), zF - 0.012, 0, sx * 0.16, 0), {
          color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
        });
        b.box(0.30, 0.06, 0.09, T(x - sx * 0.01, c.y(lampY + 0.035), zF - 0.014, 0, sx * 0.16, 0), {
          color: LENS_AMBER, rough: 0.12, metal: 0.03, coat: 0.85, uv: UV.tailLens, light: indL,
        });
        b.cyl(0.05, 0.048, 0.04, 10, T(sx * (hw - 0.30), c.y(lampY - 0.34), zF - 0.03, Math.PI / 2, 0, 0), {
          color: LENS_CLEAR, rough: 0.1, metal: 0.05, coat: 0.9, light: L.aux,
        });
        break;
      }
    }
  }

  /* --- bumper --- */
  const bumperY = d.sill + (d.belt - d.sill) * 0.30;
  if (bumperChrome) {
    b.box(hw * 1.96, 0.10, 0.095, T(0, c.y(bumperY), zF + 0.04), bumperSurf);
    b.box(hw * 1.96, 0.042, 0.05, T(0, c.y(bumperY - 0.055), zF + 0.025), chromeDull);
    for (const sx of [-1, 1]) {
      // rubber-faced overriders — slim, and mostly rubber from the front
      b.box(0.062, 0.175, 0.075, T(sx * hw * 0.46, c.y(bumperY + 0.028), zF + 0.048), chrome);
      b.box(0.052, 0.155, 0.035, T(sx * hw * 0.46, c.y(bumperY + 0.028), zF + 0.088), c.rubber);
      b.box(0.095, 0.10, 0.20, T(sx * (hw - 0.04), c.y(bumperY), zF - 0.055), chromeDull);
    }
  } else {
    const h = d.bumpers === 'cladding' ? 0.30 : 0.24;
    b.box(hw * 1.98, h, 0.15, T(0, c.y(bumperY - 0.01), zF - 0.005), bumperSurf);
    if (d.bumpers === 'cladding') {
      b.box(hw * 1.86, 0.10, 0.13, T(0, c.y(bumperY - 0.17), zF + 0.01), { color: lin(0x9aa0aa), rough: 0.42, metal: 0.55, coat: 0.3 });
    }
    if (d.bumpers === 'blackPlastic') {
      b.box(hw * 2.0, 0.04, 0.14, T(0, c.y(bumperY + 0.10), zF + 0.005), { color: lin(0x0d0d12), rough: 0.85, metal: 0.02 });
    }
  }
  // valance + plate
  b.box(hw * 1.7, 0.12, 0.05, T(0, c.y(bumperY - 0.15), zF - 0.03), trim);
  b.box(0.44, 0.11, 0.012, T(0, c.y(bumperY - 0.045), zF + 0.075), {
    color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate,
  });

  /* --- bonnet detail --- */
  b.box(hw * 1.5, 0.007, 0.011, T(0, c.y(topY(d, d.wsBase - 0.02) + 0.005), c.nose - d.noseRound - 0.35), trim);
  for (const sx of [-1, 1]) {
    b.box(0.011, 0.007, (c.nose - d.wsBase) * 0.86, T(sx * hw * 0.76, c.y(d.bonnetY - 0.005), (c.nose + d.wsBase) * 0.5), trim);
  }
  if (d.cowlVents) {
    for (let i = 0; i < 7; i++) {
      b.box(0.05, 0.006, 0.10, T(-hw * 0.42 + i * 0.075, c.y(d.bonnetY + 0.004), d.wsBase + 0.10), { color: lin(0x101016), rough: 0.8, metal: 0.1, uv: UV.vent });
    }
  }
  void V;
}

/* ---------------- rear end ---------------- */

function rearEnd(c: Ctx): void {
  const { d, b } = c;
  const zR = c.tail - 0.045;
  const hw = halfWidthAt(d, c.tail + 0.12);
  const chrome = c.chrome, chromeDull = c.chromeDull, trim = c.trim;
  const lampY = d.rear === 'saloon' ? d.belt - 0.17 : d.belt - 0.10;
  const bumperY = d.sill + (d.belt - d.sill) * 0.28;
  const bumperChrome = d.bumpers === 'chrome';

  // rear panel between the lamps
  b.box(hw * 1.36, 0.22, 0.045, T(0, c.y(lampY), zR + 0.03), { color: BLACK_TRIM, rough: 0.65, metal: 0.2 });

  for (const sx of [-1, 1] as const) {
    const x = sx * (hw - 0.20);
    const indL = sx < 0 ? L.indL : L.indR;
    if (d.rear === 'saloon' && (d.lamps === 'rect1300' || d.lamps === 'rect1310' || d.lamps === 'roundTwin')) {
      // Three-segment 70s cluster: amber / red / white in a chrome frame.
      b.box(0.30, 0.185, 0.05, T(x, c.y(lampY), zR - 0.004), { color: BLACK_TRIM, rough: 0.6, metal: 0.3 });
      b.box(0.285, 0.10, 0.045, T(x, c.y(lampY + 0.036), zR - 0.018), {
        color: LENS_RED, rough: 0.09, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
      });
      b.box(0.135, 0.06, 0.045, T(x - sx * 0.072, c.y(lampY - 0.054), zR - 0.018), {
        color: LENS_AMBER, rough: 0.1, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: indL,
      });
      b.box(0.115, 0.06, 0.045, T(x + sx * 0.082, c.y(lampY - 0.054), zR - 0.018), {
        color: LENS_CLEAR, rough: 0.09, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.reverse,
      });
      b.box(0.315, 0.018, 0.048, T(x, c.y(lampY + 0.098), zR - 0.012), chromeDull);
    } else {
      // Modern cluster: shallow, hugging the corner, wrapping a little onto
      // the flank. Depth here is what used to make it read as a billboard
      // bolted to the back of the car.
      const th = d.rear === 'saloon' ? 0.22 : 0.36;
      const lx = sx * (hw - 0.12);
      const ly = lampY + th * 0.18;
      b.box(0.20, th, 0.05, T(lx, c.y(ly), zR + 0.012, 0, sx * 0.16, 0), trim);
      b.box(0.17, th * 0.50, 0.05, T(lx, c.y(ly + th * 0.20), zR + 0.020, 0, sx * 0.16, 0), {
        color: LENS_RED, rough: 0.09, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
      });
      b.box(0.17, th * 0.19, 0.05, T(lx, c.y(ly - th * 0.14), zR + 0.020, 0, sx * 0.16, 0), {
        color: LENS_AMBER, rough: 0.1, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: indL,
      });
      b.box(0.17, th * 0.15, 0.05, T(lx, c.y(ly - th * 0.34), zR + 0.020, 0, sx * 0.16, 0), {
        color: LENS_CLEAR, rough: 0.09, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.reverse,
      });
      // wrap onto the quarter panel — shallow, or it reads as a fin
      b.box(0.028, th * 0.60, 0.085, T(sx * (hw + 0.006), c.y(ly + th * 0.10), zR + 0.075), {
        color: LENS_RED, rough: 0.1, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
      });
    }
  }

  // bumper
  if (bumperChrome) {
    b.box(hw * 1.92, 0.095, 0.09, T(0, c.y(bumperY), zR - 0.035), chrome);
    b.box(hw * 1.92, 0.038, 0.05, T(0, c.y(bumperY - 0.05), zR - 0.025), chromeDull);
    for (const sx of [-1, 1]) {
      b.box(0.08, 0.18, 0.08, T(sx * hw * 0.46, c.y(bumperY + 0.022), zR - 0.045), chrome);
      b.box(0.095, 0.095, 0.20, T(sx * (hw - 0.04), c.y(bumperY), zR + 0.055), chromeDull);
    }
  } else {
    const surf: Surf = d.bumpers === 'bodyPlastic'
      ? { ...c.paint, coat: 0.7, rough: 0.36 }
      : { color: DARK_PLASTIC, rough: 0.72, metal: 0.06, coat: 0.12 };
    b.box(hw * 1.96, d.bumpers === 'cladding' ? 0.30 : 0.24, 0.15, T(0, c.y(bumperY - 0.01), zR + 0.01), surf);
  }

  // plate, plate lamp, badge, shut line
  b.box(0.44, 0.11, 0.012, T(0, c.y(bumperY + 0.14), zR - 0.055), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });
  b.box(0.085, 0.028, 0.028, T(0, c.y(bumperY + 0.215), zR - 0.045), { color: LENS_CLEAR, rough: 0.2, metal: 0.1, light: L.tail });
  b.box(0.26, 0.022, 0.013, T(hw * 0.44, c.y(lampY - 0.10), zR - 0.02), chromeDull);
  if (d.rear === 'saloon') {
    b.box(hw * 1.5, 0.007, 0.011, T(0, c.y(d.bootY + 0.004), d.rsBase - 0.06), trim);
  }

  // exhaust
  const ex = -c.hw * 0.5;
  b.cyl(0.028, 0.028, 0.34, 8, T(ex, c.y(d.sill * 0.62), c.tail + 0.14, Math.PI / 2, 0, 0), { color: lin(0x4a4a52), rough: 0.5, metal: 0.85 });
  b.cyl(0.036, 0.032, 0.09, 8, T(ex, c.y(d.sill * 0.62), c.tail - 0.045, Math.PI / 2, 0, 0), { color: lin(0x2c2c33), rough: 0.62, metal: 0.7 });
  if (d.towbar) {
    b.box(0.30, 0.05, 0.05, T(0, c.y(d.sill * 0.5), c.tail - 0.05), { color: lin(0x3a3a42), rough: 0.55, metal: 0.8 });
    b.sphere(0.032, 8, T(0, c.y(d.sill * 0.5 + 0.05), c.tail - 0.09), { color: lin(0x6a6a74), rough: 0.3, metal: 0.95 });
  }
}

/* ---------------- flanks ---------------- */

function sides(c: Ctx): void {
  const { d, b } = c;
  for (const sx of [-1, 1] as const) {
    const x = sx * (d.halfWidth + d.archBlister + 0.004);
    if (d.brightwork) {
      b.box(0.018, 0.026, d.length * 0.70, T(x, c.y(d.belt - (d.belt - d.sill) * 0.34), -d.length * 0.02), c.chrome);
    }
    if (d.rubStrip) {
      b.box(0.020, 0.052, d.length * 0.70, T(x, c.y(d.belt - (d.belt - d.sill) * 0.40), -d.length * 0.02), {
        color: DARK_PLASTIC, rough: 0.8, metal: 0.04, coat: 0.05,
      });
    }
    // sill / rocker
    b.box(0.042, 0.085, d.length * 0.56, T(sx * (d.halfWidth - 0.012), c.y(d.sill + 0.025), -d.length * 0.02), {
      color: d.cladding ? lin(0x24242a) : c.s.interior.clone().lerp(lin(0x2f2a24), 0.66),
      rough: 0.9, metal: 0.08, uv: UV.bodyBattered,
    });
    /**
     * Wheel-arch lips — struck from the HUB, exactly like `archY`.
     *
     * These used to be centred on `sill * 0.92`, i.e. 0.08–0.1 m BELOW the hub,
     * with the same radius as the opening. The lip therefore did not trace the
     * arch: its crown fell below the top of the tyre and, seen from the side,
     * drew a dark arc straight across the upper third of the wheel. That is the
     * "the rear arch half-skirts the wheel" reading — the opening was open all
     * along, the trim on it was not.
     */
    for (const az of [d.frontAxleZ, d.rearAxleZ]) {
      b.torus(d.archRadius * 0.985, d.cladding ? 0.042 : 0.021, 5, 14, Math.PI * 1.06,
        T(sx * (d.halfWidth + d.archBlister), c.y(d.wheelRadius), az, 0, (Math.PI / 2) * sx, -0.03),
        d.cladding ? { color: lin(0x1e1e24), rough: 0.86, metal: 0.05 } : c.trim);
    }
    // Mirror, mounted ON the shoulder at the base of the A pillar rather than
    // hovering in space beside the glass.
    const mz = d.wsBase - 0.09;
    const my = d.belt + 0.045;
    b.strut(
      new THREE.Vector3(sx * (d.hwBelt - 0.01), c.y(my - 0.02), mz),
      new THREE.Vector3(sx * (d.halfWidth + 0.055), c.y(my + 0.03), mz - 0.01),
      0.032, 0.05, d.brightwork ? c.chromeDull : c.trim,
    );
    b.box(0.045, 0.075, 0.11, T(sx * (d.halfWidth + 0.085), c.y(my + 0.045), mz - 0.02),
      d.brightwork ? { color: CHROME_DULL, rough: 0.16, metal: 0.95, coat: 0.4 } : { ...c.paint, rough: 0.34 });
    b.box(0.016, 0.055, 0.085, T(sx * (d.halfWidth + 0.109), c.y(my + 0.045), mz - 0.02), { color: lin(0x9fb3d0), rough: 0.04, metal: 1, coat: 0.6 });
    // fuel filler
    if (sx < 0) {
      b.cyl(0.046, 0.046, 0.018, 10, T(-(d.halfWidth + 0.006), c.y(d.belt - 0.16), d.rearAxleZ - 0.34, 0, 0, Math.PI / 2), d.brightwork ? c.chrome : { ...c.paint, rough: 0.34 });
    }
    if (d.cladding) {
      b.box(0.03, 0.10, d.length * 0.5, T(sx * (d.halfWidth + 0.006), c.y(d.sill + 0.10), -d.length * 0.02), { color: lin(0x1e1e24), rough: 0.86, metal: 0.05 });
    }
    if (d.roofRails) {
      b.box(0.045, 0.045, d.length * 0.42, T(sx * d.hwTop * 0.80, c.y(d.height + 0.045), (d.wsTop + d.rsTop) * 0.5), { color: lin(0x2e2e36), rough: 0.4, metal: 0.7, coat: 0.3 });
      for (const zz of [-0.35, 0.35]) {
        b.box(0.04, 0.05, 0.05, T(sx * d.hwTop * 0.80, c.y(d.height + 0.012), (d.wsTop + d.rsTop) * 0.5 + d.length * zz * 0.38), { color: lin(0x2e2e36), rough: 0.5, metal: 0.6 });
      }
    }
  }
  // aerial
  b.cyl(0.005, 0.007, 0.52, 5, T(-d.halfWidth * 0.78, c.y(d.bonnetY + 0.28), d.wsBase + 0.16, 0.12, 0, 0.1), c.chromeDull);
}

/* ---------------- doors ---------------- */

function finishDoors(c: Ctx, slots: DoorSlot[]): DoorPart[] {
  const { d } = c;
  const out: DoorPart[] = [];
  const floor = d.sill + 0.10;
  const cabinZ = (d.wsBase + d.rsBase) * 0.5;
  const frontSeatZ = cabinZ + (d.wsBase - d.rsBase) * 0.16;
  const rearSeatZ = cabinZ - (d.wsBase - d.rsBase) * 0.22;

  for (const s of slots) {
    const hingeZ = s.z1;               // front-hinged
    const hx = s.side * d.halfWidth;
    const skin = s.skin;
    const midZ = (s.z0 + s.z1) * 0.5;
    const innerX = s.side * (d.halfWidth - 0.055);

    // Inner skin so the door has thickness and a card you can see when open.
    skin.box(0.05, d.belt - d.sill - 0.09, s.z1 - s.z0 - 0.03,
      T(innerX, c.y((d.sill + d.belt) * 0.5 + 0.03), midZ),
      { color: c.s.interior, rough: 0.86, metal: 0.02, uv: UV.fabric });
    // Armrest + window winder.
    skin.box(0.055, 0.05, (s.z1 - s.z0) * 0.42, T(innerX - s.side * 0.02, c.y(d.belt - 0.16), midZ - 0.02), {
      color: c.s.interior.clone().lerp(lin(0x120f16), 0.4), rough: 0.8, metal: 0.05,
    });
    // Exterior handle.
    const handleZ = s.z0 + (s.z1 - s.z0) * 0.24;
    const handleSurf: Surf = d.brightwork ? c.chrome : { ...c.paint, rough: 0.35 };
    skin.box(0.028, 0.032, 0.125, T(hx + s.side * 0.018, c.y(d.belt - 0.10), handleZ), handleSurf);
    skin.box(0.02, 0.018, 0.045, T(hx + s.side * 0.032, c.y(d.belt - 0.10), handleZ + 0.042), handleSurf);
    // Shut-line lip down the trailing edge, so the gap reads as a panel gap.
    skin.box(0.05, d.belt - d.sill - 0.08, 0.012, T(hx - s.side * 0.02, c.y((d.sill + d.belt) * 0.5 + 0.02), s.z0 + 0.008), c.trim);

    const hinge = new THREE.Vector3(hx, c.y((d.sill + d.belt) * 0.5), hingeZ);
    const shellGeo = skin.build();
    const glassGeo = s.glassB.build();
    shellGeo.translate(-hinge.x, -hinge.y, -hinge.z);
    glassGeo.translate(-hinge.x, -hinge.y, -hinge.z);

    out.push({
      id: s.id,
      side: s.side,
      row: s.row,
      hinge,
      shell: shellGeo,
      glass: glassGeo,
      maxAngle: 1.12,
      board: new THREE.Vector3(s.side * (d.halfWidth + 0.68), -d.rideHeight, midZ - 0.1),
      seat: new THREE.Vector3(s.side * d.halfWidth * 0.42, c.y(floor + 0.30), s.row === 0 ? frontSeatZ : rearSeatZ),
    });
  }
  return out;
}

/* ---------------- driver ---------------- */

/**
 * A driver you can see through the glass. Deliberately cheap — a torso, a head,
 * two forearms on the wheel — because at any distance where you can resolve
 * more than that you are close enough to open the door and look properly.
 */
function buildDriver(c: Ctx): THREE.BufferGeometry {
  const { d } = c;
  const b = new GeoBuilder();
  const floor = d.sill + 0.10;
  const cabinZ = (d.wsBase + d.rsBase) * 0.5;
  const sz = cabinZ + (d.wsBase - d.rsBase) * 0.16;
  const sx = -d.halfWidth * 0.42;
  const hipY = floor + 0.30;
  const skin: Surf = { color: lin(0x8a6144), rough: 0.72, metal: 0 };
  const cloth: Surf = { color: lin(0x2b3348), rough: 0.88, metal: 0.02, uv: UV.fabric };
  const hair: Surf = { color: lin(0x231a18), rough: 0.9, metal: 0 };

  // thighs, torso, head
  b.box(0.34, 0.14, 0.42, T(sx, c.y(hipY + 0.03), sz + 0.10, -0.06, 0, 0), cloth);
  b.box(0.36, 0.44, 0.22, T(sx, c.y(hipY + 0.29), sz - 0.06, -0.13, 0, 0), cloth);
  b.box(0.30, 0.10, 0.20, T(sx, c.y(hipY + 0.50), sz - 0.10), cloth);
  b.sphere(0.105, 10, T(sx, c.y(hipY + 0.62), sz - 0.10, 0, 0, 0, 1, 1.12, 1), skin);
  b.sphere(0.108, 10, T(sx, c.y(hipY + 0.655), sz - 0.115, 0, 0, 0, 1, 0.62, 1), hair);
  // upper arms + forearms reaching the wheel
  const wz = d.wsBase - 0.46;
  for (const ax of [-1, 1]) {
    const shoulder = new THREE.Vector3(sx + ax * 0.16, c.y(hipY + 0.46), sz - 0.06);
    const hand = new THREE.Vector3(sx + ax * d.width * 0.085, c.y(d.belt - 0.10), wz - 0.02);
    b.strut(shoulder, hand, 0.085, 0.085, cloth);
    b.sphere(0.045, 8, T(hand.x, hand.y, hand.z), skin);
  }
  return b.build();
}

/* ---------------- anchors ---------------- */

function anchors(c: Ctx): BodyAnchors {
  const { d } = c;
  const hwF = halfWidthAt(d, c.nose - 0.10);
  const hwR = halfWidthAt(d, c.tail + 0.12);
  const lampY = d.belt - (d.belt - d.sill) * 0.42;
  const tailY = d.rear === 'saloon' ? d.belt - 0.17 : d.belt - 0.10;
  return {
    headlights: [
      new THREE.Vector3(-(hwF - 0.20), c.y(lampY + 0.04), c.nose - 0.02),
      new THREE.Vector3(hwF - 0.20, c.y(lampY + 0.04), c.nose - 0.02),
    ],
    taillights: [
      new THREE.Vector3(-(hwR - 0.18), c.y(tailY), c.tail + 0.03),
      new THREE.Vector3(hwR - 0.18, c.y(tailY), c.tail + 0.03),
    ],
    exhaust: [new THREE.Vector3(-c.hw * 0.5, c.y(d.sill * 0.62), c.tail - 0.06)],
    interior: new THREE.Vector3(0, c.y(d.belt + 0.16), (d.wsBase + d.rsBase) * 0.5),
  };
}

/* ---------------- shared helpers for other builders ---------------- */

export { lin, topY as carTopY, halfWidthAt as carHalfWidth, archY as carArchY };
