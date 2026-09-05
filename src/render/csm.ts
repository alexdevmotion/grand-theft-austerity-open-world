/**
 * CASCADED SHADOW MAPS.
 *
 * The reference frame is built on long raking shadows thrown by a sun sitting
 * on the horizon. A single shadow map cannot hold both a crisp kerb shadow at
 * the player's feet and a tower shadow 400m down the boulevard, so the view
 * frustum is split into 3-4 depth slices, each with its own shadow camera.
 *
 * This wraps three's `CSM` addon (frustum splitting, texel-snapped light
 * placement, per-cascade shader clipping) and adds the two things it lacks for
 * a real game:
 *
 *  1. AUTOMATIC REGISTRATION. three's CSM requires `setupMaterial()` on every
 *     lit material, and any material it misses is lit N times over — once per
 *     cascade light. Since the city, vehicles, peds and props are authored by
 *     other systems, this class sweeps the scene and registers everything it
 *     finds, so nobody else has to know CSM exists.
 *  2. NON-DESTRUCTIVE SETUP. `setupMaterial()` overwrites `onBeforeCompile`,
 *     which would wipe the wetness/reflection injection from the material
 *     library. Here the previous hook is chained instead.
 *
 * OWNER: lighting/materials agent.
 */

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';

export interface CascadeOptions {
  camera: THREE.PerspectiveCamera;
  parent: THREE.Object3D;
  cascades: number;
  shadowMapSize: number;
  /** Furthest distance that receives shadows. */
  maxFar: number;
  lightDirection: THREE.Vector3;
  lightIntensity: number;
  lightColor: THREE.Color;
  /** Smooth blend between cascades — costs a little, removes the seam. */
  fade?: boolean;
}

/** Materials that actually run the lighting chunk and therefore need CSM. */
function isLit(m: THREE.Material): boolean {
  const a = m as THREE.Material & {
    isMeshStandardMaterial?: boolean;
    isMeshPhysicalMaterial?: boolean;
    isMeshLambertMaterial?: boolean;
    isMeshPhongMaterial?: boolean;
    isMeshToonMaterial?: boolean;
  };
  return !!(
    a.isMeshStandardMaterial ||
    a.isMeshPhysicalMaterial ||
    a.isMeshLambertMaterial ||
    a.isMeshPhongMaterial ||
    a.isMeshToonMaterial
  );
}

interface CascadeUniforms {
  CSM_cascades: { value: THREE.Vector2[] };
  cameraNear: { value: number };
  shadowFar: { value: number };
}
// Three may reuse an already compiled program when returning to a quality
// tier. Its uniforms must follow the current rig, not a disposed rig closure.
const materialUniforms = new WeakMap<THREE.Material, CascadeUniforms>();

export class CascadedShadows {
  private csm: CSM;
  private camera: THREE.PerspectiveCamera;
  private opts: CascadeOptions;

  /** Materials already carrying the CSM defines. */
  private registered = new Map<THREE.Material, {
    previous: THREE.Material['onBeforeCompile'];
    wrapper: THREE.Material['onBeforeCompile'];
    uniforms: CascadeUniforms;
  }>();
  private breaksVec2: THREE.Vector2[] = [];

  private sweepTimer = 0;
  private sweepInterval = 0.4;
  private materialCount = 0;

  constructor(opts: CascadeOptions) {
    this.opts = opts;
    this.camera = opts.camera;

    this.csm = new CSM({
      camera: opts.camera,
      parent: opts.parent,
      cascades: opts.cascades,
      maxFar: opts.maxFar,
      mode: 'practical',
      shadowMapSize: opts.shadowMapSize,
      lightDirection: opts.lightDirection.clone().normalize(),
      lightIntensity: opts.lightIntensity,
      lightNear: 1,
      // Must clear the margin the lights are pushed back by, plus the world.
      lightFar: opts.maxFar * 2.5 + 400,
      lightMargin: Math.max(180, opts.maxFar * 0.6),
    });

    this.csm.fade = opts.fade ?? true;
    this.configureLights();
    this.csm.updateFrustums();
  }

  /** Per-cascade bias, softness and tint. Near cascades get tighter bias. */
  private configureLights(): void {
    const { lightColor, lightIntensity, cascades } = this.opts;
    for (let i = 0; i < this.csm.lights.length; i++) {
      const l = this.csm.lights[i];
      l.color.copy(lightColor);
      l.intensity = lightIntensity;

      const t = cascades > 1 ? i / (cascades - 1) : 0;
      const sh = l.shadow;
      // Acne scales with texel world size, so bias must grow with the cascade.
      sh.bias = -0.00016 - t * 0.0009;
      // Kept small: a large normalBias detaches contact shadows (peter-panning).
      sh.normalBias = 0.018 + t * 0.075;
      sh.radius = i === 0 ? 1.6 : 1.1;
      sh.camera.updateProjectionMatrix();
      // Cascade lights must never be culled out of the render.
      l.frustumCulled = false;
      l.target.frustumCulled = false;
    }
  }

