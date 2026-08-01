import { expect, test } from 'bun:test';
import { faceTonePalette } from './faces';

function relativeLuminance(hex: number): number {
  const linear = (channel: number): number => {
    const srgb = channel / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return (
    linear((hex >> 16) & 255) * 0.2126
    + linear((hex >> 8) & 255) * 0.7152
    + linear(hex & 255) * 0.0722
  );
}

test('procedural faces keep readable form shadows and distinct landmarks across skin tones', () => {
  // Endpoints and midpoint of the generated crowd range. The screenshot that
  // prompted this guard used the darkest endpoint: broad baked shadow had
  // already reduced it to coal before scene lighting was applied.
  for (const skin of [0xf0d3b8, 0xc9976f, 0x6f452c]) {
    const tones = faceTonePalette(skin);
    const baseLuma = relativeLuminance(skin);
    const shadowLuma = relativeLuminance(tones.shadow);
    const deepLuma = relativeLuminance(tones.deep);
    const featureLuma = relativeLuminance(tones.feature);

    // Broad modelled-in shading leaves enough reflectance for the dynamic
    // light rig to describe the forehead, cheeks and jaw instead of lighting a
    // texture that is already almost black.
    expect(shadowLuma / baseLuma).toBeGreaterThanOrEqual(0.55);
    expect(deepLuma / baseLuma).toBeGreaterThanOrEqual(0.36);

    // Eyelids, nostrils and the mouth retain a deliberately darker ink tone;
    // lifting the face must not turn it back into a featureless oval.
    expect(deepLuma / featureLuma).toBeGreaterThanOrEqual(1.8);
    expect(featureLuma).toBeLessThan(deepLuma);
    expect(deepLuma).toBeLessThan(shadowLuma);
    expect(shadowLuma).toBeLessThan(baseLuma);
  }
});
