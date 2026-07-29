/** Enterable interiors: the Builders House lobby, the Recorder newsroom, the
 *  broadcast studio, and any shop or block hallway worth stepping into.
 *
 *  OWNER: interiors agent. `docs/STORY.md` requires the Builders House lobby to
 *  be physically enterable and to transform on liberation.
 */
import type { GameContext, System } from '../../core/engine';

export class InteriorSystem implements System {
  readonly name = 'interiors';
  readonly order = 25;

  init(_ctx: GameContext): void {
    /* interiors agent implements */
  }
}
