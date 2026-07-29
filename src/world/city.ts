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
  type Landmark,
  type RoadNode,
  type SpatialQuery,
} from '../core/services';
import { Rng } from '../core/rng';
import { QUALITY, detectQuality, type Quality } from '../render/renderer';

import { DetailBuilder, FacadeBuilder, SurfaceBuilder } from './city/builders';
import { createCityMaterials, type CityMaterials } from './city/materials';
import { HALF, planDistrictAt } from './city/districts';
import { KERB_H, blockBounds, buildRoads, type LaneSegment } from './city/roads';
import { buildBlock, type PlacedBuilding } from './city/buildings';
import {
  LANDMARK_VOIDS,
  PLAZAS,
  buildBuildersHouse,
  buildParliament,
  buildPlaza,
  type LandmarkResult,
} from './city/landmarks';
import { buildInteriorFloor, buildLobby } from './city/interiors';

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

  private drawDistance = 1600;
  private night = 0;
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
    this.mats = createCityMaterials();
    this.mats.setSunDirection(sunVector());
    this.mats.setWetness(Atmosphere.wetness);

    this.buildChunks();
    this.buildRoadGraph();
    this.buildGroundPlane();

    const t0 = performance.now();
    this.generateStreets();
    this.generateBlocks();
    this.generateLandmarks();
    this.bake();
    const ms = performance.now() - t0;

    console.info(
      `[city] ${this.stats.buildings} buildings, ${this.chunks.length} chunks, ` +
      `${(this.stats.facadeTris / 1000).toFixed(0)}k facade + ` +
      `${(this.stats.surfaceTris / 1000).toFixed(0)}k surface + ` +
      `${(this.stats.detailTris / 1000).toFixed(0)}k detail tris in ${ms.toFixed(0)} ms`,
    );

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
          detail: new DetailBuilder(),
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
      surf: (x: number, z: number) => this.chunkFor(x, z).surface,
      detail: (x: number, z: number) => this.chunkFor(x, z).detail,
      facade: (x: number, z: number) => this.chunkFor(x, z).facade,
    };
  }

  /* ---------------------------------------------------------------- */
  /* generation                                                        */
  /* ---------------------------------------------------------------- */

  private generateStreets(): void {
    const phys = this.findPhysics();
    const rng = this.rng.fork('streets');

    buildRoads({
      sink: this.sink,
      rng,
      isVoid: (x, z) => isLandmarkVoid(x, z),
      districtAt: (x, z) => planDistrictAt(x, z),
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
    });
  }

  private generateBlocks(): void {
    const phys = this.findPhysics();
    const rng = this.rng.fork('blocks');

    for (let i = 0; i < gridBlocks; i++) {
      for (let j = 0; j < gridBlocks; j++) {
        const b = blockBounds(i, j);
        const cx = (b.bx0 + b.bx1) / 2;
        const cz = (b.bz0 + b.bz1) / 2;
        if (isLandmarkVoid(cx, cz)) continue;

        const district = planDistrictAt(cx, cz);
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

        for (let k = before; k < this.buildings.length; k++) {
          const bd = this.buildings[k];
          phys?.addStaticBox(
            new THREE.Vector3(bd.hx, bd.height / 2, bd.hz),
            new THREE.Vector3(bd.x, bd.height / 2, bd.z),
          );
        }

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

  private buildGroundPlane(): void {
    const phys = this.findPhysics();
    const size = gridBlocks * blockSize + blockSize * 6;
    // A dark under-plane so the horizon never shows sky through the grid.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0812, roughness: 0.55, metalness: 0.0,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size * 2.4, size * 2.4, 1, 1), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.06;
    ground.receiveShadow = false;
    ground.name = 'ground-underlay';
    this.root.add(ground);

    phys?.addStaticBox(
      new THREE.Vector3(size, 0.5, size),
      new THREE.Vector3(0, -0.5, 0),
      undefined,
      GROUP.terrain,
    );
  }

  private bake(): void {
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
      this.stats.detailTris += c.detail.triangles;

      add(c.surface, this.mats.surface, 'surface', false);
      add(c.facade, this.mats.facade, 'facade', true);
      // Street furniture does NOT cast: at 3 degrees of sun elevation every
      // lamp post would throw a 150 m shadow through four cascades, which is
      // most of a frame budget for detail nobody reads.
      add(c.detail, this.mats.detail, 'detail', false);

      if (c.group.children.length) {
        c.group.updateMatrix();
        this.root.add(c.group);
      }
      // Release the CPU-side accumulators.
      c.facade = new FacadeBuilder();
      c.surface = new SurfaceBuilder();
      c.detail = new DetailBuilder();
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
      const i0 = Math.floor((b.x - b.hx) / cell);
      const i1 = Math.floor((b.x + b.hx) / cell);
      const j0 = Math.floor((b.z - b.hz) / cell);
      const j1 = Math.floor((b.z + b.hz) / cell);
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
      if (Math.abs(x - b.x) < b.hx && Math.abs(z - b.z) < b.hz) return true;
    }
    return false;
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
    return planDistrictAt(x, z);
  }

  randomRoadPoint(out: THREE.Vector3): void {
    if (!this.segments.length) {
      out.set(0, 0, 0);
      return;
    }
    const [a, b] = this.segments[this.rng.int(0, this.segments.length)];
    out.lerpVectors(this.roadNodes[a].position, this.roadNodes[b].position, this.rng.next());
  }

  nearestNode(p: THREE.Vector3): number {
    const i = Math.round((p.x + HALF) / blockSize);
    const j = Math.round((p.z + HALF) / blockSize);
    const ci = Math.max(0, Math.min(gridBlocks, i));
    const cj = Math.max(0, Math.min(gridBlocks, j));
    return this.nodeGrid.get(`${ci},${cj}`) ?? -1;
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

const PURPLE = new THREE.Color(0x7b3fd4).convertSRGBToLinear();
const MAGENTA = new THREE.Color(0xc04ad0).convertSRGBToLinear();

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
