/**
 * PROP KIT — the geometry accumulator and material family every piece of street
 * dressing is built from.
 *
 * Everything a prop module emits lands in a `PropBuilder`, which is merged once
 * per world tile into a single BufferGeometry. One material + one geometry per
 * tile means the whole of Bucharest's street furniture — thousands of objects —
 * costs a dozen draw calls rather than a dozen thousand.
 *
 * The material is a MeshStandardMaterial carrying three per-vertex channels:
 *   color      linear albedo
 *   aMR        metalness, roughness
 *   aEmissive  linear emissive radiance (sodium heads, signage, screens)
 *
 * That is deliberately the same contract as the city's `detail` family, so
 * props and the city's own dressing sit in the same visual space.
 *
 * OWNER: props / street-dressing agent.
 */

import * as THREE from 'three';
import { PAL, srgb } from '../../render/materials';

/**
 * Decoded EXACTLY once — see the colour-space note in `src/render/materials.ts`.
 * The previous `new Color(hex).convertSRGBToLinear()` double-decoded every prop
 * colour in the game, which is why every piece of street furniture, every tree
 * and every litter card rendered as a black or burnt-red silhouette.
 */
const lin = srgb;

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export const PropColor = {
  /* metals — authored a stop brighter than "correct", because at 0.5 metalness
     under a violet dusk probe everything here loses most of its value. */
  steel: lin(0x4d545e),
  steelDark: lin(0x30353d),
  steelPale: lin(0xa3abb4),
  alu: lin(0xb8bfc6),
  galv: lin(0x949ca4),
  chrome: lin(0xd2d7dc),
  rust: lin(0x8a5730),

  /* paints */
  paintGreen: lin(0x28503a),
  paintRed: lin(0x8e2230),
  paintWhite: lin(0xd7d3ca),
  paintCream: lin(0xbfae90),
  paintBlue: lin(0x1d3a63),
  paintOrange: lin(0xc4571c),
  paintYellow: lin(0xc9a12a),
  hazardRed: lin(0xc02528),
  hazardWhite: lin(0xdedad0),

  /* materials */
  wood: lin(0x6b4d2e),
  woodPale: lin(0x8d6a3f),
  concrete: lin(0x6a6470),
  concreteDark: lin(0x3d3944),
  // Dark plastics and rubber authored a shade up: at true value a bin bag or a
  // cone base on a lit pavement reads as a hole punched in the ground rather
  // than as an object lying on it.
  bitumen: lin(0x2a2734),
  glass: lin(0x1b2338),
  glassPale: lin(0x35415f),
  plasticDark: lin(0x33323c),
  rubber: lin(0x2a2a30),
  fabricRed: lin(0x62202c),
  fabricStripe: lin(0xa8a094),
  paper: lin(0xb9b3a6),
  paperDim: lin(0x7d786d),
  cardboard: lin(0x6f5a3e),

  /* signature colours pulled from art direction */
  sodium: PAL.sodiumLamp,
  purple: PAL.builderPurple,
  magenta: PAL.builderMagenta,
  screenBlue: PAL.screenBlue,
  neon: PAL.neonPink,
  scooter: PAL.scooterGreen,
  /**
   * FOLIAGE — late-autumn Bucharest. These are now decoded once, so they are
   * roughly three times the linear value they used to reach the frame at, and
   * a backlit crown lands in the amber band the reference actually has rather
   * than reading as a hole punched in the sky. Translucency (see `PropOpts.trans`)
   * carries the rest of the backlit read.
   */
  /*
   * AUTHORED DARK AND SATURATED, matching `DetailColor` in city/facades.ts.
   * A turned plane leaf measures ~0.20-0.30 linear in red and under 0.05 in
   * blue. Authored at the obvious "autumn gold" (0xd8ab55, 0.69 linear red)
   * every crown in the game bleached to cream under the key and there was
   * nothing left for the translucency term to add — the failure mode opposite
   * to the old black plates, and just as obviously not a tree.
   */
  leafAmber: lin(0x8a5a1c),
  leafOlive: lin(0x4a5626),
  leafRust: lin(0x74341a),
  leafGold: lin(0xa06c20),
  leafPale: lin(0xa8843c),
  bark: lin(0x5b4a3c),
  roBlue: PAL.roBlue,
  roYellow: PAL.roYellow,
  roRed: PAL.roRed,
  daciaYellow: PAL.daciaYellow,
} as const;

