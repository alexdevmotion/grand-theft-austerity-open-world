# Crowd H1/M1/M2 finalized code review

- `codeQualityStatus`: **CLEAR**
- `recommendation`: **APPROVE**
- Baseline: `HEAD` (`0e888762cbff6fe1ea8e9c85a5e016e58b05f886`) versus the current shared worktree
- Scope: prior crowd findings H1, M1, and M2 only
- Reviewed files: `src/ai/peds.ts`, `src/ai/peds/behaviours.ts`, `src/ai/peds/crowd.ts`, and untracked `src/ai/peds/crowd.test.ts`
- Input note: no notepad path was supplied. Executor reports and existing evidence were treated as untrusted and the claims below were reproduced independently.

## CRITICAL

None.

## HIGH

None.

## MEDIUM

None.

## LOW

None.

## Verified acceptance criteria

### H1 — blocker-safe roots and anchors

`CrowdGrid.resolvePrepared` sends every pair and on-foot player correction through the blocker-aware solver (`src/ai/peds/crowd.ts:94-126`). Pair corrections validate both final roots and, when moved, permanent anchors before committing; if the default split is blocked the solver tries one-sided moves, and if none is safe it returns without a fallback (`src/ai/peds/crowd.ts:129-174`, `src/ai/peds/crowd.ts:213-230`). Player correction likewise commits only a safe fan candidate and returns unchanged when all candidates are blocked (`src/ai/peds/crowd.ts:176-210`).

Independent half-plane and closed-corner probes passed for ordinary pedestrians, anchored roots plus anchors, and an anchored pedestrian against the on-foot player. In every half-plane case all roots/anchors remained unblocked and reached the configured separation. In every closed-corner case no correction was committed.

### M1 — frame transaction and source-order independence

Active pedestrians are sorted by stable ID during `rebuild` (`src/ai/peds/crowd.ts:64-73`). `step` then integrates the complete ordered population, runs the global stable-ID solve, and only afterward publishes transforms (`src/ai/peds/crowd.ts:76-80`). `PedSystem.fixedUpdate` prepares the grid and uses that transaction (`src/ai/peds.ts:850-878`); per-ped integration no longer publishes an intermediate transform, while `syncAfterCrowdStep` publishes the solved root (`src/ai/peds/crowd.ts:587-615`, `src/ai/peds/crowd.ts:1013-1131`).

An instrumented independent probe observed exactly `update(id1), update(id2), sync(id1), sync(id2)` even when the source list was reversed, and each final object transform matched its solved root. The focused regression also compares forward and reversed source lists per pedestrian ID (`src/ai/peds/crowd.test.ts:252-281`) and passed.

### M2 — on-foot projection is inactive in a vehicle

The hard circular player-root solver is invoked only while `playerInVehicle` is false (`src/ai/peds/crowd.ts:119-123`). Vehicle contact remains based on the car-frame rectangle (`carHalfLength` and `carHalfWidth`) and its own hit path (`src/ai/peds/crowd.ts:624-691`). An independent probe left a pedestrian coincident with the player when `playerInVehicle=true`, then separately knocked down a pedestrian 1.5 m from the vehicle center—outside the 0.9 m player circle but inside the moving vehicle rectangle.

One independent standards axis raised the pre-existing soft steering term at `src/ai/peds/crowd.ts:1049-1060`. I did not classify it as a prior-M2 failure: it is steering rather than the hard positional projection under review, it predates this change, and its empty-vehicle-grid reproduction omits the runtime vehicle sample whose rectangular footprint owns contact. The exact-coincidence regression is relevant to the original M2 reproduction and the independent real-vehicle probe confirms rectangle ownership.

## Test and performance evidence

- `bun test src/ai/peds/crowd.test.ts` — **10 passed, 0 failed**.
- `bun test` — **520 passed, 0 failed**.
- `bun run typecheck` — **passed**.
- `bun run build` — **passed** (Vite production build completed; only the existing large-chunk advisory was emitted).
- `git diff --check` — **passed**.
- Independent invariant script — **passed** ordinary/anchor/player half-plane and closed-corner refusal, transaction order, final transform sync, in-vehicle projection disablement, and rectangular vehicle-footprint ownership.
- 120-ped solver microbenchmark — approximately **0.069 ms** per ordinary spaced resolve and **2.848 ms** per artificial exact-pile-up resolve on this machine. No performance blocker was reproduced.
- No browser or server was launched.

## Skill-perspective check

The available `code-review` skill was consulted and both its independent spec and standards axes were run. The requested `remove-ai-slops` and `programming` skills were absent from the installed skill catalog, so their prompt-supplied criteria were applied directly.

- `remove-ai-slops`: **no violation**. The tests exercise public production seams and behavioral outcomes; none are deletion-only, tautological, constant-mirroring, or dependent on unnecessary production parsing/normalization.
- `programming`: **no violation**. The crowd changes remain typed, use no escape hatches, and the tests do not parse source text or mirror private implementation state. The public `resolve` seam is small and directly supports deterministic collision tests.

## Blockers before approval

None.
