/**
 * PROPS AND STREET DRESSING.
 *
 * An empty street is the single most common way an open world betrays itself as
 * fake, so this system's only job is to make sure that no frame shot from
 * anywhere in București is ever clean: lamps and their pools of light on wet
 * asphalt, trolleybus wires crossing the sky, traffic lights, Romanian signage,
 * kiosks and bus shelters, barriers and hazard tape and pallets, autumn trees,
 * hedges and planters, drifting leaves, litter and political flyers, tricolour
 * flags, e-scooters, and the facade screens carrying Georgescu's broadcast.
 *
 * COST MODEL — this adds thousands of objects for a couple of dozen draw calls:
 *
 *   static dressing   merged into ONE geometry per 368 m tile, split into a
 *                     `near` and a `far` half so small objects can be culled at
 *                     200 m while poles, wires and roofs survive to the draw
 *                     distance. ~10-16 tiles are ever visible.
 *   signage/posters   two InstancedMeshes off two procedural canvas atlases.
 *   litter            one InstancedMesh off the poster atlas.
 *   screens           one InstancedMesh sharing one 12 Hz canvas broadcast.
 *   light pools       one additive InstancedMesh.
 *   lamp flares       one instanced billboard mesh.
 *   drifting leaves   one instanced mesh animated entirely in the vertex shader.
 *   real lights       a FIXED pool of 5 point lights that re-homes to the
 *                     nearest lamps (a varying light count would recompile
 *                     every shader in the scene).
 *
 * Placement is driven off the city's own block/street geometry — `blockBounds`,
 * the street ranks and `CityService.spatial` — so nothing lands on a
 * carriageway or inside a building, and the lamp pitch the city already uses is
 * respected so props never grow out of a lamp column.
 *
 * OWNER: props / street-dressing agent.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Rng } from '../core/rng';
import { WorldScale } from '../artDirection';
import { PAL } from '../render/materials';
import { Services, type CityService, type DistrictKind } from '../core/services';
import { QUALITY, detectQuality, onQualityChange, type Quality } from '../render/renderer';

import {
  HALF,
  ROAD_WIDTH,
  WALK_WIDTH,
  columnRank,
  hasTram,
  planDistrictAt,
  rowRank,
  type StreetRank,
} from './city/districts';
import { blockBounds, nodeX, nodeZ } from './city/roads';
import { LANDMARK_VOIDS, PLAZAS } from './city/landmarks';

import { PropBuilder, PropColor as C, createPropMaterials, type PropMaterialSet } from './props/kit';
import {
  WALK_Y, atm, bench, bikeRack, busShelter, eScooter, kiosk, litterBin, marketStall,
  newsStand, phoneBox, roadSign, stoneBollard, streetNamePlate, trafficLight, tricolour,
  utilityCabinet, type SignShape,
} from './props/streetFurniture';
import {
  LeafDrift, autumnTree, grassTufts, hedgeRow, leafLitter, planter, treeGrate,
} from './props/foliage';
import {
  barrierRun, hazardTape, hoarding, jerseyBarrier, palletStack, scaffold, skip,
  spoilHeap, trafficCone, warningLamp,
} from './props/barriers';
import {
  AtlasPanels, FASCIA_ROWS, POSTER_COLS, POSTER_ROWS, SIGN_COLS, SIGN_ROWS,
  makeAtlasMaterial, paintFasciaAtlas, paintPosterAtlas, paintSignAtlas,
} from './props/signage';
import { debris, printedLitter, rubbishDrift } from './props/litter';
import { BroadcastScreens } from './props/screens';
import {
  contactWires, junctionWires, spanWire, tractionPole, utilityBundle, wallAnchor, WIRE_Y,
} from './props/wires';
import { GroundGlow, HeadGlow, LampLights } from './props/lights';

const { blockSize, gridBlocks } = WorldScale;

/**
 * Height the additive light pools are painted at. The carriageway crown sits at
 * 0.09 m and the kerb top at 0.17 m, so anything lower simply fails the depth
 * test and the whole lighting layer silently disappears.
 */
const POOL_Y = 0.16;

/** Tile edge in metres. Matches the city's chunk size so culling agrees. */
const TILE_M = 368;
const TILES = Math.ceil((gridBlocks * blockSize) / TILE_M) + 1;

interface Tile {
  near: PropBuilder | null;
  far: PropBuilder | null;
  group: THREE.Group;
  nearMesh: THREE.Mesh | null;
  centre: THREE.Vector3;
}

interface Edge {
  /** Fixed coordinate of the kerb line. */
  k: number;
  /** Fixed coordinate of the building line. */
  inner: number;
  /** Unit vector pointing at the carriageway. */
  ox: number;
  oz: number;
  alongX: boolean;
  from: number;
  to: number;
  rank: StreetRank;
}

export class PropsSystem implements System {
  readonly name = 'props';
  readonly order = 30;
  readonly root = new THREE.Group();

  private ctx!: GameContext;
  private city: CityService | null = null;
  private rng = new Rng('props-bucuresti');
  private mats!: PropMaterialSet;

  private tiles: Tile[] = [];
  private nearCut = 210;
  private farCut = 760;
  /** Radius within which a tile is allowed into the shadow pass. */
  private shadowCut = 70;

  /* instanced collections */
  private fascia = new AtlasPanels(1, FASCIA_ROWS);
  private posters = new AtlasPanels(POSTER_COLS, POSTER_ROWS);
  private litterPanels = new AtlasPanels(POSTER_COLS, POSTER_ROWS);
  private signFaces = new AtlasPanels(SIGN_COLS, SIGN_ROWS);
  private screens = new BroadcastScreens();
  private pools = new GroundGlow();
  private flares = new HeadGlow();
  private lamps!: LampLights;
  private leaves!: LeafDrift;

  private atlasMats: THREE.Material[] = [];
  private atlasTextures: THREE.Texture[] = [];

  private night = -1;
  private readonly camPos = new THREE.Vector3();
  private stats = {
    tiles: 0, nearTris: 0, farTris: 0,
    fascias: 0, posters: 0, litter: 0, screens: 0, pools: 0, flares: 0, lampSites: 0,
  };

  /* ---------------------------------------------------------------- */
  /* init                                                              */
  /* ---------------------------------------------------------------- */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.root.name = 'props';
    ctx.scene.add(this.root);
    this.city = ctx.tryGet(Services.City) ?? null;

    const q = this.resolveQuality(ctx);
    const qs = QUALITY[q];
    this.nearCut = Math.max(120, qs.entityDrawDistance * 0.75);
    this.farCut = Math.min(1100, Math.max(420, qs.entityDrawDistance * 2.4));
    // Measured at 1920x1080/ultra in the Builders House framing: 84 m costs
    // 907k extra triangles and 15 extra draw calls across four cascades; 60 m
    // costs 480k and is visually identical, because a prop shadow beyond about
    // 40 m is a smudge the eye never resolves.
    this.shadowCut = q === 'low' ? 0 : q === 'medium' ? 34 : q === 'high' ? 46 : 60;
    // Snapshotted at init before this: dropping to `low` from the menu left
    // every prop cut-off and the whole shadow radius at ultra values, so the
    // tier the player picked bought them nothing here.
    onQualityChange('props', ['entityDrawDistance'], (nq, s) => {
      this.nearCut = Math.max(120, s.entityDrawDistance * 0.75);
      this.farCut = Math.min(1100, Math.max(420, s.entityDrawDistance * 2.4));
      this.shadowCut = nq === 'low' ? 0 : nq === 'medium' ? 34 : nq === 'high' ? 46 : 60;
    });

    this.mats = createPropMaterials();
    this.lamps = new LampLights(5, this.root);

    const t0 = performance.now();
    this.buildTiles();
    this.buildAtlases();

    this.dressCity();
    this.dressPlazas();
    this.dressHeroCrossroads();

    this.bake(q);
    const ms = performance.now() - t0;

    console.info(
      `[props] ${(this.stats.nearTris / 1000).toFixed(0)}k near + ` +
      `${(this.stats.farTris / 1000).toFixed(0)}k far tris in ${this.stats.tiles} tiles, ` +
      `${this.stats.fascias} shop signs, ${this.stats.posters} posters, ` +
      `${this.stats.litter} litter, ${this.stats.screens} screens, ` +
      `${this.stats.pools} light pools, ${this.stats.flares} flares, ` +
      `${this.stats.lampSites} lamp sites in ${ms.toFixed(0)} ms`,
    );

