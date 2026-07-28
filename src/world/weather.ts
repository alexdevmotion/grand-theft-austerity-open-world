/** Weather + time of day.
 *  OWNER: weather agent. Must deliver rain particles, wet-surface response,
 *  puddle ripples, lightning, fog banks and smooth preset transitions. */

import type { GameContext, System } from '../core/engine';
import { Services, type WeatherPreset, type WeatherService } from '../core/services';
import { Atmosphere } from '../artDirection';

export class WeatherSystem implements System, WeatherService {
  readonly name = 'weather';
  readonly order = 14;

  private _preset: WeatherPreset = 'clearSunset';
  private _wetness: number = Atmosphere.wetness;
  private _rain = 0;
  private targetWetness: number = Atmosphere.wetness;
  private ctx!: GameContext;

  /** Hero look is locked to golden hour by default; timeScale 0 freezes it. */
  timeOfDay = 19.4;
  timeScale = 0;

  get preset(): WeatherPreset {
    return this._preset;
  }
  get wetness(): number {
    return this._wetness;
  }
  get rainIntensity(): number {
    return this._rain;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    ctx.provide(Services.Weather, this);
  }

  set(p: WeatherPreset, _transitionSeconds = 6): void {
    if (p === this._preset) return;
    const prev = this._preset;
    this._preset = p;
    this.targetWetness = p === 'rain' || p === 'stormRain' ? 1 : p === 'clearSunset' ? Atmosphere.wetness : 0.35;
    this._rain = p === 'stormRain' ? 1 : p === 'rain' ? 0.55 : 0;
    this.ctx.events.emit('weather:changed', { preset: p });
    void prev;
  }

  update(dt: number): void {
    this._wetness += (this.targetWetness - this._wetness) * Math.min(1, dt * 0.4);
    if (this.timeScale > 0) {
      this.timeOfDay = (this.timeOfDay + dt / this.timeScale) % 24;
      this.ctx.events.emit('timeOfDay:changed', { hours: this.timeOfDay });
    }
  }
}
