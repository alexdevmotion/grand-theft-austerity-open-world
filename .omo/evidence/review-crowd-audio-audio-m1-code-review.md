# Audio M1 residual re-review

## Verdict

- `codeQualityStatus`: WATCH
- `recommendation`: REQUEST_CHANGES
- External verdict: BLOCK
- Reviewed worktree base: `0e888762cbff6fe1ea8e9c85a5e016e58b05f886`

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

1. `src/audio/voiceDirector.ts:382-386`, `src/audio/audio.test.ts:781-840`, `src/audio/audio.test.ts:849-870` — the fake-node seam is not type-correct at the public method under test. `requestStreet` still accepts DOM `AudioNode`, while `FakeNode` implements only `VoiceAudioNode`. Bun executes the test without type-checking it, but a direct TypeScript check reports TS2345 at all three calls. This is the untyped test escape hatch the typed structural seam was meant to eliminate. Change `requestStreet`'s destination parameter to `VoiceAudioNode` (which real browser `AudioNode` structurally satisfies), or otherwise make the fixture satisfy the actual public boundary.

2. `src/audio/audio.test.ts:892-903` — the queued-start assertions do not prove that `lastKey` belongs to the same doorway line as `nowPlaying`; they only prove it differs from the parked-car key. A wrong unrelated key combined with the correct doorway context/text/route would pass. Assert the exact key/text pairing from the source pool or another public playback record.

### LOW

None.

## Confirmed behavior

- The unreachable telemetry `request` event and no-op reducer branch are removed: `src/audio/voiceDirector.ts:78-100`.
- The test constructs the real `VoiceDirector`, real `EventBus`, and public fake context/source/buffer objects without touching private director state: `src/audio/audio.test.ts:780-847`.
- Public `requestStreet` calls start parked-car playback, enqueue doorway and kiosk, preserve the active tuple/subtitle, end the fake source, advance the clock, drain the queue, and verify doorway context/text/route, speaker, destination, and start time: `src/audio/audio.test.ts:849-903`.
- Reintroducing request-time `lastContext = context` would fail `src/audio/audio.test.ts:874`, after the doorway and kiosk requests.

## Independent commands

- `bun test src/audio/audio.test.ts --test-name-pattern 'queued street emitters retain the active tuple until the queued line starts'` -> 1 pass, 0 fail, 29 assertions.
- `rg -n "type: 'request'|VoicePlaybackTelemetryEvent|reduceVoicePlaybackTelemetry|requestStreet\\(" src/audio/voiceDirector.ts src/audio/audio.test.ts` -> no request-event branch or reducer-only request test.
- `bunx tsc --noEmit --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --strict src/audio/audio.test.ts` -> TS2345 at test lines 850, 867, and 870 because `FakeNode` is not assignable to `AudioNode` (plus expected standalone-test environment errors for `bun:test` and `import.meta.env`).
- `git diff --check -- src/audio/audio.test.ts src/audio/voiceDirector.ts` -> clean.

## Skill-perspective checks

The named `remove-ai-slops` and `programming` skills are unavailable, so their documented criteria were applied directly. The fake-node/public-boundary mismatch is an untyped test escape hatch, and the weak key assertion provides incomplete confidence; these violate the programming perspective. No deletion-only, tautological, prompt-mirroring, or unnecessary production parsing/normalization issue was found.
