/**
 * Print every measured head invariant for the whole cast.
 *
 * `bun test` says pass or fail; this says by how much, which is what you need
 * while a magnitude is being tuned. Run with:
 *
 *   bun tools/facefit/measure.ts
 *
 * Studio-only — nothing in `src/` imports it.
 */

import { CAST } from '../../src/characters/face/heroHead';
import { buildHeadGeometry, HEAD_TO_BODY } from '../../src/characters/face/headMesh';
import { measureEyeSeating, measureProportions } from '../../src/characters/face/checks';
import { NOMINAL_HEIGHT, bodyMetrics } from '../../src/characters/rig';
import type { CastId } from '../../src/characters/face/fitData';

const M = bodyMetrics('average', false);
const mm = (v: number): string => (v * 1000).toFixed(1).padStart(7);
const f = (v: number): string => v.toFixed(4).padStart(7);

console.log('=== body ===');
console.log(`  biacromial      ${mm(M.shoulderHalf * 2)} mm   (real 400-460)`);
console.log(`  yoke width      ${mm(M.yokeW * 2)} mm`);
console.log(`  chest width     ${mm(M.chestW * 2)} mm`);
console.log(`  height          ${mm(NOMINAL_HEIGHT)} mm`);

for (const id of ['player', 'nicusor', 'ally'] as CastId[]) {
  const cfg = CAST[id];
  const { geometry, anchors } = buildHeadGeometry({
    cloud: cfg.cloud(), chinY: M.headY - 0.010, crownY: M.headTopY, skin: cfg.skin,
    beard: cfg.beardShade, beardColor: cfg.beardColor, tired: cfg.tired, age: cfg.age,
    jawPush: cfg.jawPush, browPush: cfg.browPush, seed: 0x51a5e,
  });
  const p = measureProportions(geometry, anchors, NOMINAL_HEIGHT);
  console.log(`\n=== ${id} ===`);
  console.log(`  head height     ${mm(p.headHeight)} mm`);
  console.log(`  head / body     ${f(p.headOverBody)}   target ${f(HEAD_TO_BODY)} (x${f(p.headOverBody / HEAD_TO_BODY)})`);
  console.log(`  brow / head     ${f(p.browOverHead)}   want 0.55 .. 0.68`);
  console.log(`  vault / head    ${f(p.vaultOverHead)}   want 0.26 .. 0.40`);
  console.log(`  crown flatness  ${f(p.crownFlatness)}   want > 0.62`);
  console.log(`  eye line        ${f(p.eyeLineFrac)}`);
  console.log(`  width / depth   ${mm(p.width)} /${mm(p.depth)} mm`);
  console.log(`  shoulder / head ${f((M.shoulderHalf * 2) / p.width)}   want > 2.5`);
  for (const [n, eye] of [['L', anchors.eyeL], ['R', anchors.eyeR]] as const) {
    const s = measureEyeSeating(geometry, eye);
    console.log(`  eye ${n}  fissure ${mm(s.apertureW)} x${mm(s.apertureH)} mm  exposed ${f(s.exposed)}` +
      `  rim ${mm(s.rimProtrusion)}  apex-chord ${mm(s.apexZ - s.browCheekZ)}`);
  }
}
