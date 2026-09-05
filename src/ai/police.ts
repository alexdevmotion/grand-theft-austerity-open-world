/**
 * MINISTRY OF NATIONAL DE-ACCELERATION — pursuit, escalation and escape.
 *
 * Consumes the Crisis Star state machine in `gameplay/wanted.ts` and turns each
 * star into a different kind of pressure:
 *
 *   ★      inspectors notice you. Radio chatter, no cars. Heat decays if you
 *          behave.
 *   ★★     one patrol car, moderate commitment, and a checkpoint on the road
 *          ahead of you.
 *   ★★★    three units, sirens, aggressive driving, they coordinate rather
 *          than queue.
 *   ★★★★   four units plus roadblocks thrown across junctions in front of you,
 *          with spike strips.
 *   ★★★★★  six units, ramming and PIT manoeuvres, and the helicopter with its
 *          searchlight.
 *
 * The escape is the point. Every unit runs its own line of sight; when nobody
 * can see you the pursuit converges on your last known position and starts
 * sweeping outward from it, which gives a real, readable window to get away —
 * and the helicopter's searchlight lags behind you rather than being welded to
 * your roof, so even five stars can be broken.
 *
 * Heat is fed back through `WantedService.addHeat` for what this system
 * actually observes: speeding past a signalled junction (the Ministry's whole
 * reason for existing), collisions, and attacks on its own units.
 */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { CG, PhysicsWorld, groups } from '../physics/physics';
import { Rng } from '../core/rng';
import {
  Services,
  type CharacterHandle,
  type CityService,
  type VehicleClass,
  type VehicleHandle,
  type VehicleService,
  type WantedService,
} from '../core/services';
import { PursuitUnit, type Quarry, type UnitRole } from './police/pursuit';
import { Blockade, pickBlockadeNode } from './police/roadblock';
import { PoliceHelicopter } from './police/helicopter';
import { SensorField } from './traffic/sensors';
import type { ControllableVehicle } from './traffic/driver';

/* ------------------------------------------------------------------ */
/* Response packages                                                   */
/* ------------------------------------------------------------------ */

interface Response {
  cars: number;
  inspectors: number;
  blockades: number;
  spikes: boolean;
  heli: boolean;
  /** Fraction of units allowed to ram / PIT. */
  aggression: number;
  /** How far a unit can see you. */
  sight: number;
}

const RESPONSE: Response[] = [
  { cars: 0, inspectors: 0, blockades: 0, spikes: false, heli: false, aggression: 0, sight: 0 },
  { cars: 0, inspectors: 3, blockades: 0, spikes: false, heli: false, aggression: 0, sight: 60 },
  { cars: 1, inspectors: 2, blockades: 1, spikes: false, heli: false, aggression: 0, sight: 95 },
  { cars: 3, inspectors: 2, blockades: 1, spikes: false, heli: false, aggression: 0.25, sight: 115 },
  { cars: 4, inspectors: 2, blockades: 2, spikes: true, heli: false, aggression: 0.5, sight: 135 },
  { cars: 6, inspectors: 2, blockades: 3, spikes: true, heli: true, aggression: 0.72, sight: 165 },
];

const CHATTER: Record<number, string[]> = {
  1: [
    'Dispecerat: subiect semnalat depășind viteza regulamentară. Inspectorii verifică.',
    'Ministerul De-Accelerării: menține viteza sub limită. Suntem cu ochii pe tine.',
  ],
  2: [
    'Unitatea 4, ai un vehicul care refuză să încetinească. Interceptează.',
    'Filtru de viteză montat înainte. Nu accelera.',
  ],
  3: [
    'Toate unitățile — urmărire în desfășurare. Nu îl lăsați să prindă bulevardul.',
    'Dispecerat: viteză excesivă persistentă. Autorizăm angajare fermă.',
  ],
  4: [
    'Baraj rutier la intersecția următoare. Benzi cu ținte montate.',
    'Ministerul cere oprirea imediată a vehiculului. Repet: oprire imediată.',
  ],
  5: [
    'Elicopterul e în aer. Reflectorul pe subiect.',
    'Autorizăm manevre de imobilizare. Toate unitățile, închideți-l.',
  ],
};

/* ------------------------------------------------------------------ */
/* How wide the Ministry's search is — see `reportSearch`.             */
/* ------------------------------------------------------------------ */

