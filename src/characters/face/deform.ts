/**
 * DEFORM — scattered-data displacement from landmark correspondences.
 *
 * The head is built once as a smooth analytic base and then pushed toward a
 * subject by a displacement field defined only at the 478 fitted landmarks.
 * Because the base mesh never changes, every character comes out with the same
 * vertex ordering — which is the entire reason for doing it this way: one rig,
 * one blendshape set and one skin shader serve the whole cast, and an identity
 * is a small parameter vector rather than a mesh asset.
 *
 * The interpolant is a normalised Gaussian (Shepard) kernel refined by two
 * residual passes. That converges to interpolation at the landmarks the same
 * way a proper RBF solve does, without a 478x478 linear system, and it cannot
 * blow up or fold the mesh the way an ill-conditioned RBF can. Landmarks are
 * bucketed on a uniform grid so each query only touches its own neighbourhood.
 *
 * OWNER: characters agent.
 */

/** Kernel width, in fitted-face units (1.0 = forehead to chin). */
const SIGMA = 0.048;
/** Queries further than this from every landmark keep the analytic base. */
const REACH = 0.26;
/** Residual refinement passes. Two is enough to be visually exact. */
const REFINE = 3;

const CELL = SIGMA * 2.5;

export interface Field {
  /** Evaluate the displacement at `p`, accumulating into `out`. */
  sample(x: number, y: number, z: number, out: Float32Array): void;
  /** 0 outside the landmark cloud's reach, 1 well inside it. */
  support(x: number, y: number, z: number): number;
}

interface Bucket {
  keys: Int32Array;
}

/**
 * Build a displacement field from `src` -> `dst` point pairs (flat xyz).
 * Both arrays must be the same length; index i in one corresponds to index i
 * in the other.
 */
export function buildField(src: Float32Array, dst: Float32Array): Field {
  const n = src.length / 3;
  const w = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) w[i] = dst[i] - src[i];

  /* ---- spatial buckets over the source points ---- */
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const pad = REACH + CELL;
  minX -= pad; minY -= pad; minZ -= pad;
  const nx = Math.max(1, Math.ceil((maxX + pad - minX) / CELL));
  const ny = Math.max(1, Math.ceil((maxY + pad - minY) / CELL));
  const nz = Math.max(1, Math.ceil((maxZ + pad - minZ) / CELL));

  const cellOf = (x: number, y: number, z: number): number => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / CELL)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / CELL)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / CELL)));
    return (iz * ny + iy) * nx + ix;
  };

  const counts = new Int32Array(nx * ny * nz + 1);
  for (let i = 0; i < n; i++) counts[cellOf(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]) + 1]++;
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const items = new Int32Array(n);
  const cursor = counts.slice(0, counts.length - 1);
  for (let i = 0; i < n; i++) {
    const c = cellOf(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    items[cursor[c]++] = i;
  }
  const bucket: Bucket = { keys: items };

  const inv2s2 = 1 / (2 * SIGMA * SIGMA);
  const reach2 = REACH * REACH;
  const radius = Math.ceil(REACH / CELL);

  /** Raw Shepard evaluation against a given weight table. */
  function evalWeights(
    table: Float32Array, x: number, y: number, z: number, out: Float32Array,
  ): number {
    out[0] = 0; out[1] = 0; out[2] = 0;
    let wsum = 0;
    let best = Infinity;
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / CELL)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / CELL)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / CELL)));
    for (let dz = -radius; dz <= radius; dz++) {
      const cz = iz + dz;
      if (cz < 0 || cz >= nz) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const cy = iy + dy;
        if (cy < 0 || cy >= ny) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const cx = ix + dx;
          if (cx < 0 || cx >= nx) continue;
          const c = (cz * ny + cy) * nx + cx;
          const s = counts[c];
          const e = counts[c + 1];
          for (let k = s; k < e; k++) {
            const i = bucket.keys[k];
            const ddx = x - src[i * 3];
            const ddy = y - src[i * 3 + 1];
            const ddz = z - src[i * 3 + 2];
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 > reach2) continue;
            if (d2 < best) best = d2;
            const wi = Math.exp(-d2 * inv2s2) + 1e-6;
            wsum += wi;
            out[0] += wi * table[i * 3];
            out[1] += wi * table[i * 3 + 1];
            out[2] += wi * table[i * 3 + 2];
          }
        }
      }
    }
    if (wsum > 0) {
      out[0] /= wsum;
      out[1] /= wsum;
      out[2] /= wsum;
    }
    return best;
  }

  /* ---- residual refinement: make the field interpolate the landmarks ---- */
  const tables: Float32Array[] = [w];
  const tmp = new Float32Array(3);
  for (let pass = 0; pass < REFINE; pass++) {
    const residual = new Float32Array(src.length);
    for (let i = 0; i < n; i++) {
      const x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
      let ax = 0, ay = 0, az = 0;
      for (const t of tables) {
        evalWeights(t, x, y, z, tmp);
        ax += tmp[0]; ay += tmp[1]; az += tmp[2];
      }
      residual[i * 3] = w[i * 3] - ax;
      residual[i * 3 + 1] = w[i * 3 + 1] - ay;
      residual[i * 3 + 2] = w[i * 3 + 2] - az;
    }
    tables.push(residual);
  }

  const acc = new Float32Array(3);

  return {
    sample(x: number, y: number, z: number, out: Float32Array): void {
      let ax = 0, ay = 0, az = 0;
      let best = Infinity;
      for (const t of tables) {
        const d2 = evalWeights(t, x, y, z, acc);
        if (d2 < best) best = d2;
        ax += acc[0]; ay += acc[1]; az += acc[2];
      }
      const m = falloff(best);
      out[0] = ax * m;
      out[1] = ay * m;
      out[2] = az * m;
    },
    support(x: number, y: number, z: number): number {
      const d2 = evalWeights(tables[0], x, y, z, acc);
      return falloff(d2);
    },
  };
}

/** Smooth fade so the analytic skull takes over behind the ears and above the brow. */
function falloff(d2: number): number {
  if (!isFinite(d2)) return 0;
  const d = Math.sqrt(d2);
  const t = 1 - Math.min(1, d / REACH);
  return t * t * (3 - 2 * t);
}

/**
 * Distance from `p` to the nearest of `idx` landmarks in `cloud`.
 * Used to paint per-vertex masks (lips, lids, nostrils, creases) without a UV
 * layout: the landmarks already say where every feature is.
 */
export function nearestDist(
  cloud: Float32Array, idx: readonly number[], x: number, y: number, z: number,
): number {
  let best = Infinity;
  for (const i of idx) {
    const dx = x - cloud[i * 3];
    const dy = y - cloud[i * 3 + 1];
    const dz = z - cloud[i * 3 + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Distance to the nearest point on the polyline through `idx`. */
export function distToPolyline(
  cloud: Float32Array, idx: readonly number[], x: number, y: number, z: number, closed = false,
): number {
  let best = Infinity;
  const n = idx.length;
  const last = closed ? n : n - 1;
  for (let s = 0; s < last; s++) {
    const a = idx[s] * 3;
    const b = idx[(s + 1) % n] * 3;
    const ax = cloud[a], ay = cloud[a + 1], az = cloud[a + 2];
    const ex = cloud[b] - ax, ey = cloud[b + 1] - ay, ez = cloud[b + 2] - az;
    const len2 = ex * ex + ey * ey + ez * ez;
    let t = len2 > 1e-9 ? ((x - ax) * ex + (y - ay) * ey + (z - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + ex * t);
    const dy = y - (ay + ey * t);
    const dz = z - (az + ez * t);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}
