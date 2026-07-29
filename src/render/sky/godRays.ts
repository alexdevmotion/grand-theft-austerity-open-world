/** Veiling glare around the sun.
 *
 *  Two things happen when a low sun rakes down a boulevard: crepuscular rays
 *  fan out of the cloud gaps (that part lives in the sky shader, where the city
 *  occludes it for free), and the air *between* the camera and the buildings
 *  scatters a haze of light back at the lens. That second part is what this is.
 *
 *  THREE THINGS THE FIRST VERSION GOT WRONG, and how they are fixed here:
 *
 *  1. It sampled value noise on `atan(v.y, v.x) * N`. Polar-angle noise has a
 *     hard seam at the atan branch cut and converges to an infinitely thin
 *     pinwheel at r = 0, so it drew hard-edged geometric wedges radiating from
 *     a singularity. Now the noise is sampled on `normalize(v) * N`, i.e. on
 *     the unit circle in Cartesian space: periodic by construction, no seam,
 *     and it is additionally faded out below r = 0.22 so nothing survives near
 *     the centre.
 *  2. The highest octave was `ang * 39.0` — 39 lobes over 2*pi, one spoke every
 *     9 degrees. That is a starburst, not scattered light. The octave stack now
 *     tops out at 17 lobes and each is heavily smoothed.
 *  3. The quad was `depthTest: false` at renderOrder 3000, so it composited
 *     additively over opaque buildings five metres from the camera. It is now
 *     pinned to the far plane with depth testing ON, exactly like the sky dome,
 *     so it can only brighten pixels where sky is actually visible. Spill onto
 *     neighbouring geometry is bloom's job, and bloom does it correctly.
 */

import * as THREE from 'three';
import { NOISE_GLSL } from './noise';

/** Hard ceiling on the additive term. Above this it stops reading as air. */
const MAX_INTENSITY = 0.12;

const VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  // Pinned to the far plane so the depth test rejects every pixel the city
  // already covers — glare lives in open sky, not on top of a facade.
  gl_Position = vec4(position.xy, 0.999999, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vNdc;

uniform vec2 uSunNdc;
uniform vec2 uAspect;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;

${NOISE_GLSL}

void main() {
  vec2 p = vNdc * uAspect;
  vec2 s = uSunNdc * uAspect;
  vec2 v = p - s;
  float r = length(v);

  // Everything lives within ~12 degrees of the disc; past that it is gone.
  float fall = exp(-r * 6.0);
  if (fall < 0.004) discard;

  // Angular basis sampled ON THE UNIT CIRCLE, not on atan(). Periodic, seamless,
  // and undefined nowhere. Three octaves, top one at 17 lobes.
  vec2 c = v / max(r, 1e-4);
  float streak =
      0.54 * skValue(c *  4.0 + vec2( uTime * 0.013, 11.3))
    + 0.31 * skValue(c *  9.0 + vec2(-uTime * 0.009, 27.9))
    + 0.15 * skValue(c * 17.0 + vec2( uTime * 0.006, 41.1));
  // Wide smoothstep => rolled, soft-shouldered beams instead of hard wedges.
  streak = smoothstep(0.36, 0.88, streak);

  // Kill the r -> 0 singularity: no angular structure at all inside the core.
  float birth = smoothstep(0.0, 0.22, r);
  float core = exp(-r * r * 34.0);

  float a = (streak * birth * fall * 0.55 + fall * 0.20 + core * 0.40) * uIntensity;
  gl_FragColor = vec4(uColor * a, 1.0);
}
`;

export class GodRays {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private _sunView = new THREE.Vector3();
  private _fwd = new THREE.Vector3();
  private _target = 0;
  private _current = 0;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      // Depth-tested against the far plane: only open sky lights up.
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
      uniforms: {
        uSunNdc: { value: new THREE.Vector2(0, 0) },
        uAspect: { value: new THREE.Vector2(1.78, 1) },
        uColor: { value: new THREE.Color(1, 0.6, 0.35) },
        uIntensity: { value: 0 },
        uTime: { value: 0 },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    // After the sky dome (2000) so it composites onto it.
    this.mesh.renderOrder = 3000;
    this.mesh.name = '__skyGodRays__';
    this.mesh.matrixAutoUpdate = false;
  }

  setColor(c: THREE.Color): void {
    (this.mat.uniforms.uColor.value as THREE.Color).copy(c);
  }

  /**
   * @param strength 0..1 art-directed shaft strength (weather + sun height)
   */
  update(dt: number, camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, strength: number): void {
    this.mat.uniforms.uTime.value += dt;
    (this.mat.uniforms.uAspect.value as THREE.Vector2).set(camera.aspect, 1);

    // Project a point along the sun ray. The point sits past the far plane, so
    // its NDC z is meaningless — x/y are still exact, and whether the sun is in
    // front has to come from the view direction, not from the depth.
    const behind = this._fwd.copy(camera.getWorldDirection(this._fwd)).dot(sunDir) <= 0.02;
    this._sunView.copy(sunDir).multiplyScalar(2000).add(camera.position).project(camera);
    const ndc = this.mat.uniforms.uSunNdc.value as THREE.Vector2;
    if (!behind) ndc.set(this._sunView.x, this._sunView.y);

    // Fade out as the sun leaves the frame — no shafts anchored off-screen.
    const off = Math.max(Math.abs(this._sunView.x) - 1, Math.abs(this._sunView.y) - 1, 0);
    const edge = 1 - THREE.MathUtils.smoothstep(off, 0.0, 0.85);

    this._target = behind ? 0 : Math.min(MAX_INTENSITY, strength * edge);
    // Temporal smoothing stops a hard pop when the sun clips a building edge.
    this._current += (this._target - this._current) * Math.min(1, dt * 6);
    this.mat.uniforms.uIntensity.value = this._current;
    this.mesh.visible = this._current > 0.0015;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
