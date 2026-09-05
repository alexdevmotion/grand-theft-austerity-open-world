import * as THREE from 'three';

/** Shared 1K CC0 scans. Authored metre scales and provenance are in
 * public/textures/world/sources.json. Loading never blocks world construction;
 * procedural shading stays active until all maps of a material are ready. */
export function createScannedMaterials() {
  const uniforms: Record<string, THREE.IUniform> = {};
  const textures: THREE.Texture[] = [];
  let disposed = false;
  for (const [name, asset] of [
    ['Road', 'asphalt_02'], ['Wall', 'concrete_wall_006'], ['Paving', 'pavement_01'],
  ] as const) {
    const ready = { value: 0 };
    uniforms[`u${name}ScanReady`] = ready;
    let loaded = 0;
    for (const [channel, suffix, pixel] of [
      ['Color', 'Diffuse', [128, 128, 128, 255]],
      ['Normal', 'nor_gl', [128, 128, 255, 255]],
      ['ARM', 'arm', [255, 230, 0, 255]],
    ] as const) {
      const fallback = new THREE.DataTexture(new Uint8Array(pixel), 1, 1);
      fallback.needsUpdate = true;
      const uniform: THREE.IUniform<THREE.Texture> = { value: fallback };
      uniforms[`u${name}${channel}`] = uniform;
      textures.push(fallback);
      // Geometry/unit tests run without a DOM or network.
      if (typeof document === 'undefined' || typeof document.createElementNS !== 'function') continue;
      const texture = new THREE.TextureLoader().load(
        `/textures/world/${asset}_${suffix}.jpg`,
        (map) => {
          if (disposed) { map.dispose(); return; }
          uniform.value = map;
          if (++loaded === 3) ready.value = 1;
        },
        undefined,
        () => { /* Keep the complete procedural material if a map is unavailable. */ },
      );
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 8;
      texture.colorSpace = channel === 'Color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      textures.push(texture);
    }
  }
  return {
    uniforms,
    dispose() { disposed = true; for (const texture of textures) texture.dispose(); },
  };
}

export const WALL_SCAN_GLSL = /* glsl */ `
uniform sampler2D uWallColor, uWallNormal, uWallARM;
uniform float uWallScanReady;
`;

export const SURFACE_SCAN_GLSL = /* glsl */ `
${WALL_SCAN_GLSL}
uniform sampler2D uRoadColor, uRoadNormal, uRoadARM;
uniform sampler2D uPavingColor, uPavingNormal, uPavingARM;
uniform float uRoadScanReady, uPavingScanReady;
`;
