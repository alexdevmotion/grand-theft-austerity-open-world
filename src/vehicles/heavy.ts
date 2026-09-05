/**
 * The heavy and the odd: ARO 24, the Dacia 1304 drop-side pick-up, a modern
 * panel van, the Roman/Bucegi flatbed, an RATB city bus, an articulated tram
 * and the acid-green e-scooter from the reference frame.
 *
 * These do not go through the car kit — a cab-over truck and a tram share
 * nothing useful with a saloon's side profile — but they use the same
 * `GeoBuilder`, the same atlas and the same material, so the whole fleet is
 * still one shader program.
 */

import * as THREE from 'three';
import { GeoBuilder, T, type Surf } from './builder';
import { UV } from './texture';
import { Rng } from '../core/rng';
import { Palette } from '../artDirection';
import {
  BLACK_TRIM, CHROME_DULL, CABIN_SHADOW, DARK_PLASTIC, GLASS, L, LAMP_WHITE, LENS_AMBER,
  LENS_CLEAR, LENS_RED, RUBBER, lin, buildCarBody, car,
  type BodyAnchors, type BodyBuild, type DoorPart, type VehicleSpec,
} from './carkit';

/* ------------------------------------------------------------------ */
/* Cab doors, shared by every boxy vehicle                             */
/* ------------------------------------------------------------------ */

interface CabDoorOpts {
  spec: VehicleSpec;
  /** Door z span and vertical span, ground-relative. */
  z0: number; z1: number; y0: number; y1: number;
  hw: number;
  paint: Surf;
  trim: Surf;
  interior: THREE.Color;
  glazed: boolean;
  seatY: number;
  seatZ: number;
}

/**
 * Cab door as a real, separate panel. Boxy bodies are built from a loft that
 * spans the whole flank, so rather than routing quads out (which would leave a
 * slab-sided vehicle with a rectangular hole and nothing behind it) the door
 * here is a recessed panel: the body carries a dark inset and the door fills it
 * flush, so swinging it open reveals the cab interior.
 */
function cabDoors(o: CabDoorOpts, b: GeoBuilder, g: GeoBuilder): DoorPart[] {
  const out: DoorPart[] = [];
  const G = -o.spec.rideHeight;
  const y = (h: number) => G + h;
  for (const side of [-1, 1] as const) {
    // Recess in the body: dark, so the door reads as inset even when shut.
    b.box(0.07, o.y1 - o.y0, o.z1 - o.z0, T(side * (o.hw - 0.035), y((o.y0 + o.y1) * 0.5), (o.z0 + o.z1) * 0.5), {
      color: CABIN_SHADOW, rough: 0.92, metal: 0.03,
    });
    const skin = new GeoBuilder();
    const glass = new GeoBuilder();
    const hx = side * (o.hw + 0.004);
    const midZ = (o.z0 + o.z1) * 0.5;
    const beltY = o.glazed ? o.y0 + (o.y1 - o.y0) * 0.46 : o.y1;
    skin.box(0.05, beltY - o.y0, o.z1 - o.z0 - 0.02, T(hx - side * 0.024, y((o.y0 + beltY) * 0.5), midZ), o.paint);
    skin.box(0.052, beltY - o.y0 - 0.05, o.z1 - o.z0 - 0.08, T(hx - side * 0.062, y((o.y0 + beltY) * 0.5), midZ), {
      color: o.interior, rough: 0.86, metal: 0.02, uv: UV.fabric,
    });
    if (o.glazed) {
      // Frame + pane above the belt.
      for (const e of [-1, 1]) {
        skin.box(0.04, o.y1 - beltY, 0.05, T(hx - side * 0.024, y((beltY + o.y1) * 0.5), midZ + e * (o.z1 - o.z0 - 0.06) * 0.5), o.trim);
      }
      skin.box(0.04, 0.05, o.z1 - o.z0 - 0.02, T(hx - side * 0.024, y(o.y1), midZ), o.trim);
      skin.box(0.04, 0.05, o.z1 - o.z0 - 0.02, T(hx - side * 0.024, y(beltY), midZ), o.trim);
      const V = (h: number, z: number) => new THREE.Vector3(hx - side * 0.03, y(h), z);
      const a = V(beltY + 0.03, o.z0 + 0.05), bb = V(beltY + 0.03, o.z1 - 0.05);
      const c = V(o.y1 - 0.04, o.z1 - 0.05), dd = V(o.y1 - 0.04, o.z0 + 0.05);
      if (side > 0) glass.quad(a, bb, c, dd, { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime });
      else glass.quad(dd, c, bb, a, { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime });
    }
    // handle
    skin.box(0.03, 0.035, 0.13, T(hx + side * 0.014, y(beltY - 0.16), o.z0 + (o.z1 - o.z0) * 0.24), o.trim);

    const hinge = new THREE.Vector3(side * o.hw, y((o.y0 + o.y1) * 0.5), o.z1);
    const shellGeo = skin.build();
    const glassGeo = glass.build();
    shellGeo.translate(-hinge.x, -hinge.y, -hinge.z);
    glassGeo.translate(-hinge.x, -hinge.y, -hinge.z);
    out.push({
      id: side > 0 ? 'frontLeft' : 'frontRight',
      side, row: 0, hinge,
      shell: shellGeo, glass: glassGeo,
      maxAngle: 1.05,
      board: new THREE.Vector3(side * (o.hw + 0.75), G, midZ - 0.1),
      seat: new THREE.Vector3(side * o.hw * 0.45, y(o.seatY), o.seatZ),
    });
  }
  return out;
}

