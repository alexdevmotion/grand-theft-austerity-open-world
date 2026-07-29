/**
 * IMAGE-BASED LIGHTING — the sky dome captured into a PMREM environment map.
 *
 * Rule 4 of the visual target is "the sky is the key light". A hemisphere
 * light cannot express a magenta rip over a violet zenith, so instead the real
 * sky shader is rendered into a small cube target, prefiltered by
 * PMREMGenerator, and installed as `scene.environment`. Glass, chrome, wet
 * asphalt and car paint then reflect the actual sunset rather than a flat tint.
 *
 * Cost is paid only when the sky changes (weather, time of day), never
 * per-frame — a refresh is ~4ms and is throttled and deferred.
 *
 * OWNER: lighting/materials agent.
 */

import * as THREE from 'three';
import { Palette } from '../artDirection';

/** Fallback dome, used only if the real SkySystem mesh cannot be located. */
const FALLBACK_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = normalize(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FALLBACK_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 cHorizon, cLow, cMid, cHigh, cZenith, cSun;
uniform vec3 uSunDir;
void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 s = cHorizon;
  s = mix(s, cLow,    smoothstep(0.480, 0.545, h));
  s = mix(s, cMid,    smoothstep(0.530, 0.630, h));
  s = mix(s, cHigh,   smoothstep(0.600, 0.780, h));
  s = mix(s, cZenith, smoothstep(0.720, 1.000, h));
  float sd = max(dot(d, uSunDir), 0.0);
  s += cSun * (pow(sd, 5.0) * 0.55 + pow(sd, 40.0) * 3.0);
  float band = exp(-abs(d.y) * 13.0);
  vec2 dh = normalize(vec2(d.x, d.z) + 1e-5);
  vec2 sh = normalize(vec2(uSunDir.x, uSunDir.z) + 1e-5);
  float toward = pow(max(dot(dh, sh), 0.0), 2.0);
  s += mix(cLow, cHorizon, toward) * band * (0.3 + 0.9 * toward);
  gl_FragColor = vec4(s, 1.0);
}
`;

export interface EnvProbeOptions {
  /** Cube face resolution handed to PMREMGenerator. 256 is plenty for a sky. */
  resolution?: number;
  /** Minimum seconds between refreshes, however often it is marked dirty. */
  minInterval?: number;
}

export class EnvProbe {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator;
  private probeScene = new THREE.Scene();
  private target: THREE.WebGLRenderTarget | null = null;
  private fallbackMat: THREE.ShaderMaterial | null = null;
  private groundMat: THREE.MeshBasicMaterial | null = null;
  private ownedGeometry: THREE.BufferGeometry[] = [];

  private dirty = true;
  private sinceRefresh = 1e9;
  private minInterval: number;
  private resolution: number;
  private built = false;

  /** The prefiltered environment texture, once built. */
  get texture(): THREE.Texture | null {
    return this.target?.texture ?? null;
  }

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, opts: EnvProbeOptions = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.resolution = opts.resolution ?? 256;
    this.minInterval = opts.minInterval ?? 0.35;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
  }

  /**
   * Builds the probe scene. Prefers a clone of the live sky dome so the IBL
   * always agrees with what the player sees; falls back to an analytic dome
   * built from the art-direction palette.
   */
  build(): void {
    if (this.built) return;
    this.built = true;

    const sky = this.findSkyMesh();
    if (sky) {
      // Shares the live material, so sky uniform changes flow into the probe.
      const clone = new THREE.Mesh(sky.geometry, sky.material);
      clone.frustumCulled = false;
      clone.scale.setScalar(500);
      clone.position.set(0, 0, 0);
      this.probeScene.add(clone);
    } else {
      const geo = new THREE.SphereGeometry(1, 32, 24);
      this.ownedGeometry.push(geo);
      this.fallbackMat = new THREE.ShaderMaterial({
        vertexShader: FALLBACK_VERT,
        fragmentShader: FALLBACK_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        uniforms: {
          cHorizon: { value: Palette.skyHorizon.clone() },
          cLow: { value: Palette.skyLowBand.clone() },
          cMid: { value: Palette.skyMidBand.clone() },
          cHigh: { value: Palette.skyHighBand.clone() },
          cZenith: { value: Palette.skyZenith.clone() },
          cSun: { value: Palette.sunCore.clone() },
          uSunDir: { value: new THREE.Vector3(-0.95, 0.06, -0.31) },
        },
      });
      const mesh = new THREE.Mesh(geo, this.fallbackMat);
      mesh.frustumCulled = false;
      mesh.scale.setScalar(500);
      this.probeScene.add(mesh);
    }

    // Lower hemisphere: a bounce disc so downward-facing surfaces pick up the
    // violet-brown of wet tarmac instead of going black.
    const discGeo = new THREE.PlaneGeometry(1600, 1600);
    this.ownedGeometry.push(discGeo);
    this.groundMat = new THREE.MeshBasicMaterial({
      color: Palette.groundBounce.clone(),
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const disc = new THREE.Mesh(discGeo, this.groundMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -1.0;
    disc.frustumCulled = false;
    this.probeScene.add(disc);
  }

  /** Locates the live sky dome without importing SkySystem across the seam. */
  private findSkyMesh(): THREE.Mesh | null {
    let found: THREE.Mesh | null = null;
    this.scene.traverse((o) => {
      if (found) return;
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.ShaderMaterial;
      if (Array.isArray(mat)) return;
      if (mat && (mat as THREE.ShaderMaterial).isShaderMaterial && mat.uniforms?.uSunDir) {
        found = m;
      }
    });
    return found;
  }

  /** Ask for a refresh on the next opportunity (weather, time of day, quality). */
  markDirty(): void {
    this.dirty = true;
  }

  /** Keeps the fallback dome's sun aligned; harmless when the real sky is used. */
  setSunDirection(d: THREE.Vector3): void {
    const u = this.fallbackMat?.uniforms.uSunDir;
    if (u) (u.value as THREE.Vector3).copy(d);
  }

  /** Throttled refresh. Call once per frame; it decides whether to do work. */
  update(dt: number): void {
    this.sinceRefresh += dt;
    if (!this.dirty || this.sinceRefresh < this.minInterval) return;
    this.refresh();
  }

  /** Renders the sky into a fresh PMREM and installs it as scene.environment. */
  refresh(): void {
    this.build();
    const prev = this.target;
    // near/far must bracket the 500-unit dome.
    this.target = this.pmrem.fromScene(this.probeScene, 0, 1, 2000);
    this.scene.environment = this.target.texture;
    this.scene.environmentIntensity = this.envIntensity;
    prev?.dispose();
    this.dirty = false;
    this.sinceRefresh = 0;
  }

  private envIntensity = 1.0;

  /** Global multiplier on the IBL contribution. */
  setIntensity(v: number): void {
    this.envIntensity = Math.max(0, v);
    this.scene.environmentIntensity = this.envIntensity;
  }

  get intensity(): number {
    return this.envIntensity;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.pmrem.dispose();
    this.fallbackMat?.dispose();
    this.groundMat?.dispose();
    for (const g of this.ownedGeometry) g.dispose();
    this.ownedGeometry.length = 0;
    this.probeScene.clear();
    if (this.scene.environment) this.scene.environment = null;
  }
}
