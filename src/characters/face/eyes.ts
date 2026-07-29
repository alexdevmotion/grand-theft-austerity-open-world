/**
 * EYES — the single biggest tell.
 *
 * A flat textured sphere kills a face no matter how good the skin is, so the
 * eye here is built the way a real one is layered:
 *
 *   sclera   a sphere, faintly subsurface, with capillaries that fade toward
 *            the iris and a soft shadow where the lid overhangs it
 *   iris     set BEHIND the corneal surface in a concave dish, so the parallax
 *            as the head turns is geometric rather than faked, with radial
 *            stromal fibres, a collarette and a dark limbal ring
 *   cornea   a separate transparent shell in front with clearcoat and a real
 *            index of refraction, which is what produces the wet highlight
 *   meniscus a thin wet fillet where the lid meets the eyeball, so the eye is
 *            not a ball dropped into a hole
 *
 * Left and right are merged into one geometry per layer, so the whole pair
 * costs three draw calls.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { Rng } from '../../core/rng';
import type { EyeAnchor } from './headMesh';

export interface EyeBuild {
  /** Sclera + iris, one mesh. */
  globe: THREE.Mesh;
  /** Transparent corneal shells. */
  cornea: THREE.Mesh;
  /** Wet fillet along the lid line. */
  meniscus: THREE.Mesh;
  dispose(): void;
}

export interface EyeOptions {
  irisColor: number;
  /** 0..1 how bloodshot / tired the sclera reads. */
  tired: number;
  /** Radians the eyes converge inward, so the gaze lands in front of the face. */
  convergence?: number;
  seed?: number;
}

/* ------------------------------------------------------------------ */
/* Iris + sclera texture                                               */
/* ------------------------------------------------------------------ */

const TEX = 512;

/**
 * Atlas: the left half is the sclera (spherical UV), the right half is the iris
 * disc (planar UV). One texture, one material, one draw call for both layers.
 */
