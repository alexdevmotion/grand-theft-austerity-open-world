/** Street-facing openings are cuts in the wall, with glazing behind them.
 * All surfaces append to the existing facade/detail batches. No per-window
 * objects, transparent panes, textures or draw calls are introduced. */
import { srgb } from '../../render/materials';
import { FacadeStyle } from './materials';
import { DetailBuilder, FacadeBuilder, type FacadeParams, type Vec2 } from './builders';

const REVEAL = { color: srgb(0x8a8276), mr: [0, 0.91] as [number, number] };
const FRAME = { color: srgb(0xaaa799), mr: [0, 0.68] as [number, number] };
const TIMBER = { color: srgb(0x493b31), mr: [0, 0.82] as [number, number] };
const SILL = { color: srgb(0x77766e), mr: [0, 0.9] as [number, number] };

/** Width, height and vertical centre fractions of the facade grammar bay.
 * Openings include the shader's reveal margin; the pane keeps its original
 * facade UVs so window lighting and room variation still work. */
function windowProfile(style: number): [number, number, number] | null {
  if (style === FacadeStyle.bulevard) return [0.44, 0.52, 0.52];
  if (style === FacadeStyle.cartier) return [0.44, 0.46, 0.55];
  if (style === FacadeStyle.guvern) return [0.34, 0.66, 0.5];
  if (style === FacadeStyle.interbelic) return [0.72, 0.34, 0.66];
  return null;
}

export interface OpeningOptions {
  tier: 0 | 1 | 2;
  /** Outward direction towards the street. Other elevations keep cheap walls. */
  front: { x: number; z: number };
  ground?: boolean;
}

/** Replace a solid extrusion without changing its footprint or collider.
 * A bounded number of lower-floor openings survives even at tier zero because
 * these tiers are baked by city location, not updated as the player moves. */
export function articulatedExtrusion(
  f: FacadeBuilder, d: DetailBuilder, fp: ReadonlyArray<Vec2>,
  y0: number, y1: number, vBase: number, p: FacadeParams, opts: OpeningOptions,
): number {
  const profile = windowProfile(p.style);
  const bay = Math.max(1.2, p.bayW), fh = Math.max(2.4, p.floorH);
  const eligible = fp.map((a, i) => {
    const b = fp[(i + 1) % fp.length], dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    return { a, len, ux: dx / len, uz: dz / len,
      street: len > bay && (-dz * opts.front.x + dx * opts.front.z) / len > 0.25 };
  });
  const streetLength = eligible.reduce((sum, e) => sum + (e.street ? e.len : 0), 0);
  const totalBudget = [12, 36, 72][opts.tier];
  let openings = 0;
  for (const e of eligible) {
    if (e.len < 0.02) continue;
    // Local +depth points outside; a negative depth sinks into the building.
    const P = (u: number, y: number, depth = 0): number[] =>
      [e.a.x + e.ux * u - e.uz * depth, y, e.a.z + e.uz * u + e.ux * depth];
    const wall = (u0: number, u1: number, lo: number, hi: number, depth = 0): void => {
      if (u1 - u0 < 0.001 || hi - lo < 0.001) return;
      f.quad(P(u0, lo, depth), P(u1, lo, depth), P(u1, hi, depth), P(u0, hi, depth),
        [u0, vBase + lo - y0, u1, vBase + lo - y0, u1, vBase + hi - y0, u0, vBase + hi - y0], p);
    };
    if (!e.street) { wall(0, e.len, y0, y1); continue; }
    const edgeBudget = Math.min(totalBudget - openings,
      Math.max(1, Math.floor(totalBudget * e.len / Math.max(1, streetLength))));
    if (edgeBudget <= 0) { wall(0, e.len, y0, y1); continue; }
    let remaining = edgeBudget;
    const aperture = (u0: number, u1: number, lo: number, hi: number, depth: number, ground: boolean): void => {
      const corners = [P(u0, lo), P(u1, lo), P(u1, hi), P(u0, hi)];
      const inner = [P(u0, lo, -depth), P(u1, lo, -depth), P(u1, hi, -depth), P(u0, hi, -depth)];
      // Returns face into the opening. There is no coplanar original wall.
      for (let j = 0; j < 4; j++) {
        const k = (j + 1) % 4;
        d.quad(corners[j], corners[k], inner[k], inner[j], REVEAL);
      }
      wall(u0, u1, lo, hi, -depth);
      const frame = (Math.floor(u0 / bay) + Math.floor(p.seed)) % 4 === 0 ? TIMBER : FRAME;
      const rim = 0.055, frameDepth = -depth + 0.025;
      const trim = (a: number, b: number, c: number, h: number): void =>
        d.quad(P(a, c, frameDepth), P(b, c, frameDepth), P(b, h, frameDepth), P(a, h, frameDepth), frame);
      trim(u0, u0 + rim, lo, hi); trim(u1 - rim, u1, lo, hi);
      trim(u0 + rim, u1 - rim, lo, lo + rim); trim(u0 + rim, u1 - rim, hi - rim, hi);
      const mid = ground ? u0 + (u1 - u0) * 0.27 : (u0 + u1) / 2;
      trim(mid - rim / 2, mid + rim / 2, lo + rim, hi - rim);
      if (ground) trim(u0 + rim, u1 - rim, hi - 0.48, hi - 0.42);
      // Four exposed sill faces; rear/ends are embedded in masonry.
      const s0 = u0 - 0.08, s1 = u1 + 0.08, top = lo - 0.025, bottom = lo - 0.12;
      d.quad(P(s0, top, 0.19), P(s1, top, 0.19), P(s1, top, -depth), P(s0, top, -depth), SILL);
      d.quad(P(s0, bottom, 0.19), P(s1, bottom, 0.19), P(s1, top, 0.19), P(s0, top, 0.19), SILL);
      openings++; remaining--;
    };
    const floorBase = y0 + p.groundH - vBase;
    const groundTop = Math.min(y1, floorBase);
    if (opts.ground !== false && y0 < groundTop && y0 === 0 && p.style !== FacadeStyle.industrial && p.style !== FacadeStyle.plain) {
      const pitch = Math.max(3.8, bay * 2), count = Math.floor(e.len / pitch);
      const n = Math.min(count, Math.max(1, Math.floor(edgeBudget / 4)));
      let cursor = 0;
      for (let k = 0; k < n; k++) {
        const centre = (k + 0.5) * e.len / n;
        const u0 = centre - pitch * 0.38, u1 = centre + pitch * 0.38;
        const lo = 0.22, hi = Math.min(groundTop - 0.65, p.style === FacadeStyle.glassCorporate ? 8.6 : 4.0);
        if (u0 < cursor || u1 > e.len || hi < 1.8) continue;
        wall(cursor, u0, y0, groundTop); wall(u0, u1, y0, lo); wall(u0, u1, hi, groundTop);
        aperture(u0, u1, lo, hi, 0.48, true); cursor = u1;
      }
      wall(cursor, e.len, y0, groundTop);
    } else wall(0, e.len, y0, Math.max(y0, groundTop));
    const firstFloor = Math.max(0, Math.ceil((y0 - floorBase) / fh));
    let bottom = Math.max(y0, floorBase + firstFloor * fh);
    if (bottom > Math.max(y0, groundTop)) wall(0, e.len, Math.max(y0, groundTop), bottom);
    const rows = Math.min([1, 3, 6][opts.tier], Math.floor((y1 - bottom) / fh));
    const columns = Math.floor(e.len / bay);
    for (let row = 0; row < rows && profile && columns > 0; row++) {
      const top = bottom + fh, perRow = Math.min(columns, Math.floor(remaining / (rows - row)));
      const selected = new Set(Array.from({ length: perRow }, (_, k) => Math.floor((k + 0.5) * columns / perRow)));
      let cursor = 0;
      for (let col = 0; col < columns; col++) {
        if (!selected.has(col)) continue;
        const u0 = (col + 0.5) * bay - bay * profile[0] / 2 - 0.065;
        const u1 = (col + 0.5) * bay + bay * profile[0] / 2 + 0.065;
        const lo = bottom + fh * (profile[2] - profile[1] / 2) - 0.055;
        const hi = bottom + fh * (profile[2] + profile[1] / 2) + 0.055;
        wall(cursor, u0, bottom, top); wall(u0, u1, bottom, lo); wall(u0, u1, hi, top);
        aperture(u0, u1, lo, hi, p.style === FacadeStyle.guvern ? 0.36 : 0.24, false);
        cursor = u1;
      }
      wall(cursor, e.len, bottom, top); bottom = top;
    }
    wall(0, e.len, bottom, y1);
  }
  f.cap(fp, y1, p);
  return openings;
}

