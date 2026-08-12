/**
 * Collision damage: a health model driven by contact impulses plus real mesh
 * deformation.
 *
 * Body geometry is *shared* between every vehicle of the same variant, so a car
 * only pays for its own copy the first time it actually gets hit. After that,
 * each impact pushes vertices in toward the impact point, crumples the normals
 * and scrapes the paint back to primer around the dent.
 */

import * as THREE from 'three';

export interface Dent {
  /** Impact point in the vehicle's local space. */
  p: THREE.Vector3;
  /** Radius of influence, metres. */
  r: number;
  /** Depth, metres. */
  d: number;
}

const PRIMER = new THREE.Color(0x6a4632).convertSRGBToLinear();
const SOOT = new THREE.Color(0x2a2228).convertSRGBToLinear();

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _col = new THREE.Color();

/**
 * Push vertices in toward each dent centre and scrape the paint. Operates on a
 * non-indexed geometry (which is what GeoBuilder produces), so duplicated
 * vertices move together and the mesh never cracks.
 */
export function deform(geo: THREE.BufferGeometry, dents: Dent[], burn = 0): void {
  if (!dents.length && burn <= 0) return;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute | undefined;
  const n = pos.count;
  const weights = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    _a.fromBufferAttribute(pos, i);
    let wSum = 0;
    for (const dent of dents) {
      const dist = _a.distanceTo(dent.p);
      if (dist >= dent.r) continue;
      const t = 1 - dist / dent.r;
      const w = t * t * (3 - 2 * t);
      // Crumple: a little high-frequency ripple so it isn't a smooth bowl.
      const ripple = 1 + 0.35 * Math.sin(_a.x * 21.7 + _a.z * 17.3) * Math.sin(_a.y * 19.1);
      _d.subVectors(dent.p, _a);
      const len = _d.length() || 1;
      _d.multiplyScalar((dent.d * w * ripple) / len);
      _a.add(_d);
      wSum = Math.max(wSum, w);
    }
    if (wSum > 0) {
      pos.setXYZ(i, _a.x, _a.y, _a.z);
      weights[i] = wSum;
    }
  }

  // Blend the shading normals toward the crumpled face normals.
  for (let t = 0; t < n; t += 3) {
    const w = Math.max(weights[t], weights[t + 1], weights[t + 2]);
    if (w <= 0.001) continue;
    _a.fromBufferAttribute(pos, t);
    _b.fromBufferAttribute(pos, t + 1);
    _c.fromBufferAttribute(pos, t + 2);
    _b.sub(_a);
    _c.sub(_a);
    _n.crossVectors(_b, _c);
    if (_n.lengthSq() < 1e-12) continue;
    _n.normalize();
    for (let k = 0; k < 3; k++) {
      _a.fromBufferAttribute(nor, t + k);
      _a.lerp(_n, Math.min(0.95, w * 1.15)).normalize();
      nor.setXYZ(t + k, _a.x, _a.y, _a.z);
    }
  }

  if (col) {
    for (let i = 0; i < n; i++) {
      const w = weights[i];
      if (w <= 0.02 && burn <= 0) continue;
      _col.fromBufferAttribute(col, i);
      if (w > 0.02) _col.lerp(PRIMER, Math.min(0.8, w * 0.85));
      if (burn > 0) _col.lerp(SOOT, burn * 0.7);
      col.setXYZ(i, _col.r, _col.g, _col.b);
    }
    col.needsUpdate = true;
  }

  pos.needsUpdate = true;
  nor.needsUpdate = true;
  geo.computeBoundingSphere();
}

/* ------------------------------------------------------------------ */

export class DamageModel {
  health: number;
  readonly maxHealth: number;
  /** Set when new dents are waiting to be baked into the mesh. */
  private pending: Dent[] = [];
  private applied = 0;
  private owned: THREE.BufferGeometry | null = null;
  private cooldown = 0;
  /** Stops a sustained overlap chewing through the health bar in one frame. */
  private impactLock = 0;

  constructor(maxHealth: number) {
    this.health = maxHealth;
    this.maxHealth = maxHealth;
  }

  get ratio(): number {
    return this.health / this.maxHealth;
  }

  /** 0..1 — how much engine smoke should be pouring out of the bonnet. */
  get smoke(): number {
    return THREE.MathUtils.clamp((0.45 - this.ratio) / 0.45, 0, 1);
  }

  get isWrecked(): boolean {
    return this.health <= 0;
  }

  /**
   * Register a collision. `impulse` is the contact force magnitude reported by
   * Rapier; `localPoint` the impact position in vehicle space.
   * Returns the damage actually applied.
   */
  impact(localPoint: THREE.Vector3, force: number, threshold: number, scale = 1): number {
    // Rapier reports contact force (impulse / dt), so a resting car already
    // registers its own weight. Only the excess over `threshold` is a crash.
    if (this.impactLock > 0) return 0;
    const raw = Math.min(420, Math.max(0, (force - threshold) * 0.0009)) * scale;
    const dmg = Math.min(raw, this.health);
    if (dmg <= 0.5) return 0;
    this.impactLock = 0.22;
    this.health -= dmg;
    if (this.applied < 26) {
      const severity = THREE.MathUtils.clamp(dmg / 160, 0.12, 1);
      this.pending.push({
        p: localPoint.clone(),
        r: 0.34 + severity * 0.62,
        d: 0.03 + severity * 0.135,
      });
      this.applied++;
    }
    return dmg;
  }

  /** Direct damage with no deformation (fire, explosions elsewhere). */
  applyDamage(amount: number): void {
    this.health = THREE.MathUtils.clamp(this.health - amount, 0, this.maxHealth);
  }

  /**
   * Bake queued dents into the mesh. The first call clones the shared geometry
   * so other vehicles of the same variant stay pristine.
   */
  /** Called every fixed step, visible or not. */
  tick(dt: number): void {
    if (this.impactLock > 0) this.impactLock -= dt;
  }

  flush(mesh: THREE.Mesh, dt: number): void {
    this.cooldown -= dt;
    if (!this.pending.length || this.cooldown > 0) return;
    this.cooldown = 0.12;
    if (!this.owned) {
      this.owned = mesh.geometry.clone();
      mesh.geometry = this.owned;
    }
    deform(this.owned, this.pending, this.isWrecked ? 0.75 : 0);
    this.pending.length = 0;
  }

  dispose(): void {
    this.owned?.dispose();
    this.owned = null;
  }
}
