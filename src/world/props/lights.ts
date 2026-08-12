/**
 * Practical lighting for street dressing.
 *
 * Three cooperating pieces, because none of them alone gives the reference's
 * look of sodium heads sitting in wet asphalt:
 *
 *  1. GroundGlow — additive elliptical pools painted on the road under every
 *     lamp, kiosk and shopfront. This is the cheap part and does most of the
 *     work: thousands of pools for one draw call.
 *  2. HeadGlow — camera-facing additive flares on the lamp heads themselves,
 *     so a light source reads as a source and not as a bright box.
 *  3. LampLights — a small FIXED pool of real point lights that follows the
 *     camera and lands on the nearest lamps, so nearby geometry actually
 *     receives warm light. The count never changes, which matters: a varying
 *     light count would recompile every shader in the scene.
 *
 * OWNER: props / street-dressing agent.
 */

import * as THREE from 'three';
import { PAL } from '../../render/materials';

export interface LightSourceRef {
  x: number;
  z: number;
}

const HIDDEN_INSTANCE = new THREE.Matrix4().makeScale(0, 0, 0);

function sourceMatches(source: LightSourceRef | null, x: number, z: number, radius: number): boolean {
  if (!source) return false;
  const dx = source.x - x;
  const dz = source.z - z;
  return dx * dx + dz * dz <= radius * radius;
}

/* ------------------------------------------------------------------ */
/* Radial falloff texture                                              */
/* ------------------------------------------------------------------ */

/**
 * The pool a real luminaire throws.
 *
 * A single `pow(1-d, n)` falloff is a soft blob: it has no edge, so at any
 * useful strength it reads as a bruise painted on the tarmac rather than as
 * light landing on it. A real sodium head over a wet road produces THREE
 * distinct things at once, and the pool only reads as light when all three are
 * present:
 *
 *   a bright, fairly small CORE directly under the fitting;
 *   a broad SKIRT that falls off slowly and carries most of the area;
 *   a soft outer edge where the beam runs out, which is what gives the pool a
 *   shape instead of dissolving into fog.
 */
