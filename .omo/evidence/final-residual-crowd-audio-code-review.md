# Final residual crowd/audio code review

- `codeQualityStatus`: **BLOCK**
- `recommendation`: **REQUEST_CHANGES**
- Baseline: `HEAD` (`0e888762cbff6fe1ea8e9c85a5e016e58b05f886`) versus the current shared worktree
- Scope: immediate crowd attachment publication, late in-vehicle player steering, and voice attribution at the playback boundary; regression check of the prior crowd/audio findings
- Input note: no notepad path was supplied. Existing executor/reviewer evidence was treated as untrusted and the core claims were reproduced independently.

## CRITICAL

None.

## HIGH

None.

## MEDIUM

### M1 — The queued-emitter regression exercises a production-unreachable no-op instead of the queue

Locations: `src/audio/voiceDirector.ts:76-95`, `src/audio/voiceDirector.ts:259-270`, `src/audio/audio.test.ts:791-825`.

The test named “a queued emitter cannot retag the line that is already speaking” does not instantiate `VoiceDirector`, call `requestStreet`, enter `schedule`, queue/drop a request, or reach `play`. It passes a synthetic `{ type: 'request' }` event directly to `reduceVoicePlaybackTelemetry` and asserts the deliberately hard-coded no-op.

Production never emits that event. `applyTelemetry` is called only with `start` or `stop` (`src/audio/voiceDirector.ts:429`, `:442`, `:460`, `:483`). Therefore the `request` event variant exists only for this test. Reintroducing the original defect—such as assigning `lastContext` in `requestStreet` before `schedule` accepts or rejects the request—would leave this regression green. The test gives false confidence at exactly the requested boundary and the production event type is speculative complexity.

The production implementation currently behaves correctly: an independent typed `VoiceDirector` probe started a parked-car line, queued a doorway line, filled the queue and rejected another doorway line, and observed no attribution changes until the queued doorway source actually called `start()`. At that start, `lastKey`, `lastContext`, `nowPlaying`, and `route` changed together before the subtitle observer ran. The blocker is the requested meaningful, runtime-connected regression seam, not a reproduced runtime attribution defect.

Narrow correction: remove the unused `request` telemetry event and test the real `VoiceDirector` request/schedule/play path with a small typed clock/source/buffer fixture. Assert the parked tuple remains unchanged after both queue and drop, then advance the fake clock and assert the complete doorway tuple changes only when the second source starts. Alternatively, make a request-boundary seam genuinely used by production and test through that same path.

## LOW

None.

## Verified clear areas

### Immediate crowd attachments

- Every production attachment enters `PedSystem.attach`, and `attach` calls `CrowdGrid.publish` before returning (`src/ai/peds.ts:500-508`, `src/ai/peds.ts:594-610`, `src/ai/peds.ts:751`, `src/ai/peds.ts:784`). Debug melee publication also runs after its final position/anchor override and before returning (`src/ai/peds.ts:342-355`).
- `publish` rebuilds the active population in stable ID order, runs the blocker-aware global solve, then synchronizes every final root (`src/ai/peds/crowd.ts:64-103`). This refreshes `crowdedAt`/`nearestAnchor` queries before the next boot/debug-fill spawn attempt (`src/ai/peds.ts:798-824`, `src/ai/peds.ts:941-948`).
- Independent sequential samples of 80 and 120 anchored attachments used an `x < 0` half-plane blocker. Both finished with minimum pair distance `0.740000`, no blocked roots/anchors, and every object transform equal to its solved root. Total publication cost was approximately **6.98 ms** for 80 and **12.80 ms** for 120 on this machine.

### Late M2

- Both hard player-root projection and soft player-obstacle steering are disabled when `playerInVehicle` is true (`src/ai/peds/crowd.ts:130-134`, `src/ai/peds/crowd.ts:1060-1071`).
- An independent off-centre probe with an empty vehicle grid ran 60 fixed steps and retained the exact starting root `(5.4, 9)`.

### Audio runtime and prior findings

- All production attribution assignments are centralized through `applyTelemetry`; playback start occurs before the complete telemetry transition (`src/audio/voiceDirector.ts:259-270`, `src/audio/voiceDirector.ts:403-444`). Queued, rejected, failed-load, and expired requests have no attribution write.
- The typed physical-source mapping, playback-pool denylist, and engine-release paths from earlier findings remain intact; the focused audio suite passed.
- Earlier crowd blocker safety, stable-ID integrate/solve/sync ordering, reversed-list equivalence, anchor safety, and in-vehicle rectangular vehicle ownership remain intact; the focused crowd suite passed.

## Verification evidence

- `bun test src/ai/peds/crowd.test.ts src/audio/audio.test.ts` — **80 passed, 0 failed** (1,947 assertions).
- `bun test` — **523 passed, 0 failed** (9,222 assertions).
- `bun run typecheck` — **passed**.
- `bun run build` — **passed**; only the existing large-chunk advisory was emitted.
- `git diff --check` — **passed**.
- Independent crowd model — **passed** 80/120 immediate-attachment separation, blocker, anchor, publication, and performance checks.
- Independent late-M2 model — **passed** 60 fixed steps with no off-centre in-vehicle drift and no vehicle sample.
- Independent real `VoiceDirector` model — **passed** queued/drop immutability and atomic start transition; this exposed the gap between correct runtime behavior and the committed pure-reducer regression.
- No browser or server was launched.

## Skill-perspective check

The available `code-review` skill was consulted and its independent spec and standards axes ran. The spec axis was clear; the standards axis independently reproduced M1. The requested `remove-ai-slops` and `programming` skills were absent from the installed catalog, so their prompt-supplied criteria were applied directly.

- `remove-ai-slops`: **violated** by M1's test-only no-op transition and implementation-shaped regression.
- `programming`: **violated** by M1's production-unreachable event branch and a test that mirrors the reducer instead of exercising the behavioral boundary. No untyped escape hatch was introduced.

## Blockers before approval

1. Replace the synthetic reducer `request` assertion with a regression that traverses the real typed `VoiceDirector` queue/rejection and actual-start boundary, or make the tested request seam genuinely runtime-used.
