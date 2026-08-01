# Grand Theft Austerity — post-fix manual QA

Date: 2026-08-01  
URL: `http://127.0.0.1:5273/`  
Browser constraint: one persistent `checker` session, every browser action through `GTA_BROWSER_SLOTS=1 tools/gta-browser checker ...`; no recorder was used. The checker was closed at the end and `session list` reported no active sessions.

## Verdict

Overall **FAIL**. Fresh boot, melee, trams, audio source pools (when the director is idle), stale lifecycle, and vehicle recovery all produced evidence. Crowd hard separation still fails: the computed minimum pair distance is `0.0m` (required approximately `0.74m`). A concurrent ambient-voice adversarial check also exposed a transient source/label mismatch before an idle-director retry recovered.

Residual severity: **high** for crowd overlap; **medium** for transient audio attribution. No fatal overlay, `RuntimeError`, `unreachable`, recursive unsafe aliasing, or browser page error was observed in the final checks.

## manualQa

### surfaceEvidence

| Scenario | Criterion | Surface and exact invocation | Verdict | Artifact refs |
|---|---|---|---|---|
| S1 | Fresh open/start, ready, FPS, console/errors | `GTA_BROWSER_SLOTS=1 tools/gta-browser checker open 'http://127.0.0.1:5273/'`; `wait 3000`; `eval 'JSON.stringify({ready:...,stats:...})'`; `console`; `errors`; `screenshot` | PASS | A1, A2, A3, A4 |
| S2 | Real melee Q/click, one hit, health 66, flee, wanted feedback; second target | `eval 'spawnMeleeTarget()'`; real canvas click to acquire pointer lock; second real click; `wait 240`; `eval combatTarget/stats`; repeat after cooldown | PASS | A5, A6, A7, A8, A9, A10 |
| S2-F | F remains distinct from punch | Fresh `spawnMeleeTarget()`; real canvas click; `press F`; `wait 300`; `eval combatTarget/stats` | PASS | A11, A12 |
| S3 | `fill(80)`, wardrobe/state positions, pair/player separation, dense crowd visual | `eval 'P.clear(); P.fill(80); wardrobe()+state() min-distance computation'`; `frameHere`; `screenshot` | FAIL | A13, A14, A15 |
| S4 | High traffic budget, live trams, position samples, rails/junction framing | `eval '__GTA_TRAFFIC__.setBudget(72); setDensity(2)'`; waits; `eval '__VEH__.list().filter(v=>v.kind==="tram")'`; `setCamera`; `screenshot` | PASS | A16, A17, A18, A19, A20, A21 |
| S5 | Audio unlock/readiness and source-specific editorial lines | Real canvas click; wait; `eval ready/streetVoices`; `sayStreet(0/1/2)` with `voice()` and subtitle capture | PASS with adversarial note | A22, A23, A24, A25, A26, A27 |
| S6 | Stale clear/refill cycles, physics progress, no freed-body failures | Three cycles of `eval P.clear(); T.clear()` → `wait 500` → `eval P.fill(80)` → `wait 1800` → stats; console/errors | PASS | A28, A29, A30, A31, A32, A33, A34, A35 |
| S7 | Vehicle giveVehicle, forward/steer/reverse movement and heading | `eval 'releaseCamera(); clearInput(); giveVehicle("dacia")'`; `setInput({throttle:1,steer:.28})`; wait; `setInput({throttle:-1,steer:-.22})`; wait; stats/list | PASS | A36, A37, A38, A39, A40, A41, A42 |
| S8 | Final stats/errors/screenshot and shutdown | `eval final stats`; `screenshot`; `console`; `errors`; `close --all`; `session list` | PASS | A43, A44, A45, A46, A47 |

### adversarialCases