/** Driver bust for the boxy cabs. */
function cabDriver(spec: VehicleSpec, seatX: number, seatY: number, seatZ: number, wheelZ: number, wheelY: number): THREE.BufferGeometry {
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const b = new GeoBuilder();
  const skin: Surf = { color: lin(0x8a6144), rough: 0.72, metal: 0 };
  const cloth: Surf = { color: lin(0x2a3040), rough: 0.88, metal: 0.02, uv: UV.fabric };
  b.box(0.34, 0.14, 0.40, T(seatX, y(seatY + 0.03), seatZ + 0.10, -0.06, 0, 0), cloth);
  b.box(0.36, 0.44, 0.22, T(seatX, y(seatY + 0.29), seatZ - 0.05, -0.12, 0, 0), cloth);
  b.sphere(0.105, 10, T(seatX, y(seatY + 0.62), seatZ - 0.09, 0, 0, 0, 1, 1.12, 1), skin);
  b.sphere(0.108, 10, T(seatX, y(seatY + 0.655), seatZ - 0.105, 0, 0, 0, 1, 0.6, 1), { color: lin(0x231a18), rough: 0.9, metal: 0 });
  for (const ax of [-1, 1]) {
    const sh = new THREE.Vector3(seatX + ax * 0.16, y(seatY + 0.46), seatZ - 0.05);
    const hand = new THREE.Vector3(seatX + ax * 0.14, y(wheelY), wheelZ);
    b.strut(sh, hand, 0.085, 0.085, cloth);
    b.sphere(0.045, 8, T(hand.x, hand.y, hand.z), skin);
  }
  return b.build();
}

/* ------------------------------------------------------------------ */
/* Generic boxy shell                                                  */
/* ------------------------------------------------------------------ */

interface BoxOpts {
  spec: VehicleSpec;
  colour: THREE.Color;
  windscreenZ: number;
  cabRoofZ: number;
  sideWindows: { from: number; to: number; count: number; y0: number; y1: number } | null;
  roundEnds?: boolean;
  lowFloor?: boolean;
  /** Height of the floor line: where the flanks visually break. */
  floorOverride?: number;
}

function buildBoxy(o: BoxOpts): { b: GeoBuilder; g: GeoBuilder; anchors: BodyAnchors; floor: number } {
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const spec = o.spec;
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const nose = spec.length * 0.5;
  const tail = -spec.length * 0.5;
  const hw = spec.width * 0.5;
  const roof = spec.height;
  const floor = o.floorOverride ?? (o.lowFloor ? 0.34 : 0.5);

  const paint: Surf = { color: o.colour, rough: 0.32, metal: 0, coat: 1, uv: UV.bodyClean };
  const trim: Surf = { color: BLACK_TRIM, rough: 0.62, metal: 0.12, coat: 0.35 };
  const glassSurf: Surf = { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime };
  const chrome: Surf = { color: CHROME_DULL, rough: 0.16, metal: 0.95, coat: 0.3 };

  const archY = (z: number): number => {
    let v = floor - 0.24;
    const r = spec.wheelRadius * 1.24;
    for (const ax of [spec.frontAxleZ, spec.rearAxleZ]) {
      const dz = z - ax;
      if (Math.abs(dz) < r) v = Math.max(v, spec.rideHeight - 0.12 + Math.sqrt(r * r - dz * dz) * 0.55);
    }
    return Math.min(v, floor + 0.16);
  };

  const N = 40;
  const stations = [];
  for (let i = 0; i <= N; i++) {
    const z = tail + (nose - tail) * (i / N);
    let w = hw;
    let top = roof;
    const endT = o.roundEnds ? 0.9 : 0.34;
    const edge = Math.min((nose - z) / spec.length, (z - tail) / spec.length);
    if (edge < 0.035) {
      const k = 1 - edge / 0.035;
      w -= hw * 0.30 * k * endT;
      top -= (roof - floor) * 0.14 * k * endT;
    }
    for (const ax of [spec.frontAxleZ, spec.rearAxleZ]) {
      const k = Math.max(0, 1 - Math.abs(z - ax) / (spec.wheelRadius * 1.5));
      w += 0.03 * k * k;
    }
    stations.push({ z, hw: w, yTop: y(top), yBottom: y(archY(z) - 0.24), rTop: o.roundEnds ? 0.4 : 0.18, rBottom: 0.12 });
  }
  b.loft(stations, paint);

  for (const sx of [-1, 1]) {
    for (const az of [spec.frontAxleZ, spec.rearAxleZ]) {
      b.cyl(spec.wheelRadius * 1.22, spec.wheelRadius * 1.22, 0.10, 14,
        T(sx * (hw - 0.06), y(spec.rideHeight - 0.02), az, 0, 0, Math.PI / 2), trim, true);
      b.box(0.06, spec.wheelRadius * 2.5, spec.wheelRadius * 2.5,
        T(sx * (hw - 0.16), y(spec.rideHeight - 0.30), az), { color: lin(0x08080b), rough: 0.95, metal: 0, coat: 0 });
    }
    b.box(0.05, 0.09, spec.length * 0.94, T(sx * (hw + 0.005), y(floor - 0.16), 0), trim);
    b.box(0.05, 0.07, spec.length * 0.95, T(sx * (hw + 0.002), y(roof - 0.085), 0), trim);
    b.box(0.03, 0.035, spec.length * 0.9, T(sx * (hw + 0.02), y(floor + 0.40), 0), chrome);
  }

  const V = (x: number, h: number, z: number) => new THREE.Vector3(x, y(h), z);
  g.quad(V(-hw * 0.88, floor + 1.06, o.windscreenZ), V(hw * 0.88, floor + 1.06, o.windscreenZ),
    V(hw * 0.86, roof - 0.30, o.cabRoofZ), V(-hw * 0.86, roof - 0.30, o.cabRoofZ), glassSurf);
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
        const c = V(x, y1, z1), dd = V(x, y1, z0);
        if (sx > 0) g.quad(a, bb, c, dd, glassSurf); else g.quad(dd, c, bb, a, glassSurf);
        b.box(0.045, y1 - y0 + 0.10, span * 0.15, T(x - sx * 0.012, y((y0 + y1) * 0.5), z1 + span * 0.07), trim);
      }
      b.box(0.04, 0.075, to - from, T(x - sx * 0.008, y(y1 + 0.035), (from + to) * 0.5), trim);
      b.box(0.04, 0.075, to - from, T(x - sx * 0.008, y(y0 - 0.035), (from + to) * 0.5), trim);
    }
  }

  for (const sx of [-1, 1]) {
    b.box(0.30, 0.18, 0.10, T(sx * (hw - 0.34), y(floor + 0.02), nose + 0.03), {
      color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
    });
    b.box(0.16, 0.30, 0.09, T(sx * (hw - 0.24), y(floor + 0.10), tail - 0.03), {
      color: LENS_RED, rough: 0.08, metal: 0.02, coat: 0.9, uv: UV.tailLens, light: L.tail,
    });
    b.box(0.14, 0.10, 0.07, T(sx * (hw - 0.24), y(floor - 0.10), tail - 0.03), {
      color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx > 0 ? L.indL : L.indR,
    });
    b.box(0.14, 0.10, 0.07, T(sx * (hw - 0.06), y(floor + 0.02), nose + 0.03), {
      color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx > 0 ? L.indL : L.indR,
    });
    b.box(0.07, 0.26, 0.09, T(sx * (hw + 0.16), y(roof - 0.62), o.windscreenZ - 0.1), trim);
  }
  b.box(hw * 1.95, 0.22, 0.16, T(0, y(floor - 0.28), nose + 0.02), trim);
  b.box(hw * 1.95, 0.20, 0.14, T(0, y(floor - 0.26), tail - 0.02), trim);
  b.box(0.46, 0.12, 0.012, T(0, y(floor - 0.30), nose + 0.09), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });

  return {
    b, g, floor,
    anchors: {
      headlights: [new THREE.Vector3(-(hw - 0.34), y(floor), nose - 0.03), new THREE.Vector3(hw - 0.34, y(floor), nose - 0.03)],
      taillights: [new THREE.Vector3(-(hw - 0.24), y(floor + 0.1), tail + 0.03), new THREE.Vector3(hw - 0.24, y(floor + 0.1), tail + 0.03)],
      exhaust: [new THREE.Vector3(-hw * 0.6, y(0.22), tail + 0.4)],
      interior: new THREE.Vector3(0, y(roof - 0.5), 0),
    },
  };
}

