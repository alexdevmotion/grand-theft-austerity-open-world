# Integrated core repairs — code-quality re-review

Date: 2026-08-01  
Scope: re-review of the four previously blocking core findings only: rendered tram joins, grounded occupied-vehicle recovery, vehicle despawn lifecycle coverage, and melee service/player consequence coverage. Concurrent crowd/audio work in the shared worktree was not judged. `omo ulw-loop status --json` returned `ULW_LOOP_PLAN_MISSING`, so this report uses the required fallback evidence path.

## Decision

- `codeQualityStatus`: **CLEAR**
- `recommendation`: **APPROVE**
- `reportPath`: `.omo/evidence/review_core_repairs-code-review.md`
- `blockers`: **None**

## Findings by severity

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None.

## Closure of prior findings

### H1 — tram joins remain on rendered/published permanent way: closed

- `src/world/city/roads.ts:245-274` now renders the grid permanent way from road node to road node, including the junction patch, rather than only over the trimmed carriageway span.
- `src/world/city.ts:517-521` publishes those exact node-to-node centrelines through the `CityService.tramLines` contract.
- `src/ai/traffic/roadGraph.ts:469-507` independently samples the complete exit/corner/entry waypoint bridge against physical track centrelines and rejects both centreline and swept-body deviations, in addition to blocked geometry.
- `src/ai/traffic/roadGraph.test.ts:178-289` builds the production city and checks all accepted continuations against reconstructed visible track geometry. It reported 173 rendered lines, 334 directed rail edges, 188 continuations, a 42.3 m longest join, and a 1.08 m maximum join-to-track deviation, all within the production sweep invariant.
- Independent concrete repro: edge `93` exits at `(-113, -1.92)` and continuation `169` enters at `(-71, -1.92)`, with corner `(-92, -1.92)`. The bridge is still exactly 42.0 m, but all 15 sampled points were 0.000 m from the rendered track. Published/rendered segments now meet at the junction node `(-92, 0)` from all four directions.

### M1 — recovery requires failed dwell in both directions and preserves back-out: closed

- `src/vehicles/vehicleSystem.ts:199-275` keeps separate `forwardStalledSeconds` and `reverseStalledSeconds` clocks and requires at least one second of failed dwell in each direction, as well as the overall 3.5 second stall threshold.
- Moving, becoming unoccupied, or leaving the grounded state clears both directional histories; a neutral pedal change decays the entire attempt together.
- `src/vehicles/recovery.test.ts:22-92` proves forward-only waiting cannot recover, one reverse sample cannot recover, a second stopped reverse sample can complete a genuine bidirectional attempt, and a queued driver who begins moving backward clears the detector without teleporting. It also covers stale-attempt expiry and the two-wheel wedge case.

### M2 — lifecycle test exercises the real despawn transaction: closed

- The prior one-line `releaseVehicleAudioBinding` wrapper is absent from production and tests.
- `src/vehicles/vehicleLifecycle.test.ts:31-117` calls the real `VehicleSystem.despawn` method. It verifies the occupied guard is mutation-free, then asserts audio unbind and collider-map invalidation occur before rigid-body removal, all owning collections are cleared, damage is disposed, and repeated teardown is idempotent.
- The narrowly typed white-box harness injects only the private collaborators needed to reach the real transaction; it does not replace or mirror the despawn implementation.

### M3 — melee tests execute service consequences and player dispatch/accounting: closed

- `src/ai/peds/melee.test.ts:96-175` calls `PedSystem.meleeStrike` and verifies civilian/protected-faction heat, impact audio, fatal state, and exactly one `ped:killed` event through the existing consequence path.
- `src/gameplay/playerMelee.test.ts:29-78` calls the real `PlayerSystem.performMeleeImpact` dispatch path and verifies body-facing origin/vector, damage, hit count, retained last-hit data, and camera feedback.
- Production wiring inspected at `src/ai/peds.ts:547-565` and `src/gameplay/player.ts:771-789` matches the exercised service boundaries.

## Verification performed

- Focused: `bun test src/ai/traffic/roadGraph.test.ts src/vehicles/recovery.test.ts src/vehicles/vehicleLifecycle.test.ts src/ai/peds/melee.test.ts src/gameplay/playerMelee.test.ts` — **19 pass, 0 fail, 903 assertions**.
- Full: `bun test` — **518 pass, 0 fail, 8,971 assertions across 27 files**.
- `bun run typecheck` — **pass** (`tsc --noEmit`).
- `git diff --check` — **pass**.
- Independent production-city geometry probe — **pass**; concrete `93 -> 169` join sampled at 0.000 m maximum track deviation.
- No browser or server was launched, per assignment.

## Skill-perspective check

- The available `code-review` skill was read and applied. Its suggested delegation phase was omitted because active instructions prohibit sub-agent delegation unless explicitly requested.
- `remove-ai-slops` and `programming` are not present in the available skill catalog or filesystem skill roots, so their supplied review criteria were applied directly.
- `remove-ai-slops`: **no violation in the repaired scope**. The replacement tests execute substantive production behavior; none are deletion-only, tautological, removal-only, or solely constant-mirroring. No unnecessary production extraction/parsing/normalization was introduced to close these findings.
- `programming`: **no violation in the repaired scope**. The tests exercise stable service/transaction boundaries rather than prompts or copied implementation algorithms. No production `any`, suppression, needless repair abstraction, or boundary-irrelevant validation/parsing was introduced. The test-only `unknown as` casts are narrow, explicitly shaped white-box harnesses needed to invoke private production transactions and do not erase types downstream.

## Blockers before approval

None.
