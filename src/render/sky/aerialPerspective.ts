/** Directional aerial perspective — replaces three's flat distance fog.
 *
 *  A single `FogExp2` colour cannot produce the reference frame, where the far
 *  boulevard dissolves into a hot orange rip while the buildings behind the
 *  camera sink into azure. So we override the four `fog_*` shader chunks
 *  globally with a height-attenuated scattering model whose in-scatter radiance
 *  is THE SKY DOME ITSELF, evaluated along the pixel's own view direction.
 *
 *  WHY THE IN-SCATTER COLOUR TABLE IS GONE
 *
 *  There used to be an `AERIAL_STOPS` table of hand-authored linear triples
 *  (a warm "toward sun" colour, a violet "away" colour, a "zenith" colour)
 *  lerped by cos(theta). That table can be tuned until it is individually
 *  plausible and it will still produce a razor-straight, full-width hue
 *  discontinuity along the horizon line — because at the horizon, fogged ground
 *  geometry is showing table colour and the pixel one row above it is showing
 *  dome colour, and the two are different functions.
 *
 *  For a homogeneous scattering medium,
 *
 *      L = L_surface * e^-tau  +  L_inscatter * (1 - e^-tau)
 *
 *  so as tau grows the composite must approach the sky radiance ALONG THE SAME
 *  RAY. Making `L_inscatter` literally be `skBandRadiance(viewDir, ...)` — the
 *  identical function the dome runs, fed the identical uniforms — makes that
 *  convergence true by construction. There is no seam to tune away because
 *  both sides of the horizon line are now the same expression.
 *
 *  What survives from the old model is the geometry: the height-attenuated
 *  optical depth (street haze piles up, rooftops stay crisp) and a Mie forward
 *  lobe so that looking into the sun through 600 m of air genuinely glows.
 *
 *  HOW THE UNIFORMS REACH EVERY MATERIAL
 *  `UniformsUtils.clone` deep-copies anything with a `.clone()` method but
 *  passes plain objects through *by reference*. So the shared state below is
 *  held in plain `{x,y,z}` / `{elements}` objects: every material that compiles
 *  with fog gets a clone of the uniform *slot* pointing at the same value
 *  object, and mutating it here updates the whole scene for free — no
 *  per-material bookkeeping, no onBeforeCompile on other agents' materials.
 *
 *  A material that includes the fog chunks but never receives the uniforms
 *  (someone else's hand-written ShaderMaterial) sees a zero sun direction and
 *  falls back to the stock exponential fog path. Nothing can break.
 */

import * as THREE from 'three';
import { SKY_BANDS_GLSL } from './skyBands';

/* ------------------------------------------------------------------ */
/* Density only — the COLOUR now comes from the sky dome function.     */
/* ------------------------------------------------------------------ */

export interface AerialStop {
  /** Elevation of the sun, degrees, that this stop is authored for. */
  elev: number;
  /** Extinction coefficient, 1/m at sea level. */
  density: number;
}

/** Ordered high sun -> deep night. */
export const AERIAL_STOPS: readonly AerialStop[] = [
  { elev: 46, density: 0.00070 },
  { elev: 18, density: 0.00080 },
  { elev: 3.2, density: 0.00082 },
  { elev: -3.5, density: 0.00086 },
  { elev: -9.5, density: 0.00084 },
  { elev: -20, density: 0.00090 },
];

const _stop = { density: 0.0009 };

/** Blend the authored aerial stops for a solar elevation, in degrees. */
export function aerialForElevation(elevationDeg: number): typeof _stop {
  const S = AERIAL_STOPS;
  let a = S[0];
  let b = S[0];
  let t = 0;
  if (elevationDeg >= S[0].elev) {
    a = b = S[0];
  } else if (elevationDeg <= S[S.length - 1].elev) {
    a = b = S[S.length - 1];
  } else {
    for (let i = 0; i < S.length - 1; i++) {
      if (elevationDeg <= S[i].elev && elevationDeg >= S[i + 1].elev) {
        a = S[i];
        b = S[i + 1];
        const raw = (a.elev - elevationDeg) / (a.elev - b.elev);
        t = raw * raw * (3 - 2 * raw);
        break;
      }
    }
  }
  _stop.density = a.density + (b.density - a.density) * t;
  return _stop;
}

type V3 = { x: number; y: number; z: number };
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });

