/**
 * Vehicle lighting.
 *
 * Two layers:
 *   1. Emissive lamp lenses, driven per vehicle by two vec4 uniforms — free.
 *      Headlights, running lights, brake, reverse, indicators, interior glow
 *      and police strobes are all just uniform writes.
 *   2. A small, strictly LODed pool of *real* light: additive beam cones, a
 *      ground pool splat and a couple of THREE.SpotLight/PointLight instances
 *      handed to whichever vehicles are closest to the camera.
 *
 * Only the nearest few vehicles ever get layer 2, so 40 cars cost 40 uniform
 * writes and at most 6 dynamic lights in the scene.
 */

import * as THREE from 'three';
import { Palette } from '../artDirection';
import type { CarUniforms } from './builder';

export interface LampState {
  /** 0..1 master headlight level. */
  head: number;
  brake: number;
  reverse: number;
  /** -1 left, 0 none, 1 right, 2 hazards. */
  indicator: -1 | 0 | 1 | 2;
  interior: number;
  /** 0..1 police strobe activity. */
  siren: number;
}

const MAX_BEAMS = 3;
const MAX_POINTS = 4;

/* ------------------------------------------------------------------ */
/* Per-vehicle lamp controller                                         */
/* ------------------------------------------------------------------ */

export class VehicleLamps {
  readonly state: LampState = { head: 0, brake: 0, reverse: 0, indicator: 0, interior: 0, siren: 0 };
  private blink = 0;
  private strobe = 0;

  constructor(private uniforms: CarUniforms, private isPolice: boolean) {}

  update(dt: number): void {
    const s = this.state;
    this.blink = (this.blink + dt * 1.55) % 1;
    this.strobe = (this.strobe + dt * 5.2) % 1;

    const on = this.blink < 0.55 ? 1 : 0;
    let indL = 0, indR = 0;
    if (s.indicator === -1) indL = on;
    else if (s.indicator === 1) indR = on;
    else if (s.indicator === 2) { indL = on; indR = on; }

    if (this.isPolice && s.siren > 0) {
      // Alternating double-flash, the classic pattern.
      const p = this.strobe;
      const blue = (p < 0.16 || (p > 0.22 && p < 0.34)) ? 1 : 0;
      const red = (p > 0.5 && p < 0.66) || (p > 0.72 && p < 0.84) ? 1 : 0;
      indL = Math.max(indL, blue * s.siren);
      indR = Math.max(indR, red * s.siren);
    }

    const a = this.uniforms.uChanA.value;
    const b = this.uniforms.uChanB.value;
    a.set(
      s.head * 2.1,
      s.head > 0.02 ? 0.62 : 0.0,
      s.brake * 2.4,
      s.reverse * 1.7,
    );
    b.set(indL * 2.6, indR * 2.6, s.interior * 1.35, 0.8);
  }
}

/* ------------------------------------------------------------------ */
/* Shared beam assets                                                  */
/* ------------------------------------------------------------------ */

let coneGeo: THREE.BufferGeometry | null = null;
let coneMat: THREE.ShaderMaterial | null = null;
let splatGeo: THREE.PlaneGeometry | null = null;
let splatMat: THREE.MeshBasicMaterial | null = null;
let glowTex: THREE.Texture | null = null;