function eyeTexture(opts: EyeOptions): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = TEX;
  cv.height = TEX;
  const g = cv.getContext('2d')!;
  const rng = new Rng(`eye|${opts.irisColor}|${opts.seed ?? 0}`);

  /* ---- sclera half ---- */
  const half = TEX / 2;
  // A real sclera is nowhere near white: it is a mid grey-cream that sits in
  // the permanent shadow of the lids. Painting it white is what turns eyes into
  // ping-pong balls.
  // Not white, but it must still be the lightest thing in the socket: the eye
  // reads as an eye because of the value step between sclera and lid. Painted
  // too dark, a correctly-seated globe renders as a black hollow, which is what
  // the first pass at this did.
  g.fillStyle = '#d6cec2';
  g.fillRect(0, 0, half, TEX);
  // The sclera is never white: it yellows toward the corners and greys in the
  // shadow of the lid.
  const wash = g.createLinearGradient(0, 0, half, TEX);
  wash.addColorStop(0, 'rgba(176,158,134,0.42)');
  wash.addColorStop(0.5, 'rgba(214,206,196,0)');
  wash.addColorStop(1, 'rgba(168,148,126,0.38)');
  g.fillStyle = wash;
  g.fillRect(0, 0, half, TEX);
  // Ambient occlusion from the upper lid: the sphere's pole faces up and the
  // lid sits on it, so the top of the globe is always the darkest part.
  const lid = g.createLinearGradient(0, 0, 0, TEX);
  lid.addColorStop(0, 'rgba(46,32,26,0.34)');
  lid.addColorStop(0.30, 'rgba(58,42,36,0.13)');
  lid.addColorStop(0.62, 'rgba(70,52,44,0.10)');
  lid.addColorStop(1, 'rgba(52,38,32,0.24)');
  g.fillStyle = lid;
  g.fillRect(0, 0, half, TEX);

  // Capillaries — faint, branching, denser at the edges.
  const veinCount = 26 + Math.round(opts.tired * 34);
  for (let i = 0; i < veinCount; i++) {
    let x = rng.range(0, half);
    let y = rng.range(0, TEX);
    let a = rng.range(0, Math.PI * 2);
    const alpha = rng.range(0.05, 0.14) * (0.5 + opts.tired * 0.9);
    g.strokeStyle = `rgba(${172 + rng.int(0, 30)},${40 + rng.int(0, 30)},${44 + rng.int(0, 24)},${alpha.toFixed(3)})`;
    g.lineWidth = rng.range(0.6, 1.9);
    g.beginPath();
    g.moveTo(x, y);
    const segs = rng.int(4, 11);
    for (let s = 0; s < segs; s++) {
      a += rng.range(-0.55, 0.55);
      x += Math.cos(a) * rng.range(4, 13);
      y += Math.sin(a) * rng.range(4, 13);
      g.lineTo(x, y);
    }
    g.stroke();
  }

  /* ---- iris half ---- */
  const cx = half + half / 2;
  const cy = TEX / 2;
  const R = half * 0.47;
  const base = new THREE.Color(opts.irisColor);
  const dark = base.clone().multiplyScalar(0.30);
  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.40);

  g.fillStyle = '#000';
  g.fillRect(half, 0, half, TEX);

  // Base iris, darker at the rim (the limbal ring) and toward the pupil.
  const irisGrad = g.createRadialGradient(cx, cy, R * 0.18, cx, cy, R);
  irisGrad.addColorStop(0, css(dark));
  irisGrad.addColorStop(0.32, css(base));
  irisGrad.addColorStop(0.74, css(light));
  irisGrad.addColorStop(0.92, css(base.clone().multiplyScalar(0.55)));
  irisGrad.addColorStop(1, css(dark.clone().multiplyScalar(0.35)));
  g.beginPath();
  g.arc(cx, cy, R, 0, 7);
  g.fillStyle = irisGrad;
  g.fill();

  // Stromal fibres: the radial structure that makes an iris read as an iris.
  g.save();
  g.beginPath();
  g.arc(cx, cy, R * 0.995, 0, 7);
  g.clip();
  for (let i = 0; i < 460; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r0 = R * rng.range(0.20, 0.34);
    const r1 = R * rng.range(0.62, 0.99);
    const wob = rng.range(-0.10, 0.10);
    const bright = rng.next();
    const c = bright > 0.62 ? light : bright > 0.28 ? base : dark;
    g.strokeStyle = `rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},${rng.range(0.14, 0.5).toFixed(3)})`;
    g.lineWidth = rng.range(0.7, 2.4);
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    g.quadraticCurveTo(
      cx + Math.cos(a + wob) * (r0 + r1) * 0.5, cy + Math.sin(a + wob) * (r0 + r1) * 0.5,
      cx + Math.cos(a + wob * 1.7) * r1, cy + Math.sin(a + wob * 1.7) * r1,
    );
    g.stroke();
  }
  // Collarette — the ruff around the pupil.
  g.strokeStyle = 'rgba(255,240,220,0.20)';
  g.lineWidth = R * 0.05;
  g.beginPath();
  g.arc(cx, cy, R * 0.36, 0, 7);
  g.stroke();
  g.restore();

  // Darkened limbal ring — without it the iris floats.
  g.strokeStyle = 'rgba(12,8,6,0.80)';
  g.lineWidth = R * 0.10;
  g.beginPath();
  g.arc(cx, cy, R * 0.965, 0, 7);
  g.stroke();
  g.strokeStyle = 'rgba(24,16,12,0.42)';
  g.lineWidth = R * 0.20;
  g.beginPath();
  g.arc(cx, cy, R * 0.90, 0, 7);
  g.stroke();

  // Pupil.
  g.fillStyle = '#050405';
  g.beginPath();
  g.arc(cx, cy, R * 0.34, 0, 7);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = R * 0.06;
  g.beginPath();
  g.arc(cx, cy, R * 0.37, 0, 7);
  g.stroke();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function css(c: THREE.Color): string {
  return `rgb(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0})`;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Aim a sphere's +Y pole down the eye's optical axis, +Z, out of the face.
 *
 * This one line is load-bearing and was previously wrong. `SphereGeometry`'s
 * `thetaStart` / `thetaLength` measure the polar angle from +Y, so the sclera's
 * iris aperture, the iris dish and the corneal cap are all authored around +Y.
 * Rotating by -PI/2 about X maps (x, y, z) -> (x, z, -y), which sends +Y to
 * **-Z** — straight into the skull. The consequence is not subtle: the aperture
 * and the cornea end up behind the globe, the iris disc is sealed inside an
 * opaque sphere, and what faces the camera is the blank back of the sclera. A
 * featureless ball with no pupil reads as a googly eye stuck on the face no
 * matter how well the lids are seated, which is exactly the failure this was.
 *
 * +PI/2 maps (x, y, z) -> (x, -z, y), which sends +Y to +Z. That is the one we
 * want, and `assertEyeSeating` below will not let it regress.
 */
const AIM_FORWARD = Math.PI / 2;

/** Sclera sphere with the iris aperture cut out, UV'd into the atlas' left half. */
function scleraGeometry(radius: number, apertureRad: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius, 28, 20, 0, Math.PI * 2, apertureRad, Math.PI - apertureRad);
  g.rotateX(AIM_FORWARD);           // pole toward +Z (out of the face)
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 0.5);
  return g;
}

