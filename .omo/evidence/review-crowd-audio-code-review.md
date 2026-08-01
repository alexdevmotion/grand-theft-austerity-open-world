# Crowd and audio residual code review

## Verdict

- `codeQualityStatus`: CLEAR
- `recommendation`: APPROVE
- `blockers`: None.
- Reviewed commit/worktree base: `0e888762cbff6fe1ea8e9c85a5e016e58b05f886`

## Findings

### CRITICAL

None.

### HIGH

None.

### MEDIUM

None.

### LOW

None.

## Verification

- Fresh attachment publication is stable-ID ordered and blocker-aware, moves anchored roots and anchors together, and synchronizes object transforms before returning: `src/ai/peds/crowd.ts:64-73`, `src/ai/peds/crowd.ts:94-103`, `src/ai/peds/crowd.ts:105-184`, `src/ai/peds.ts:594-610`.
- Boot/debug fill cannot consult a previous-frame crowd grid after a successful attachment because every `attach` publishes synchronously; debug melee republishes after its post-spawn relocation: `src/ai/peds.ts:304-308`, `src/ai/peds.ts:342-354`, `src/ai/peds.ts:798-824`.
- Both soft player-circle steering and hard player-root projection are disabled while the player is in a vehicle: `src/ai/peds/crowd.ts:130-134`, `src/ai/peds/crowd.ts:1060-1071`.
- Voice source identity is carried in the queued playback request. Telemetry changes only at actual start/stop; request, queue, and rejection paths do not retag the playing line: `src/audio/voiceDirector.ts:61-103`, `src/audio/voiceDirector.ts:259-270`, `src/audio/voiceDirector.ts:364-400`, `src/audio/voiceDirector.ts:403-444`.
- Runtime calls the typed street-source seam: `src/audio/audioSystem.ts:722-729`, `src/audio/audioSystem.ts:1789-1793`.

Independent commands:

- `bun test src/ai/peds/crowd.test.ts src/audio/audio.test.ts` -> 80 pass, 0 fail, 1947 assertions.
- Inline 80/120-ped attachment sample -> minimum root distances `0.7399999999999977` and `0.7399999999999982`; zero blocked roots, zero unsynchronized objects; approximately 8.0 ms and 13.8 ms respectively.
- Inline real `VoiceDirector` fake-WebAudio probe -> queued doorway request preserved the playing parked-car key/context/subtitle/route; rejected doorway request preserved the playing radio tuple.
- `git diff --check -- <reviewed crowd/audio files>` -> clean.

Relevant regression tests: `src/ai/peds/crowd.test.ts:178-207`, `src/ai/peds/crowd.test.ts:258-276`, `src/ai/peds/crowd.test.ts:296-325`, `src/audio/audio.test.ts:777-839`.

## Skill-perspective checks

The named `remove-ai-slops` and `programming` skills were not installed, so their prompt-documented criteria were applied directly. No deletion-only, tautological, constant-mirroring, brittle prompt, or implementation-only tests were found in this residual scope; no untyped escape hatch, needless abstraction, or unnecessary production parsing/normalization was introduced. The available `code-review` skill was consulted and followed.
