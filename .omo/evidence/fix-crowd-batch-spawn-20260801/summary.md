# Immediate crowd spawn publication repair

Status: PASS

No browser or development server was launched. The parent retains ownership of the single browser instance and independent browser recheck.

## Verified diagnosis

The browser artifact `dogfood-output/2026-08-01-fixed/crowd-metrics-ready.json` records 80 live pedestrians immediately after `P.clear(); P.fill(80)`, with `ped14` and `ped19` anchored at the same X/Z root and `minPairDistance: 0`.

`CrowdGrid` was rebuilt before the fixed pedestrian step, but `fill` and the boot-time stream attach several pedestrians after that step. `crowdedAt` and `nearestAnchor` therefore queried the previous population snapshot, and debug `fill` returned before another solver frame. Cleared pedestrians could also remain in the stale cell snapshot until a rebuild. Public `spawn` additionally attached before its final route placement.

## Criterion 1: spawn/fill returns valid roots immediately

Scenario: attach 80 anchored pedestrians as 40 live-like duplicate-anchor pairs. After every individual attachment, measure every X/Z pair, then verify all published object transforms match the corrected roots.

Implementation observable:

- `CrowdGrid.publish` performs the blocker-aware stable-ID solve and publishes transforms synchronously.
- `PedSystem.attach` calls `publish`, so every boot stream, normal stream, cluster spawn, and debug fill attachment refreshes the grid and exposes a solved root before returning.
- `crowdedAt` ignores inactive stale entries left by clear/despawn.
- Public `spawn` completes route placement before attachment publication.
- The melee debug fixture republishes after its deliberate post-spawn reposition.

Red invocation: `bun test src/ai/peds/crowd.test.ts --test-name-pattern 'batch of anchored spawns'`

Red binary observable: `TypeError: grid.publish is not a function`, `0 pass, 1 fail`.

Green invocation: the same targeted test.

Green binary observable: `1 pass, 0 fail`, 242 assertions; after each attachment the minimum distance is at least `0.739` m and the final population is exactly 80.

Artifacts:

- `red-batch-spawn-publication.txt`
- `green-batch-spawn-publication.txt`

Additional production-scale probe invocation: a Bun script sequentially publishes 120 anchored pedestrians arranged as 60 duplicate pairs and exits nonzero below `0.739` m or above 100 ms.

Probe binary observable: `live: 120`, `minPairDistance: 0.7399999999999977`, `totalMs: 15.268125000000001`.

Artifact: `batch-publication-probe.txt`.

## Criterion 2: no circular player drift while driving

Scenario: an anchored pedestrian begins 0.4 m off-centre from a player marked in-vehicle, with an empty vehicle grid. This removes the exact-coincidence blind spot from the previous regression.

Implementation observable: both the hard circular projection and soft circular steering are gated by `!env.playerInVehicle`; vehicle interaction remains owned by vehicle samples/footprints.

Red invocation: `bun test src/ai/peds/crowd.test.ts --test-name-pattern 'off-centre vehicle player'`

Red binary observable: expected X `5.4`, received `5.478000000000001` after 0.1 s, proving 7.8 cm of circular drift; `0 pass, 1 fail`.

Green invocation: the same targeted test.

Green binary observable: exact X/Z retention, `1 pass, 0 fail`.

Artifacts:

- `red-off-centre-vehicle-steering.txt`
- `green-off-centre-vehicle-steering.txt`

## Regression and delivery gates

- Scenario: crowd, melee, and rig integration. Invocation: `bun test src/ai/peds/crowd.test.ts src/ai/peds/melee.test.ts src/ai/peds/rig.test.ts`. Binary observable: `22 pass, 0 fail`, 366 assertions. Artifact: `focused-peds-suite.txt`.
- Scenario: repository regression. Invocation: `bun test`. Binary observable: `523 pass, 0 fail`, 9,222 assertions. Artifact: `full-suite.txt`.
- Scenario: static typing. Invocation: `bun run typecheck`. Binary observable: exit 0. Artifact: `typecheck.txt`.
- Scenario: production compilation/bundle. Invocation: `bun run build`. Binary observable: 173 modules transformed and Vite build completed successfully in 775 ms; only the pre-existing large-chunk advisory remains. Artifact: `build.txt`.
- Scenario: targeted patch hygiene. Invocation: `git diff --check -- src/ai/peds.ts src/ai/peds/crowd.ts src/ai/peds/crowd.test.ts`. Binary observable: explicit PASS. Artifact: `diff-check.txt`.

## Preserved invariants

The immediate publication uses the existing blocker-aware stable-ID resolver, so half-plane/closed-corner root and anchor safety, per-ID reversed-order equivalence, on-foot player separation, moving-pair separation, and loiter-anchor behavior remain covered and green in `focused-peds-suite.txt` and `full-suite.txt`.
