/**
 * Geometry accumulators for the city.
 *
 * The whole city is merged into three material families (facade, surface,
 * detail — see materials.ts). Each family has a builder that appends triangles
 * into flat arrays and bakes them into a single BufferGeometry per chunk. This
 * is what keeps a 2000-building Bucharest under a couple of hundred draw calls.
 *
 * WINDING CONVENTION — read before adding geometry:
 *   Footprints are given CLOCKWISE when viewed from above (+Y looking down).
 *   A quad is (a, b, c, d) and emits (0,1,2)(0,2,3). With a clockwise footprint
 *   this yields outward-facing wall normals AND an upward-facing roof.
 */

import * as THREE from 'three';

export interface Vec2 {
  x: number;
  z: number;
}

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();

function faceNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): THREE.Vector3 {
  _ab.set(bx - ax, by - ay, bz - az);
  _ac.set(cx - ax, cy - ay, cz - az);
  return _n.crossVectors(_ab, _ac).normalize();
}

/* ------------------------------------------------------------------ */
/* Facade builder — walls and roofs driven by the facade grammar shader */
/* ------------------------------------------------------------------ */

/** Per-vertex facade grammar parameters. */
export interface FacadeParams {
  /** Grammar id, see FacadeStyle in materials.ts. */
  style: number;
  /** Storey height in metres. */
  floorH: number;
  /** Horizontal bay pitch in metres. */
  bayW: number;
  /** Per-building random seed (stable across faces of one building). */
  seed: number;
  /** Total building height — used for crown/cornice logic. */
  buildingH: number;
  /** Ground-floor (retail/podium/lobby) height in metres. */
  groundH: number;
  /** 0..1 bias on how many windows are lit. */
  lit: number;
  /** 0..1 selects the per-building colour variant inside the grammar. */
  tint: number;
}

