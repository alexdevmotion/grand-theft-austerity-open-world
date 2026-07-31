/**
 * `stats()` MUST NOT INVENT NUMBERS.
 *
 * `window.__GTA_DEBUG__.stats()` is what every critic, screenshot harness and
 * reviewer reads to prove the world is not empty. It used to build every field
 * as `ctx.tryGet(Service)?.field ?? 0`, so a service that was never registered
 * produced a number rather than an absence.
 *
 * `loadedChunks` was exactly that. `Services.Streaming` has never been
 * registered by anything — `src/core/debug.ts` is its only consumer in the
 * whole codebase — so the field read 0 on every frame of every run, forever.
 * A reviewer looking at `loadedChunks: 0` sees a measurement that says the
 * streamer is idle. They cannot see that there is no streamer.
 *
 * The rule this file enforces: a field whose service is missing is ABSENT, and
 * the missing service is named. `undefined` is loud. A plausible zero is not.
 *
 * OWNER: truth-assertion agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as THREE from 'three';
import { DebugSystem, type DebugApi } from './debug';
import { Services, type ServiceKey } from './services';

/* ------------------------------------------------------------------ */
/* Just enough DOM and engine for DebugSystem.init                     */
/* ------------------------------------------------------------------ */

interface Harness {
  api: DebugApi;
  provide<T>(k: ServiceKey<T>, v: T): void;
}

const listeners: Array<() => void> = [];

function stubDom(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g.window) g.window = g;
  const el = {
    style: { cssText: '', display: '' },
    textContent: '',
    appendChild: () => {},
  };
  g.document = {
    createElement: () => ({ ...el, style: { cssText: '', display: '' } }),
    getElementById: () => ({ appendChild: () => {} }),
  };
  (g.window as Record<string, unknown>).addEventListener = () => {};
}

function harness(): Harness {
  stubDom();
  const services = new Map<string, unknown>();
  const scene = new THREE.Scene();
  scene.add(new THREE.Group());
  const ctx = {
    scene,
    camera: new THREE.PerspectiveCamera(),
    renderer: { info: { render: { calls: 42, triangles: 1234 }, programs: [{}, {}] } },
    provide: (k: { id: string }, v: unknown) => services.set(k.id, v),
    get: (k: { id: string }) => services.get(k.id),
    tryGet: (k: { id: string }) => services.get(k.id),
  } as unknown as Parameters<DebugSystem['init']>[0];

  new DebugSystem().init(ctx);
  const api = (globalThis as unknown as { __GTA_DEBUG__: DebugApi }).__GTA_DEBUG__;
  return {
    api,
    provide: (k, v) => services.set(k.id, v as unknown),
  };
}

beforeEach(() => { listeners.length = 0; });
afterEach(() => {
  delete (globalThis as unknown as { __GTA_DEBUG__?: DebugApi }).__GTA_DEBUG__;
});

/* ================================================================== */

describe('stats() with nothing registered', () => {
  test('omits every service-backed field instead of defaulting it to zero', () => {
    const { api } = harness();
    const s = api.stats();

    // The bug, named. `loadedChunks` must not be a number when there is no
    // streaming service — and there has never been one.
    expect('loadedChunks' in s).toBe(false);
    expect(s.loadedChunks).toBeUndefined();

    for (const field of ['vehicles', 'peds', 'traffic', 'stars', 'playerPos', 'quality'] as const) {
      expect(`${field} present: ${field in s}`).toBe(`${field} present: false`);
    }
  });

  test('names the services it could not find', () => {
    const { api } = harness();
    const s = api.stats();
    expect(s.unavailable).toContain('streaming');
    expect(s.unavailable).toContain('peds');
    expect(s.unavailable).toContain('vehicles');
    // Each id appears once, however many fields it backs.
    expect(new Set(s.unavailable).size).toBe(s.unavailable.length);
  });

  test('still reports what it can measure directly', () => {
    // Renderer counters do not come from a service and must always be real,
    // or the harness loses the one thing it can always trust.
    const { api } = harness();
    const s = api.stats();
    expect(s.drawCalls).toBe(42);
    expect(s.triangles).toBe(1234);
    expect(s.programs).toBe(2);
    expect(s.sceneObjects).toBeGreaterThan(0);
  });

  test('the whole object is JSON-round-trippable — the harness reads it over the wire', () => {
    const { api } = harness();
    const s = api.stats();
    const wire = JSON.parse(JSON.stringify(s));
    expect('loadedChunks' in wire).toBe(false);
    expect(Array.isArray(wire.unavailable)).toBe(true);
  });
});

describe('stats() with services registered', () => {
  test('reports real values and shrinks the unavailable list', () => {
    const h = harness();
    h.provide(Services.Peds, { all: [1, 2, 3] } as never);
    h.provide(Services.Traffic, { activeCount: 17 } as never);
    h.provide(Services.Render, { fps: 59.4, quality: 'high' } as never);

    const s = h.api.stats();
    expect(s.peds).toBe(3);
    expect(s.traffic).toBe(17);
    expect(s.quality).toBe('high');
    expect(s.fps).toBeCloseTo(59.4, 5);
    expect(s.unavailable).not.toContain('peds');
    expect(s.unavailable).not.toContain('traffic');
    // Still absent, because nothing provides it.
    expect(s.unavailable).toContain('streaming');
    expect('loadedChunks' in s).toBe(false);
  });

  test('a registered streaming service makes loadedChunks appear — including a real zero', () => {
    // The point is not that zero is forbidden. It is that a zero must come
    // from something that counted. A streamer with nothing loaded reports 0
    // and is NOT listed as unavailable; that is a measurement.
    const h = harness();
    h.provide(Services.Streaming, { loadedChunks: 0, pendingChunks: 0, focus: () => {} });
    const s = h.api.stats();
    expect(s.loadedChunks).toBe(0);
    expect(s.unavailable).not.toContain('streaming');
  });

  test('a zero from a live service is distinguishable from a missing one', () => {
    const live = (() => {
      const h = harness();
      h.provide(Services.Peds, { all: [] } as never);
      return h.api.stats();
    })();
    const missing = harness().api.stats();

    expect(live.peds).toBe(0);
    expect(missing.peds).toBeUndefined();
    // This is the whole assertion of this file, in one line.
    expect(live.peds === missing.peds).toBe(false);
  });
});

describe('nothing in the codebase registers Services.Streaming', () => {
  test('the field is dead, and the test says so out loud', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
      }
    };
    walk(SRC);
    const providers = files.filter((f) => /provide\(\s*Services\.Streaming/.test(readFileSync(f, 'utf8')));
    console.log(`[debug] Services.Streaming providers: ${providers.length ? providers.join(', ') : 'NONE'}`);
    // When someone finally writes a streaming system, this flips and the
    // comment at the top of this file needs updating — which is the point.
    expect(providers).toEqual([]);
  });
});
