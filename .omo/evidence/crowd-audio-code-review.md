# Crowd realism and audio code review

- `codeQualityStatus`: **BLOCK**
- `recommendation`: **REQUEST_CHANGES**
- Baseline: `HEAD` versus the current working tree, including untracked `src/ai/peds/crowd.test.ts`
- Scope: crowd separation/anchors/player interaction, imposter LOD/head/hair/dog capacity, street voice selection/exclusions/provenance, and engine voice teardown
- Input note: no notepad path was supplied; executor summaries were not used as evidence.

## CRITICAL

None.

## HIGH

### H1 — Separation can move pedestrians and permanent anchors into blockers

Locations: `src/ai/peds/crowd.ts:64-139`, `src/ai/peds/crowd.ts:194-211`, `src/ai/peds/crowd.ts:1118-1138`.

`CrowdGrid.rebuild` changes roots (and, for anchored pairs, their authored targets) without access to `SpatialQuery`. Both later fan solvers also fall back to the original radial point after every candidate was reported blocked. The new hard-separation invariant can therefore violate the pre-existing no-building invariant.

Independent reproduction: two active peds at `(0.1, 0)` and `(0.2, 0)` beside a half-plane blocker `x < 0` were rebuilt to `a.x = -0.220005`, `b.x = 0.520005`; `a` was placed inside the blocker. A second probe made every 0.74 m fan candidate blocked and `CrowdGrid.depenetrate` still committed one of those blocked coordinates.

Failure scenario: pedestrians overlap near a facade/corner; the frame-start solver pushes one through the facade, and an anchored pair can permanently move its anchor through the wall.

Narrow correction: pass the spatial query into the global solve, validate each proposed side independently, apply the full correction to the safe side when possible, and retain/revert to a last-known safe point when no candidate is open. Never commit the currently blocked radial fallback. Add half-plane and closed-corner tests for ordinary, anchored, and player separation.

## MEDIUM

### M1 — Post-integration results still depend on mutable pedestrian array order

Locations: `src/ai/peds.ts:866-878`, `src/ai/peds/crowd.ts:174-224`, `src/ai/peds/crowd.ts:1073-1076`; missing coverage at `src/ai/peds/crowd.test.ts:100-117`.

The frame-start pairs are ID-sorted, but each `Ped.update` subsequently moves only the currently iterated ped against live neighbours. Reversing identical A/B state produced `a.x=-0.36,b.x=0.38` versus `a.x=-0.38,b.x=0.36`. The current test executes only A then B and checks distance, so it cannot substantiate the replay-safe/order-independent claim.

Narrow correction: integrate all peds first, then run one stable-ID global depenetration phase (or otherwise guarantee stable solve order) before syncing transforms. Add a reversed-input test that compares per-ID positions, not only pair distance.

### M2 — The on-foot player projection also runs while the player is driving

Locations: `src/ai/peds/crowd.ts:1102-1104`; the available `env.playerInVehicle` is populated at `src/ai/peds.ts:871-873` but ignored.

An anchored ped at the player vehicle origin is projected only 0.9 m from the vehicle centre. That competes with the existing rectangular vehicle-footprint logic and can still leave the ped inside a stationary car (`carHalfWidth=0.94`, `carHalfLength=2.15`).

Narrow correction: run the circular player-body projection only on foot and leave in-vehicle interaction to the vehicle footprint solver. Add an in-vehicle regression test.

### M3 — Street context is inferred from Romanian display copy

Locations: `src/audio/streetVoices.ts:31-37`, `src/audio/voiceDirector.ts:60-65`, `src/audio/audioSystem.ts:673-678`, `src/audio/audioSystem.ts:1743`, `src/audio/audio.test.ts:760-762`.

Callers already know `e.kind`, but production passes a subtitle label and `streetContextForSpeaker` parses words from it. Any copy/localization change silently falls through to the kiosk pool. The test repeats the current strings rather than exercising the runtime `EMITTER_SPEAKER` mapping, so it would stay green if those constants changed.

Narrow correction: pass the typed `StreetEmitterKind`/`StreetVoiceSource` separately from the speaker label and map it exhaustively to context; test the actual runtime mapping.

### M4 — Engine teardown tests forge impossible private states through `as any`

Locations: `src/audio/audio.test.ts:779-837`.

Both tests bypass construction with `Object.create(AudioSystem.prototype) as any` and reconstruct private maps/nodes. In particular, the test named "before audio is ready" seeds a `voiceByVehicle` entry, although engine voices/slots are created only after unlock. This is an untyped, implementation-mirroring test: useful helper assertions, but not evidence for the real ready/unready lifecycle boundary.

Narrow correction: use a typed lifecycle seam/fixture and exercise the real pre-ready path (`bindEngine` then `unbindEngine`) plus a ready slot whose pool active/tracked state is observed before and after release.

### M5 — The exclusion regression includes deletion-only mirrored assertions

Locations: `src/audio/audio.test.ts:734-750`.

The test repeats the three requested phrases as regexes and separately checks the same raw curated table against `STREET_EXCLUDED_FILES`. This is removal-mirroring coverage rather than a playback-boundary test and adds false confidence about the production filter.

Narrow correction: keep one behavioral assertion over `buildPools().reaction` for every street context and the denylist, and remove the duplicate phrase-specific assertions. Preserve the production file-level gate if defense in depth is desired.

## LOW

None.

## Verified clear areas

- Rig changes: dog heads use the untextured blob pool; near/far face pools remain unused by dogs; `blobCap = maxPeds * 2` covers one human crown plus one dog head per pedestrian; shell transforms stayed above the face midline in the focused tests.
- Street assets: all 17 new source-specific entries matched `src/audio/manifest.json` exactly for file, duration, and transcript, and all corresponding `public/` assets existed.
- Engine production teardown: for the reachable ready-state path, `releaseEngineVoice` silences, reconnects the shared bus, untracks/releases the slot, nulls it, and removes vehicle/tracked ownership. No production defect was reproduced there.
- Performance: a 120-ped spaced-grid microprobe averaged about 0.10 ms per rebuild; no performance blocker was found.

## Verification run

- `bun test src/ai/peds/crowd.test.ts src/ai/peds/rig.test.ts src/audio/audio.test.ts` — **78 passed, 0 failed**.
- `bun test` — **511 passed, 0 failed**.
- `bun run typecheck` — **passed**.
- No browser or server was launched.

## Skill-perspective check

The available `code-review` skill was consulted and its standards/spec axes were run. The requested `remove-ai-slops` and `programming` skills were absent from both the installed skill catalog and filesystem, so their prompt-supplied criteria were applied directly.

- `remove-ai-slops`: **violated** by M5's deletion-only/mirrored assertions and M4's implementation-shaped fixture.
- `programming`: **violated** by M1's order-sensitive solver, M3's display-text parsing, and M4's untyped escape hatch.

## Blockers before approval

1. Make every pedestrian/player depenetration path preserve `SpatialQuery.isBlocked === false`, including the no-open-fan case and anchor updates.
2. Add focused blocker/corner regressions that fail against the current implementation and pass only when roots and anchors remain outside geometry.
