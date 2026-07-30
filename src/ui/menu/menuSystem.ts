/** Front-end: studio sting, title screen, main menu, panelled loading screen.
 *
 *  OWNER: menu agent. The spec is the previous game's front-end, kept at
 *  `docs/reference/menu/` — studio mark, tricolour, BUCUREȘTI / GRAND THEFT
 *  AUSTERITY / TAKE BACK THE HOUSE lockup, START · CONTROLS · AUDIO · CREDITS,
 *  a five-star Political Instability preview, and a 01/04 panelled loading
 *  screen over the reference art.
 *
 *  Runs at order >= 400 so it keeps ticking while `time.paused` is true.
 *
 *  WHY THE OVERLAY IS MOUNTED AT MODULE LOAD, NOT IN init()
 *  --------------------------------------------------------
 *  The loading screen has to be on screen for the *whole* load. `init()` here
 *  runs at order 430 — after physics, the city, the props, the traffic and the
 *  peds have already been generated, i.e. after the part worth covering. So
 *  `installFrontEnd()` is called as this module is imported (which happens
 *  inside `src/game.ts`, before `createGame()` starts building anything), and
 *  `init()` only attaches the live services to a front-end that is already up.
 *
 *  `installFrontEnd()` returns null under automation — see `frontEnd.ts` for
 *  why the harness must never see a title screen.
 */
import type { GameContext, System } from '../../core/engine';
import { installFrontEnd, type FrontEnd } from './frontEnd';

const frontEnd: FrontEnd | null = installFrontEnd();

export class MenuSystem implements System {
  readonly name = 'menu';
  readonly order = 430;

  private fe: FrontEnd | null = null;

  init(ctx: GameContext): void {
    this.fe = frontEnd;
    this.fe?.attach(ctx);
  }

  /** Keeps the CONTINUE slot current; the front-end's own rAF drives its DOM. */
  update(dt: number): void {
    this.fe?.updateInGame(dt);
  }

  dispose(): void {
    this.fe?.dispose();
    this.fe = null;
  }
}
