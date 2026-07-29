# Architecture

## Stack

| Concern | Choice | Why |
| --- | --- | --- |
| Language | TypeScript 5.9, strict | Contracts between parallel contributors |
| Bundler / dev | Vite 8 | Instant HMR on a large source tree |
| Renderer | three.js 0.185 (WebGL2) | Mature, shader-level control, runs everywhere |
| Post FX | `postprocessing` 6.39 + `n8ao` | HDR chain, SSAO, bloom, AgX tone mapping |
| Physics | Rapier 0.19 (`rapier3d-compat`) | Deterministic, fast, good raycast-vehicle support |
| Package manager / runtime | Bun | Project standard |

WebGPU was rejected for now: the post chain, SSAO and shadow tooling we depend
on are WebGL2-mature, and headless GPU capture for the critic loop is reliable
there. Nothing in the architecture prevents a later `WebGPURenderer` swap —
rendering is confined to `src/render/`.

## Frame model

```
requestAnimationFrame
  ├─ renderer.info.reset()
  ├─ input.update()
  ├─ while (accumulator >= 1/60)   → system.fixedUpdate()   physics, vehicles, AI
  ├─ system.update()                                        animation, camera, UI
  ├─ system.lateUpdate()                                    LOD, shadow snapping
  ├─ renderOverride() → EffectComposer.render()
  └─ input.postUpdate()
```

Fixed step is 1/60 with a 5-step backlog cap. `System.order` decides both init
and update sequence:

| Range | Phase |
| --- | --- |
| 0–9 | debug hooks, physics init |
| 10–99 | world: sky, lighting, weather, city, props |
| 100–199 | simulation: vehicles, peds, traffic, police |
| 200–299 | gameplay: player, wanted, progression, missions, activities |
| 300–399 | camera |
| 400–899 | presentation: audio, HUD |
| 900+ | post-processing |

## The service seam — read this before writing code

Subsystems **never import each other's classes**. They talk through the
interfaces in `src/core/services.ts`:

```ts
// publishing (in your system's init)
ctx.provide(Services.Traffic, this);

// consuming (anywhere)
const traffic = ctx.tryGet(Services.Traffic);   // undefined-safe
const physics = ctx.get(Services.Physics);      // throws if missing
```

Use `tryGet` unless your system genuinely cannot start without the dependency.
This is what lets the city, vehicle, AI, gameplay and UI work proceed in
parallel and integrate at the end.

Extending a contract is fine; **breaking one is not**. If you need a new
method, add it to the interface in `services.ts` in the same change.

## Determinism

The whole city is generated from seeds. Use `ctx.rng` / `new Rng(seed)` from
`src/core/rng.ts`, never `Math.random()`, for anything that shapes the world —
otherwise visual regression screenshots stop being comparable between runs.
`Math.random()` is fine for one-frame cosmetic jitter (camera shake, sparks).

## Automation contract

`window.__GTA_DEBUG__` (see `src/core/debug.ts`) is the stable API that
`tools/shot.mjs` and every critic drives. Adding methods is encouraged;
renaming or removing them breaks the critic loop.

```
node tools/shot.mjs --drive --out tools/out/roundN
```

Press `F1` in-game for the live stats overlay.

## Directory map

```
src/
  artDirection.ts     palette, sun, grade, world scale — single source of look
  core/               engine, services, events, input, rng, debug
  physics/            Rapier wrapper, collision groups, queries
  render/             renderer, post chain, grade, sky, lighting
  world/              city generation, props, weather
  vehicles/           vehicle simulation and bodywork
  ai/                 traffic, pedestrians, police
  gameplay/           player, camera, wanted, missions, activities, progression
  ui/                 HUD, map, menus
  audio/              procedural audio
tools/shot.mjs        screenshot + playtest harness
docs/reference/       the visual target
```

## File ownership

To keep parallel work conflict-free, each area has one owner at a time. Do not
edit files outside your area; if you need a change there, note it in your
report instead of making it.

## Audio verification must be silent

Automated verification renders audio but must never reach the machine's
speakers. Always launch the browser muted:

```
agent-browser --session gta --args "--mute-audio" open "http://127.0.0.1:5273/?q=high"
```

Chrome still runs the full WebAudio graph under `--mute-audio`, so
`AnalyserNode` taps, RMS/peak metering and spectral measurements all behave
normally — only the output device is silenced. Verify audio by **measurement**
(`window.__GTA_AUDIO__`) and by `OfflineAudioContext` unit tests, never by
playing it aloud.

## Browser verification is rate-limited

Each `agent-browser` session is a full headless Chrome — about a dozen
processes and a GPU context. Six verification agents in parallel meant six of
them alongside the developer's own browser, which ground the machine to a halt.

**Never call `agent-browser` directly.** Use the wrapper, which caps concurrent
browser holders at two (atomic-mkdir lock, auto-released on exit, stale locks
reaped by pid):

```
tools/gta-browser <session> open "http://127.0.0.1:5273/?q=high"
tools/gta-browser <session> screenshot /tmp/x.png
tools/gta-browser <session> eval "JSON.stringify(window.__GTA_DEBUG__.stats())"
```

It applies `--mute-audio` for you. Agents may still run in parallel — they
queue for a browser, which is fine because writing code dominates and browser
use is bursty. Raise the cap with `GTA_BROWSER_SLOTS` only if the machine can
take it.