function radialTexture(size: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const d = Math.min(1, Math.hypot(dx, dy));
      const core = Math.pow(Math.max(0, 1 - d / 0.30), 2.2);
      const skirt = Math.pow(Math.max(0, 1 - d), 2.6);
      // Squared cosine roll-off at the rim: the beam edge, not a hard circle.
      const rim = Math.max(0, 1 - d) ** 0.9;
      const v = Math.min(1, core * 0.62 + skirt * 0.55 * rim);
      const o = (y * size + x) * 4;
      const b = Math.round(v * 255);
      data[o] = b;
      data[o + 1] = b;
      data[o + 2] = b;
      data[o + 3] = b;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/* ------------------------------------------------------------------ */
/* Ground pools                                                        */
/* ------------------------------------------------------------------ */

/** Additive light pools lying on the road. One instanced draw call. */
export class GroundGlow {
  private readonly mats: THREE.Matrix4[] = [];
  private readonly cols: THREE.Color[] = [];
  private readonly sources: Array<LightSourceRef | null> = [];
  private readonly enabled: boolean[] = [];
  private readonly texture: THREE.DataTexture;
  readonly material: THREE.MeshBasicMaterial;
  mesh: THREE.InstancedMesh | null = null;

  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler(-Math.PI / 2, 0, 0);
  private readonly _e2 = new THREE.Euler(-Math.PI / 2, 0, 0, 'YXZ');
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();

  constructor() {
    this.texture = radialTexture(128);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -6,
      // NOT vertexColors. Per-instance tint arrives through `instanceColor`,
      // which three enables on its own. Setting `vertexColors` as well makes the
      // shader read a per-VERTEX `color` attribute that this geometry does not
      // have — WebGL then supplies (0,0,0) and every pool multiplies to black,
      // which on an additive material means the entire lighting layer silently
      // renders as nothing at all.
      fog: false,
    });
    this.material.name = 'gta:props-glowpool';
  }

  /** `radius` metres, `strength` scales the additive contribution. */
  add(
    x: number, y: number, z: number, radius: number, color: THREE.Color, strength: number,
    source?: LightSourceRef,
  ): void {
    this._q.setFromEuler(this._e);
    this._p.set(x, y, z);
    this._s.set(radius * 2, radius * 2, 1);
    this.mats.push(this._m.clone().compose(this._p, this._q, this._s));
    this.cols.push(color.clone().multiplyScalar(strength));
    this.sources.push(source ? { ...source } : null);
    this.enabled.push(true);
  }

  /**
   * A long, narrow pool aligned to a direction — the vertical smear a sodium
   * head leaves down wet tarmac.
   *
   * This is the shape the reference frame is actually built on: the road is a
   * mirror, so a lamp is not a round patch on the ground, it is a streak
   * running toward and away from the viewer for 20-30 m. A round pool at 1:1
   * says "damp"; a 1:4 streak says "mirror".
   *
   * `dirX, dirZ` is the road tangent; `len` and `wid` are metres.
   */
  addStreak(
    x: number, y: number, z: number,
    len: number, wid: number,
    dirX: number, dirZ: number,
    color: THREE.Color, strength: number,
    source?: LightSourceRef,
  ): void {
    // The plane is built in XY and laid flat by a -90 deg X rotation, so its
    // local +Y maps to world -Z. Rolling about the (already-rotated) Z axis by
    // the tangent's yaw therefore aligns local +Y with the road direction.
    this._e2.set(-Math.PI / 2, 0, Math.atan2(dirX, dirZ), 'YXZ');
    this._q.setFromEuler(this._e2);
    this._p.set(x, y, z);
    this._s.set(wid, len, 1);
    this.mats.push(this._m.clone().compose(this._p, this._q, this._s));
    this.cols.push(color.clone().multiplyScalar(strength));
    this.sources.push(source ? { ...source } : null);
    this.enabled.push(true);
  }

  get count(): number {
    return this.mats.length;
  }

  /**
   * Day/night gain on the whole pool layer.
   *
   * The pools are baked into one instanced mesh with per-instance colours, so
   * the only live lever is the shared material's own tint — which multiplies
   * every instance. This matters because at the hero hour the sun is still up:
   * a sodium head throws almost nothing you can see on a sunlit road, and
   * running the pools at full night strength was what covered the boulevard in
   * a rash of bright orange ovals in every dusk capture.
   */
  setGain(v: number): void {
    this.material.color.setScalar(Math.max(0, v));
  }

  build(): THREE.InstancedMesh | null {
    const n = this.mats.length;
    if (!n) return null;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    for (let i = 0; i < n; i++) {
      mesh.setMatrixAt(i, this.mats[i]);
      mesh.setColorAt(i, this.cols[i]);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = 'props-lightpools';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    mesh.computeBoundingSphere();
    this.mesh = mesh;
    return mesh;
  }

  disableSourceNear(x: number, z: number, radius: number): number {
    let disabled = 0;
    for (let i = 0; i < this.sources.length; i++) {
      if (!this.enabled[i] || !sourceMatches(this.sources[i], x, z, radius)) continue;
      this.enabled[i] = false;
      this.mesh?.setMatrixAt(i, HIDDEN_INSTANCE);
      disabled++;
    }
    if (disabled && this.mesh) this.mesh.instanceMatrix.needsUpdate = true;
    return disabled;
  }

  enableAllSources(): void {
    if (!this.mesh) {
      this.enabled.fill(true);
      return;
    }
    for (let i = 0; i < this.enabled.length; i++) {
      if (this.enabled[i]) continue;
      this.enabled[i] = true;
      this.mesh.setMatrixAt(i, this.mats[i]);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.mesh?.geometry.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Head flares                                                         */
/* ------------------------------------------------------------------ */

const GLOW_VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec2 aSize;
attribute vec3 aColor;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(aPos, 1.0);
  // Shrink with distance a little slower than perspective so distant lamps
  // stay visible as points rather than vanishing into sub-pixel flicker.
  float d = -mv.z;
  float k = aSize.x * (1.0 + smoothstep(30.0, 260.0, d) * 1.1);
  mv.xy += position.xy * k;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
uniform float uGain;
void main() {
  vec2 d = vUv - 0.5;
  float r = length(d) * 2.0;
  // A real luminaire is a small bright FITTING with a modest halo, not a ball
  // of bloom. The tight lobe is the lamp itself and carries almost all of the
  // energy; the wide one is scatter in the air and in the lens, and it has to
  // stay dim or every lamp in the city turns into a glowing orb.
  float lamp = pow(max(0.0, 1.0 - r / 0.34), 2.0);
  float halo = pow(max(0.0, 1.0 - r), 3.4);
  float streak = pow(max(0.0, 1.0 - abs(d.y) * 11.0), 3.0) * pow(max(0.0, 1.0 - abs(d.x) * 1.8), 2.0);
  float a = lamp * 0.85 + halo * 0.20 + streak * 0.16;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a * uGain, 1.0);
}
`;

/** Camera-facing additive flares on every emissive head. One draw call. */
export class HeadGlow {
  private readonly pos: number[] = [];
  private readonly size: number[] = [];
  private readonly col: number[] = [];
  private readonly sources: Array<LightSourceRef | null> = [];
  private readonly enabled: boolean[] = [];
  private readonly uniforms = { uGain: { value: 1.0 } };
  mesh: THREE.Mesh | null = null;

  add(
    x: number, y: number, z: number, radius: number, color: THREE.Color, strength: number,
    source?: LightSourceRef,
  ): void {
    this.pos.push(x, y, z);
    this.size.push(radius, radius);
    this.col.push(color.r * strength, color.g * strength, color.b * strength);
    this.sources.push(source ? { ...source } : null);
    this.enabled.push(true);
  }

  get count(): number {
    return this.pos.length / 3;
  }

  build(): THREE.Mesh | null {
    const n = this.count;
    if (!n) return null;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.attributes.position = base.attributes.position;
    geo.attributes.uv = base.attributes.uv;
    geo.instanceCount = n;
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(this.size), 2));
    geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(this.col), 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: GLOW_VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    mat.name = 'gta:props-headglow';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'props-headglow';
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.mesh = mesh;
    base.dispose();
    return mesh;
  }

  disableSourceNear(x: number, z: number, radius: number): number {
    const size = this.mesh?.geometry.getAttribute('aSize');
    let disabled = 0;
    for (let i = 0; i < this.sources.length; i++) {
      if (!this.enabled[i] || !sourceMatches(this.sources[i], x, z, radius)) continue;
      this.enabled[i] = false;
      size?.setXY(i, 0, 0);
      disabled++;
    }
    if (disabled && size) size.needsUpdate = true;
    return disabled;
  }

  enableAllSources(): void {
    const size = this.mesh?.geometry.getAttribute('aSize');
    for (let i = 0; i < this.enabled.length; i++) {
      if (this.enabled[i]) continue;
      this.enabled[i] = true;
      size?.setXY(i, this.size[i * 2], this.size[i * 2 + 1]);
    }
    if (size) size.needsUpdate = true;
  }

  /** Lamps burn brighter after dusk. */
  setGain(v: number): void {
    this.uniforms.uGain.value = v;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    (this.mesh?.material as THREE.Material | undefined)?.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Real point lights, pooled                                           */
/* ------------------------------------------------------------------ */

export interface LampSite {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
  intensity: number;
  distance: number;
}

/**
 * A fixed-size pool of point lights that migrates to whichever registered lamp
 * sites are nearest the camera. Fixed size is not an optimisation detail — a
 * changing light count invalidates every compiled program in the scene.
 */
export class LampLights {
  private readonly lights: THREE.PointLight[] = [];
  private readonly sites: Array<LampSite & { source: LightSourceRef | null; active: boolean }> = [];
  private readonly cam = new THREE.Vector3();
  private readonly order: number[] = [];
  private accum = 0;
  private gain = 1;
  private readonly assigned: number[] = [];

  constructor(readonly size: number, parent: THREE.Object3D) {
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffb14a, 0, 26, 2);
      l.castShadow = false;
      l.name = `props-lamp-${i}`;
      parent.add(l);
      this.lights.push(l);
      this.assigned.push(-1);
    }
  }

  register(site: LampSite, source?: LightSourceRef): void {
    this.sites.push({ ...site, source: source ? { ...source } : null, active: true });
  }

  get siteCount(): number {
    return this.sites.length;
  }

  setGain(v: number): void {
    this.gain = v;
  }

  /** Re-sorts a few times a second; lights lerp nowhere, they just re-home. */
  update(dt: number, camera: THREE.Object3D): void {
    this.accum += dt;
    if (this.accum < 0.25 || this.sites.length === 0) return;
    this.accum = 0;
    camera.getWorldPosition(this.cam);

    // Partial selection: find the `size` nearest sites without a full sort.
    this.order.length = 0;
    const best: number[] = [];
    const bestD: number[] = [];
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (!s.active) continue;
      const dx = s.x - this.cam.x;
      const dz = s.z - this.cam.z;
      const dy = s.y - this.cam.y;
      const d = dx * dx + dy * dy + dz * dz;
      if (best.length < this.size) {
        best.push(i);
        bestD.push(d);
        continue;
      }
      let worst = 0;
      for (let k = 1; k < bestD.length; k++) if (bestD[k] > bestD[worst]) worst = k;
      if (d < bestD[worst]) {
        best[worst] = i;
        bestD[worst] = d;
      }
    }

    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      if (i >= best.length) {
        l.intensity = 0;
        this.assigned[i] = -1;
        continue;
      }
      const s = this.sites[best[i]];
      this.assigned[i] = best[i];
      const d2 = bestD[i];
      l.position.set(s.x, s.y, s.z);
      l.color.copy(s.color);
      l.distance = s.distance;
      // Fade out rather than snap when a lamp is re-homed far away.
      const fade = 1 - Math.min(1, Math.sqrt(d2) / (s.distance * 2.2));
      l.intensity = s.intensity * this.gain * fade * fade;
    }
  }

  disableSourceNear(x: number, z: number, radius: number): number {
    let disabled = 0;
    for (let i = 0; i < this.sites.length; i++) {
      const site = this.sites[i];
      if (!site.active || !sourceMatches(site.source, x, z, radius)) continue;
      site.active = false;
      disabled++;
      for (let k = 0; k < this.assigned.length; k++) {
        if (this.assigned[k] !== i) continue;
        this.assigned[k] = -1;
        this.lights[k].intensity = 0;
      }
    }
    return disabled;
  }

  enableAllSources(): void {
    for (const site of this.sites) site.active = true;
  }

  dispose(): void {
    for (const l of this.lights) l.removeFromParent();
    this.lights.length = 0;
    this.assigned.length = 0;
    this.sites.length = 0;
  }
}

export const SODIUM = PAL.sodiumLamp;
export const SHOP_GLOW = PAL.builderMagenta;
