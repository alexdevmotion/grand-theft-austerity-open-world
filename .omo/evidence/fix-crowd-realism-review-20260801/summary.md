# Crowd realism review repair evidence

Status: PASS

Scope owned in this repair:

- `src/ai/peds/crowd.ts`
- the crowd-frame call in `src/ai/peds.ts`
- `src/ai/peds/crowd.test.ts`

No browser or development server was launched. Unrelated work in the shared checkout, including the melee changes already present in `src/ai/peds.ts`, was preserved.

## H1: blocker-safe pedestrian and player correction

Scenario: ordinary and anchored pairs overlap beside an `x < 0` blocker, then repeat in a closed corner where every correction candidate is blocked. The on-foot player case repeats both geometries. The tests require all moved roots and permanent anchors to remain open, require separation when a safe side exists, and require exact retention when no safe candidate exists.

Implementation observable: `CrowdGrid.resolve` supplies `SpatialQuery` to every pair/player correction; pair plans validate both proposed roots and any moved anchors before commit; the player fan commits only open candidates; there is no blocked radial fallback.

Invocation: `bun test src/ai/peds/crowd.test.ts src/ai/peds/rig.test.ts src/audio/audio.test.ts`

Binary observable: the three blocker/corner tests pass as part of `83 pass, 0 fail`.

Artifacts:

- `red-ordinary-blockers.txt` and `green-ordinary-blockers.txt`
- `red-anchored-blockers.txt` and `green-anchored-blockers.txt`
- `red-player-blockers.txt` and `green-player-blockers.txt`
- `final-focused-suite.txt`

## M1: source-list-order-independent frame solve

Scenario: the same two scripted pedestrians integrate toward one another twice, first from `[a, b]` and then `[b, a]`; final X/Z coordinates are compared by stable pedestrian ID.

Implementation observable: `CrowdGrid.rebuild` establishes stable-ID integration order, `CrowdGrid.step` integrates the complete prepared population, performs one stable-ID global solve, and only then calls `syncAfterCrowdStep`. `PedSystem.fixedUpdate` uses that frame transaction. The old per-ped mutable-neighbour depenetration and pre-solve transform sync paths are removed.

Invocation: `bun test src/ai/peds/crowd.test.ts --test-name-pattern 'source list is reversed'`

Binary observable: the new test changes from `TypeError: grid.step is not a function` to `1 pass, 0 fail`, with four per-ID coordinate assertions.

Artifacts:

- `red-order-independent-frame.txt`
- `green-order-independent-frame.txt`
- `final-focused-suite.txt`

## M2: driving uses the vehicle footprint

Scenario: an anchored pedestrian and player share the same ground coordinate while `playerInVehicle` is true.

Implementation observable: the on-foot circular player projection is gated by `!playerInVehicle`; the pedestrian remains at the vehicle origin so the existing rectangular vehicle-footprint path owns the interaction.

Invocation: `bun test src/ai/peds/crowd.test.ts --test-name-pattern 'on-foot player projection stays inactive'`

Binary observable: the regression changes from a projected X coordinate of `4.614257578396155` instead of `5` to `1 pass, 0 fail` with exact X/Z retention assertions.

Artifacts:

- `red-player-in-vehicle.txt`
- `green-player-in-vehicle.txt`
- `final-focused-suite.txt`

## Integration and performance gates

Scenario: all review-related crowd/rig/audio tests, the entire repository test suite, TypeScript compilation, whitespace validation, and a 120-ped blocker-aware global-solve probe.

Invocations and binary observables:

- `bun test src/ai/peds/crowd.test.ts src/ai/peds/rig.test.ts src/audio/audio.test.ts` -> `83 pass, 0 fail` in `final-focused-suite.txt`.
- `bun test` -> `520 pass, 0 fail` in `final-full-suite.txt`.
- `bun run typecheck` -> exit 0 in `final-typecheck.txt`.
- `git diff --check -- src/ai/peds/crowd.ts src/ai/peds/crowd.test.ts src/ai/peds.ts` -> explicit PASS in `diff-check.txt`.
- 1,000 blocker-aware solves over 120 spaced pedestrians -> `averageMs: 0.03375820899999999`, below the executable 2 ms ceiling, in `performance-120-peds.txt`.

## Remaining boundary

This repair provides deterministic simulation and code-level evidence only. Interactive browser play was deliberately not started in this worker because the parent owns the single permitted browser instance and independent checking pass.
