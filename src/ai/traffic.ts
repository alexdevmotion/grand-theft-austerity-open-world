/**
 * AMBIENT TRAFFIC.
 *
 * Streams civilian vehicles in and out of a ring around the camera, routes them
 * over a lane network derived from the city road graph, and runs them through
 * the shared driver in `traffic/driver.ts`.
 *
 * The shape of a frame is what matters: from any street you should see cars
 * moving in both directions, queueing at a red, filtering past something
 * double-parked, and getting out of the way when the Ministry turns up. The
 * mix is deliberately weighted toward tired hatchbacks and Dacias, with vans
 * and trucks on the industrial edges and buses and trams down the boulevards.
 *
 *   traffic/roadGraph.ts   lane network derived from CityService
 *   traffic/driver.ts      steering + speed control, shared with the police
 *   traffic/agent.ts       one civilian driver's behaviours
 *   traffic/junctions.ts   signal phases and give-way reservations
 *   traffic/sensors.ts     per-step spatial index over every vehicle
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Rng } from '../core/rng';
import {
  Services,
  type DistrictKind,
  type TrafficService,
  type VehicleClass,
  type VehicleHandle,
  type VehicleService,
} from '../core/services';
import { QUALITY, detectQuality, type Quality } from '../render/renderer';
import { CG, groups, type PhysicsWorld } from '../physics/physics';
import { TRAM_LANE, TrafficGraph } from './traffic/roadGraph';
import { JunctionControl } from './traffic/junctions';
import { SensorField } from './traffic/sensors';
import { TrafficAgent } from './traffic/agent';
import type { ControllableVehicle } from './traffic/driver';

/* ------------------------------------------------------------------ */
/* Fleet mix                                                           */
/* ------------------------------------------------------------------ */

/**
 * Bucharest traffic is overwhelmingly small, old and tired. The Dacia is the
 * hero car so it is over-represented on purpose; heavy goods live on the
 * industrial edge; buses only make sense on a road wide enough for them.
 */
const MIX: Array<{ kind: VehicleClass; base: number; minRank: number; district?: Partial<Record<DistrictKind, number>> }> = [
  { kind: 'dacia', base: 3.4, minRank: 0, district: { cartier: 1.4, centruVechi: 1.25, industrial: 1.1, glassCorporate: 0.7 } },
  { kind: 'hatch', base: 3.0, minRank: 0, district: { cartier: 1.25, glassCorporate: 0.9 } },
  { kind: 'sedan', base: 2.0, minRank: 0, district: { glassCorporate: 1.9, guvern: 1.8, cartier: 0.7 } },
  { kind: 'van', base: 1.15, minRank: 0, district: { industrial: 2.6, centruVechi: 1.4, guvern: 0.5 } },
  { kind: 'truck', base: 0.45, minRank: 1, district: { industrial: 3.4, bulevard: 1.2, glassCorporate: 0.35, guvern: 0.3, parc: 0.2 } },
  { kind: 'bus', base: 0.40, minRank: 1, district: { bulevard: 1.7, guvern: 1.3, cartier: 1.2, industrial: 0.5 } },
];

const MAX_TRAMS = 3;

/* ------------------------------------------------------------------ */

interface Slot {
  agent: TrafficAgent;
  vehicle: VehicleHandle;
  distance: number;
}

export class TrafficSystem implements System, TrafficService {
  readonly name = 'traffic';
  readonly order = 130;

  density = 1;

  private ctx!: GameContext;
  private vehicles: VehicleService | null = null;
  private phys: PhysicsWorld | null = null;
  private graph: TrafficGraph | null = null;
  private junctions: JunctionControl | null = null;
  private field = new SensorField();
  private slots: Slot[] = [];
  private byId = new Map<string, Slot>();
  private rng = new Rng('traffic');

  private maxTraffic = 40;
  /** Live ceiling — the governor moves this between a floor and maxTraffic. */
  private budget = 40;
  private budgetLocked = false;
  private warmup = 0;
  private spawnCooldown = 0;
  private tramCount = 0;
  private hornEvents = 0;
  /** Citywide horn throttle. A street full of drivers all leaning on the horn
   *  at once stops reading as frustration and starts reading as a bug. */
  private hornGate = 0;

