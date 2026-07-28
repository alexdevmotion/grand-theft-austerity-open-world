/** Street furniture, foliage, litter, barriers, signage.
 *  OWNER: props/dressing agent. Baseline is intentionally empty — the agent
 *  must fill the city with street lamps, trams wires, benches, bins, kiosks,
 *  scaffolding, construction barriers, scattered papers, autumn leaves,
 *  e-scooters, political posters and the facade screens from the reference. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';

export class PropsSystem implements System {
  readonly name = 'props';
  readonly order = 30;
  readonly root = new THREE.Group();

  init(ctx: GameContext): void {
    this.root.name = 'props';
    ctx.scene.add(this.root);
  }

  dispose(): void {
    this.root.clear();
  }
}
