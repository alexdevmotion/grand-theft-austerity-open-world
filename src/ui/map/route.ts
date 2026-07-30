/**
 * ROUTE — the line from the player to the waypoint, along real streets.
 *
 * OWNER: map agent.
 *
 * This is the difference between a map that is decoration and a map that is a
 * tool. It is a plain A* over `CityService.findPath`, but *when* it runs is the
 * whole design:
 *
 *  - `findPath` is an A* with a linear open-set scan over the ~730-node road
 *    graph. That is a millisecond or two — nothing per minute, a disaster per
 *    frame. So it runs on demand, never on a schedule.
 *  - It re-plans when the destination moves, when the player's nearest node
 *    changes (i.e. you actually crossed a junction), or when you have strayed
 *    more than half a block from the drawn line — the three moments a satnav
 *    is allowed to think.
 *  - Everything between re-plans is O(n) trimming of a ~30-point polyline,
 *    which is what keeps the line stuck to the front of the car at 60 Hz.
 *
 * When the graph cannot connect the two ends (waypoint dropped inside a
 * landmark void, or on a plaza deck), the route degrades to a straight bearing
 * line and says so, rather than silently disappearing.
 */

import * as THREE from 'three';
import type { CityService } from '../../core/services';
import { distanceToPolyline, polylineLength, routeAdvance, smoothPolyline, type RoutePoint } from './mapMath';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Re-plan no more often than this, seconds. */
const REPLAN_COOLDOWN = 0.45;
/** Metres off the drawn line before we admit the route is stale. */
const OFF_ROUTE = 46;

export class Router {
  /** Smoothed world polyline from the first road node to the destination. */
  points: RoutePoint[] = [];
  /** Index of the first point still ahead of the player. */
  advance = 0;
  /** Metres left along the drawn line, including the hop onto it. */
  remaining = 0;
  /** True when the graph could not connect the ends and this is a bearing. */
  direct = false;
  /** Bumped whenever a new plan lands — lets views invalidate cheaply. */
  version = 0;

  private destX = NaN;
  private destZ = NaN;
  private fromNode = -2;
  private cooldown = 0;
  private planned = false;

  clear(): void {
    if (!this.points.length && !this.planned) return;
    this.points.length = 0;
    this.advance = 0;
    this.remaining = 0;
    this.direct = false;
    this.planned = false;
    this.destX = NaN;
    this.destZ = NaN;
    this.fromNode = -2;
    this.version++;
  }

  update(
    city: CityService | undefined,
    px: number,
    pz: number,
    dest: { x: number; z: number } | null,
    dt: number,
  ): void {
    if (!city || !dest) {
      this.clear();
      return;
    }
    this.cooldown -= dt;

    const moved = !this.planned
      || Math.hypot(dest.x - this.destX, dest.z - this.destZ) > 3;

    _a.set(px, 0, pz);
    const node = city.nearestNode(_a);
    const crossedJunction = node !== this.fromNode;
    const strayed = this.points.length > 1 && distanceToPolyline(this.points, px, pz) > OFF_ROUTE;

    if ((moved || crossedJunction || strayed) && this.cooldown <= 0) {
      this.plan(city, px, pz, dest, node);
      this.cooldown = REPLAN_COOLDOWN;
    }

    if (!this.points.length) {
      this.remaining = 0;
      return;
    }

    this.advance = routeAdvance(this.points, px, pz);
    const head = this.points[Math.min(this.advance, this.points.length - 1)];
    this.remaining = Math.hypot(head.x - px, head.z - pz) + polylineLength(this.points, this.advance);
  }

  private plan(
    city: CityService,
    px: number,
    pz: number,
    dest: { x: number; z: number },
    fromNode: number,
  ): void {
    this.destX = dest.x;
    this.destZ = dest.z;
    this.fromNode = fromNode;
    this.planned = true;
    this.version++;
    this.points.length = 0;

    _b.set(dest.x, 0, dest.z);
    const toNode = city.nearestNode(_b);
    const raw: RoutePoint[] = [];

    if (fromNode >= 0 && toNode >= 0 && fromNode !== toNode) {
      const path = city.findPath(fromNode, toNode);
      for (let i = 0; i < path.length; i++) {
        const n = city.roadNodes[path[i]];
        if (n) raw.push({ x: n.position.x, z: n.position.z });
      }
    }

    this.direct = raw.length < 2;
    if (this.direct) {
      // No graph answer: a bearing to the destination is still useful and is
      // drawn dashed so it never pretends to be a driveable route.
      this.points = [{ x: px, z: pz }, { x: dest.x, z: dest.z }];
      return;
    }

    // Do not double back to the junction behind you: if the player is already
    // past the first node (the second node is nearer), drop it.
    if (raw.length > 2) {
      const d0 = Math.hypot(raw[0].x - px, raw[0].z - pz);
      const d1 = Math.hypot(raw[1].x - px, raw[1].z - pz);
      if (d1 < d0) raw.shift();
    }
    raw.push({ x: dest.x, z: dest.z });
    this.points = smoothPolyline(raw, 0.24);
  }
}