| Scenario | Criterion | Adversarial class | Expected behavior | Verdict | Artifact refs |
|---|---|---|---|---|---|
| ADV-1 | S1/S6/S7 | Fatal runtime / stale Rapier body | No `RuntimeError`, `unreachable`, recursive unsafe aliasing, or fatal overlay | PASS | A3, A31, A35, A42, A45 |
| ADV-2 | S2 | Melee target isolation | Exactly one target takes 34 damage; no fan-out | PASS | A5, A6, A7, A8 |
| ADV-3 | S3 | Crowd pair separation | Every pair stays above the hard separation threshold (~0.74m) | FAIL — min pair `0.0m`; `ped14` and `ped19` share `[-56.1834, 23.1394]` | A14 |
| ADV-4 | S3 | Player-to-crowd separation | Nearest on-foot crowd member stays above ~0.9m | PASS — measured `2.4622m` | A14 |
| ADV-5 | S3 | Blocked-root hook | If an exposed blocked-root hook exists, no spawned root is blocked | NOT_APPLICABLE — `__GTA_PEDS__` exposed no block/valid/collision hook | A14 |
| ADV-6 | S4 | Tram route/facade penetration | Live tram is on visible rails, not pavement/facade | PASS — rails and junction are visible in framed capture | A20 |
| ADV-7 | S5 | Banned editorial fragments | No dopamine/test/medical-fragment subtitle | PASS in forced-source captures | A23, A25, A26, A27 |
| ADV-8 | S5 | Concurrent emitter attribution | Forced source retains its own kind/label/line even if ambient audio is active | FAIL — first doorway force queued a parked-car line/label; idle retry recovered | A24, A25 |
| ADV-9 | S7 | Reverse escape/recovery | Reverse input produces negative speed and heading/movement change without fatal overlay | PASS — `speed:-3.93`, position changed, errors empty | A38, A40, A42 |

### artifactRefs

