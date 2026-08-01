# Pedestrian crowd robustness and imposter realism evidence

## Changed scope

- `src/ai/peds/crowd.ts`
- `src/ai/peds/crowd.test.ts`
- `src/ai/peds/behaviours.ts`
- `src/ai/peds/rig.ts`
- `src/ai/peds/rig.test.ts`

No browser or development server was launched.

## Red-to-green scenarios

| Scenario | Invocation | Red binary observable | Red artifact | Green binary observable | Green artifact |
|---|---|---|---|---|---|
| Two pedestrians spawn at the identical root | `bun test src/ai/peds/crowd.test.ts` | distance `0`, required `>= 0.72`; 1 failed | `red-coincident.txt` | finite separation and centre preserved; pass | `green-coincident.txt` |
| Four coincident anchored conversation members | same | anchor remained `3` while body moved to `3.973...`; 1 failed | `red-anchored-cluster.txt` | every pair separated and every anchor follows its corrected body; pass | `green-anchored-cluster.txt` |
| Anchored pedestrian coincident with on-foot player | same | distance `0`, required `>= 0.86`; 1 failed | `red-player-overlap.txt` | hard player separation; pass | `green-player-overlap.txt` |
| Two scripted pedestrians move into one another in one fixed step | same | distance `0.7`, required `>= 0.72`; 1 failed | `red-moving-overlap.txt` | post-integration hard separation; pass | `green-moving-overlap.txt` |
| A passer-by overlaps a loiterer | same | loiterer root moved from `8` to `7.630...`; 1 failed | `red-anchor-stability.txt` | passer-by yields while loiter root/anchor remain fixed; pass | `green-anchor-stability.txt` |
| Dog head material in near/far imposter tiers | `bun test src/ai/peds/rig.test.ts` | human face pool count `1`, required `0`; 1 failed | `red-dog-face-material.txt` | dog heads use untextured blob pools in both tiers; pass | `green-dog-face-material.txt` |
| Hair, hard-hat, beanie, and long-hair shell silhouette | same | shell bottom was `-0.073...m` below face midline; 1 failed | `red-head-shell-silhouette.txt` | every tested shell clears the face midline in both tiers; pass | `green-head-shell-silhouette.txt` |
| Crown/dog-head pool at maximum pedestrian occupancy | same | retained `2` of required `4` instances; 1 failed | `red-blob-capacity.txt` | retains one crown and one dog head per pedestrian; pass | `green-blob-capacity.txt` |

## Final verification

- Focused command: `bun test src/ai/peds/crowd.test.ts src/ai/peds/rig.test.ts`
  - Observable: `11 pass`, `0 fail`, `62 expect()` calls.
  - Artifact: `focused-tests.txt`
- Repository command: `bun test`
  - Observable: `511 pass`, `0 fail`, `8940 expect()` calls.
  - Artifact: `full-tests.txt`
- Static command: `bun run typecheck`
  - Observable: exit 0 from `tsc --noEmit`.
  - Artifact: `typecheck.txt`
- Normal-density grid microbenchmark: 120 pedestrians, 2,000 rebuilds.
  - Observable: finite positions; mean `0.07816ms` per rebuild in this run.
  - Artifact: `grid-benchmark.txt`

## Checker QA risks

- The tests prove body-root clearance and imposter composition invariants, not artistic quality under the live dusk lighting/post-processing stack. A checker should inspect all headwear variants at near/far transitions and confirm faces no longer read as detached or covered.
- The nearest `actorBudget` pedestrians are promoted to the separate skinned-character renderer under `src/characters`; any remaining foreground overexposure, angular anatomy, or clothing/limb self-intersection there is not produced by the imposter renderer changed in this scope and still needs visual attribution by the checker.
- No browser QA was run because this worker was explicitly prohibited from launching a browser/server.
