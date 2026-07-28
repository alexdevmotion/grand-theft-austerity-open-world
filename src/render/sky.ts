/** Sky dome: analytic sunset gradient + horizon glow + procedural cloud deck.
 *  OWNER: sky/atmosphere agent. Must match the reference frame's magenta-orange
 *  cloud bands, violet zenith, and low warm sun. */

import * as THREE from 'three';
import type { GameContext, System } from '../core/engine';
import { Atmosphere, HeroSun, Palette } from '../artDirection';

const vert = /* glsl */ `
varying vec3 vWorldDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldDir = normalize(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const frag = /* glsl */ `
precision highp float;
varying vec3 vWorldDir;

uniform vec3 uSunDir;
uniform vec3 cHorizon, cLow, cMid, cHigh, cZenith;
uniform vec3 cCloudLit, cCloudMid, cCloudShadow, cSunCore;
uniform float uTime;
uniform float uCloudCover;
uniform float uExposure;

float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x),
             mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i=0;i<6;i++){ v += a*noise(p); p *= 2.03; a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vWorldDir);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  float up = clamp(d.y, 0.0, 1.0);

  // Vertical gradient through five authored bands.
  vec3 sky = cHorizon;
  sky = mix(sky, cLow,    smoothstep(0.48, 0.545, h));
  sky = mix(sky, cMid,    smoothstep(0.53, 0.63,  h));
  sky = mix(sky, cHigh,   smoothstep(0.60, 0.78,  h));
  sky = mix(sky, cZenith, smoothstep(0.72, 1.00,  h));

  // Below horizon fades to a dark violet ground haze.
  sky = mix(cCloudShadow * 0.32, sky, smoothstep(0.40, 0.502, h));

  // Sun glow — broad warm scatter plus a soft disc.
  float sd = max(dot(d, uSunDir), 0.0);
  float glow = pow(sd, 5.0) * 0.55 + pow(sd, 40.0) * 0.9;
  float disc = smoothstep(0.9985, 0.9995, sd);
  sky += cSunCore * glow * 1.25;
  sky += cSunCore * disc * 14.0;

  // Horizon band brightening toward the sun azimuth (the orange rip).
  float horizonBand = exp(-abs(d.y) * 14.0);
  float towardSun = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.0);
  sky += mix(cLow, cHorizon, towardSun) * horizonBand * (0.35 + 0.85 * towardSun);

  // Cloud deck — flattened dome projection so clouds converge at the horizon.
  if (d.y > -0.02) {
    vec2 cuv = d.xz / max(d.y + 0.14, 0.055);
    cuv *= 0.30;
    cuv += vec2(uTime * 0.0035, uTime * 0.0018);
    float c1 = fbm(cuv);
    float c2 = fbm(cuv * 2.1 + vec2(3.7, 1.2) + c1 * 0.55);
    float dens = smoothstep(0.42 - uCloudCover * 0.22, 0.86, c1 * 0.65 + c2 * 0.45);

    // Light the clouds from the sun side: lit rims, violet cores.
    float lit = pow(clamp(towardSun * 0.8 + 0.35 - c2 * 0.35, 0.0, 1.0), 1.5);
    vec3 cloud = mix(cCloudShadow, cCloudMid, smoothstep(0.15, 0.7, lit));
    cloud = mix(cloud, cCloudLit, pow(lit, 2.2));
    // Rim ignition near the sun.
    cloud += cSunCore * pow(sd, 8.0) * dens * 0.85;

    float fade = smoothstep(-0.02, 0.10, d.y);
    sky = mix(sky, cloud, dens * fade * 0.94);
  }

  gl_FragColor = vec4(sky * uExposure, 1.0);
}
`;

export class SkySystem implements System {
  readonly name = 'sky';
  readonly order = 10;

  mesh!: THREE.Mesh;
  material!: THREE.ShaderMaterial;
  /** Unit vector pointing at the sun; other systems read this. */
  readonly sunDirection = new THREE.Vector3();

  init(ctx: GameContext): void {
    this.updateSunDirection(HeroSun.elevationDeg, HeroSun.azimuthDeg);

    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
      uniforms: {
        uSunDir: { value: this.sunDirection },
        cHorizon: { value: Palette.skyHorizon },
        cLow: { value: Palette.skyLowBand },
        cMid: { value: Palette.skyMidBand },
        cHigh: { value: Palette.skyHighBand },
        cZenith: { value: Palette.skyZenith },
        cCloudLit: { value: Palette.cloudLit },
        cCloudMid: { value: Palette.cloudMid },
        cCloudShadow: { value: Palette.cloudShadow },
        cSunCore: { value: Palette.sunCore },
        uTime: { value: 0 },
        uCloudCover: { value: 0.58 },
        uExposure: { value: 1.0 },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(2400);
    ctx.scene.add(this.mesh);

    ctx.scene.fog = new THREE.FogExp2(
      Palette.skyMidBand.clone().lerp(Palette.skyLowBand, 0.4).getHex(),
      Atmosphere.fogDensity,
    );
  }

  updateSunDirection(elevationDeg: number, azimuthDeg: number): void {
    const el = THREE.MathUtils.degToRad(elevationDeg);
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDirection.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();
  }

  update(dt: number, ctx: GameContext): void {
    this.material.uniforms.uTime.value += dt;
    // Keep the dome centred on the camera so it never clips.
    this.mesh.position.copy(ctx.camera.position);
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material?.dispose();
  }
}
