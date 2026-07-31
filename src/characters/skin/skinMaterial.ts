/**
 * SKIN MATERIAL — the anti-mask shading stack.
 *
 * Built on `MeshPhysicalMaterial` so the scene's cascaded shadows, image-based
 * lighting, fog, aerial perspective and tone mapping all keep working, with the
 * skin-specific physics injected around three's own render equations:
 *
 *   - albedo arrives as a per-vertex colour authored in `headMesh.ts`. It is
 *     de-lit by construction: nothing is ever sampled out of a photograph, so
 *     no studio shadow or highlight can survive into base colour and get
 *     multiplied a second time by the game's sunset key.
 *   - direct diffuse goes through the pre-integrated scattering LUT rather than
 *     Lambert, so the terminator wraps and reddens the way flesh does.
 *   - thin parts (ears, nostrils, lips, eyelids) transmit the key light. That
 *     term deliberately ignores the shadow map: when the sun is behind an ear
 *     the ear's front face is *always* shadowed, so gating it on the shadow
 *     would delete the exact effect it exists for.
 *   - specular is two lobes, a tight oily one over a broad one, against a
 *     roughness that carries a real T-zone.
 *   - a tiling micro-normal adds pores and fine creases, and a per-vertex
 *     cavity term keeps the nasolabial folds, eye corners and the shelf under
 *     the brow dark whatever the key light does.
 *
 * LOD is by uniform, not by define, so nothing recompiles mid-session: past
 * ~15 m the scattering and micro-detail fade out, and past ~30 m the caller
 * swaps in the cheap standard material entirely.
 *
 * OWNER: characters agent.
 */

import * as THREE from 'three';
import { microNormalMap } from './microDetail';
import { sssLut } from './sssLut';

export interface SkinUniforms {
  uSssLut: { value: THREE.Texture };
  uSssStrength: { value: number };
  uSssTint: { value: THREE.Color };
  uCurvScale: { value: number };
  uCurvBias: { value: number };
  uSpecLobeMix: { value: number };
  uSpecLobeSpread: { value: number };
  uMicroMap: { value: THREE.Texture };
  uMicroScale: { value: number };
  uMicroStrength: { value: number };
  uKeyDir: { value: THREE.Vector3 };
  uKeyColor: { value: THREE.Color };
  uTransColor: { value: THREE.Color };
  uTransScale: { value: number };
  uTransPower: { value: number };
  uTransDistort: { value: number };
  uCavityStrength: { value: number };
}

export interface SkinMaterialOptions {
  /** Base tint multiplied over the per-vertex albedo. */
  color?: number;
  /** Overall scattering strength, 0..1. */
  sss?: number;
  /** Colour the scattering pushes light toward. */
  sssTint?: number;
  /** Maps the per-vertex curvature attribute into the LUT's 0..1 axis. */
  curvScale?: number;
  curvBias?: number;
  /** How much of the specular energy sits in the broad lobe. */
  specLobeMix?: number;
  specLobeSpread?: number;
  microScale?: number;
  microStrength?: number;
  transColor?: number;
  transScale?: number;
  transPower?: number;
  transDistort?: number;
  roughnessScale?: number;
  roughnessBias?: number;
}

export interface SkinMaterial extends THREE.MeshPhysicalMaterial {
  skin: SkinUniforms;
}

const HEAD = /* glsl */`
attribute vec4 aSkin;
varying vec4 vSkinAttr;
varying vec3 vSkinWorldNormal;
varying vec3 vSkinWorldPos;
varying vec3 vSkinObjPos;
`;

const FRAG_HEAD = /* glsl */`
varying vec4 vSkinAttr;
varying vec3 vSkinWorldNormal;
varying vec3 vSkinWorldPos;
varying vec3 vSkinObjPos;
uniform sampler2D uSssLut;
uniform float uSssStrength;
uniform vec3  uSssTint;
uniform float uCurvScale;
uniform float uCurvBias;
uniform float uSpecLobeMix;
uniform float uSpecLobeSpread;
uniform sampler2D uMicroMap;
uniform float uMicroScale;
uniform float uMicroStrength;
uniform vec3  uKeyDir;
uniform vec3  uKeyColor;
uniform vec3  uTransColor;
uniform float uTransScale;
uniform float uTransPower;
uniform float uTransDistort;
uniform float uCavityStrength;
uniform float uRoughScale;
uniform float uRoughBias;
`;

