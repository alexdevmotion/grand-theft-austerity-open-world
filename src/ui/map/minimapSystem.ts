/** Minimap and the full-screen map.
 *
 *  OWNER: map agent. Streets from `CityService.roadNodes`, districts, landmarks,
 *  the player and their heading, traffic and police blips, mission waypoints
 *  (`HudService.setWaypoint`), and a legible route line. `map` is already bound
 *  to M in `src/core/input.ts`.
 */
import type { GameContext, System } from '../../core/engine';

export class MinimapSystem implements System {
  readonly name = 'minimap';
  readonly order = 425;

  init(_ctx: GameContext): void {
    /* map agent implements */
  }
}
