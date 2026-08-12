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

  /**
   * Flat roof cap.
   *
   * Fan-triangulated for the generated footprints (rectangles and the L-plan,
   * both star-shaped about vertex 0). REAL OSM FOOTPRINTS ARE NEITHER: a
   * Bucharest perimeter block is a ragged 20-gon with re-entrant corners, and a
   * fan over one of those throws triangles clean outside the building — roofs
   * that spill over the pavement and z-fight the street. Anything past a
   * quadrilateral goes through the ear clipper instead, which preserves the
   * input winding so the cap keeps facing up either way.
   */
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
    if (footprint.length <= 4) {
      for (let i = 1; i < footprint.length - 1; i++) {
        this.idx.push(base, base + i, base + i + 1);
      }
      return;
    }
    for (const t of triangulate(footprint)) {
      this.idx.push(base + t[0], base + t[1], base + t[2]);
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

  /** Single triangle, world-metre UVs. */
  tri(a: Vec2, b: Vec2, c: Vec2, y: number, p: SurfParams): void {
    const base = this.pos.length / 3;
    for (const v of [a, b, c]) {
      this.pos.push(v.x, y, v.z);
      this.nrm.push(0, 1, 0);
      this.uv.push(v.x, v.z);
      this.s1.push(p.kind, p.a, p.b, p.seed);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  /**
   * Arbitrary horizontal polygon — real park outlines, square paving, junction
   * patches. Ear-clipped; the winding of the input decides which way it faces,
   * and `poly` normalises it to the same handedness `rect` uses so a park never
   * comes out invisible from above.
   */
  poly(points: ReadonlyArray<Vec2>, y: number, p: SurfParams): void {
    if (points.length < 3) return;
    const ring = signedArea(points) > 0 ? points.slice().reverse() : points;
    const base = this.pos.length / 3;
    for (const v of ring) {
      this.pos.push(v.x, y, v.z);
      this.nrm.push(0, 1, 0);
      this.uv.push(v.x, v.z);
      this.s1.push(p.kind, p.a, p.b, p.seed);
    }
    for (const t of triangulate(ring)) {
      this.idx.push(base + t[0], base + t[1], base + t[2]);
    }
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
   *
   * `runCamber` cambers along the RUN axis instead of across the width, for
   * ribbons laid at right angles to the traffic — zebra crossings and stop
   * bars, which cross a cambered carriageway and must ride its crown. Without
   * it a crossing is a flat plane at its own y while the road it sits on bulges
   * 90 mm above it in the middle, so the markings are buried across the whole
   * central span and no crossing is visible anywhere in the city. A flat run
   * needs one row; a cambered one needs enough rows to resolve the parabola.
   *
   * `runFrom`/`runTo` say where the run's two ends sit on the host road, as a
   * signed fraction of its half-width: a full kerb-to-kerb crossing is -1 to 1,
   * a stop bar covering one direction of travel is 0 to -1.
   */
  ribbon(
    x0: number, z0: number, x1: number, z1: number,
    width: number, y: number, camber: number, p: SurfParams,
    segments = 4,
    runCamber = 0,
    runFrom = -1,
    runTo = 1,
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
    const rows = runCamber !== 0 ? 6 : 1;
    const baseIdx = this.pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      const cx = x0 + dx * t;
      const cz = z0 + dz * t;
      // Signed distance from the host road's centreline, normalised to its
      // half-width — this is what the road's own camber is a function of.
      const rn = runFrom + (runTo - runFrom) * t;
      const runCrown = runCamber * (1 - rn * rn);
      for (let c = 0; c <= cols; c++) {
        const s = c / cols;
        const off = (s - 0.5) * width;
        const crown = camber * (1 - (off / hw) * (off / hw)) + runCrown;
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
        /*
         * WINDING — was `(i0, i3, i2)(i0, i2, i1)`, which faces DOWN.
         *
         * i1 steps +1 ACROSS the width (along the left-hand perpendicular
         * `p = (-uz, ux)`) and i3 steps +1 ALONG the run (`u`). The geometric
         * normal of (i0, i3, i2) is therefore cross(run, leftPerp), and with
         * a y-up frame cross(u, p) = (0, -1, 0): every carriageway, lane line,
         * zebra crossing, stop bar and tram bed in the city was a downward-
         * facing sheet whose vertices all claimed (0, 1, 0). All three city
         * materials are FrontSide, so none of it was drawn at all and what
         * showed through was the near-black bedrock underlay — which under a
         * three-degree sun is indistinguishable from wet asphalt.
         *
         * `(i0, i1, i2)(i0, i2, i3)` walks across the width first, giving
         * cross(leftPerp, run) = (0, 1, 0). Asserted in builders.test.ts.
         */
        this.idx.push(i0, i1, i2, i0, i2, i3);
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
  /**
   * TRANSLUCENCY 0..1 — how much light passes THROUGH this surface.
   *
   * The sun sits three degrees above the horizon, so every street tree in the
   * city is backlit. An opaque leaf cluster under that key renders as a black
   * hole punched in a magenta sky; a real backlit autumn canopy is the
   * brightest amber in the frame. This drives a wrapped back-scatter plus a
   * forward-scatter lobe in the detail shader (see createCityMaterials).
   */
  trans?: number;
  /**
   * WIND SWAY AMPLITUDE in metres. Displaced in the vertex shader by a cheap
   * two-frequency gust field; 0 for anything that is not foliage. Crown tips
   * want ~0.10-0.18, inner branches ~0.02, trunks 0.
   */
  wind?: number;
}

/** Cheap physical proxy for one semantic piece of merged city dressing. */
export interface DetailCollisionBox {
  kind: string;
  position: THREE.Vector3;
  halfExtents: THREE.Vector3;
  /** Detail geometry applies R_y(-rotationY); physics mirrors that transform. */
  rotationY: number;
}

const WHITE: [number, number] = [0, 0.85];
const NO_E = [0, 0, 0];

export class DetailBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly col: number[] = [];
  readonly mr: number[] = [];
  readonly emi: number[] = [];
  /** (translucency, wind sway amplitude) per vertex. */
  readonly fol: number[] = [];
  readonly idx: number[] = [];
  /** Semantic blockers only; decorative sub-parts never add boxes themselves. */
  readonly collisionBoxes: DetailCollisionBox[] = [];

  get triangles(): number {
    return this.idx.length / 3;
  }

  get isEmpty(): boolean {
    return this.idx.length === 0;
  }

  collisionBox(
    kind: string,
    cx: number, cy: number, cz: number,
    sx: number, sy: number, sz: number,
    rotationY = 0,
  ): void {
    this.collisionBoxes.push({
      kind,
      position: new THREE.Vector3(cx, cy, cz),
      halfExtents: new THREE.Vector3(sx / 2, sy / 2, sz / 2),
      rotationY,
    });
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
    this.fol.push(o.trans ?? 0, o.wind ?? 0);
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

  /**
   * Tube between two arbitrary points — branches, brackets, handrails.
   * Untapered and uncapped: at branch radii the caps are invisible and cost
   * two thirds of the triangles.
   */
  tube(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r: number, seg: number, o: DetailOpts,
  ): void {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    let px = 0;
    let py = 1;
    let pz = 0;
    if (Math.abs(uy) > 0.9) { px = 1; py = 0; pz = 0; }
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
      this.push(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, o);
      this.push(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, o);
    }
    /*
     * WINDING. This walks the ring pair the OPPOSITE way round to `cyl`,
     * because the (t, s) frame it builds turns the other way: for a vertical
     * axis `cyl` steps +x -> +z while this steps -z -> -x. Emitting `cyl`'s
     * index order on top of that produced triangles whose faces pointed INTO
     * the tube while every vertex normal pointed out of it.
     *
     * With front-face culling on, what you then see through a branch is its
     * far inner wall, shaded by an outward normal that happens to face the
     * key — so every branch, twig, catenary wire, handrail and bracket in the
     * city rendered as a BLINDING WHITE stick. On a tree that is the whole
     * "white twigs poking out of the crown" complaint, and it is why a trunk
     * built half from `cyl` and half from `tube` was dark up to its midpoint
     * and white above it, which is what finally located this.
     */
    for (let i = 0; i < seg; i++) {
      const i0 = base + i * 2;
      this.idx.push(i0, i0 + 3, i0 + 1, i0, i0 + 2, i0 + 3);
    }
  }

  /**
   * Low-poly irregular blob — leaf clusters and shrub masses.
   *
   * `rings` 1 => 12 triangles, 2 => 24. `jitter` deforms the POSITIONS so the
   * silhouette is ragged; `nJitter` scatters the NORMALS independently, which
   * is what stops a backlit crown collapsing into one flat dark facet. Both
   * matter: position jitter fixes the outline, normal jitter fixes the shading.
   */
  blob(
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
    o: DetailOpts, jitter = 0, seedIn = 1, rings: 1 | 2 = 2, nJitter = 0,
    /** Radial segments. 6 is cheap; 8 stops a >1 m lobe reading as a hexagon. */
    seg = 6,
  ): void {
    const base = this.pos.length / 3;
    let seed = seedIn >>> 0 || 1;
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
    {
      const [px, py, pz] = dev(0, 1, 0);
      this.push(cx, cy + ry, cz, px, py, pz, o);
    }
    for (let r = 1; r <= rings; r++) {
      const phi = (r / (rings + 1)) * Math.PI;
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      for (let i = 0; i < seg; i++) {
        const th = (i / seg) * Math.PI * 2 + rnd() * 0.25;
        const j = 1 + (rnd() - 0.5) * jitter;
        const nx = sp * Math.cos(th);
        const ny = cp;
        const nz = sp * Math.sin(th);
        const [dx, dy, dz] = dev(nx, ny, nz);
        this.push(cx + nx * rx * j, cy + ny * ry * j, cz + nz * rz * j, dx, dy, dz, o);
      }
    }
    {
      const [px, py, pz] = dev(0, -1, 0);
      this.push(cx, cy - ry, cz, px, py, pz, o);
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

  /**
   * Parapet / cornice following an ARBITRARY footprint.
   *
   * `ring` only knows how to band a world-axis-aligned rectangle, which is all
   * the generated grid ever needed. Real Bucharest blocks sit on streets that
   * run at every angle — Calea Victoriei alone swings through sixty degrees —
   * and an axis-aligned parapet on a skewed building floats off two of its
   * corners and cuts through the other two.
   *
   * Emitted as a strip rather than a box per edge: outer face, top, inner face,
   * six triangles per edge against `ring`'s twelve, so a 14-sided perimeter
   * block costs about what a rectangle used to.
   */
  ringPoly(
    points: ReadonlyArray<Vec2>,
    y: number, thickness: number, height: number, o: DetailOpts,
  ): void {
    const n = points.length;
    if (n < 3) return;
    const inner = insetPolygon(points, thickness);
    const top = y + height;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const ia = inner[i];
      const ib = inner[(i + 1) % n];
      // Outer face, top band, inner face.
      this.quad([a.x, y, a.z], [b.x, y, b.z], [b.x, top, b.z], [a.x, top, a.z], o);
      this.quad([a.x, top, a.z], [b.x, top, b.z], [ib.x, top, ib.z], [ia.x, top, ia.z], o);
      this.quad([ia.x, top, ia.z], [ib.x, top, ib.z], [ib.x, y, ib.z], [ia.x, y, ia.z], o);
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
    g.setAttribute('aFoliage', new THREE.Float32BufferAttribute(this.fol, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ------------------------------------------------------------------ */
/* Polygon utilities — needed once real OSM outlines entered the city   */
/* ------------------------------------------------------------------ */

/** Shoelace area. Negative for the clockwise-from-above winding used here. */
export function signedArea(p: ReadonlyArray<Vec2>): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i++) {
    const c = p[i];
    const d = p[(i + 1) % n];
    a += c.x * d.z - d.x * c.z;
  }
  return a / 2;
}

const _tmpShape: THREE.Vector2[] = [];

/**
 * Ear-clip an arbitrary simple polygon into index triples for a HORIZONTAL
 * face, wound so that the face points UP — the same handedness `cap`'s <= 4
 * corner fan and `rect` already use.
 *
 * IT USED TO PROMISE "winding is preserved, so callers keep control of which
 * way the face points". IT DOES NOT AND CANNOT. `THREE.ShapeUtils
 * .triangulateShape` returns POSITIVELY-HANDED triples in the (x, z) plane for
 * BOTH input windings — measured, both ways round — and in a y-up frame a
 * positively-handed triple in (x, z) has geometric normal (0, -1, 0) while both
 * callers push (0, 1, 0) on every vertex. Every park outline, square, junction
 * patch and the roof cap of every imported footprint past four corners was
 * therefore back-face culled and simply not drawn.
 *
 * So the handedness is fixed HERE, once, for both callers, and the promise the
 * old docstring made is retracted: the caller does not control the facing, this
 * function does, and it always faces up.
 */
export function triangulate(p: ReadonlyArray<Vec2>): number[][] {
  _tmpShape.length = 0;
  for (const v of p) _tmpShape.push(new THREE.Vector2(v.x, v.z));
  const tris = THREE.ShapeUtils.triangulateShape(_tmpShape, []);
  // Degenerate rings (collinear, self-touching) come back empty; fall back to a
  // fan so the caller still gets a closed surface rather than a hole. The fan
  // already matches `cap`'s correct <= 4 corner path, so it is NOT reversed.
  if (!tris.length) {
    const out: number[][] = [];
    for (let i = 1; i < p.length - 1; i++) out.push([0, i, i + 1]);
    return out;
  }
  return tris.map((t) => [t[0], t[2], t[1]]);
}

/**
 * Offset a polygon inward by `d`, by moving each vertex along the bisector of
 * its two edge normals. Good enough for parapet bands; it does not attempt to
 * resolve self-intersection on very sharp spurs, so `d` should stay small
 * relative to the shortest edge.
 */
export function insetPolygon(p: ReadonlyArray<Vec2>, d: number): Vec2[] {
  const n = p.length;
  const cw = signedArea(p) < 0;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = p[(i - 1 + n) % n];
    const cur = p[i];
    const next = p[(i + 1) % n];
    const n1 = edgeNormal(prev, cur, cw);
    const n2 = edgeNormal(cur, next, cw);
    let bx = n1.x + n2.x;
    let bz = n1.z + n2.z;
    const l = Math.hypot(bx, bz);
    if (l < 1e-4) { out.push({ x: cur.x, z: cur.z }); continue; }
    bx /= l; bz /= l;
    // Scale so the offset edge sits exactly `d` in, however sharp the corner.
    const cos = Math.max(0.35, bx * n1.x + bz * n1.z);
    out.push({ x: cur.x + bx * (d / cos), z: cur.z + bz * (d / cos) });
  }
  return out;
}

/** Inward unit normal of edge a->b for the given winding. */
function edgeNormal(a: Vec2, b: Vec2, clockwise: boolean): Vec2 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  // For the clockwise-from-above winding this file uses, the inward normal is
  // the RIGHT-hand perpendicular: check it against rectFootprint's west edge,
  // which runs -z to +z at x = -hw and must point back toward +x.
  const s = clockwise ? -1 : 1;
  return { x: (-dz / l) * s, z: (dx / l) * s };
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

/**
 * Rectangle with its two STREET-SIDE corners turned in a quarter circle.
 *
 * THE INTERBELIC CORNER BLOCK, which is a species and not a decoration.
 * Bucharest's 1930s corner buildings — Calea Victoriei, Magheru, Piața Romană,
 * and the block in `docs/reference/world/lipscani-oldtown.jpg` — do not meet at
 * a right angle. They sweep round in a drum three to five metres across, carry
 * the balcony bands and the cornice round it unbroken, and often stand a
 * storey taller on the curve. That curve is the entire silhouette difference
 * between the interbelic species and the box next to it, and no facade shader
 * can produce it: `u` restarts at every arris, so a shader can only PAINT a
 * corner, and a painted corner still meets the sky at 90 degrees.
 *
 * Rounding costs `2 * (seg - 1)` extra footprint vertices, i.e. four extra
 * wall quads at seg 3 — eight triangles for the whole building, whatever its
 * height, because the massing is quads. Everything hung off the footprint
 * (cornice, parapet, string courses, roof cap) follows it for free.
 *
 * Corners are given in the site's own frame, where local -z faces the street,
 * and the ring keeps `rectFootprint`'s clockwise-from-above winding.
 */
export function roundedFrontFootprint(
  cx: number, cz: number, w: number, d: number, rot: number,
  radius: number, seg = 3,
): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  const r = Math.max(0.4, Math.min(radius, hw * 0.45, hd * 0.7));
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const out: Vec2[] = [];
  const put = (x: number, z: number): void => {
    out.push({ x: cx + x * cs + z * sn, z: cz - x * sn + z * cs });
  };
  /** Quarter arc about (ox, oz), sweeping 90 degrees clockwise from `a0`. */
  const arc = (ox: number, oz: number, a0: number): void => {
    for (let i = 0; i <= seg; i++) {
      const a = a0 - (i / seg) * (Math.PI / 2);
      put(ox + Math.cos(a) * r, oz + Math.sin(a) * r);
    }
  };
  // Same traversal as rectFootprint — west edge, north edge, east edge, front —
  // with the two front corners replaced by arcs.
  put(-hw, -hd + r);
  put(-hw, hd);
  put(hw, hd);
  put(hw, -hd + r);
  arc(hw - r, -hd + r, 0);            // +x round to -z
  put(-hw + r, -hd);
  arc(-hw + r, -hd + r, -Math.PI / 2); // -z round to -x
  return out;
}

/** L-shaped footprint (clockwise) — cuts a notch out of the +x/+z corner. */
export function lFootprint(
  cx: number, cz: number, w: number, d: number, notchW: number, notchD: number,
  rot = 0,
): Vec2[] {
  const hw = w / 2;
  const hd = d / 2;
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const local: Array<[number, number]> = [
    [-hw, -hd],
    [-hw, hd],
    [hw - notchW, hd],
    [hw - notchW, hd - notchD],
    [hw, hd - notchD],
    [hw, -hd],
  ];
  return local.map(([x, z]) => ({ x: cx + x * cs + z * sn, z: cz - x * sn + z * cs }));
}