const SKIN_RE = /* glsl */`
void RE_Direct_Skin( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {

	float dotNL = dot( geometryNormal, directLight.direction );

	// Pre-integrated scattering (Penner 2011): the table already holds the
	// diffusion profile integrated over a ring of surface at this curvature, so
	// the soft, reddening terminator comes out of a single fetch with no blur
	// passes — which is what makes it affordable in a forward renderer.
	float curv = clamp( vSkinAttr.x * uCurvScale + uCurvBias, 0.0, 1.0 );
	vec3 sss = texture2D( uSssLut, vec2( dotNL * 0.5 + 0.5, curv ) ).rgb * uSssTint;
	vec3 wrapped = mix( vec3( max( dotNL, 0.0 ) ), sss, uSssStrength );

	float cavity = mix( 1.0, vSkinAttr.z, uCavityStrength );
	vec3 irradiance = wrapped * directLight.color * cavity;

	// Dual-lobe specular. A single lobe is exactly what makes CG skin read as
	// polished plastic: real skin has a tight oily layer over a broad one.
	PhysicalMaterial broad = material;
	broad.roughness = clamp( material.roughness * uSpecLobeSpread, 0.05, 1.0 );
	vec3 specIrr = max( dotNL, 0.0 ) * directLight.color;
	vec3 spec =
		BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, material ) * ( 1.0 - uSpecLobeMix ) +
		BRDF_GGX_Multiscatter( directLight.direction, geometryViewDir, geometryNormal, broad ) * uSpecLobeMix;

	reflectedLight.directSpecular += specIrr * spec;
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Skin
`;

/** Triplanar micro-normal, blended in object space so no UV layout is needed. */
const MICRO = /* glsl */`
	if ( uMicroStrength > 0.0001 ) {
		vec3 gn = normalize( vSkinWorldNormal );
		vec3 an = abs( gn );
		an /= ( an.x + an.y + an.z );
		vec3 p = vSkinObjPos * uMicroScale;
		vec3 nx = texture2D( uMicroMap, p.zy ).xyz * 2.0 - 1.0;
		vec3 ny = texture2D( uMicroMap, p.xz ).xyz * 2.0 - 1.0;
		vec3 nz = texture2D( uMicroMap, p.xy ).xyz * 2.0 - 1.0;
		// Whiteout blend with sign correction. Without the sign, the blend weight
		// abs(n.x) has a kink where n.x crosses zero — which on a head is exactly
		// the midline — and the pore normal flips there, drawing a hard seam
		// straight down the forehead, nose and chin.
		vec3 s = sign( gn );
		vec3 bump =
			vec3( 0.0, nx.y, nx.x ) * ( an.x * s.x ) +
			vec3( ny.x, 0.0, ny.y ) * ( an.y * s.y ) +
			vec3( nz.x, nz.y, 0.0 ) * ( an.z * s.z );
		// The tangent-space z of each sample is the "no perturbation" axis; it
		// belongs along the geometric normal, not along a world axis.
		float along = nx.z * an.x + ny.z * an.y + nz.z * an.z;
		vec3 wn = normalize( gn * along + bump * uMicroStrength );
		normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
	}
`;

const TRANSMISSION = /* glsl */`
	{
		// Thin-part transmission. Not shadowed, on purpose — see the header.
		vec3 Nw = normalize( vSkinWorldNormal );
		vec3 Vw = normalize( cameraPosition - vSkinWorldPos );
		vec3 tl = normalize( -uKeyDir + Nw * uTransDistort );
		float t = pow( clamp( dot( Vw, -tl ), 0.0, 1.0 ), uTransPower ) * uTransScale;
		/* THE BACK-LIT GATE, AND WHY IT IS NOT A HALF-LAMBERT.
		 *
		 * This was -dot(N,K) * 0.5 + 0.5, which is 0.5 for a surface exactly
		 * side-on to the key and never reaches zero for anything short of a
		 * surface aimed straight at it. So a cheek in FULL FRONTAL SUN was still
		 * being given half of a saturated orange-red, unshadowed, multiplied by a
		 * key that at midday is 12.5 in intensity. Framed at 0.6 m under a noon
		 * sun the whole head rendered oxblood — measured 49/22/30 on the cheek,
		 * against 179/144/124 for the identical frame with uTransScale locked
		 * to zero through a property getter. Nothing else in the stack moved.
		 *
		 * Transmission is light that entered the far side of a thin part and came
		 * out at the near side. A surface with ANY of the key on its front face
		 * is not that, by definition. So the gate is a true back-facing test with
		 * a soft shoulder: full strength when the key is directly behind, zero the
		 * moment the surface turns into it. Ears, nostril wings and lip edges with
		 * the sun behind the head — the cases this term exists for — are
		 * unaffected, because for them -dot(N,K) is near 1. */
		float back = pow( clamp( -dot( Nw, uKeyDir ), 0.0, 1.0 ), 1.4 );
		reflectedLight.directDiffuse +=
			uKeyColor * uTransColor * diffuseColor.rgb * ( t * back * vSkinAttr.y );
	}
`;

