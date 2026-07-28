/** Deterministic PRNG. The whole city is generated from seeds, so every
 *  system must use this rather than Math.random() to stay reproducible
 *  across reloads (critical for visual regression screenshots). */
export class Rng {
  private s: number;

  constructor(seed: number | string = 0x9e3779b9) {
    this.s = typeof seed === 'string' ? Rng.hash(seed) : seed >>> 0;
    if (this.s === 0) this.s = 0x6d2b79f5;
  }

  static hash(str: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /** Fork a child stream — lets each subsystem be independent of call order. */
  fork(label: string): Rng {
    return new Rng((this.s ^ Rng.hash(label)) >>> 0);
  }

  /** mulberry32 */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(minInclusive: number, maxExclusive: number): number {
    return Math.floor(this.range(minInclusive, maxExclusive));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))];
  }

  /** Weighted pick. `weights` must be same length as `arr`. */
  weighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** Gaussian-ish via sum of uniforms; mean 0, ~unit stddev. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }
}

/** Cheap 2D value noise for terrain-ish / density variation. Deterministic. */
export function valueNoise2D(x: number, y: number, seed = 1337): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const h = (a: number, b: number) => {
    let n = Math.imul(a ^ seed, 374761393) + Math.imul(b ^ (seed >>> 3), 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const cc = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * u + (cc - a) * v + (a - b - cc + d) * u * v;
}

export function fbm2D(x: number, y: number, octaves = 4, seed = 1337): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(x, y, seed + i * 7919) * amp;
    norm += amp;
    x *= 2.02;
    y *= 2.02;
    amp *= 0.5;
  }
  return sum / norm;
}
