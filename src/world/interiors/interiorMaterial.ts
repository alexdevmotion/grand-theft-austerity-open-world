/**
 * ONE MATERIAL FOR EVERY INTERIOR.
 *
 * It reads the same vertex layout the city's detail pass uses (`color`, `aMR`,
 * `aEmissive`), so the whole fitout kit can be written against `DetailBuilder`
 * and a room bakes to a single draw call.
 *
 * WHY NOT JUST USE THE CITY'S DETAIL MATERIAL. Because it is authored for the
 * OUTSIDE: it adds an analytic sky reflection plus a sky-coloured indirect
 * term to every surface, which is correct for a parapet and wrong for a desk
 * six metres inside a building. A room lit that way reads as a magenta patio —
 * the reference frame's key light landing on furniture that cannot see it.
 *
 * So the interior material:
 *   — keeps `scene.environment` at a low `envMapIntensity`, enough for glass
 *     and chrome to pick up the sunset through the door and not more;
 *   — replaces the sky ambient with a small, FIXED interior fill, tinted
 *     violet so the shadows still agree with `artDirection.Palette`;
 *   — drives roughness/metalness/emissive from the vertex stream.
 *
 * Everything else in a room comes from the interior's own lights.
 *
 * OWNER: interiors agent.
 */

import * as THREE from 'three';
import { Palette } from '../../artDirection';

const FILL = new THREE.Color().copy(Palette.skyAmbient).multiplyScalar(0.14);
const FILL_FLOOR = new THREE.Color().copy(Palette.groundBounce).multiplyScalar(0.9);

export interface InteriorMaterial extends THREE.MeshStandardMaterial {
  /** 0..1 — scales the fixed fill, for rooms that are meant to be dark. */
  setFill(v: number): void;
}

export function createInteriorMaterial(): InteriorMaterial {
  const uFill = { value: new THREE.Color().copy(FILL) };
  const uFillFloor = { value: new THREE.Color().copy(FILL_FLOOR) };

  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.0,
    emissive: 0xffffff,
    emissiveIntensity: 1.0,
    dithering: true,
  }) as InteriorMaterial;
  m.name = 'interior';
  /*
   * THE ENVIRONMENT INDOORS IS THE SKY PROBE, AND THERE IS NO SKY IN HERE.
   *
   * At 0.16 a smooth surface still rendered a legible reflection of the
   * skybox: a horizon line with sky above it, painted across every pane of
   * glass in the room. On a long partition seen edge-on that is
   * indistinguishable from a missing wall, which is exactly how the broadcast
   * studio's gallery screen read in the playtest. Halved, and the fragment
   * shader below refuses to go fully polished, so what is left is a sheen
   * rather than a window.
   */
  m.envMapIntensity = 0.075;

  m.onBeforeCompile = (shader) => {
    shader.uniforms.uFill = uFill;
    shader.uniforms.uFillFloor = uFillFloor;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        attribute vec2 aMR;
        attribute vec3 aEmissive;
        varying vec2 vMR;
        varying vec3 vEmi;
        varying vec3 vNrmI;`,
      )
      .replace(
        '#include <fog_vertex>',
        /* glsl */ `#include <fog_vertex>
        vMR = aMR;
        vEmi = aEmissive;
        vNrmI = normalize(mat3(modelMatrix) * normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform vec3 uFill;
        uniform vec3 uFillFloor;
        varying vec2 vMR;
        varying vec3 vEmi;
        varying vec3 vNrmI;`,
      )
      // Floor of 0.12 rather than 0.03: a perfect mirror indoors can only
      // reflect the sky probe, and a sky reflection on an interior surface
      // reads as a hole in the building.
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vMR.y, 0.12, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(vMR.x, 0.0, 1.0);')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vEmi;')
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `
        #include <lights_fragment_end>
        {
          /*
           * INTERIOR FILL. Two constants, not one: a room's ceiling bounce is
           * cooler and weaker than the bounce off its own floor, and without
           * the floor term every underside in the room — desk soffits, the
           * lintel over the door, the underside of a shelf — goes to pure
           * black and the furniture reads as cut-out.
           */
          float up = vNrmI.y * 0.5 + 0.5;
          reflectedLight.indirectDiffuse +=
            mix(uFillFloor, uFill, up) * diffuseColor.rgb * 3.14159;
        }
        `,
      );
  };
  // A stable key: three.js otherwise re-links this program whenever anything
  // about the light set changes shape, which is a visible hitch on entry.
  m.customProgramCacheKey = () => 'gta-interior-v1';

  m.setFill = (v: number): void => {
    uFill.value.copy(FILL).multiplyScalar(v);
    uFillFloor.value.copy(FILL_FLOOR).multiplyScalar(v);
  };
  return m;
}
