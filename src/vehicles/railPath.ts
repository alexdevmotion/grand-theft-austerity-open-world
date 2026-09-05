export interface RailPoint { readonly x: number; readonly z: number }

/** Distance along the verified permanent way, independent of render frames. */
export class RailPath {
  private points: RailPoint[];
  private distances = [0];
  readonly length: number;

  constructor(points: ReadonlyArray<RailPoint>) {
    this.points = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > 1e-6);
    for (let i = 1; i < this.points.length; i++) {
      this.distances.push(this.distances[i - 1] + Math.hypot(
        this.points[i].x - this.points[i - 1].x, this.points[i].z - this.points[i - 1].z,
      ));
    }
    this.length = this.distances[this.distances.length - 1];
  }

  project(x: number, z: number): number {
    let best = Infinity;
    let distance = 0;
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1], b = this.points[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
      const error = (x - a.x - dx * t) ** 2 + (z - a.z - dz * t) ** 2;
      if (error < best) {
        best = error;
        distance = this.distances[i - 1] + t * (this.distances[i] - this.distances[i - 1]);
      }
    }
    return distance;
  }

  sample(distance: number): RailPoint {
    const at = Math.max(0, Math.min(this.length, distance));
    let i = 1;
    while (i < this.points.length - 1 && this.distances[i] < at) i++;
    const a = this.points[i - 1], b = this.points[i] ?? a;
    const t = (at - this.distances[i - 1]) / Math.max(1e-6, (this.distances[i] ?? 0) - this.distances[i - 1]);
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }

  /** Bogies determine body yaw, avoiding a snap at every sampled rail joint. */
  heading(distance: number, bogieHalfSpan: number): number {
    const rear = this.sample(distance - bogieHalfSpan);
    const front = this.sample(distance + bogieHalfSpan);
    return Math.atan2(front.x - rear.x, front.z - rear.z);
  }
}
