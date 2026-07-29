/**
 * Road-surface decals and particles: tyre skidmarks, tyre smoke, exhaust and
 * impact sparks.
 *
 * Both pools are single pre-allocated meshes with ring-buffer writes — the
 * whole city's rubber and smoke is 2 draw calls, and neither ever allocates at
 * runtime.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Skidmarks                                                           */
/* ------------------------------------------------------------------ */

const SKID_LIFE = 38;

export class SkidmarkPool {
  readonly mesh: THREE.Mesh;
  private pos: THREE.BufferAttribute;
  private birth: THREE.BufferAttribute;
  private strength: THREE.BufferAttribute;
  private head = 0;
  private dirty = false;
  private readonly capacity: number;
  private time = 0;

  constructor(scene: THREE.Scene, capacity = 900) {
    this.capacity = capacity;
    const verts = capacity * 6;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3);
    this.birth = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.strength = new THREE.BufferAttribute(new Float32Array(verts), 1);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.birth.setUsage(THREE.DynamicDrawUsage);
    this.strength.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < verts; i++) this.birth.setX(i, -1e6);
    g.setAttribute('position', this.pos);
    g.setAttribute('aBirth', this.birth);
    g.setAttribute('aStrength', this.strength);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: SKID_LIFE },
        uColor: { value: new THREE.Color(0x0a0810) },
      },
      vertexShader: /* glsl */ `
        attribute float aBirth;
        attribute float aStrength;
        uniform float uTime;
        uniform float uLife;
        varying float vA;
        void main() {
          float age = (uTime - aBirth) / uLife;
          vA = aStrength * clamp(1.0 - age, 0.0, 1.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          if (vA <= 0.004) discard;
          gl_FragColor = vec4(uColor, vA * 0.92);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -6,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
  }

  update(dt: number): void {
    this.time += dt;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = this.time;
    if (this.dirty) {
      this.pos.needsUpdate = true;
      this.birth.needsUpdate = true;
      this.strength.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Lay a strip of rubber between two contact points. */
  segment(from: THREE.Vector3, to: THREE.Vector3, right: THREE.Vector3, width: number, strength: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const base = i * 6;
    const hw = width * 0.5;
    const ax = from.x + right.x * hw, ay = from.y, az = from.z + right.z * hw;
    const bx = from.x - right.x * hw, by = from.y, bz = from.z - right.z * hw;
    const cx = to.x - right.x * hw, cy = to.y, cz = to.z - right.z * hw;
    const dx = to.x + right.x * hw, dy = to.y, dz = to.z + right.z * hw;
    const P = this.pos.array as Float32Array;
    const set = (k: number, x: number, y: number, z: number) => {
      P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z;
    };
    set(base + 0, ax, ay, az);
    set(base + 1, bx, by, bz);
    set(base + 2, cx, cy, cz);
    set(base + 3, ax, ay, az);
    set(base + 4, cx, cy, cz);
    set(base + 5, dx, dy, dz);
    for (let k = 0; k < 6; k++) {
      this.birth.setX(base + k, this.time);
      this.strength.setX(base + k, strength);
    }
    this.dirty = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

/* ------------------------------------------------------------------ */
/* Particles: tyre smoke, exhaust, sparks                              */
/* ------------------------------------------------------------------ */

export type ParticleKind = 'smoke' | 'exhaust' | 'spark' | 'enginesmoke';

const KIND_ID: Record<ParticleKind, number> = { smoke: 0, exhaust: 1, spark: 2, enginesmoke: 3 };

function softSprite(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d')!;
  const g = c.createRadialGradient(32, 32, 1, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ParticlePool {
  readonly points: THREE.Points;
  private pos: THREE.BufferAttribute;
  private vel: THREE.BufferAttribute;
  private data: THREE.BufferAttribute; // birth, life, size, kind
  private head = 0;
  private dirty = false;
  private time = 0;
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity = 900) {
    this.capacity = capacity;
    const g = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.vel = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
    this.data = new THREE.BufferAttribute(new Float32Array(capacity * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.vel.setUsage(THREE.DynamicDrawUsage);
    this.data.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) this.data.setXYZW(i, -1e6, 1, 0, 0);
    g.setAttribute('position', this.pos);
    g.setAttribute('aVel', this.vel);
    g.setAttribute('aData', this.data);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: softSprite() },
        uSmoke: { value: new THREE.Color(0x7c6f86) },
        uExhaust: { value: new THREE.Color(0x4a4356) },
        uSpark: { value: new THREE.Color(0xffbb55) },
        uPixel: { value: 900 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aVel;
        attribute vec4 aData;
        uniform float uTime;
        uniform float uPixel;
        varying float vAge;
        varying float vKind;
        void main() {
          float age = (uTime - aData.x) / aData.y;
          vAge = age;
          vKind = aData.w;
          vec3 p = position + aVel * (uTime - aData.x);
          // sparks arc down, smoke floats up and slows
          float t = uTime - aData.x;
          if (aData.w > 1.5 && aData.w < 2.5) p.y -= 4.2 * t * t;
          else p.y += 0.55 * t * t;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float grow = mix(1.0, 3.4, clamp(age, 0.0, 1.0));
          if (aData.w > 1.5 && aData.w < 2.5) grow = mix(1.0, 0.2, clamp(age, 0.0, 1.0));
          gl_PointSize = aData.z * grow * uPixel / max(0.001, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        uniform vec3 uSmoke;
        uniform vec3 uExhaust;
        uniform vec3 uSpark;
        varying float vAge;
        varying float vKind;
        void main() {
          if (vAge < 0.0 || vAge > 1.0) discard;
          vec4 tex = texture2D(uMap, gl_PointCoord);
          float a = tex.a;
          vec3 col = uSmoke;
          float mul = 0.5;
          if (vKind > 0.5 && vKind < 1.5) { col = uExhaust; mul = 0.34; }
          else if (vKind > 1.5 && vKind < 2.5) { col = uSpark; mul = 2.4; }
          else if (vKind > 2.5) { col = vec3(0.09, 0.08, 0.1); mul = 0.8; }
          float fade = (1.0 - vAge) * (1.0 - vAge);
          float alpha = a * fade * mul;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col * (vKind > 1.5 && vKind < 2.5 ? 2.5 : 1.0), alpha);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });

    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 8;
    this.points.matrixAutoUpdate = false;
    scene.add(this.points);
  }

  update(dt: number, viewportHeight: number): void {
    this.time += dt;
    const u = (this.points.material as THREE.ShaderMaterial).uniforms;
    u.uTime.value = this.time;
    u.uPixel.value = viewportHeight * 0.9;
    if (this.dirty) {
      this.pos.needsUpdate = true;
      this.vel.needsUpdate = true;
      this.data.needsUpdate = true;
      this.dirty = false;
    }
  }

  emit(p: THREE.Vector3, v: THREE.Vector3, kind: ParticleKind, size: number, life: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    this.pos.setXYZ(i, p.x, p.y, p.z);
    this.vel.setXYZ(i, v.x, v.y, v.z);
    this.data.setXYZW(i, this.time, life, size, KIND_ID[kind]);
    this.dirty = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points.removeFromParent();
  }
}
