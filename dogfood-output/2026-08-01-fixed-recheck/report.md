# Grand Theft Austerity — final residual live recheck

Date: 2026-08-01  
URL: `http://127.0.0.1:5273/`  
Browser discipline: stale `checker` was closed first; one shared checker session was opened once, all scenarios ran sequentially in it, and it was closed once at the end. No production or server files were edited.

## Verdict

**PASS.** The crowd separation fix holds in the immediate same-eval publication path at both 80 and 120 pedestrians. The live audio queue preserves the parked-car state while the doorway request is queued, then starts a fresh doorway line with the correct source context and visible speaker/subtitle. Fresh boot and final runtime/error checks are clean apart from the known tolerable Rapier initialization deprecation warning.

## manualQa

### surfaceEvidence

| Scenario | Criterion reference | Surface and exact invocation | Verdict | Artifact refs |
|---|---|---|---|---|
| R1 | Fresh boot/runtime/perf sanity | `GTA_BROWSER_SLOTS=1 tools/gta-browser checker open 'http://127.0.0.1:5273/'`; `wait 3000`; `eval ready/stats`; `screenshot`; `console`; `errors` | PASS — ready, FPS `59.92`, 120 peds, 25 traffic, no page errors | A1–A4 |
| R2 | Immediate crowd publication at 80 | One synchronous eval: `P.clear(); P.fill(80); wardrobe IDs; state positions; min pair/player distances`; then `frameHere` and screenshot | PASS — 80 active, min pair `0.7399999999999883m` (IDs `ped57`/`ped63`), player min `2.8658m` | A5–A7 |
| R2-120 | Immediate crowd publication at 120 | One synchronous eval: `P.clear(); P.fill(120); state positions; min pair; performance timer` | PASS — 120 active, min pair `0.7399092823m`, compute `9.2ms` | A8 |
| R3 | Audio unlock/readiness and live attribution queue | Real canvas click; `(async()=>{await __GTA_AUDIO__.waitReady(); ...})()`; warm doorway/parked caches; start parked source; submit doorway while parked remaining `0.16s`; poll actual doorway start | PASS — queued request leaves parked `lastKey/context/nowPlaying/route` and visible Dacia subtitle unchanged; later `lastContext=streetDoorway`, `DINTR-UN MAGAZIN`, doorway text | A9–A12 |
| R4 | Final runtime/errors/perf and shutdown | `eval final stats/voice`; `screenshot`; `console`; `errors`; `close --all` | PASS — FPS `67.99`, 120 peds/72 traffic, audio ready, no fatal/runtime errors; checker closed | A13–A17 |

### adversarialCases

| Scenario | Criterion reference | Adversarial class | Expected behavior | Verdict | Artifact refs |
|---|---|---|---|---|---|
| ADV-1 | R1/R4 | Runtime failure / fatal overlay | No `RuntimeError`, `unreachable`, recursive unsafe aliasing, fatal overlay, or page errors | PASS | A2, A3, A4, A14, A15 |
| ADV-2 | R2 | Immediate publication overlap | Pair separation is at least `0.739m` before yielding or framing | PASS — `0.7399999999999883m` | A5 |
| ADV-3 | R2-120 | Dense 120 stress | Same-eval 120-ped publication retains hard separation and completes promptly | PASS — `0.7399092823m`, `9.2ms` | A8 |
| ADV-4 | R3 | Queued emitter attribution | While parked line is active, doorway request cannot mutate current playback state/subtitle | PASS — parked state identical before/during queue | A11 |
| ADV-5 | R3 | Fresh queued start | After parked line ends, queued doorway actually starts with doorway context/speaker/text | PASS — `streetDoorway`, `DINTR-UN MAGAZIN`, source-specific line | A12 |
| ADV-6 | R3 | Banned editorial fragments | No dopamine/test/medical-fragment content in the forced lines | PASS — parked and doorway captures contain none | A11, A12 |

### artifactRefs

| ID | Kind | Description | Path |
|---|---|---|---|
| A1 | telemetry | Fresh boot ready/stats (`ready:true`, FPS 59.92) | `dogfood-output/2026-08-01-fixed-recheck/boot-state.json` |
| A2 | screenshot | Fresh boot gameplay frame | `dogfood-output/2026-08-01-fixed-recheck/boot.png` |
| A3 | console | Fresh boot console; only known deprecation warning | `dogfood-output/2026-08-01-fixed-recheck/boot-console.txt` |
| A4 | errors-summary | Fresh boot page errors empty | `dogfood-output/2026-08-01-fixed-recheck/boot-errors-summary.txt` |
| A5 | telemetry | Same-eval 80 publication, pair IDs/positions and thresholds | `dogfood-output/2026-08-01-fixed-recheck/crowd-immediate-80.json` |
| A6 | telemetry | Crowd framing invocation result | `dogfood-output/2026-08-01-fixed-recheck/crowd-frame.json` |
| A7 | screenshot | Dense crowd after render | `dogfood-output/2026-08-01-fixed-recheck/crowd-dense.png` |
| A8 | telemetry | Same-eval 120 publication, pair IDs/positions and 9.2ms compute | `dogfood-output/2026-08-01-fixed-recheck/crowd-immediate-120.json` |
| A9 | telemetry | Reloaded audio ready after real click and awaited `waitReady()` | `dogfood-output/2026-08-01-fixed-recheck/audio-ready-reload.json` |
| A10 | telemetry | Warmed doorway/parked source buffers with actual start snapshots | `dogfood-output/2026-08-01-fixed-recheck/audio-warm.json` |
| A11 | telemetry | Parked source active; doorway request queued; current parked state/subtitle unchanged | `dogfood-output/2026-08-01-fixed-recheck/audio-live-queue-regression.json` |
| A12 | telemetry | Actual queued doorway start with `streetDoorway` and `DINTR-UN MAGAZIN` subtitle | `dogfood-output/2026-08-01-fixed-recheck/audio-live-queue-regression.json` |
| A13 | telemetry | Final stats/audio/traffic state | `dogfood-output/2026-08-01-fixed-recheck/final-state.json` |
| A14 | console | Final console | `dogfood-output/2026-08-01-fixed-recheck/final-console.txt` |
| A15 | errors-summary | Final page errors empty | `dogfood-output/2026-08-01-fixed-recheck/final-errors-summary.txt` |
| A16 | screenshot | Final gameplay frame | `dogfood-output/2026-08-01-fixed-recheck/final.png` |
| A17 | transcript | Single checker close at end | `dogfood-output/2026-08-01-fixed-recheck/browser-close.txt` |
