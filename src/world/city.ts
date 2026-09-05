/**
 * City generation + road graph.
 *
 * OWNER: city agent.
 *
 * The whole of București is generated at init into a fixed grid of CHUNKS.
 * Each chunk owns exactly three merged BufferGeometries — facade, surface and
 * detail — which map onto the three shared materials in `city/materials.ts`.
 * That is what lets ~2000 articulated buildings, a full street network with
 * markings and kerbs, and several thousand pieces of street furniture render
 * in a couple of hundred draw calls.
 *
 *   city/districts.ts  authored zoning plan + per-district building grammar
 *   city/roads.ts      carriageways, kerbs, footways, trams, street dressing
 *   city/buildings.ts  block -> plots
 *   city/facades.ts    plot -> massing, cornices, roofscape, balconies, props
 *   city/landmarks.ts  hand-modelled Builders House + Palatul Parlamentului
 *   city/interiors.ts  lit floors you can see into from the street
 *   city/materials.ts  the facade-grammar / surface / detail shaders
 *   city/builders.ts   geometry accumulators
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { GROUP, PhysicsWorld } from '../physics/physics';
import { Atmosphere, HeroSun, WorldScale } from '../artDirection';
import {
  Services,
  type CityService,
  type DistrictKind,
  type Footprint,
  type Landmark,
  type RoadNode,
  type SpatialQuery,
} from '../core/services';
import { Rng } from '../core/rng';
import { QUALITY, detectQuality, onQualityChange, type Quality } from '../render/renderer';
import { srgb } from '../render/materials';

import { DetailBuilder, FacadeBuilder, SurfaceBuilder } from './city/builders';
import { createCityMaterials, type CityMaterials } from './city/materials';
import { AXIS_X, AXIS_Z, HALF, planDistrictAt } from './city/districts';
import {
  KERB_H,
  blockBounds,
  buildOsmStreets,
  buildRoads,
  dressAuthoredAxes,
  fillOsmGround,
  type LaneSegment,
} from './city/roads';
import {
  buildBlock,
  buildOsmFootprints,
  buildOsmInfill,
  type PlacedBuilding,
} from './city/buildings';
import { Cell, OSM_FIT, buildOsmCity, type OsmCity } from './city/osm';
import {
  LANDMARK_VOIDS,
  PLAZAS,
  buildBuildersHouse,
  buildParliament,
  buildPlaza,
  type LandmarkResult,
} from './city/landmarks';
import { buildInteriorFloor, buildLobby } from './city/interiors';
import { streetLamp } from './city/facades';
import { StreetLampBatch } from './environment/streetLampBatch';

const { blockSize, gridBlocks } = WorldScale;

/** Blocks per chunk edge. 4 => 368 m chunks => 7x7 = 49 chunks. */
const CHUNK_BLOCKS = 4;
const CHUNK_M = CHUNK_BLOCKS * blockSize;
const CHUNKS = Math.ceil(gridBlocks / CHUNK_BLOCKS) + 1;

interface Chunk {
  cx: number;
  cz: number;
  facade: FacadeBuilder;
  surface: SurfaceBuilder;
  detail: DetailBuilder;
  group: THREE.Group;
  centre: THREE.Vector3;
}

export class CitySystem implements System, CityService {
  readonly name = 'city';
  readonly order = 20;

  readonly roadNodes: RoadNode[] = [];
  /** Exact centrelines used when the permanent-way geometry is emitted. */
  readonly tramLines: THREE.Vector3[][] = [];
  readonly landmarks = new Map<string, Landmark>();
  readonly spatial: SpatialQuery;

  /** Directed lane centrelines, for whoever wires traffic. */
  readonly lanes: LaneSegment[] = [];

  private nodeGrid = new Map<string, number>();
  private root = new THREE.Group();
  private rng = new Rng('bucuresti');
  private ctx!: GameContext;
  private mats!: CityMaterials;

  private chunks: Chunk[] = [];
  private chunkAt = new Map<number, Chunk>();

  /** Buildings hashed into a coarse grid for O(1) blocking queries. */
  private buildings: PlacedBuilding[] = [];
  private blockHash = new Map<number, number[]>();
  private static readonly HASH_CELL = 24;

  /** Alive road segments, as node-id pairs, for spawn sampling. */
  private segments: Array<[number, number]> = [];

  /** The imported real city. Null only if the survey failed to parse. */
  private osm: OsmCity | null = null;
  /** Node lookup for `nearestNode` — the grid index no longer covers it. */
  private nodeBins = new Map<number, number[]>();
  private static readonly NODE_BIN = 48;

  /** Raised walkable slabs (plaza decks, landmark forecourts), world-space. */
  private raisedSlabs: Array<{ x0: number; z0: number; x1: number; z1: number; top: number }> = [];

  private drawDistance = 1600;
  private night = 0;
  private osmInfill = 0;
  private groundRects = 0;
  private readonly camPos = new THREE.Vector3();
  private stats = { facadeTris: 0, surfaceTris: 0, detailTris: 0, buildings: 0 };

