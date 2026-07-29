/**
 * The five-star helicopter and its searchlight.
 *
 * Procedural geometry, one opaque material and two additive ones. The
 * searchlight is deliberately NOT a real THREE.SpotLight: adding and removing
 * a light re-links every shader program in the scene, which at exactly the
 * moment the fifth star lands would be a visible hitch. An additive cone plus a
 * ground ellipse, both riding the post chain's bloom, read stronger anyway.
 */

import * as THREE from 'three';
import { Palette } from '../../artDirection';

const BODY = new THREE.Color(0x1a1a22).convertSRGBToLinear();
const TRIM = new THREE.Color(Palette.policeBlue).clone();
const BEAM = new THREE.Color(0xfff0d0).convertSRGBToLinear();

export class PoliceHelicopter {
  readonly object = new THREE.Group();
  private rotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private beam: THREE.Mesh;
  private pool: THREE.Mesh;
  private beacon: THREE.Mesh;
  private beamMat: THREE.MeshBasicMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  private beaconMat: THREE.MeshBasicMaterial;
  private spin = 0;
  private beaconPhase = 0;
  private disposables: Array<{ dispose(): void }> = [];

  /** Smoothed hover target. */
  private readonly target = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  /** Where the light is actually pointing (lags the quarry). */
  private readonly lookAt = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshStandardMaterial({ color: BODY, roughness: 0.48, metalness: 0.55 });
    const trim = new THREE.MeshStandardMaterial({
      color: TRIM, roughness: 0.4, metalness: 0.2,
      emissive: TRIM.clone().multiplyScalar(0.5),
    });
    this.disposables.push(mat, trim);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      parent.add(mesh);
      this.disposables.push(geo);
      return mesh;
    };

    // Cabin: a stretched sphere reads better than a box at this distance.
    const cabin = add(new THREE.SphereGeometry(1.35, 12, 9), mat, this.object);
    cabin.scale.set(1.0, 0.92, 1.5);
    const boom = add(new THREE.CylinderGeometry(0.24, 0.13, 4.6, 8), mat, this.object);
    boom.rotation.x = Math.PI / 2;
    boom.position.set(0, 0.35, -3.1);
    const fin = add(new THREE.BoxGeometry(0.12, 1.25, 0.75), mat, this.object);
    fin.position.set(0, 0.95, -5.1);
    const stripe = add(new THREE.BoxGeometry(2.05, 0.24, 1.7), trim, this.object);
    stripe.position.set(0, -0.15, 0.15);

    for (const sx of [-1, 1]) {
      const skid = add(new THREE.CylinderGeometry(0.07, 0.07, 3.2, 6), mat, this.object);
      skid.rotation.x = Math.PI / 2;
      skid.position.set(sx * 0.85, -1.35, 0.1);
      const strut = add(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 5), mat, this.object);
      strut.position.set(sx * 0.72, -0.95, 0.3);
    }

    // Main rotor.
    const mast = add(new THREE.CylinderGeometry(0.11, 0.11, 0.6, 6), mat, this.object);
    mast.position.y = 1.3;
    this.object.add(this.rotor);
    this.rotor.position.y = 1.6;
    for (let i = 0; i < 4; i++) {
      const blade = add(new THREE.BoxGeometry(9.4, 0.05, 0.42), mat, this.rotor);
      blade.rotation.y = (i / 4) * Math.PI * 2;
    }
    this.object.add(this.tailRotor);
    this.tailRotor.position.set(0.18, 0.95, -5.1);
    for (let i = 0; i < 3; i++) {
      const blade = add(new THREE.BoxGeometry(0.06, 1.6, 0.2), mat, this.tailRotor);
      blade.rotation.x = (i / 3) * Math.PI * 2;
    }

    // Rotating beacon under the nose.
    this.beaconMat = new THREE.MeshBasicMaterial({
      color: TRIM, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    });
    this.disposables.push(this.beaconMat);
    this.beacon = add(new THREE.SphereGeometry(0.3, 8, 6), this.beaconMat, this.object);
    this.beacon.position.set(0, -1.05, 1.0);

    // Searchlight: cone from the belly plus a pool on the ground.
    this.beamMat = new THREE.MeshBasicMaterial({
      color: BEAM, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.poolMat = new THREE.MeshBasicMaterial({
      color: BEAM, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    });
    this.disposables.push(this.beamMat, this.poolMat);

    const cone = new THREE.ConeGeometry(1, 1, 18, 1, true);
    cone.translate(0, -0.5, 0);
    this.beam = new THREE.Mesh(cone, this.beamMat);
    this.beam.renderOrder = 6;
    this.beam.frustumCulled = false;
    this.disposables.push(cone);
    scene.add(this.beam);

    const disc = new THREE.CircleGeometry(1, 24);
    disc.rotateX(-Math.PI / 2);
    this.pool = new THREE.Mesh(disc, this.poolMat);
    this.pool.renderOrder = 7;
    this.disposables.push(disc);
    scene.add(this.pool);

    this.object.name = 'ministry-helicopter';
    scene.add(this.object);
  }

  /** Hover above the quarry with real lag, and sweep the light onto them. */
  update(dt: number, quarry: THREE.Vector3, quarryVel: THREE.Vector3, lost: number): void {
    this.spin += dt;
    this.rotor.rotation.y = this.spin * 26;
    this.tailRotor.rotation.x = this.spin * 44;
    this.beaconPhase += dt * 4.4;
    const flash = 0.35 + 0.65 * Math.max(0, Math.sin(this.beaconPhase));
    this.beaconMat.opacity = 0.25 + flash * 0.7;
    this.beacon.scale.setScalar(0.7 + flash * 0.6);

    // Lead the quarry so it does not sit permanently behind them.
    this.target.copy(quarry).addScaledVector(quarryVel, 1.4);
    this.target.y = quarry.y + 46;
    // While searching, orbit the last known position instead of tracking.
    if (lost > 1.5) {
      const a = this.spin * 0.32;
      this.target.x += Math.cos(a) * Math.min(90, 22 + lost * 7);
      this.target.z += Math.sin(a) * Math.min(90, 22 + lost * 7);
    }

    const p = this.object.position;
    const k = Math.min(1, dt * 0.8);
    this.vel.set(
      (this.target.x - p.x) * 0.55,
      (this.target.y - p.y) * 0.9,
      (this.target.z - p.z) * 0.55,
    );
    p.addScaledVector(this.vel, k * 1.9);

    // Nose into the direction of travel, with a bank.
    const heading = Math.atan2(this.vel.x, this.vel.z);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.object.rotation.y += THREE.MathUtils.clamp(
      wrap(heading - this.object.rotation.y), -dt * 1.6, dt * 1.6,
    );
    this.object.rotation.z += (THREE.MathUtils.clamp(-speed * 0.012, -0.28, 0.28) - this.object.rotation.z) * Math.min(1, dt * 2);
    this.object.rotation.x += (THREE.MathUtils.clamp(-speed * 0.006, -0.12, 0.12) - this.object.rotation.x) * Math.min(1, dt * 2);

    // Searchlight: lag onto the quarry so the player can outrun the beam.
    if (lost > 1.5) _sweep.set(this.target.x, quarry.y, this.target.z);
    else _sweep.copy(quarry);
    this.lookAt.lerp(_sweep, Math.min(1, dt * (lost > 1.5 ? 0.7 : 1.9)));
    const dx = this.lookAt.x - p.x;
    const dy = Math.min(-4, this.lookAt.y - p.y);
    const dz = this.lookAt.z - p.z;
    const len = Math.hypot(dx, dy, dz);
    const radius = Math.max(4, len * 0.09);

    // Apex at the aircraft, base on the ground.
    this.beam.position.copy(p);
    this.beam.scale.set(radius, len, radius);
    this.beam.quaternion.setFromUnitVectors(
      DOWN_LOCAL,
      _dir.set(dx / len, dy / len, dz / len),
    );
    this.pool.position.set(this.lookAt.x, this.lookAt.y + 0.08, this.lookAt.z);
    this.pool.scale.setScalar(radius * 1.05);
    this.poolMat.opacity = lost > 1.5 ? 0.16 : 0.32;
  }

  get position(): THREE.Vector3 {
    return this.object.position;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.object);
    scene.remove(this.beam);
    scene.remove(this.pool);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

const DOWN_LOCAL = new THREE.Vector3(0, -1, 0);
const _dir = new THREE.Vector3();
const _sweep = new THREE.Vector3();

function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
