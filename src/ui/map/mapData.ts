/**
 * STATIC MAP DATA — built once, from the city, at init.
 *
 * OWNER: map agent.
 *
 * The map is not a picture of the city, it *is* the city's road graph. Every
 * street you see drawn comes from `CityService.roadNodes`; every tint comes
 * from `CityService.districtAt`. Nothing here is hand-authored geometry, so
 * the map can never drift out of sync with the world the player drives
 * through — regenerate the city with a new seed and the map follows.
 *
 * Two things are precomputed because they are far too expensive per frame:
 *
 *  1. `segs` + `grid` — the undirected edge list of the road graph, hashed
 *     into a coarse spatial grid. The minimap only ever strokes the handful of
 *     segments overlapping its window, which is what keeps a fully vector
 *     (and therefore crisp at any zoom) minimap essentially free.
 *  2. `wash` — a 160x160 raster of `districtAt`, drawn back scaled and
 *     smoothed. Sampling 25k district lookups per frame is impossible;
 *     sampling them once and blitting a bitmap costs one drawImage.
 */

import type { CityService, DistrictKind, RoadNode } from '../../core/services';

export interface RoadSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Lanes per direction — decides stroke weight. */
  lanes: number;
  /** Boulevards and the monumental axis: drawn brighter and wider. */
  major: boolean;
}

export interface MapLandmark {
  id: string;
  name: string;
  x: number;
  z: number;
  radius: number;
  /**
   * `story` and `plaza`/`park` are the authored anchors the city was built
   * around — they get a disc, a blip and a caption. `poi` is everything the
   * OpenStreetMap import brought in (well over a hundred churches, schools,
   * malls and office blocks): real, worth showing, but only as a small dot on
   * a zoomed-in full map. Painting them like landmarks turned the minimap into
   * a solid wash of overlapping discs.
   */
  kind: 'story' | 'plaza' | 'park' | 'poi';
}

export interface DistrictLabel {
  name: string;
  x: number;
  z: number;
  kind: DistrictKind;
}

/** Romanian display names for the district kinds. */
export const DISTRICT_NAMES: Record<DistrictKind, string> = {
  centruVechi: 'CENTRUL VECHI',
  bulevard: 'BULEVARDE',
  glassCorporate: 'SECTORUL DE STICLĂ',
  guvern: 'CARTIERUL GUVERNAMENTAL',
  cartier: 'CARTIERE DE BLOCURI',
  industrial: 'ZONA INDUSTRIALĂ',
  parc: 'PARC',
};

/** Map tints. Deep violet base, districts separated by hue not by brightness. */
export const DISTRICT_TINT: Record<DistrictKind, [number, number, number]> = {
  centruVechi: [58, 33, 50],
  bulevard: [37, 26, 52],
  glassCorporate: [28, 38, 66],
  guvern: [54, 32, 56],
  cartier: [30, 26, 44],
  industrial: [45, 34, 42],
  parc: [26, 46, 36],
};

const WASH_RES = 160;

/**
 * The tints above are chosen as *ink*, and ink on a black sheet reads darker
 * than it measures. Metering the first full-map screenshot, the districts were
 * separated by three or four levels out of 255 — invisible. This gain is the
 * smallest one that makes the old town read warm, the corporate belt read
 * cold and the panel-block cartiere read neutral without ever approaching the
 * value of the pale carriageways drawn on top of them.
 */
const WASH_GAIN = 1.3;

export class MapData {
  readonly segs: RoadSeg[] = [];
  readonly landmarks: MapLandmark[] = [];
  readonly districtLabels: DistrictLabel[] = [];

  /** World-space bounds of the road network, padded. */
  minX = -1;
  minZ = -1;
  maxX = 1;
  maxZ = 1;

  /** District colour raster covering [minX,maxX] x [minZ,maxZ]. */
  wash: HTMLCanvasElement | null = null;

  readonly cellSize = 160;
  private grid = new Map<number, number[]>();
  private gridW = 1;
  private gridH = 1;