  constructor() {
    const self = this;
    this.spatial = {
      snapToRoad(p, out) {
        const id = self.nearestNode(p);
        if (id < 0) return false;
        out.copy(self.roadNodes[id].position);
        return true;
      },
      groundHeight(x, z) {
        if (Math.abs(x) > HALF + blockSize || Math.abs(z) > HALF + blockSize) return -Infinity;
        // Raised landmark slabs win: they overlap road tiles that would
        // otherwise report 0, which is what put characters inside the stone.
        const slab = self.slabTopAt(x, z);
        if (slab !== null) return slab;
        // Inside the imported extent there are no block rectangles to test —
        // the ground is a kerb above the carriageway and nothing else, which
        // the occupancy mask answers directly.
        if (self.osm?.covered(x, z)) return self.osm.isCarriageway(x, z) ? 0 : KERB_H;
        return self.onPavement(x, z) ? KERB_H : 0;
      },
      isBlocked(x, z) {
        return self.isInsideBuilding(x, z);
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* init                                                              */
  /* ---------------------------------------------------------------- */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.City, this);
    this.root.name = 'city';
    ctx.scene.add(this.root);

    this.drawDistance = QUALITY[this.resolveQuality(ctx)].cityDrawDistance;
    // The quality menu used to move and the city's draw distance did not: this
    // was a one-shot snapshot taken at init. Re-applied on every tier change.
    onQualityChange('city', ['cityDrawDistance'], (_q, s) => {
      this.drawDistance = s.cityDrawDistance;
    });
    this.mats = createCityMaterials();
    this.mats.setSunDirection(sunVector());
    this.mats.setWetness(Atmosphere.wetness);

    this.buildChunks();
    this.buildRoadGraph();
    this.buildGroundPlane();

    const t0 = performance.now();
    this.importBucharest();
    this.generateBlocks();
    this.generateLandmarks();
    // Street dressing must see the raised decks that overlap road ribbons.
    this.generateStreets();
    this.bake();
    this.binNodes();
    const ms = performance.now() - t0;

    console.info(
      `[city] ${this.stats.buildings} buildings, ${this.chunks.length} chunks, ` +
      `${(this.stats.facadeTris / 1000).toFixed(0)}k facade + ` +
      `${(this.stats.surfaceTris / 1000).toFixed(0)}k surface + ` +
      `${(this.stats.detailTris / 1000).toFixed(0)}k detail tris in ${ms.toFixed(0)} ms`,
    );
    if (this.osm) {
      const s = this.osm.stats;
      console.info(
        `[city/osm] Bucharest at ${(OSM_FIT.scale * 100).toFixed(0)}%: ` +
        `${s.roadKm.toFixed(1)} km of real street, ${s.nodes} nodes, ${s.edges} edges, ` +
        `${s.footprints} real footprints, ${this.osmInfill} infilled, ` +
        `${s.parks} parks, ${this.osm.squares.length} squares`,
      );
    }

    (window as unknown as { __GTA_CITY__: unknown }).__GTA_CITY__ = {
      stats: () => ({ ...this.stats, chunks: this.chunks.length, lanes: this.lanes.length }),
      root: this.root,
      mats: this.mats,
      /** Isolate one of the three city material families for diagnosis. */
      only: (which: 'facade' | 'surface' | 'detail' | 'all') => {
        this.root.traverse((o) => {
          if (!(o as THREE.Mesh).isMesh) return;
          o.visible = which === 'all' || o.name.endsWith(which);
        });
      },
      /**
       * The imported survey, for verification: `sample(x, z)` says what the
       * generator believes is at a point, and `coverage()` reports how much of
       * the map the real layout took over.
       */
      osm: () => (this.osm ? {
        fit: OSM_FIT,
        stats: { ...this.osm.stats, infill: this.osmInfill, groundRects: this.groundRects },
        squares: this.osm.squares.map((s) => ({ name: s.name, x: Math.round(s.x), z: Math.round(s.z) })),
        sample: (x: number, z: number) => ({
          covered: this.osm!.covered(x, z),
          road: this.osm!.isCarriageway(x, z),
          mask: this.osm!.mask.at(x, z),
          district: this.district(x, z),
          plan: planDistrictAt(x, z),
          ground: this.spatial.groundHeight(x, z),
        }),
        coverage: () => {
          let hit = 0;
          let total = 0;
          for (let x = -HALF; x < HALF; x += 24) {
            for (let z = -HALF; z < HALF; z += 24) {
              total++;
              if (this.osm!.covered(x, z)) hit++;
            }
          }
          return hit / total;
        },
      } : null),
      night: (v: number) => this.setNight(v),
      wet: (v: number) => this.mats.setWetness(v),
      drawDistance: (v: number) => { this.drawDistance = v; },
    };
  }

  private resolveQuality(ctx: GameContext): Quality {
    const fromService = ctx.tryGet(Services.Render)?.quality;
    if (fromService) return fromService;
    const p = new URLSearchParams(location.search).get('q') as Quality | null;
    return p ?? detectQuality();
  }

  /* ---------------------------------------------------------------- */
  /* chunk plumbing                                                    */
  /* ---------------------------------------------------------------- */

  private buildChunks(): void {
    for (let ci = 0; ci < CHUNKS; ci++) {
      for (let cj = 0; cj < CHUNKS; cj++) {
        const g = new THREE.Group();
        g.name = `chunk-${ci}-${cj}`;
        g.matrixAutoUpdate = false;
        const chunk: Chunk = {
          cx: ci,
          cz: cj,
          facade: new FacadeBuilder(),
          surface: new SurfaceBuilder(),
          detail: new DetailBuilder(true),
          group: g,
          centre: new THREE.Vector3(
            -HALF + (ci + 0.5) * CHUNK_M,
            0,
            -HALF + (cj + 0.5) * CHUNK_M,
          ),
        };
        this.chunks.push(chunk);
        this.chunkAt.set(ci * 1000 + cj, chunk);
      }
    }
  }

  private chunkFor(x: number, z: number): Chunk {
    const ci = Math.max(0, Math.min(CHUNKS - 1, Math.floor((x + HALF) / CHUNK_M)));
    const cj = Math.max(0, Math.min(CHUNKS - 1, Math.floor((z + HALF) / CHUNK_M)));
    return this.chunkAt.get(ci * 1000 + cj)!;
  }

  private get sink() {
    return {
      groundHeight: (x: number, z: number) => this.slabTopAt(x, z) ?? undefined,
      surf: (x: number, z: number) => this.chunkFor(x, z).surface,
      detail: (x: number, z: number) => this.chunkFor(x, z).detail,
      facade: (x: number, z: number) => this.chunkFor(x, z).facade,
    };
  }

  /* ---------------------------------------------------------------- */
  /* generation                                                        */
  /* ---------------------------------------------------------------- */

  /* ---------------------------------------------------------------- */
  /* the real city                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Import curated OpenStreetMap Bucharest and splice it into the graph.
   *
   * The survey supplies the layout; the grid keeps the two authored axes and
   * everything outside the imported extent. The two graphs are then STITCHED:
   * without it a car that drove off the end of the monumental axis would find
   * itself on an island, because the real network and the grid never shared a
   * node even where they cross.
   *
   * See `city/osm.ts` for the scale decision and what it cost.
   */
  private importBucharest(): void {
    // `?osm=0` builds the pre-import generated city, for A/B comparison.
    if (new URLSearchParams(location.search).get('osm') === '0') {
      console.info('[city/osm] disabled by ?osm=0 — generated grid only');
      return;
    }
    const reserved = [
      ...LANDMARK_VOIDS.map((v) => ({ x0: v.x0, z0: v.z0, x1: v.x1, z1: v.z1 })),
      // Exactly the deck `buildPlaza` lays, plus a kerb. Any more and the
      // imported street wall stands off the plaza with a moat of nothing
      // between, which is how a square stops reading as a square.
      ...PLAZAS.map((p) => ({
        x0: p.x - p.radius - 1.5, z0: p.z - p.radius - 1.5,
        x1: p.x + p.radius + 1.5, z1: p.z + p.radius + 1.5,
      })),
    ];

    let osm: OsmCity;
    try {
      osm = buildOsmCity({ reserved, rng: this.rng.fork('osm') });
    } catch (err) {
      console.error('[city/osm] import failed, falling back to the grid', err);
      return;
    }
    this.osm = osm;

    // The renderer consumes these same paths in `buildOsmStreets`. Publishing
    // them on the city contract gives traffic an explicit source of rail truth
    // instead of guessing from a road's width.
    for (const line of osm.trams) {
      this.tramLines.push(line.map((p) => new THREE.Vector3(p.x, 0, p.z)));
    }

    const base = this.roadNodes.length;
    for (const n of osm.nodes) {
      this.roadNodes.push({
        id: this.roadNodes.length,
        position: new THREE.Vector3(n.x, 0, n.z),
        links: [],
        lanes: n.rank === 2 ? 3 : n.rank === 1 ? 2 : 1,
        isIntersection: n.edges.length > 2,
        hasTrafficLight: n.rank === 2 && n.edges.length > 2,
      });
    }

    const laneW = 3.6;
    for (const e of osm.edges) {
      const a = base + e.a;
      const b = base + e.b;
      const na = this.roadNodes[a];
      const nb = this.roadNodes[b];
      na.links.push(b);
      nb.links.push(a);
      this.segments.push([a, b]);
      if (e.width <= 0) continue;      // pedestrianised: walkable, not drivable

      const dx = nb.position.x - na.position.x;
      const dz = nb.position.z - na.position.z;
      const len = Math.hypot(dx, dz) || 1;
      const px = -dz / len;
      const pz = dx / len;
      const lanes = Math.max(1, Math.min(3, e.lanes));
      for (let l = 0; l < lanes; l++) {
        const off = (l + 0.5) * laneW;
        this.lanes.push({
          fromNode: a, toNode: b, lane: l,
          ax: na.position.x + px * off, az: na.position.z + pz * off,
          bx: nb.position.x + px * off, bz: nb.position.z + pz * off,
          width: laneW,
        });
        if (!e.oneway) {
          this.lanes.push({
            fromNode: b, toNode: a, lane: l,
            ax: nb.position.x - px * off, az: nb.position.z - pz * off,
            bx: na.position.x - px * off, bz: na.position.z - pz * off,
            width: laneW,
          });
        }
      }
    }

    this.stitchToAxes(base, osm);

    for (const p of osm.places) {
      const id = `osm:${p.name}`;
      if (this.landmarks.has(id)) continue;
      this.landmarks.set(id, {
        id, name: p.name,
        position: new THREE.Vector3(p.x, 0, p.z),
        radius: p.radius,
      });
    }
    for (const s of osm.squares) {
      const id = `osm:${s.name}`;
      if (this.landmarks.has(id)) continue;
      this.landmarks.set(id, {
        id, name: s.name,
        position: new THREE.Vector3(s.x, 0, s.z),
        radius: s.radius,
      });
    }
  }

  /**
   * Join the imported network to the two grid axes wherever they pass close.
   * Both graphs are drivable and they physically cross; without an explicit
   * link A* treats them as separate road systems.
   */
  private stitchToAxes(base: number, osm: OsmCity): void {
    const gridNode = (x: number, z: number): number => {
      const i = Math.round((x + HALF) / blockSize);
      const j = Math.round((z + HALF) / blockSize);
      return this.nodeGrid.get(`${i},${j}`) ?? -1;
    };
    const join = (g: number, me: number, maxDist: number): void => {
      if (g < 0) return;
      if (this.roadNodes[g].links.includes(me)) return;
      if (this.roadNodes[g].position.distanceToSquared(this.roadNodes[me].position) > maxDist * maxDist) {
        return;
      }
      this.roadNodes[g].links.push(me);
      this.roadNodes[me].links.push(g);
      this.segments.push([g, me]);
    };

    for (let k = 0; k < osm.nodes.length; k++) {
      const n = osm.nodes[k];
      const me = base + k;
      const nearX = Math.abs(n.x - AXIS_X) < 34;
      const nearZ = Math.abs(n.z - AXIS_Z) < 34;
      if (nearX || nearZ) {
        join(gridNode(nearX ? AXIS_X : n.x, nearZ ? AXIS_Z : n.z), me, 70);
        continue;
      }
      /*
       * THE SEAM. Where the survey runs out, the generated grid takes over —
       * on this map that is the eastern strip and the far south-west, because
       * the OSM extent is not square. The two networks physically abut but
       * shared no node, so a car could drive to the boundary and find the rest
       * of the city unreachable: A* returned nothing and the traffic system
       * quietly gave up on half the map. Any real node that sits just OUTSIDE
       * the covered area gets welded to the grid crossing it is standing on.
       */
      if (!osm.covered(n.x, n.z)) continue;
      const gx = Math.round((n.x + HALF) / blockSize) * blockSize - HALF;
      const gz = Math.round((n.z + HALF) / blockSize) * blockSize - HALF;
      if (osm.covered(gx, gz)) continue;      // that crossing was replaced
      join(gridNode(gx, gz), me, 64);
    }
  }

  /** Uniform bins over every node, so `nearestNode` stays O(1). */
  private binNodes(): void {
    this.nodeBins.clear();
    const c = CitySystem.NODE_BIN;
    for (const n of this.roadNodes) {
      if (!n.links.length) continue;
      const key = Math.floor(n.position.x / c) * 100003 + Math.floor(n.position.z / c);
      let list = this.nodeBins.get(key);
      if (!list) this.nodeBins.set(key, (list = []));
      list.push(n.id);
    }
  }

  private generateStreets(): void {
    const phys = this.findPhysics();
    const rng = this.rng.fork('streets');

    buildRoads({
      covered: (x, z) => this.osm !== null && this.osm.covered(x, z),
      sink: this.sink,
      rng,
      isVoid: (x, z) => isLandmarkVoid(x, z),
      districtAt: (x, z) => this.district(x, z),
      addKerbCollider: (cx, cz, hx, hz, top) => {
        phys?.addStaticBox(
          new THREE.Vector3(hx, top / 2 + 0.1, hz),
          new THREE.Vector3(cx, top / 2 - 0.1, cz),
          undefined,
          GROUP.terrain,
        );
      },
      lanes: this.lanes,
      nodeId: (i, j) => this.nodeGrid.get(`${i},${j}`) ?? -1,
      onSegment: (ai, aj, bi, bj, alive) => {
        const a = this.nodeGrid.get(`${ai},${aj}`);
        const b = this.nodeGrid.get(`${bi},${bj}`);
        if (a === undefined || b === undefined) return;
        if (alive) {
          this.roadNodes[a].links.push(b);
          this.roadNodes[b].links.push(a);
          this.segments.push([a, b]);
        }
      },
      onTramSegment: (ax, az, bx, bz) => {
        this.tramLines.push([
          new THREE.Vector3(ax, 0, az),
          new THREE.Vector3(bx, 0, bz),
        ]);
      },
    });

    if (this.osm) {
      const osm = this.osm;
      buildOsmStreets({
        sink: this.sink,
        rng: rng.fork('osm-streets'),
        city: osm,
        districtAt: (x, z) => this.district(x, z),
        addWalkCollider: (cx, cz, hx, hz, rot, top) => {
          phys?.addStaticBox(
            new THREE.Vector3(hx, top / 2 + 0.1, hz),
            new THREE.Vector3(cx, top / 2 - 0.1, cz),
            rot ? new THREE.Quaternion().setFromAxisAngle(UP, -rot) : undefined,
            GROUP.terrain,
          );
        },
      });
      dressAuthoredAxes(
        this.sink, rng.fork('axes'),
        (x, z) => osm.covered(x, z),
        (x, z) => isLandmarkVoid(x, z),
        (cx, cz, hx, hz, _rot, top) => {
          phys?.addStaticBox(
            new THREE.Vector3(hx, top / 2 + 0.1, hz),
            new THREE.Vector3(cx, top / 2 - 0.1, cz),
            undefined, GROUP.terrain,
          );
        },
      );
      const fill = fillOsmGround(
        this.sink, osm, (x, z) => this.district(x, z), rng.fork('ground'),
        (cx, cz, hx, hz, top) => {
          phys?.addStaticBox(
            new THREE.Vector3(hx, top / 2 + 0.1, hz),
            new THREE.Vector3(cx, top / 2 - 0.1, cz),
            undefined, GROUP.terrain,
          );
        },
      );
      this.groundRects = fill.rects;
    }
  }

  private generateBlocks(): void {
    const phys = this.findPhysics();
    const rng = this.rng.fork('blocks');

    // The real city first: its footprints claim their ground in the occupancy
    // mask, and the infill then fills what the curation sampled away.
    if (this.osm) {
      const before = this.buildings.length;
      const osmOpts = {
        city: this.osm,
        rng: rng.fork('osm-buildings'),
        facade: (x: number, z: number) => this.chunkFor(x, z).facade,
        detail: (x: number, z: number) => this.chunkFor(x, z).detail,
        districtAt: (x: number, z: number) => this.district(x, z),
        out: this.buildings,
      };
      buildOsmFootprints(osmOpts);
      const real = this.buildings.length - before;
      buildOsmInfill(osmOpts);
      this.osmInfill = this.buildings.length - before - real;
      this.addColliders(phys, before);
    }

    for (let i = 0; i < gridBlocks; i++) {
      for (let j = 0; j < gridBlocks; j++) {
        const b = blockBounds(i, j);
        const cx = (b.bx0 + b.bx1) / 2;
        const cz = (b.bz0 + b.bz1) / 2;
        if (isLandmarkVoid(cx, cz)) continue;
        if (this.osm?.covered(cx, cz)) continue;

        const district = this.district(cx, cz);
        const before = this.buildings.length;
        buildBlock({
          block: { bx0: b.bx0, bz0: b.bz0, bx1: b.bx1, bz1: b.bz1 },
          district,
          rng,
          facade: (x, z) => this.chunkFor(x, z).facade,
          detail: (x, z) => this.chunkFor(x, z).detail,
          isVoid: (x, z) => isLandmarkVoid(x, z),
          out: this.buildings,
        });

        this.addColliders(phys, before);

        // Visible interiors for the corporate frontage around the hero
        // crossroads — the reference frame is shot from ten metres away.
        if (district === 'glassCorporate') {
          for (let k = before; k < this.buildings.length; k++) {
            const bd = this.buildings[k];
            if (Math.hypot(bd.x + 46, bd.z - 46) > 260) continue;
            buildLobby(
              this.chunkFor(bd.x, bd.z).detail,
              bd.x, bd.z, bd.hx * 2, bd.hz * 2, 6.4, 1.6, rng,
            );
          }
        }
      }
    }
    this.stats.buildings = this.buildings.length;
    this.hashBuildings();
  }

  /**
   * Static colliders for buildings placed since `from`.
   *
   * The half-extents are the ones the grammar reports, and a real Bucharest
   * plot sits at whatever angle its street does — so the box has to carry the
   * rotation too, or every skewed block gets a collider a third bigger than
   * itself sticking out into the carriageway.
   */
  private addColliders(phys: PhysicsWorld | null, from: number): void {
    if (!phys) return;
    for (let k = from; k < this.buildings.length; k++) {
      const bd = this.buildings[k];
      phys.addStaticBox(
        new THREE.Vector3(bd.hx, bd.height / 2, bd.hz),
        new THREE.Vector3(bd.x, bd.height / 2, bd.z),
        bd.rot ? new THREE.Quaternion().setFromAxisAngle(UP, -bd.rot) : undefined,
      );
    }
  }

  private generateLandmarks(): void {
    const rng = this.rng.fork('landmarks');
    const phys = this.findPhysics();
    const results: LandmarkResult[] = [
      buildBuildersHouse(this.sink, rng),
      buildParliament(this.sink, rng),
      ...PLAZAS.map((p) => buildPlaza(this.sink, p, rng)),
    ];

    for (const r of results) {
      this.landmarks.set(r.id, {
        id: r.id,
        name: r.name,
        position: r.position,
        radius: r.radius,
      });
      for (const bx of r.boxes) {
        this.buildings.push({ x: bx.x, z: bx.z, hx: bx.hx, hz: bx.hz, height: bx.h });
        phys?.addStaticBox(
          new THREE.Vector3(bx.hx, bx.h / 2, bx.hz),
          new THREE.Vector3(bx.x, bx.h / 2, bx.z),
        );
      }

      // Raised walkable slabs — plaza decks and forecourts. These sit inside
      // LANDMARK_VOIDS, so the block's kerb ring is skipped and nothing else
      // gave them a floor: they had no collider, and `groundHeight` reported
      // the carriageway. Everything standing on a plaza was a kerb inside the
      // stone. Register both the physics box and the analytic height so the
      // collider, the footing probe and the crowd all agree.
      for (const sl of r.slabs) {
        this.raisedSlabs.push(sl);
        const hx = (sl.x1 - sl.x0) / 2;
        const hz = (sl.z1 - sl.z0) / 2;
        phys?.addStaticBox(
          new THREE.Vector3(hx, sl.top / 2 + 0.1, hz),
          new THREE.Vector3(sl.x0 + hx, sl.top / 2 - 0.1, sl.z0 + hz),
          undefined,
          GROUP.terrain,
        );
      }
    }

    // Builders House: real lit floors behind the curtain wall, so the tower
    // reads as occupied from the plaza.
    const hero = this.chunkFor(-46, 46).detail;
    buildLobby(hero, -46, 46, 30, 24, 9.0, 1.4, rng);
    for (let fl = 1; fl <= 4; fl++) {
      buildInteriorFloor(hero, {
        cx: -46, cz: 46, w: 30, d: 24,
        y: 9.5 + (fl - 1) * 4.0,
        height: 3.6,
        inset: 1.3,
        glow: fl % 2 === 0 ? new THREE.Color().copy(PURPLE) : new THREE.Color().copy(MAGENTA),
        intensity: 1.0,
      }, rng);
    }
    this.hashBuildings();
  }

  /* ---------------------------------------------------------------- */
  /* ground + baking                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * The bedrock the whole city sits on.
   *
   * THIS USED TO BE A SINGLE `PlaneGeometry`, AND THAT IS WHERE THE
   * "artifacts under the pavement" CAME FROM. Every horizontal surface in the
   * city — carriageway ribbons, junction patches, footway slabs, block
   * interiors — is emitted as ONE upward-facing quad by `SurfaceBuilder`, and
   * the underlay was upward-facing too. So the world had no skin on its
   * underside at all: drop the camera below y = -0.06 and the depth buffer is
   * empty, the sky dome (a `BackSide` sphere) renders straight through the
   * pavement, and the city reads as a set of floating zero-thickness sheets
   * with the building interiors showing through the floor.
   *
   * The fix is a DOUBLE-SIDED SLAB — twelve triangles. From above, the top
   * face is exactly the plane that was there before: same y, same material,
   * pixel-identical. Below it the camera is inside a closed, double-sided box,
   * so every direction resolves to opaque bedrock instead of to the sky dome.
   *
   * Both halves of that description are load-bearing. A single double-sided
   * plane still leaves the *downward* view open (a zero-thickness floor blocks
   * nothing when you look down past its edge), and a single-sided box is worse
   * still — from inside it you see only backfaces and the hole comes straight
   * back. It has to be a box AND double sided.
   *
   * The `polygonOffset` is the second half of the fix. The slab top sits only
   * 60 mm under the carriageway (which is at y = 0 rising to y = 0.09 at the
   * crown). With near = 0.15 and far = 3000 the depth buffer resolves about
   * 60 mm at 390 m, so past that the bedrock and the road were interleaving
   * into the speckled seam you could see running along the street. Biasing the
   * bedrock away from the eye makes the road win that comparison at every
   * distance, whatever the depth precision happens to be.
   */
  private buildGroundPlane(): void {
    const phys = this.findPhysics();
    const size = gridBlocks * blockSize + blockSize * 6;
    const playableHalf = HALF + blockSize;
    const TOP_Y = -0.06;
    const THICKNESS = 80;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0812, roughness: 0.55, metalness: 0.0,
      side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 8, polygonOffsetUnits: 16,
    });
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(size * 2.4, THICKNESS, size * 2.4, 1, 1, 1),
      mat,
    );
    ground.position.y = TOP_Y - THICKNESS / 2;
    ground.castShadow = false;
    ground.receiveShadow = false;
    ground.name = 'ground-underlay';
    this.root.add(ground);

    phys?.addStaticBox(
      // Match SpatialQuery.groundHeight exactly. The larger rendered underlay
      // hides the sky below the map, but must not become invisible driveable
      // ground several kilometres beyond the playable city.
      new THREE.Vector3(playableHalf, 0.5, playableHalf),
      new THREE.Vector3(0, -0.5, 0),
      undefined,
      GROUP.terrain,
    );
  }

  private bake(): void {
    const phys = this.findPhysics();
    const environment = this.ctx.tryGet(Services.EnvironmentDamage);
    // One shared city-detail template, instanced into stable per-chunk slots.
    // Its arm faces local +X and starts at y=0; each placement supplies yaw,
    // pavement height and the modest height variation.
    const lampTemplateBuilder = new DetailBuilder();
    streetLamp(lampTemplateBuilder, 0, 0, 1, 0, 8.4, 0);
    const lampTemplate = lampTemplateBuilder.build();
    const lampTemplateTris = lampTemplate.getIndex()!.count / 3;
    for (const c of this.chunks) {
      const add = (
        b: FacadeBuilder | SurfaceBuilder | DetailBuilder,
        mat: THREE.Material,
        label: string,
        cast: boolean,
      ): void => {
        if (b.isEmpty) return;
        const geo = b.build();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `${c.group.name}-${label}`;
        mesh.castShadow = cast;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        c.group.add(mesh);
      };
      this.stats.facadeTris += c.facade.triangles;
      this.stats.surfaceTris += c.surface.triangles;
      this.stats.detailTris += c.detail.triangles + c.detail.streetLamps.length * lampTemplateTris;

      for (const box of c.detail.collisionBoxes) {
        // Runtime street lamps are registered below from their addressable
        // visual slots. Skipping the legacy semantic box avoids a duplicate
        // indestructible collider occupying the same trunk.
        if (box.kind === 'street-lamp' && c.detail.addressableStreetLamps) continue;
        phys?.addStaticBox(
          box.halfExtents,
          box.position,
          box.rotationY
            ? new THREE.Quaternion().setFromAxisAngle(UP, -box.rotationY)
            : undefined,
          GROUP.prop,
        );
      }

      add(c.surface, this.mats.surface, 'surface', false);
      add(c.facade, this.mats.facade, 'facade', true);
      // Street furniture does NOT cast: at 3 degrees of sun elevation every
      // lamp post would throw a 150 m shadow through four cascades, which is
      // most of a frame budget for detail nobody reads.
      add(c.detail, this.mats.detail, 'detail', false);

      if (c.detail.streetLamps.length) {
        const batch = new StreetLampBatch(
          lampTemplate,
          this.mats.detail,
          c.detail.streetLamps,
          `${c.group.name}-street-lamps-detail`,
        );
        c.group.add(batch.mesh);
        if (phys) {
          for (let i = 0; i < c.detail.streetLamps.length; i++) {
            const lamp = c.detail.streetLamps[i];
            const collider = phys.addStaticBox(
              new THREE.Vector3(0.17, lamp.height / 2, 0.17),
              new THREE.Vector3(lamp.x, lamp.y0 + lamp.height / 2, lamp.z),
              undefined,
              GROUP.prop,
            );
            environment?.registerBreakablePole({
              id: `street-lamp:${c.cx}:${c.cz}:${i}`,
              colliderHandle: collider.handle,
              position: new THREE.Vector3(lamp.x, lamp.y0, lamp.z),
              height: lamp.height,
              inward: new THREE.Vector3(lamp.inwardX, 0, lamp.inwardZ),
              setIntactVisible: (visible) => batch.setIntactVisible(i, visible),
            });
          }
        }
      }

      if (c.group.children.length) {
        c.group.updateMatrix();
        this.root.add(c.group);
      }
      // Release the CPU-side accumulators.
      c.facade = new FacadeBuilder();
      c.surface = new SurfaceBuilder();
      c.detail = new DetailBuilder(true);
    }
  }

  /* ---------------------------------------------------------------- */
  /* road graph                                                        */
  /* ---------------------------------------------------------------- */

  private buildRoadGraph(): void {
    const n = gridBlocks + 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = -HALF + i * blockSize;
        const z = -HALF + j * blockSize;
        const id = this.roadNodes.length;
        const boulevard = i % 4 === 0 || j % 4 === 0;
        this.roadNodes.push({
          id,
          position: new THREE.Vector3(x, 0, z),
          links: [],
          lanes: i === 12 || j === 13 ? 3 : boulevard ? 2 : 1,
          isIntersection: true,
          hasTrafficLight: boulevard && i % 4 === 0 && j % 4 === 0,
        });
        this.nodeGrid.set(`${i},${j}`, id);
      }
    }
    // Links are added by generateStreets() via onSegment, so segments that a
    // landmark swallowed never appear in the navigation graph.
  }

  /* ---------------------------------------------------------------- */
  /* spatial acceleration                                              */
  /* ---------------------------------------------------------------- */

  private hashBuildings(): void {
    this.blockHash.clear();
    const cell = CitySystem.HASH_CELL;
    for (let k = 0; k < this.buildings.length; k++) {
      const b = this.buildings[k];
      // Rotated plots hash by their circumscribed radius; the exact oriented
      // test then rejects the corners.
      const r = b.rot ? Math.hypot(b.hx, b.hz) : 0;
      const rx = r || b.hx;
      const rz = r || b.hz;
      const i0 = Math.floor((b.x - rx) / cell);
      const i1 = Math.floor((b.x + rx) / cell);
      const j0 = Math.floor((b.z - rz) / cell);
      const j1 = Math.floor((b.z + rz) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * 100003 + j;
          let list = this.blockHash.get(key);
          if (!list) this.blockHash.set(key, (list = []));
          list.push(k);
        }
      }
    }
  }

  private isInsideBuilding(x: number, z: number): boolean {
    const cell = CitySystem.HASH_CELL;
    const key = Math.floor(x / cell) * 100003 + Math.floor(z / cell);
    const list = this.blockHash.get(key);
    if (!list) return false;
    for (const k of list) {
      const b = this.buildings[k];
      const ox = x - b.x;
      const oz = z - b.z;
      if (b.rot) {
        /*
         * WORLD -> PLOT, and the sign of the angle is the whole bug.
         *
         * `addColliders` orients the Rapier box with
         * `setFromAxisAngle(UP, -b.rot)`, so the box's local-to-world map is
         * R_y(-rot) and the world-to-local map — which is what a point test
         * needs — is its INVERSE, R_y(+rot):
         *
         *     lx =  ox * cos(rot) + oz * sin(rot)
         *     lz = -ox * sin(rot) + oz * cos(rot)
         *
         * This used to apply R_y(-rot) instead, i.e. the collider's own
         * forward transform. For an axis-aligned plot the two agree and
         * nothing showed; for every plot at an angle — which, since the real
         * Bucharest layout landed, is most of the ~2700 buildings — the
         * analytic footprint was the collider MIRRORED about the plot's axes.
         * `isBlocked` is what peds, traffic and every spawn point use to avoid
         * placing things inside geometry, so things were spawned inside walls
         * on one side of a skewed block and refused on open pavement on the
         * other. Measured before the fix at 3.5% of the map solid-but-open and
         * 3.4% open-but-blocked; see `world/worldTruth.test.ts`, which compares
         * this function against the colliders themselves.
         */
        const c = Math.cos(b.rot);
        const s = Math.sin(b.rot);
        if (Math.abs(ox * c + oz * s) < b.hx && Math.abs(oz * c - ox * s) < b.hz) return true;
      } else if (Math.abs(ox) < b.hx && Math.abs(oz) < b.hz) return true;
    }
    return false;
  }

  /** Top of the raised landmark slab under (x, z), or null if there isn't one. */
  private slabTopAt(x: number, z: number): number | null {
    let best: number | null = null;
    for (const s of this.raisedSlabs) {
      if (x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1) continue;
      if (best === null || s.top > best) best = s.top;
    }
    return best;
  }

  private onPavement(x: number, z: number): boolean {
    const i = Math.floor((x + HALF) / blockSize);
    const j = Math.floor((z + HALF) / blockSize);
    if (i < 0 || j < 0 || i >= gridBlocks || j >= gridBlocks) return false;
    const b = blockBounds(i, j);
    return x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
  }

  /* ---------------------------------------------------------------- */
  /* per-frame                                                         */
  /* ---------------------------------------------------------------- */

  update(_dt: number, ctx: GameContext): void {
    // Foliage wind. Wrapped so the phase never loses float precision on a long
    // session; 3600 s is an exact multiple of nothing in the gust field, but at
    // this amplitude the discontinuity is a few millimetres of leaf.
    this.mats.shared.uTime.value = (this.mats.shared.uTime.value + _dt) % 3600;
    const w = ctx.tryGet(Services.Weather);
    if (w) {
      this.mats.setWetness(w.wetness);
      this.setNight(nightAmount(w.timeOfDay, w.preset === 'night'));
    }
  }

  lateUpdate(_dt: number, ctx: GameContext): void {
    // Chunk-level distance culling. Frustum culling is per-mesh and automatic;
    // this is what keeps the far half of a 2.4 km city off the command buffer.
    ctx.camera.getWorldPosition(this.camPos);
    const cut = this.drawDistance + CHUNK_M;
    const cut2 = cut * cut;
    for (const c of this.chunks) {
      const dx = c.centre.x - this.camPos.x;
      const dz = c.centre.z - this.camPos.z;
      c.group.visible = dx * dx + dz * dz < cut2;
    }
  }

  private setNight(v: number): void {
    const n = Math.max(0, Math.min(1, v));
    if (Math.abs(n - this.night) < 0.002) return;
    this.night = n;
    this.mats.shared.uNight.value = n;
    // The analytic sky the city reflects has to go out with the real one, or
    // wet asphalt and glass stay lit at midnight.
    this.mats.shared.uEnvMix.value = 1.0 - n * 0.82;
  }

  /* ---------------------------------------------------------------- */
  /* CityService                                                       */
  /* ---------------------------------------------------------------- */

  districtAt(x: number, z: number): DistrictKind {
    return this.district(x, z);
  }

  /**
   * The authored zoning plan, RECONCILED WITH THE SURVEY.
   *
   * `planDistrictAt` was written for a city that was entirely invented: past
   * the authored rectangles it falls back to noise, dropping "park" pockets
   * wherever a fractal says so and calling the rest cartier. Over imported
   * ground that is simply false, and it showed: Piața Victoriei — the north
   * gate of Bucharest, ringed by the Government and the Antipa museum — came
   * out as a grass field with four panel blocks on it, because the noise had
   * decided that corner of the map was parkland.
   *
   * So inside the imported extent the survey gets the casting vote on the two
   * things it actually knows: where the green is, and where the boulevards
   * are. The authored districts — the government quarter, the corporate
   * pocket, Lipscani, the industrial belt — are untouched, because those are
   * the game's own art direction and the story is staged in them.
   */
  private district(x: number, z: number): DistrictKind {
    const base = planDistrictAt(x, z);
    const osm = this.osm;
    if (!osm || !osm.covered(x, z)) return base;
    if (osm.mask.has(x, z, Cell.green)) return 'parc';
    const onBoulevard = osm.mask.has(x, z, Cell.major);
    if (base === 'parc') return onBoulevard ? 'bulevard' : 'cartier';
    if (base === 'cartier' && onBoulevard) return 'bulevard';
    return base;
  }

  /**
   * BUILDING FOOTPRINTS IN A WINDOW — the read-only half of `blockHash`.
   *
   * The hash was built for `isBlocked`, a point test; this walks the same cells
   * and hands back the plots themselves, which is what lets a map draw the city
   * as BLOCKS rather than as a flat district wash between streets. It is the
   * one thing the map could not fake: every other layer it draws (streets,
   * districts, landmarks) was already on the contract.
   *
   * `out` is grown and reused, and entries are overwritten in place, so a
   * caller that holds one array across repaints never allocates. Buildings
   * spanning several hash cells are de-duplicated with a generation stamp
   * rather than a Set, for the same reason.
   */
  blocksIn(x0: number, z0: number, x1: number, z1: number, out: Footprint[]): number {
    const cell = CitySystem.HASH_CELL;
    const i0 = Math.floor(Math.min(x0, x1) / cell);
    const i1 = Math.floor(Math.max(x0, x1) / cell);
    const j0 = Math.floor(Math.min(z0, z1) / cell);
    const j1 = Math.floor(Math.max(z0, z1) / cell);

    if (this.blockStamp.length !== this.buildings.length) {
      this.blockStamp = new Int32Array(this.buildings.length);
      this.blockStampGen = 0;
    }
    const stamp = this.blockStamp;
    const gen = ++this.blockStampGen;

    let n = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.blockHash.get(i * 100003 + j);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const idx = list[k];
          if (stamp[idx] === gen) continue;
          stamp[idx] = gen;
          const b = this.buildings[idx];
          let f = out[n];
          if (!f) out.push((f = { x: 0, z: 0, hx: 0, hz: 0, rot: 0, height: 0 }));
          f.x = b.x;
          f.z = b.z;
          f.hx = b.hx;
          f.hz = b.hz;
          f.rot = b.rot ?? 0;
          f.height = b.height;
          n++;
        }
      }
    }
    return n;
  }

  private blockStamp = new Int32Array(0);
  private blockStampGen = 0;

  randomRoadPoint(out: THREE.Vector3): void {
    if (!this.segments.length) {
      out.set(0, 0, 0);
      return;
    }
    const [a, b] = this.segments[this.rng.int(0, this.segments.length)];
    out.lerpVectors(this.roadNodes[a].position, this.roadNodes[b].position, this.rng.next());
  }

  /**
   * Nearest CONNECTED road node.
   *
   * This used to be an index into the grid, which is exact and free — and
   * wrong the moment the real street layout arrived, because the nearest road
   * to a point in the middle of Bucharest is now almost never a grid crossing,
   * and half the grid crossings inside the imported extent no longer have a
   * single live link. Link-less nodes are skipped: returning one strands
   * whatever was spawned there on an island with no route out.
   */
  nearestNode(p: THREE.Vector3): number {
    const c = CitySystem.NODE_BIN;
    const bi = Math.floor(p.x / c);
    const bj = Math.floor(p.z / c);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= 8; ring++) {
      for (let di = -ring; di <= ring; di++) {
        for (let dj = -ring; dj <= ring; dj++) {
          // Only the newly added shell of the expanding square.
          if (ring > 0 && Math.abs(di) !== ring && Math.abs(dj) !== ring) continue;
          const list = this.nodeBins.get((bi + di) * 100003 + (bj + dj));
          if (!list) continue;
          for (const id of list) {
            const d = this.roadNodes[id].position.distanceToSquared(p);
            if (d < bestD) { bestD = d; best = id; }
          }
        }
      }
      // One more ring after the first hit, so a node just over the bin edge
      // still wins.
      if (best >= 0 && bestD < (ring * c) ** 2) break;
    }
    return best;
  }

  findPath(fromNode: number, toNode: number): number[] {
    if (fromNode < 0 || toNode < 0 || fromNode === toNode) return [];
    const nodes = this.roadNodes;
    const open = new Set<number>([fromNode]);
    const cameFrom = new Map<number, number>();
    const g = new Map<number, number>([[fromNode, 0]]);
    const goal = nodes[toNode].position;
    const f = new Map<number, number>([[fromNode, nodes[fromNode].position.distanceTo(goal)]]);
    let guard = 0;

    while (open.size && guard++ < 20000) {
      let cur = -1;
      let best = Infinity;
      for (const id of open) {
        const v = f.get(id) ?? Infinity;
        if (v < best) { best = v; cur = id; }
      }
      if (cur === toNode) {
        const path = [cur];
        let c = cur;
        while (cameFrom.has(c)) { c = cameFrom.get(c)!; path.push(c); }
        return path.reverse();
      }
      open.delete(cur);
      for (const nb of nodes[cur].links) {
        const tentative = (g.get(cur) ?? Infinity) + nodes[cur].position.distanceTo(nodes[nb].position);
        if (tentative < (g.get(nb) ?? Infinity)) {
          cameFrom.set(nb, cur);
          g.set(nb, tentative);
          f.set(nb, tentative + nodes[nb].position.distanceTo(goal));
          open.add(nb);
        }
      }
    }
    return [];
  }

  private findPhysics(): PhysicsWorld | null {
    return this.ctx.tryGet(Services.Physics) ?? null;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.root.clear();
    this.mats?.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const UP = new THREE.Vector3(0, 1, 0);
const PURPLE = srgb(0x7b3fd4);
const MAGENTA = srgb(0xc04ad0);

function isLandmarkVoid(x: number, z: number): boolean {
  for (const v of LANDMARK_VOIDS) {
    if (x > v.x0 && x < v.x1 && z > v.z0 && z < v.z1) return true;
  }
  return false;
}

function sunVector(): THREE.Vector3 {
  const el = THREE.MathUtils.degToRad(HeroSun.elevationDeg);
  const az = THREE.MathUtils.degToRad(HeroSun.azimuthDeg);
  return new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ).normalize();
}

/** 0 at midday, 1 deep at night, with dusk/dawn ramps either side. */
function nightAmount(hours: number, forced: boolean): number {
  if (forced) return 1;
  const h = ((hours % 24) + 24) % 24;
  const dusk = smoothstep(18.6, 21.2, h);
  const dawn = 1 - smoothstep(4.6, 7.0, h);
  return Math.max(dusk, dawn);
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