function finish(b: GeoBuilder, g: GeoBuilder, anchors: BodyAnchors, doors: DoorPart[], driver?: THREE.BufferGeometry): BodyBuild {
  let tris = b.triangles + g.triangles;
  for (const p of doors) tris += (p.shell.attributes.position.count + p.glass.attributes.position.count) / 3;
  return { shell: b.build(), glass: g.build(), anchors, doors, driver, triangles: tris };
}

/* ------------------------------------------------------------------ */
/* Panel van                                                           */
/* ------------------------------------------------------------------ */

export function buildPanelVan(spec: VehicleSpec, rng: Rng): BodyBuild {
  const colour = lin(rng.pick([0xd8d4cc, 0x8e97a6, 0xb0522f, 0x5a6b7d, 0xc9c3b4]));
  const { b, g, anchors, floor } = buildBoxy({
    spec, colour,
    windscreenZ: spec.length * 0.5 - 0.62,
    cabRoofZ: spec.length * 0.5 - 1.05,
    sideWindows: { from: spec.length * 0.5 - 1.86, to: spec.length * 0.5 - 1.02, count: 1, y0: 1.32, y1: 2.02 },
  });
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  for (let i = 0; i < 5; i++) {
    b.box(spec.width * 0.98, 0.05, 0.05, T(0, y(spec.height + 0.02), -1.9 + i * 0.62), { color: BLACK_TRIM, rough: 0.7, metal: 0.3 });
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      b.box(0.04, 1.3, 0.06, T(sx * (hw + 0.01), y(1.3), -2.0 + i * 0.66), { color: colour, rough: 0.45, metal: 0.4 });
    }
  }
  b.box(0.02, 1.5, 0.02, T(0, y(1.25), -spec.length * 0.5 + 0.02), { color: BLACK_TRIM, rough: 0.8, metal: 0.1 });
  const doors = cabDoors({
    spec, hw, z0: spec.length * 0.5 - 1.94, z1: spec.length * 0.5 - 0.74, y0: floor - 0.14, y1: floor + 1.66,
    paint: { color: colour, rough: 0.32, metal: 0, coat: 1, uv: UV.bodyClean },
    trim: { color: BLACK_TRIM, rough: 0.62, metal: 0.12, coat: 0.35 },
    interior: lin(0x2a2630), glazed: true, seatY: floor + 0.42, seatZ: spec.length * 0.5 - 1.35,
  }, b, g);
  const driver = cabDriver(spec, hw * 0.45, floor + 0.42, spec.length * 0.5 - 1.35, spec.length * 0.5 - 0.86, floor + 1.14);
  return finish(b, g, anchors, doors, driver);
}

/* ------------------------------------------------------------------ */
/* ARO 24 — the boxy Romanian 4x4                                      */
/* ------------------------------------------------------------------ */

