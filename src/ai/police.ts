/** Police / Ministry of National De-Acceleration pursuit AI.
 *  OWNER: police agent. Must deliver escalating response per Crisis Star:
 *  inspectors on foot, pursuit vans, roadblocks, PIT manoeuvres, spike strips,
 *  helicopter spotlight, search behaviour when the player breaks line of
 *  sight, and a satisfying escape/cooldown. */

import type { GameContext, System } from '../core/engine';
import { Services } from '../core/services';

export class PoliceSystem implements System {
  readonly name = 'police';
  readonly order = 140;

  private ctx!: GameContext;

  init(ctx: GameContext): void {
    this.ctx = ctx;
  }

  fixedUpdate(): void {
    const wanted = this.ctx.tryGet(Services.Wanted);
    void wanted;
    /* police agent implements pursuit */
  }
}
