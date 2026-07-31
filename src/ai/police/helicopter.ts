/**
 * The five-star helicopter and its searchlight.
 *
 * Procedural geometry, one opaque material and two additive ones. The
 * searchlight is deliberately NOT a real THREE.SpotLight: adding and removing
 * a light re-links every shader program in the scene, which at exactly the
 * moment the fifth star lands would be a visible hitch. An additive cone plus a
 * ground ellipse, both riding the post chain's bloom, read stronger anyway.
 *
 * WHY THE BEAM IS A SHADER AND NOT A FLAT ADDITIVE CONE
 * ----------------------------------------------------
 * It used to be `MeshBasicMaterial({ opacity: 0.14, AdditiveBlending })` on a
 * double-sided cone, with a flat 0.30-alpha disc for the ground pool. Both are
 * VIEW-INDEPENDENT: every fragment of the cone wall contributes the same 0.14
 * whether you are looking along the beam or straight into its side. At five
 * stars the beam is pointed at YOU, so the cone wall faces the lens head-on and
 * fills most of the frame — two double-sided walls stacking additively, plus a
 * hard-edged white ellipse under the car. The result was a milk-white screen
 * with no contrast left in it (see the 17/18/27 playtest frames).
 *
 * The fix is the one `src/vehicles/lights.ts` already uses for headlight cones:
 * a `facing` term, `pow(abs(dot(N, V)), k)`. A volume seen edge-on has a lot of
 * participating medium along the eye ray and reads bright; a volume seen
 * face-on has almost none and must read faint. That single term turns the cone
 * from a painted surface into something with a silhouette. On top of it:
 *
 *  - an axial ramp so the shaft is strongest near the aircraft and dies before
 *    the ground rim (the rim is the pool's job, and a hard rim reads as a lid);
 *  - a near-lens fade, so driving THROUGH the beam does not fog the lens;
 *  - a soft radial pool texture instead of a flat disc, exactly as the wet-road
 *    light pool in `lights.ts` had to learn.
 */

import * as THREE from 'three';
import { Palette } from '../../artDirection';

const BODY = new THREE.Color(0x1a1a22).convertSRGBToLinear();
const TRIM = new THREE.Color(Palette.policeBlue).clone();
const BEAM = new THREE.Color(0xfff0d0).convertSRGBToLinear();

/**
 * Peak beam density, before the axial ramp and the `facing` term take their
 * cut. The old flat material was 0.14 with NO falloff of any kind, so 0.14 was
 * also its average; here the same number is a ceiling that only the silhouette
 * of the cone ever reaches, which is why it can be raised rather than lowered
 * and still read as a fraction of the old wash.
 */
const BEAM_INTENSITY = 0.30;
/** Ground pool peak, at the centre of a soft radial falloff (was a flat 0.30). */
const POOL_INTENSITY = 0.42;
/** …dropped to this while the helicopter has lost the quarry and is sweeping. */
const POOL_SEARCHING = 0.22;

export class PoliceHelicopter {
  readonly object = new THREE.Group();
  private rotor = new THREE.Group();
  private tailRotor = new THREE.Group();
  private beam: THREE.Mesh;
  private pool: THREE.Mesh;
  private beacon: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  private poolTex: THREE.Texture;
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
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: BEAM.clone() },
        uIntensity: { value: BEAM_INTENSITY },
      },
      vertexShader: /* glsl */ `
        varying float vAxis;
        varying vec3 vN;
        varying vec3 vView;
        varying float vDepth;
        void main() {
          // ConeGeometry uv.y is 1 at the apex, 0 at the base, and the cone is
          // built apex-at-origin pointing down the local -Y, so this is
          // "distance travelled from the aircraft", 0..1.
          vAxis = 1.0 - uv.y;
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = normalize(-mv.xyz);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying float vAxis;
        varying vec3 vN;
        varying vec3 vView;
        varying float vDepth;
        void main() {
          // Strongest at the aircraft, thinning down the shaft, and gone
          // before the base ring so the cone has no drawn lid.
          float axial = (1.0 - 0.62 * vAxis)
            * smoothstep(0.0, 0.05, vAxis)
            * smoothstep(1.0, 0.80, vAxis);
          // THE view-dependent term. Edge-on = long path through the medium =
          // bright; face-on = almost no medium = nearly nothing. Without it a
          // beam aimed at the camera is an opaque white wall.
          float facing = pow(abs(dot(normalize(vN), normalize(vView))), 2.1);
          // Driving through the beam must not fog the lens.
          float lens = smoothstep(1.2, 11.0, vDepth);
          float a = axial * facing * lens * uIntensity;
          if (a < 0.003) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.poolTex = poolTexture();
    this.poolMat = new THREE.MeshBasicMaterial({
      color: BEAM, map: this.poolTex, transparent: true, opacity: POOL_INTENSITY,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.disposables.push(this.beamMat, this.poolMat, this.poolTex);

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
    // A searchlight is a NARROW instrument. `max(4, len * 0.09)` gave a 4.1 m
    // radius at the usual 46 m hover, which is an 8 m pool of hard white light
    // centred on a 4 m car — the car was inside its own sun. Half a Dacia's
    // length of penumbra either side is what actually reads as "pinned".
    const radius = THREE.MathUtils.clamp(len * 0.055, 2.6, 5.5);

    // Apex at the aircraft, base on the ground.
    this.beam.position.copy(p);
    this.beam.scale.set(radius, len, radius);
    this.beam.quaternion.setFromUnitVectors(
      DOWN_LOCAL,
      _dir.set(dx / len, dy / len, dz / len),
    );
    this.beamMat.uniforms.uIntensity.value = lost > 1.5
      ? BEAM_INTENSITY * 0.7
      : BEAM_INTENSITY;
    this.pool.position.set(this.lookAt.x, this.lookAt.y + 0.08, this.lookAt.z);
    // The pool is wider than the shaft's base because its falloff is soft: the
    // bright core sits inside the cone's footprint and the rest is spill.
    this.pool.scale.setScalar(radius * 1.9);
    this.poolMat.opacity = lost > 1.5 ? POOL_SEARCHING : POOL_INTENSITY;
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

/**
 * The ground pool, as a soft radial falloff painted to a canvas.
 *
 * A `CircleGeometry` with a flat additive material is a disc of constant
 * brightness with a polygonal edge — a white sticker on the tarmac. Light
 * cast onto a wet street has no edge at all; the alpha has to be off its peak
 * well before the rim and reach zero smoothly, or the eye reads the boundary
 * as an object. The curve below is deliberately convex (the `^2.2`): it holds
 * a small hot core and spends most of the radius in spill.
 */
function poolTexture(): THREE.Texture {
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(N, N);
  const half = N / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x + 0.5 - half, y + 0.5 - half) / half;
      // Plateau out to ~0.28 (the shaft's own footprint sits inside it), then
      // a long smooth spill that is already off its peak well before the rim.
      const t = smoothstep(0.28, 1, r);
      const a = r >= 1 ? 0 : Math.pow(1 - t, 1.5);
      const i = (y * N + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
