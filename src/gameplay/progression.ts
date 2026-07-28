/** XP, levels and unlocks — "Runway", "Traction", "Series A"…
 *  OWNER: progression agent. Must make free-roam pay off: unlock vehicles,
 *  garages, safehouses, abilities, map regions, and radio stations. */

import type { GameContext, System } from '../core/engine';
import { Services, type ProgressionService } from '../core/services';

const LEVEL_CURVE = [0, 400, 1100, 2300, 4200, 7000, 11000, 16500, 24000, 34000];

export class ProgressionSystem implements System, ProgressionService {
  readonly name = 'progression';
  readonly order = 215;

  private _xp = 0;
  private _level = 1;
  private _unlocks = new Set<string>();
  private ctx!: GameContext;

  get level(): number {
    return this._level;
  }
  get xp(): number {
    return this._xp;
  }
  get unlocks(): ReadonlySet<string> {
    return this._unlocks;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Progression, this);
    ctx.events.on('activity:finished', ({ score }) => this.addXp(Math.round(score), 'activity'));
  }

  addXp(amount: number, reason: string): void {
    if (amount <= 0) return;
    this._xp += amount;
    this.ctx.events.emit('progression:xp', { amount, total: this._xp, reason });
    while (this._level < LEVEL_CURVE.length && this._xp >= LEVEL_CURVE[this._level]) {
      this._level++;
      const unlock = `level_${this._level}`;
      this._unlocks.add(unlock);
      this.ctx.events.emit('progression:levelUp', { level: this._level, unlock });
    }
  }

  has(unlock: string): boolean {
    return this._unlocks.has(unlock);
  }
}