/** Shared, mutable uniform payloads. Plain objects on purpose — see above. */
export const AerialUniforms = {
  camWorld: { elements: new Float32Array(16) },
  sunDir: { x: 0, y: 0, z: 0 },
  sunAz: { x: 0, y: 1 },

  /** The sky band ladder, mirrored from the live SkyKey. Identical values to
   *  the dome's own uniforms — that identity is the whole point. */
  bHorizon: v3(1, 0.4, 0.15),
  bLow: v3(0.5, 0.2, 0.2),
  bMid: v3(0.2, 0.05, 0.2),
  bHigh: v3(0.06, 0.03, 0.2),
  bZenith: v3(0.02, 0.02, 0.1),
  bAway: v3(0.62, 0.86, 1.42),
  bToward: v3(1.24, 0.9, 0.56),
  bHalo: v3(0.6, 0.25, 0.08),
  bGround: v3(0.03, 0.02, 0.05),

  /** x density, y height falloff (1/m), z Mie g, w Mie strength */
  params: { x: 0.0016, y: 0.006, z: 0.72, w: 0.5 },
  /** x start distance (m), y max opacity, z haze, w sky multiplier */
  params2: { x: 22, y: 0.998, z: 1, w: 1 },
  /**
   * x: how much of the dome's radiance the airlight carries.
   *
   * Slightly under 1 on purpose. The dome is unoccluded sky; a ground-level
   * air column is partly shadowed by the city itself and by the planet, so
   * airlight measures a little below the sky it converges on. Pushing this to
   * a true 1.0 makes distant streets read brighter than the sky above them,
   * which inverts the depth cue. Anything much below ~0.85 and the seam
   * reappears as a value step instead of a hue step.
   *
   * y, z: the horizon-closure ramp, in metres. Between these two distances the
   * fog is forced to full opacity regardless of what the physical optical
   * depth says, so the edge of the finite world dissolves completely into the
   * sky instead of ending in a hard line. See FOG_FRAGMENT.
   */
  params3: { x: 0.86, y: 1250, z: 2900, w: 0 },
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	uniform mat4 uAerialCamWorld;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	// mvPosition is in scope for every built-in vertex shader that includes
	// this chunk (sprites included, which have no 'transformed').
	vFogWorldPos = ( uAerialCamWorld * mvPosition ).xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;

	uniform vec3 uAerialSunDir;
	uniform vec2 uAerialSunAz;
	uniform vec3 uAerBHorizon, uAerBLow, uAerBMid, uAerBHigh, uAerBZenith;
	uniform vec3 uAerBAway, uAerBToward, uAerBHalo, uAerBGround;
	uniform vec4 uAerialParams;
	uniform vec4 uAerialParams2;
	uniform vec4 uAerialParams3;

	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif

	float aerialHG( float cosT, float g ) {
		float g2 = g * g;
		float den = 1.0 + g2 - 2.0 * g * cosT;
		return ( 1.0 - g2 ) / ( 12.566370614 * pow( max( den, 1e-4 ), 1.5 ) );
	}

${SKY_BANDS_GLSL}

#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG

	if ( dot( uAerialSunDir, uAerialSunDir ) > 0.25 ) {

		vec3 aerialV = vFogWorldPos - cameraPosition;
		float aerialDist = length( aerialV );
		vec3 aerialDir = aerialV / max( aerialDist, 1e-4 );

		// Analytic mean of exp(-k*y) along the ray: the city thins out with
		// altitude, so rooftops stay crisp while the street haze piles up.
		float k = uAerialParams.y;
		float h0 = cameraPosition.y;
		float h1 = vFogWorldPos.y;
		float dh = h1 - h0;
		float meanDensity;
		if ( abs( dh ) > 0.05 ) {
			meanDensity = ( exp( - k * h0 ) - exp( - k * h1 ) ) / ( k * dh );
		} else {
			meanDensity = exp( - k * h0 );
		}

		float od = uAerialParams.x * meanDensity * max( aerialDist - uAerialParams2.x, 0.0 );
		float fogFactor = 1.0 - exp( - od );

		/* HORIZON CLOSURE.
		 *
		 * Converging the in-scatter onto the sky function makes the two sides of
		 * the horizon the same COLOUR, but that only shows up once the optical
		 * depth actually saturates — and in a world 2.4 km across it does not.
		 * Measured from a 130 m rooftop, the far edge of the ground plane reaches
		 * only tau = 1.0, i.e. 64% fogged, so 36% of a near-black ground albedo
		 * survived and painted a razor-straight dark band under a bright sky.
		 * That band is the seam, and no colour change can remove it.
		 *
		 * A real horizon is thousands of kilometres of air. This ramp says so:
		 * past the world edge every surface is pure atmosphere, which is exactly
		 * the limit the physical term is heading toward anyway — it just cannot
		 * get there inside a finite city. */
		fogFactor = max( fogFactor, smoothstep( uAerialParams3.y, uAerialParams3.z, aerialDist ) );
		fogFactor = min( fogFactor, uAerialParams2.y );

		// IN-SCATTER == SKY RADIANCE ALONG THIS RAY. Same function, same
		// uniforms as the dome, so the composite converges onto the dome by
		// construction and the horizon seam cannot exist. Do not replace this
		// with a colour table; see the header of this file.
		SkBandSet B;
		B.horizon = uAerBHorizon;
		B.low = uAerBLow;
		B.mid = uAerBMid;
		B.high = uAerBHigh;
		B.zenith = uAerBZenith;
		B.away = uAerBAway;
		B.toward = uAerBToward;
		B.halo = uAerBHalo;
		B.ground = uAerBGround;

		vec3 scatter = skBandRadiance( aerialDir, uAerialSunDir, uAerialSunAz, B,
			uAerialParams2.z, uAerialParams2.w ) * uAerialParams3.x;

		// Mie forward lobe on top: 600 m of air looked through toward a low sun
		// glows well above the sky behind it.
		float cosT = dot( aerialDir, uAerialSunDir );
		scatter += uAerBHalo * aerialHG( cosT, uAerialParams.z ) * uAerialParams.w;

		gl_FragColor.rgb = mix( gl_FragColor.rgb, scatter, fogFactor );

	} else {

		#ifdef FOG_EXP2
			float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		#else
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
		#endif

		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );

	}