  get lights(): THREE.DirectionalLight[] {
    return this.csm.lights;
  }

  get cascadeCount(): number {
    return this.csm.cascades;
  }

  setSunDirection(d: THREE.Vector3): void {
    this.csm.lightDirection.copy(d).normalize();
  }

  setLight(color: THREE.Color, intensity: number): void {
    this.opts.lightColor.copy(color);
    this.opts.lightIntensity = intensity;
    for (const l of this.csm.lights) {
      l.color.copy(color);
      l.intensity = intensity;
    }
  }

  /** Call after changing camera near/far or shadow distance. */
  updateFrustums(): void {
    this.csm.updateFrustums();
  }

  /* ---------------- material registration ---------------- */

  /**
   * Adds the CSM defines and uniform plumbing to `material`, preserving any
   * existing `onBeforeCompile` (the material library's wetness injection).
   */
  setupMaterial(material: THREE.Material): void {
    if (this.registered.has(material) || !isLit(material)) return;
    this.materialCount++;

    material.defines = material.defines ?? {};
    material.defines.USE_CSM = 1;
    material.defines.CSM_CASCADES = this.csm.cascades;
    if (this.csm.fade) material.defines.CSM_FADE = '';

    this.refreshBreaks();
    let uniforms = materialUniforms.get(material);
    if (!uniforms) {
      uniforms = { CSM_cascades: { value: this.breaksVec2 }, cameraNear: { value: this.camera.near },
        shadowFar: { value: Math.min(this.camera.far, this.csm.maxFar) } };
      materialUniforms.set(material, uniforms);
    }
    uniforms.CSM_cascades.value = this.breaksVec2;
    uniforms.cameraNear.value = this.camera.near;
    uniforms.shadowFar.value = Math.min(this.camera.far, this.csm.maxFar);
    const binding = uniforms;
    const prev = material.onBeforeCompile;
    const self = this;
    material.onBeforeCompile = function (shader, renderer) {
      prev?.call(this, shader, renderer);
      self.refreshBreaks();
      Object.assign(shader.uniforms, binding);
    };
    this.registered.set(material, { previous: prev, wrapper: material.onBeforeCompile, uniforms: binding });

    material.needsUpdate = true;
  }

  /** Rebuilds the [prev, cur] cascade ranges the shader clips against. */
  private refreshBreaks(): void {
    const breaks = this.csm.breaks;
    while (this.breaksVec2.length < breaks.length) this.breaksVec2.push(new THREE.Vector2());
    this.breaksVec2.length = breaks.length;
    for (let i = 0; i < breaks.length; i++) {
      this.breaksVec2[i].set(i === 0 ? 0 : breaks[i - 1], breaks[i]);
    }
  }

  /**
   * Sweeps the scene for materials that have appeared since the last sweep.
   * Throttled — a full traverse at 2.5Hz is far cheaper than the alternative
   * of every other system having to know about the shadow implementation.
   */
  registerScene(scene: THREE.Object3D, force = false): void {
    if (!force && this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepInterval;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
      const mat = mesh.material;
      if (!mat) return;
      if (Array.isArray(mat)) {
        for (const m of mat) this.setupMaterial(m);
      } else {
        this.setupMaterial(mat);
      }
    });
  }

  /** Number of materials currently under CSM control (diagnostics). */
  get registeredMaterials(): number {
    return this.materialCount;
  }

  /* ---------------- per-frame ---------------- */

  /**
   * Positions the cascade lights and pushes the split ranges. Must run after
   * the camera is final — i.e. from `lateUpdate`.
   */
  update(dt: number, scene: THREE.Object3D): void {
    this.sweepTimer -= dt;
    this.registerScene(scene);

    this.csm.update();
    this.refreshBreaks();

    const far = Math.min(this.camera.far, this.csm.maxFar);
    for (const { uniforms } of this.registered.values()) {
      uniforms.CSM_cascades.value = this.breaksVec2;
      uniforms.cameraNear.value = this.camera.near;
      uniforms.shadowFar.value = far;
    }
  }

  dispose(): void {
    // Include materials that were registered but never rendered. Otherwise a
    // quality change leaves old cascade closures on offscreen cached meshes.
    for (const [material, hooks] of this.registered) {
      if (material.onBeforeCompile === hooks.wrapper) material.onBeforeCompile = hooks.previous;
      delete material.defines?.USE_CSM;
      delete material.defines?.CSM_CASCADES;
      delete material.defines?.CSM_FADE;
      material.needsUpdate = true;
    }
    this.registered.clear();
    this.csm.remove();
    this.csm.dispose();
  }
}
