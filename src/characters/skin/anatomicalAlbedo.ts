import * as THREE from 'three';

const textures = new Map<string, THREE.Texture>();
const neutral = new THREE.Color(0xd2ae91);

/** CC0 HM08 skin detail shares the native mesh UVs. Normalize its average
 * tone so the cast palette and the body-neck colour remain consistent. */
export function applyAnatomicalAlbedo(material: THREE.MeshStandardMaterial, cast: string): void {
  const age = cast === 'ally' ? 'young' : 'middleage';
  let texture = textures.get(age);
  if (!texture) {
    texture = new THREE.TextureLoader().load(`/textures/characters/${age}_lightskinned_male_diffuse.png`);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    textures.set(age, texture);
  }
  material.map = texture;
  const compile = material.onBeforeCompile.bind(material);
  const key = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec3 skinDetail = texture2D(map, vMapUv).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), skinDetail / vec3(${neutral.r}, ${neutral.g}, ${neutral.b}), 0.85);
      #endif
    `);
  };
  material.customProgramCacheKey = () => `${key}|hm08-albedo-v1`;
}
