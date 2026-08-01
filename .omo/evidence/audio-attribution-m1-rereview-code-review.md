# Audio attribution M1 re-review

- `codeQualityStatus`: **BLOCK**
- `recommendation`: **REQUEST_CHANGES**
- Baseline: `HEAD` (`0e888762cbff6fe1ea8e9c85a5e016e58b05f886`) versus the latest shared worktree
- Scope: prior final audio-attribution M1 only
- Reviewed files: `src/audio/voiceDirector.ts`, `src/audio/audio.test.ts`
- Input note: no notepad path was supplied. Executor evidence was treated as untrusted and the focused behavior/type surface was checked independently.

## CRITICAL

None.

## HIGH

None.

## MEDIUM

### M1 — The fake node does not satisfy the public method it is passed to

Locations: `src/audio/voiceDirector.ts:216-234`, `src/audio/voiceDirector.ts:382-386`, `src/audio/audio.test.ts:780-851`.

The new fixture defines `FakeNode implements VoiceAudioNode`, but `VoiceAudioNode` is empty and `requestStreet` still requires the DOM `AudioNode`. `FakeNode` is therefore not assignable to the method's declared parameter type. Repository `tsc` does not reveal this because `tsconfig.json` excludes `*.test.ts`, and Bun transpiles/runs the test without TypeScript checking.

An independent TypeScript compiler probe reproduced TS2345 at all three real calls (`src/audio/audio.test.ts:850`, `:867`, `:870`): `FakeNode` is missing the DOM `AudioNode` members. This means the claimed typed fake-node boundary is incomplete even though there is no explicit `any` or cast.

Narrow correction: make `requestStreet` consistently accept the same meaningful `VoiceAudioNode` port used by `Request.destination`, or provide a properly coupled playback adapter/port, then typecheck the test fixture rather than relying only on Bun's transpiler.

### M2 — The test does not associate the new key with the doorway text

Location: `src/audio/audio.test.ts:892-903`.

After the queued doorway starts, the test verifies doorway context and text but checks the key only with `lastKey !== parked.key`. An unrelated non-parked key would pass. The requested atomic `context/key/text/route` proof therefore remains partial.

Narrow correction: find the started line in `buildPools().reaction.streetDoorway` and assert that its `key` and `text` both equal `director.lastKey` and `director.nowPlaying`, alongside the existing context/route/speaker/destination/start-time checks.

## LOW

None.

## Verified clear behavior

- The production-unreachable telemetry `request` event is gone. `VoicePlaybackTelemetryEvent` now contains only `start` and `stop`, and runtime invokes those transitions (`src/audio/voiceDirector.ts:78-100`, `src/audio/voiceDirector.ts:277-287`, `src/audio/voiceDirector.ts:447`, `:460`, `:478`, `:501`).
- The regression instantiates the real `VoiceDirector` and `EventBus`, creates public fake context/source/buffer/node collaborators, starts a parked-car line, queues doorway and kiosk requests through `requestStreet`, preserves the active tuple and subtitle count, ends the source, advances the clock, calls `update`, and observes the doorway source start (`src/audio/audio.test.ts:780-903`).
- The fixture does not access or forge private state and contains no `as any`, `as unknown`, `Object.create`, or private-field cast.
- Reintroducing `this.lastContext = context` in `requestStreet` before scheduling would fail the parked-context assertion at `src/audio/audio.test.ts:874`; the original request-time retag defect is behaviorally covered on the accepted-queue path.
- Runtime applies the complete telemetry transition after `source.start()` and before emitting the subtitle (`src/audio/voiceDirector.ts:421-454`).

## Verification evidence

- `bun test src/audio/audio.test.ts` — **68 passed, 0 failed** (1,676 assertions).
- `bun run typecheck` — **passed for production**, but the repository configuration excludes test files.
- Scoped `git diff --check` — **passed**.
- Search confirmed no remaining telemetry `request` event or request-event test.
- Independent TypeScript compiler probe — **failed as expected** with TS2345 for all three `FakeNode` to `AudioNode` calls, substantiating M1.
- No browser or server was launched.

## Skill-perspective check

The available `code-review` skill was consulted and its independent spec and standards axes ran. Both reproduced the fake-node type-boundary problem; the spec axis also reproduced the incomplete key/text association. The requested `remove-ai-slops` and `programming` skills were absent from the installed catalog, so their prompt-supplied criteria were applied directly.

- `remove-ai-slops`: **violated** by M2's partial, implementation-shaped key assertion.
- `programming`: **violated** by M1's nominally typed fixture crossing a public signature it does not satisfy while normal typecheck excludes the test.

## Blockers before approval

1. Make the fake playback node genuinely assignable through the public `requestStreet` boundary and include the fixture in a real TypeScript check.
2. Assert that the doorway `lastKey` and `nowPlaying` belong to the same started doorway line.