#endif
`;

let installed = false;

function uniformSlots(): Record<string, { value: unknown }> {
  return {
    uAerialCamWorld: { value: AerialUniforms.camWorld },
    uAerialSunDir: { value: AerialUniforms.sunDir },
    uAerialSunAz: { value: AerialUniforms.sunAz },
    uAerBHorizon: { value: AerialUniforms.bHorizon },
    uAerBLow: { value: AerialUniforms.bLow },
    uAerBMid: { value: AerialUniforms.bMid },
    uAerBHigh: { value: AerialUniforms.bHigh },
    uAerBZenith: { value: AerialUniforms.bZenith },
    uAerBAway: { value: AerialUniforms.bAway },
    uAerBToward: { value: AerialUniforms.bToward },
    uAerBHalo: { value: AerialUniforms.bHalo },
    uAerBGround: { value: AerialUniforms.bGround },
    uAerialParams: { value: AerialUniforms.params },
    uAerialParams2: { value: AerialUniforms.params2 },
    uAerialParams3: { value: AerialUniforms.params3 },
  };
}

/**
 * Patch the global fog chunks and seed every built-in shader with the shared
 * uniform slots. Must run before the first program compiles — SkySystem is
 * order 10, so it does.
 */
export function installAerialPerspective(): void {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

  // Future merges (custom ShaderMaterials built from UniformsLib) pick these up.
  Object.assign(THREE.UniformsLib.fog, uniformSlots());

  // ShaderLib was already assembled at module load, so patch each entry too.
  for (const name of Object.keys(THREE.ShaderLib)) {
    const shader = (THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> }>)[name];
    if (shader?.uniforms && 'fogColor' in shader.uniforms) {
      Object.assign(shader.uniforms, uniformSlots());
    }
  }
}

/**
 * Best-effort: hand the shared slots to hand-written ShaderMaterials that opted
 * into fog. Cheap enough to run on a timer; skips anything already wired.
 */
export function adoptCustomFogMaterials(root: THREE.Object3D): number {
  let touched = 0;
  const slots = uniformSlots();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (const m of list) {
      const sm = m as THREE.ShaderMaterial;
      if (!sm.uniforms || sm.fog !== true) continue;
      if ('uAerialSunDir' in sm.uniforms) continue;
      Object.assign(sm.uniforms, slots);
      touched++;
    }
  });
  return touched;
}

const _e = new THREE.Matrix4();

/** Push this frame's camera matrix into the shared uniform payload. */
export function updateAerialCamera(camera: THREE.Camera): void {
  _e.copy(camera.matrixWorld);
  AerialUniforms.camWorld.elements.set(_e.elements);
}

export function setAerialColor(
  target: { x: number; y: number; z: number },
  c: THREE.Color,
  mul = 1,
): void {
  target.x = c.r * mul;
  target.y = c.g * mul;
  target.z = c.b * mul;
}
