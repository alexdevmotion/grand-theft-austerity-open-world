/** Directional aerial perspective — replaces three's flat distance fog.
 *
 *  A single `FogExp2` colour cannot produce the reference frame, where the far
 *  boulevard dissolves into a hot orange rip while the buildings behind the
 *  camera sink into violet. So we override the four `fog_*` shader chunks
 *  globally with a height-attenuated, view-dependent scattering model:
 *
 *    optical depth  exponential density falloff with altitude, integrated
 *                   analytically along the view ray
 *    in-scatter     lerp(violet away-colour, orange sun-colour) by cos(theta),
 *                   pulled toward the zenith colour when looking up
 *    Mie lobe       Henyey-Greenstein forward peak, so looking into the sun
 *                   through 600 m of air genuinely glows
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

/* ------------------------------------------------------------------ */
/* In-scatter colour — AUTHORED HERE, in literal linear RGB             */
/*                                                                     */
/* These used to be derived from the sky keyframe by multiplying the    */
/* `low`/`mid` bands by the anti-solar tint. Compounding three already- */
/* magenta terms drove the green channel to ~0.007 against a 0.058 blue */
/* — a G/B ratio of 0.12, which no atmosphere has. The result was that  */
/* every distant building sampled rgb(80, 0, 82): the green channel     */
/* literally zero, the city one flat magenta silhouette with no depth   */
/* cue and no material reading left in it.                              */
/*                                                                     */
/* Airlight is Rayleigh-dominated and Rayleigh always carries green:    */
/* a dusk in-scatter normalises to about (0.10, 0.13, 0.28), i.e. MORE  */
/* green than red. So the three colours are written out by hand as      */
/* linear triples, and the only thing time of day does is choose        */
/* between the stops and scale them.                                    */
/* ------------------------------------------------------------------ */

type RGB = readonly [number, number, number];

export interface AerialStop {
  /** Elevation of the sun, degrees, that this stop is authored for. */
  elev: number;
  /** In-scatter looking INTO the sun — the warm rip down the boulevard. */
  sun: RGB;
  /** In-scatter looking away from the sun — Rayleigh violet-blue, WITH green. */
  away: RGB;
  /** In-scatter looking up — the zenith the far skyline dissolves into. */
  zen: RGB;
  /** Extinction coefficient, 1/m at sea level. */
  density: number;
}

/** Ordered high sun -> deep night. */
export const AERIAL_STOPS: readonly AerialStop[] = [
  { elev: 46,
    sun:  [0.560, 0.600, 0.720], away: [0.300, 0.400, 0.680], zen: [0.180, 0.270, 0.580],
    density: 0.00070 },
  { elev: 18,
    sun:  [0.680, 0.480, 0.400], away: [0.230, 0.280, 0.520], zen: [0.140, 0.180, 0.420],
    density: 0.00080 },
  { elev: 3.2,
    sun:  [0.250, 0.112, 0.055], away: [0.058, 0.072, 0.166], zen: [0.034, 0.044, 0.126],
    density: 0.00090 },
  { elev: -3.5,
    sun:  [0.180, 0.070, 0.042], away: [0.040, 0.047, 0.122], zen: [0.024, 0.030, 0.096],
    density: 0.00095 },
  { elev: -9.5,
    sun:  [0.110, 0.052, 0.062], away: [0.030, 0.034, 0.092], zen: [0.018, 0.021, 0.070],
    density: 0.00090 },
  { elev: -20,
    sun:  [0.040, 0.030, 0.040], away: [0.016, 0.019, 0.046], zen: [0.010, 0.012, 0.034],
    density: 0.00080 },
];

const _stop: { sun: [number, number, number]; away: [number, number, number]; zen: [number, number, number]; density: number } = {
  sun: [0, 0, 0], away: [0, 0, 0], zen: [0, 0, 0], density: 0.0009,
};

const mix3 = (out: [number, number, number], a: RGB, b: RGB, t: number): void => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
};

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
  mix3(_stop.sun, a.sun, b.sun, t);
  mix3(_stop.away, a.away, b.away, t);
  mix3(_stop.zen, a.zen, b.zen, t);
  _stop.density = a.density + (b.density - a.density) * t;
  return _stop;
}

/** Shared, mutable uniform payloads. Plain objects on purpose — see above. */
export const AerialUniforms = {
  camWorld: { elements: new Float32Array(16) },
  sunDir: { x: 0, y: 0, z: 0 },
  sunCol: { x: 1, y: 0.5, z: 0.25 },
  awayCol: { x: 0.35, y: 0.28, z: 0.6 },
  zenCol: { x: 0.18, y: 0.14, z: 0.36 },
  /** x density, y height falloff (1/m), z Mie g, w Mie strength */
  params: { x: 0.0016, y: 0.006, z: 0.72, w: 0.5 },
  /** x start distance (m), y max opacity, z unused, w unused */
  params2: { x: 22, y: 0.985, z: 0, w: 0 },
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
	uniform vec3 uAerialSunCol;
	uniform vec3 uAerialAwayCol;
	uniform vec3 uAerialZenCol;
	uniform vec4 uAerialParams;
	uniform vec4 uAerialParams2;

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
		float fogFactor = min( 1.0 - exp( - od ), uAerialParams2.y );

		float cosT = dot( aerialDir, uAerialSunDir );
		vec3 scatter = mix( uAerialAwayCol, uAerialSunCol, smoothstep( -0.30, 0.94, cosT ) );
		scatter = mix( scatter, uAerialZenCol, smoothstep( 0.04, 0.60, aerialDir.y ) );
		scatter += uAerialSunCol * aerialHG( cosT, uAerialParams.z ) * uAerialParams.w;

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
    uAerialSunCol: { value: AerialUniforms.sunCol },
    uAerialAwayCol: { value: AerialUniforms.awayCol },
    uAerialZenCol: { value: AerialUniforms.zenCol },
    uAerialParams: { value: AerialUniforms.params },
    uAerialParams2: { value: AerialUniforms.params2 },
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
