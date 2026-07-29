/** Print the nose and midline metrics for every cast member. Studio-only. */
import { CAST } from '../../src/characters/face/heroHead';
import { buildHeadGeometry } from '../../src/characters/face/headMesh';
import { measureMidlineSeam, measureNose } from '../../src/characters/face/checks';
import type { CastId } from '../../src/characters/face/fitData';
import { bodyMetrics } from '../../src/characters/rig';

const M = bodyMetrics('average', false);
for (const id of ['player', 'nicusor', 'ally'] as CastId[]) {
  const cfg = CAST[id];
  const { geometry, anchors } = buildHeadGeometry({
    cloud: cfg.cloud(), chinY: M.headY - 0.010, crownY: M.headTopY, skin: cfg.skin,
    beard: cfg.beardShade, beardColor: cfg.beardColor, hairColor: cfg.hairColor,
    tired: cfg.tired, age: cfg.age, jawPush: cfg.jawPush, browPush: cfg.browPush,
    hairline: cfg.hair.hairline, seed: 0x51a5e,
  });
  const n = measureNose(geometry, anchors);
  const s = measureMidlineSeam(geometry, anchors, { age: cfg.age, browPush: cfg.browPush, jawPush: cfg.jawPush });
  console.log(`\n== ${id} ==`);
  console.log(`  dorsalLength   ${(n.dorsalLength * 1000).toFixed(1)} mm`);
  console.log(`  tipProjection  ${(n.tipProjection * 1000).toFixed(1)} mm`);
  console.log(`  alarWidth      ${(n.alarWidth * 1000).toFixed(1)} mm`);
  console.log(`  bridgeWidth    ${(n.bridgeWidth * 1000).toFixed(1)} mm`);
  console.log(`  alarOverLength ${n.alarOverLength.toFixed(3)}   (target 0.36-0.50)`);
  console.log(`  lengthRatio    ${n.lengthRatio.toFixed(3)}   (target >0.72)`);
  console.log(`  bridgeOverAlar ${n.bridgeOverAlar.toFixed(3)}   (target 0.52-0.80)`);
  console.log(`  projectionRatio${n.projectionRatio.toFixed(3)}   (target 0.50-0.66)`);
  console.log(`  dorsalCamber   ${n.dorsalCamber.toFixed(4)}  (straight ~ 0)`);
  console.log(`  sculptKink     ${s.sculptKink.toFixed(4)} at fitted y=${s.worstY.toFixed(3)}`);
  console.log(`  curvatureRatio ${s.curvatureRatio.toFixed(2)}`);
  console.log(`  cavityDrop     ${s.cavityDrop.toFixed(3)}`);
}
