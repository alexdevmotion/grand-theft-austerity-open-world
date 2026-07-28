/** Side activities — the reason to free-roam.
 *  OWNER: activities agent. Must deliver at least: street races, courier runs
 *  (deliver servers/coffee against the clock), rampage/evade challenges,
 *  stunt jumps, photo bounties on political billboards, e-scooter time trials,
 *  and collectibles — each repeatable, scored, and rewarding. */

import type * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type ActivityService } from '../core/services';

export class ActivitySystem implements System, ActivityService {
  readonly name = 'activities';
  readonly order = 230;

  private _available: Array<{ id: string; kind: string; position: THREE.Vector3; name: string }> = [];
  private _activeId: string | null = null;
  private ctx!: GameContext;

  get available(): ReadonlyArray<{ id: string; kind: string; position: THREE.Vector3; name: string }> {
    return this._available;
  }
  get activeId(): string | null {
    return this._activeId;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Activities, this);
  }

  start(id: string): void {
    const a = this._available.find((x) => x.id === id);
    if (!a) return;
    this._activeId = id;
    this.ctx.events.emit('activity:started', { id, kind: a.kind });
  }

  abandon(): void {
    this._activeId = null;
  }
}
