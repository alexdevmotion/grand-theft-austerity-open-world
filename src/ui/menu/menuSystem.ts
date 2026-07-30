/** Front-end: studio sting, title screen, main menu, panelled loading screen.
 *
 *  OWNER: menu agent. The spec is the previous game's front-end, kept at
 *  `docs/reference/menu/` — studio mark, tricolour, BUCUREȘTI / GRAND THEFT
 *  AUSTERITY / TAKE BACK THE HOUSE lockup, START · CONTROLS · AUDIO · CREDITS,
 *  a five-star Political Instability preview, and a 01/04 panelled loading
 *  screen over the reference art.
 *
 *  ORDER 2 — FIRST THING AFTER THE DEBUG HOOKS
 *  -------------------------------------------
 *  The loading screen has to be on screen for the *whole* load, which means it
 *  must exist before the city, the props, the traffic and the peds are built.
 *  This system used to sit at 430, i.e. after all of that, so `installFrontEnd()`
 *  was called at *module import time* to get in ahead of its own init — a side
 *  effect on import, in a file whose only job is registration. With the registry
 *  open again the honest fix is the obvious one: register at order 2 and mount
 *  in `init()`, where every other system does its work.
 *
 *  `ticksWhenPaused` is what keeps it alive with the world stopped. It used to
 *  be a consequence of order >= 400 — which is the other reason it was stuck at
 *  430 — and is now stated directly.
 *
 *  `installFrontEnd()` returns null under automation — see `frontEnd.ts` for
 *  why the harness must never see a title screen.
 */
import type { GameContext, System } from '../../core/engine';
import { installFrontEnd, type FrontEnd } from './frontEnd';

export class MenuSystem implements System {
  readonly name = 'menu';
  /** Before the world: the overlay must cover the load it is describing. */
  readonly order = 2;
  /** The front-end holds the world paused until the player presses START. */
  readonly ticksWhenPaused = true;

  private fe: FrontEnd | null = null;

  init(ctx: GameContext): void {
    this.fe = installFrontEnd();
    this.fe?.attach(ctx);
  }

  /** Keeps the save slot current; the front-end's own rAF drives its DOM. */
  update(dt: number): void {
    this.fe?.updateInGame(dt);
  }

  dispose(): void {
    this.fe?.dispose();
    this.fe = null;
  }
}
