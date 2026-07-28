/** Pedestrian crowds.
 *  OWNER: pedestrian agent. Must deliver pavement-following crowds with
 *  avoidance, idle behaviours (phones, smoking, talking, queueing), crossing
 *  at lights, reaction to vehicles/sirens/gunfire, panic, and variety of
 *  archetypes — office workers, builders, protesters, vendors. */

import type * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type CharacterHandle, type PedArchetype, type PedService } from '../core/services';

export class PedSystem implements System, PedService {
  readonly name = 'peds';
  readonly order = 120;

  density = 1;
  private peds = new Map<string, CharacterHandle>();
  private list: CharacterHandle[] = [];

  get all(): ReadonlyArray<CharacterHandle> {
    return this.list;
  }

  init(ctx: GameContext): void {
    ctx.provide(Services.Peds, this);
  }

  spawn(_archetype: PedArchetype, _position: THREE.Vector3, _headingRad: number): CharacterHandle {
    throw new Error('PedSystem.spawn not implemented — owned by the pedestrian agent');
  }

  despawn(id: string): void {
    const p = this.peds.get(id);
    if (!p) return;
    this.peds.delete(id);
    const i = this.list.indexOf(p);
    if (i >= 0) this.list.splice(i, 1);
  }

  get(id: string): CharacterHandle | undefined {
    return this.peds.get(id);
  }

  scatter(_centre: THREE.Vector3, _radius: number): void {
    /* pedestrian agent implements */
  }
}
