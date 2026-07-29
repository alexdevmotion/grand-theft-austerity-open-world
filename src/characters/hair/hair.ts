/**
 * HAIR — layered alpha cards with Kajiya-Kay specular.
 *
 * A solid blob of hair is one of the eight things that make a head read as a
 * mask, so hair here is three things stacked:
 *
 *   shell     a scalp-hugging mass that gives the volume and the silhouette,
 *             alpha-dissolving at its own edges so it never ends in a hard rim
 *   cards     ribbons of strands that stick out past the shell and break the
 *             outline, each carrying its own tangent for anisotropic specular
 *   flyaways  single thin strands that leave the mass entirely
 *
 * Lighting is Kajiya-Kay with two shifted lobes — a tight white primary and a
 * broad hair-coloured secondary — which is what produces the band of sheen that
 * runs across real hair rather than a plastic dot.
 *
 * Brows, lashes and beard use the same builder with different guides, because
 * they are the same problem at a different scale. Bolojan's heavy dark brows in
 * particular have to be geometry: painted onto the skin they read as make-up,
 * and they are his single most recognisable feature.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { Rng } from '../../core/rng';

/* ------------------------------------------------------------------ */
/* Strand alpha texture                                                */
/* ------------------------------------------------------------------ */

const STRAND_TEX = 256;
let strandCache: THREE.CanvasTexture | null = null;
let shellCache: THREE.CanvasTexture | null = null;

/**
 * The shell's alpha: solid through the mass, dissolving into a ragged strand
 * edge at the hairline. A hard rim where hair meets forehead is what makes
 * cheap hair read as a moulded cap.
 */
export function shellAlphaTexture(): THREE.CanvasTexture {
  if (shellCache) return shellCache;
  const cv = document.createElement('canvas');
  cv.width = STRAND_TEX;
  cv.height = STRAND_TEX;
  const g = cv.getContext('2d')!;
  const rng = new Rng('hair-shell-alpha');

  // Authored OPAQUE, as a greyscale mask. three's `alphaMap` reads the GREEN
  // channel, not the alpha channel, so a canvas painted with varying alpha
  // gives an alphaMap of solid white wherever anything was drawn at all —
  // which erases exactly the parts of the hair that were meant to survive.
  g.fillStyle = '#000';
  g.fillRect(0, 0, STRAND_TEX, STRAND_TEX);
  g.fillStyle = '#fff';
  g.fillRect(0, 0, STRAND_TEX, STRAND_TEX * 0.66);
  const grad = g.createLinearGradient(0, STRAND_TEX * 0.66, 0, STRAND_TEX);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, STRAND_TEX * 0.66, STRAND_TEX, STRAND_TEX * 0.34);
  // Ragged tongues of hair reaching past the average hairline, and bites out of
  // the leading edge, so the hair never ends in a straight line on the forehead.
  g.fillStyle = '#fff';
  for (let i = 0; i < 120; i++) {
    const x = rng.next() * STRAND_TEX;
    const w = rng.range(1.5, 7);
    const y0 = STRAND_TEX * rng.range(0.55, 0.74);
    g.fillRect(x, y0, w, rng.range(10, 62));
  }
  g.fillStyle = '#000';
  for (let i = 0; i < 150; i++) {
    const x = rng.next() * STRAND_TEX;
    const y = STRAND_TEX * rng.range(0.60, 1.0);
    g.beginPath();
    g.arc(x, y, rng.range(2, 12), 0, 7);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  shellCache = tex;
  return tex;
}