export function buildAro(spec: VehicleSpec, rng: Rng): BodyBuild {
  const base = lin(rng.pick([0x56644d, 0xa7a08a, 0x795c48, 0x506b7a, 0xc7c1ab]));
  const scheme = {
    base, alt: base.clone(), faded: base.clone().lerp(lin(0xc1b9a2), 0.12),
    interior: lin(0x514b3d), wear: rng.range(0.20, 0.48),
  };
  // ARO's engine bay ends below the windscreen. It cannot use buildBoxy:
  // that loft carries a full-height van roof all the way to the grille.
  const design = car({
    ...spec, id: 'aro24', cls: 'van', label: 'ARO 244',
    sill: 0.40, belt: 1.22, bonnetY: 1.23, bonnetRake: -0.014,
    noseY: 1.18, tailY: 1.20, bootY: 1.22,
    noseRound: 0.07, tailRound: 0.06, noseTaper: 0.055, tailTaper: 0.035,
    halfWidth: spec.width * 0.5, archBlister: 0.028, archRadius: 0.465,
    wsBase: 0.93, wsTop: 0.75, rsBase: -2.08, rsTop: -2.02,
    bPillarZ: -0.21, hwTop: 0.82, hwBelt: 0.875, glassX: 0.855,
    roofCrown: 0.014, rear: 'suv',
    doorRows: 2, frontDoorZ: [-0.16, 0.86], rearDoorZ: [-1.12, -0.25],
    lamps: 'roundTwin', grille: 'blackSlats', bumpers: 'blackPlastic',
    brightwork: false, rubStrip: false, cladding: false,
    cowlVents: true, quarterLight: false, roofRails: false, towbar: true,
    extra: (b, g, d) => {
      const y = (h: number) => h - d.rideHeight;
      const tail = -d.length * 0.5;
      const nose = d.length * 0.5;
      const hw = d.width * 0.5;
      const paint: Surf = { color: base, rough: 0.42, metal: 0, coat: 0.65, uv: UV.bodyClean };
      const steel: Surf = { color: lin(0x858783), rough: 0.43, metal: 0.75 };
      const trim: Surf = { color: BLACK_TRIM, rough: 0.78, metal: 0.05 };
      // Inner pair completes the characteristic four round headlamps.
      const lampY = d.belt - (d.belt - d.sill) * 0.30 + 0.03;
      for (const side of [-1, 1]) {
        b.torus(0.098, 0.012, 6, 24, Math.PI * 2,
          T(side * 0.405, y(lampY), nose + 0.05), steel);
        b.cyl(0.09, 0.087, 0.035, 24,
          T(side * 0.405, y(lampY), nose + 0.046, Math.PI / 2),
          { color: LAMP_WHITE, rough: 0.10, metal: 0.08, coat: 0.85, uv: UV.headlampGlass, light: L.head });
        // External hinges and ribbed running boards on the utility body.
        for (const zz of [0.84, -0.27]) {
          for (const h of [0.63, 1.10]) {
            b.box(0.032, 0.055, 0.095, T(side * (hw + 0.014), y(h), zz), paint);
          }
        }
        b.box(0.16, 0.045, 1.82, T(side * (hw + 0.018), y(0.34), -0.12), steel);
        for (let k = 0; k < 12; k++) {
          b.box(0.14, 0.008, 0.018, T(side * (hw + 0.018), y(0.367), -0.92 + k * 0.145), trim);
        }
        // Fixed cargo-side pane closes the gap behind the rear passenger door.
        const V = (h: number, z: number) => new THREE.Vector3(side * 0.857, y(h), z);
        const a = V(1.27, -1.91), bb = V(1.27, -1.17);
        const c = V(1.85, -1.17), e = V(1.85, -1.91);
        if (side > 0) g.quad(e, c, bb, a, { color: GLASS, rough: 0.05 });
        else g.quad(a, bb, c, e, { color: GLASS, rough: 0.05 });
        for (const zz of [-1.95, -1.13]) b.box(0.055, 0.64, 0.055, T(side * 0.858, y(1.56), zz), paint);
        // Drip rails, straight steel gutters instead of decorative roof bars.
        b.box(0.035, 0.022, 2.88, T(side * 0.847, y(d.height - 0.045), -0.61), steel);
      }
      // Tailgate-mounted spare: wheel axis is longitudinal, not vertical.
      b.box(0.34, 0.34, 0.13, T(0.34, y(1.10), tail - 0.055), steel);
      b.torus(d.wheelRadius * 0.79, d.wheelRadius * 0.21, 10, 32,
        Math.PI * 2, T(0.34, y(1.12), tail - 0.20),
        { color: RUBBER, rough: 0.91, metal: 0, uv: UV.sidewall });
      b.cyl(d.wheelRadius * 0.62, d.wheelRadius * 0.65, 0.15, 32,
        T(0.34, y(1.12), tail - 0.19, Math.PI / 2), steel);
      b.cyl(0.085, 0.085, 0.18, 12, T(0.34, y(1.12), tail - 0.24, Math.PI / 2), trim);
      b.box(1.70, 0.009, 0.012, T(0, y(1.21), tail - 0.065), trim);
      b.box(0.14, 0.045, 0.035, T(-0.42, y(1.13), tail - 0.084), steel);
      // Raised centre pressing and paired retaining catches on the bonnet.
      b.loft([
        { z: 1.00, hw: 0.55, yTop: y(1.262), yBottom: y(1.22), rTop: 0.018, rBottom: 0.006 },
        { z: nose - 0.14, hw: 0.52, yTop: y(1.245), yBottom: y(1.20), rTop: 0.018, rBottom: 0.006 },
      ], paint);
      for (const side of [-1, 1]) b.box(0.026, 0.095, 0.045, T(side * (hw + 0.008), y(1.17), nose - 0.44), steel);
    },
  });
  return buildCarBody(design, scheme, rng);
}

/* ------------------------------------------------------------------ */
/* Dacia 1304 drop-side pick-up                                        */
/* ------------------------------------------------------------------ */

