/**
 * One Ministry of National De-Acceleration pursuit unit.
 *
 * A pursuit has to be competent and beatable at the same time, so the unit is
 * built out of behaviours that each have a visible failure mode:
 *
 *   APPROACH  route over the city graph toward the last known position. Fast,
 *             but it is following the road network, so a player who turns off
 *             the boulevard buys real distance.
 *   ENGAGE    direct interception with a lead, and a per-unit tactical slot so
 *             four cars arrive spread across the carriageway rather than
 *             nose-to-tail. Slots are what make three cars look like a team.
 *   RAM/PIT   aim at the quarry's rear quarter and stay on the throttle. Nasty
 *             at five stars, and it is exactly the behaviour that makes them
 *             overshoot when the player brakes.
 *   BLOCK     get ahead, turn across the road, stop.
 *   SEARCH    line of sight is gone: converge on the last known position, then
 *             sweep outward. This is the window the player escapes through.
 */

import * as THREE from 'three';
import { Driver, approachSpeed, type ControllableVehicle } from '../traffic/driver';
import { Polyline } from '../traffic/polyline';
import { findLead, type SensorField } from '../traffic/sensors';
import type { CityService } from '../../core/services';

export type UnitRole = 'pursue' | 'flank' | 'ram' | 'pit' | 'block';
export type UnitState = 'approach' | 'engage' | 'search' | 'blocking';

export interface Quarry {
  /** Live position, only valid while `visible`. */
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
  visible: boolean;
  lastKnown: THREE.Vector3;
  /** Seconds since the player was last seen by anybody. */
  lostFor: number;
}

const _v = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _pts: THREE.Vector3[] = [];
const _road = new THREE.Vector3();

export class PursuitUnit {
  readonly driver: Driver;
  readonly route = new Polyline();
  state: UnitState = 'approach';
  role: UnitRole = 'pursue';
  /** Lateral slot in the pursuit formation, metres. */
  slot = 0;
  /** Seconds until the route is recomputed. */
  private repath = 0;
  private routeGoal = new THREE.Vector3(NaN, 0, NaN);
  /** Where this unit is currently sweeping during a search. */
  private searchPoint = new THREE.Vector3();
  private searchTimer = 0;
  age = 0;
  /** Seconds this unit has personally had eyes on the player. */
  sightTime = 0;
  private sirenOn = false;

  constructor(readonly vehicle: ControllableVehicle, readonly index: number) {
    this.driver = new Driver(vehicle);
    this.slot = index % 2 === 0 ? -2.6 - index * 0.9 : 2.6 + index * 0.9;
  }

  get id(): string {
    return this.vehicle.id;
  }

  get position(): THREE.Vector3 {
    return this.vehicle.position;
  }

  /* ------------------------------------------------------------------ */

