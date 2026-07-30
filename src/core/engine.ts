/** Engine: fixed-step simulation + variable-step render, service registry,
 *  system scheduling. Deliberately tiny — the game lives in the systems. */

import * as THREE from 'three';
import { EventBus } from './events';
import { Input } from './input';
import { Rng } from './rng';
import type { ServiceKey } from './services';

export interface TimeState {
  /** Variable frame delta, clamped, in seconds. */
  dt: number;
  /** Fixed simulation step, seconds. */
  fixedDt: number;
  /** Seconds since engine start (unpaused). */
  elapsed: number;
  /** Monotonic frame counter. */
  frame: number;
  /** 0..1 interpolation between the last two fixed steps. */
  alpha: number;
  paused: boolean;
}

export interface GameContext {
  readonly engine: Engine;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly events: EventBus;
  readonly input: Input;
  readonly rng: Rng;
  readonly time: TimeState;
  readonly canvas: HTMLCanvasElement;
  get<T>(k: ServiceKey<T>): T;
  tryGet<T>(k: ServiceKey<T>): T | undefined;
  provide<T>(k: ServiceKey<T>, impl: T): void;
}

export interface System {
  readonly name: string;
  /** Lower runs first. Convention: world 0-99, sim 100-199, gameplay 200-299,
   *  camera 300, presentation 400+. `order` decides sequence and NOTHING else. */
  readonly order?: number;
  /**
   * Keep calling `update()` while `time.paused` is true.
   *
   * Menus, the HUD and the audio bus need this; simulation must never have it.
   * This used to be inferred from `order >= 400`, which made a single number
   * mean two unrelated things — and forced the pause menu to live at 430 and
   * the front-end at 430 purely to stay alive, long after they belonged there.
   * `Engine.add(system, { ticksWhenPaused: true })` can set it from the
   * assembly point for systems whose own file cannot be edited.
   */
  readonly ticksWhenPaused?: boolean;
  init?(ctx: GameContext): void | Promise<void>;
  /** Fixed-rate simulation (physics, AI). May be called 0..N times per frame. */
  fixedUpdate?(dt: number, ctx: GameContext): void;
  /** Per-frame (animation, camera, UI). */
  update?(dt: number, ctx: GameContext): void;
  /** After camera is final, before render (culling, LOD, billboards). */
  lateUpdate?(dt: number, ctx: GameContext): void;
  dispose?(): void;
}

const MAX_FRAME_DT = 0.1;
const FIXED_DT = 1 / 60;
const MAX_FIXED_STEPS = 5;

export class Engine implements GameContext {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly events = new EventBus();
  readonly input: Input;
  readonly rng = new Rng('grand-theft-austerity');
  readonly canvas: HTMLCanvasElement;

  readonly time: TimeState = {
    dt: 0,
    fixedDt: FIXED_DT,
    elapsed: 0,
    frame: 0,
    alpha: 0,
    paused: false,
  };

  get engine(): Engine {
    return this;
  }

  /** Optional render hook — the post-processing pipeline installs itself here. */
  renderOverride: ((ctx: GameContext) => void) | null = null;

  private systems: System[] = [];
  /** Subset of `systems` whose `update()` survives `time.paused`. */
  private pausedTickers = new Set<System>();
  private services = new Map<string, unknown>();
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.input = new Input(canvas);
    this.camera = new THREE.PerspectiveCamera(
      58,
      canvas.clientWidth / Math.max(1, canvas.clientHeight),
      0.15,
      3000,
    );
    this.camera.position.set(0, 3, 8);
    this.scene.matrixWorldAutoUpdate = true;
    this.installResize();
  }

  /* ---- services ---- */

  provide<T>(k: ServiceKey<T>, impl: T): void {
    if (this.services.has(k.id)) {
      console.warn(`[engine] service "${k.id}" replaced`);
    }
    this.services.set(k.id, impl);
  }

  get<T>(k: ServiceKey<T>): T {
    const v = this.services.get(k.id);
    if (v === undefined) throw new Error(`[engine] service "${k.id}" not registered`);
    return v as T;
  }

  tryGet<T>(k: ServiceKey<T>): T | undefined {
    return this.services.get(k.id) as T | undefined;
  }

  /* ---- systems ---- */

  /**
   * Register a system. `opts.ticksWhenPaused` overrides the system's own
   * declaration — that is the escape hatch for systems whose file is owned by
   * someone else, so the assembly point can still state the fact out loud.
   */
  add(system: System, opts?: { ticksWhenPaused?: boolean }): this {
    this.systems.push(system);
    if (opts?.ticksWhenPaused ?? system.ticksWhenPaused ?? false) {
      this.pausedTickers.add(system);
    }
    this.systems.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return this;
  }

  /** Diagnostics: which systems keep running with the world stopped. */
  get pausedSystemNames(): string[] {
    return this.systems.filter((s) => this.pausedTickers.has(s)).map((s) => s.name);
  }

  /** Diagnostics: every registered system, in run order. */
  get systemNames(): string[] {
    return this.systems.map((s) => s.name);
  }

  async initSystems(onProgress?: (done: number, total: number, name: string) => void): Promise<void> {
    const total = this.systems.length;
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      onProgress?.(i, total, s.name);
      try {
        await s.init?.(this);
      } catch (err) {
        console.error(`[engine] system "${s.name}" failed to init:`, err);
        throw err;
      }
      // Yield so the boot screen can paint between heavy systems.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    onProgress?.(total, total, 'gata');
  }

  /* ---- loop ---- */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private frame(now: number): void {
    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = Math.min(MAX_FRAME_DT, Math.max(0, raw));
    this.time.dt = dt;
    this.time.frame++;

    // Manual reset so renderer.info accumulates across every pass of the post
    // chain — otherwise stats only reflect the final fullscreen quad.
    this.renderer.info.reset();

    this.input.update();

    if (!this.time.paused) {
      this.time.elapsed += dt;
      this.accumulator += dt;

      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_FIXED_STEPS) {
        for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_FIXED_STEPS) this.accumulator = 0; // shed backlog
      this.time.alpha = this.accumulator / FIXED_DT;

      for (const s of this.systems) s.update?.(dt, this);
    } else {
      // Paused: only the systems that explicitly asked to survive a pause.
      for (const s of this.systems) {
        if (this.pausedTickers.has(s)) s.update?.(dt, this);
      }
    }

    for (const s of this.systems) s.lateUpdate?.(dt, this);

    if (this.renderOverride) this.renderOverride(this);
    else this.renderer.render(this.scene, this.camera);

    this.input.postUpdate();
  }

  /* ---- resize ---- */

  private installResize(): void {
    const apply = () => {
      const parent = this.canvas.parentElement ?? document.body;
      const w = Math.max(1, parent.clientWidth);
      const h = Math.max(1, parent.clientHeight);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      // Post-processing composers listen for this to resize their targets.
      window.dispatchEvent(new CustomEvent('gta:resize', { detail: { w, h } }));
    };
    this.resizeObserver = new ResizeObserver(apply);
    this.resizeObserver.observe(this.canvas.parentElement ?? document.body);
    apply();
  }

  dispose(): void {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.pausedTickers.clear();
    this.input.dispose();
    this.resizeObserver?.disconnect();
    this.events.clear();
    this.renderer.dispose();
  }
}