export function buildPickup(spec: VehicleSpec, rng: Rng): BodyBuild {
  const colour = lin(rng.pick([0xd8d2c2, 0x2f6fb0, 0xc23a2a, 0x8b8778, 0xe0b62c]));
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  const nose = spec.length * 0.5;
  const tail = -spec.length * 0.5;
  const paint: Surf = { color: colour, rough: 0.34, metal: 0, coat: 0.9, uv: UV.bodyClean };
  const trim: Surf = { color: BLACK_TRIM, rough: 0.62, metal: 0.12, coat: 0.3 };
  const chrome: Surf = { color: CHROME_DULL, rough: 0.16, metal: 0.95, coat: 0.3 };
  const glassSurf: Surf = { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime };
  const V = (x: number, h: number, z: number) => new THREE.Vector3(x, y(h), z);

  const cabRear = nose - 2.05;
  const belt = 1.02;
  const roof = spec.height;

  // Cab: 1300 front end on a chassis, cut off behind the front seats.
  const stations = [];
  for (let i = 0; i <= 22; i++) {
    const z = cabRear + ((nose - cabRear) * i) / 22;
    const k = Math.max(0, (z - (nose - 0.24)) / 0.24);
    const ar = spec.wheelRadius * 1.4;
    const dz = z - spec.frontAxleZ;
    let bottom = 0.30;
    if (Math.abs(dz) < ar) bottom = Math.max(bottom, 0.26 + Math.sqrt(ar * ar - dz * dz) * 0.94);
    const blister = 0.02 * Math.max(0, 1 - Math.abs(dz) / (ar * 1.3)) ** 2;
    let top = belt;
    if (z > nose - 1.24) top = belt - Math.max(0, (z - (nose - 1.24))) * 0.02;
    stations.push({ z, hw: hw - k * 0.16 + blister, yTop: y(top - k * 0.18), yBottom: y(bottom), rTop: 0.08, rBottom: 0.05 });
  }
  b.loft(stations, paint);
  b.box(hw * 1.6, 0.05, 1.9, T(0, y(0.36), nose - 1.05), { color: lin(0x121016), rough: 0.95, metal: 0.05 });
  b.box(hw * 1.5, belt - 0.4, 1.5, T(0, y(0.72), nose - 1.15), { color: CABIN_SHADOW, rough: 0.95, metal: 0 });

  // Cab greenhouse: upright, one row of doors.
  const wsBase = nose - 1.30, wsTop = nose - 1.64, rsZ = cabRear + 0.06;
  const hwTop = hw * 0.86;
  for (const sx of [-1, 1]) {
    b.strut(V(sx * hw * 0.94, belt - 0.02, wsBase), V(sx * (hwTop - 0.01), roof - 0.07, wsTop), 0.045, 0.08, paint);
    b.strut(V(sx * hw * 0.94, belt - 0.02, rsZ), V(sx * (hwTop - 0.01), roof - 0.07, rsZ), 0.05, 0.11, paint);
    b.strut(V(sx * (hwTop + 0.004), roof - 0.08, wsTop), V(sx * (hwTop + 0.004), roof - 0.08, rsZ), 0.05, 0.05, paint);
    b.strut(V(sx * hw * 0.94, belt + 0.01, wsBase - 0.03), V(sx * hw * 0.94, belt + 0.01, rsZ + 0.03), 0.05, 0.06, paint);
  }
  b.loft([
    { z: rsZ - 0.02, hw: hwTop - 0.04, yTop: y(roof - 0.02), yBottom: y(roof - 0.13), rTop: 0.05, rBottom: 0.03 },
    { z: (rsZ + wsTop) * 0.5, hw: hwTop + 0.01, yTop: y(roof), yBottom: y(roof - 0.13), rTop: 0.06, rBottom: 0.03 },
    { z: wsTop + 0.02, hw: hwTop - 0.04, yTop: y(roof - 0.02), yBottom: y(roof - 0.13), rTop: 0.05, rBottom: 0.03 },
  ], paint);
  g.quad(V(-hwTop * 0.86, belt + 0.045, wsBase), V(hwTop * 0.86, belt + 0.045, wsBase),
    V(hwTop * 0.80, roof - 0.10, wsTop), V(-hwTop * 0.80, roof - 0.10, wsTop), glassSurf);
  g.quad(V(hwTop * 0.86, belt + 0.045, rsZ), V(-hwTop * 0.86, belt + 0.045, rsZ),
    V(-hwTop * 0.82, roof - 0.10, rsZ), V(hwTop * 0.82, roof - 0.10, rsZ), glassSurf);

  // Drop-side bed with hinged sides and a tailgate.
  const bedZ0 = tail + 0.12, bedZ1 = cabRear - 0.06;
  b.box(spec.width * 0.98, 0.08, bedZ1 - bedZ0, T(0, y(0.86), (bedZ0 + bedZ1) * 0.5), { color: lin(0x4a3c2c), rough: 0.92, metal: 0.05, uv: UV.carpet });
  for (const sx of [-1, 1]) {
    b.box(0.06, 0.46, bedZ1 - bedZ0, T(sx * (hw - 0.03), y(1.13), (bedZ0 + bedZ1) * 0.5), paint);
    for (let i = 0; i < 3; i++) {
      b.box(0.075, 0.44, 0.06, T(sx * (hw - 0.01), y(1.13), bedZ0 + 0.35 + i * ((bedZ1 - bedZ0 - 0.7) / 2)), trim);
    }
  }
  b.box(spec.width * 0.98, 0.46, 0.06, T(0, y(1.13), bedZ0), paint);
  b.box(spec.width * 0.98, 0.06, bedZ1 - bedZ0 + 0.02, T(0, y(1.37), (bedZ0 + bedZ1) * 0.5), trim);

  // 1300 front end.
  const zF = nose + 0.05;
  b.box(hw * 1.28, 0.20, 0.05, T(0, y(0.72), zF - 0.03), { color: lin(0x101016), rough: 0.5, metal: 0.35, uv: UV.grille });
  b.box(hw * 1.34, 0.03, 0.055, T(0, y(0.83), zF - 0.02), chrome);
  b.box(hw * 1.34, 0.03, 0.055, T(0, y(0.61), zF - 0.02), chrome);
  for (const sx of [-1, 1]) {
    b.box(0.28, 0.125, 0.05, T(sx * (hw - 0.22), y(0.75), zF - 0.01), chrome);
    b.box(0.25, 0.10, 0.055, T(sx * (hw - 0.22), y(0.75), zF - 0.002), {
      color: LAMP_WHITE, rough: 0.06, metal: 0.02, coat: 0.9, uv: UV.headlampGlass, light: L.head,
    });
    b.box(0.10, 0.075, 0.045, T(sx * (hw - 0.04), y(0.70), zF - 0.012), {
      color: LENS_AMBER, rough: 0.12, metal: 0.03, light: sx > 0 ? L.indL : L.indR,
    });
    b.box(0.16, 0.28, 0.05, T(sx * (hw - 0.20), y(0.98), tail - 0.03), {
      color: LENS_RED, rough: 0.09, metal: 0.02, uv: UV.tailLens, light: L.tail,
    });
  }
  b.box(hw * 1.9, 0.10, 0.09, T(0, y(0.52), zF + 0.04), chrome);
  b.box(hw * 1.9, 0.09, 0.09, T(0, y(0.60), tail - 0.05), chrome);
  b.box(0.44, 0.11, 0.012, T(0, y(0.46), zF + 0.08), { color: lin(0xf0f0ea), rough: 0.42, metal: 0.05, coat: 0.5, uv: UV.plate });
  b.cyl(0.028, 0.028, 0.4, 8, T(-hw * 0.5, y(0.24), tail + 0.3, Math.PI / 2, 0, 0), { color: lin(0x4a4a52), rough: 0.5, metal: 0.85 });

  const doors = cabDoors({
    spec, hw, z0: rsZ + 0.02, z1: wsBase - 0.04, y0: 0.32, y1: roof - 0.12,
    paint, trim, interior: lin(0x3a3040), glazed: true, seatY: 0.62, seatZ: nose - 1.72,
  }, b, g);
  const driver = cabDriver(spec, hw * 0.42, 0.62, nose - 1.72, nose - 1.42, belt - 0.06);

  return finish(b, g, {
    headlights: [new THREE.Vector3(-(hw - 0.22), y(0.75), nose - 0.02), new THREE.Vector3(hw - 0.22, y(0.75), nose - 0.02)],
    taillights: [new THREE.Vector3(-(hw - 0.20), y(0.98), tail + 0.03), new THREE.Vector3(hw - 0.20, y(0.98), tail + 0.03)],
    exhaust: [new THREE.Vector3(-hw * 0.5, y(0.24), tail + 0.08)],
    interior: new THREE.Vector3(0, y(belt + 0.2), nose - 1.6),
  }, doors, driver);
}

