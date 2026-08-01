import { describe, expect, test } from 'bun:test';
import type { GameContext } from '../core/engine';
import { Atmosphere } from '../artDirection';
import { WeatherSystem } from './weather';

function testContext(): GameContext {
  return {
    events: { emit: () => undefined },
    provide: () => undefined,
  } as unknown as GameContext;
}

function settle(weather: WeatherSystem): void {
  // A one-second step uses the system's capped interpolation and settles the
  // target quickly without depending on a renderer or browser clock.
  for (let i = 0; i < 20; i++) weather.update(1);
}

describe('weather surface state', () => {
  test('clear sunset starts matte while rain and storm retain a fully wet target', () => {
    const weather = new WeatherSystem();
    weather.init(testContext());

    expect(weather.wetness).toBeCloseTo(Atmosphere.wetness, 6);
    expect(weather.wetness).toBeLessThan(0.2);

    weather.set('rain');
    settle(weather);
    expect(weather.wetness).toBeGreaterThan(0.99);
    expect(weather.rainIntensity).toBe(0.55);

    weather.set('stormRain');
    expect(weather.rainIntensity).toBe(1);
    settle(weather);
    expect(weather.wetness).toBeGreaterThan(0.99);
  });

  test('fog and overcast keep their damp but non-mirror baseline', () => {
    const weather = new WeatherSystem();
    weather.init(testContext());

    weather.set('fogDusk');
    settle(weather);
    expect(weather.wetness).toBeCloseTo(0.35, 3);

    weather.set('overcast');
    settle(weather);
    expect(weather.wetness).toBeCloseTo(0.35, 3);

    weather.set('clearSunset');
    settle(weather);
    expect(weather.wetness).toBeCloseTo(Atmosphere.wetness, 3);
  });
});