function beamAssets(): { cone: THREE.BufferGeometry; coneMaterial: THREE.ShaderMaterial } {
  if (!coneGeo) {
    const len = 16;
    const g = new THREE.CylinderGeometry(2.5, 0.11, len, 14, 1, true);
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, len * 0.5);
    // Squash vertically so the beam reads like a low dipped headlight.
    g.scale(1, 0.42, 1);
    coneGeo = g;
    coneMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: Palette.sunCore.clone().lerp(new THREE.Color(1, 1, 1), 0.4) },
        uIntensity: { value: 1 },
      },
      vertexShader: /* glsl */ `
        varying float vV;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          vV = uv.y;
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vV;
        varying vec3 vN;
        varying vec3 vView;
        void main() {
          float axial = pow(clamp(1.0 - vV, 0.0, 1.0), 1.7);
          float facing = pow(abs(dot(normalize(vN), normalize(vView))), 1.6);
          float a = axial * facing * uIntensity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }
  return { cone: coneGeo!, coneMaterial: coneMat! };
}

/**
 * Wet-road light pool.
 *
 * The falloff is deliberately long and very soft: a headlight on rain-slicked
 * asphalt is a smeared streak with no edge at all, not a disc. The previous
 * texture peaked at full white in the middle and still had 14% alpha at 70% of
 * the radius, which after additive blending and AgX read as a hard-edged white
 * ellipse painted on the kerb.
 */
function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(N / 2, N / 2, 1, N / 2, N / 2, N / 2 - 1);
  g.addColorStop(0.00, 'rgba(255,236,205,0.85)');
  g.addColorStop(0.18, 'rgba(255,222,178,0.44)');
  g.addColorStop(0.40, 'rgba(255,198,140,0.17)');
  g.addColorStop(0.66, 'rgba(255,176,116,0.05)');
  g.addColorStop(0.86, 'rgba(255,166,104,0.012)');
  g.addColorStop(1.00, 'rgba(255,160,100,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, N, N);
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

function splatAssets(): { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial } {
  if (!splatGeo) {
    splatGeo = new THREE.PlaneGeometry(1, 1);
    splatMat = new THREE.MeshBasicMaterial({
      map: glowTexture(),
      // Warm, and well under 1.0 in linear so the pool can never on its own
      // push a pixel past the tonemapper's shoulder. Bloom does the glare.
      color: new THREE.Color(0.72, 0.52, 0.32),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      opacity: 1,
    });
  }
  return { geo: splatGeo!, mat: splatMat! };
}

/* ------------------------------------------------------------------ */
/* Contact shadow                                                      */
/* ------------------------------------------------------------------ */

let contactGeo: THREE.PlaneGeometry | null = null;
let contactMat: THREE.MeshBasicMaterial | null = null;

function contactTexture(): THREE.Texture {
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const c = cv.getContext('2d')!;
  // Elliptical core (the footprint between the wheels) with a long soft skirt.
  const g = c.createRadialGradient(N / 2, N / 2, N * 0.06, N / 2, N / 2, N * 0.5);
  g.addColorStop(0.00, 'rgba(255,255,255,0.92)');
  g.addColorStop(0.34, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.30)');
  g.addColorStop(0.84, 'rgba(255,255,255,0.07)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A vehicle standing on a mirror-bright wet lane with nothing under it floats.
 * Every vehicle gets one of these: a ground-plane gradient decal in the violet
 * of `Palette.asphaltWet`, sharing one geometry and one material across the
 * whole city.
 */
export function contactShadowAssets(): { geo: THREE.PlaneGeometry; mat: THREE.MeshBasicMaterial } {
  if (!contactGeo) {
    contactGeo = new THREE.PlaneGeometry(1, 1);
    contactMat = new THREE.MeshBasicMaterial({
      map: contactTexture(),
      color: Palette.asphaltWet.clone().lerp(Palette.skyAmbient, 0.18),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
    });
  }
  return { geo: contactGeo!, mat: contactMat! };
}

/* ------------------------------------------------------------------ */
/* Beam rig                                                            */
/* ------------------------------------------------------------------ */

class Beam {
  readonly group = new THREE.Group();
  private cones: THREE.Mesh[] = [];
  private splat: THREE.Mesh;
  spot: THREE.SpotLight | null = null;
  private spotTarget = new THREE.Object3D();

  constructor(withSpot: boolean) {
    const { cone, coneMaterial } = beamAssets();
    // Each rig owns its materials so per-beam intensity doesn't fight.
    const myCone = coneMaterial.clone();
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(cone, myCone);
      m.frustumCulled = false;
      m.renderOrder = 6;
      this.cones.push(m);
      this.group.add(m);
    }
    const sa = splatAssets();
    this.splat = new THREE.Mesh(sa.geo, sa.mat.clone());
    this.splat.rotation.x = -Math.PI / 2;
    this.splat.renderOrder = 5;
    this.splat.frustumCulled = false;
    this.group.add(this.splat);

    if (withSpot) {
      this.spot = new THREE.SpotLight(0xffe6c0, 0, 46, 0.66, 0.85, 1.5);
      this.spot.castShadow = false;
      this.group.add(this.spot);
      this.group.add(this.spotTarget);
      this.spot.target = this.spotTarget;
    }
    // NOTE: the group itself must stay permanently visible.
    //
    // `numSpotLights` is part of three's program cache key, and
    // WebGLRenderer.projectObject skips invisible subtrees entirely — so
    // hiding a group that contains a SpotLight changes the scene's spot count
    // and re-links EVERY lit material in the frame. With beams popping on and
    // off per vehicle per frame that is a continuous shader rebuild storm
    // (observed as `programs` drifting 71-90 at runtime).
    //
    // Visibility is therefore expressed on the visual children only, and the
    // spot is silenced with `intensity = 0`, which keeps the light in the
    // scene's light list and the program cache stable. The same hazard is
    // documented in ai/police/helicopter.ts and world/props/lights.ts.
    this.setVisualsVisible(false);
    this.group.matrixAutoUpdate = true;
  }

  private setVisualsVisible(v: boolean): void {
    for (const c of this.cones) c.visible = v;
    this.splat.visible = v;
  }

  hide(): void {
    this.setVisualsVisible(false);
    if (this.spot) this.spot.intensity = 0;
  }

  /** Place the rig on a vehicle. `anchors` are local-space lamp positions. */
  apply(
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
    anchors: THREE.Vector3[],
    intensity: number,
    groundY: number,
  ): void {
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);

    for (let i = 0; i < this.cones.length; i++) {
      const c = this.cones[i];
      const a = anchors[Math.min(i, anchors.length - 1)];
      c.position.copy(a);
      c.rotation.set(-0.055, i === 0 ? 0.04 : -0.04, 0);
      c.visible = intensity > 0.02;
      (c.material as THREE.ShaderMaterial).uniforms.uIntensity.value = intensity * 0.13;
    }

    // Pool of light on the tarmac, kept flat in world space. Long and narrow:
    // on a wet road the beam smears down the lane rather than pooling in a disc.
    const localGroundY = groundY - position.y;
    this.splat.position.set(0, localGroundY + 0.03, 8.6);
    _q.copy(quaternion).invert();
    _e.setFromQuaternion(_q, 'YXZ');
    this.splat.rotation.set(-Math.PI / 2 + _e.x, 0, _e.z);
    this.splat.scale.set(5.2, 21.0, 1);
    (this.splat.material as THREE.MeshBasicMaterial).opacity = intensity * 0.20;
    this.splat.visible = intensity > 0.02;

    if (this.spot) {
      // Sit the emitter clear of the car's own bumper. With the lamp anchor
      // buried a few centimetres *behind* the bumper face, a 90cd spot was
      // washing out the entire nose of the vehicle it belonged to.
      this.spot.position.set(0, anchors[0].y + 0.16, anchors[0].z + 1.1);
      this.spotTarget.position.set(0, anchors[0].y - 2.4, anchors[0].z + 18);
      this.spot.intensity = intensity * 26;
    }
  }
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/* ------------------------------------------------------------------ */
/* Pool                                                                */
/* ------------------------------------------------------------------ */

export interface BeamRequest {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  anchors: THREE.Vector3[];
  intensity: number;
  groundY: number;
  distance: number;
  /** Coloured point light for brake glow / siren wash. */
  point?: { colour: THREE.Color; intensity: number; position: THREE.Vector3; range: number };
}

export class VehicleLightPool {
  private beams: Beam[] = [];
  private points: THREE.PointLight[] = [];
  private queue: BeamRequest[] = [];

  constructor(private scene: THREE.Scene, quality: string) {
    const beamCount = quality === 'low' ? 1 : quality === 'medium' ? 2 : MAX_BEAMS;
    const pointCount = quality === 'low' ? 1 : quality === 'medium' ? 2 : MAX_POINTS;
    for (let i = 0; i < beamCount; i++) {
      const b = new Beam(i < 2);
      this.beams.push(b);
      scene.add(b.group);
    }
    for (let i = 0; i < pointCount; i++) {
      const p = new THREE.PointLight(0xff3040, 0, 9, 1.8);
      p.castShadow = false;
      this.points.push(p);
      scene.add(p);
    }
  }

  begin(): void {
    this.queue.length = 0;
  }

  request(r: BeamRequest): void {
    this.queue.push(r);
  }

  end(): void {
    this.queue.sort((a, b) => a.distance - b.distance);

    let bi = 0;
    for (const r of this.queue) {
      if (bi >= this.beams.length) break;
      if (r.intensity <= 0.02) continue;
      this.beams[bi].apply(r.position, r.quaternion, r.anchors, r.intensity, r.groundY);
      bi++;
    }
    for (; bi < this.beams.length; bi++) this.beams[bi].hide();

    let pi = 0;
    for (const r of this.queue) {
      if (pi >= this.points.length) break;
      if (!r.point || r.point.intensity <= 0.01) continue;
      const p = this.points[pi];
      p.position.copy(r.point.position);
      p.color.copy(r.point.colour);
      p.intensity = r.point.intensity;
      p.distance = r.point.range;
      pi++;
    }
    for (; pi < this.points.length; pi++) this.points[pi].intensity = 0;
  }

  dispose(): void {
    for (const b of this.beams) this.scene.remove(b.group);
    for (const p of this.points) this.scene.remove(p);
    this.beams.length = 0;
    this.points.length = 0;
  }
}