/* ------------------------------------------------------------------ */
/* Roman / Bucegi flatbed                                              */
/* ------------------------------------------------------------------ */

export function buildTruck(spec: VehicleSpec, rng: Rng): BodyBuild {
  const colour = lin(rng.pick([0x8a3d2e, 0x35506b, 0x6d6a60, 0x2f3a44, 0x7d8a5c]));
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

  const cabRear = nose - 2.1;
  const cabStations = [];
  for (let i = 0; i <= 24; i++) {
    const z = cabRear + ((nose - cabRear) * i) / 24;
    const k = Math.max(0, (z - (nose - 0.3)) / 0.3);
    const ar = spec.wheelRadius * 1.22;
    const dz = z - spec.frontAxleZ;
    let bottom = 0.72;
    if (Math.abs(dz) < ar) bottom = Math.max(bottom, 0.50 + Math.sqrt(ar * ar - dz * dz) * 0.92);
    const blister = 0.045 * Math.max(0, 1 - Math.abs(dz) / (ar * 1.35)) ** 2;
    cabStations.push({ z, hw: hw - k * 0.12 + blister, yTop: y(3.02 - k * 0.16), yBottom: y(bottom), rTop: 0.24, rBottom: 0.14 });
  }
  b.loft(cabStations, paint);
  b.box(spec.width * 0.86, 1.0, 1.5, T(0, y(2.1), nose - 1.1), { color: CABIN_SHADOW, rough: 0.95, metal: 0 });
  for (const sx of [-1, 1]) {
    b.cyl(spec.wheelRadius * 1.2, spec.wheelRadius * 1.2, 0.10, 14,
      T(sx * (hw - 0.08), y(spec.rideHeight - 0.36), spec.frontAxleZ, 0, 0, Math.PI / 2), trim, true);
  }
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
  for (let i = 0; i < 5; i++) {
    const z = bedZ0 + 0.35 + i * ((bedZ1 - bedZ0 - 0.7) / 4);
    b.torus(hw - 0.06, 0.035, 5, 12, Math.PI, T(0, y(2.06), z, 0, Math.PI / 2, 0), trim);
  }
  g.quad(V(-hw * 0.86, 1.9, nose - 0.14), V(hw * 0.86, 1.9, nose - 0.14), V(hw * 0.84, 2.88, nose - 0.36), V(-hw * 0.84, 2.88, nose - 0.36), glassSurf);
  for (const sx of [-1, 1]) {
    b.box(0.36, 0.24, 0.12, T(sx * (hw - 0.4), y(1.10), nose + 0.04), { color: LAMP_WHITE, rough: 0.1, metal: 0.1, uv: UV.headlampGlass, light: L.head });
    b.box(0.18, 0.34, 0.10, T(sx * (hw - 0.26), y(1.24), tail - 0.04), { color: LENS_RED, rough: 0.12, metal: 0.06, uv: UV.tailLens, light: L.tail });
    b.box(0.16, 0.12, 0.08, T(sx * (hw - 0.1), y(1.34), nose + 0.03), { color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx > 0 ? L.indL : L.indR });
    b.box(0.16, 0.12, 0.08, T(sx * (hw - 0.26), y(0.98), tail - 0.03), { color: LENS_AMBER, rough: 0.14, metal: 0.06, light: sx > 0 ? L.indL : L.indR });
    b.box(0.08, 0.5, 0.16, T(sx * (hw + 0.14), y(2.4), nose - 0.5), trim);
  }
  b.box(spec.width * 0.78, 0.52, 0.08, T(0, y(1.5), nose + 0.03), { color: lin(0x1a1a20), rough: 0.5, metal: 0.5, coat: 0.3, uv: UV.grille });
  for (let i = 0; i < 5; i++) {
    b.box(spec.width * 0.80, 0.035, 0.10, T(0, y(1.28 + i * 0.11), nose + 0.05), { color: CHROME_DULL, rough: 0.22, metal: 0.95, coat: 0.3 });
  }
  b.box(spec.width * 0.84, 0.06, 0.11, T(0, y(1.78), nose + 0.05), { color: CHROME_DULL, rough: 0.18, metal: 1, coat: 0.35 });
  b.box(spec.width * 0.84, 0.06, 0.11, T(0, y(1.22), nose + 0.05), { color: CHROME_DULL, rough: 0.18, metal: 1, coat: 0.35 });
  for (const sx of [-1, 1]) {
    b.box(0.42, 0.30, 0.06, T(sx * (hw - 0.4), y(1.10), nose + 0.06), { color: CHROME_DULL, rough: 0.18, metal: 1, coat: 0.35 });
    b.box(0.10, 0.05, 0.42, T(sx * (hw - 0.02), y(0.52), nose - 1.0), { color: lin(0x3a3a44), rough: 0.5, metal: 0.7, coat: 0.2 });
    b.box(0.03, 0.34, 0.26, T(sx * (hw - 0.10), y(0.28), tail + 0.35), { color: RUBBER, rough: 0.92, metal: 0.02, coat: 0 });
  }
  b.box(spec.width * 1.0, 0.22, 0.22, T(0, y(0.82), nose + 0.04), { color: CHROME_DULL, rough: 0.2, metal: 0.95, coat: 0.3 });
  b.box(spec.width * 1.0, 0.16, 0.16, T(0, y(0.62), nose + 0.0), trim);
  b.cyl(0.09, 0.09, 1.7, 8, T(hw - 0.08, y(2.4), cabRear + 0.05), { color: lin(0x8e929e), rough: 0.24, metal: 1, coat: 0.3 });
  for (let i = -2; i <= 2; i++) {
    b.box(0.09, 0.05, 0.05, T(i * 0.36, y(3.06), nose - 0.4), { color: LENS_AMBER, rough: 0.2, metal: 0.05, coat: 0.8, light: L.aux });
  }

  const doors = cabDoors({
    spec, hw, z0: cabRear + 0.10, z1: nose - 0.42, y0: 1.06, y1: 2.86,
    paint, trim, interior: lin(0x2a2630), glazed: true, seatY: 1.62, seatZ: nose - 1.12,
  }, b, g);
  const driver = cabDriver(spec, hw * 0.45, 1.62, nose - 1.12, nose - 0.56, 2.30);

  return finish(b, g, {
    headlights: [new THREE.Vector3(-(hw - 0.4), y(1.1), nose - 0.02), new THREE.Vector3(hw - 0.4, y(1.1), nose - 0.02)],
    taillights: [new THREE.Vector3(-(hw - 0.26), y(1.24), tail + 0.02), new THREE.Vector3(hw - 0.26, y(1.24), tail + 0.02)],
    exhaust: [new THREE.Vector3(hw - 0.08, y(3.3), cabRear + 0.05)],
    interior: new THREE.Vector3(0, y(2.4), nose - 0.7),
  }, doors, driver);
}