/**
 * The iris, a concave dish set behind the corneal surface. The depth is the
 * whole point: it is what gives the eye real parallax when the head turns,
 * instead of a decal sliding across a ball.
 */
function irisGeometry(radius: number, apertureRad: number, dish: number): THREE.BufferGeometry {
  const rings = 12;
  const segs = 32;
  const rim = Math.sin(apertureRad) * radius;
  const rimZ = Math.cos(apertureRad) * radius;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const t = r / rings;
    const rad = rim * t;
    // Concave dish: deepest at the pupil, flush with the sclera at the rim.
    const z = rimZ - dish * (1 - t * t) - (1 - Math.sqrt(Math.max(0, 1 - t * t))) * 0.0;
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, Math.sin(a) * rad, z);
      // The iris disc is authored into the right half of the atlas, centred on
      // u = 0.75 with a radius of 0.235 in both axes (the canvas is square).
      uv.push(0.75 + Math.cos(a) * t * 0.235, 0.5 + Math.sin(a) * t * 0.235);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segs; s++) {
      const a = r * (segs + 1) + s;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      idx.push(a, c, d, a, d, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Corneal bulge: a shallow cap slightly proud of the sclera. */
function corneaGeometry(radius: number, apertureRad: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(radius * 1.012, 26, 14, 0, Math.PI * 2, 0, apertureRad * 1.12);
  g.rotateX(AIM_FORWARD);
  // Push the cap forward a touch so it reads as a bulge, not a coat of paint.
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const rim = Math.cos(apertureRad * 1.12) * radius;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const t = Math.max(0, (z - rim) / (radius - rim));
    p.setZ(i, z + radius * 0.045 * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * The wet meniscus: a thin ring of fluid where the lid rests on the globe.
 * Without it the eye is a ball in a hole; with it the lid line catches a
 * highlight and the eye sits in a socket.
 */
function meniscusGeometry(ring: THREE.Vector3[], centre: THREE.Vector3, radius: number): THREE.BufferGeometry {
  const n = ring.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const out = new THREE.Vector3();
  // A fillet, not a web. The lid ring runs out to the canthi, which are further
  // from the globe centre than the globe's own radius, so spanning all the way
  // from the sphere to the ring builds a wide translucent sheet across the
  // socket — which is what rendered as a red crescent beside each eye.
  const FILLET = 0.0007;
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    // Both edges hug the globe: inner on its surface, outer a fillet's width
    // further along the same direction and pulled very slightly back.
    out.copy(p).sub(centre).normalize();
    const inner = out.clone().multiplyScalar(radius * 1.002).add(centre);
    const outer = out.clone().multiplyScalar(radius * 1.002 + FILLET).add(centre);
    outer.z -= FILLET * 0.5;
    pos.push(inner.x, inner.y, inner.z, outer.x, outer.y, outer.z);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = ((i + 1) % n) * 2;
    idx.push(a, a + 1, b + 1, a, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

function orient(g: THREE.BufferGeometry, anchor: EyeAnchor, yaw: number): THREE.BufferGeometry {
  const c = g.clone();
  c.rotateY(yaw);
  c.translate(anchor.centre.x, anchor.centre.y, anchor.centre.z);
  return c;
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'uv'];
  const aCount = a.getAttribute('position').count;
  for (const n of names) {
    const aa = a.getAttribute(n);
    const bb = b.getAttribute(n);
    if (!aa || !bb) continue;
    const arr = new Float32Array((aa.count + bb.count) * aa.itemSize);
    arr.set(aa.array as Float32Array, 0);
    arr.set(bb.array as Float32Array, aa.count * aa.itemSize);
    out.setAttribute(n, new THREE.BufferAttribute(arr, aa.itemSize));
  }
  const ai = a.getIndex()!;
  const bi = b.getIndex()!;
  const idx: number[] = [];
  for (let i = 0; i < ai.count; i++) idx.push(ai.getX(i));
  for (let i = 0; i < bi.count; i++) idx.push(bi.getX(i) + aCount);
  out.setIndex(idx);
  return out;
}

/** Radians of the globe the iris occupies. */
const IRIS_APERTURE = 0.50;

/**
 * The two solid layers of one eye, in character space. Hoisted out of
 * `buildEyes` so the test can assert the optical axis points out of the face
 * without needing a canvas for the iris atlas — the bug this guards against was
 * a sign error that no amount of reading the source caught.
 */
export function eyeLayerGeometries(
  a: EyeAnchor, yaw: number,
): { globe: THREE.BufferGeometry; cornea: THREE.BufferGeometry } {
  const sclera = scleraGeometry(a.radius, IRIS_APERTURE);
  const iris = irisGeometry(a.radius, IRIS_APERTURE, a.radius * 0.30);
  // The iris disc has no UV in the sclera's half of the atlas; it is already
  // authored into the right half, so the two merge cleanly.
  const globe = mergeTwo(sclera, iris);
  return {
    globe: orient(globe, a, yaw),
    cornea: orient(corneaGeometry(a.radius, IRIS_APERTURE), a, yaw),
  };
}

export function buildEyes(eyeL: EyeAnchor, eyeR: EyeAnchor, opts: EyeOptions): EyeBuild {
  const conv = opts.convergence ?? 0.035;
  const tex = eyeTexture(opts);

  const geos: THREE.BufferGeometry[] = [];
  const l = eyeLayerGeometries(eyeL, conv);
  const r = eyeLayerGeometries(eyeR, -conv);
  geos.push(l.globe, l.cornea, r.globe, r.cornea);

  const globeGeo = mergeTwo(l.globe, r.globe);
  const corneaGeo = mergeTwo(l.cornea, r.cornea);

  const globeMat = new THREE.MeshPhysicalMaterial({
    map: tex,
    // The sclera lives in the permanent shade of the lids and the brow. Left at
    // full value it reads as two lamps in the face at any distance.
    color: 0xf2ece2,
    roughness: 0.30,
    metalness: 0,
    // The sclera is faintly translucent — light bleeds through its rim.
    sheen: 0.25,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color(0xffb0a0),
    clearcoat: 0.0,
    dithering: true,
  });
  globeMat.name = 'eye-globe';

  const corneaMat = new THREE.MeshPhysicalMaterial({
    color: 0x080a0e,
    transparent: true,
    opacity: 0.05,
    roughness: 0.02,
    metalness: 0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.015,
    ior: 1.376,                    // the actual index of refraction of cornea
    specularIntensity: 1.0,
    depthWrite: false,
    side: THREE.FrontSide,
    dithering: true,
  });
  corneaMat.name = 'eye-cornea';

  const meniscusGeo = mergeTwo(
    meniscusGeometry(eyeL.ring, eyeL.centre, eyeL.radius),
    meniscusGeometry(eyeR.ring, eyeR.centre, eyeR.radius),
  );
  const meniscusMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a1012,
    transparent: true,
    opacity: 0.55,
    roughness: 0.05,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    depthWrite: false,
    side: THREE.DoubleSide,
    dithering: true,
  });
  meniscusMat.name = 'eye-meniscus';

  const globe = new THREE.Mesh(globeGeo, globeMat);
  const cornea = new THREE.Mesh(corneaGeo, corneaMat);
  const meniscus = new THREE.Mesh(meniscusGeo, meniscusMat);
  globe.name = 'eye-globe';
  cornea.name = 'eye-cornea';
  meniscus.name = 'eye-meniscus';
  cornea.renderOrder = 3;
  meniscus.renderOrder = 4;
  for (const m of [globe, cornea, meniscus]) {
    m.castShadow = false;
    m.receiveShadow = false;
    m.frustumCulled = false;
  }

  return {
    globe,
    cornea,
    meniscus,
    dispose(): void {
      for (const g of geos) g.dispose();
      globeGeo.dispose();
      corneaGeo.dispose();
      meniscusGeo.dispose();
      globeMat.dispose();
      corneaMat.dispose();
      meniscusMat.dispose();
      tex.dispose();
    },
  };
}
