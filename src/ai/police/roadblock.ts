/**
 * Roadblocks, checkpoints and spike strips.
 *
 * Placed on the road graph *ahead* of where the player is going rather than
 * where they are, so at four stars the city starts closing in front of you
 * instead of merely chasing behind. Everything here is procedural geometry on
 * shared material instances — a strip costs two draw calls.
 */

import * as THREE from 'three';
import { Palette } from '../../artDirection';
import type {
  CityService,
  Faction,
  VehicleClass,
  VehicleHandle,
  VehicleService,
} from '../../core/services';

/* ------------------------------------------------------------------ */
/* Shared assets                                                       */
/* ------------------------------------------------------------------ */

let stripGeo: THREE.BufferGeometry | null = null;
let toothGeo: THREE.BufferGeometry | null = null;
let stripMat: THREE.MeshStandardMaterial | null = null;
let toothMat: THREE.MeshStandardMaterial | null = null;

function assets(): {
  strip: THREE.BufferGeometry; tooth: THREE.BufferGeometry;
  matA: THREE.MeshStandardMaterial; matB: THREE.MeshStandardMaterial;
} {
  if (!stripGeo) {
    stripGeo = new THREE.BoxGeometry(1, 0.05, 0.62);
    toothGeo = new THREE.ConeGeometry(0.035, 0.17, 5);
    stripMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x1b1620).convertSRGBToLinear(),
      roughness: 0.72, metalness: 0.1,
      emissive: new THREE.Color(Palette.roYellow).multiplyScalar(0.12),
    });
    toothMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x9aa0aa).convertSRGBToLinear(),
      roughness: 0.32, metalness: 0.85,
    });
  }
  return { strip: stripGeo!, tooth: toothGeo!, matA: stripMat!, matB: toothMat! };
}

/* ------------------------------------------------------------------ */

export interface BlockadeOptions {
  /** How many vehicles form the block. */
  vehicles: number;
  /** Add a spike strip in front of the vehicles. */
  spikes: boolean;
  kind: VehicleClass;
}