export class FacadeBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly f1: number[] = [];
  readonly f2: number[] = [];
  readonly idx: number[] = [];

  get triangles(): number {
    return this.idx.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  /** Raw quad. `uvs` is 8 numbers (u,v per corner) in metres. */
  quad(
    a: number[], b: number[], c: number[], d: number[],
    uvs: number[],
    p: FacadeParams,
  ): void {
    const n = faceNormal(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const base = this.pos.length / 3;
    const corners = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      const v = corners[i];
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.f1.push(p.style, p.floorH, p.bayW, p.seed);
      this.f2.push(p.buildingH, p.groundH, p.lit, p.tint);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Extrude a clockwise footprint between y0 and y1.
   * `vBase` is the facade-space height of y0 (so setbacks keep floor lines
   * aligned with the storeys below).
   */
  extrude(
    footprint: ReadonlyArray<Vec2>,
    y0: number,
    y1: number,
    vBase: number,
    p: FacadeParams,
    opts: { roof?: boolean; walls?: boolean } = {},
  ): void {
    const walls = opts.walls !== false;
    const roof = opts.roof !== false;
    const h = y1 - y0;
    if (walls && h > 0.01) {
      for (let i = 0; i < footprint.length; i++) {
        const s = footprint[i];
        const e = footprint[(i + 1) % footprint.length];
        const len = Math.hypot(e.x - s.x, e.z - s.z);
        if (len < 0.02) continue;
        this.quad(
          [s.x, y0, s.z], [e.x, y0, e.z], [e.x, y1, e.z], [s.x, y1, s.z],
          [0, vBase, len, vBase, len, vBase + h, 0, vBase + h],
          p,
        );
      }
    }
    if (roof) this.cap(footprint, y1, p);
  }

  /** Flat roof cap. Fan-triangulated — footprints are convex or L-shaped. */
  cap(footprint: ReadonlyArray<Vec2>, y: number, p: FacadeParams): void {
    if (footprint.length < 3) return;
    const base = this.pos.length / 3;
    for (const v of footprint) {
      this.pos.push(v.x, y, v.z);
      this.nrm.push(0, 1, 0);
      this.uv.push(v.x, v.z);
      this.f1.push(p.style, p.floorH, p.bayW, p.seed);
      this.f2.push(p.buildingH, p.groundH, p.lit, p.tint);
    }
    for (let i = 1; i < footprint.length - 1; i++) {
      this.idx.push(base, base + i, base + i + 1);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aFacade', new THREE.Float32BufferAttribute(this.f1, 4));
    g.setAttribute('aFacade2', new THREE.Float32BufferAttribute(this.f2, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* Surface builder — roads, pavements, plazas, lawns, water            */
/* ------------------------------------------------------------------ */

export const Surf = {
  asphalt: 0,
  paving: 1,
  kerb: 2,
  plaza: 3,
  grass: 4,
  gravel: 5,
  water: 6,
  tramBed: 7,
  zebra: 8,
  cobbles: 9,
} as const;

export interface SurfParams {
  kind: number;
  /** asphalt: half carriageway width. zebra: stripe pitch. */
  a: number;
  /** asphalt: lanes per direction (packed flags in the fraction). */
  b: number;
  seed: number;
}

export class SurfaceBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly s1: number[] = [];
  readonly idx: number[] = [];

  get triangles(): number {
    return this.idx.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  quad(a: number[], b: number[], c: number[], d: number[], uvs: number[], p: SurfParams): void {
    const n = faceNormal(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const base = this.pos.length / 3;
    const corners = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      const v = corners[i];
      this.pos.push(v[0], v[1], v[2]);
      this.nrm.push(n.x, n.y, n.z);
      this.uv.push(uvs[i * 2], uvs[i * 2 + 1]);
      this.s1.push(p.kind, p.a, p.b, p.seed);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Axis-aligned horizontal slab top face.
   * UVs are world metres so patterns tile continuously between pieces.
   */
  rect(x0: number, z0: number, x1: number, z1: number, y: number, p: SurfParams): void {
    this.quad(
      [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0],
      [x0, z0, x0, z1, x1, z1, x1, z0],
      p,
    );
  }

  /**
   * Road ribbon with camber. Runs from (x0,z0) to (x1,z1) with total width w.
   * uv.x is metres from the left edge, uv.y is metres along the run.
   */
  ribbon(
    x0: number, z0: number, x1: number, z1: number,
    width: number, y: number, camber: number, p: SurfParams,
    segments = 4,
  ): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) return;
    const ux = dx / len;
    const uz = dz / len;
    // Left-hand perpendicular.
    const px = -uz;
    const pz = ux;
    const hw = width / 2;
    const cols = segments;
    const rows = 1;
    const baseIdx = this.pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const cx = x0 + dx * t;
      const cz = z0 + dz * t;
      for (let c = 0; c <= cols; c++) {
        const s = c / cols;
        const off = (s - 0.5) * width;
        const crown = camber * (1 - (off / hw) * (off / hw));
        this.pos.push(cx + px * off, y + crown, cz + pz * off);
        this.nrm.push(0, 1, 0);
        this.uv.push(s * width, t * len);
        this.s1.push(p.kind, p.a, p.b, p.seed);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i0 = baseIdx + r * (cols + 1) + c;
        const i1 = i0 + 1;
        const i2 = i0 + (cols + 1) + 1;
        const i3 = i0 + (cols + 1);
        // Clockwise-from-above ordering for an upward normal.
        this.idx.push(i0, i3, i2, i0, i2, i1);
      }
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.s1, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* Detail builder — cornices, balconies, roof plant, poles, rails      */
/* ------------------------------------------------------------------ */

export interface DetailOpts {
  color: THREE.Color | number[];
  /** metalness, roughness */
  mr?: [number, number];
  emissive?: number[];
}

const WHITE: [number, number] = [0, 0.85];
const NO_E = [0, 0, 0];

export class DetailBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly mr: number[] = [];
  readonly emi: number[] = [];
  readonly idx: number[] = [];

  get triangles(): number {
    return this.idx.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  private push(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    o: DetailOpts,
  ): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    const c = o.color as THREE.Color;
    if ((c as THREE.Color).isColor) this.col.push(c.r, c.g, c.b);
    else {
      const a = o.color as number[];
      this.col.push(a[0], a[1], a[2]);
    }
    const m = o.mr ?? WHITE;
    this.mr.push(m[0], m[1]);
    const e = o.emissive ?? NO_E;
    this.emi.push(e[0], e[1], e[2]);
  }

  quad(a: number[], b: number[], c: number[], d: number[], o: DetailOpts): void {
    const n = faceNormal(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const base = this.pos.length / 3;
    for (const v of [a, b, c, d]) this.push(v[0], v[1], v[2], n.x, n.y, n.z, o);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Axis-aligned box, optionally rotated about Y. */
  box(
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    rotY: number, o: DetailOpts,
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
    this.quad(e, f, g, h, o);          // top
    this.quad(d, c, b, a, o);          // bottom
    this.quad(a, b, f, e, o);          // -x side
    this.quad(c, d, h, g, o);          // +x side
    this.quad(b, c, g, f, o);          // +z side
    this.quad(d, a, e, h, o);          // -z side
  }

  /** Vertical cylinder (poles, tanks, columns). */
  cyl(
    cx: number, cy: number, cz: number,
    rBottom: number, rTop: number, h: number, seg: number,
    o: DetailOpts, capTop = true,
  ): void {
    const base = this.pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      this.push(cx + nx * rBottom, cy, cz + nz * rBottom, nx, 0, nz, o);
      this.push(cx + nx * rTop, cy + h, cz + nz * rTop, nx, 0, nz, o);
    }
    for (let i = 0; i < seg; i++) {
      const i0 = base + i * 2;
      this.idx.push(i0, i0 + 1, i0 + 3, i0, i0 + 3, i0 + 2);
    }
    if (capTop) {
      const cb = this.pos.length / 3;
      this.push(cx, cy + h, cz, 0, 1, 0, o);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        this.push(cx + Math.cos(a) * rTop, cy + h, cz + Math.sin(a) * rTop, 0, 1, 0, o);
      }
      for (let i = 0; i < seg; i++) this.idx.push(cb, cb + i + 2, cb + i + 1);
    }
  }

  /** Ring of boxes forming a parapet / cornice around a rectangle. */
  ring(
    x0: number, z0: number, x1: number, z1: number,
    y: number, thickness: number, height: number, o: DetailOpts,
  ): void {
    const w = x1 - x0;
    const d = z1 - z0;
    const t = thickness;
    this.box((x0 + x1) / 2, y + height / 2, z0 + t / 2, w, height, t, 0, o);
    this.box((x0 + x1) / 2, y + height / 2, z1 - t / 2, w, height, t, 0, o);
    this.box(x0 + t / 2, y + height / 2, (z0 + z1) / 2, t, height, d - 2 * t, 0, o);
    this.box(x1 - t / 2, y + height / 2, (z0 + z1) / 2, t, height, d - 2 * t, 0, o);
  }

  /** Thin unlit billboard-ish plate, used for signs and screens. */
  plate(a: number[], b: number[], c: number[], d: number[], o: DetailOpts): void {
    this.quad(a, b, c, d, o);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMR', new THREE.Float32BufferAttribute(this.mr, 2));
    g.setAttribute('aEmissive', new THREE.Float32BufferAttribute(this.emi, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Rectangle footprint, clockwise viewed from above. */
export function rectFootprint(cx: number, cz: number, w: number, d: number, rot = 0): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const pts: Array<[number, number]> = [
    [-hw, -hd], [-hw, hd], [hw, hd], [hw, -hd],
  ];
  return pts.map(([x, z]) => ({ x: cx + x * cs + z * sn, z: cz - x * sn + z * cs }));
}

/** L-shaped footprint (clockwise) — cuts a notch out of the +x/+z corner. */
export function lFootprint(
  cx: number, cz: number, w: number, d: number, notchW: number, notchD: number,
): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: cx - hw, z: cz - hd },
    { x: cx - hw, z: cz + hd },
    { x: cx + hw - notchW, z: cz + hd },
    { x: cx + hw - notchW, z: cz + hd - notchD },
    { x: cx + hw, z: cz + hd - notchD },
    { x: cx + hw, z: cz - hd },
  ];
}
