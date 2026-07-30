/**
 * LIVE MAP STATE — one sample of the world per frame, in map terms.
 *
 * OWNER: map agent.
 *
 * Everything the two views draw that is *not* static geometry is gathered here
 * exactly once a frame, through the service seam, into pre-allocated arrays.
 * Nothing below allocates in steady state: the minimap runs at 60 Hz and a map
 * that produces garbage would be worse than no map at all.
 *
 * WHERE THE SEARCH CIRCLE COMES FROM. `WantedService` publishes stars and a
 * pursuer count, not the Ministry's last sighting — that lives inside the
 * police system, which is not ours and which we must not import. So we derive
 * it the way the player experiences it: while anyone is actually chasing you
 * they can see you, so the circle sits on you; the moment the last pursuer
 * loses contact the circle freezes where you were last seen and starts to
 * breathe. That is the same information the player gets from the sirens, and
 * it is honest — if it ever drifts from the police system's own belief, it
 * drifts in the direction of "you have not shaken them yet".
 */

import * as THREE from 'three';
import type { GameContext } from '../../core/engine';
import { Services } from '../../core/services';

export interface Blip {
  x: number;
  z: number;
  /** Radians, 0 = north. NaN when the thing has no meaningful facing. */
  heading: number;
  /** Free tag: activity kind, vehicle class, landmark id. */
  tag: string;
  /** True for the one the player is currently engaged with. */
  hot: boolean;
}

const _fwd = new THREE.Vector3();

/**
 * Compass heading of a three.js forward vector, radians, 0 = north (-Z),
 * +π/2 = east (+X). `Object3D.getWorldDirection` returns the object's -Z, so
 * an object facing north gives (0, 0, -1) and this returns 0.
 */
function headingOf(f: THREE.Vector3): number {
  return Math.atan2(f.x, -f.z);
}

function blip(): Blip {
  return { x: 0, z: 0, heading: NaN, tag: '', hot: false };
}

/** Grow-only pool: `used` says how many of `items` are live this frame. */
class BlipPool {
  readonly items: Blip[] = [];
  used = 0;

  reset(): void {
    this.used = 0;
  }

  push(x: number, z: number, heading = NaN, tag = '', hot = false): void {
    let b = this.items[this.used];
    if (!b) {
      b = blip();
      this.items.push(b);
    }
    b.x = x;
    b.z = z;
    b.heading = heading;
    b.tag = tag;
    b.hot = hot;
    this.used++;
  }
}

export class MapWorld {
  /* player */
  x = 0;
  z = 0;
  /** Body/vehicle facing, radians, 0 = north (-Z). */
  heading = 0;
  /** Camera facing — what the rotating minimap puts at the top of the frame. */
  cameraHeading = 0;
  speedKmh = 0;
  inVehicle = false;
  alive = true;

  /* wanted */
  stars = 0;
  pursuers = 0;
  searchX = 0;
  searchZ = 0;
  searchRadius = 0;
  /** 0 = nobody is looking, 1 = they have eyes on you. */
  contact = 0;

  /* waypoint */
  waypointX = 0;
  waypointZ = 0;
  hasWaypoint = false;
  waypointIsCustom = false;

  /* objective text, for the full map's readout */
  missionTitle = '';
  objectiveTitle = '';

  readonly police = new BlipPool();
  readonly traffic = new BlipPool();
  readonly activities = new BlipPool();

  private lastKnownValid = false;

  sample(ctx: GameContext, dt: number): void {
    const player = ctx.tryGet(Services.Player);
    const wanted = ctx.tryGet(Services.Wanted);
    const vehicles = ctx.tryGet(Services.Vehicles);
    const peds = ctx.tryGet(Services.Peds);
    const acts = ctx.tryGet(Services.Activities);
    const missions = ctx.tryGet(Services.Missions);

    if (player) {
      const veh = player.inVehicle;
      const src = veh ? veh.position : player.position;
      this.x = src.x;
      this.z = src.z;
      this.inVehicle = !!veh;
      this.speedKmh = veh ? Math.abs(veh.speed) * 3.6 : 0;
      this.alive = player.health > 0;

      const obj = veh ? veh.object : player.character?.object;
      if (obj) {
        obj.getWorldDirection(_fwd);
        this.heading = headingOf(_fwd);
      }
    }

    ctx.camera.getWorldDirection(_fwd);
    this.cameraHeading = headingOf(_fwd);

    /* ---- wanted ---------------------------------------------------- */

    this.stars = wanted?.stars ?? 0;
    this.pursuers = wanted?.pursuerCount ?? 0;
    if (this.stars <= 0) {
      this.searchRadius = 0;
      this.contact = 0;
      this.lastKnownValid = false;
    } else {
      const seen = this.pursuers > 0;
      if (seen || !this.lastKnownValid) {
        this.searchX = this.x;
        this.searchZ = this.z;
        this.lastKnownValid = true;
      }
      this.contact = Math.max(0, Math.min(1, this.contact + (seen ? dt * 3 : -dt * 0.8)));
      const target = 70 + this.stars * 46;
      this.searchRadius = this.searchRadius > 0
        ? this.searchRadius + (target - this.searchRadius) * Math.min(1, dt * 2)
        : target;
    }

    /* ---- waypoint -------------------------------------------------- */
    // Set from outside via `setWaypoint` — see MinimapSystem, which observes
    // every write to `HudService.setWaypoint` so mission markers and the
    // player's own map pin share one source of truth.

    /* ---- blips ----------------------------------------------------- */

    this.police.reset();
    this.traffic.reset();
    this.activities.reset();

    if (vehicles) {
      const all = vehicles.all;
      for (let i = 0; i < all.length; i++) {
        const v = all[i];
        if (v.isWrecked) continue;
        const p = v.position;
        const dx = p.x - this.x;
        const dz = p.z - this.z;
        // 420 m keeps the whole minimap window plus a margin at top speed,
        // and stops a 2 km city of parked cars costing anything.
        if (dx * dx + dz * dz > 420 * 420) continue;
        if (v === player?.inVehicle) continue;
        if (v.kind === 'police') {
          v.object.getWorldDirection(_fwd);
          this.police.push(p.x, p.z, headingOf(_fwd), 'car', true);
        } else {
          this.traffic.push(p.x, p.z, NaN, v.kind, false);
        }
      }
    }

    if (peds) {
      const all = peds.all;
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        if (c.faction !== 'police' && c.faction !== 'ministry') continue;
        if (!c.isAlive) continue;
        const p = c.position;
        const dx = p.x - this.x;
        const dz = p.z - this.z;
        if (dx * dx + dz * dz > 320 * 320) continue;
        this.police.push(p.x, p.z, NaN, 'foot', false);
      }
    }

    if (acts) {
      const list = acts.available;
      const active = acts.activeId;
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        this.activities.push(a.position.x, a.position.z, NaN, a.kind, a.id === active);
      }
    }

    this.missionTitle = missions?.currentTitle ?? '';
  }

  setWaypoint(p: { x: number; z: number } | null, custom: boolean): void {
    if (!p) {
      this.hasWaypoint = false;
      this.waypointIsCustom = false;
      return;
    }
    this.waypointX = p.x;
    this.waypointZ = p.z;
    this.hasWaypoint = true;
    this.waypointIsCustom = custom;
  }

  distanceToWaypoint(): number {
    if (!this.hasWaypoint) return NaN;
    return Math.hypot(this.waypointX - this.x, this.waypointZ - this.z);
  }
}