  /** Nodes kept so route drawing can resolve path ids to positions. */
  nodes: ReadonlyArray<RoadNode> = [];

  get worldWidth(): number {
    return this.maxX - this.minX;
  }
  get worldHeight(): number {
    return this.maxZ - this.minZ;
  }

  build(city: CityService): void {
    this.nodes = city.roadNodes;
    this.buildSegments(city);
    this.buildGrid();
    this.buildWash(city);
    this.buildLandmarks(city);
  }

  /* ---------------------------------------------------------------- */
  /* Road graph -> undirected segment list                             */
  /* ---------------------------------------------------------------- */

  private buildSegments(city: CityService): void {
    const nodes = city.roadNodes;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const p = a.position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;

      for (const j of a.links) {
        // Each undirected edge once. Links can dangle if the graph was
        // trimmed after generation, so guard the index.
        if (j <= i) continue;
        const b = nodes[j];
        if (!b) continue;
        const lanes = Math.max(a.lanes, b.lanes);
        this.segs.push({
          ax: p.x,
          az: p.z,
          bx: b.position.x,
          bz: b.position.z,
          lanes,
          major: lanes >= 2,
        });
      }
    }

    if (!Number.isFinite(minX)) {
      minX = minZ = -100;
      maxX = maxZ = 100;
    }
    const pad = 90;
    this.minX = minX - pad;
    this.minZ = minZ - pad;
    this.maxX = maxX + pad;
    this.maxZ = maxZ + pad;
  }

  /* ---------------------------------------------------------------- */
  /* Spatial index                                                     */
  /* ---------------------------------------------------------------- */

  private buildGrid(): void {
    this.gridW = Math.max(1, Math.ceil(this.worldWidth / this.cellSize));
    this.gridH = Math.max(1, Math.ceil(this.worldHeight / this.cellSize));

    for (let s = 0; s < this.segs.length; s++) {
      const g = this.segs[s];
      const cx0 = this.cellX(Math.min(g.ax, g.bx));
      const cx1 = this.cellX(Math.max(g.ax, g.bx));
      const cz0 = this.cellZ(Math.min(g.az, g.bz));
      const cz1 = this.cellZ(Math.max(g.az, g.bz));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cz * this.gridW + cx;
          const list = this.grid.get(k);
          if (list) list.push(s);
          else this.grid.set(k, [s]);
        }
      }
    }
  }

  private cellX(x: number): number {
    return clampInt(Math.floor((x - this.minX) / this.cellSize), 0, this.gridW - 1);
  }
  private cellZ(z: number): number {
    return clampInt(Math.floor((z - this.minZ) / this.cellSize), 0, this.gridH - 1);
  }

  /**
   * Segment indices overlapping a world-space AABB, written into `out`.
   * De-duplicated with a generation stamp rather than a Set — this runs every
   * frame for the minimap and must not allocate.
   */
  private stamp: Int32Array | null = null;
  private stampGen = 0;

  query(x0: number, z0: number, x1: number, z1: number, out: number[]): number[] {
    out.length = 0;
    if (!this.stamp || this.stamp.length !== this.segs.length) {
      this.stamp = new Int32Array(this.segs.length);
      this.stampGen = 0;
    }
    const gen = ++this.stampGen;
    const stamp = this.stamp;

    const cx0 = this.cellX(x0);
    const cx1 = this.cellX(x1);
    const cz0 = this.cellZ(z0);
    const cz1 = this.cellZ(z1);
    for (let cz = cz0; cz <= cz1; cz++) {
      const row = cz * this.gridW;
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.grid.get(row + cx);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          if (stamp[s] === gen) continue;
          stamp[s] = gen;
          out.push(s);
        }
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* District wash + labels                                            */
  /* ---------------------------------------------------------------- */

  private buildWash(city: CityService): void {
    const cv = document.createElement('canvas');
    cv.width = WASH_RES;
    cv.height = WASH_RES;
    const g = cv.getContext('2d');
    if (!g) return;
    const img = g.createImageData(WASH_RES, WASH_RES);
    const kinds: DistrictKind[] = new Array(WASH_RES * WASH_RES);

    const sx = this.worldWidth / WASH_RES;
    const sz = this.worldHeight / WASH_RES;

    for (let j = 0; j < WASH_RES; j++) {
      const wz = this.minZ + (j + 0.5) * sz;
      for (let i = 0; i < WASH_RES; i++) {
        const wx = this.minX + (i + 0.5) * sx;
        let k: DistrictKind;
        try {
          k = city.districtAt(wx, wz);
        } catch {
          k = 'cartier';
        }
        const idx = j * WASH_RES + i;
        kinds[idx] = k;
        const t = DISTRICT_TINT[k] ?? DISTRICT_TINT.cartier;
        const o = idx * 4;
        img.data[o] = Math.min(255, Math.round(t[0] * WASH_GAIN));
        img.data[o + 1] = Math.min(255, Math.round(t[1] * WASH_GAIN));
        img.data[o + 2] = Math.min(255, Math.round(t[2] * WASH_GAIN));
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    this.wash = cv;

    this.buildDistrictLabels(kinds, sx, sz);
  }

  /**
   * Label placement without a real pole-of-inaccessibility solve: score every
   * cell by how many same-kind neighbours it has inside a 5-cell disc, then
   * greedily take the deepest spots keeping them 420 m apart. That reliably
   * lands the caption in the middle of a district blob instead of on a border,
   * and it handles the split industrial belt by giving it two labels.
   */
  private buildDistrictLabels(kinds: DistrictKind[], sx: number, sz: number): void {
    const R = 5;
    const perKind = new Map<DistrictKind, Array<{ x: number; z: number; score: number }>>();

    for (let j = R; j < WASH_RES - R; j++) {
      for (let i = R; i < WASH_RES - R; i++) {
        const k = kinds[j * WASH_RES + i];
        let score = 0;
        for (let dj = -R; dj <= R; dj++) {
          for (let di = -R; di <= R; di++) {
            if (di * di + dj * dj > R * R) continue;
            if (kinds[(j + dj) * WASH_RES + (i + di)] === k) score++;
          }
        }
        if (score < 60) continue;
        const list = perKind.get(k) ?? [];
        list.push({ x: this.minX + (i + 0.5) * sx, z: this.minZ + (j + 0.5) * sz, score });
        perKind.set(k, list);
      }
    }

    for (const [kind, list] of perKind) {
      list.sort((a, b) => b.score - a.score);
      const picked: Array<{ x: number; z: number }> = [];
      const wanted = kind === 'industrial' || kind === 'cartier' || kind === 'parc' ? 2 : 1;
      for (const c of list) {
        if (picked.length >= wanted) break;
        if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 420)) continue;
        picked.push(c);
        this.districtLabels.push({ name: DISTRICT_NAMES[kind], x: c.x, z: c.z, kind });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Landmarks                                                         */
  /* ---------------------------------------------------------------- */

  private buildLandmarks(city: CityService): void {
    for (const lm of city.landmarks.values()) {
      const kind: MapLandmark['kind'] =
        lm.id === 'buildersHouse' || lm.id === 'palatulParlamentului'
          ? 'story'
          : /cismigiu|parc/i.test(lm.id)
            ? 'park'
            : lm.id.startsWith('osm:')
              ? 'poi'
              : 'plaza';
      this.landmarks.push({
        id: lm.id,
        name: lm.name.replace(/^osm:/, ''),
        x: lm.position.x,
        z: lm.position.z,
        radius: lm.radius,
        kind,
      });
    }
    // Anchors first, POIs last: the painter walks this list in order, so the
    // handful of things that matter end up drawn on top of the crowd.
    const rank: Record<MapLandmark['kind'], number> = { poi: 0, park: 1, plaza: 2, story: 3 };
    this.landmarks.sort(
      (a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, 'ro'),
    );
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
