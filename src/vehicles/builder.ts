/**
 * Procedural geometry builder for vehicle bodywork.
 *
 * Everything a vehicle needs — paint, chrome, rubber, glass, lamp lenses,
 * upholstery — is baked into ONE merged buffer geometry per material bucket so
 * a whole car costs ~2 draw calls for the shell plus 4 for the wheels.
 *
 * Per-vertex attributes carry what would normally require separate materials:
 *   color     vec3  base albedo (linear)
 *   aMat      vec3  (roughness, metalness, clearcoat)
 *   aLightA   vec4  emissive channel weights: head, tail, brake, reverse
 *   aLightB   vec4  emissive channel weights: indL, indR, interior, aux
 *
 * The lamp channels are driven by two vec4 uniforms per vehicle, so brake
 * lights, indicators and police strobes are a uniform write, not a material
 * swap.
 */

import * as THREE from 'three';
import { Palette } from '../artDirection';

/* ------------------------------------------------------------------ */
/* Surface description                                                 */
/* ------------------------------------------------------------------ */

export type ColorFn = (x: number, y: number, z: number, out: THREE.Color) => void;

/** 8 emissive channels: head, tail, brake, reverse | indL, indR, interior, aux */
export type LightWeights = readonly [number, number, number, number, number, number, number, number];

export const NO_LIGHT: LightWeights = [0, 0, 0, 0, 0, 0, 0, 0];

export interface Surf {
  /** Base colour, already in linear space. */
  color?: THREE.Color;
  /** Per-vertex colour, evaluated in local space. Wins over `color`. */
  colorFn?: ColorFn;
  rough?: number;
  metal?: number;
  /**
   * Clearcoat weight 0..1. Car paint is lacquered: a second, very sharp GGX
   * lobe on top of the base layer. Without it the sun never lands a highlight
   * on the bonnet and the whole car reads as clay.
   */
  coat?: number;
  /** Atlas rect [u0, v0, u1, v1]; the primitive's own 0..1 uv is remapped into it. */
  uv?: readonly [number, number, number, number];
  light?: LightWeights;
}

/** Must match `UV.white` in texture.ts — the flat, untextured atlas cell. */
const WHITE_UV = [0.80, 0.02, 0.95, 0.10] as const;

/* ------------------------------------------------------------------ */
/* Loft cross-sections                                                 */
/* ------------------------------------------------------------------ */

export interface Station {
  z: number;
  /** Half width of the cross-section. */
  hw: number;
  yTop: number;
  yBottom: number;
  /** Corner radius at the top / bottom of the section. */
  rTop: number;
  rBottom: number;
}

/** Number of perimeter samples produced by `outline` (last duplicates first). */
export const PERIM = 28;

const _outA: number[] = [];

/**
 * Rounded-rectangle cross-section, counter-clockwise seen from +Z, seam at
 * bottom-centre so the UV seam lands on the underside. Writes 2*(PERIM) floats
 * (x, y pairs) into `out`.
 */
export function outline(hw: number, yBottom: number, yTop: number, rTop: number, rBottom: number, out: number[]): void {
  out.length = 0;
  const h = yTop - yBottom;
  const rt = Math.min(rTop, hw * 0.9, h * 0.49);
  const rb = Math.min(rBottom, hw * 0.9, h * 0.49);
  const push = (x: number, y: number) => {
    out.push(x, y);
  };
  const edge = (x0: number, y0: number, x1: number, y1: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const t = i / n;
      push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  };
  const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  };
  // bottom-right half edge -> BR corner -> right edge -> TR corner -> top ->
  // TL corner -> left edge -> BL corner -> bottom-left half edge
  edge(0, yBottom, hw - rb, yBottom, 2);
  arc(hw - rb, yBottom + rb, rb, -Math.PI / 2, 0, 3);
  edge(hw, yBottom + rb, hw, yTop - rt, 3);
  arc(hw - rt, yTop - rt, rt, 0, Math.PI / 2, 3);
  edge(hw - rt, yTop, -(hw - rt), yTop, 5);
  arc(-(hw - rt), yTop - rt, rt, Math.PI / 2, Math.PI, 3);
  edge(-hw, yTop - rt, -hw, yBottom + rb, 3);
  arc(-(hw - rb), yBottom + rb, rb, Math.PI, Math.PI * 1.5, 3);
  edge(-(hw - rb), yBottom, 0, yBottom, 2);
  push(0, yBottom); // closing duplicate for the UV seam
}