/**
 * metalness / roughness presets.
 *
 * NOTE ON METALNESS. A PBR metal has no diffuse term: everything it shows is
 * reflected environment. At `metalness 0.85` under this game's dusk probe a
 * galvanised barrier, a lamp column and a bike stand all render as pure black
 * silhouettes — which is exactly why the whole street furniture layer read as
 * cardboard cut-outs. Real galvanised and powder-coated steel is a long way
 * from a mirror anyway, so these sit at 0.4-0.55 and let the authored albedo
 * carry the surface. `chrome` is the only thing here that stays a real metal.
 */
export const MR = {
  metal: [0.5, 0.4] as [number, number],
  metalRough: [0.36, 0.66] as [number, number],
  chrome: [0.92, 0.16] as [number, number],
  paint: [0.06, 0.48] as [number, number],
  plastic: [0.0, 0.42] as [number, number],
  rubber: [0.0, 0.92] as [number, number],
  wood: [0.0, 0.86] as [number, number],
  stone: [0.0, 0.78] as [number, number],
  glass: [0.55, 0.09] as [number, number],
  fabric: [0.0, 0.9] as [number, number],
  paper: [0.0, 0.72] as [number, number],
  leaf: [0.0, 0.68] as [number, number],
  lamp: [0.0, 0.3] as [number, number],
} as const;

/** Emissive radiance vector for a colour at a given gain. */
export function emi(c: THREE.Color, gain: number): number[] {
  return [c.r * gain, c.g * gain, c.b * gain];
}

export interface PropOpts {
  color: THREE.Color;
  /** [metalness, roughness] */
  mr?: readonly [number, number];
  emissive?: number[];
  /**
   * TRANSLUCENCY 0..1 — how much light passes THROUGH this surface.
   *
   * The sun in this game sits three degrees above the horizon, so every street
   * tree is lit from behind. A leaf is not opaque: a backlit autumn canopy is
   * the brightest amber in the reference frame, not the darkest mass. This
   * drives a wrapped back-scatter term in the prop shader that only fires when
   * the viewer is looking toward the sun through the surface, which is exactly
   * when real foliage glows.
   */
  trans?: number;
}

const NO_E = [0, 0, 0];
const DEFAULT_MR: readonly [number, number] = [0, 0.85];

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _fn = new THREE.Vector3();

