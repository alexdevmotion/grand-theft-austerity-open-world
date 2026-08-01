# Player melee evidence

## Selection and damage

- Scenario: one punch amid pedestrians in front, beside, and behind the player.
- Invocation: `bun test src/ai/peds/melee.test.ts`
- Binary observable: the nearest living pedestrian inside the 2.15 m / 38-degree forward cone loses exactly 34 health and enters the existing flee reaction; every other pedestrian remains at 100 health.
- Red artifact: `.omo/evidence/melee/red-selection-damage.log` (`applyPedMeleeStrike` missing; 0 pass / 1 fail).
- Green artifacts: `.omo/evidence/melee/green-selection-damage.log` and `.omo/evidence/melee/final-focused-tests.log`.

## Invalid target hardening

- Scenario: candidate list includes a dead ped, an out-of-reach ped, a ped on another vertical level, a valid target, a ped with a non-finite position, and a non-finite strike heading.
- Invocation: `bun test src/ai/peds/melee.test.ts`
- Binary observable: only the valid target loses health; corrupt inputs return no hit and cannot apply damage.
- Red artifacts: `.omo/evidence/melee/red-invalid-target.log` and `.omo/evidence/melee/red-invalid-heading.log`.
- Green artifacts: `.omo/evidence/melee/green-invalid-target.log`, `.omo/evidence/melee/green-invalid-heading.log`, and `.omo/evidence/melee/final-focused-tests.log`.

## One hit per punch / cooldown

- Scenario: attack is requested repeatedly before and immediately after the 0.5 s cadence boundary.
- Invocation: `bun test src/gameplay/playerMelee.test.ts`
- Binary observable: first request starts, repeated requests inside the interval are rejected, and the request at the completed interval starts exactly once.
- Red artifact: `.omo/evidence/melee/red-cooldown.log` (`MeleeCadence` missing; 0 pass / 1 fail).
- Green artifacts: `.omo/evidence/melee/green-cooldown-and-strike.log` and `.omo/evidence/melee/final-focused-tests.log`.

- Scenario: a started punch reaches its contact beat after 150 ms and cannot produce a second impact from later cadence ticks.
- Invocation: `bun test src/gameplay/playerMelee.test.ts`
- Binary observable: no impact at 140 ms, exactly one impact at 150 ms, no repeat at 160 ms.
- Red artifact: `.omo/evidence/melee/red-contact-timing.log`.
- Green artifacts: `.omo/evidence/melee/green-contact-timing.log` and `.omo/evidence/melee/final-focused-tests.log`.

## Browser QA fixture

- Scenario: the exact point ahead is blocked while another point in the production melee cone is walkable.
- Invocation: `bun test src/ai/peds/melee.test.ts`
- Binary observable: debug placement succeeds at 1.55 m, remains inside the 38-degree cone, and uses the reported ground height.
- Red artifact: `.omo/evidence/melee/red-debug-target.log`.
- Green artifacts: `.omo/evidence/melee/green-debug-target.log` and `.omo/evidence/melee/final-focused-tests.log`.
- Live seam for the independent checker: `__GTA_PEDS__.spawnMeleeTarget()`, `__GTA_PEDS__.state(id)`, `__GTA_PEDS__.combatTarget()`, and `__GTA_CHAR__.combat()`.

## Production wiring and preserved interaction

- Scenario: accepted click/Q punch routes through `PlayerSystem` to `PedService`, produces punch/hit feedback, adds assault heat, and leaves `F` as interact.
- Invocation: `git diff --quiet -- src/core/input.ts` plus focused `rg` over the input/service/player/ped wiring.
- Binary observable: input file is unchanged with `KeyF: 'interact'`; service call, punch audio, hit camera shake, wanted heat, combat diagnostics, and deterministic QA target/state hooks are all present.
- Artifact: `.omo/evidence/melee/wiring-observables.log`.

## Regression and compile gates

- Scenario: existing player locomotion/footing behavior plus new melee behavior.
- Invocation: `bun test src/gameplay/player.test.ts src/gameplay/playerMelee.test.ts src/ai/peds/melee.test.ts`
- Binary observable: 24 pass / 0 fail / 509 assertions.
- Artifact: `.omo/evidence/melee/final-focused-tests.log`.

- Scenario: repository TypeScript contract after extending `PedService`.
- Invocation: `bun run typecheck`
- Binary observable: exit 0 (`tsc --noEmit`).
- Artifact: `.omo/evidence/melee/final-typecheck.log`.

- Scenario: patch whitespace/integrity check.
- Invocation: `git diff --check`
- Binary observable: exit 0 with explicit PASS marker.
- Artifact: `.omo/evidence/melee/diff-check.log`.

## Concurrent-suite disclosure

- Invocation: `bun test`
- Observable at capture time: 490 pass / 3 fail; failures are confined to concurrent owners' new `src/ai/traffic/roadGraph.test.ts` (2) and `src/ai/peds/crowd.test.ts` (1), outside this assignment and explicitly prohibited from editing here. The melee tests pass inside the same run.
- Artifact: `.omo/evidence/melee/full-suite.log`.

## Exact scoped patch

- Artifact: `.omo/evidence/melee/scoped-changes.patch` (572 lines, SHA-256 `60ae7c404b2e7d60a01f26734b89d0628409b86a68b33a92008b7148cb727081`).
