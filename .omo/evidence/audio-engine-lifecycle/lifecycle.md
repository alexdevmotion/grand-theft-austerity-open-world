# Audio engine voice lifecycle evidence

Date: 2026-08-01

## Regression scenario

Scenario: an assigned vehicle voice is unbound while audio is ready. The voice
must be silenced, disconnected from its spatial panner, reconnected to the
shared vehicles bus, untracked from occlusion, released to the slot pool, and
have `voice.slot` reset to `null`; the vehicle and tracking maps must be
cleared. The same unbind must remain safe before audio is ready.

Invocation:

```text
bun test src/audio/audio.test.ts --test-name-pattern 'engine voice lifecycle'
```

Red artifact (before the implementation):

```text
1 fail
engine voice lifecycle > unbindEngine releases the voice slot and restores the shared bus
Expected length: 1
Received length: 0
```

Green artifact (after the implementation):

```text
2 pass
0 fail
15 expect() calls
```

The two passing cases are `unbindEngine releases the voice slot and restores
the shared bus` and `unbindEngine is safe before audio is ready`.

## Focused validation

Invocation:

```text
bun test src/audio/audio.test.ts
```

Observable: `67 pass`, `0 fail`, `1701 expect() calls`.

Invocation:

```text
bun run typecheck
```

Observable: `tsc --noEmit` exits 0 with no diagnostics.

Invocation:

```text
git diff --check -- src/audio/audioSystem.ts src/audio/audio.test.ts
```

Observable: exits 0 with no whitespace errors. Only the owned audio system and
audio test paths are changed by this task (the test file also contains unrelated
pre-existing concurrent edits, which were preserved).
