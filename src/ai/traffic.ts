/** Ambient traffic.
 *  OWNER: traffic agent. Must deliver lane-following cars with intersections,
 *  traffic lights, overtaking, horns, reaction to the player, crashes,
 *  spawn/despawn streaming around the camera, and trams on the boulevards. */

import type { GameContext, System } from '../core/engine';
import { Services, type TrafficService } from '../core/services';
import type * as THREE from 'three';

export class TrafficSystem implements System, TrafficService {
  readonly name = 'traffic';
  readonly order = 130;

  density = 1;
  private _active = 0;

  get activeCount(): number {
    return this._active;
  }

  init(ctx: GameContext): void {
    ctx.provide(Services.Traffic, this);
  }

  panic(_centre: THREE.Vector3, _radius: number, _seconds: number): void {
    /* traffic agent implements */
  }
}