/* ------------------------------------------------------------------ */
/* Builder                                                             */
/* ------------------------------------------------------------------ */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();
const _c = new THREE.Color();
const _strutM = new THREE.Matrix4();

export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  private mat: number[] = [];
  private la: number[] = [];
  private lb: number[] = [];

  get triangles(): number {
    return this.pos.length / 9;
  }

  /** Raw vertex writer; positions/normals are already world(local)-space. */
  private vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, s: Surf): void {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    const r = s.uv ?? WHITE_UV;
    this.uvs.push(r[0] + (r[2] - r[0]) * u, r[1] + (r[3] - r[1]) * v);
    if (s.colorFn) {
      s.colorFn(x, y, z, _c);
      this.col.push(_c.r, _c.g, _c.b);
    } else {
      const c = s.color ?? WHITE_C;
      this.col.push(c.r, c.g, c.b);
    }
    this.mat.push(s.rough ?? 0.5, s.metal ?? 0, s.coat ?? 0);
    const l = s.light ?? NO_LIGHT;
    this.la.push(l[0], l[1], l[2], l[3]);
    this.lb.push(l[4], l[5], l[6], l[7]);
  }

  /** Append an arbitrary geometry, transformed. */
  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4 | null, s: Surf): this {
    const p = geo.attributes.position as THREE.BufferAttribute;
    const nAttr = geo.attributes.normal as THREE.BufferAttribute | undefined;
    const uvAttr = geo.attributes.uv as THREE.BufferAttribute | undefined;
    const index = geo.index;
    const count = index ? index.count : p.count;
    if (matrix) _nm.getNormalMatrix(matrix);

    for (let i = 0; i < count; i++) {
      const vi = index ? index.getX(i) : i;
      _v.fromBufferAttribute(p, vi);
      if (matrix) _v.applyMatrix4(matrix);
      if (nAttr) {
        _n.fromBufferAttribute(nAttr, vi);
        if (matrix) _n.applyMatrix3(_nm).normalize();
      } else {
        _n.set(0, 1, 0);
      }
      const u = uvAttr ? uvAttr.getX(vi) : 0.5;
      const v = uvAttr ? uvAttr.getY(vi) : 0.5;
      this.vertex(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, u, v, s);
    }
    return this;
  }

  /** Triangle from explicit corners; normal derived from winding. */
  tri(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    s: Surf,
    uv?: readonly [number, number, number, number, number, number],
  ): this {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const q = uv ?? [0, 0, 1, 0, 1, 1];
    this.vertex(ax, ay, az, nx, ny, nz, q[0], q[1], s);
    this.vertex(bx, by, bz, nx, ny, nz, q[2], q[3], s);
    this.vertex(cx, cy, cz, nx, ny, nz, q[4], q[5], s);
    return this;
  }

  /** Quad a→b→c→d (counter-clockwise from the front face). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, s: Surf): this {
    this.tri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, s, [0, 0, 1, 0, 1, 1]);
    this.tri(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z, s, [0, 0, 1, 1, 0, 1]);
    return this;
  }

  /** Axis-aligned box, optionally transformed. */
  box(w: number, h: number, d: number, m: THREE.Matrix4 | null, s: Surf): this {
    return this.add(cachedBox(w, h, d), m, s);
  }

  /** Box spanning `from` → `to` with cross-section `w` x `d`. See `span`. */
  strut(from: THREE.Vector3, to: THREE.Vector3, w: number, d: number, s: Surf): this {
    return this.add(cachedBox(1, 1, 1), span(from, to, w, d, _strutM), s);
  }

  cyl(rTop: number, rBot: number, h: number, seg: number, m: THREE.Matrix4 | null, s: Surf, open = false): this {
    return this.add(cachedCyl(rTop, rBot, h, seg, open), m, s);
  }

  sphere(r: number, seg: number, m: THREE.Matrix4 | null, s: Surf): this {
    return this.add(cachedSphere(r, seg), m, s);
  }

  torus(r: number, tube: number, radial: number, tubular: number, arc: number, m: THREE.Matrix4 | null, s: Surf): this {
    return this.add(cachedTorus(r, tube, radial, tubular, arc), m, s);
  }

  /**
   * Loft a chain of rounded-rect cross-sections along +Z. This is what gives
   * the cars a real body: wheel arches come from raising `yBottom` at the axle
   * stations, the bonnet/boot from dropping `yTop`, tumblehome from `hw`.
   *
   * `opts.route` is what makes opening doors possible. For every quad it is
   * handed the quad centre; returning another builder moves that quad OUT of
   * this one and into that one. The door skin is therefore not a panel stuck on
   * top of the flank — it is literally the piece of pressed steel that is
   * missing from the body, so when it swings there is a real hole behind it.
   */
  loft(
    stations: Station[],
    s: Surf,
    opts?: {
      capFront?: boolean;
      capRear?: boolean;
      vScale?: number;
      route?: (cx: number, cy: number, cz: number) => GeoBuilder | null;
    },
  ): this {
    const n = stations.length;
    if (n < 2) return this;
    const rings: number[][] = [];
    const uCoord: number[] = [];
    for (let i = 0; i < n; i++) {
      const st = stations[i];
      outline(st.hw, st.yBottom, st.yTop, st.rTop, st.rBottom, _outA);
      rings.push(_outA.slice());
    }
    // u by arc length of the first ring
    {
      const r0 = rings[0];
      const m = r0.length / 2;
      let total = 0;
      uCoord.push(0);
      for (let k = 1; k < m; k++) {
        total += Math.hypot(r0[k * 2] - r0[(k - 1) * 2], r0[k * 2 + 1] - r0[(k - 1) * 2 + 1]);
        uCoord.push(total);
      }
      for (let k = 0; k < m; k++) uCoord[k] = total > 0 ? uCoord[k] / total : 0;
    }
    const m = rings[0].length / 2;
    const z0 = stations[0].z;
    const zSpan = stations[n - 1].z - z0 || 1;
    const vs = opts?.vScale ?? 1;

    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), D = new THREE.Vector3();
    for (let i = 0; i < n - 1; i++) {
      const ri = rings[i], rj = rings[i + 1];
      const zi = stations[i].z, zj = stations[i + 1].z;
      const vi = ((zi - z0) / zSpan) * vs;
      const vj = ((zj - z0) / zSpan) * vs;
      for (let k = 0; k < m - 1; k++) {
        A.set(ri[k * 2], ri[k * 2 + 1], zi);
        B.set(ri[(k + 1) * 2], ri[(k + 1) * 2 + 1], zi);
        C.set(rj[(k + 1) * 2], rj[(k + 1) * 2 + 1], zj);
        D.set(rj[k * 2], rj[k * 2 + 1], zj);
        // Skip degenerate slivers.
        if (A.distanceToSquared(B) < 1e-9 && D.distanceToSquared(C) < 1e-9) continue;
        let target: GeoBuilder = this;
        if (opts?.route) {
          const cx = (A.x + B.x + C.x + D.x) * 0.25;
          const cy = (A.y + B.y + C.y + D.y) * 0.25;
          const cz = (A.z + B.z + C.z + D.z) * 0.25;
          target = opts.route(cx, cy, cz) ?? this;
        }
        target.smoothQuad(A, B, C, D, uCoord[k], uCoord[k + 1], vi, vj, s);
      }
    }
    if (opts?.capFront !== false) this.cap(rings[n - 1], stations[n - 1].z, 1, s);
    if (opts?.capRear !== false) this.cap(rings[0], stations[0].z, -1, s);
    return this;
  }

  /** Quad with normals averaged from the quad plane — keeps lofts smooth-ish. */
  smoothQuad(
    a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3,
    u0: number, u1: number, v0: number, v1: number, s: Surf,
  ): void {
    // Face normal of the whole quad (averaged) so adjacent strips agree.
    _n.set(0, 0, 0);
    const e1 = _v.subVectors(b, a);
    const e2 = new THREE.Vector3().subVectors(d, a);
    _n.crossVectors(e1, e2);
    e1.subVectors(c, b);
    e2.subVectors(a, b);
    _n.add(new THREE.Vector3().crossVectors(e1, e2));
    _n.normalize();
    const nx = _n.x, ny = _n.y, nz = _n.z;
    this.vertex(a.x, a.y, a.z, nx, ny, nz, u0, v0, s);
    this.vertex(b.x, b.y, b.z, nx, ny, nz, u1, v0, s);
    this.vertex(c.x, c.y, c.z, nx, ny, nz, u1, v1, s);
    this.vertex(a.x, a.y, a.z, nx, ny, nz, u0, v0, s);
    this.vertex(c.x, c.y, c.z, nx, ny, nz, u1, v1, s);
    this.vertex(d.x, d.y, d.z, nx, ny, nz, u0, v1, s);
  }

  private cap(ring: number[], z: number, dir: number, s: Surf): void {
    const m = ring.length / 2;
    let cx = 0, cy = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let k = 0; k < m - 1; k++) {
      const x = ring[k * 2], yy = ring[k * 2 + 1];
      cx += x; cy += yy;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    }
    cx /= m - 1; cy /= m - 1;
    // Planar UV across the cap. A triangle-fan UV would smear the atlas into a
    // sunburst across the whole nose/tail panel.
    const sx = 1 / Math.max(1e-4, maxX - minX);
    const sy = 1 / Math.max(1e-4, maxY - minY);
    const u = (x: number) => (x - minX) * sx;
    const v = (yy: number) => (yy - minY) * sy;
    for (let k = 0; k < m - 1; k++) {
      const ax = ring[k * 2], ay = ring[k * 2 + 1];
      const bx = ring[(k + 1) * 2], by = ring[(k + 1) * 2 + 1];
      if (dir > 0) {
        this.vertex(cx, cy, z, 0, 0, 1, u(cx), v(cy), s);
        this.vertex(ax, ay, z, 0, 0, 1, u(ax), v(ay), s);
        this.vertex(bx, by, z, 0, 0, 1, u(bx), v(by), s);
      } else {
        this.vertex(cx, cy, z, 0, 0, -1, u(cx), v(cy), s);
        this.vertex(bx, by, z, 0, 0, -1, u(bx), v(by), s);
        this.vertex(ax, ay, z, 0, 0, -1, u(ax), v(ay), s);
      }
    }
  }

  build(smoothAngleDeg = 36): THREE.BufferGeometry {
    if (smoothAngleDeg > 0) smoothNormals(this.pos, this.nor, smoothAngleDeg);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 3));
    g.setAttribute('aLightA', new THREE.Float32BufferAttribute(this.la, 4));
    g.setAttribute('aLightB', new THREE.Float32BufferAttribute(this.lb, 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const WHITE_C = new THREE.Color(1, 1, 1);

/**
 * Weld-and-smooth pass: vertices that share a position get an averaged normal,
 * but only across faces meeting at less than `angleDeg`. That keeps panel
 * creases, chrome edges and box corners crisp while making the lofted roof,
 * bonnet and wings read as continuous pressed steel instead of facets.
 */
function smoothNormals(pos: number[], nor: number[], angleDeg: number): void {
  const cosLimit = Math.cos((angleDeg * Math.PI) / 180);
  const buckets = new Map<string, number[]>();
  const n = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const key =
      `${Math.round(pos[i * 3] * 2000)},${Math.round(pos[i * 3 + 1] * 2000)},${Math.round(pos[i * 3 + 2] * 2000)}`;
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    arr.push(i);
  }
  const out = new Float32Array(nor.length);
  for (const arr of buckets.values()) {
    if (arr.length === 1) {
      const i = arr[0];
      out[i * 3] = nor[i * 3]; out[i * 3 + 1] = nor[i * 3 + 1]; out[i * 3 + 2] = nor[i * 3 + 2];
      continue;
    }
    for (const i of arr) {
      const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (const j of arr) {
        const mx = nor[j * 3], my = nor[j * 3 + 1], mz = nor[j * 3 + 2];
        if (nx * mx + ny * my + nz * mz >= cosLimit) { sx += mx; sy += my; sz += mz; }
      }
      const len = Math.hypot(sx, sy, sz) || 1;
      out[i * 3] = sx / len; out[i * 3 + 1] = sy / len; out[i * 3 + 2] = sz / len;
    }
  }
  for (let i = 0; i < nor.length; i++) nor[i] = out[i];
}

/* ------------------------------------------------------------------ */
/* Primitive cache — build-time only, shared across every variant       */
/* ------------------------------------------------------------------ */

const primCache = new Map<string, THREE.BufferGeometry>();
function cached(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = primCache.get(key);
  if (!g) {
    g = make();
    primCache.set(key, g);
  }
  return g;
}
const cachedBox = (w: number, h: number, d: number) =>
  cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cachedCyl = (rt: number, rb: number, h: number, seg: number, open: boolean) =>
  cached(`c${rt},${rb},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
const cachedSphere = (r: number, seg: number) =>
  cached(`s${r},${seg}`, () => new THREE.SphereGeometry(r, seg, Math.max(3, seg >> 1)));
const cachedTorus = (r: number, tube: number, rad: number, tub: number, arc: number) =>
  cached(`t${r},${tube},${rad},${tub},${arc}`, () => new THREE.TorusGeometry(r, tube, rad, tub, arc));

/* ------------------------------------------------------------------ */
/* Transform helper                                                    */
/* ------------------------------------------------------------------ */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Compact TRS matrix helper used everywhere in the body builders. */
export function T(
  px = 0, py = 0, pz = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
  out = new THREE.Matrix4(),
): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  _p.set(px, py, pz);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _bq = new THREE.Quaternion();
const _bs = new THREE.Vector3();

/**
 * Matrix for a box of cross-section `w` x `d` spanning exactly `from` → `to`.
 *
 * Pillars used to be placed with a hand-derived Euler angle, and the sign of
 * that angle was wrong — which is how the Dacia ended up with its A and C
 * pillars leaning the wrong way and X-bracing across the door aperture. Deriving
 * the rotation from the actual segment removes the whole class of mistake.
 */
export function span(
  from: THREE.Vector3, to: THREE.Vector3, w: number, d: number, out = new THREE.Matrix4(),
): THREE.Matrix4 {
  _dir.subVectors(to, from);
  const len = _dir.length() || 1e-4;
  _dir.divideScalar(len);
  _bq.setFromUnitVectors(_up, _dir);
  _mid.addVectors(from, to).multiplyScalar(0.5);
  _bs.set(w, len, d);
  return out.compose(_mid, _bq, _bs);
}

/** Unit box, used with `span` — the scale carries the real dimensions. */
export function unitBox(): THREE.BufferGeometry {
  return cachedBox(1, 1, 1);
}

/* ------------------------------------------------------------------ */
/* Material                                                            */
/* ------------------------------------------------------------------ */

export interface CarUniforms {
  uChanA: { value: THREE.Vector4 };
  uChanB: { value: THREE.Vector4 };
  uEmis: { value: number };
  /** Global grime multiplier — climbs as the car takes damage. */
  uGrime: { value: number };
}

/**
 * Two-band stand-in environment, straight out of the art direction.
 *
 * These are deliberately BRIGHT. They are what chrome, glass and lacquered
 * paint reflect, and at golden hour the sky dome is the single most luminous
 * thing in the world — a timid value here is exactly what makes car paint read
 * as matte clay.
 */
const SKY_TINT = Palette.skyMidBand.clone().lerp(Palette.skyLowBand, 0.5).multiplyScalar(1.75);
const HORIZON_TINT = Palette.skyHorizon.clone().multiplyScalar(1.55);
const GROUND_TINT = Palette.asphaltWet.clone().lerp(Palette.skyAmbient, 0.5).multiplyScalar(0.7);

export function makeCarUniforms(): CarUniforms {
  return {
    uChanA: { value: new THREE.Vector4(0, 0, 0, 0) },
    uChanB: { value: new THREE.Vector4(0, 0, 0, 0) },
    uEmis: { value: 1 },
    uGrime: { value: 0 },
  };
}

const VERT_HEAD = /* glsl */ `
attribute vec3 aMat;
attribute vec4 aLightA;
attribute vec4 aLightB;
uniform vec4 uChanA;
uniform vec4 uChanB;
varying vec3 vMatP;
varying float vEmis;
`;

const FRAG_HEAD = /* glsl */ `
varying vec3 vMatP;
varying float vEmis;
uniform float uEmis;
uniform float uGrime;
uniform vec3 uSkyTint;
uniform vec3 uHorizonTint;
uniform vec3 uGroundTint;

/** Three-band environment: hot orange horizon rip, magenta sky above it,
 *  violet wet street below. Chrome, glass and lacquer need something to
 *  reflect or they read as flat clay, and this stays correct even before a
 *  real probe exists. The horizon band is what puts a warm streak down the
 *  flank of a car at golden hour. */
vec3 gtaFakeEnv(vec3 n, vec3 v) {
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float t = dot(reflect(-v, n), upV);
  vec3 above = mix(uHorizonTint, uSkyTint, smoothstep(0.02, 0.55, t));
  return mix(uGroundTint, above, smoothstep(-0.16, 0.03, t));
}
`;

/**
 * MeshStandardMaterial with per-vertex roughness/metalness and 8 emissive
 * channels. Every vehicle shares the same compiled program.
 */
export function createCarMaterial(
  atlas: THREE.Texture,
  uniforms: CarUniforms,
  opts: { transparent?: boolean; opacity?: number; alphaTest?: number; side?: THREE.Side; glass?: boolean } = {},
): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: atlas,
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.2,
    envMapIntensity: 1.5,
    // Enabling clearcoat here is what compiles the second GGX lobe into the
    // program; the per-vertex `coat` weight then decides which surfaces use
    // it, so rubber and fabric stay matte while paint gets a lacquer sheen.
    clearcoat: 1.0,
    clearcoatRoughness: 0.075,
    emissive: new THREE.Color(0, 0, 0),
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
    alphaTest: opts.alphaTest ?? 0,
    side: opts.side ?? THREE.FrontSide,
    depthWrite: opts.transparent ? false : true,
  });

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uChanA = uniforms.uChanA;
    shader.uniforms.uChanB = uniforms.uChanB;
    shader.uniforms.uEmis = uniforms.uEmis;
    shader.uniforms.uGrime = uniforms.uGrime;
    shader.uniforms.uSkyTint = { value: SKY_TINT };
    shader.uniforms.uHorizonTint = { value: HORIZON_TINT };
    shader.uniforms.uGroundTint = { value: GROUND_TINT };

    shader.vertexShader = VERT_HEAD + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vMatP = aMat;
       vEmis = dot(aLightA, uChanA) + dot(aLightB, uChanB);`,
    );

    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `#include <roughnessmap_fragment>
       roughnessFactor = clamp(mix(vMatP.x, 0.86, uGrime * 0.55), 0.035, 1.0);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <metalnessmap_fragment>',
      `#include <metalnessmap_fragment>
       metalnessFactor = vMatP.y * (1.0 - uGrime * 0.35);`,
    );
    // Per-vertex clearcoat weight. `lights_physical_fragment` is the chunk that
    // fills in `material`, so this is the first legal place to scale it.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
       material.clearcoat *= vMatP.z * (1.0 - uGrime * 0.7);
       material.clearcoatRoughness = clamp(material.clearcoatRoughness + uGrime * 0.35, 0.02, 1.0);`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      opts.glass
        ? `#include <emissivemap_fragment>
       totalEmissiveRadiance += diffuseColor.rgb * max(vEmis, 0.0) * uEmis;
       {
         // Glass mirrors the sky and goes fully opaque at grazing angles.
         // The reflection has to be STRONG: a dark tint at 60% alpha over a
         // dusk street is indistinguishable from an empty window aperture,
         // which is precisely how this car ended up looking roofless.
         vec3 gV = normalize(vViewPosition);
         float gFres = pow(1.0 - clamp(abs(dot(normal, gV)), 0.0, 1.0), 2.9);
         vec3 gEnv = gtaFakeEnv(normal, gV);
         totalEmissiveRadiance += gEnv * (0.16 + gFres * 2.6) * (1.0 - uGrime * 0.4);
         diffuseColor.a = clamp(mix(0.70, 1.0, gFres), 0.0, 1.0);
       }`
        : `#include <emissivemap_fragment>
       totalEmissiveRadiance += diffuseColor.rgb * max(vEmis, 0.0) * uEmis;
       {
         vec3 cV = normalize(vViewPosition);
         float cFres = pow(1.0 - clamp(abs(dot(normal, cV)), 0.0, 1.0), 3.0);
         vec3 env = gtaFakeEnv(normal, cV);
         // Chrome and polished metal reflect the environment tinted by their
         // own colour.
         totalEmissiveRadiance += env * diffuseColor.rgb
           * vMatP.y * (0.34 + cFres * 1.1) * (1.0 - uGrime * 0.5);
         // Lacquered paint gets a sky gradient down the flanks — the broad
         // cool-to-warm falloff that makes a body read as curved metal rather
         // than a flat swatch. Kept modest and half-tinted by the paint itself,
         // because a strong untinted Fresnel lift at grazing angles washes the
         // livery out to a single pale value.
         vec3 coatTint = mix(vec3(1.0), normalize(diffuseColor.rgb + 0.02), 0.45);
         totalEmissiveRadiance += env * coatTint * vMatP.z
           * (0.03 + cFres * 0.20) * (1.0 - uGrime * 0.6);
       }`,
    );
  };
  m.customProgramCacheKey = () => (opts.glass ? 'gtaCarGlass' : 'gtaCarOpaque');
  return m;
}