    (window as unknown as { __GTA_PROPS__: unknown }).__GTA_PROPS__ = {
      stats: () => ({ ...this.stats, nearCut: this.nearCut, farCut: this.farCut }),
      root: this.root,
      /** Isolate one family for diagnosis. */
      only: (which: 'near' | 'far' | 'signs' | 'litter' | 'screens' | 'glow' | 'all') => {
        this.root.traverse((o) => {
          if (!(o as THREE.Mesh).isMesh) return;
          o.visible = which === 'all' || o.name.includes(which);
        });
      },
      night: (v: number) => this.setNight(v),
      cuts: (near: number, far: number) => { this.nearCut = near; this.farCut = far; },
      /** Radius (m) within which prop tiles are handed to the shadow cascades. */
      shadowCut: (v: number) => { this.shadowCut = v; return this.shadowCut; },
    };
  }

  private resolveQuality(ctx: GameContext): Quality {
    const fromService = ctx.tryGet(Services.Render)?.quality;
    if (fromService) return fromService;
    const p = new URLSearchParams(location.search).get('q') as Quality | null;
    return p ?? detectQuality();
  }

  /* ---------------------------------------------------------------- */
  /* tiles                                                             */
  /* ---------------------------------------------------------------- */

  private buildTiles(): void {
    for (let i = 0; i < TILES; i++) {
      for (let j = 0; j < TILES; j++) {
        const g = new THREE.Group();
        g.name = `props-tile-${i}-${j}`;
        g.matrixAutoUpdate = false;
        this.tiles.push({
          near: new PropBuilder(),
          far: new PropBuilder(),
          group: g,
          nearMesh: null,
          centre: new THREE.Vector3(
            -HALF + (i + 0.5) * TILE_M, 0, -HALF + (j + 0.5) * TILE_M,
          ),
        });
      }
    }
  }

  private tileAt(x: number, z: number): Tile {
    const i = Math.max(0, Math.min(TILES - 1, Math.floor((x + HALF) / TILE_M)));
    const j = Math.max(0, Math.min(TILES - 1, Math.floor((z + HALF) / TILE_M)));
    return this.tiles[i * TILES + j];
  }

  /** Small dressing — culled hard. */
  private near(x: number, z: number): PropBuilder {
    return this.tileAt(x, z).near!;
  }

  /** Silhouette dressing — survives to the far cut. */
  private far(x: number, z: number): PropBuilder {
    return this.tileAt(x, z).far!;
  }

  private bake(q: Quality): void {
    for (const t of this.tiles) {
      const add = (b: PropBuilder | null, label: string): THREE.Mesh | null => {
        if (!b || b.isEmpty) return null;
        const mesh = new THREE.Mesh(b.build(), this.mats.solid);
        mesh.name = `${t.group.name}-${label}`;
        // Props CAST. A contact shadow is the only thing that puts an object on
        // the ground rather than pasting it onto the surface, and without it
        // every bin, cone and lamp column floats. Only the NEAR half casts:
        // far-tile dressing is poles, wires and roof clutter 200 m out, whose
        // shadows land outside the near cascades and cost a full extra draw of
        // the tile per split. `lateUpdate` narrows this further to a radius.
        // Off at bake: on frame one nothing has been distance-gated yet, and
        // handing every near tile in the world to four cascades at once stalls
        // the GPU for seconds. `lateUpdate` switches on the few tiles that are
        // actually close enough for a prop shadow to read.
        mesh.castShadow = false;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        t.group.add(mesh);
        return mesh;
      };
      this.stats.nearTris += t.near?.triangles ?? 0;
      this.stats.farTris += t.far?.triangles ?? 0;
      t.nearMesh = add(t.near, 'near');
      add(t.far, 'far');
      if (t.group.children.length) {
        t.group.updateMatrix();
        this.root.add(t.group);
        this.stats.tiles++;
      }
      t.near = null;
      t.far = null;
    }

    const push = (m: THREE.Object3D | null): void => {
      if (m) this.root.add(m);
    };
    push(this.fascia.build(this.atlasMats[0], 'props-signs-fascia'));
    push(this.posters.build(this.atlasMats[1], 'props-signs-poster'));
    push(this.litterPanels.build(this.atlasMats[2], 'props-litter-printed'));
    push(this.signFaces.build(this.atlasMats[3], 'props-signs-road'));
    push(this.screens.build());
    push(this.pools.build());
    push(this.flares.build());

    this.stats.fascias = this.fascia.count;
    this.stats.posters = this.posters.count;
    this.stats.litter = this.litterPanels.count;
    this.stats.screens = this.screens.count;
    this.stats.pools = this.pools.count;
    this.stats.flares = this.flares.count;
    this.stats.lampSites = this.lamps.siteCount;

    this.leaves = new LeafDrift(
      q === 'low' ? 200 : q === 'medium' ? 380 : 620, 80, this.rng.fork('leaves'),
    );
    this.root.add(this.leaves.mesh);
  }

  private buildAtlases(): void {
    const rng = this.rng.fork('atlas');
    const fasciaTex = paintFasciaAtlas(rng);
    const posterTex = paintPosterAtlas(rng);
    const signTex = paintSignAtlas(rng);
    this.atlasTextures.push(fasciaTex, posterTex, signTex);
    this.atlasMats = [
      makeAtlasMaterial(fasciaTex, { emissive: true, emissiveIntensity: 4.4, roughness: 0.42, key: 'fascia' }),
      makeAtlasMaterial(posterTex, { emissive: true, emissiveIntensity: 0.16, roughness: 0.86, key: 'poster' }),
      // Litter is the same print, soaked: darker, rougher, no glow.
      makeAtlasMaterial(posterTex, { roughness: 0.38, key: 'litter' }),
      // Sign faces: retroreflective sheeting, cut out so a STOP is an octagon
      // and a give-way is a triangle rather than a picture on a square.
      makeAtlasMaterial(signTex, {
        roughness: 0.25, key: 'roadsign', alphaTest: 0.45, emissive: true, emissiveIntensity: 0.14,
      }),
    ];
    (this.atlasMats[2] as THREE.MeshStandardMaterial).color.setRGB(0.26, 0.25, 0.30);
  }

  /* ---------------------------------------------------------------- */
  /* city-wide placement                                               */
  /* ---------------------------------------------------------------- */

  private dressCity(): void {
    const rng = this.rng.fork('blocks');
    for (let i = 0; i < gridBlocks; i++) {
      for (let j = 0; j < gridBlocks; j++) {
        const b = blockBounds(i, j);
        const cx = (b.x0 + b.x1) / 2;
        const cz = (b.z0 + b.z1) / 2;
        if (inVoid(cx, cz)) continue;
        const district = planDistrictAt(cx, cz);
        const edges: Edge[] = [
          { k: b.z0, inner: b.bz0, ox: 0, oz: -1, alongX: true, from: b.x0, to: b.x1, rank: rowRank(j) },
          { k: b.z1, inner: b.bz1, ox: 0, oz: 1, alongX: true, from: b.x0, to: b.x1, rank: rowRank(j + 1) },
          { k: b.x0, inner: b.bx0, ox: -1, oz: 0, alongX: false, from: b.z0, to: b.z1, rank: columnRank(i) },
          { k: b.x1, inner: b.bx1, ox: 1, oz: 0, alongX: false, from: b.z0, to: b.z1, rank: columnRank(i + 1) },
        ];
        for (const ed of edges) this.dressEdge(ed, district, rng);
        this.dressInterior(b, district, rng);
        if (rng.bool(roadworksChance(district))) this.dressRoadworks(edges, rng);
      }
    }
    this.dressJunctions(this.rng.fork('junctions'));
  }

  /* ---- one kerb line ---- */

  private dressEdge(ed: Edge, district: DistrictKind, rng: Rng): void {
    const len = ed.to - ed.from;
    if (len < 14) return;
    const walk = Math.abs(ed.inner - ed.k);
    const central = district === 'glassCorporate' || district === 'guvern'
      || district === 'centruVechi' || district === 'bulevard';

    /** World point `inset` metres in from the kerb line, `t` along the run. */
    const P = (t: number, inset: number): [number, number] => {
      const kx = ed.alongX ? ed.from + t : ed.k;
      const kz = ed.alongX ? ed.k : ed.from + t;
      return [kx - ed.ox * inset, kz - ed.oz * inset];
    };

    // Where the city has already planted a lamp column; nothing may grow there.
    const lp = lampPitch(ed.rank, district);
    const lampN = Math.max(1, Math.round(len / lp));
    const lampT: number[] = [];
    for (let n = 0; n < lampN; n++) lampT.push((n + 0.5) * (len / lampN));
    const clear = (t: number, r = 2.0): boolean => {
      for (const lt of lampT) if (Math.abs(lt - t) < r) return false;
      return true;
    };

    // The lamps themselves get their pool of light and a flare. This is the
    // single strongest cue in the reference frame.
    for (const lt of lampT) {
      const [lx, lz] = P(lt, 1.15);
      const headOut = 1.9;
      const hx = lx + ed.ox * headOut;
      const hz = lz + ed.oz * headOut;
      const hy = WALK_Y + (ed.rank === 2 ? 9.4 : ed.rank === 1 ? 8.4 : 7.2) + 0.6;
      // Pool radius tracks the street: a 42 m boulevard needs a 14 m pool or
      // the carriageway between the two kerb lines stays pitch dark.
      const poolR = ed.rank === 2 ? 8.5 : ed.rank === 1 ? 6.8 : 5.0;
      this.pools.add(hx, POOL_Y, hz, poolR, PAL.sodiumLamp, ed.rank === 0 ? 0.85 : 1.05);
      // THE WET-ROAD SMEAR. A round pool under a lamp reads as damp tarmac; the
      // reference frame's road is a mirror, and a mirror turns every sodium
      // head into a 25 m vertical streak running down the carriageway toward
      // the camera. Two streaks per lamp — one out over the running lanes, one
      // tight against the kerb line where the gutter holds standing water —
      // aligned to the ROAD TANGENT, not to the lamp's own axis.
      const tanX = ed.alongX ? 1 : 0;
      const tanZ = ed.alongX ? 0 : 1;
      const road = ROAD_WIDTH[ed.rank];
      const outer = road * (ed.rank === 2 ? 0.34 : 0.28);
      this.pools.addStreak(
        hx + ed.ox * outer, POOL_Y - 0.005, hz + ed.oz * outer,
        poolR * 3.0, poolR * 0.5, tanX, tanZ, PAL.sodiumLamp, 0.34,
      );
      this.pools.addStreak(
        hx + ed.ox * 0.6, POOL_Y - 0.004, hz + ed.oz * 0.6,
        poolR * 1.9, poolR * 0.26, tanX, tanZ, PAL.sodiumLamp, 0.30,
      );
      this.flares.add(hx, hy - 0.03, hz, 0.5, PAL.sodiumLamp, 1.1);
      this.lamps.register({
        x: hx, y: hy - 0.4, z: hz,
        color: PAL.sodiumLamp.clone(), intensity: 26, distance: 24,
      });
    }

    /* ---- kerb-side furniture ---- */
    const pitch = ed.rank === 2 ? 11 : ed.rank === 1 ? 13 : 17;
    const slots = Math.max(1, Math.floor(len / pitch));
    for (let n = 0; n < slots; n++) {
      const t = (n + 0.5) * (len / slots) + rng.range(-1.6, 1.6);
      if (t < 4 || t > len - 4 || !clear(t)) continue;
      const inset = Math.min(1.55, walk * 0.34);
      const [px, pz] = P(t, inset);
      if (this.blocked(px, pz)) continue;
      const b = this.near(px, pz);
      const kind = rng.weighted(
        ['bin', 'sign', 'scooter', 'news', 'phone', 'cabinet', 'bollard', 'nothing'],
        central
          ? [3.0, 2.4, 1.6, 0.9, 0.5, 0.9, 1.0, 3.0]
          : [2.0, 1.6, 0.5, 0.2, 0.2, 1.2, 0.5, 6.0],
      );
      switch (kind) {
        case 'bin':
          litterBin(b, px, pz, rng);
          leafLitter(b, px, pz, 1.5, 5, rng);
          break;
        case 'sign': {
          const shape = rng.weighted<SignShape>(['circle', 'triangle', 'rect', 'blue'], [3, 1.4, 2, 2]);
          roadSign(b, this.signFaces, px, pz, ed.ox, ed.oz, shape, rng);
          break;
        }
        case 'scooter':
          eScooter(b, px, pz, Math.atan2(ed.ox, ed.oz) + rng.range(-0.6, 0.6), rng);
          break;
        case 'news':
          newsStand(b, px, pz, ed.ox, ed.oz, rng);
          this.pools.add(px + ed.ox * 0.7, POOL_Y, pz + ed.oz * 0.7, 3.4, PAL.sodiumLamp, 0.4);
          break;
        case 'phone':
          phoneBox(b, px, pz, ed.ox, ed.oz);
          this.flares.add(px, WALK_Y + 2.1, pz, 0.7, PAL.screenBlue, 0.5);
          break;
        case 'cabinet':
          utilityCabinet(b, px, pz, ed.ox, ed.oz, rng);
          break;
        case 'bollard':
          stoneBollard(b, px, pz);
          break;
        default:
          break;
      }
    }

    /* ---- the wide strip: only where there is actually room ---- */
    if (walk >= 5.6) {
      const bigPitch = ed.rank === 2 ? 46 : 62;
      const bigs = Math.floor(len / bigPitch);
      for (let n = 0; n < bigs; n++) {
        const t = (n + 0.5) * (len / Math.max(1, bigs)) + rng.range(-4, 4);
        if (t < 9 || t > len - 9 || !clear(t, 4.5)) continue;
        const [px, pz] = P(t, Math.min(3.2, walk * 0.45));
        if (this.blocked(px, pz)) continue;
        const kind = rng.weighted(
          ['shelter', 'kiosk', 'stall', 'planters', 'tree', 'nothing'],
          district === 'centruVechi' ? [1.0, 2.2, 2.0, 1.4, 0.8, 1.6]
            : district === 'parc' ? [0.6, 0.6, 0.6, 2.0, 3.0, 1.0]
              : [2.0, 1.6, 0.6, 1.6, 1.6, 1.6],
        );
        const bf = this.far(px, pz);
        const bn = this.near(px, pz);
        switch (kind) {
          case 'shelter':
            busShelter(bf, px, pz, ed.ox, ed.oz, rng);
            this.pools.add(px + ed.ox * 1.4, POOL_Y, pz + ed.oz * 1.4, 7.5, PAL.sodiumLamp, 0.6);
            this.flares.add(px, WALK_Y + 2.4, pz, 1.0, PAL.sodiumLamp, 0.6);
            this.lamps.register({
              x: px, y: WALK_Y + 2.3, z: pz,
              color: PAL.sodiumLamp.clone(), intensity: 11, distance: 15,
            });
            // People wait, and they drop things.
            debris(bn, px + ed.ox * 1.2, pz + ed.oz * 1.2, WALK_Y, 2.4, 7, rng);
            printedLitter(this.litterPanels, px + ed.ox * 1.6, pz + ed.oz * 1.6, WALK_Y, 2.6, 4, rng);
            break;
          case 'kiosk':
            kiosk(bf, px, pz, ed.ox, ed.oz, rng);
            this.pools.add(px + ed.ox * 2.0, POOL_Y, pz + ed.oz * 2.0, 8.0, PAL.builderMagenta, 0.7);
            this.flares.add(px + ed.ox * 1.2, WALK_Y + 2.45, pz + ed.oz * 1.2, 1.3, PAL.neonPink, 0.9);
            this.lamps.register({
              x: px + ed.ox * 1.3, y: WALK_Y + 2.2, z: pz + ed.oz * 1.3,
              color: PAL.builderMagenta.clone(), intensity: 14, distance: 16,
            });
            debris(bn, px + ed.ox * 2.0, pz + ed.oz * 2.0, WALK_Y, 3.0, 9, rng);
            break;
          case 'stall':
            marketStall(bf, px, pz, ed.ox, ed.oz, rng);
            this.pools.add(px, POOL_Y, pz, 5.5, PAL.sodiumLamp, 0.55);
            this.flares.add(px, WALK_Y + 2.1, pz, 0.9, PAL.sodiumLamp, 1.0);
            debris(bn, px, pz, WALK_Y, 2.6, 8, rng);
            break;
          case 'planters': {
            const n2 = 2 + rng.int(0, 3);
            for (let k = 0; k < n2; k++) {
              const [qx, qz] = P(t + (k - n2 / 2) * 1.9, Math.min(2.4, walk * 0.4));
              planter(bn, qx, qz, rng);
              leafLitter(bn, qx, qz, 1.6, 5, rng);
            }
            break;
          }
          case 'tree': {
            autumnTree(bf, px, pz, rng, district === 'parc' ? 1.25 : 1.0);
            treeGrate(bn, px, pz, rng);
            leafLitter(bn, px, pz, 3.4, 15, rng);
            break;
          }
          default:
            break;
        }
      }
    }

    /* ---- against the building line ---- */
    const wallPitch = 9;
    const wallSlots = Math.max(1, Math.floor(len / wallPitch));
    for (let n = 0; n < wallSlots; n++) {
      const t = (n + 0.5) * (len / wallSlots) + rng.range(-1.4, 1.4);
      if (t < 3 || t > len - 3) continue;
      const [wx, wz] = P(t, walk - 0.9);
      // Only where a building actually stands behind the line.
      const [ix, iz] = P(t, walk + 0.6);
      if (!this.blocked(ix, iz)) continue;
      const b = this.near(wx, wz);
      const kind = rng.weighted(
        ['bench', 'bike', 'poster', 'drift', 'atm', 'nothing'],
        central ? [1.6, 1.4, 3.0, 1.6, 0.7, 3.0] : [0.8, 0.6, 1.6, 2.0, 0.2, 6.0],
      );
      switch (kind) {
        case 'bench':
          bench(b, wx, wz, ed.ox, ed.oz, rng);
          leafLitter(b, wx + ed.ox * 0.9, wz + ed.oz * 0.9, 1.7, 8, rng);
          break;
        case 'bike':
          bikeRack(b, wx, wz, ed.ox, ed.oz, 2 + rng.int(0, 3), rng);
          break;
        case 'poster': {
          // Fly-posting on the wall itself.
          const [px2, pz2] = P(t, walk - 0.06);
          const n2 = 1 + rng.int(0, 4);
          for (let k = 0; k < n2; k++) {
            const off = (k - (n2 - 1) / 2) * 0.78;
            const ax = px2 + (ed.alongX ? off : 0);
            const az = pz2 + (ed.alongX ? 0 : off);
            this.posters.add(ax, rng.range(1.6, 2.5), az, 0.72, 0.98, ed.ox, ed.oz, rng.int(0, 16));
          }
          break;
        }
        case 'drift':
          rubbishDrift(b, wx, wz, WALK_Y, ed.alongX ? 1 : 0, ed.alongX ? 0 : 1,
            rng.range(1.4, 3.2), rng);
          break;
        case 'atm':
          atm(b, wx, wz, ed.ox, ed.oz);
          this.pools.add(wx + ed.ox * 1.0, WALK_Y + 0.04, wz + ed.oz * 1.0, 4.0, PAL.screenBlue, 0.5);
          this.flares.add(wx + ed.ox * 0.2, WALK_Y + 1.7, wz + ed.oz * 0.2, 0.55, PAL.screenBlue, 0.6);
          break;
        default:
          break;
      }
    }

    /* ---- facades: shopfronts, flags, screens ---- */
    this.dressFacade(ed, district, rng, P, walk);

    /* ---- gutter leaves and road litter, always ----
       A carriageway with nothing on it is 40-50% of a street-level frame doing
       no work at all. Runs sit every 15 m rather than every 26, and each one
       throws paper OUT onto the tarmac as well as into the gutter. */
    const leafRuns = Math.floor(len / 15);
    for (let n = 0; n < leafRuns; n++) {
      const t = (n + 0.5) * (len / Math.max(1, leafRuns));
      const [gx, gz] = P(t, 0.35);
      const b = this.near(gx, gz);
      leafLitter(b, gx, gz, 2.9, 5 + rng.int(0, 4), rng, WALK_Y);
      if (rng.bool(0.5)) debris(b, gx, gz, WALK_Y, 2.2, 4, rng);
      printedLitter(this.litterPanels, gx + ed.ox * 0.9, gz + ed.oz * 0.9, POOL_Y - 0.06, 2.8, 1 + rng.int(0, 2), rng);
      // Out on the carriageway itself, where nothing else ever lands.
      if (rng.bool(0.55)) {
        const out = 1.5 + rng.range(0, ROAD_WIDTH[ed.rank] * 0.4);
        const [rx, rz] = P(t + rng.range(-4, 4), -out);
        printedLitter(this.litterPanels, rx, rz, POOL_Y - 0.075, 3.2, 1 + rng.int(0, 2), rng);
        leafLitter(this.near(rx, rz), rx, rz, 3.0, 3 + rng.int(0, 3), rng, 0.095);
      }
    }

    /* ---- overhead cabling across narrow streets ---- */
    // Telecom bundles: cut ~60%. Overhead cable is a signature of the city but
    // at the old rate every side street had one and the upper frame turned into
    // a scribble. Now it is an occasional accent.
    if (ed.rank === 0 && rng.bool(district === 'centruVechi' ? 0.22 : 0.06)) {
      const t = rng.range(6, Math.max(7, len - 6));
      const [wx, wz] = P(t, walk - 0.2);
      const [ix, iz] = P(t, walk + 0.6);
      if (this.blocked(ix, iz)) {
        const road = ROAD_WIDTH[ed.rank];
        const span = walk * 2 + road - 1.2;
        const ax = wx + ed.ox * 0;
        const az = wz + ed.oz * 0;
        const bx = wx + ed.ox * span;
        const bz = wz + ed.oz * span;
        const y = rng.range(7.5, 11.5);
        const f = this.far(ax, az);
        utilityBundle(f, ax, y, az, bx, y + rng.range(-0.8, 0.8), bz, rng);
        wallAnchor(f, ax, y, az, ed.ox, ed.oz);
        wallAnchor(f, bx, y, bz, -ed.ox, -ed.oz);
      }
    }
  }

  /* ---- shop fronts, flags and facade screens ---- */

  private dressFacade(
    ed: Edge, district: DistrictKind, rng: Rng,
    P: (t: number, inset: number) => [number, number],
    walk: number,
  ): void {
    const len = ed.to - ed.from;
    const retail = district === 'centruVechi' ? 0.72
      : district === 'bulevard' ? 0.5
        : district === 'glassCorporate' ? 0.34
          : district === 'cartier' ? 0.26 : 0.12;
    const pitch = district === 'centruVechi' ? 7.5 : 11;
    const slots = Math.max(1, Math.floor(len / pitch));

    for (let n = 0; n < slots; n++) {
      const t = (n + 0.5) * (len / slots);
      // Sampled just 0.6 m behind the building line, not 1.8 m: a frontage set
      // back from the line still reads as "blocked" further in, and anything
      // hung off it — flag, fascia, screen — then floats in mid-air.
      const [ix, iz] = P(t, walk + 0.6);
      if (!this.blocked(ix, iz)) continue;
      const [wx, wz] = P(t, walk - 0.05);
      const bf = this.far(wx, wz);
      const bn = this.near(wx, wz);

      if (rng.bool(retail)) {
        // Lit fascia band over the shop, an awning, and warm spill on the paving.
        const sw = Math.min(pitch - 1.0, rng.range(3.6, 6.0));
        const sy = rng.range(3.8, 4.9);
        this.fascia.add(wx + ed.ox * 0.16, sy, wz + ed.oz * 0.16, sw, sw * 0.26,
          ed.ox, ed.oz, rng.int(0, FASCIA_ROWS));
        // Shopfront glazing below it, lit from inside.
        const glow = rng.weighted([PAL.sodiumLamp, PAL.builderMagenta, PAL.screenBlue], [4, 2, 1]);
        bn.box(wx + ed.ox * 0.08, WALK_Y + 1.7, wz + ed.oz * 0.08, sw * 0.92, 2.6, 0.1,
          Math.atan2(ed.ox, ed.oz),
          { color: C.glassPale, mr: [0.4, 0.12], emissive: [glow.r * 1.4, glow.g * 1.4, glow.b * 1.4] });
        this.pools.add(wx + ed.ox * 1.9, WALK_Y + 0.04, wz + ed.oz * 1.9, sw * 1.35, glow, 0.42);
        this.lamps.register({
          x: wx + ed.ox * 1.0, y: WALK_Y + 2.4, z: wz + ed.oz * 1.0,
          color: glow.clone(), intensity: 9, distance: 13,
        });
        if (rng.bool(0.45)) {
          // Awning.
          bn.box(wx + ed.ox * 0.9, sy - 0.75, wz + ed.oz * 0.9, sw, 0.06, 1.7,
            Math.atan2(ed.ox, ed.oz), { color: C.fabricRed, mr: [0, 0.9] });
          bn.box(wx + ed.ox * 1.72, sy - 0.95, wz + ed.oz * 1.72, sw, 0.34, 0.05,
            Math.atan2(ed.ox, ed.oz), { color: C.fabricStripe, mr: [0, 0.9] });
        }
        // A-board or crates on the pavement.
        if (rng.bool(0.35)) {
          const [ax, az] = P(t, walk - 2.0);
          bn.box(ax, WALK_Y + 0.5, az, 0.62, 1.0, 0.1, Math.atan2(ed.ox, ed.oz) + rng.range(-0.4, 0.4),
            { color: C.wood, mr: [0, 0.88] });
        }
      } else if (rng.bool(0.5)) {
        // Blank wall: fly-posting and a street-name plate.
        const [px, pz] = P(t, walk - 0.05);
        const n2 = 2 + rng.int(0, 4);
        for (let k = 0; k < n2; k++) {
          const off = (k - (n2 - 1) / 2) * 0.8;
          this.posters.add(
            px + (ed.alongX ? off : 0), rng.range(1.7, 3.2), pz + (ed.alongX ? 0 : off),
            0.74, 1.0, ed.ox, ed.oz, rng.int(0, 16),
          );
        }
        if (rng.bool(0.2)) streetNamePlate(bn, px, 3.1, pz, ed.ox, ed.oz);
      }

      // Tricolour flags on civic and corporate frontages.
      const flagChance = district === 'guvern' ? 0.24
        : district === 'glassCorporate' ? 0.12 : district === 'bulevard' ? 0.07 : 0.02;
      if (rng.bool(flagChance)) {
        tricolour(bf, wx, WALK_Y + rng.range(5.5, 8.0), wz, ed.ox, ed.oz, rng);
      }

      // Facade screens: the broadcast. Only on big frontages, and rationed so
      // they stay an event rather than wallpaper.
      const screenChance = district === 'glassCorporate' ? 0.075
        : district === 'guvern' ? 0.05 : district === 'bulevard' ? 0.035 : 0;
      if (screenChance > 0 && rng.bool(screenChance)) {
        this.addScreen(wx, rng.range(11, 22), wz, rng.range(6.5, 11), ed.ox, ed.oz, rng);
      }
    }
  }

  private addScreen(
    x: number, y: number, z: number, w: number,
    nx: number, nz: number, rng: Rng,
  ): void {
    const h = w * 0.5;
    this.screens.add({ x: x + nx * 0.16, y, z: z + nz * 0.16, w, h, nx, nz });
    const b = this.far(x, z);
    const yaw = Math.atan2(nx, nz);
    // Bezel and mounting frame.
    b.box(x + nx * 0.06, y, z + nz * 0.06, w + 0.5, h + 0.5, 0.2, yaw,
      { color: C.steelDark, mr: [0.7, 0.4] });
    for (const s of [-1, 1]) {
      b.box(x + nx * 0.02 + Math.sin(yaw + Math.PI / 2) * s * (w / 2 + 0.4), y,
        z + nz * 0.02 + Math.cos(yaw + Math.PI / 2) * s * (w / 2 + 0.4),
        0.22, h + 0.9, 0.3, yaw, { color: C.steel, mr: [0.8, 0.35] });
    }
    // The screen throws magenta onto the pavement below it.
    this.pools.add(x + nx * (w * 0.4), POOL_Y, z + nz * (w * 0.4), w * 1.5, PAL.builderMagenta, 0.7);
    this.flares.add(x + nx * 0.4, y, z + nz * 0.4, w * 0.42, PAL.builderMagenta, 0.32);
    this.lamps.register({
      x: x + nx * 2.5, y: y - h * 0.3, z: z + nz * 2.5,
      color: PAL.builderMagenta.clone(), intensity: 26 + rng.range(0, 10), distance: 30,
    });
  }

  /* ---- block interiors: courtyards, parks, yards ---- */

  private dressInterior(
    b: ReturnType<typeof blockBounds>, district: DistrictKind, rng: Rng,
  ): void {
    const w = b.bx1 - b.bx0;
    const d = b.bz1 - b.bz0;
    if (w < 10 || d < 10) return;

    if (district === 'parc') {
      const n = Math.floor((w * d) / 420);
      for (let k = 0; k < n; k++) {
        const px = rng.range(b.bx0 + 3, b.bx1 - 3);
        const pz = rng.range(b.bz0 + 3, b.bz1 - 3);
        if (this.blocked(px, pz)) continue;
        const roll = rng.next();
        if (roll < 0.55) {
          autumnTree(this.far(px, pz), px, pz, rng, rng.range(1.0, 1.45));
          leafLitter(this.near(px, pz), px, pz, 4.2, 16, rng);
        } else if (roll < 0.72) {
          grassTufts(this.near(px, pz), px, pz, 3.4, 8, rng);
        } else if (roll < 0.86) {
          bench(this.near(px, pz), px, pz, rng.bool() ? 1 : -1, 0, rng);
          leafLitter(this.near(px, pz), px, pz, 2.4, 8, rng);
        } else {
          hedgeRow(this.near(px, pz), px, pz, rng.bool() ? 1 : 0, rng.bool() ? 0 : 1,
            rng.range(4, 11), rng.range(0.8, 1.4), rng);
        }
      }
      return;
    }

    if (district === 'cartier' || district === 'industrial') {
      // Yards: skips, pallets, spoil, a stack of tyres' worth of junk.
      const n = 1 + rng.int(0, 3);
      for (let k = 0; k < n; k++) {
        const px = rng.range(b.bx0 + 4, b.bx1 - 4);
        const pz = rng.range(b.bz0 + 4, b.bz1 - 4);
        if (this.blocked(px, pz)) continue;
        const bn = this.near(px, pz);
        const roll = rng.next();
        if (roll < 0.3) skip(bn, px, WALK_Y, pz, rng.range(0, Math.PI), rng);
        else if (roll < 0.55) palletStack(bn, px, WALK_Y, pz, 2 + rng.int(0, 4), rng);
        else if (roll < 0.72) spoilHeap(bn, px, WALK_Y, pz, rng.range(1.2, 2.4), rng);
        else if (roll < 0.86) {
          for (let c = 0; c < 4; c++) {
            trafficCone(bn, px + rng.range(-2, 2), WALK_Y, pz + rng.range(-2, 2), rng);
          }
        } else {
          grassTufts(bn, px, pz, 3.0, 7, rng);
        }
        debris(bn, px, pz, WALK_Y, 3.2, 10, rng);
      }
      return;
    }

    if (district === 'glassCorporate' || district === 'guvern') {
      // Forecourts: planters, hedges, bollard lines and a flagpole.
      const n = 1 + rng.int(0, 3);
      for (let k = 0; k < n; k++) {
        const px = rng.range(b.bx0 + 3, b.bx1 - 3);
        const pz = rng.range(b.bz0 + 3, b.bz1 - 3);
        if (this.blocked(px, pz)) continue;
        const bn = this.near(px, pz);
        if (rng.bool(0.5)) {
          planter(bn, px, pz, rng);
          leafLitter(bn, px, pz, 2.0, 7, rng);
        } else {
          hedgeRow(bn, px, pz, rng.bool() ? 1 : 0, rng.bool() ? 0 : 1,
            rng.range(3, 9), rng.range(0.7, 1.1), rng);
        }
      }
    }
  }

  /* ---- roadworks: the permanent condition ---- */

  private dressRoadworks(edges: Edge[], rng: Rng): void {
    const ed = edges[rng.int(0, edges.length)];
    const len = ed.to - ed.from;
    if (len < 26) return;
    const walk = Math.abs(ed.inner - ed.k);
    const t0 = rng.range(6, Math.max(7, len - 20));
    const P = (t: number, inset: number): [number, number] => {
      const kx = ed.alongX ? ed.from + t : ed.k;
      const kz = ed.alongX ? ed.k : ed.from + t;
      return [kx - ed.ox * inset, kz - ed.oz * inset];
    };
    const dirX = ed.alongX ? 1 : 0;
    const dirZ = ed.alongX ? 0 : 1;
    const inset = Math.min(1.9, walk * 0.4);
    const [sx, sz] = P(t0, inset);
    const bn = this.near(sx, sz);
    const bf = this.far(sx, sz);

    const panels = 3 + rng.int(0, 4);
    const [ex, ez] = barrierRun(bn, sx, sz, dirX, dirZ, panels, rng);
    // Hazard tape from the first barrier to the last, sagging.
    hazardTape(bn, sx, WALK_Y + 1.0, sz, ex, WALK_Y + 0.95, ez, rng);
    if (rng.bool(0.6)) {
      hazardTape(bn, sx, WALK_Y + 0.66, sz, ex, WALK_Y + 0.6, ez, rng);
    }

    // Excavation kit inside the run.
    const mid = (t0 + t0 + panels * 2.1) / 2;
    const [mx, mz] = P(mid, inset + 1.2);
    if (rng.bool(0.6)) palletStack(bn, mx, WALK_Y, mz, 2 + rng.int(0, 3), rng);
    if (rng.bool(0.5)) spoilHeap(bn, mx + rng.range(-2, 2), WALK_Y, mz + rng.range(-2, 2), rng.range(0.9, 1.8), rng);
    if (rng.bool(0.4)) skip(bn, mx + rng.range(-3, 3), WALK_Y, mz, rng.range(0, Math.PI), rng);
    for (let k = 0; k < 3 + rng.int(0, 4); k++) {
      const [cx2, cz2] = P(t0 + rng.range(-2, panels * 2.1 + 2), rng.range(-0.6, inset + 1.0));
      trafficCone(bn, cx2, cz2 < 1e9 ? WALK_Y : WALK_Y, cz2, rng);
    }
    for (let k = 0; k < 2; k++) {
      const [wx, wz] = P(t0 + k * panels * 2.1, inset);
      warningLamp(bn, wx, WALK_Y, wz);
      this.flares.add(wx, WALK_Y + 1.0, wz, 0.5, PAL.sodiumLamp, 0.8);
      this.pools.add(wx, POOL_Y, wz, 3.4, PAL.sodiumLamp, 0.4);
    }
    // Jersey barriers protecting the hole from the carriageway.
    if (rng.bool(0.45)) {
      for (let k = 0; k < 3; k++) {
        const [jx, jz] = P(t0 + k * 2.1, -0.8);
        jerseyBarrier(bn, jx, 0.02, jz, Math.atan2(dirX, dirZ), rng);
      }
    }
    // Hoarding and scaffolding against the building line.
    if (rng.bool(0.35)) {
      const [hx, hz] = P(t0, walk - 0.6);
      const [ix, iz] = P(t0, walk + 0.6);
      if (this.blocked(ix, iz)) {
        hoarding(bf, hx, hz, dirX, dirZ, Math.min(len - t0 - 2, rng.range(8, 20)), rng);
        if (rng.bool(0.5)) {
          scaffold(bf, hx, hz, dirX, dirZ, 2 + rng.int(0, 3), 2 + rng.int(0, 4), rng);
        }
        // Fly-posted on the hoarding.
        for (let k = 0; k < 5; k++) {
          const [px, pz] = P(t0 + 1.5 + k * 1.5, walk - 0.68);
          this.posters.add(px, rng.range(1.2, 2.0), pz, 0.8, 1.05, ed.ox, ed.oz, rng.int(0, 16));
        }
      }
    }
    printedLitter(this.litterPanels, sx, sz, WALK_Y, 4.0, 6, rng);
    debris(bn, sx, sz, WALK_Y, 4.0, 12, rng);
  }

  /* ---- junctions: signals and the overhead ---- */

  private dressJunctions(rng: Rng): void {
    const n = gridBlocks + 1;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = nodeX(i);
        const z = nodeZ(j);
        if (inVoid(x, z)) continue;
        const rI = columnRank(i);
        const rJ = rowRank(j);
        const hw = ROAD_WIDTH[rI] / 2;
        const hd = ROAD_WIDTH[rJ] / 2;
        const major = rI >= 1 && rJ >= 1;
        const district = planDistrictAt(x, z);

        if (major) {
          const mast = rI === 2 || rJ === 2;
          let corner = 0;
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              const px = x + sx * (hw + 1.6);
              const pz = z + sz * (hd + 1.6);
              if (this.blocked(px, pz)) continue;
              // Alternate which approach each corner controls.
              const alongX = corner % 2 === 0;
              const fx = alongX ? -sx : 0;
              const fz = alongX ? 0 : -sz;
              trafficLight(this.far(px, pz), px, pz, fx, fz, rng, mast && corner < 2);
              this.flares.add(px + fx * 0.3, WALK_Y + (mast ? 4.9 : 2.7), pz + fz * 0.3,
                0.42, PAL.sodiumLamp, 0.35);
              corner++;
            }
          }
        }

        // Overhead wiring: contact wires along tram/trolleybus streets, span
        // wires across them, and the tangle over the crossing.
        const tramI = hasTram(i, null);
        const tramJ = hasTram(null, j);
        if (tramI || tramJ) {
          if (tramI && tramJ) junctionWires(this.far(x, z), x, z, hw, hd, rng);
          // Poles and spans down the block to the next node.
          if (tramI && j < gridBlocks) this.wireRun(x, z, x, nodeZ(j + 1), hw, rng);
          if (tramJ && i < gridBlocks) this.wireRun(x, z, nodeX(i + 1), z, hd, rng);
        } else if ((rI === 1 || rJ === 1) && rng.bool(0.12)) {
          // Trolleybus-only routes on the secondary grid.
          if (rI === 1 && j < gridBlocks) this.wireRun(x, z, x, nodeZ(j + 1), hw, rng);
          if (rJ === 1 && i < gridBlocks) this.wireRun(x, z, nodeX(i + 1), z, hd, rng);
        }

        // Street name plates on a pole at the corner of every major junction.
        if (major && rng.bool(0.6)) {
          const px = x + (hw + 1.1);
          const pz = z + (hd + 1.1);
          if (!this.blocked(px, pz)) {
            const b = this.near(px, pz);
            b.cyl(px, WALK_Y, pz, 0.05, 0.045, 2.7, 5, { color: C.galv, mr: [0.8, 0.4] }, false);
            streetNamePlate(b, px, WALK_Y + 2.5, pz, -1, 0);
            streetNamePlate(b, px, WALK_Y + 2.2, pz, 0, -1);
          }
        }

        // Big civic districts get a flagpole cluster at the crossing.
        if (major && district === 'guvern' && rng.bool(0.3)) {
          const px = x + (hw + 3.2);
          const pz = z + (hd + 3.2);
          if (!this.blocked(px, pz)) {
            for (let k = 0; k < 3; k++) {
              tricolour(this.far(px, pz), px + k * 1.6, WALK_Y, pz, 0, -1, rng, true);
            }
          }
        }
      }
    }
  }

  /** Poles + spans + contact wires along one street segment. */
  private wireRun(ax: number, az: number, bx: number, bz: number, halfRoad: number, rng: Rng): void {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 20) return;
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz;
    const pz = ux;
    const s0 = halfRoad + 4.0;
    const s1 = halfRoad + 6.0;
    contactWires(this.far((ax + bx) / 2, (az + bz) / 2), ax + ux * s0, az + uz * s0,
      bx - ux * s1, bz - uz * s1, 0.62, rng);

    // 42 m spacing put a transverse span across the frame every three seconds
    // of walking. Real trolleybus spans sit far further apart than the poles.
    const spacing = 46;
    const count = Math.max(1, Math.round((len - s0 - s1) / spacing));
    for (let k = 0; k <= count; k++) {
      const t = s0 + ((len - s0 - s1) * k) / count;
      const cx = ax + ux * t;
      const cz = az + uz * t;
      const lx = cx + px * (halfRoad + 1.7);
      const lz = cz + pz * (halfRoad + 1.7);
      const rx = cx - px * (halfRoad + 1.7);
      const rz = cz - pz * (halfRoad + 1.7);
      const haveL = !this.blocked(lx, lz);
      const haveR = !this.blocked(rx, rz);
      if (haveL) {
        tractionPole(this.far(lx, lz), lx, lz, -px, -pz, rng);
        this.flares.add(lx - px * 3.0, WALK_Y + 9.6, lz - pz * 3.0, 0.6, PAL.sodiumLamp, 1.2);
        this.pools.add(lx - px * 3.0, POOL_Y, lz - pz * 3.0, 7.5, PAL.sodiumLamp, 0.95);
        // Traction poles straddle the running lanes, so their smear is the
        // longest thing on the road.
        this.pools.addStreak(lx - px * (halfRoad * 0.55), POOL_Y - 0.005, lz - pz * (halfRoad * 0.55),
          26, 4.5, ux, uz, PAL.sodiumLamp, 0.34);
        this.lamps.register({
          x: lx - px * 3.0, y: WALK_Y + 9.2, z: lz - pz * 3.0,
          color: PAL.sodiumLamp.clone(), intensity: 34, distance: 30,
        });
      }
      if (haveR && rng.bool(0.55)) {
        tractionPole(this.far(rx, rz), rx, rz, px, pz, rng);
      }
      // Only every other pole pair carries a transverse span — a 60% cut on
      // the count of hard lines crossing the sky.
      if (haveL && haveR && k % 2 === 0) spanWire(this.far(cx, cz), lx, lz, rx, rz, rng);
    }
  }

  /* ---- plazas ---- */

  private dressPlazas(): void {
    const rng = this.rng.fork('plazas');
    for (const p of PLAZAS) {
      const ring = p.radius * 0.72;
      const n = Math.max(8, Math.floor(p.radius / 6));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + rng.range(-0.06, 0.06);
        const r = ring * rng.range(0.86, 1.0);
        const px = p.x + Math.cos(a) * r;
        const pz = p.z + Math.sin(a) * r;
        if (this.blocked(px, pz)) continue;
        const bn = this.near(px, pz);
        const bf = this.far(px, pz);
        const roll = rng.next();
        if (p.id === 'cismigiu') {
          if (roll < 0.6) {
            autumnTree(bf, px, pz, rng, rng.range(1.1, 1.5));
            leafLitter(bn, px, pz, 4.6, 18, rng);
          } else if (roll < 0.8) {
            bench(bn, px, pz, -Math.cos(a), -Math.sin(a), rng);
          } else {
            hedgeRow(bn, px, pz, Math.cos(a + 1.57), Math.sin(a + 1.57), rng.range(4, 10), 1.0, rng);
          }
          continue;
        }
        if (roll < 0.28) {
          planter(bn, px, pz, rng);
          leafLitter(bn, px, pz, 2.2, 7, rng);
        } else if (roll < 0.46) {
          bench(bn, px, pz, -Math.cos(a), -Math.sin(a), rng);
        } else if (roll < 0.58) {
          autumnTree(bf, px, pz, rng, 1.1);
          leafLitter(bn, px, pz, 3.8, 13, rng);
        } else if (roll < 0.70) {
          barrierRun(bn, px, pz, -Math.sin(a), Math.cos(a), 2 + rng.int(0, 3), rng);
        } else if (roll < 0.80) {
          eScooter(bn, px, pz, a, rng);
        } else if (roll < 0.9) {
          stoneBollard(bn, px, pz);
        } else {
          kiosk(bf, px, pz, -Math.cos(a), -Math.sin(a), rng);
          this.pools.add(px, POOL_Y, pz, 8, PAL.builderMagenta, 0.7);
          this.flares.add(px, WALK_Y + 2.4, pz, 1.2, PAL.neonPink, 0.9);
        }
        if (rng.bool(0.4)) printedLitter(this.litterPanels, px, pz, 0.18, 3.0, 4, rng);
      }
      // A tricolour cluster and a screen looking over every civic square.
      if (p.id !== 'cismigiu') {
        const fx = p.x;
        const fz = p.z - p.radius * 0.55;
        for (let k = 0; k < 3; k++) {
          tricolour(this.far(fx + k * 2.2, fz), fx + k * 2.2, WALK_Y, fz, 0, 1, rng, true);
        }
      }
    }
  }

  /* ---- the hero crossroads, framed like the reference ---- */

  private dressHeroCrossroads(): void {
    const rng = this.rng.fork('hero');
    // Builders House stands at (-46, 46), 30 x 24 m, so its south face is z=34
    // and its forecourt plaza runs x -86..-12, z 6..20. The landmark's own
    // `goTo` target is (-46, 0, 16) and every natural approach comes up the
    // boulevard from -z, which means the FOREGROUND of the hero framing is the
    // plaza's southern lip around z 5..12 — not z 4 as this set used to sit,
    // 40 m off to one side where nothing ever looked.
    const bx = -46;

    // Barrier run straight across the near foreground of the approach.
    const runZ = 7.6;
    const runX0 = bx - 26;
    let bn = this.near(runX0 + 12, runZ);
    const [ex, ez] = barrierRun(bn, runX0, runZ, 1, 0, 13, rng, 0.18, 1.15);
    hazardTape(bn, runX0, 1.36, runZ, ex, 1.26, ez, rng);
    hazardTape(bn, runX0, 0.9, runZ, ex, 0.84, ez, rng);
    // Cones spilling out in front of the run, three deep — the reference has a
    // whole scatter of them, not a tidy line.
    for (let k = 0; k < 26; k++) {
      const cx2 = runX0 - 3 + rng.range(0, 34);
      const cz2 = runZ - rng.range(0.9, 5.2);
      trafficCone(this.near(cx2, cz2), cx2, 0.02, cz2, rng);
    }
    palletStack(bn, bx + 2.5, 0.18, runZ + 1.6, 4, rng);
    palletStack(bn, bx + 5.1, 0.18, runZ + 1.3, 2, rng);
    skip(bn, bx + 11, 0.18, runZ + 2.2, 0.24, rng);
    spoilHeap(bn, bx - 4, 0.18, runZ + 1.8, 1.6, rng);
    warningLamp(bn, bx - 12, 0.18, runZ - 0.4);
    this.flares.add(bx - 12, 1.15, runZ - 0.4, 0.55, PAL.sodiumLamp, 1.0);
    warningLamp(bn, bx + 8, 0.18, runZ - 0.4);
    this.flares.add(bx + 8, 1.15, runZ - 0.4, 0.55, PAL.sodiumLamp, 1.0);
    // A second, shorter run raking away to the west so the barrier reads in
    // depth rather than as one flat picket fence.
    const bn2 = this.near(runX0 - 12, runZ + 7);
    const [ex2, ez2] = barrierRun(bn2, runX0 - 17, runZ + 12, 0.62, -0.78, 7, rng, 0.18, 1.15);
    hazardTape(bn2, runX0 - 17, runZ + 12.9, runZ + 12, ex2, 1.26, ez2, rng);

    // The acid-green e-scooter, parked in the left foreground as in the
    // reference. It is NOT a light source — no pool.
    bn = this.near(bx - 44, runZ + 1);
    eScooter(bn, bx - 44, runZ + 1, 1.9, rng);
    eScooter(this.near(bx - 41, runZ + 1.6), bx - 41, runZ + 1.6, 2.3, rng);

    // Litter carpeting the foreground — the reference has newspapers all over
    // the wet paving, so this is deliberately heavy.
    printedLitter(this.litterPanels, bx - 8, runZ - 5, 0.02, 11, 26, rng);
    printedLitter(this.litterPanels, bx - 30, runZ - 3, 0.02, 9, 18, rng);
    printedLitter(this.litterPanels, bx + 14, runZ - 4, 0.02, 8, 13, rng);
    debris(this.near(bx - 10, runZ - 5), bx - 10, runZ - 5, 0.02, 7, 34, rng);
    debris(this.near(bx - 28, runZ - 3), bx - 28, runZ - 3, 0.02, 6, 22, rng);
    leafLitter(this.near(bx - 14, runZ + 1), bx - 14, runZ + 1, 9, 40, rng, 0.19);
    leafLitter(this.near(bx + 12, runZ - 2), bx + 12, runZ - 2, 7, 24, rng, 0.19);

    // The APPROACH. Everything above is 30 m from the camera in the standard
    // framing; the reference's foreground — the bottom third of the frame — is
    // wet paving carpeted in newspaper and leaves. Seed the whole corridor the
    // player walks up, so there is no empty tarmac between the camera and the
    // set.
    for (let k = 0; k < 16; k++) {
      const ax = bx - 44 + rng.range(0, 60);
      const az = -34 + rng.range(0, 40);
      printedLitter(this.litterPanels, ax, az, 0.095, 4.5, 2 + rng.int(0, 3), rng);
      leafLitter(this.near(ax, az), ax, az, 4.0, 5 + rng.int(0, 5), rng, 0.095);
      if (rng.bool(0.4)) debris(this.near(ax, az), ax, az, 0.095, 3.0, 5, rng);
    }
    // Two more roadwork clusters up the approach so the barrier run reads as
    // one episode of a permanently half-dug city rather than a single prop set.
    for (const [cx2, cz2, panels] of [[bx - 40, -12, 5], [bx + 6, -20, 4]] as const) {
      const bnA = this.near(cx2, cz2);
      const [ax2, az2] = barrierRun(bnA, cx2, cz2, 1, 0, panels, rng, 0.02, 1.15);
      hazardTape(bnA, cx2, 1.2, cz2, ax2, 1.12, az2, rng);
      for (let k = 0; k < 7; k++) {
        trafficCone(bnA, cx2 + rng.range(-2, panels * 2.1 + 2), 0.02, cz2 + rng.range(-3.4, 1.2), rng);
      }
      spoilHeap(bnA, cx2 + panels, 0.02, cz2 + 1.2, 1.3, rng);
      warningLamp(bnA, cx2 - 0.6, 0.02, cz2 - 0.5);
      this.flares.add(cx2 - 0.6, 1.0, cz2 - 0.5, 0.5, PAL.sodiumLamp, 1.0);
      this.pools.add(cx2 + panels, POOL_Y, cz2, 6.5, PAL.sodiumLamp, 0.45);
    }

    // Tricolour on the tower's south-west corner, and the hero screens.
    const bf = this.far(bx - 16, 8);
    tricolour(bf, bx - 14, 9.5, 32.6, 0, -1, rng);
    tricolour(bf, bx - 10, 9.5, 32.6, 0, -1, rng);
    this.addScreen(bx - 4, 17.5, 33.4, 13, 0, -1, rng);
    this.addScreen(bx - 15.6, 21, 46, 11, -1, 0, rng);

    // ONE traction pole with a clean pair of catenaries running up the
    // boulevard. The reference has about six wires against the sky, not a
    // spider web: the diagonal guy wires and the crossing run that used to be
    // here read as a scratch on the lens, so they are gone.
    const px = bx - 34;
    const pz = 4;
    tractionPole(bf, px, pz, 1, 0, rng);
    this.flares.add(px + 3.0, WIRE_Y + 3.6, pz, 0.65, PAL.sodiumLamp, 1.3);
    this.pools.add(px + 3.0, POOL_Y, pz, 8, PAL.sodiumLamp, 1.0);
    this.lamps.register({
      x: px + 3.0, y: WIRE_Y + 3.2, z: pz,
      color: PAL.sodiumLamp.clone(), intensity: 40, distance: 34,
    });
    contactWires(bf, px + 6, pz - 60, px + 6, pz + 14, 0.62, rng);
  }

  /* ---------------------------------------------------------------- */
  /* per-frame                                                         */
  /* ---------------------------------------------------------------- */

  update(dt: number, ctx: GameContext): void {
    this.screens.update(dt);
    // The leaf field belongs to the GROUND under the camera, never to the
    // camera itself — see the note in LeafDrift's vertex shader.
    ctx.camera.getWorldPosition(this.camPos);
    const g = this.city?.spatial.groundHeight(this.camPos.x, this.camPos.z);
    this.leaves.update(ctx.time.elapsed, ctx.camera, g !== undefined && Number.isFinite(g) ? g : 0);

    // Keep the foliage back-scatter locked to the real sun, so a crown lights
    // up when you walk round it instead of glowing from a fixed direction.
    const sky = (window as unknown as { __GTA_SKY__?: { sunDirection: THREE.Vector3 } }).__GTA_SKY__;
    if (sky?.sunDirection) this.mats.uSunDir.value.copy(sky.sunDirection);

    const w = ctx.tryGet(Services.Weather);
    if (w) this.setNight(nightAmount(w.timeOfDay, w.preset === 'night'));
  }

  lateUpdate(dt: number, ctx: GameContext): void {
    ctx.camera.getWorldPosition(this.camPos);
    const far2 = (this.farCut + TILE_M) * (this.farCut + TILE_M);
    const near2 = (this.nearCut + TILE_M) * (this.nearCut + TILE_M);
    // Shadow casting is the expensive half: every casting tile is redrawn once
    // per cascade. A prop's shadow only reads within the first cascade or two,
    // so tiles beyond `shadowCut` keep their geometry and drop their caster.
    // Measured against the tile's EDGE, not its centre — at a 368 m tile the
    // centre distance is meaningless for a 84 m cut.
    const half = TILE_M / 2;
    const shadow2 = this.shadowCut * this.shadowCut;
    for (const t of this.tiles) {
      const dx = t.centre.x - this.camPos.x;
      const dz = t.centre.z - this.camPos.z;
      const d2 = dx * dx + dz * dz;
      t.group.visible = d2 < far2;
      if (t.nearMesh) {
        const vis = d2 < near2;
        t.nearMesh.visible = vis;
        const ex = Math.max(0, Math.abs(dx) - half);
        const ez = Math.max(0, Math.abs(dz) - half);
        t.nearMesh.castShadow = vis && ex * ex + ez * ez < shadow2;
      }
    }
    this.lamps.update(dt, ctx.camera);
  }

  private setNight(v: number): void {
    const n = Math.max(0, Math.min(1, v));
    if (Math.abs(n - this.night) < 0.004) return;
    this.night = n;
    this.mats.uNight.value = n;
    this.flares.setGain(0.42 + n * 1.5);
    this.pools.setGain(0.34 + n * 0.9);
    this.lamps.setGain(0.45 + n * 1.4);
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  private blocked(x: number, z: number): boolean {
    return this.city?.spatial.isBlocked(x, z) ?? false;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.lamps.dispose();
    this.leaves?.dispose();
    this.screens.dispose();
    this.pools.dispose();
    this.flares.dispose();
    for (const m of this.atlasMats) m.dispose();
    for (const t of this.atlasTextures) t.dispose();
    this.mats?.dispose();
    this.root.clear();
  }
}

/* ------------------------------------------------------------------ */
/* free functions                                                      */
/* ------------------------------------------------------------------ */

function inVoid(x: number, z: number): boolean {
  for (const v of LANDMARK_VOIDS) {
    if (x > v.x0 && x < v.x1 && z > v.z0 && z < v.z1) return true;
  }
  return false;
}

/**
 * The lamp pitch the CITY uses, replicated exactly so props never sprout out
 * of a lamp column. Kept in sync with `lampPitch` in world/city/roads.ts.
 */
function lampPitch(rank: StreetRank, district: DistrictKind): number {
  const central = district === 'glassCorporate' || district === 'guvern' || district === 'centruVechi';
  if (rank === 2) return 28;
  if (rank === 1) return central ? 34 : 48;
  return central ? 52 : 88;
}

function roadworksChance(d: DistrictKind): number {
  switch (d) {
    case 'glassCorporate': return 0.34;
    case 'bulevard': return 0.26;
    case 'centruVechi': return 0.30;
    case 'guvern': return 0.22;
    case 'industrial': return 0.30;
    case 'cartier': return 0.16;
    default: return 0.05;
  }
}

/** 0 at midday, 1 deep at night. Mirrors the city's own ramp. */
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
