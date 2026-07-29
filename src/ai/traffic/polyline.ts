/**
 * A polyline you can chase: advance a cursor along it as a vehicle moves, ask
 * for a point N metres further on, and read the cross-track error.
 *
 * Used by the police to follow a route from the city's A* over the road graph.
 * Ambient traffic keeps its own lane-exact version in `agent.ts`, because a
 * civilian must sit in a lane while a pursuit unit only has to arrive.
 */

import * as THREE from 'three';

export class Polyline {
  readonly pts: THREE.Vector3[] = [];
  private hx: number[] = [];
  private hz: number[] = [];
  private len: number[] = [];
  cursor = 0;

  get length(): number {
    return this.pts.length;
  }

  set(points: ArrayLike<THREE.Vector3>): void {
    this.pts.length = 0;
    for (let i = 0; i < points.length; i++) this.pts.push(points[i].clone());
    this.rebuild();
    this.cursor = 0;
  }

  private rebuild(): void {
    this.hx.length = 0;
    this.hz.length = 0;
    this.len.length = 0;
    for (let i = 0; i < this.pts.length; i++) {
      const a = this.pts[i];
      const b = this.pts[Math.min(i + 1, this.pts.length - 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz);
      this.hx.push(l > 1e-4 ? dx / l : 0);
      this.hz.push(l > 1e-4 ? dz / l : 1);
      this.len.push(l);
    }
    for (let i = this.pts.length - 1; i > 0; i--) {
      if (this.len[i] < 1e-4) { this.hx[i] = this.hx[i - 1]; this.hz[i] = this.hz[i - 1]; }
    }
  }

  /** Metres of path left in front of the cursor. */
  remaining(px: number, pz: number): number {
    if (this.cursor >= this.pts.length - 1) return 0;
    const a = this.pts[this.cursor];
    let d = Math.max(0, this.len[this.cursor] - ((px - a.x) * this.hx[this.cursor] + (pz - a.z) * this.hz[this.cursor]));
    for (let i = this.cursor + 1; i < this.pts.length - 1; i++) d += this.len[i];
    return d;
  }

  /** Advance past anything behind us and return the signed cross-track error. */
  track(px: number, pz: number): number {
    let guard = 0;
    while (this.cursor < this.pts.length - 1 && guard++ < 16) {
      const a = this.pts[this.cursor];
      const t = ((px - a.x) * this.hx[this.cursor] + (pz - a.z) * this.hz[this.cursor]) / Math.max(0.2, this.len[this.cursor]);
      if (t > 1) { this.cursor++; continue; }
      return (px - a.x) * this.hz[this.cursor] - (pz - a.z) * this.hx[this.cursor];
    }
    const i = Math.max(0, this.pts.length - 1);
    const a = this.pts[i];
    if (!a) return 0;
    return (px - a.x) * this.hz[i] - (pz - a.z) * this.hx[i];
  }

  /** Point `dist` metres along the path from our projection. Heading in `.w`. */
  lookahead(px: number, pz: number, dist: number, out: THREE.Vector3): number {
    let i = this.cursor;
    if (i >= this.pts.length - 1 || !this.pts.length) {
      const a = this.pts[this.pts.length - 1];
      if (!a) { out.set(px, 0, pz); return 0; }
      out.set(a.x, 0, a.z);
      return Math.atan2(this.hx[this.pts.length - 1], this.hz[this.pts.length - 1]);
    }
    const a = this.pts[i];
    let along = (px - a.x) * this.hx[i] + (pz - a.z) * this.hz[i];
    let remain = dist;
    while (i < this.pts.length - 1) {
      const left = this.len[i] - along;
      if (remain <= left) {
        const s = along + remain;
        out.set(this.pts[i].x + this.hx[i] * s, 0, this.pts[i].z + this.hz[i] * s);
        return Math.atan2(this.hx[i], this.hz[i]);
      }
      remain -= Math.max(0, left);
      along = 0;
      i++;
    }
    const last = this.pts[this.pts.length - 1];
    out.set(last.x, 0, last.z);
    return Math.atan2(this.hx[this.pts.length - 1], this.hz[this.pts.length - 1]);
  }
}
