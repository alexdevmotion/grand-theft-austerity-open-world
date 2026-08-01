# Tram junction rail invariant evidence

## Failure reproduced before the correction

- Scenario: sample every metre of each real-city tram continuation and compare the center and 1.5 m swept body edges with independently reconstructed rendered track centrelines.
- Invocation: `bun test src/ai/traffic/roadGraph.test.ts`
- Binary observable: exit 1; continuation `93->169` crossed bare asphalt and reached 19.2 m from a rendered track.
- Artifact: `red-bare-junction.txt`

## Focused routing verification after the correction

- Scenario: validate explicit rail mapping, facade rejection, rail-only continuation/recovery, rejection of two rail edges separated by bare junction asphalt, and all real-city tram joins.
- Invocation: `bun test src/ai/traffic/roadGraph.test.ts`
- Binary observable: exit 0; 5 pass / 0 fail / 745 expectations. The real city produced 334 directed rail edges, 188 verified continuations, 40 safe spawn edges near Casa, and a maximum sampled join-to-track error of 1.08 m.
- Artifact: `green-focused-final.txt`

## World geometry regression

- Scenario: exercise city mesh builders, geometry orientation, and built-world truth after extending generated permanent way through junction patches.
- Invocation: `bun test src/world/city/builders.test.ts src/world/geometryOrientation.test.ts src/world/worldTruth.test.ts`
- Binary observable: exit 0; 97 pass / 0 fail / 280 expectations.
- Artifact: `world-regression.txt`

## Static and patch validation

- Scenario: compile all TypeScript without emission.
- Invocation: `bun run typecheck`
- Binary observable: exit 0 (`tsc --noEmit`).
- Artifact: `typecheck.txt`
- Scenario: reject whitespace errors across the shared worktree.
- Invocation: `git diff --check`
- Binary observable: exit 0 with explicit `PASS: git diff --check`.
- Artifact: `diff-check.txt`
- Artifacts containing the reviewed implementation and regression-test diffs: `scoped.patch`, `test.patch`.