/** One card's worth of strands: opaque at the root, dissolving into the tip. */
export function strandTexture(): THREE.CanvasTexture {
  if (strandCache) return strandCache;
  const cv = document.createElement('canvas');
  cv.width = STRAND_TEX;
  cv.height = STRAND_TEX;
  const g = cv.getContext('2d')!;
  const rng = new Rng('hair-strands');

  g.fillStyle = '#000';
  g.fillRect(0, 0, STRAND_TEX, STRAND_TEX);
  const count = 22;
  for (let i = 0; i < count; i++) {
    const x = ((i + rng.range(0.15, 0.85)) / count) * STRAND_TEX;
    const w = rng.range(2.4, 6.5);
    const a = rng.range(0.7, 1.0);
    const grad = g.createLinearGradient(0, 0, 0, STRAND_TEX);
    const v = (k: number): string => {
      const c = Math.round(255 * a * k);
      return `rgb(${c},${c},${c})`;
    };
    grad.addColorStop(0, v(1));
    grad.addColorStop(0.55, v(0.95));
    grad.addColorStop(0.82, v(0.55));
    grad.addColorStop(1, v(0));
    g.fillStyle = grad;
    let cx = x;
    for (let y = 0; y < STRAND_TEX; y += 4) {
      cx += rng.range(-0.9, 0.9);
      g.fillRect(cx - w * 0.5, y, w, 5);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  strandCache = tex;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Kajiya-Kay material                                                 */
/* ------------------------------------------------------------------ */

export interface HairMaterialOptions {
  color: number;
  /** Colour of the secondary (transmitted) lobe — usually the hair colour. */
  tintColor?: number;
  roughness?: number;
  /** Primary highlight sharpness. */
  gloss?: number;
  alphaTest?: number;
  /** Use the solid-with-ragged-edge alpha instead of the strand alpha. */
  shell?: boolean;
  transparent?: boolean;
  depthWrite?: boolean;
  /** Root-to-tip darkening, 0..1. */
  rootDark?: number;
  /** Linear-space colour the grey mix pulls toward. */
  greyTarget?: THREE.Color;
  /** Specular energy. Hair is a dielectric — this belongs near 0.1, not 1. */
  specular?: number;
}

const HAIR_VERT_HEAD = /* glsl */`
attribute vec3 aStrandTangent;
attribute vec2 aStrandInfo;      // x = 0 root .. 1 tip, y = grey mix
varying vec3 vStrandT;
varying vec2 vStrandInfo;
`;

const HAIR_FRAG_HEAD = /* glsl */`
varying vec3 vStrandT;
varying vec2 vStrandInfo;
uniform vec3  uHairTint;
uniform float uHairGloss;
uniform float uHairShiftA;
uniform float uHairShiftB;
uniform float uHairRootDark;
uniform vec3  uHairGrey;
uniform float uHairSpec;
`;

const HAIR_RE = /* glsl */`
float kkSpec( vec3 T, vec3 N, vec3 L, vec3 V, float shift, float expo ) {
	vec3 Ts = normalize( T + N * shift );
	float tl = dot( Ts, L );
	float tv = dot( Ts, V );
	float stl = sqrt( max( 0.0, 1.0 - tl * tl ) );
	float stv = sqrt( max( 0.0, 1.0 - tv * tv ) );
	return pow( max( 0.0, tl * tv + stl * stv ), expo );
}

void RE_Direct_Hair( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

	vec3 T = normalize( vStrandT );
	vec3 L = directLight.direction;
	vec3 V = geometryViewDir;

	// Hair scatters heavily along the fibre, so the diffuse term is wrapped
	// rather than clamped — a hard terminator across a head of hair is one of
	// the loudest CG tells there is.
	float ndl = dot( geometryNormal, L );
	float wrap = max( 0.0, ( ndl + 0.45 ) / 1.45 );

	float primary = kkSpec( T, geometryNormal, L, V, uHairShiftA, uHairGloss );
	float secondary = kkSpec( T, geometryNormal, L, V, uHairShiftB, uHairGloss * 0.16 );
	// The secondary lobe is light that went through the fibre, so it carries the
	// hair's own colour; the primary is a surface reflection and stays white.
	// Hair fibres are dielectric: the reflected energy is a few percent, not a
	// few hundred. Left unscaled the primary lobe alone blows every strand to
	// white under a low sun, which is what a "wig made of tinfoil" looks like.
	vec3 spec = ( vec3( primary ) * 0.60 + uHairTint * secondary * 0.55 ) *
		uHairSpec * ( 1.0 - material.roughness * 0.55 );

	reflectedLight.directDiffuse += wrap * directLight.color * BRDF_Lambert( material.diffuseContribution );
	reflectedLight.directSpecular += spec * directLight.color * max( 0.0, ndl * 0.5 + 0.5 );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Hair
`;

export function createHairMaterial(opts: HairMaterialOptions): THREE.MeshPhysicalMaterial {
  const uniforms = {
    uHairTint: { value: new THREE.Color(opts.tintColor ?? opts.color) },
    uHairGloss: { value: opts.gloss ?? 90 },
    uHairShiftA: { value: 0.06 },
    uHairShiftB: { value: -0.10 },
    uHairRootDark: { value: opts.rootDark ?? 0.28 },
    // Salt-and-pepper grey, authored in LINEAR space: mid grey is ~0.62 sRGB,
    // which is 0.34 linear. Mixing toward 0.6 linear produces white hair.
    uHairGrey: { value: opts.greyTarget ?? new THREE.Color(0.30, 0.295, 0.288) },
    uHairSpec: { value: opts.specular ?? 0.16 },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: opts.color,
    roughness: opts.roughness ?? 0.42,
    metalness: 0,
    alphaMap: opts.shell ? shellAlphaTexture() : strandTexture(),
    transparent: opts.transparent ?? true,
    alphaTest: opts.alphaTest ?? 0.34,
    depthWrite: opts.depthWrite ?? true,
    side: THREE.DoubleSide,
    dithering: true,
  });
  mat.name = 'hair';

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HAIR_VERT_HEAD}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vStrandT = normalize( mat3( modelMatrix ) * aStrandTangent );
        vStrandInfo = aStrandInfo;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${HAIR_FRAG_HEAD}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${HAIR_RE}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Darker at the root, and greying wherever the guide asked for it.
        diffuseColor.rgb *= mix( 1.0 - uHairRootDark, 1.0, vStrandInfo.x );
        diffuseColor.rgb = mix( diffuseColor.rgb, uHairGrey, vStrandInfo.y );`,
      );
  };
  // The cache key has to carry every custom uniform value. Two materials that
  // return the same key share ONE program, and three only runs
  // `onBeforeCompile` for the first of them — so with a constant key the brows,
  // lashes and beard silently render with the hair shell's gloss, grey and
  // specular. Keying on the values means identical materials still share.
  const key = `gta-hair-v1|${uniforms.uHairTint.value.getHex()}|${uniforms.uHairGloss.value}` +
    `|${uniforms.uHairRootDark.value}|${uniforms.uHairSpec.value}|${opts.shell ? 's' : 'c'}`;
  mat.customProgramCacheKey = () => key;
  return mat;
}

/* ------------------------------------------------------------------ */
/* Ribbon builder                                                      */
/* ------------------------------------------------------------------ */

export interface Guide {
  /** Centreline, character space. */
  pts: THREE.Vector3[];
  /** Half-width at each point. */
  half: number[];
  /** Ribbon plane normal at each point (which way the card faces). */
  normal: THREE.Vector3[];
  /** 0..1 grey mix for this card. */
  grey: number;
  /** How many strand columns of the texture this card uses. */
  repeat?: number;
}

export class RibbonBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private tan: number[] = [];
  private info: number[] = [];
  private idx: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  add(g: Guide): void {
    const n = g.pts.length;
    if (n < 2) return;
    const base = this.pos.length / 3;
    const rep = g.repeat ?? 1;
    const t = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const p = g.pts[i];
      const prev = g.pts[Math.max(0, i - 1)];
      const next = g.pts[Math.min(n - 1, i + 1)];
      t.copy(next).sub(prev);
      if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
      t.normalize();
      const nl = g.normal[i];
      side.crossVectors(t, nl).normalize();
      const v = i / (n - 1);
      for (const s of [-1, 1]) {
        this.pos.push(
          p.x + side.x * g.half[i] * s,
          p.y + side.y * g.half[i] * s,
          p.z + side.z * g.half[i] * s,
        );
        this.nrm.push(nl.x, nl.y, nl.z);
        // The strand texture is opaque at the canvas top and fades to nothing at
        // the bottom, and `flipY` puts the canvas top at v = 1 — so a card has
        // to run from v = 1 at the root to v = 0 at the tip. Getting this
        // backwards erases the roots and leaves floating tips.
        this.uv.push(s < 0 ? 0 : rep, 1 - v);
        this.tan.push(t.x, t.y, t.z);
        this.info.push(v, g.grey);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }

  build(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aStrandTangent', new THREE.Float32BufferAttribute(this.tan, 3));
    g.setAttribute('aStrandInfo', new THREE.Float32BufferAttribute(this.info, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