export class Blockade {
  readonly vehicles: VehicleHandle[] = [];
  readonly node: number;
  readonly group: THREE.Group | null = null;
  private teeth: THREE.InstancedMesh | null = null;
  private strip: THREE.Mesh | null = null;
  /** Centre and axis of the spike line. */
  private sx = 0;
  private sz = 0;
  private ax = 1;
  private az = 0;
  private halfWidth = 0;
  spikesArmed = false;
  age = 0;
  readonly position = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    vehicles: VehicleService,
    city: CityService,
    node: number,
    approachX: number,
    approachZ: number,
    opts: BlockadeOptions,
  ) {
    this.node = node;
    const n = city.roadNodes[node];
    const centre = n ? n.position : new THREE.Vector3();
    this.position.copy(centre);

    // Face the oncoming traffic; the block sits across the carriageway.
    const heading = Math.atan2(approachX, approachZ);
    const rx = approachZ;
    const rz = -approachX;
    // Stand off from the junction centre so the player meets the block before
    // they meet the intersection itself.
    const standoff = 13;
    const bx = centre.x - approachX * standoff;
    const bz = centre.z - approachZ * standoff;

    const lanes = Math.max(1, n?.lanes ?? 1);
    const spread = lanes >= 3 ? 4.4 : lanes === 2 ? 3.6 : 3.0;
    for (let i = 0; i < opts.vehicles; i++) {
      const off = (i - (opts.vehicles - 1) / 2) * spread;
      const px = bx + rx * off;
      const pz = bz + rz * off;
      if (city.spatial.isBlocked(px, pz)) continue;
      const gh = city.spatial.groundHeight(px, pz);
      const p = new THREE.Vector3(px, Number.isFinite(gh) ? Math.max(0, gh) : 0, pz);
      // Angled across the road, alternating, so it reads as hastily thrown up.
      const yaw = heading + Math.PI / 2 + (i % 2 ? 0.28 : -0.28);
      const v = vehicles.spawn(opts.kind, p, yaw, {
        faction: 'police' as Faction,
        colorSeed: 1 + i,
      });
      v.setControls(0, 0, true);
      this.vehicles.push(v);
    }

    if (opts.spikes) {
      const a = assets();
      const width = lanes * 3.6 * 2 + 2;
      this.halfWidth = width / 2;
      this.sx = bx - approachX * 9;
      this.sz = bz - approachZ * 9;
      this.ax = rx;
      this.az = rz;

      const g = new THREE.Group();
      g.name = 'police-spikes';
      const strip = new THREE.Mesh(a.strip, a.matA);
      strip.scale.set(width, 1, 1);
      strip.position.set(this.sx, 0.03, this.sz);
      strip.rotation.y = heading;
      strip.castShadow = false;
      strip.receiveShadow = false;
      g.add(strip);
      this.strip = strip;

      const count = Math.max(6, Math.round(width / 0.42));
      const teeth = new THREE.InstancedMesh(a.tooth, a.matB, count);
      teeth.castShadow = false;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      for (let i = 0; i < count; i++) {
        const t = (i / (count - 1) - 0.5) * width;
        m.compose(
          new THREE.Vector3(this.sx + rx * t, 0.12, this.sz + rz * t),
          q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0),
          new THREE.Vector3(1, 1, 1),
        );
        teeth.setMatrixAt(i, m);
      }
      teeth.instanceMatrix.needsUpdate = true;
      teeth.frustumCulled = true;
      g.add(teeth);
      this.teeth = teeth;

      scene.add(g);
      (this as { group: THREE.Group | null }).group = g;
      this.spikesArmed = true;
    }
  }

  /** True on the frame a vehicle drives over the armed strip. */
  testSpikes(v: VehicleHandle): boolean {
    if (!this.spikesArmed) return false;
    const dx = v.position.x - this.sx;
    const dz = v.position.z - this.sz;
    const along = dx * this.ax + dz * this.az;
    if (Math.abs(along) > this.halfWidth) return false;
    const across = dx * this.az - dz * this.ax;
    if (Math.abs(across) > 1.6) return false;
    if (Math.abs(v.speed) < 3) return false;
    this.spikesArmed = false;
    if (this.strip) this.strip.scale.y = 0.4;
    if (this.teeth) this.teeth.visible = false;
    return true;
  }

  dispose(scene: THREE.Scene, vehicles: VehicleService): void {
    for (const v of this.vehicles) vehicles.despawn(v.id);
    this.vehicles.length = 0;
    if (this.group) {
      scene.remove(this.group);
      this.teeth?.dispose();
    }
  }
}

/**
 * Choose a junction to block: far enough ahead of the player to be reachable,
 * roughly in the direction they are travelling, and actually on the network.
 */
export function pickBlockadeNode(
  city: CityService,
  from: THREE.Vector3,
  velocity: THREE.Vector3,
  minDist: number,
  maxDist: number,
  taken: ReadonlySet<number>,
): { node: number; approachX: number; approachZ: number } | null {
  const speed = Math.hypot(velocity.x, velocity.z);
  const dirX = speed > 2 ? velocity.x / speed : 0;
  const dirZ = speed > 2 ? velocity.z / speed : 1;

  let best = -1;
  let bestScore = -Infinity;
  const nodes = city.roadNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n.links.length || taken.has(i)) continue;
    const dx = n.position.x - from.x;
    const dz = n.position.z - from.z;
    const d = Math.hypot(dx, dz);
    if (d < minDist || d > maxDist) continue;
    const facing = (dx * dirX + dz * dirZ) / Math.max(1e-3, d);
    if (facing < 0.55) continue;
    // Prefer big junctions directly in the player's path.
    const score = facing * 100 + n.lanes * 18 - Math.abs(d - (minDist + maxDist) / 2) * 0.4;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return null;
  // Approach direction = from the player toward the junction.
  const n = nodes[best];
  const dx = n.position.x - from.x;
  const dz = n.position.z - from.z;
  const l = Math.hypot(dx, dz) || 1;
  return { node: best, approachX: dx / l, approachZ: dz / l };
}
