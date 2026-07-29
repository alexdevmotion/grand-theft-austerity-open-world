/**
 * A frame profiler for the simulation systems.
 *
 * Wall-clock fps is capped by vsync and `renderer.info` only describes the
 * draw stream, so neither tells you where a frame actually went. This does:
 * every probe accumulates milliseconds *within one frame*, and the accumulated
 * totals are pushed into a ring buffer once per frame so the report is a
 * median over recent frames rather than a single noisy sample.
 *
 * It lives in `src/characters/` because that is the leaf module every actor
 * consumer already depends on — importing it from `src/ai/**` keeps the
 * dependency direction the architecture already has.
 *
 * Zero cost when disabled: `enabled` is false unless `?prof=1` is in the URL
 * or `window.__GTA_PROF__.enable()` is called, and every probe is an early
 * return on a boolean.
 *
 *   import { prof } from '../characters/profile';
 *   const t = prof.begin(); ...work...; prof.add('peds.steer', t);
 */

const RING = 120;

interface Slot {
  /** Milliseconds accumulated in the frame currently being assembled. */
  current: number;
  /** Per-frame totals, newest overwriting oldest. */
  ring: Float32Array;
  /** Number of `add` calls in the current frame. */
  calls: number;
  callRing: Float32Array;
}

class Profiler {
  enabled = false;

  private slots = new Map<string, Slot>();
  private cursor = 0;
  private frames = 0;

  /** Returns a timestamp, or 0 when disabled so callers pay nothing. */
  begin(): number {
    return this.enabled ? performance.now() : 0;
  }

  /** Charge the elapsed time since `t0` to `name`. */
  add(name: string, t0: number): void {
    if (!this.enabled || t0 === 0) return;
    this.slot(name).current += performance.now() - t0;
    this.slot(name).calls++;
  }

  /** Charge a count with no time attached (instance counts, raycasts, …). */
  count(name: string, n = 1): void {
    if (!this.enabled) return;
    this.slot(name).calls += n;
  }

  private slot(name: string): Slot {
    let s = this.slots.get(name);
    if (!s) {
      s = { current: 0, ring: new Float32Array(RING), calls: 0, callRing: new Float32Array(RING) };
      this.slots.set(name, s);
    }
    return s;
  }

  /**
   * Close the frame: flush every slot's accumulator into the ring. Called from
   * the pedestrian system's lateUpdate, which is the last simulation stage.
   */
  endFrame(): void {
    if (!this.enabled) return;
    for (const s of this.slots.values()) {
      s.ring[this.cursor] = s.current;
      s.callRing[this.cursor] = s.calls;
      s.current = 0;
      s.calls = 0;
    }
    this.cursor = (this.cursor + 1) % RING;
    this.frames++;
  }

  /** Median milliseconds per frame for every probe, largest first. */
  report(): Array<{ name: string; ms: number; p95: number; calls: number }> {
    const n = Math.min(this.frames, RING);
    const out: Array<{ name: string; ms: number; p95: number; calls: number }> = [];
    const buf = new Float32Array(n);
    for (const [name, s] of this.slots) {
      for (let i = 0; i < n; i++) buf[i] = s.ring[i];
      const sorted = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
      const callsSorted = Array.from(s.callRing.subarray(0, n)).sort((a, b) => a - b);
      out.push({
        name,
        ms: round(sorted[n >> 1] ?? 0),
        p95: round(sorted[Math.floor(n * 0.95)] ?? 0),
        calls: Math.round(callsSorted[n >> 1] ?? 0),
      });
    }
    out.sort((a, b) => b.ms - a.ms);
    return out;
  }

  reset(): void {
    this.slots.clear();
    this.cursor = 0;
    this.frames = 0;
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export const prof = new Profiler();

if (typeof window !== 'undefined') {
  try {
    if (new URLSearchParams(location.search).get('prof') === '1') prof.enabled = true;
  } catch {
    /* non-browser */
  }
  (window as unknown as { __GTA_PROF__: unknown }).__GTA_PROF__ = {
    enable: () => { prof.enabled = true; prof.reset(); return 'on'; },
    disable: () => { prof.enabled = false; return 'off'; },
    reset: () => prof.reset(),
    report: () => prof.report(),
  };
}
