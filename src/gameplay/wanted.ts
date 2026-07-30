/** Political Instability — five Crisis Stars.
 *  OWNER: wanted/police agent. Baseline holds star state and decay; the agent
 *  must wire heat sources (collisions, hitting peds, being seen committing
 *  crimes), line-of-sight loss, hiding, and the per-star response packages. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Services, type WantedService } from '../core/services';

const STAR_THRESHOLDS = [0, 60, 160, 320, 560, 900];
const COOLDOWN_SECONDS = [0, 12, 18, 26, 36, 50];

export class WantedSystem implements System, WantedService {
  readonly name = 'wanted';
  readonly order = 210;

  private heat = 0;
  private _stars = 0;
  private cooldown = 0;
  private ctx!: GameContext;
  private _pursuers = 0;

  get stars(): number {
    return this._stars;
  }
  get cooldownRemaining(): number {
    return this.cooldown;
  }
  get pursuerCount(): number {
    return this._pursuers;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Wanted, this);
  }

  addHeat(amount: number, _at?: THREE.Vector3): void {
    if (amount <= 0) return;
    this.heat += amount;
    this.cooldown = COOLDOWN_SECONDS[Math.min(5, this._stars + 1)];
    this.recomputeStars();
  }

  setStars(n: number): void {
    const clamped = THREE.MathUtils.clamp(Math.round(n), 0, 5);
    this.heat = STAR_THRESHOLDS[clamped];
    this.recomputeStars();
  }

  clear(): void {
    this.heat = 0;
    this.cooldown = 0;
    this.recomputeStars();
    this.ctx.events.emit('instability:cleared', {});
  }

  private recomputeStars(): void {
    let s = 0;
    for (let i = 5; i >= 0; i--) {
      if (this.heat >= STAR_THRESHOLDS[i]) { s = i; break; }
    }
    if (s !== this._stars) {
      const previous = this._stars;
      this._stars = s;
      this.ctx.events.emit('instability:changed', { stars: s, previous });
    }
  }

  update(dt: number): void {
    if (this._stars === 0) return;
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    // Level 4's `cool_head` unlock (src/gameplay/progression.ts): the whole
    // point of it is that a chase you used to lose becomes one you can break,
    // so it moves the decay rate rather than anything cosmetic.
    const decay = this.ctx.tryGet(Services.Progression)?.has('cool_head') ? 24 * 1.45 : 24;
    this.heat = Math.max(0, this.heat - dt * decay);
    this.recomputeStars();
  }
}