/* ------------------------------------------------------------------ */
/* RATB city bus                                                       */
/* ------------------------------------------------------------------ */

export function buildBus(spec: VehicleSpec, rng: Rng): BodyBuild {
  const colour = lin(rng.pick([0xc4442e, 0x2f6ea8, 0xd8d2c6, 0xe0a520, 0x2f8a62]));
  const bandColour = lin(rng.pick([0xd8d2c6, 0x1c2028, 0xe8e4d8]));
  const { b, g, anchors } = buildBoxy({
    spec, colour,
    windscreenZ: spec.length * 0.5 - 0.5,
    cabRoofZ: spec.length * 0.5 - 0.95,
    sideWindows: { from: -spec.length * 0.5 + 0.7, to: spec.length * 0.5 - 1.1, count: 7, y0: 1.42, y1: 2.62 },
    lowFloor: true,
  });
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  const floor = 0.34;
  const trim: Surf = { color: BLACK_TRIM, rough: 0.6, metal: 0.15, coat: 0.3 };

  b.box(spec.width * 0.7, 0.26, 0.05, T(0, y(spec.height - 0.28), spec.length * 0.5 - 0.42), {
    color: lin(0x101018), rough: 0.4, metal: 0.1, coat: 0.4, light: L.aux,
  });
  b.box(spec.width * 0.74, 0.32, 0.03, T(0, y(spec.height - 0.28), spec.length * 0.5 - 0.40), trim);

  const doorZ = [spec.length * 0.5 - 2.05, -0.5, -spec.length * 0.5 + 1.75];
  for (const sx of [-1, 1]) {
    for (const z of doorZ) {
      const x = sx * (hw + 0.012);
      const dTop = 2.66, dBot = 0.42;
      b.box(0.05, dTop - dBot, 1.28, T(sx * (hw - 0.03), y((dTop + dBot) * 0.5), z), { color: lin(0x14141b), rough: 0.8, metal: 0.05, coat: 0.15 });
      b.box(0.035, dTop - dBot, 0.05, T(x, y((dTop + dBot) * 0.5), z), trim);
      for (const e of [-0.64, 0.64]) b.box(0.035, dTop - dBot, 0.06, T(x, y((dTop + dBot) * 0.5), z + e), trim);
      b.box(0.035, 0.06, 1.30, T(x, y(dTop), z), trim);
      b.box(0.035, 0.06, 1.30, T(x, y(dBot), z), trim);
      const V = (h: number, zz: number) => new THREE.Vector3(sx * (hw + 0.004), y(h), zz);
      for (const e of [-0.31, 0.31]) {
        const a = V(1.42, z + e - 0.25), bb = V(1.42, z + e + 0.25);
        const c = V(2.58, z + e + 0.25), dd = V(2.58, z + e - 0.25);
        if (sx > 0) g.quad(a, bb, c, dd, { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime });
        else g.quad(dd, c, bb, a, { color: GLASS, rough: 0.05, metal: 0, coat: 0, uv: UV.glassGrime });
      }
    }
    b.box(0.03, 0.30, spec.length * 0.93, T(sx * (hw + 0.018), y(floor + 0.16), 0), {
      color: bandColour, rough: 0.3, metal: 0, coat: 1, uv: UV.bodyClean,
    });
    b.box(0.045, 0.045, spec.length * 0.94, T(sx * (hw + 0.008), y(spec.height - 0.03), 0), trim);
  }
  // Interior: seat rows and a dark cabin so the windows are not empty apertures.
  b.box(spec.width * 0.92, 1.3, spec.length * 0.9, T(0, y(1.35), -0.2), { color: CABIN_SHADOW, rough: 0.95, metal: 0 });
  for (let i = 0; i < 8; i++) {
    const z = -spec.length * 0.5 + 1.3 + i * 1.15;
    for (const sx of [-1, 1]) {
      b.box(0.42, 0.09, 0.42, T(sx * hw * 0.62, y(1.22), z), { color: lin(0x2c3f6a), rough: 0.85, metal: 0.02, uv: UV.fabric });
      b.box(0.42, 0.42, 0.09, T(sx * hw * 0.62, y(1.45), z - 0.20), { color: lin(0x2c3f6a), rough: 0.85, metal: 0.02, uv: UV.fabric });
    }
  }
  for (let i = 0; i < 3; i++) {
    b.box(spec.width * 0.62, 0.14, 0.95, T(0, y(spec.height + 0.06), -3 + i * 2.6), { color: lin(0xd8d8dc), rough: 0.55, metal: 0.2, coat: 0.3 });
  }
  b.box(spec.width * 0.8, 0.26, 2.1, T(0, y(spec.height + 0.12), spec.length * 0.5 - 2.6), { color: lin(0xc8c8cc), rough: 0.6, metal: 0.25, coat: 0.25 });
  for (let i = 0; i < 6; i++) {
    b.box(spec.width * 0.78, 0.03, 0.07, T(0, y(spec.height + 0.26), spec.length * 0.5 - 3.4 + i * 0.3), trim);
  }
  b.box(spec.width * 0.62, 0.30, 0.06, T(0, y(floor - 0.02), spec.length * 0.5 + 0.03), {
    color: lin(0x14141a), rough: 0.5, metal: 0.4, coat: 0.3, uv: UV.grille,
  });
  b.box(spec.width * 0.96, 0.10, 0.12, T(0, y(floor - 0.36), spec.length * 0.5 + 0.04), { color: CHROME_DULL, rough: 0.2, metal: 0.95, coat: 0.3 });

  const driver = cabDriver(spec, hw * 0.58, 1.10, spec.length * 0.5 - 1.55, spec.length * 0.5 - 1.05, 1.72);
  return finish(b, g, anchors, [], driver);
}

