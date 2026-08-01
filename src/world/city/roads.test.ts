import { describe, expect, test } from 'bun:test';
import { Rng } from '../../core/rng';
import type { DistrictKind } from '../../core/services';
import type { DetailBuilder, FacadeBuilder, SurfaceBuilder } from './builders';
import { buildOsmCity } from './osm';
import { buildOsmStreets, type ChunkSink } from './roads';

interface WalkCollider {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  /** Rotation argument consumed by CitySystem as a quaternion around -rot. */
  rot: number;
}

const noopBuilder = new Proxy<Record<string, () => void>>({}, {
  get: () => () => undefined,
});

const sink = {
  surf: () => noopBuilder as unknown as SurfaceBuilder,
  detail: () => noopBuilder as unknown as DetailBuilder,
  facade: () => noopBuilder as unknown as FacadeBuilder,
} satisfies ChunkSink;

/** Matches the actual quaternion convention in CitySystem.addWalkCollider. */
function colliderContains(c: WalkCollider, x: number, z: number, inset = 0): boolean {
  const ox = x - c.cx;
  const oz = z - c.cz;
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  const lx = ox * cs + oz * sn;
  const lz = -ox * sn + oz * cs;
  return Math.abs(lx) < c.hx - inset && Math.abs(lz) < c.hz - inset;
}

describe('rendered road collision continuity', () => {
  test('raised footway colliders never cross a visible carriageway or its junction seam', () => {
    const city = buildOsmCity({ reserved: [], rng: new Rng('road-seam-test') });
    const colliders: WalkCollider[] = [];
    buildOsmStreets({
      city,
      sink,
      rng: new Rng('road-seam-render'),
      districtAt: () => 'bulevard' as DistrictKind,
      addWalkCollider: (cx, cz, hx, hz, rot) => {
        colliders.push({ cx, cz, hx, hz, rot });
      },
    });

    const cell = 32;
    const grid = new Map<number, WalkCollider[]>();
    const key = (i: number, j: number): number => i * 100003 + j;
    for (const collider of colliders) {
      const radius = Math.hypot(collider.hx, collider.hz);
      const i0 = Math.floor((collider.cx - radius) / cell);
      const i1 = Math.floor((collider.cx + radius) / cell);
      const j0 = Math.floor((collider.cz - radius) / cell);
      const j1 = Math.floor((collider.cz + radius) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          const bucket = grid.get(k);
          if (bucket) bucket.push(collider);
          else grid.set(k, [collider]);
        }
      }
    }

    const examples: string[] = [];
    let collisions = 0;
    let samples = 0;
    for (let edgeIndex = 0; edgeIndex < city.edges.length; edgeIndex++) {
      const edge = city.edges[edgeIndex];
      if (edge.width <= 0) continue;
      const a = city.nodes[edge.a];
      const b = city.nodes[edge.b];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const length = Math.hypot(dx, dz);
      if (length < 1) continue;
      const ux = dx / length;
      const uz = dz / length;
      const px = -uz;
      const pz = ux;
      // Probe the centre and both outer driving bands, including the polygon
      // patch where ribbons meet. Half-metre samples make a thin diagonal wall
      // a deterministic failure rather than a lucky miss.
      const steps = Math.max(1, Math.ceil(length / 0.5));
      for (let step = 0; step <= steps; step++) {
        const t = step / steps;
        for (const lateral of [-edge.width * 0.4, 0, edge.width * 0.4]) {
          const x = a.x + dx * t + px * lateral;
          const z = a.z + dz * t + pz * lateral;
          samples++;
          const bucket = grid.get(key(Math.floor(x / cell), Math.floor(z / cell))) ?? [];
          const hit = bucket.find((c) => colliderContains(c, x, z, 0.04));
          if (hit) {
            const along = (x - a.x) * ux + (z - a.z) * uz;
            collisions++;
            if (examples.length < 20) {
              examples.push(
                `${edgeIndex}@${along.toFixed(1)}/${length.toFixed(1)}m ` +
                `lateral=${lateral.toFixed(1)}m (${x.toFixed(1)},${z.toFixed(1)})`,
              );
            }
            break;
          }
        }
      }
    }

    console.info(
      `[road-seam-test] ${samples} carriageway samples against ${colliders.length} raised footway colliders; ` +
      `${collisions} invisible crossings; examples: ${examples.join(' | ')}`,
    );
    expect(colliders.length).toBeGreaterThan(100);
    expect(collisions).toBe(0);
  }, 20_000);
});
