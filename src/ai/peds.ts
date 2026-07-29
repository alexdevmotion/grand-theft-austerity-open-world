/** Pedestrian crowds.
 *
 *  OWNER: pedestrian agent.
 *
 *  Streams a living crowd around the camera: pavement navigation on a graph
 *  derived from the city's own footways, local steering and queueing, road
 *  crossings that wait for traffic, per-district archetypes, idle street life
 *  (phones, cigarettes, conversations, window shopping, vendors, dogs), and
 *  reactions — flinching, scattering, and being knocked flat by a car.
 *
 *  RENDERING is a two-tier system. The nearest `actorBudget` people run on the
 *  characters agent's real skinned rig (`src/characters/`) — proper bodies,
 *  wardrobe, foot IK and ragdoll. Everyone beyond that is an instanced imposter
 *  drawn from six shared InstancedMeshes, wearing the same clothes as the
 *  actor it would be promoted into, so the swap is invisible.
 *
 *    peds/navigation.ts  footway graph + loiter anchors, probed from CityService
 *    peds/actors.ts      the bridge onto the skinned rig + the idle arm layer
 *    peds/rig.ts         imposter skeleton solver + instanced renderer + dogs
 *    peds/crowd.ts       the agent, steering, reactions
 *    peds/behaviours.ts  what people are doing while they stand around
 *    peds/spawn.ts       archetype mix, density curves
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Rng } from '../core/rng';
import { QUALITY, detectQuality, type Quality } from '../render/renderer';
import {
  Services,
  type CharacterHandle,
  type CityService,
  type DistrictKind,
  type PedArchetype,
  type PedService,
} from '../core/services';
import {
  BI,
  CharacterFactory,
  prof,
  rollAppearance,
  type Appearance,
  type CharacterActor,
} from '../characters';
import { EdgeKind, PavementGraph } from './peds/navigation';
import { CIG_GLOW, CrowdRenderer, PHONE_GLOW } from './peds/rig';
import { CrowdGrid, Ped, VehicleGrid, type CrowdEnv } from './peds/crowd';
import { pickCluster, pickIdle } from './peds/behaviours';
import { driveActor } from './peds/actors';
import {
  baseSpeed,
  districtDensity,
  makeAppearance,
  pickArchetype,
  timeOfDayDensity,
} from './peds/spawn';

const DOG_COLOURS = [0x4a3a2e, 0x2a2420, 0x8a7156, 0xc4b49a, 0x6a5a4a, 0x1e1a18];

export class PedSystem implements System, PedService {
  readonly name = 'peds';
  readonly order = 120;

  density = 1;

  private ctx!: GameContext;
  private city: CityService | null = null;
  private graph = new PavementGraph();
  /** Dogs only — people are on the characters agent's skinned rig. */
  private renderer!: CrowdRenderer;
  private factory!: CharacterFactory;
  private actors = new Map<string, CharacterActor>();
  private wardrobe = new Map<PedArchetype, Appearance[]>();
  private static readonly WARDROBE_VARIANTS = 16;
  private rng = new Rng('bucuresti-multime');

  private peds = new Map<string, Ped>();
  private list: Ped[] = [];
  private pool: Ped[] = [];
  private maxPeds = 80;
  private drawDistance = 240;
  /**
   * Peds are only streamed in inside this radius. Deliberately much tighter
   * than `entityDrawDistance`: a fixed budget of people spread over a 340 m
   * disc gives one person per street, which is what an empty city looks like.
   */
  private spawnRadius = 150;

  private grid = new CrowdGrid();
  private vehGrid = new VehicleGrid();
  private lastVehPos = new Map<string, { x: number; z: number }>();

  private readonly camPos = new THREE.Vector3();
  private readonly camFwd = new THREE.Vector3();
  private spawnTimer = 0;
  private filled = false;
  private tension = 0;
  private shadowRadius = 38;
  private actorBudget = 34;
  private ranked: Array<{ p: Ped; d: number }> = [];
  private edgeBuf: number[] = [];
  private anchorBuf: number[] = [];

  private landmarkBias: Array<{ x: number; z: number; r: number; kinds: PedArchetype[]; weights: number[] }> = [];

  private env!: CrowdEnv;
  private stats = {
    peds: 0, drawn: 0, skinned: 0, instances: 0, triangles: 0,
    spawned: 0, despawned: 0, knockdowns: 0, target: 0,
  };

  get all(): ReadonlyArray<CharacterHandle> {
    return this.list;
  }

  /* ---------------------------------------------------------------- */
  /* init                                                              */
  /* ---------------------------------------------------------------- */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Peds, this);
    this.city = ctx.tryGet(Services.City) ?? null;

    const q = this.resolveQuality(ctx);
    const qs = QUALITY[q];
    this.maxPeds = qs.maxPeds;
    this.drawDistance = qs.entityDrawDistance;
    // Concentrate the budget: at ultra this is ~90 m, which puts the whole
    // 120-person allowance on the four blocks you can actually read.
    this.spawnRadius = Math.min(this.drawDistance * 0.55, 34 + this.maxPeds * 0.47);

    const t0 = performance.now();
    if (this.city) this.graph.build(this.city, this.rng.fork('pavement'));
    const buildMs = performance.now() - t0;

    this.factory = CharacterFactory.of(ctx);
    // The nearest slice of the crowd runs on the characters agent's skinned
    // rig; everyone further out is an instanced imposter wearing the same
    // clothes. A skinned actor costs a draw call, twenty-two bones of scene
    // graph and a skeleton update; an imposter costs fifteen instances in a
    // shared buffer. Measured at 1920x1080/ultra, going all-skinned at 120
    // peds cost 15 fps, and past about 45 m the two are indistinguishable.
    this.actorBudget = q === 'ultra' ? 34 : q === 'high' ? 26 : q === 'medium' ? 16 : 8;
    this.renderer = new CrowdRenderer(ctx.scene, this.maxPeds, q !== 'low');
    this.renderer.lod1 = Math.max(34, this.drawDistance * 0.2);
    this.renderer.lod2 = Math.max(80, this.drawDistance * 0.45);
    this.shadowRadius = q === 'ultra' ? 38 : q === 'high' ? 30 : q === 'medium' ? 20 : 0;
    this.renderer.shadowRadius = this.shadowRadius;

    // Anchor Object3Ds live under one group so other systems can parent to
    // `CharacterHandle.object` without walking the scene.
    for (let i = 0; i < this.maxPeds + 12; i++) this.pool.push(new Ped());

    this.collectLandmarkBias();

    this.env = {
      graph: this.graph,
      spatial: this.city?.spatial ?? {
        snapToRoad: () => false,
        groundHeight: () => 0,
        isBlocked: () => false,
      },
      rng: this.rng.fork('behaviour'),
      time: 0,
      hour: 19,
      district: (x, z) => this.districtAt(x, z),
      playerPos: null,
      playerInVehicle: false,
      playerSpeed: 0,
      vehicles: this.vehGrid,
      peds: this.grid,
      onKnockdown: (p, fatal) => this.onKnockdown(p, fatal),
      tension: 0,
    };

    // A crash anywhere near people empties the pavement.
    ctx.events.on('vehicle:collision', (e) => {
      if (e.impulse > 3200) this.scatter(e.position, 26);
    });
    ctx.events.on('player:died', () => this.scatter(this.camPos, 20));

    console.info(
      `[peds] pavement graph: ${this.graph.stats.nodes} corners, ` +
      `${this.graph.stats.walk} footways, ${this.graph.stats.cross} crossings, ` +
      `${this.graph.stats.anchors} loiter spots in ${buildMs.toFixed(0)} ms; ` +
      `max ${this.maxPeds} peds`,
    );

    (window as unknown as { __GTA_PEDS__: unknown }).__GTA_PEDS__ = {
      stats: () => ({ ...this.stats, graph: this.graph.stats, density: this.density }),
      /** Force the population immediately (screenshot helper). */
      fill: (n?: number) => {
        const want = n ?? this.targetPopulation();
        let guard = 0;
        while (this.list.length < want && guard++ < want * 30) this.trySpawn(true);
        return this.list.length;
      },
      clear: () => {
        for (const p of this.list.slice()) this.despawn(p.id);
      },
      setDensity: (n: number) => {
        this.density = n;
        if (n <= 0) for (const p of this.list.slice()) this.despawn(p.id);
        return this.density;
      },
      /** Nearest-N budget for the skinned rig; the rest use the imposter. */
      actorBudget: (n?: number) => {
        if (n !== undefined) this.actorBudget = n;
        return { budget: this.actorBudget, live: this.actors.size };
      },
      scatter: (r = 40) => this.scatter(this.camPos, r),
      shadows: (on: boolean) => this.renderer.setShadows(on),
      poses: () => {
        const m: Record<string, number> = {};
        for (const p of this.list) m[p.pose] = (m[p.pose] ?? 0) + 1;
        return m;
      },
      /** Force everyone into one pose so it can be inspected. */
      showcase: (pose: string) => {
        for (const p of this.list) p.pose = pose as never;
        return this.list.length;
      },
      /**
       * Frame the nearest ped from the front-left, at eye height. Used to
       * inspect a pose without hardcoding camera coordinates.
       */
      inspect: (index = 0, distance = 3.1) => {
        const p = this.ranked[index]?.p ?? this.list[index];
        if (!p) return null;
        const a = p.yaw + 2.35;
        const px = p.position.x + Math.sin(a) * distance;
        const pz = p.position.z + Math.cos(a) * distance;
        const dbg = (window as unknown as {
          __GTA_DEBUG__: { setCamera(a: number, b: number, c: number, d: number, e: number, f: number, g?: number): void };
        }).__GTA_DEBUG__;
        dbg.setCamera(px, p.position.y + 1.35, pz, p.position.x, p.position.y + 1.05, p.position.z, 42);
        return { id: p.id, pose: p.pose, mode: p.mode, archetype: p.archetype, skinned: this.actors.has(p.id) };
      },
    };
  }

  private resolveQuality(ctx: GameContext): Quality {
    const fromService = ctx.tryGet(Services.Render)?.quality;
    if (fromService) return fromService;
    const p = new URLSearchParams(location.search).get('q') as Quality | null;
    return p ?? detectQuality();
  }

  private districtAt(x: number, z: number): DistrictKind {
    return this.city?.districtAt(x, z) ?? 'bulevard';
  }

  /**
   * Landmarks pull their own crowd: builders and protesters at the Builders
   * House hoarding, tourists on the Parliament axis.
   */
  private collectLandmarkBias(): void {
    if (!this.city) return;
    for (const [id, lm] of this.city.landmarks) {
      if (id === 'buildersHouse') {
        this.landmarkBias.push({
          x: lm.position.x, z: lm.position.z, r: Math.max(110, lm.radius * 1.6),
          kinds: ['builder', 'protester', 'officeWorker', 'civilian', 'ministryAgent'],
          weights: [3.0, 2.6, 2.2, 2.0, 0.8],
        });
      } else if (id === 'palatulParlamentului') {
        this.landmarkBias.push({
          x: lm.position.x, z: lm.position.z, r: Math.max(220, lm.radius * 1.5),
          kinds: ['tourist', 'civilian', 'ministryAgent', 'protester'],
          weights: [4.0, 2.0, 1.4, 1.6],
        });
      } else if (id.startsWith('plaza')) {
        this.landmarkBias.push({
          x: lm.position.x, z: lm.position.z, r: Math.max(80, lm.radius * 1.3),
          kinds: ['civilian', 'streetVendor', 'tourist', 'officeWorker'],
          weights: [3.0, 1.4, 1.4, 1.6],
        });
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* PedService                                                        */
  /* ---------------------------------------------------------------- */

  spawn(archetype: PedArchetype, position: THREE.Vector3, headingRad: number): CharacterHandle {
    const p = this.take();
    const rng = this.rng;
    p.reset(archetype, makeAppearance(archetype, rng), position.x, position.z, headingRad, baseSpeed(archetype, rng), rng);
    p.position.y = this.env.spatial.groundHeight(position.x, position.z);
    if (p.position.y === -Infinity) p.position.y = position.y;
    this.attach(p);
    this.routeFromHere(p);
    return p;
  }

  despawn(id: string): void {
    const p = this.peds.get(id);
    if (!p) return;
    this.peds.delete(id);
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
    p.active = false;
    p.object.removeFromParent();
    const actor = this.actors.get(id);
    if (actor) {
      // Returns the shared geometry/material refs to the factory cache.
      actor.dispose();
      this.actors.delete(id);
    }
    this.pool.push(p);
    this.stats.despawned++;
  }

  get(id: string): CharacterHandle | undefined {
    return this.peds.get(id);
  }

  scatter(centre: THREE.Vector3, radius: number): void {
    const r2 = radius * radius;
    for (const p of this.list) {
      const dx = p.position.x - centre.x;
      const dz = p.position.z - centre.z;
      if (dx * dx + dz * dz > r2) continue;
      p.startFlee(centre.x, centre.z);
    }
    this.tension = Math.max(this.tension, 1);
  }

  /* ---------------------------------------------------------------- */
  /* streaming                                                         */
  /* ---------------------------------------------------------------- */

  private take(): Ped {
    return this.pool.pop() ?? new Ped();
  }

  /**
   * A fixed wardrobe per archetype rather than a fresh roll each spawn.
   *
   * The character factory caches geometry and textures by appearance key, and
   * a crowd that streams a hundred people a minute with a unique wardrobe each
   * time rebuilds a skinned mesh every spawn. Sixteen variants per archetype is
   * 128 distinct people — more than you can tell apart on one street — and
   * every spawn after the first is a cache hit.
   */
  private appearanceFor(archetype: PedArchetype): Appearance {
    let list = this.wardrobe.get(archetype);
    if (!list) this.wardrobe.set(archetype, (list = []));
    if (list.length < PedSystem.WARDROBE_VARIANTS) {
      const a = rollAppearance(this.rng, archetype);
      list.push(a);
      return a;
    }
    return list[this.rng.int(0, list.length)];
  }

  private attach(p: Ped): void {
    this.peds.set(p.id, p);
    this.list.push(p);
    this.renderer.root.add(p.object);

    // Body, wardrobe, skinning and ragdoll all belong to the characters agent.
    // The appearance is chosen here even when this ped starts life as an
    // imposter, so promotion later never changes what they are wearing.
    const appearance = this.appearanceFor(p.archetype);
    p.appearance = appearance;
    p.app.height = appearance.height;
    copyWardrobe(appearance, p);
    this.stats.spawned++;
  }

  /** Give a ped the real skinned rig. */
  private promote(p: Ped): CharacterActor | undefined {
    if (!p.appearance) return undefined;
    const actor = this.factory.create(p.appearance as Appearance, { seed: p.seed, castShadow: false });
    actor.setTransform(p.position, p.yaw);
    this.renderer.root.add(actor.object);
    this.actors.set(p.id, actor);
    return actor;
  }

  private demote(p: Ped): void {
    const actor = this.actors.get(p.id);
    if (!actor) return;
    actor.dispose();
    this.actors.delete(p.id);
  }

  private targetPopulation(): number {
    const hour = this.ctx.tryGet(Services.Weather)?.timeOfDay ?? 19;
    const d = this.districtAt(this.camPos.x, this.camPos.z);
    const t = this.maxPeds
      * Math.max(0, Math.min(2, this.density))
      * timeOfDayDensity(hour)
      * districtDensity(d);
    return Math.round(Math.min(this.maxPeds, t));
  }

  /** Archetype for a spawn point, blending district mix with landmark pull. */
  private archetypeAt(x: number, z: number, hour: number): PedArchetype {
    for (const b of this.landmarkBias) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < b.r && this.rng.bool(1 - d / b.r)) {
        return this.rng.weighted(b.kinds, b.weights);
      }
    }
    return pickArchetype(this.districtAt(x, z), hour, this.rng);
  }

  /**
   * Find a footway point around the camera and put somebody on it. `force`
   * relaxes the "not right in front of you" rule for the screenshot helper.
   */
  private trySpawn(force = false): boolean {
    const g = this.graph;
    if (!g.edges.length) return false;
    const minR = force ? 5 : 17;
    const maxR = this.spawnRadius;

    for (let attempt = 0; attempt < 8; attempt++) {
      // Aim at a point around the camera first, biased toward the near field —
      // a crowd spread evenly over a 300 m disc reads as an empty city.
      const a = this.rng.range(0, Math.PI * 2);
      const rr = minR + (maxR - minR) * this.rng.next() ** 0.62;
      const aimX = this.camPos.x + Math.sin(a) * rr;
      const aimZ = this.camPos.z + Math.cos(a) * rr;
      this.graph.edgesNear(aimX, aimZ, 34, this.edgeBuf);
      if (!this.edgeBuf.length) continue;

      const e = g.edges[this.edgeBuf[this.rng.int(0, this.edgeBuf.length)]];
      if (!e || e.kind !== EdgeKind.Walk) continue;
      const na = g.nodes[e.a];
      // Closest point on the edge to the aim point, jittered.
      const proj = clamp01(
        ((aimX - na.x) * e.ux + (aimZ - na.z) * e.uz) / e.length + this.rng.range(-0.12, 0.12),
      );
      const t = proj;
      const lat = this.rng.range(-0.7, 0.7) * e.halfWidth;
      const x = na.x + e.ux * e.length * t - e.uz * lat;
      const z = na.z + e.uz * e.length * t + e.ux * lat;

      const dx = x - this.camPos.x;
      const dz = z - this.camPos.z;
      const d = Math.hypot(dx, dz);
      if (d < minR || d > maxR * 1.2) continue;
      if (!force && d < 62) {
        // Do not materialise inside the player's field of view. Beyond ~60 m a
        // person is a dozen pixels tall and the pop is invisible.
        const dot = (dx * this.camFwd.x + dz * this.camFwd.z) / (d || 1);
        if (dot > 0.22) continue;
      }
      if (this.env.spatial.isBlocked(x, z)) continue;
      if (this.env.spatial.groundHeight(x, z) <= 0.08) continue;
      if (this.crowdedAt(x, z, 1.0)) continue;

      const hour = this.ctx.tryGet(Services.Weather)?.timeOfDay ?? 19;
      const district = this.districtAt(x, z);

      // Groups arrive together.
      const cluster = this.rng.bool(0.4) ? pickCluster(district, this.rng) : null;
      if (cluster && this.list.length + cluster.size <= this.maxPeds) {
        this.spawnCluster(x, z, cluster.size, cluster.radius, cluster.archetype, district, hour);
        return true;
      }

      const arch = this.archetypeAt(x, z, hour);
      const p = this.take();
      const app = makeAppearance(arch, this.rng);
      p.reset(arch, app, x, z, Math.atan2(e.ux, e.uz), baseSpeed(arch, this.rng), this.rng);
      p.position.y = Math.max(0, this.env.spatial.groundHeight(x, z));
      p.placeOnEdge(g, e.id, this.rng.bool() ? e.a : e.b, t);
      p.lateralTargetRandomise(this.rng);

      // A slice of the crowd is standing still doing something.
      if (this.rng.bool(0.34)) {
        const anchor = this.nearestAnchor(x, z, 22);
        if (anchor) {
          p.anchorAt(
            anchor.x, anchor.z, anchor.yaw,
            pickIdle(arch, district, anchor.kind === 'shopfront', this.rng),
          );
          p.position.y = Math.max(0, this.env.spatial.groundHeight(anchor.x, anchor.z));
        }
      }
      if (arch === 'streetVendor') {
        const anchor = this.nearestAnchor(x, z, 30);
        if (anchor) {
          p.anchorAt(anchor.x, anchor.z, anchor.yaw, pickIdle(arch, district, true, this.rng));
        }
      }

      // Joggers and dog walkers.
      if (p.mode === 'route' && this.rng.bool(district === 'parc' ? 0.16 : 0.05)) {
        p.jogger = true;
        p.preferredSpeed = this.rng.range(2.8, 3.6);
        p.maxSpeed = p.preferredSpeed;
        p.app.bag = 0;
        p.app.phone = false;
      } else if (p.mode === 'route' && this.rng.bool(0.07)) {
        p.dog = {
          x: p.position.x, z: p.position.z, y: p.position.y,
          yaw: p.yaw, phase: this.rng.range(0, 6.28),
          colour: new THREE.Color(this.rng.pick(DOG_COLOURS)).convertSRGBToLinear(),
          size: this.rng.range(0.72, 1.15),
        };
        p.preferredSpeed *= 0.82;
        p.maxSpeed = p.preferredSpeed;
      }

      this.attach(p);
      return true;
    }
    return false;
  }

  private spawnCluster(
    x: number,
    z: number,
    size: number,
    radius: number,
    forced: PedArchetype | undefined,
    district: DistrictKind,
    hour: number,
  ): void {
    const members: Ped[] = [];
    for (let k = 0; k < size; k++) {
      const a = (k / size) * Math.PI * 2 + this.rng.range(-0.25, 0.25);
      const cx = x + Math.sin(a) * radius;
      const cz = z + Math.cos(a) * radius;
      if (this.env.spatial.isBlocked(cx, cz)) continue;
      const arch = forced ?? this.archetypeAt(cx, cz, hour);
      const p = this.take();
      p.reset(arch, makeAppearance(arch, this.rng), cx, cz, a + Math.PI, baseSpeed(arch, this.rng), this.rng);
      p.position.y = Math.max(0, this.env.spatial.groundHeight(cx, cz));
      const spec = pickIdle(arch, district, false, this.rng);
      // Everyone in a cluster is in the same conversation.
      p.anchorAt(cx, cz, a + Math.PI, {
        ...spec,
        kind: k === 0 ? 'talk' : 'listen',
        pose: k === 0 ? 'talk' : 'idle',
        facesGroup: true,
      });
      this.attach(p);
      members.push(p);
    }
    for (let k = 0; k < members.length; k++) {
      members[k].partner = members[(k + 1) % members.length] ?? null;
    }
    // Rotate who is speaking so a group is not one person gesturing forever.
    if (members.length > 1) {
      for (let k = 0; k < members.length; k++) {
        members[k].idleTimer = 6 + k * 5 + this.rng.range(0, 4);
      }
    }
  }

  private nearestAnchor(x: number, z: number, radius: number) {
    const anchors = this.graph.anchors;
    if (!anchors.length) return null;
    this.graph.anchorsNear(x, z, radius, this.anchorBuf);
    let best = null as (typeof anchors)[number] | null;
    let bestD = radius * radius;
    for (const id of this.anchorBuf) {
      const a = anchors[id];
      const d = (a.x - x) ** 2 + (a.z - z) ** 2;
      if (d < bestD && !this.crowdedAt(a.x, a.z, 0.95)) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  private crowdedAt(x: number, z: number, radius: number): boolean {
    let hit = false;
    const r2 = radius * radius;
    this.grid.forEachNear(x, z, (o) => {
      if (hit) return;
      const dx = o.position.x - x;
      const dz = o.position.z - z;
      if (dx * dx + dz * dz < r2) hit = true;
    });
    return hit;
  }

  private routeFromHere(p: Ped): void {
    const g = this.graph;
    const node = g.nearestNode(p.position.x, p.position.z);
    if (node < 0) return;
    const n = g.nodes[node];
    for (const id of n.edges) {
      if (g.edges[id].kind === EdgeKind.Walk) {
        p.placeOnEdge(g, id, node, 0.02);
        return;
      }
    }
  }

  private onKnockdown(p: Ped, fatal: boolean): void {
    this.stats.knockdowns++;
    this.ctx.events.emit('ped:killed', { position: p.position.clone() });
    this.ctx.tryGet(Services.Audio)?.oneShot(fatal ? 'ped_hit' : 'ped_yell', p.position, 0.8);
    // Everyone who saw it runs.
    this.scatter(p.position, 22);
  }

  /* ---------------------------------------------------------------- */
  /* simulation                                                        */
  /* ---------------------------------------------------------------- */

  fixedUpdate(dt: number, ctx: GameContext): void {
    ctx.camera.getWorldPosition(this.camPos);
    ctx.camera.getWorldDirection(this.camFwd);

    const player = ctx.tryGet(Services.Player);
    const wanted = ctx.tryGet(Services.Wanted);
    this.tension = Math.max(
      this.tension - dt * 0.22,
      Math.min(1, (wanted?.stars ?? 0) / 3),
    );

    let t = prof.begin();
    this.buildVehicleGrid(dt, ctx);
    prof.add('peds.vehGrid', t);

    t = prof.begin();
    this.grid.rebuild(this.list);
    prof.add('peds.grid', t);

    this.env.time = ctx.time.elapsed;
    this.env.hour = ctx.tryGet(Services.Weather)?.timeOfDay ?? 19;
    this.env.playerPos = player ? player.position : null;
    this.env.playerInVehicle = !!player?.inVehicle;
    this.env.playerSpeed = player?.inVehicle ? Math.abs(player.inVehicle.speed) : 0;
    this.env.tension = this.tension;

    t = prof.begin();
    for (const p of this.list) p.update(dt, this.env);
    prof.add('peds.steer', t);

    t = prof.begin();
    this.stream(dt);
    prof.add('peds.stream', t);
    this.stats.peds = this.list.length;
  }

  private buildVehicleGrid(dt: number, ctx: GameContext): void {
    this.vehGrid.begin();
    const vs = ctx.tryGet(Services.Vehicles);
    if (!vs) return;
    const inv = dt > 1e-5 ? 1 / dt : 0;
    for (const v of vs.all) {
      const p = v.position;
      const dxz = Math.hypot(p.x - this.camPos.x, p.z - this.camPos.z);
      if (dxz > this.drawDistance + 60) continue;
      let last = this.lastVehPos.get(v.id);
      if (!last) this.lastVehPos.set(v.id, (last = { x: p.x, z: p.z }));
      // Velocity from actual displacement — independent of anyone's forward-axis
      // convention, and correct while reversing or sliding.
      let vx = (p.x - last.x) * inv;
      let vz = (p.z - last.z) * inv;
      last.x = p.x;
      last.z = p.z;
      let speed = Math.hypot(vx, vz);
      if (speed < 0.05 && Math.abs(v.speed) > 0.4) {
        // First frame after a teleport/spawn: fall back to the reported speed.
        speed = Math.abs(v.speed);
        vx = 0;
        vz = 0;
      } else if (speed > 0.01) {
        vx /= speed;
        vz /= speed;
      }
      this.vehGrid.add(p.x, p.z, vx, vz, speed, v.id);
    }
  }

  private stream(dt: number): void {
    const cut = this.spawnRadius * 1.5;
    const cut2 = cut * cut;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const dx = p.position.x - this.camPos.x;
      const dz = p.position.z - this.camPos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > cut2) {
        this.despawn(p.id);
        continue;
      }
      if (p.mode === 'down' && p.downTimer <= 0 && d2 > 900) this.despawn(p.id);
    }

    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.15;

    const target = this.targetPopulation();
    this.stats.target = target;

    // First fill happens all at once and ignores the field-of-view rule —
    // nobody is watching during the boot screen, and an empty first frame is
    // the worst thing a screenshot can catch.
    if (!this.filled) {
      this.filled = true;
      let guard = target * 26;
      while (this.list.length < target && guard-- > 0) this.trySpawn(true);
      return;
    }

    // A failed attempt means that patch of pavement was busy or blocked; keep
    // spending the budget rather than giving up for the whole tick.
    for (let k = 0; k < 7 && this.list.length < target; k++) this.trySpawn();
    // Trim gently when the target drops (district change, dusk).
    if (this.list.length > target + 6) {
      let worst: Ped | null = null;
      let worstD = 0;
      for (const p of this.list) {
        const d = (p.position.x - this.camPos.x) ** 2 + (p.position.z - this.camPos.z) ** 2;
        if (d > worstD) {
          worstD = d;
          worst = p;
        }
      }
      if (worst) this.despawn(worst.id);
    }
  }

  /* ---------------------------------------------------------------- */
  /* rendering                                                         */
  /* ---------------------------------------------------------------- */

  lateUpdate(dt: number, ctx: GameContext): void {
    ctx.camera.getWorldPosition(this.camPos);
    const t = ctx.time.elapsed;
    const r = this.renderer;
    r.begin();
    const cut = this.drawDistance;

    // Nearest first — the skinned budget goes to whoever is close enough for
    // a face and a wardrobe to read.
    let tp = prof.begin();
    this.ranked.length = 0;
    for (const p of this.list) {
      if (!p.active) continue;
      this.ranked.push({
        p,
        d: Math.hypot(p.position.x - this.camPos.x, p.position.z - this.camPos.z),
      });
    }
    this.ranked.sort(byDistance);
    prof.add('peds.rank', tp);

    let promotions = 0;
    let skinned = 0;
    for (let i = 0; i < this.ranked.length; i++) {
      const { p, d } = this.ranked[i];
      let actor = this.actors.get(p.id);
      const wants = i < this.actorBudget && d <= cut;

      if (wants && !actor && promotions < 2) {
        // Rate-limited: building a skeleton is cheap but not free, and a
        // hundred at once is a visible hitch.
        tp = prof.begin();
        actor = this.promote(p);
        prof.add('peds.promote', tp);
        promotions++;
      } else if (!wants && actor && !p.ragdolled && (i > this.actorBudget + 5 || d > cut)) {
        this.demote(p);
        actor = undefined;
      }

      if (actor) {
        if (!actor.object.visible) actor.setVisible(true);
        tp = prof.begin();
        driveActor(actor, p, dt, ctx, d, this.shadowRadius, t);
        prof.add('peds.skinnedActors', tp);
        if (d < 44) this.handLight(actor, p, r, t);
        skinned++;
      } else if (d <= cut) {
        tp = prof.begin();
        r.draw(p, t, d);
        prof.add('peds.imposters', tp);
      }

      if (p.dog && d < r.lod2) {
        r.drawDog(p.dog.x, p.dog.y, p.dog.z, p.dog.yaw, p.dog.phase, p.dog.size, p.dog.colour, d);
      }
    }
    tp = prof.begin();
    r.end();
    prof.add('peds.upload', tp);
    this.stats.drawn = this.ranked.length;
    this.stats.skinned = skinned;
    this.stats.instances = r.stats.instances;
    this.stats.triangles = r.stats.triangles;

    // Peds are the last simulation system to run a lateUpdate, so this is the
    // natural place to close the profiler's frame.
    prof.endFrame();
  }

  /** Phone screens and cigarette embers, pinned to the rig's hand bones. */
  private handLight(actor: CharacterActor, p: Ped, r: CrowdRenderer, t: number): void {
    if (p.pose !== 'phone' && p.pose !== 'smoke') return;
    const bones = actor.rig.bones;
    const right = p.seed % 2 === 0 || p.pose === 'smoke';
    const hand = bones[right ? BI.handR : BI.handL];
    if (!hand) return;
    hand.getWorldPosition(this._hand);
    if (p.pose === 'phone') {
      this._hand.y += 0.03;
      r.handLight(this._hand, p.yaw, 0.055, PHONE_GLOW, true);
    } else {
      // Embers brighten on the draw.
      this._glow.copy(CIG_GLOW).multiplyScalar(0.55 + 0.45 * Math.sin(t * 1.6 + p.seed));
      r.handLight(this._hand, p.yaw, 0.02, this._glow, false);
    }
  }

  private readonly _hand = new THREE.Vector3();
  private readonly _glow = new THREE.Color();

  dispose(): void {
    this.renderer?.dispose();
    this.peds.clear();
    this.list.length = 0;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function byDistance(a: { d: number }, b: { d: number }): number {
  return a.d - b.d;
}

const _c = new THREE.Color();

/**
 * Dress the imposter in the skinned actor's clothes, so promoting or demoting
 * a ped at 45 m does not change its colour.
 */
function copyWardrobe(a: Appearance, p: Ped): void {
  const lin = (hex: number, out: THREE.Color) => out.setHex(hex).convertSRGBToLinear();
  lin(a.colors.skin, p.app.skin);
  lin(a.colors.hair, p.app.hair);
  lin(a.outer !== 'none' ? a.colors.outer : a.colors.top, p.app.top);
  lin(a.colors.legs, p.app.legs);
  lin(a.colors.shoes, p.app.shoes);
  p.app.sleeve = a.shortSleeve ? p.app.skin : p.app.top;
  p.app.build = a.body === 'heavy' ? 1.16 : a.body === 'stocky' ? 1.08 : a.body === 'slim' ? 0.9 : 1.0;
  p.app.headwear = a.headwear !== 'none' ? 1 : a.hair === 'long' || a.hair === 'bun' ? 4 : 0;
  lin(a.headwear !== 'none' ? a.colors.accent : a.colors.hair, p.app.hatColor);
  p.app.vest = a.accessory === 'builderHarness'
    ? lin(a.colors.accent, _c.clone())
    : null;
  p.app.bag = a.accessory === 'backpack' ? 2 : a.accessory === 'satchel' ? 1 : 0;
  lin(a.colors.detail, p.app.bagColor);
  p.app.placard = null;
}