/** Hipped sheet-metal roof for the surviving low-rise historic fabric.
 * Restrict it to convex quadrilaterals so a ragged OSM courtyard never gets
 * bridged by a roof. Plant and landmark domes use their existing paths. */
export function hippedRoof(d: DetailBuilder, fp: ReadonlyArray<Vec2>, top: number): boolean {
  if (fp.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = fp[i], b = fp[(i + 1) % 4], c = fp[(i + 2) % 4];
    if ((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x) >= -0.001) return false;
  }
  const centre = fp.reduce((c, p) => ({ x: c.x + p.x / 4, z: c.z + p.z / 4 }), { x: 0, z: 0 });
  const minEdge = Math.min(...fp.map((p, i) => Math.hypot(p.x - fp[(i + 1) % 4].x, p.z - fp[(i + 1) % 4].z)));
  if (minEdge < 6) return false;
  const height = Math.min(3.4, minEdge * 0.20);
  const roof = { color: srgb(0x565750), mr: [0.38, 0.77] as [number, number] };
  const seam = { color: srgb(0x70716a), mr: [0.42, 0.64] as [number, number] };
  const lower = fp.map(p => [p.x, top + 0.25, p.z]);
  const upper = fp.map(p => [centre.x + (p.x - centre.x) * 0.50, top + height, centre.z + (p.z - centre.z) * 0.50]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    d.quad(lower[i], lower[j], upper[j], upper[i], roof);
    const length = Math.hypot(fp[j].x - fp[i].x, fp[j].z - fp[i].z);
    const strips = Math.min(10, Math.floor(length / 1.6));
    for (let s = 1; s < strips; s++) {
      const t = s / strips;
      const a = lower[i].map((v, k) => v + (lower[j][k] - v) * t);
      const b = upper[i].map((v, k) => v + (upper[j][k] - v) * t);
      d.tube(a[0], a[1] + 0.015, a[2], b[0], b[1] + 0.015, b[2], 0.022, 3, seam);
    }
  }
  d.quad(upper[0], upper[1], upper[2], upper[3], roof);
  return true;
}