| ID | Kind | Description | Path |
|---|---|---|---|
| A1 | screenshot | Fresh initial gameplay frame | `dogfood-output/2026-08-01-fixed/initial.png` |
| A2 | telemetry | Initial ready/stats (`ready:true`, FPS ~60, 120 peds) | `dogfood-output/2026-08-01-fixed/initial-state.json` |
| A3 | console | Initial console; only known Rapier deprecation warning | `dogfood-output/2026-08-01-fixed/initial-console.txt` |
| A4 | errors | Initial page errors (empty; non-empty summary) | `dogfood-output/2026-08-01-fixed/initial-errors-summary.txt` |
| A5 | telemetry | Melee target before real input | `dogfood-output/2026-08-01-fixed/melee2-before.json` |
| A6 | telemetry | First real click impact: health 66, flee, stars 1 | `dogfood-output/2026-08-01-fixed/melee2-after-attack-240ms.json` |
| A7 | screenshot | First real melee result | `dogfood-output/2026-08-01-fixed/melee2-after-attack.png` |
| A8 | telemetry | Second target before input | `dogfood-output/2026-08-01-fixed/melee-second-before.json` |
| A9 | telemetry | Second target impact and wanted state | `dogfood-output/2026-08-01-fixed/melee-second-after-240ms.json` |
| A10 | screenshot | Second melee result | `dogfood-output/2026-08-01-fixed/melee-second-after.png` |
| A11 | telemetry | F distinct before | `dogfood-output/2026-08-01-fixed/f-distinct-before.json` |
| A12 | telemetry | F distinct after: health remains 100, stars 0 | `dogfood-output/2026-08-01-fixed/f-distinct-after.json` |
| A13 | telemetry | Ready crowd baseline | `dogfood-output/2026-08-01-fixed/crowd-ready.json` |
| A14 | telemetry | `fill(80)` wardrobe/state distance computation; min pair `0.0m`, player min `2.4622m` | `dogfood-output/2026-08-01-fixed/crowd-metrics-ready.json` |
| A15 | screenshot | Dense crowd framed view | `dogfood-output/2026-08-01-fixed/crowd-dense-ready.png` |
| A16 | telemetry | High budget/density setup | `dogfood-output/2026-08-01-fixed/tram-budget.json` |
| A17 | telemetry | Three live trams after refill | `dogfood-output/2026-08-01-fixed/tram-live-50s.json` |
| A18 | telemetry | Tram position sample A | `dogfood-output/2026-08-01-fixed/trams-all-a.json` |
| A19 | telemetry | Tram position sample B | `dogfood-output/2026-08-01-fixed/trams-all-b.json` |
| A20 | screenshot | Tram visibly aligned with rails at junction | `dogfood-output/2026-08-01-fixed/tram-rails.png` |
| A21 | telemetry | Framed tram/traffic stats | `dogfood-output/2026-08-01-fixed/tram-frame-state.json` |
| A22 | telemetry | Audio ready + emitter positions/bed state | `dogfood-output/2026-08-01-fixed/audio-ready.json` |
| A23 | telemetry | Kiosk forced line/context/subtitle | `dogfood-output/2026-08-01-fixed/audio-kiosk-after.json` |
| A24 | telemetry | First doorway force showing transient mismatch | `dogfood-output/2026-08-01-fixed/audio-doorway-after.json` |
| A25 | telemetry | Idle doorway retry with correct shop label/line | `dogfood-output/2026-08-01-fixed/audio-doorway-retry.json` |
| A26 | telemetry | Parked-car force with concurrent subtitle | `dogfood-output/2026-08-01-fixed/audio-parkedcar.json` |
| A27 | telemetry | Idle parked-car retry with correct Dacia label/line | `dogfood-output/2026-08-01-fixed/audio-parkedcar-retry.json` |
| A28 | telemetry | Lifecycle cycle 1 clear | `dogfood-output/2026-08-01-fixed/lifecycle-1-clear.json` |
| A29 | telemetry | Lifecycle cycle 1 refill/after | `dogfood-output/2026-08-01-fixed/lifecycle-1-refill.json` |
| A30 | telemetry | Lifecycle cycle 2 clear/refill/after | `dogfood-output/2026-08-01-fixed/lifecycle-2-clear.json` |
| A31 | telemetry | Lifecycle cycle 2 final state with moving traffic | `dogfood-output/2026-08-01-fixed/lifecycle-2-after.json` |
| A32 | telemetry | Lifecycle cycle 3 clear/refill | `dogfood-output/2026-08-01-fixed/lifecycle-3-clear.json` |
| A33 | telemetry | Lifecycle cycle 3 final state | `dogfood-output/2026-08-01-fixed/lifecycle-3-after.json` |
| A34 | console | Lifecycle console | `dogfood-output/2026-08-01-fixed/lifecycle-console.txt` |
| A35 | errors | Lifecycle page errors (empty; non-empty summary) | `dogfood-output/2026-08-01-fixed/lifecycle-errors-summary.txt` |
| A36 | telemetry | Vehicle giveVehicle/in-vehicle state | `dogfood-output/2026-08-01-fixed/vehicle-before.json` |
| A37 | telemetry | Forward steering start/after | `dogfood-output/2026-08-01-fixed/vehicle-forward-after.json` |
| A38 | telemetry | Reverse input start | `dogfood-output/2026-08-01-fixed/vehicle-reverse-start.json` |
| A39 | telemetry | Reverse result (`speed:-3.93`) | `dogfood-output/2026-08-01-fixed/vehicle-reverse-after.json` |
| A40 | screenshot | Vehicle final gameplay frame | `dogfood-output/2026-08-01-fixed/vehicle-final.png` |
| A41 | console | Vehicle console | `dogfood-output/2026-08-01-fixed/vehicle-console.txt` |
| A42 | errors | Vehicle page errors (empty; non-empty summary) | `dogfood-output/2026-08-01-fixed/vehicle-errors-summary.txt` |
| A43 | telemetry | Final stats/audio/traffic state | `dogfood-output/2026-08-01-fixed/final-state.json` |
| A44 | screenshot | Final gameplay frame | `dogfood-output/2026-08-01-fixed/final.png` |
| A45 | console | Final console | `dogfood-output/2026-08-01-fixed/final-console.txt` |
| A46 | errors | Final page errors (empty; non-empty summary) | `dogfood-output/2026-08-01-fixed/final-errors-summary.txt` |
| A47 | transcript | Browser close and no-active-session verification | `dogfood-output/2026-08-01-fixed/browser-close.txt` |
