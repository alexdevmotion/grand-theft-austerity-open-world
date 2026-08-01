# Audio attribution fix evidence

Date: 2026-08-01

## Success criteria

- **Atomic context telemetry:** `bun test src/audio/audio.test.ts` passed 68 tests, including `voice attribution telemetry > queued street emitters retain the active tuple until the queued line starts`. A real typed `VoiceDirector` fixture starts a parked-car line, queues doorway/kiosk requests, verifies the parked key/context/subtitle/route stay unchanged, ends the first source, and verifies the doorway context/key/subtitle/speaker tuple changes only when the queued source starts. Artifact: `focused-tests.txt`.
- **No unrelated audio regressions:** `bun test` passed 522 tests / 0 failures. Artifact: `full-tests.txt`.
- **Type and build safety:** `bun run typecheck` exited 0; `bun run build` exited 0 (Vite emitted only the existing chunk-size warning). Artifacts: `typecheck.txt`, `build.txt`.
- **Scoped diff hygiene:** `git diff --check -- src/audio/voiceDirector.ts src/audio/audio.test.ts` exited 0. Artifact: `diff-check.txt`.

## Regression source

The input QA evidence is `dogfood-output/2026-08-01-fixed/audio-doorway-after.json`: the active subtitle/key is `streetParkedCar` content while `lastContext` is `streetDoorway`. The fix carries `context` on every request and updates `lastContext` only through the start transition.