  private readonly focus = new THREE.Vector3();
  private readonly lastFocus = new THREE.Vector3();
  private readonly camForward = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private edgeScratch: number[] = [];
  private edgeWeights: number[] = [];
  /** Seconds of unrestricted spawning after a camera cut. */
  private warpRefill = 0;
  /** Cosine of the camera's horizontal half-FOV — the real "on screen" test. */
  private cosHalfFov = 0.75;

  /** Global panic, set by the police during a chase. */
  private panicCentre = new THREE.Vector3();
  private panicRadius = 0;
  private panicTimer = 0;

  get activeCount(): number {
    return this.slots.length;
  }

  /* ------------------------------------------------------------------ */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Traffic, this);

    const quality: Quality =
      ctx.tryGet(Services.Render)?.quality ??
      ((new URLSearchParams(location.search).get('q') as Quality | null) ?? detectQuality());
    this.maxTraffic = QUALITY[quality].maxTraffic;
    this.budget = this.maxTraffic;

    const city = ctx.tryGet(Services.City);
    if (city) {
      this.graph = new TrafficGraph(city);
      this.junctions = new JunctionControl(city.roadNodes);
      console.info(`[traffic] lane graph: ${this.graph.edges.length} directed edges, budget ${this.maxTraffic}`);
    } else {
      console.warn('[traffic] no CityService — ambient traffic disabled');
    }
    this.vehicles = ctx.tryGet(Services.Vehicles) ?? null;
    this.phys = ctx.tryGet(Services.Physics) ?? null;

    (window as unknown as { __GTA_TRAFFIC__: unknown }).__GTA_TRAFFIC__ = {
      stats: () => ({
        active: this.slots.length,
        budget: this.budget,
        max: this.maxTraffic,
        density: this.density,
        trams: this.tramCount,
        claims: this.junctions?.activeClaims ?? 0,
        edges: this.graph?.edges.length ?? 0,
        moving: this.slots.filter((s) => Math.abs(s.vehicle.speed) > 1.2).length,
        panicking: this.slots.filter((s) => s.agent.mood !== 'cruise').length,
        horns: this.hornEvents,
        stalled: this.stallBreakdown(),
      }),
      /**
       * Pin the live ceiling and switch the frame-rate governor off, so an A/B
       * measurement is not quietly undone by the governor refilling the street.
       */
      setBudget: (n: number) => {
        this.budget = Math.max(0, Math.min(this.maxTraffic, n | 0));
        this.budgetLocked = true;
      },
      autoBudget: () => { this.budgetLocked = false; },
      setDensity: (d: number) => { this.density = Math.max(0, Math.min(2, d)); },
      clear: () => { for (const s of [...this.slots]) this.remove(s, true); },
      list: () => this.slots.map((s) => ({
        id: s.agent.id, kind: s.vehicle.kind, mood: s.agent.mood,
        speed: +s.vehicle.speed.toFixed(1),
        target: +s.agent.lastTargetSpeed.toFixed(1),
        lane: s.agent.lane, edge: s.agent.edge, why: s.agent.stopReason,
        dist: +s.distance.toFixed(0),
      })),
      panic: (seconds = 8) => this.panic(this.focus.clone(), 140, seconds),
    };
  }

  /* ------------------------------------------------------------------ */
  /* TrafficService                                                      */
  /* ------------------------------------------------------------------ */

  panic(centre: THREE.Vector3, radius: number, seconds: number): void {
    this.panicCentre.copy(centre);
    this.panicRadius = radius;
    this.panicTimer = Math.max(this.panicTimer, seconds);
    const r2 = radius * radius;
    for (const s of this.slots) {
      if (s.vehicle.position.distanceToSquared(centre) < r2) {
        s.agent.panicTime = Math.max(s.agent.panicTime, seconds);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* frame                                                               */
  /* ------------------------------------------------------------------ */

  fixedUpdate(dt: number, ctx: GameContext): void {
    if (!this.graph || !this.junctions) return;
    if (!this.vehicles) {
      this.vehicles = ctx.tryGet(Services.Vehicles) ?? null;
      if (!this.vehicles) return;
    }

    ctx.camera.getWorldPosition(this.focus);
    ctx.camera.getWorldDirection(this.camForward);
    // Only the ground-plane component matters for "is this spawn on screen".
    this.camForward.y = 0;
    if (this.camForward.lengthSq() > 1e-6) this.camForward.normalize();
    // Horizontal half-FOV from the vertical FOV and the current aspect.
    const vHalf = THREE.MathUtils.degToRad(ctx.camera.fov) * 0.5;
    const hHalf = Math.atan(Math.tan(vHalf) * ctx.camera.aspect);
    this.cosHalfFov = Math.cos(Math.min(1.35, hHalf + 0.12));
    this.junctions.update(dt);

    if (this.panicTimer > 0) {
      this.panicTimer -= dt;
      // Keep re-arming vehicles that drive into the panic zone mid-chase.
      const r2 = this.panicRadius * this.panicRadius;
      for (const s of this.slots) {
        if (s.vehicle.position.distanceToSquared(this.panicCentre) < r2) {
          s.agent.panicTime = Math.max(s.agent.panicTime, 2.5);
        }
      }
    }

    this.buildField(ctx);
    this.prune(ctx);

    // Sensing pass: everyone bids for the junctions they are approaching before
    // anyone acts, so a step's give-way decisions are mutually consistent.
    for (const s of this.slots) s.agent.bid(this.junctions);

    this.hornGate = Math.max(0, this.hornGate - dt);
    const horn = {
      horn: (x: number, z: number) => {
        if (this.hornGate > 0) return;
        // Only what the camera could plausibly hear.
        const d2 = (x - this.focus.x) ** 2 + (z - this.focus.z) ** 2;
        if (d2 > 130 * 130) return;
        this.hornGate = 1.4;
        this.hornEvents++;
        _hornAt.set(x, 1.1, z);
        this.ctx.events.emit('audio:oneShot', { id: 'horn', position: _hornAt.clone(), volume: 0.7 });
      },
    };
    for (const s of this.slots) s.agent.update(dt, this.field, this.junctions, horn);

    // A camera cut (debug framing, respawn, a mission jump) invalidates every
    // "do not appear on screen" rule — the whole frame just changed anyway, so
    // refill the new location immediately instead of trickling in behind the
    // player over the next ten seconds.
    const jump = this.lastFocus.distanceToSquared(this.focus);
    this.warpRefill = Math.max(0, this.warpRefill - dt);
    if (jump > 60 * 60) this.warpRefill = 1.2;
    this.lastFocus.copy(this.focus);

    this.spawnCooldown -= dt;
    if (this.spawnCooldown <= 0) {
      this.spawnCooldown = this.warpRefill > 0 ? 0.02 : 0.2;
      const want = Math.round(Math.min(this.budget, this.maxTraffic * this.density));
      const deficit = want - this.slots.length;
      // Fill fast when the street is empty, trickle when it is nearly full.
      const burst = this.warpRefill > 0 ? 8 : deficit > want * 0.4 ? 4 : 2;
      let attempts = 0;
      while (this.slots.length < want && attempts++ < burst) {
        if (!this.trySpawn()) break;
      }
    }
  }

  update(dt: number, ctx: GameContext): void {
    // The governor keeps the street full on hardware that can take it and thins
    // it out rather than dropping frames on hardware that cannot. Sixty frames
    // is the contract; traffic density is the first thing that gives.
    if (this.budgetLocked) return;
    // Ignore the first few seconds: shader compilation and the first shadow
    // update tank the frame rate, and governing on that empties the street.
    this.warmup += dt;
    if (this.warmup < 6) return;
    const fps = ctx.tryGet(Services.Render)?.fps ?? 60;
    if (fps < 1) return;
    const floor = Math.max(14, Math.round(this.maxTraffic * 0.45));
    // Sixty frames is the contract, so the target is set just under it and
    // traffic density is the first thing that gives.
    if (fps < 56) {
      this.budget = Math.max(floor, this.budget - dt * (3 + (56 - fps) * 1.2));
    } else if (fps > 58.5 && this.budget < this.maxTraffic) {
      this.budget = Math.min(this.maxTraffic, this.budget + dt * 5);
    }
  }

  /* ------------------------------------------------------------------ */

  private buildField(ctx: GameContext): void {
    this.field.begin();
    const player = ctx.tryGet(Services.Player);
    const playerVehicleId = player?.inVehicle?.id ?? '';
    for (const v of this.vehicles!.all) {
      this.field.addVehicle(v, v.id === playerVehicleId);
    }
    if (player && player.isOnFoot) {
      this.field.addPoint('player', player.position.x, player.position.z, 0.55, true);
    }
    // Pedestrians are obstacles too, once the crowd system starts producing any.
    const peds = ctx.tryGet(Services.Peds);
    if (peds) {
      for (const p of peds.all) {
        if (p.position.distanceToSquared(this.focus) > 160 * 160) continue;
        this.field.addPoint(p.id, p.position.x, p.position.z, 0.45, false);
      }
    }
  }

  private prune(ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    const playerVehicleId = player?.inVehicle?.id ?? '';
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i];
      const v = s.vehicle;
      s.distance = v.position.distanceTo(this.focus);

      // The player can steal an ambient car — hand it over and forget it.
      if (v.id === playerVehicleId || v.occupants.length > 0) {
        this.release(s);
        continue;
      }
      if (s.agent.retire && s.distance > 60) { this.remove(s, true); continue; }
      if (s.distance > 340) { this.remove(s, true); continue; }
      if (v.isWrecked && s.distance > 120) { this.remove(s, true); continue; }
      // A wreck blocking a junction in front of the player stays; one that has
      // been sitting far away for a while does not.
      if (s.agent.age > 300 && s.distance > 220) { this.remove(s, true); continue; }
    }
  }

  /** Stop driving a vehicle but leave it in the world. */
  private release(s: Slot): void {
    s.agent.releaseAll(this.junctions!);
    const i = this.slots.indexOf(s);
    if (i >= 0) this.slots.splice(i, 1);
    this.byId.delete(s.agent.id);
    if (s.vehicle.kind === 'tram') this.tramCount = Math.max(0, this.tramCount - 1);
  }

  private remove(s: Slot, despawn: boolean): void {
    this.release(s);
    if (despawn) this.vehicles?.despawn(s.vehicle.id);
  }

  /* ------------------------------------------------------------------ */
  /* streaming spawn                                                     */
  /* ------------------------------------------------------------------ */

  private trySpawn(): boolean {
    const graph = this.graph!;
    const city = this.ctx.tryGet(Services.City);
    const player = this.ctx.tryGet(Services.Player);
    if (!city || !this.vehicles) return false;

    const candidates = graph.edgesNear(this.focus.x, this.focus.z, 230, this.edgeScratch);
    if (!candidates.length) return false;

    // Weight by road class: a boulevard should carry several times the traffic
    // of a back street, and the boulevards are what the camera actually sees.
    const w = this.edgeWeights;
    w.length = 0;
    for (const ei of candidates) {
      const e = graph.edges[ei];
      w.push(e.rank === 2 ? 6.0 : e.rank === 1 ? 2.8 : 1);
    }

    for (let attempt = 0; attempt < 16; attempt++) {
      const edge = graph.edges[this.rng.weighted(candidates, w)];
      if (!edge || edge.length < 18) continue;

      const wantTram = this.tramCount < MAX_TRAMS && edge.tram && this.rng.bool(0.10);
      const lane = wantTram ? TRAM_LANE : this.rng.int(0, edge.lanes);
      const t = this.rng.range(0.1, 0.9);
      graph.lanePoint(edge, lane, t, this.probe);

      const d = Math.hypot(this.probe.x - this.focus.x, this.probe.z - this.focus.z);
      if (d < 34 || d > 195) continue;

      if (this.warpRefill <= 0) {
        const toX = (this.probe.x - this.focus.x) / d;
        const toZ = (this.probe.z - this.focus.z) / d;
        const facing = toX * this.camForward.x + toZ * this.camForward.z;
        const onScreen = facing > this.cosHalfFov;

        // Traffic that appears in front of you is the single most obvious tell
        // that a city is fake, so a spawn inside the frustum has to earn its
        // place: either a building is between it and the camera, or it is far
        // enough down the road to be buried in aerial haze.
        if (onScreen && d < 110 && !this.occluded(this.probe)) continue;
        if (facing > 0.2 && d < 44) continue;

        // Anything seeded ahead should be COMING TOWARD us. Without this the
        // near foreground is permanently starved: everything spawned up the
        // road drives away from the camera and never enters the shot.
        if (facing > 0.3 && edge.ux * this.camForward.x + edge.uz * this.camForward.z > 0.2) {
          if (this.rng.bool(0.82)) continue;
        }
      }

      // Never on top of the player.
      if (player && player.position.distanceTo(this.probe) < 24) continue;

      // Never on top of anything else.
      let blocked = false;
      this.field.forEachNear(this.probe.x, this.probe.z, 14, (o) => {
        if (blocked) return;
        const dx = o.x - this.probe.x;
        const dz = o.z - this.probe.z;
        if (dx * dx + dz * dz < 121) blocked = true;
      });
      if (blocked) continue;

      const kind = wantTram ? 'tram' : this.pickKind(city.districtAt(this.probe.x, this.probe.z), edge.rank);
      if (!kind) continue;

      const heading = Math.atan2(edge.ux, edge.uz);
      const gh = city.spatial.groundHeight(this.probe.x, this.probe.z);
      this.probe.y = Number.isFinite(gh) ? Math.max(0, gh) : 0;

      const handle = this.vehicles.spawn(kind, this.probe, heading, {
        colorSeed: this.rng.int(1, 4096),
        faction: 'civilian',
      }) as ControllableVehicle;
      handle.setIndicator?.(0);

      const agent = new TrafficAgent(handle, graph, edge.index, lane, this.rng.fork(handle.id));
      const slot: Slot = { agent, vehicle: handle, distance: d };
      this.slots.push(slot);
      this.byId.set(agent.id, slot);
      if (kind === 'tram') this.tramCount++;
      if (this.panicTimer > 0 && this.probe.distanceTo(this.panicCentre) < this.panicRadius) {
        agent.panicTime = this.panicTimer;
      }
      return true;
    }
    return false;
  }

  /** Why the stationary part of the fleet is stationary. */
  private stallBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.slots) {
      if (Math.abs(s.vehicle.speed) > 1.2) continue;
      out[s.agent.stopReason] = (out[s.agent.stopReason] ?? 0) + 1;
    }
    return out;
  }

  /** True when a building stands between the camera and this spawn point. */
  private occluded(p: THREE.Vector3): boolean {
    if (!this.phys) return false;
    _ray.set(p.x - this.focus.x, 1.2 - this.focus.y, p.z - this.focus.z);
    const dist = _ray.length();
    if (dist < 2) return false;
    _ray.divideScalar(dist);
    // Buildings only — a lamp post is not cover.
    return !!this.phys.raycast(this.focus, _ray, dist - 1.5, groups(CG.VEHICLE, CG.STATIC));
  }

  private pickKind(district: DistrictKind, rank: number): VehicleClass | null {
    const kinds: VehicleClass[] = [];
    const weights: number[] = [];
    for (const m of MIX) {
      if (rank < m.minRank) continue;
      let w = m.base * (m.district?.[district] ?? 1);
      // Buses and trucks need room; keep them off the narrowest streets.
      if ((m.kind === 'bus' || m.kind === 'truck') && rank < 1) continue;
      if (w <= 0) continue;
      kinds.push(m.kind);
      weights.push(w);
    }
    if (!kinds.length) return null;
    return this.rng.weighted(kinds, weights);
  }

  dispose(): void {
    for (const s of [...this.slots]) this.remove(s, true);
  }
}

const _ray = new THREE.Vector3();
const _hornAt = new THREE.Vector3();
