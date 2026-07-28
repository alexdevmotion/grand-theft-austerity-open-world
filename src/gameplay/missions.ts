/** Story spine: the four-act Grand Theft Austerity campaign.
 *  OWNER: mission agent. Must deliver the acts as real, replayable objectives
 *  with triggers, markers, fail/restart, cutscene beats, subtitled dialogue,
 *  and the broadcast-hijack climax. */

import type { GameContext, System } from '../core/engine';
import { Services, type MissionService } from '../core/services';

export class MissionSystem implements System, MissionService {
  readonly name = 'missions';
  readonly order = 220;

  private _current: string | null = null;
  private _title = '';
  private _completed = new Set<string>();
  private ctx!: GameContext;

  get currentId(): string | null {
    return this._current;
  }
  get currentTitle(): string {
    return this._title;
  }
  get completed(): ReadonlySet<string> {
    return this._completed;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Missions, this);
  }

  start(id: string): void {
    this._current = id;
    this.ctx.events.emit('mission:advance', { id });
  }

  abandon(): void {
    if (!this._current) return;
    this.ctx.events.emit('mission:failed', { id: this._current, reason: 'abandoned' });
    this._current = null;
  }
}