export function createSkinMaterial(opts: SkinMaterialOptions = {}): SkinMaterial {
  const uniforms: SkinUniforms & { uRoughScale: { value: number }; uRoughBias: { value: number } } = {
    uSssLut: { value: sssLut() },
    uSssStrength: { value: opts.sss ?? 0.60 },
    uSssTint: { value: new THREE.Color(opts.sssTint ?? 0xfff0e6) },
    // The per-vertex curvature attribute is in 1/metres. The LUT's v axis is
    // curvature in 1/mm over [0, 0.5], so the conversion is k / 1000 / 0.5.
    // Getting this wrong pins every vertex at the maximum-curvature row and the
    // whole face turns into one flat wrapped red mask.
    uCurvScale: { value: opts.curvScale ?? 0.0020 },
    uCurvBias: { value: opts.curvBias ?? 0.006 },
    uSpecLobeMix: { value: opts.specLobeMix ?? 0.32 },
    uSpecLobeSpread: { value: opts.specLobeSpread ?? 2.6 },
    uMicroMap: { value: microNormalMap() },
    uMicroScale: { value: opts.microScale ?? 150 },
    uMicroStrength: { value: opts.microStrength ?? 0.30 },
    uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
    uKeyColor: { value: new THREE.Color(0, 0, 0) },
    uTransColor: { value: new THREE.Color(opts.transColor ?? 0xff4a22) },
    uTransScale: { value: opts.transScale ?? 1.9 },
    uTransPower: { value: opts.transPower ?? 4.0 },
    uTransDistort: { value: opts.transDistort ?? 0.35 },
    uCavityStrength: { value: 1.0 },
    uRoughScale: { value: opts.roughnessScale ?? 1.0 },
    uRoughBias: { value: opts.roughnessBias ?? 0.0 },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: opts.color ?? 0xffffff,
    vertexColors: true,
    roughness: 0.5,
    metalness: 0.0,
    // A dielectric skin surface: the specular response is the oil film, not a
    // metal, and the clearcoat term is left off so the two lobes below are the
    // only specular the face has.
    specularIntensity: 1.0,
    reflectivity: 0.42,
    dithering: true,
  }) as SkinMaterial;

  mat.name = 'skin';
  mat.skin = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HEAD}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSkinAttr = aSkin;
        vSkinObjPos = position;
        vSkinWorldNormal = normalize( mat3( modelMatrix ) * objectNormal );`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vSkinWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = clamp( vSkinAttr.w * uRoughScale + uRoughBias, 0.035, 1.0 );`,
      )
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${MICRO}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${SKIN_RE}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          // Cavity against the AMBIENT, softened. The same term is already a
          // multiplier on direct diffuse and a 0.20 multiplier on the authored
          // albedo, so applying it here at full strength was the third bite out
          // of the same vertex: a crease at the 0.22 floor was returning 0.16 of
          // its neighbour, which renders as a drawn black line rather than as a
          // fold. Ambient occlusion is also the wrong place to be aggressive on
          // this head — the key is low and often behind it, so ambient IS the
          // light, and crushing ambient crushes the face.
          float cav = mix( 1.0, vSkinAttr.z, uCavityStrength );
          reflectedLight.indirectDiffuse *= mix( 1.0, cav, 0.72 );
          reflectedLight.indirectSpecular *= mix( 1.0, cav, 0.55 );
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${TRANSMISSION}`);
  };

  // Distinct from every other physical material in the scene, and distinct per
  // option set: materials sharing a cache key share one program, and three only
  // runs `onBeforeCompile` for the first of them, so a constant key would make
  // every cast member inherit the first head's scattering and transmission.
  const key = `gta-skin-v1|${uniforms.uSssStrength.value}|${uniforms.uSssTint.value.getHex()}` +
    `|${uniforms.uMicroScale.value}|${uniforms.uTransColor.value.getHex()}`;
  mat.customProgramCacheKey = () => key;

  return mat;
}

/**
 * Distance LOD. The full stack is for hero faces near the camera only; past
 * ~15 m the scattering and pore detail are invisible and past ~30 m the caller
 * swaps to `fallbackSkinMaterial` entirely.
 */
export function lodSkinMaterial(mat: SkinMaterial, distance: number, base: SkinMaterialOptions): void {
  const near = 1 - THREE.MathUtils.smoothstep(distance, 8, 15);
  const mid = 1 - THREE.MathUtils.smoothstep(distance, 14, 26);
  mat.skin.uSssStrength.value = (base.sss ?? 0.60) * (0.35 + 0.65 * mid);
  mat.skin.uMicroStrength.value = (base.microStrength ?? 0.30) * near;
  mat.skin.uTransScale.value = (base.transScale ?? 1.9) * mid;
  mat.skin.uCavityStrength.value = 0.45 + 0.55 * mid;
}

/** The cheap material a hero head falls back to beyond ~30 m. */
export function createFallbackSkinMaterial(color = 0xffffff): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    vertexColors: true,
    roughness: 0.52,
    metalness: 0,
    dithering: true,
  });
}
