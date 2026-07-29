/** Front-end: studio sting, title screen, main menu, panelled loading screen.
 *
 *  OWNER: menu agent. The spec is the previous game's front-end, kept at
 *  `docs/reference/menu/` — studio mark, tricolour, BUCUREȘTI / GRAND THEFT
 *  AUSTERITY / TAKE BACK THE HOUSE lockup, START · CONTROLS · AUDIO · CREDITS,
 *  a five-star Political Instability preview, and a 01/04 panelled loading
 *  screen over the reference art.
 *
 *  Runs at order >= 400 so it keeps ticking while `time.paused` is true.
 */
import type { GameContext, System } from '../../core/engine';

export class MenuSystem implements System {
  readonly name = 'menu';
  readonly order = 430;

  init(_ctx: GameContext): void {
    /* menu agent implements */
  }
}