/* ------------------------------------------------------------------ */
/* Articulated tram                                                    */
/* ------------------------------------------------------------------ */

export function buildTram(spec: VehicleSpec, rng: Rng): BodyBuild {
  const colour = lin(rng.pick([0xd8c23a, 0xb8452e]));
  const { b, g, anchors } = buildBoxy({
    spec, colour,
    windscreenZ: spec.length * 0.5 - 0.35,
    cabRoofZ: spec.length * 0.5 - 0.9,
    sideWindows: { from: -spec.length * 0.5 + 1.0, to: spec.length * 0.5 - 1.1, count: 9, y0: 1.46, y1: 2.78 },
    roundEnds: true,
    lowFloor: true,
  });
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const hw = spec.width * 0.5;
  for (let i = -2; i <= 2; i++) {
    b.box(spec.width * 1.01, spec.height * 0.62, 0.09, T(0, y(spec.height * 0.52), i * 0.13), { color: lin(0x18181e), rough: 0.9, metal: 0.05 });
  }
  b.box(spec.width * 0.9, 1.4, spec.length * 0.9, T(0, y(1.55), 0), { color: CABIN_SHADOW, rough: 0.95, metal: 0 });
  for (let i = 0; i < 10; i++) {
    const z = -spec.length * 0.5 + 1.6 + i * 1.3;
    for (const sx of [-1, 1]) {
      b.box(0.40, 0.08, 0.40, T(sx * hw * 0.64, y(1.28), z), { color: lin(0x3a2f52), rough: 0.85, metal: 0.02, uv: UV.fabric });
      b.box(0.40, 0.40, 0.08, T(sx * hw * 0.64, y(1.50), z - 0.19), { color: lin(0x3a2f52), rough: 0.85, metal: 0.02, uv: UV.fabric });
    }
  }
  b.box(1.5, 0.08, 0.5, T(0, y(spec.height + 0.06), 1.6), { color: lin(0x2a2a32), rough: 0.6, metal: 0.6 });
  b.box(0.07, 0.9, 0.07, T(-0.3, y(spec.height + 0.5), 1.6, 0.5, 0, 0), { color: lin(0x8a8a96), rough: 0.4, metal: 0.9 });
  b.box(0.07, 0.9, 0.07, T(0.3, y(spec.height + 0.5), 1.6, 0.5, 0, 0), { color: lin(0x8a8a96), rough: 0.4, metal: 0.9 });
  b.box(1.3, 0.05, 0.09, T(0, y(spec.height + 0.92), 1.18), { color: lin(0x6a6a76), rough: 0.35, metal: 0.95 });
  b.box(0.7, 0.24, 0.04, T(0, y(spec.height - 0.34), spec.length * 0.5 - 0.28), {
    color: lin(0x0d0d14), rough: 0.5, metal: 0.1, light: L.aux,
  });
  for (const sx of [-1, 1]) {
    b.box(0.06, 0.5, spec.length * 0.9, T(sx * (hw - 0.01), y(0.24), 0), { color: lin(0x1a1a22), rough: 0.85, metal: 0.1 });
  }
  const driver = cabDriver(spec, hw * 0.5, 1.12, spec.length * 0.5 - 1.35, spec.length * 0.5 - 0.9, 1.68);
  return finish(b, g, anchors, [], driver);
}

/* ------------------------------------------------------------------ */
/* E-scooter                                                           */
/* ------------------------------------------------------------------ */

export function buildScooter(spec: VehicleSpec, rng: Rng): BodyBuild {
  const b = new GeoBuilder();
  const g = new GeoBuilder();
  const G = -spec.rideHeight;
  const y = (h: number) => G + h;
  const green: Surf = { color: Palette.scooterGreen.clone(), rough: 0.28, metal: 0, coat: 1 };
  const dark: Surf = { color: DARK_PLASTIC, rough: 0.6, metal: 0.35 };
  const metal: Surf = { color: lin(0x8d919c), rough: 0.16, metal: 1, coat: 0.35 };

  b.box(0.20, 0.06, 0.86, T(0, y(0.13), 0), green);
  b.box(0.23, 0.03, 0.90, T(0, y(0.165), 0), { color: lin(0x1c1c22), rough: 0.9, metal: 0.05, uv: UV.tread });
  b.box(0.10, 0.10, 0.30, T(0, y(0.12), -0.42), green);
  b.box(0.07, 1.02, 0.09, T(0, y(0.62), 0.44, -0.16, 0, 0), metal);
  b.box(0.52, 0.045, 0.05, T(0, y(1.10), 0.36), dark);
  for (const sx of [-1, 1]) b.cyl(0.026, 0.026, 0.12, 8, T(sx * 0.22, y(1.10), 0.36, 0, 0, Math.PI / 2), dark);
  b.box(0.11, 0.07, 0.03, T(0, y(1.16), 0.40, 0.4, 0, 0), { color: lin(0x1a2a1a), rough: 0.3, metal: 0.1, light: L.aux });
  b.cyl(0.035, 0.035, 0.03, 10, T(0, y(0.98), 0.47, Math.PI / 2, 0, 0), { color: LAMP_WHITE, rough: 0.1, metal: 0.1, light: L.head });
  b.box(0.07, 0.04, 0.02, T(0, y(0.20), -0.55), { color: LENS_RED, rough: 0.14, metal: 0.05, light: L.tail });
  for (const az of [0.5, -0.5]) {
    b.torus(0.17, 0.02, 4, 10, Math.PI * 0.7, T(0, y(0.18), az, 0, Math.PI / 2, 0.4), green);
  }
  b.box(0.03, 0.20, 0.03, T(-0.11, y(0.08), -0.26, 0, 0, 0.5), metal);
  void rng;
  return finish(b, g, {
    headlights: [new THREE.Vector3(0, y(0.98), 0.5)],
    taillights: [new THREE.Vector3(0, y(0.2), -0.56)],
    exhaust: [],
    interior: new THREE.Vector3(0, y(1.1), 0.4),
  }, []);
}

export { LENS_CLEAR };