export class PropBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly mr: number[] = [];
  readonly emis: number[] = [];
  readonly trans: number[] = [];
  readonly idx: number[] = [];

  get triangles(): number {
    return this.idx.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  private v(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    o: PropOpts,
  ): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(o.color.r, o.color.g, o.color.b);
    const m = o.mr ?? DEFAULT_MR;
    this.mr.push(m[0], m[1]);
    const e = o.emissive ?? NO_E;
    this.emis.push(e[0], e[1], e[2]);
    this.trans.push(o.trans ?? 0);
  }

  /** Quad with a derived normal. Winding a→b→c→d, front face CCW. */
  quad(a: number[], b: number[], c: number[], d: number[], o: PropOpts): void {
    _ab.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _ac.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    _fn.crossVectors(_ab, _ac).normalize();
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.v(p[0], p[1], p[2], _fn.x, _fn.y, _fn.z, o);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box, rotated about Y. 12 triangles. */
  box(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    rotY: number, o: PropOpts,
  ): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const cs = Math.cos(rotY);
    const sn = Math.sin(rotY);
    const P = (x: number, y: number, z: number): number[] => [
      cx + x * cs + z * sn,
      cy + y,
      cz - x * sn + z * cs,
    ];
    const a = P(-hx, -hy, -hz);
    const b = P(-hx, -hy, hz);
    const c = P(hx, -hy, hz);
    const d = P(hx, -hy, -hz);
    const e = P(-hx, hy, -hz);
    const f = P(-hx, hy, hz);
    const g = P(hx, hy, hz);
    const h = P(hx, hy, -hz);
    this.quad(e, f, g, h, o);
    this.quad(d, c, b, a, o);
    this.quad(a, b, f, e, o);
    this.quad(c, d, h, g, o);
    this.quad(b, c, g, f, o);
    this.quad(d, a, e, h, o);
  }

  /** Open-topped box shell used for skips, planters and bins (no lid, no floor). */
  openBox(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    rotY: number, o: PropOpts,
  ): void {
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    const cs = Math.cos(rotY);
    const sn = Math.sin(rotY);
    const P = (x: number, y: number, z: number): number[] => [
      cx + x * cs + z * sn, cy + y, cz - x * sn + z * cs,
    ];
    const a = P(-hx, -hy, -hz);
    const b = P(-hx, -hy, hz);
    const c = P(hx, -hy, hz);
    const d = P(hx, -hy, -hz);
    const e = P(-hx, hy, -hz);
    const f = P(-hx, hy, hz);
    const g = P(hx, hy, hz);
    const h = P(hx, hy, -hz);
    this.quad(a, b, f, e, o);
    this.quad(c, d, h, g, o);
    this.quad(b, c, g, f, o);
    this.quad(d, a, e, h, o);
    // Inner floor, slightly raised so the contents read.
    const i0 = P(-hx * 0.94, -hy * 0.6, -hz * 0.94);
    const i1 = P(-hx * 0.94, -hy * 0.6, hz * 0.94);
    const i2 = P(hx * 0.94, -hy * 0.6, hz * 0.94);
    const i3 = P(hx * 0.94, -hy * 0.6, -hz * 0.94);
    this.quad(i3, i2, i1, i0, o);
  }

  /** Vertical cylinder / frustum. */
  cyl(
    cx: number, cy: number, cz: number,
    rBottom: number, rTop: number, h: number, seg: number,
    o: PropOpts, capTop = true,
  ): void {
    const base = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      this.v(cx + nx * rBottom, cy, cz + nz * rBottom, nx, 0, nz, o);
      this.v(cx + nx * rTop, cy + h, cz + nz * rTop, nx, 0, nz, o);
    }
    for (let i = 0; i < seg; i++) {
      const i0 = base + i * 2;
      this.idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
    if (capTop && rTop > 1e-4) {
      const cb = this.pos.length / 3;
      this.v(cx, cy + h, cz, 0, 1, 0, o);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        this.v(cx + Math.cos(a) * rTop, cy + h, cz + Math.sin(a) * rTop, 0, 1, 0, o);
      }
      for (let i = 0; i < seg; i++) this.idx.push(cb, cb + i + 2, cb + i + 1);
    }
  }

  /**
   * Tube between two arbitrary points — wires, branches, handlebars, railings.
   * Untapered, uncapped: at wire radii the caps are invisible and cost 2/3 of
   * the triangles.
   */
  tube(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, seg: number, o: PropOpts,
  ): void {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    // Any vector not parallel to the axis.
    let px = 0;
    let py = 1;
    let pz = 0;
    if (Math.abs(uy) > 0.9) { px = 1; py = 0; pz = 0; }
    // t = normalize(cross(u, p)), s = cross(u, t)
    let tx = uy * pz - uz * py;
    let ty = uz * px - ux * pz;
    let tz = ux * py - uy * px;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    const sx = uy * tz - uz * ty;
    const sy = uz * tx - ux * tz;
    const sz = ux * ty - uy * tx;

    const base = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nx = tx * ca + sx * sa;
      const ny = ty * ca + sy * sa;
      const nz = tz * ca + sz * sa;
      this.v(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, o);
      this.v(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, o);
    }
    for (let i = 0; i < seg; i++) {
      const i0 = base + i * 2;
      this.idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
  }

  /**
   * Sagging catenary between two points, as a chain of tube segments.
   * `sag` is the drop at midspan in metres.
   */
  wire(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    sag: number, r: number, o: PropOpts, segments = 5,
  ): void {
    let px = ax;
    let py = ay;
    let pz = az;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const qx = ax + (bx - ax) * t;
      const qz = az + (bz - az) * t;
      const qy = ay + (by - ay) * t - sag * 4 * t * (1 - t);
      this.tube(px, py, pz, qx, qy, qz, r, 3, o);
      px = qx; py = qy; pz = qz;
    }
  }

  /** Horizontal quad on the ground — litter, leaf patches, painted marks. */
  ground(
    cx: number, y: number, cz: number,
    w: number, d: number, rotY: number, o: PropOpts,
  ): void {
    const hw = w / 2;
    const hd = d / 2;
    const cs = Math.cos(rotY);
    const sn = Math.sin(rotY);
    const P = (x: number, z: number): number[] => [cx + x * cs + z * sn, y, cz - x * sn + z * cs];
    const base = this.pos.length / 3;
    for (const p of [P(-hw, -hd), P(-hw, hd), P(hw, hd), P(hw, -hd)]) {
      this.v(p[0], p[1], p[2], 0, 1, 0, o);
    }
    this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }

  /**
   * Vertical double-sided panel — posters, signs, hoarding, flags.
   * `nx,nz` is the facing direction; the panel spans `w` across it.
   */
  panel(
    cx: number, cy: number, cz: number,
    w: number, h: number, nx: number, nz: number,
    o: PropOpts, twoSided = true,
  ): void {
    const l = Math.hypot(nx, nz) || 1;
    const fx = nx / l;
    const fz = nz / l;
    // Right = up x forward
    const rx = -fz;
    const rz = fx;
    const hw = w / 2;
    const hh = h / 2;
    const P = (s: number, u: number): number[] => [cx + rx * s, cy + u, cz + rz * s];
    const a = P(-hw, -hh);
    const b = P(hw, -hh);
    const c = P(hw, hh);
    const d = P(-hw, hh);
    const base = this.pos.length / 3;
    for (const p of [a, b, c, d]) this.v(p[0], p[1], p[2], fx, 0, fz, o);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    if (twoSided) {
      const b2 = this.pos.length / 3;
      for (const p of [a, b, c, d]) this.v(p[0], p[1], p[2], -fx, 0, -fz, o);
      this.idx.push(b2, b2 + 2, b2 + 1, b2, b2 + 3, b2 + 2);
    }
  }

  /** Vertical disc facing (nx, nz) — sign faces, wheel hubs, lamp lenses. */
  disc(
    cx: number, cy: number, cz: number,
    r: number, nx: number, nz: number, seg: number, o: PropOpts,
  ): void {
    const l = Math.hypot(nx, nz) || 1;
    const fx = nx / l;
    const fz = nz / l;
    const rx = -fz;
    const rz = fx;
    const base = this.pos.length / 3;
    this.v(cx, cy, cz, fx, 0, fz, o);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const s = Math.cos(a) * r;
      const u = Math.sin(a) * r;
      this.v(cx + rx * s, cy + u, cz + rz * s, fx, 0, fz, o);
    }
    for (let i = 0; i < seg; i++) this.idx.push(base, base + i + 1, base + i + 2);
    // Back face, so a sign is not invisible from behind.
    const b2 = this.pos.length / 3;
    this.v(cx, cy, cz, -fx, 0, -fz, o);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const s = Math.cos(a) * r;
      const u = Math.sin(a) * r;
      this.v(cx + rx * s, cy + u, cz + rz * s, -fx, 0, -fz, o);
    }
    for (let i = 0; i < seg; i++) this.idx.push(b2, b2 + i + 2, b2 + i + 1);
  }

  /**
   * Low-poly blob — leaf clusters, bushes, bin bags.
   * `rings` 1 => 12 triangles (debris), 2 => 24 (foliage).
   */
  blob(
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
    o: PropOpts, jitter = 0, seedIn = 1, rings = 2,
    /**
     * Radians of random deflection applied to each vertex NORMAL, independent
     * of the position jitter. A leaf cluster whose normals all agree is a
     * smooth ball: backlit, every facet faces away from the key at once and
     * the whole crown collapses to one black silhouette. Scattering the
     * normals makes some facets catch the sky and some the sun, which is what
     * real foliage does and what stops a tree reading as a hole in the frame.
     */
    nJitter = 0,
  ): void {
    const seg = 6;
    const base = this.pos.length / 3;
    let seed = seedIn;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const dev = (nx: number, ny: number, nz: number): [number, number, number] => {
      if (nJitter <= 0) return [nx, ny, nz];
      const ax = nx + (rnd() - 0.5) * 2 * nJitter;
      const ay = ny + (rnd() - 0.5) * 2 * nJitter;
      const az = nz + (rnd() - 0.5) * 2 * nJitter;
      const l = Math.hypot(ax, ay, az) || 1;
      return [ax / l, ay / l, az / l];
    };
    // top pole
    {
      const [px, py, pz] = dev(0, 1, 0);
      this.v(cx, cy + ry, cz, px, py, pz, o);
    }
    for (let r = 1; r <= rings; r++) {
      const phi = (r / (rings + 1)) * Math.PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      for (let i = 0; i < seg; i++) {
        const th = (i / seg) * Math.PI * 2;
        const j = 1 + (rnd() - 0.5) * jitter;
        const nx = sp * Math.cos(th);
        const ny = cp;
        const nz = sp * Math.sin(th);
        const [dx, dy, dz] = dev(nx, ny, nz);
        this.v(cx + nx * rx * j, cy + ny * ry * j, cz + nz * rz * j, dx, dy, dz, o);
      }
    }
    {
      const [px, py, pz] = dev(0, -1, 0);
      this.v(cx, cy - ry, cz, px, py, pz, o);
    }
    const ringStart = (r: number): number => base + 1 + (r - 1) * seg;
    for (let i = 0; i < seg; i++) {
      const a = ringStart(1) + i;
      const b = ringStart(1) + ((i + 1) % seg);
      this.idx.push(base, b, a);
    }
    for (let r = 1; r < rings; r++) {
      for (let i = 0; i < seg; i++) {
        const a = ringStart(r) + i;
        const b = ringStart(r) + ((i + 1) % seg);
        const c = ringStart(r + 1) + i;
        const d = ringStart(r + 1) + ((i + 1) % seg);
        this.idx.push(a, b, d, a, d, c);
      }
    }
    const bottom = base + 1 + rings * seg;
    for (let i = 0; i < seg; i++) {
      const a = ringStart(rings) + i;
      const b = ringStart(rings) + ((i + 1) % seg);
      this.idx.push(bottom, a, b);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMR', new THREE.Float32BufferAttribute(this.mr, 2));
    g.setAttribute('aEmissive', new THREE.Float32BufferAttribute(this.emis, 3));
    g.setAttribute('aTrans', new THREE.Float32BufferAttribute(this.trans, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* Material                                                            */
/* ------------------------------------------------------------------ */

export interface PropMaterialSet {
  solid: THREE.MeshStandardMaterial;
  /** Night ramp shared with the city: emissives lift after dusk. */
  uNight: { value: number };
  /** World-space direction TO the sun. Drives foliage back-scatter. */
  uSunDir: { value: THREE.Vector3 };
  /** Linear radiance of the key light, so translucency matches the sun. */
  uSunColor: { value: THREE.Color };
  dispose(): void;
}

const PROP_VERT_PARS = /* glsl */ `
attribute vec2 aMR;
attribute vec3 aEmissive;
attribute float aTrans;
varying vec2 vPMR;
varying vec3 vPEmi;
varying float vPTrans;
varying vec3 vPWPos;
varying vec3 vPWNrm;
`;

const PROP_VERT_MAIN = /* glsl */ `
vPMR = aMR;
vPEmi = aEmissive;
vPTrans = aTrans;
vPWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vPWNrm = normalize(mat3(modelMatrix) * objectNormal);
`;

const PROP_FRAG_PARS = /* glsl */ `
varying vec2 vPMR;
varying vec3 vPEmi;
varying float vPTrans;
varying vec3 vPWPos;
varying vec3 vPWNrm;
uniform float uNight;
uniform vec3 uPropSunDir;
uniform vec3 uPropSunColor;
`;

export function createPropMaterials(): PropMaterialSet {
  const uNight = { value: 0 };
  const uSunDir = { value: new THREE.Vector3(-0.95, 0.056, -0.31).normalize() };
  const uSunColor = { value: srgb(0xffab72).multiplyScalar(2.6) };

  const solid = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    emissive: 0xffffff,
    emissiveIntensity: 1,
    envMapIntensity: 1.05,
    dithering: true,
  });

  solid.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = uNight;
    shader.uniforms.uPropSunDir = uSunDir;
    shader.uniforms.uPropSunColor = uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${PROP_VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${PROP_VERT_MAIN}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PROP_FRAG_PARS}`)
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp(vPMR.y, 0.02, 1.0);',
      )
      .replace(
        '#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\nmetalnessFactor = clamp(vPMR.x, 0.0, 1.0);',
      )
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance = vPEmi * (1.0 + 2.2 * uNight);',
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        // BACK-SCATTER through thin surfaces (leaves, fabric awnings, paper).
        // Two terms, because foliage does two things at once:
        //   - a broad WRAPPED diffuse, so the shadow side of a crown is lit by
        //     the sun that is behind it instead of falling to the fill alone;
        //   - a tight forward-scatter lobe that fires when the viewer looks
        //     along the sun ray THROUGH the canopy, which is the amber glow
        //     that makes an autumn tree read as foliage and not as a lump.
        if (vPTrans > 0.001) {
          vec3 _n = normalize(vPWNrm);
          vec3 _v = normalize(vPWPos - cameraPosition);
          // Weighted so the DIRECTIONAL term dominates — matched to the city's
          // detail shader. Turned up, the broad wrapped term fires on half the
          // facets of every cluster at once and bleaches an amber canopy to
          // cream, which is as wrong as the black plates it replaced.
          float _wrapT = max(0.0, (-dot(_n, uPropSunDir) + 0.45) / 1.45);
          float _thru = pow(max(0.0, dot(_v, uPropSunDir)), 4.0);
          totalEmissiveRadiance += diffuseColor.rgb * uPropSunColor * vPTrans *
            (_wrapT * 0.24 + _thru * 1.05) * (1.0 - uNight * 0.8);
        }
        `,
      );
  };
  solid.customProgramCacheKey = () => 'gta-prop-solid-v3';
  solid.name = 'gta:props';

  return {
    solid,
    uNight,
    uSunDir,
    uSunColor,
    dispose() {
      solid.dispose();
    },
  };
}