/** Metres per second the reachable set grows once contact is broken. */
const SEARCH_SPREAD = 13;
/** Past this the search has failed; a bigger circle tells the player nothing. */
const SEARCH_MAX = 520;

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _prev = new THREE.Vector3();

export class PoliceSystem implements System {
  readonly name = 'police';
  readonly order = 140;

  private ctx!: GameContext;
  private phys: PhysicsWorld | null = null;
  private vehicles: VehicleService | null = null;
  private city: CityService | null = null;
  private wanted: WantedService | null = null;
  private rng = new Rng('ministry');
  private field = new SensorField();

  private units: PursuitUnit[] = [];
  private inspectors: CharacterHandle[] = [];
  private blockades: Blockade[] = [];
  private blockedNodes = new Set<number>();
  private heli: PoliceHelicopter | null = null;

  private stars = 0;
  private prevStars = 0;
  private spawnCooldown = 0;
  private blockadeCooldown = 0;
  private chatterCooldown = 0;
  private cameraHeatCooldown = 0;
  private inspectorsTried = false;

  private quarry: Quarry = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    speed: 0,
    visible: false,
    lastKnown: new THREE.Vector3(),
    lostFor: 999,
  };
  private quarryInit = false;
  /** Stars the quarry was last updated at — catches the 0 -> wanted edge. */
  private quarryStars = 0;

  /** Authoritative pursuer count, published via `WantedService.reportSearch`. */
  private _pursuers = 0;

  get pursuerCount(): number {
    return this._pursuers;
  }

  /* ------------------------------------------------------------------ */

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.phys = ctx.tryGet(Services.Physics) ?? null;

    ctx.events.on('vehicle:collision', (e) => this.onCollision(e.vehicleId, e.impulse, e.position));
    ctx.events.on('vehicle:destroyed', (e) => this.onDestroyed(e.vehicleId));
    ctx.events.on('ped:killed', (e) => {
      // Only the player's body count counts. Ambient traffic occasionally
      // clips a pedestrian and the Ministry is not about to blame you for it.
      const p = ctx.tryGet(Services.Player);
      const near = p ? (p.inVehicle ? p.inVehicle.position : p.position).distanceTo(e.position) : 999;
      if (near > 14) return;
      this.wanted?.addHeat(140, e.position);
      this.radio('Dispecerat: victimă la sol. Toate unitățile, prioritate maximă.');
    });
    ctx.events.on('instability:cleared', () => this.standDown());

    (window as unknown as { __GTA_POLICE__: unknown }).__GTA_POLICE__ = {
      stats: () => ({
        stars: this.stars,
        pursuers: this._pursuers,
        units: this.units.map((u) => ({
          id: u.id, kind: u.vehicle.kind, role: u.role, state: u.state,
          speed: +u.vehicle.speed.toFixed(1),
          dist: +u.position.distanceTo(this.quarry.position).toFixed(0),
        })),
        blockades: this.blockades.length,
        inspectors: this.inspectors.length,
        heli: !!this.heli,
        visible: this.quarry.visible,
        lostFor: +this.quarry.lostFor.toFixed(1),
        lastKnown: [this.quarry.lastKnown.x, this.quarry.lastKnown.z].map((n) => +n.toFixed(0)),
        // What we actually published to WantedService this tick — the map and
        // the minimap both draw from there, so this is the number to compare
        // a screenshot against.
        published: (() => {
          const w = this.wanted;
          const lk = w?.lastKnown ?? null;
          return {
            lastKnown: lk ? [+lk.x.toFixed(0), +lk.z.toFixed(0)] : null,
            searchRadius: +(w?.searchRadius ?? 0).toFixed(0),
            contact: w?.inContact ?? false,
            pursuers: w?.pursuerCount ?? 0,
          };
        })(),
      }),
      standDown: () => this.standDown(),
      /** Convenience for chase testing — drives the star machine directly. */
      setStars: (n: number) => ctx.tryGet(Services.Wanted)?.setStars(n),
      heat: (n: number) => ctx.tryGet(Services.Wanted)?.addHeat(n),
    };
  }

  /* ------------------------------------------------------------------ */

  fixedUpdate(dt: number, ctx: GameContext): void {
    this.wanted = ctx.tryGet(Services.Wanted) ?? null;
    this.city = ctx.tryGet(Services.City) ?? null;
    this.vehicles = ctx.tryGet(Services.Vehicles) ?? null;
    if (!this.wanted || !this.city || !this.vehicles) return;

    this.stars = this.wanted.stars;
    const plan = RESPONSE[Math.max(0, Math.min(5, this.stars))];

    this.updateQuarry(dt, ctx);
    this.buildField();

    if (this.stars !== this.prevStars) {
      if (this.stars > this.prevStars) this.radio(this.pick(CHATTER[this.stars] ?? []));
      if (this.stars === 0) this.standDown();
      this.prevStars = this.stars;
    }

    this.observeCrimes(dt, ctx);

    if (this.stars > 0) {
      this.maintainUnits(dt, plan);
      this.maintainInspectors(plan);
      this.maintainBlockades(dt, plan);
      this.maintainHelicopter(dt, plan);
    }

    for (const u of this.units) {
      if (u.vehicle.entryReserved) u.vehicle.setControls(0, 0, true);
      else u.update(dt, this.quarry, this.city, this.field, this.stars);
    }

    this.reportSearch();
    this.pushPanic(dt);
    this.chatter(dt);
  }

  update(dt: number): void {
    if (this.heli) {
      this.heli.update(dt, this.quarry.visible ? this.quarry.position : this.quarry.lastKnown,
        this.quarry.velocity, this.quarry.lostFor);
    }
  }

  /* ------------------------------------------------------------------ */
  /* the quarry                                                          */
  /* ------------------------------------------------------------------ */

  private updateQuarry(dt: number, ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    if (!player) return;
    const q = this.quarry;
    const p = player.inVehicle ? player.inVehicle.position : player.position;
    if (!this.quarryInit) {
      q.position.copy(p);
      q.lastKnown.copy(p);
      q.lostFor = 0;
      this.quarryInit = true;
    }

    /*
     * A CHASE STARTS FROM A SIGHTING, NOT FROM WHENEVER WE LAST TICKED.
     *
     * `lostFor` is only zeroed by the zero-star branch below, so if the world
     * was paused (the title screen holds it for as long as the menu is up) or
     * the pursuit system had simply never run with a player present, the first
     * star inherits a `lostFor` of 999 seconds. That used to be harmless —
     * only the helicopter's lag and the radio chatter read it. It is not
     * harmless now that `reportSearch` turns it into the cordon the map draws:
     * the very first star would open with a search circle covering the whole
     * of Bucharest.
     *
     * The star exists because the Ministry saw you do something. Seed the
     * belief from that: they know where you are, right now.
     */
    if (this.stars > 0 && this.quarryStars === 0) {
      q.lastKnown.copy(p);
      q.lostFor = 0;
      q.visible = true;
    }
    this.quarryStars = this.stars;
    _prev.copy(q.position);
    q.position.copy(p);
    _v.subVectors(q.position, _prev).divideScalar(Math.max(1e-4, dt));
    q.velocity.lerp(_v, Math.min(1, dt * 6));
    q.velocity.y = 0;
    q.speed = q.velocity.length();

    if (this.stars === 0) {
      q.visible = false;
      q.lastKnown.copy(p);
      q.lostFor = 0;
      return;
    }

    const plan = RESPONSE[Math.min(5, this.stars)];
    let seen = false;
    for (const u of this.units) {
      const d = u.position.distanceTo(q.position);
      if (d > plan.sight) continue;
      if (this.hasLineOfSight(u.position, q.position, 1.1)) { seen = true; break; }
    }
    if (!seen && this.heli) {
      // The helicopter sees you unless you are genuinely under something.
      seen = this.hasLineOfSight(this.heli.position, q.position, 0);
    }
    if (!seen && this.stars === 1) {
      // At one star nobody is chasing; inspectors keep loose tabs from the kerb.
      for (const insp of this.inspectors) {
        if (insp.position.distanceTo(q.position) < plan.sight) { seen = true; break; }
      }
    }

    q.visible = seen;
    if (seen) {
      q.lastKnown.copy(q.position);
      q.lostFor = 0;
    } else {
      q.lostFor += dt;
      // Dead reckoning for a moment after the break — they are not psychic, but
      // they do know which way you were pointing.
      if (q.lostFor < 1.2) q.lastKnown.addScaledVector(q.velocity, dt * 0.7);
    }
  }

  private hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3, fromHeight: number): boolean {
    if (!this.phys) return true;
    _v.set(from.x, from.y + fromHeight, from.z);
    _dir.set(to.x - _v.x, to.y + 0.9 - _v.y, to.z - _v.z);
    const dist = _dir.length();
    if (dist < 1) return true;
    _dir.divideScalar(dist);
    // Buildings only: a lamp post or a kerb must not break a sight line.
    const hit = this.phys.raycast(_v, _dir, dist - 0.6, groups(CG.VEHICLE, CG.STATIC));
    return !hit;
  }

  /* ------------------------------------------------------------------ */
  /* roster                                                              */
  /* ------------------------------------------------------------------ */

  private buildField(): void {
    this.field.begin();
    const player = this.ctx.tryGet(Services.Player);
    const pvId = player?.inVehicle?.id ?? '';
    for (const v of this.vehicles!.all) {
      if (v.position.distanceToSquared(this.quarry.position) > 320 * 320) continue;
      this.field.addVehicle(v, v.id === pvId);
    }
    if (player?.isOnFoot) {
      this.field.addPoint('player', player.position.x, player.position.z, 0.55, true);
    }
  }

  private maintainUnits(dt: number, plan: Response): void {
    // Retire wrecks and anything that has fallen hopelessly behind.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const far = u.position.distanceTo(this.quarry.position);
      if (u.vehicle.isWrecked && far > 90) { this.retire(i); continue; }
      if (far > 620) { this.retire(i); continue; }
      if (u.vehicle.occupants.length > 0 || u.vehicle.npcDriver === null) { this.retire(i); continue; }
    }
    // Shed units when the star level falls.
    while (this.units.length > plan.cars) {
      let worst = 0;
      let worstD = -1;
      for (let i = 0; i < this.units.length; i++) {
        const d = this.units[i].position.distanceTo(this.quarry.position);
        if (d > worstD) { worstD = d; worst = i; }
      }
      this.retire(worst);
    }

    this.spawnCooldown -= dt;
    if (this.units.length < plan.cars && this.spawnCooldown <= 0) {
      this.spawnCooldown = 1.6;
      this.spawnUnit();
    }

    // Roles: a pursuit that all does the same thing is a queue, not a pursuit.
    const aggressive = Math.round(this.units.length * plan.aggression);
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      let role: UnitRole;
      if (i === 0) role = 'pursue';
      else if (i <= aggressive) role = i % 2 === 0 ? 'pit' : 'ram';
      else if (i === this.units.length - 1 && this.units.length >= 4 && this.stars >= 4) role = 'block';
      else role = 'flank';
      u.role = role;
    }
    this._pursuers = this.units.length;
  }

  private retire(index: number): void {
    const u = this.units[index];
    if (!u) return;
    u.dispose();
    this.vehicles?.despawn(u.vehicle.id);
    this.units.splice(index, 1);
  }

  private spawnUnit(): void {
    const from = this.quarry.lastKnown;
    // Behind the player if we can, ahead of them at high stars.
    const wantAhead = this.stars >= 4 && this.rng.bool(0.4);
    const slot = this.roadSlotNear(from, 80, 190, wantAhead);
    if (!slot) return;

    const kind: VehicleClass = this.stars >= 4 && this.units.length >= 3 && this.rng.bool(0.34)
      ? 'van'
      : 'police';
    const v = this.vehicles!.spawn(kind, slot.pos, slot.heading, {
      faction: 'police',
      npcDriver: 'police',
      colorSeed: 1,
    }) as ControllableVehicle;
    v.setSiren?.(true);
    v.setHeadlights?.(1);
    const unit = new PursuitUnit(v, this.units.length);
    this.units.push(unit);
  }

  /** A clear point on the road graph in an annulus around `centre`. */
  private roadSlotNear(
    centre: THREE.Vector3,
    minDist: number,
    maxDist: number,
    ahead: boolean,
  ): { pos: THREE.Vector3; heading: number } | null {
    const city = this.city!;
    const nodes = city.roadNodes;
    if (!nodes.length) return null;
    const vel = this.quarry.velocity;
    const vlen = Math.hypot(vel.x, vel.z);
    const dirX = vlen > 2 ? vel.x / vlen : 0;
    const dirZ = vlen > 2 ? vel.z / vlen : 1;

    for (let attempt = 0; attempt < 70; attempt++) {
      const n = nodes[this.rng.int(0, nodes.length)];
      if (!n.links.length) continue;
      const dx = n.position.x - centre.x;
      const dz = n.position.z - centre.z;
      const d = Math.hypot(dx, dz);
      if (d < minDist || d > maxDist) continue;
      const facing = (dx * dirX + dz * dirZ) / Math.max(1e-3, d);
      if (ahead ? facing < 0.3 : facing > 0.45) continue;

      const link = nodes[n.links[this.rng.int(0, n.links.length)]];
      if (!link) continue;
      const lx = link.position.x - n.position.x;
      const lz = link.position.z - n.position.z;
      const ll = Math.hypot(lx, lz) || 1;
      const ux = lx / ll;
      const uz = lz / ll;
      // Sit in the near-side lane, a few metres up the link.
      const px = n.position.x + ux * 14 + uz * 2.6;
      const pz = n.position.z + uz * 14 - ux * 2.6;
      if (city.spatial.isBlocked(px, pz)) continue;

      let blocked = false;
      for (const other of this.vehicles!.all) {
        if (Math.abs(other.position.x - px) < 6 && Math.abs(other.position.z - pz) < 6) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const gh = city.spatial.groundHeight(px, pz);
      return {
        pos: new THREE.Vector3(px, Number.isFinite(gh) ? Math.max(0, gh) : 0, pz),
        heading: Math.atan2(ux, uz),
      };
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* inspectors on foot                                                  */
  /* ------------------------------------------------------------------ */

  private maintainInspectors(plan: Response): void {
    const peds = this.ctx.tryGet(Services.Peds);
    if (!peds || plan.inspectors === 0) return;
    // The crowd system may not be able to produce characters yet. Ask once; if
    // it refuses, fall back to radio-only presence rather than throwing on
    // every fixed step for the rest of the session.
    if (this.inspectorsTried) return;

    for (let i = this.inspectors.length - 1; i >= 0; i--) {
      const insp = this.inspectors[i];
      if (!insp.isAlive || insp.position.distanceTo(this.quarry.position) > 240) {
        peds.despawn(insp.id);
        this.inspectors.splice(i, 1);
      }
    }
    while (this.inspectors.length < plan.inspectors) {
      const slot = this.roadSlotNear(this.quarry.lastKnown, 26, 90, false);
      if (!slot) return;
      try {
        const c = peds.spawn('ministryAgent', slot.pos, slot.heading + Math.PI);
        this.inspectors.push(c);
      } catch {
        this.inspectorsTried = true;
        return;
      }
    }
    for (const insp of this.inspectors) {
      if (this.quarry.visible) insp.lookAt(this.quarry.position);
    }
  }

  /* ------------------------------------------------------------------ */
  /* roadblocks + spikes                                                 */
  /* ------------------------------------------------------------------ */

  private maintainBlockades(dt: number, plan: Response): void {
    const scene = this.ctx.scene;
    for (let i = this.blockades.length - 1; i >= 0; i--) {
      const b = this.blockades[i];
      b.age += dt;
      const d = b.position.distanceTo(this.quarry.position);
      // Once you are past it, or it has been standing for a long time, clear it.
      if (d > 330 || b.age > 90 || this.stars === 0) {
        this.blockedNodes.delete(b.node);
        b.dispose(scene, this.vehicles!);
        this.blockades.splice(i, 1);
        continue;
      }
      const pv = this.ctx.tryGet(Services.Player)?.inVehicle;
      if (pv && b.testSpikes(pv)) {
        pv.applyDamage(Math.max(60, pv.maxHealth * 0.22), 'police', pv.position.clone());
        this.ctx.tryGet(Services.Camera)?.shake(0.85, 0.7);
        this.ctx.events.emit('audio:oneShot', { id: 'spikes', position: pv.position.clone(), volume: 1 });
        this.toast('BENZI CU ȚINTE — cauciucuri compromise', 'bad');
      }
    }

    if (this.blockades.length >= plan.blockades) return;
    this.blockadeCooldown -= dt;
    if (this.blockadeCooldown > 0) return;
    this.blockadeCooldown = 6.5;
    if (!this.quarry.visible && this.quarry.lostFor > 6) return;

    const pick = pickBlockadeNode(
      this.city!, this.quarry.position, this.quarry.velocity,
      this.stars >= 4 ? 110 : 150, 260, this.blockedNodes,
    );
    if (!pick) return;
    this.blockedNodes.add(pick.node);
    const b = new Blockade(
      this.ctx.scene, this.vehicles!, this.city!,
      pick.node, pick.approachX, pick.approachZ,
      {
        vehicles: this.stars >= 4 ? 3 : this.stars >= 3 ? 2 : 1,
        spikes: plan.spikes,
        kind: this.stars >= 3 ? 'van' : 'police',
      },
    );
    this.blockades.push(b);
    this.radio(plan.spikes
      ? 'Baraj și benzi cu ținte montate în față. Opriți vehiculul.'
      : 'Filtru rutier instalat în față.');
  }

  /* ------------------------------------------------------------------ */
  /* helicopter                                                          */
  /* ------------------------------------------------------------------ */

  private maintainHelicopter(_dt: number, plan: Response): void {
    if (plan.heli && !this.heli) {
      this.heli = new PoliceHelicopter(this.ctx.scene);
      this.heli.position.set(
        this.quarry.position.x - 120,
        this.quarry.position.y + 90,
        this.quarry.position.z - 120,
      );
      this.radio('Elicopterul Ministerului e deasupra ta.');
    } else if (!plan.heli && this.heli) {
      this.heli.dispose(this.ctx.scene);
      this.heli = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* crimes we observe                                                   */
  /* ------------------------------------------------------------------ */

  private observeCrimes(dt: number, ctx: GameContext): void {
    const player = ctx.tryGet(Services.Player);
    const wanted = this.wanted!;
    if (!player) return;
    const veh = player.inVehicle;

    /* ---- speeding: the Ministry's founding grievance ---- */
    if (veh) {
      const speed = Math.abs(veh.speed);
      if (speed > 24) {
        // Signalled junctions are speed cameras. Blow through one and the
        // Ministry knows within seconds, whether or not anyone saw you.
        this.cameraHeatCooldown -= dt;
        if (this.cameraHeatCooldown <= 0) {
          const nodeId = this.city!.nearestNode(veh.position);
          const node = this.city!.roadNodes[nodeId];
          if (node && node.hasTrafficLight && node.position.distanceTo(veh.position) < 26) {
            this.cameraHeatCooldown = 4.5;
            wanted.addHeat(26 + (speed - 24) * 2.4, veh.position);
            if (this.stars === 0) this.toast('Radar Ministerial: viteză înregistrată', 'bad');
          }
        }
        // Being seen speeding by a live unit keeps the pot boiling.
        if (this.quarry.visible && this.stars > 0) {
          wanted.addHeat(dt * (6 + (speed - 24) * 0.9), veh.position);
        }
      }
    }

    /* ---- driving at officers on foot ---- */
    if (veh && Math.abs(veh.speed) > 8) {
      for (const insp of this.inspectors) {
        if (insp.position.distanceTo(veh.position) < 3.2) {
          wanted.addHeat(120, veh.position);
          insp.ragdoll();
        }
      }
    }
  }

  private onCollision(vehicleId: string, impulse: number, position: THREE.Vector3): void {
    const wanted = this.ctx.tryGet(Services.Wanted);
    if (!wanted) return;
    const player = this.ctx.tryGet(Services.Player);
    const pv = player?.inVehicle;

    const isUnit = this.units.some((u) => u.vehicle.id === vehicleId);
    const isBlock = this.blockades.some((b) => b.vehicles.some((v) => v.id === vehicleId));
    if (isUnit || isBlock) {
      // Someone hit a Ministry vehicle. If the player is anywhere near, it was
      // the player.
      if (pv && pv.position.distanceTo(position) < 12) {
        wanted.addHeat(Math.min(150, 40 + impulse / 4000), position);
        this.radio('Unitate lovită! Repet, unitate lovită.');
      }
      return;
    }
    if (!pv || pv.id !== vehicleId) return;
    // The player crashed into something. Only counts once anyone is watching.
    const witnessed = this.quarry.visible || this.stars > 0 || this.nearInspector(position, 45);
    if (!witnessed) return;
    wanted.addHeat(Math.min(90, 14 + impulse / 9000), position);
  }

  private onDestroyed(vehicleId: string): void {
    if (this.units.some((u) => u.vehicle.id === vehicleId)) {
      this.wanted?.addHeat(180);
      this.radio('Unitate scoasă din uz. Escaladăm răspunsul.');
    }
  }

  private nearInspector(p: THREE.Vector3, radius: number): boolean {
    for (const insp of this.inspectors) if (insp.position.distanceTo(p) < radius) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* plumbing                                                            */
  /* ------------------------------------------------------------------ */

  /** Push ambient traffic out of the way of a live pursuit. */
  private pushPanic(dt: number): void {
    if (this.stars < 2) return;
    this.panicTick -= dt;
    if (this.panicTick > 0) return;
    this.panicTick = 1.0;
    const traffic = this.ctx.tryGet(Services.Traffic);
    traffic?.panic(this.quarry.position, 60 + this.stars * 12, 6);
  }
  private panicTick = 0;

  /**
   * PUBLISH WHAT THE MINISTRY ACTUALLY KNOWS.
   *
   * Pursuer count, the last sighting and how wide the cordon has grown all live
   * here — sight lines are resolved against real colliders in `updateQuarry`,
   * and nothing outside this file can recompute them. `WantedService.reportSearch`
   * is the seam; this used to be a reflective write into the wanted system's
   * private `_pursuers` because the contract was read-only, and the map had to
   * INFER the search circle from pursuer-count transitions, which made it
   * plausible fiction rather than the Ministry's belief.
   *
   * THE RADIUS IS A REACHABLE SET, not a decoration. With eyes on you it is the
   * sighting range of the units that can see you — they know where you are, the
   * circle is tight and centred on you. Once contact breaks it grows from the
   * last sighting at `SEARCH_SPREAD` m/s, which is roughly how fast a car can
   * put distance between itself and a cordon, so the ring on the map is the
   * honest answer to "how much of the city could I be in by now". It is capped:
   * past `SEARCH_MAX` the search has failed and a circle covering the whole map
   * tells the player nothing.
   */
  private reportSearch(): void {
    const w = this.wanted;
    if (!w) return;
    const q = this.quarry;
    const looking = this.stars > 0;
    const sight = RESPONSE[Math.max(0, Math.min(5, this.stars))].sight;
    const radius = !looking
      ? 0
      : q.visible
        ? sight
        : Math.min(SEARCH_MAX, sight + q.lostFor * SEARCH_SPREAD);
    w.reportSearch({
      pursuers: this._pursuers,
      lastKnown: looking ? q.lastKnown : null,
      radius,
      contact: looking && q.visible,
    });
  }

  private standDown(): void {
    for (let i = this.units.length - 1; i >= 0; i--) this.retire(i);
    const peds = this.ctx.tryGet(Services.Peds);
    for (const insp of this.inspectors) peds?.despawn(insp.id);
    this.inspectors.length = 0;
    this.inspectorsTried = false;
    for (const b of this.blockades) b.dispose(this.ctx.scene, this.vehicles!);
    this.blockades.length = 0;
    this.blockedNodes.clear();
    if (this.heli) { this.heli.dispose(this.ctx.scene); this.heli = null; }
    this._pursuers = 0;
    this.reportSearch();
  }

  private chatter(dt: number): void {
    if (this.stars === 0) return;
    this.chatterCooldown -= dt;
    if (this.chatterCooldown > 0) return;
    this.chatterCooldown = 9 + this.rng.next() * 8;
    if (!this.quarry.visible && this.quarry.lostFor > 3) {
      this.radio(this.pick([
        'Am pierdut contactul vizual. Ultima poziție cunoscută — verificați străzile laterale.',
        'Nu îl mai vedem. Extindeți căutarea de la ultima poziție.',
        'Subiect dispărut din raza vizuală. Menținem perimetrul.',
      ]));
    } else {
      this.radio(this.pick(CHATTER[Math.min(5, this.stars)] ?? []));
    }
  }

  private pick(list: string[]): string {
    if (!list.length) return '';
    return list[this.rng.int(0, list.length)];
  }

  private radio(text: string): void {
    if (!text) return;
    // ONE widget, not two. This also called HudService.subtitle, so every
    // dispatch line was drawn twice and stacked — once in the radio strap and
    // once in the subtitle line. `radio:line` is the channel the HUD's radio
    // strap listens on, and src/audio/audioSystem.ts already notes that police
    // dispatch writes its own subtitle.
    this.ctx.events.emit('radio:line', { text });
  }

  private toast(text: string, kind: 'info' | 'good' | 'bad'): void {
    this.ctx.tryGet(Services.Hud)?.toast(text, kind, 2600);
  }

  dispose(): void {
    this.standDown();
  }
}

/** Re-exported so the type is reachable from the debug surface. */
export type { VehicleHandle };