  private planRoute(city: CityService, to: THREE.Vector3): void {
    const from = city.nearestNode(this.vehicle.position);
    const goal = city.nearestNode(to);
    if (from < 0 || goal < 0) return;
    const path = city.findPath(from, goal);
    _pts.length = 0;
    _pts.push(this.vehicle.position.clone().setY(0));
    for (const id of path) {
      const n = city.roadNodes[id];
      if (n) _pts.push(n.position.clone().setY(0));
    }
    _pts.push(to.clone().setY(0));
    // Offset the interior of the route to the right so units do not drive down
    // the exact centreline of every street in the city.
    for (let i = 1; i < _pts.length - 1; i++) {
      const a = _pts[i];
      const b = _pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) continue;
      a.x += (dz / l) * 2.4;
      a.z += (-dx / l) * 2.4;
    }
    this.route.set(_pts);
    this.routeGoal.copy(to);
  }

  /* ------------------------------------------------------------------ */

  update(
    dt: number,
    quarry: Quarry,
    city: CityService,
    field: SensorField,
    stars: number,
  ): void {
    this.age += dt;
    this.driver.sense(dt);
    const v = this.vehicle;

    if (v.isWrecked) {
      v.setControls(0, 0, true);
      return;
    }
    if (!this.sirenOn) {
      this.sirenOn = true;
      v.setSiren?.(true);
      v.setHeadlights?.(1);
    }

    const px = v.position.x;
    const pz = v.position.z;
    const speed = v.speed;
    const toQuarry = _v.subVectors(quarry.position, v.position);
    const dist = Math.hypot(toQuarry.x, toQuarry.z);

    if (quarry.visible) this.sightTime += dt;
    else this.sightTime = 0;

    /* ---- state ---- */
    if (this.role === 'block' && dist < 200) this.state = 'blocking';
    else if (!quarry.visible && quarry.lostFor > 2.2) this.state = 'search';
    // Interception is a straight line at the target, so it is only safe with
    // eyes on: without that the unit would drive through the building the
    // quarry just disappeared behind.
    else if (dist < 70 && quarry.visible) this.state = 'engage';
    else this.state = 'approach';

    /* ---- top speed by star level: beatable at two, terrifying at five ---- */
    const chaseSpeed = [16, 20, 25, 30, 34, 38][Math.max(0, Math.min(5, stars))];

    let targetSpeed = chaseSpeed;
    let aimX: number;
    let aimZ: number;
    let pathHeading: number | null = null;
    let crossTrack: number | undefined;

    if (this.state === 'engage') {
      // Intercept: aim where the quarry will be, offset into our tactical slot.
      const lead = Math.min(2.2, dist / Math.max(6, chaseSpeed));
      _aim.copy(quarry.position).addScaledVector(quarry.velocity, lead);
      const rightX = quarry.velocity.z;
      const rightZ = -quarry.velocity.x;
      const rl = Math.hypot(rightX, rightZ) || 1;
      if (this.role === 'ram' || this.role === 'pit') {
        // Rear quarter for a PIT, dead centre for a ram.
        const back = this.role === 'pit' ? -2.4 : -0.4;
        const side = this.role === 'pit' ? (this.index % 2 ? 1.3 : -1.3) : 0;
        const ql = Math.max(1e-3, quarry.speed);
        _aim.x += (quarry.velocity.x / ql) * back + (rightX / rl) * side;
        _aim.z += (quarry.velocity.z / ql) * back + (rightZ / rl) * side;
        targetSpeed = chaseSpeed + 4;
      } else {
        const fade = THREE.MathUtils.clamp((dist - 8) / 22, 0, 1);
        _aim.x += (rightX / rl) * this.slot * fade;
        _aim.z += (rightZ / rl) * this.slot * fade;
        // Sit off the quarry's shoulder rather than climbing into its boot.
        if (dist < 14 && this.role !== 'pursue') targetSpeed = Math.min(targetSpeed, quarry.speed + 2);
      }
      aimX = _aim.x;
      aimZ = _aim.z;
      this.repath = 0;
    } else if (this.state === 'blocking') {
      // Get across the road ahead of the quarry, then stand on the brakes.
      _aim.copy(quarry.position).addScaledVector(quarry.velocity, 3.4);
      if (city.spatial.snapToRoad(_aim, _road) && _road.lengthSq() > 0) _aim.copy(_road);
      aimX = _aim.x;
      aimZ = _aim.z;
      const d = Math.hypot(aimX - px, aimZ - pz);
      targetSpeed = d < 9 ? 0 : Math.min(chaseSpeed, approachSpeed(0, d - 8, this.driver.tuning.brake));
      if (d < 9) {
        // Slew across the carriageway.
        this.vehicle.setControls(0, this.index % 2 ? 1 : -1, true);
        return;
      }
    } else {
      // Approach or search: follow a route over the road graph.
      const goal = this.state === 'search' ? this.searchTarget(dt, quarry, city) : quarry.lastKnown;
      this.repath -= dt;
      if (this.repath <= 0 || this.routeGoal.distanceToSquared(goal) > 30 * 30 || this.route.length < 2) {
        this.repath = 1.4;
        this.planRoute(city, goal);
      }
      crossTrack = this.route.track(px, pz);
      const look = THREE.MathUtils.clamp(7 + Math.abs(speed) * 0.9, 8, 30);
      pathHeading = this.route.lookahead(px, pz, look, _aim);
      aimX = _aim.x;
      aimZ = _aim.z;
      if (this.state === 'search') targetSpeed = Math.min(chaseSpeed * 0.55, 16);
      const left = this.route.remaining(px, pz);
      if (left < 24) targetSpeed = Math.min(targetSpeed, approachSpeed(this.state === 'search' ? 4 : 10, left, this.driver.tuning.brake));
    }

    /* ---- do not drive through the traffic we are supposed to be protecting ---- */
    const lead = findLead(field, this.id, px, pz, this.driver.heading, 2.4,
      Math.max(14, Math.abs(speed) * 2.0 + 10), 1.4);
    let emergency = false;
    if (lead.obstacle && !lead.obstacle.isPlayer) {
      const gap = lead.gap;
      if (gap < 22) {
        // Steer around rather than queue — but never into a head-on.
        const dodge = lead.lateral > 0 ? -1 : 1;
        const push = Math.min(3.4, 26 / Math.max(3, gap));
        aimX += this.driver.forwardZ * dodge * push;
        aimZ -= this.driver.forwardX * dodge * push;
      }
      if (gap < 9) {
        targetSpeed = Math.min(targetSpeed, Math.max(2, lead.speed));
        emergency = gap < 4;
      }
    }

    this.driver.drive(dt, aimX, aimZ, targetSpeed, pathHeading, {
      crossTrack,
      emergency,
      allowReverse: true,
    });
  }

  /** Sweep pattern around the last known position. */
  private searchTarget(dt: number, quarry: Quarry, city: CityService): THREE.Vector3 {
    this.searchTimer -= dt;
    if (this.searchTimer <= 0 || this.searchPoint.lengthSq() === 0) {
      this.searchTimer = 5.5;
      // Spread the units around an expanding ring centred on the last sighting.
      const radius = Math.min(150, 26 + quarry.lostFor * 9);
      const a = (this.index * 2.399963) + quarry.lostFor * 0.35;
      this.searchPoint.set(
        quarry.lastKnown.x + Math.cos(a) * radius,
        0,
        quarry.lastKnown.z + Math.sin(a) * radius,
      );
      if (city.spatial.snapToRoad(this.searchPoint, _road)) this.searchPoint.copy(_road);
    }
    return this.searchPoint;
  }

  dispose(): void {
    this.vehicle.setSiren?.(false);
  }
}
