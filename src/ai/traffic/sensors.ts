/**
 * Sensing: a per-step uniform grid over every vehicle in the world plus the
 * player on foot, and the cone query that car-following, overtaking and
 * collision avoidance are built on.
 *
 * Rebuilt from `VehicleService.all` each fixed step. That list is the single
 * authority on what physically exists, so traffic, police and the player are
 * all seen by the same query — a traffic car brakes for a police car for
 * exactly the same reason it brakes for a bus.
 */

import * as THREE from 'three';
import type { VehicleHandle } from '../../core/services';

export interface Obstacle {
  id: string;
  /** Vehicle handle, or null for the player on foot. */
  vehicle: VehicleHandle | null;
  x: number;
  z: number;
  /** Heading, radians, 0 = +Z. */
  heading: number;
  /** Signed forward speed. */
  speed: number;
  /** Half length / half width of the footprint. */
  halfLength: number;
  halfWidth: number;
  isPlayer: boolean;
}

/** Footprint by vehicle class — deliberately local tuning, not city data. */
const FOOTPRINT: Record<string, [number, number]> = {
  dacia: [2.2, 0.85],
  sedan: [2.35, 0.92],
  hatch: [1.98, 0.88],
  van: [2.6, 1.02],
  truck: [3.75, 1.24],
  bus: [5.85, 1.30],
  police: [2.4, 0.94],
  tram: [7.7, 1.26],
  scooter: [0.62, 0.32],
};

export function footprint(kind: string): [number, number] {
  return FOOTPRINT[kind] ?? [2.2, 0.9];
}

const _fwd = new THREE.Vector3();

export function headingOf(v: VehicleHandle): number {
  _fwd.set(0, 0, 1).applyQuaternion(v.rotation);
  return Math.atan2(_fwd.x, _fwd.z);
}

const CELL = 18;

export class SensorField {
  private grid = new Map<number, Obstacle[]>();
  private pool: Obstacle[] = [];
  private used = 0;
  /** Every obstacle in the field this step. */
  readonly all: Obstacle[] = [];

  begin(): void {
    this.grid.clear();
    this.all.length = 0;
    this.used = 0;
  }

  private take(): Obstacle {
    if (this.used < this.pool.length) return this.pool[this.used++];
    const o: Obstacle = {
      id: '', vehicle: null, x: 0, z: 0, heading: 0, speed: 0,
      halfLength: 2, halfWidth: 0.9, isPlayer: false,
    };
    this.pool.push(o);
    this.used++;
    return o;
  }

  addVehicle(v: VehicleHandle, isPlayer: boolean): void {
    const o = this.take();
    const fp = footprint(v.kind);
    o.id = v.id;
    o.vehicle = v;
    o.x = v.position.x;
    o.z = v.position.z;
    o.heading = headingOf(v);
    o.speed = v.speed;
    o.halfLength = fp[0];
    o.halfWidth = fp[1];
    o.isPlayer = isPlayer;
    this.insert(o);
  }

  addPoint(id: string, x: number, z: number, radius: number, isPlayer: boolean): void {
    const o = this.take();
    o.id = id;
    o.vehicle = null;
    o.x = x;
    o.z = z;
    o.heading = 0;
    o.speed = 0;
    o.halfLength = radius;
    o.halfWidth = radius;
    o.isPlayer = isPlayer;
    this.insert(o);
  }

  private insert(o: Obstacle): void {
    this.all.push(o);
    const key = Math.floor(o.x / CELL) * 100003 + Math.floor(o.z / CELL);
    let list = this.grid.get(key);
    if (!list) this.grid.set(key, (list = []));
    list.push(o);
  }

  forEachNear(x: number, z: number, radius: number, fn: (o: Obstacle) => void): void {
    const r = Math.ceil(radius / CELL);
    const ci = Math.floor(x / CELL);
    const cj = Math.floor(z / CELL);
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        const list = this.grid.get(i * 100003 + j);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) fn(list[k]);
      }
    }
  }
}

export interface LeadResult {
  /** Gap between bumpers, metres. Infinity when the road ahead is clear. */
  gap: number;
  /** Forward speed of whatever is ahead. */
  speed: number;
  obstacle: Obstacle | null;
  /** Signed lateral offset of the obstacle from our path (+ = to our left, matching the steering controller). */
  lateral: number;
}

const _lead: LeadResult = { gap: Infinity, speed: 0, obstacle: null, lateral: 0 };

/**
 * Nearest thing ahead inside a corridor of `halfCorridor` metres, looking
 * `range` metres down our own heading. Returns a shared record — read it
 * before the next call.
 */
export function findLead(
  field: SensorField,
  selfId: string,
  x: number, z: number,
  heading: number,
  selfHalfLength: number,
  range: number,
  halfCorridor: number,
): LeadResult {
  const fx = Math.sin(heading);
  const fz = Math.cos(heading);
  const rx = fz;
  const rz = -fx;
  _lead.gap = Infinity;
  _lead.speed = 0;
  _lead.obstacle = null;
  _lead.lateral = 0;

  field.forEachNear(x, z, range + 8, (o) => {
    if (o.id === selfId) return;
    const dx = o.x - x;
    const dz = o.z - z;
    const along = dx * fx + dz * fz;
    if (along <= 0 || along > range) return;
    const lat = dx * rx + dz * rz;
    // Project the complete oriented body onto our corridor. A bus crossing
    // sideways occupies its length across our lane, not just its width.
    const alignment = Math.cos(o.heading - heading);
    const sideways = Math.abs(Math.sin(o.heading - heading));
    const projectedWidth = o.halfWidth * Math.abs(alignment) + o.halfLength * sideways;
    const projectedLength = o.halfLength * Math.abs(alignment) + o.halfWidth * sideways;
    const widen = halfCorridor + projectedWidth;
    if (Math.abs(lat) > widen) return;
    const gap = along - selfHalfLength - projectedLength;
    if (gap < _lead.gap) {
      _lead.gap = gap;
      _lead.speed = o.speed * alignment;
      _lead.obstacle = o;
      _lead.lateral = lat;
    }
  });
  return _lead;
}
