# Tram routing evidence

No browser or development server was launched for this task, per assignment.

## Red-capable regressions

- Scenario: a rank-2 road with no rendered permanent way must not be tram-routable.
  Invocation: `bun test src/ai/traffic/roadGraph.test.ts`
  Observable: `Expected: false`, `Received: true` on `edge.tram` before the fix.
  Artifact: `red-roadgraph.txt` (repeat: `red-roadgraph-repeat.txt`).
- Scenario: a displaced tram must recover to rail rather than the closest ordinary road.
  Invocation: `bun test src/ai/traffic/roadGraph.test.ts`
  Observable: `TypeError: graph.nearestTramLane is not a function` before rail-only recovery was implemented.
  Artifact: `red-tram-recovery.txt`.
- Scenario: mapped rail lanes and their joins must not intersect city building footprints.
  Invocation: `bun test src/ai/traffic/roadGraph.test.ts`
  Observable: 17 blocked lane samples, then one blocked continuation, before corridor/join validation.
  Artifacts: `real-city-blocked-audit.txt`, `real-city-join-audit.txt`.

## Final verification

- Scenario: explicit generated/OSM rail mapping, both directions, signed lane offsets,
  safe continuations, long-body spawn clearance, rail-only recovery, and the real Casa
  Constructorilor neighborhood.
  Invocation: `bun test src/ai/traffic/roadGraph.test.ts`
  Observable: 4 pass / 0 fail; 173 rendered lines -> 314 directed rail edges,
  195 safe continuations, 1,192 rank-2 road edges rejected, 42 safe tram-spawn edges
  near Casa, longest safe join 42.0 m.
  Artifact: `focused-final-candidate.txt`.
- Scenario: all AI and world regressions.
  Invocation: `bun test src/ai src/world`
  Observable: 219 pass / 0 fail.
  Artifact: `ai-world-tests.txt`.
- Scenario: complete repository test suite.
  Invocation: `bun test`
  Observable: 506 pass / 0 fail, 8,907 assertions.
  Artifact: `full-test.txt`.
- Scenario: TypeScript integration.
  Invocation: `bun run typecheck`
  Observable: exit 0 (`tsc --noEmit`).
  Artifact: `typecheck-final.txt`.
- Scenario: production build.
  Invocation: `bun run build`
  Observable: exit 0; 173 modules transformed and Vite build completed.
  Artifact: `build.txt`.

## Residual boundary

Only rail corridors that can be aligned to the drivable road graph and proven clear are
used. Unmatched or building-crossing rendered rail fragments remain visual-only. A tram
retires at an unsafe/unmapped rail end instead of entering arbitrary asphalt. Browser QA
was intentionally left to the parent checking agent because this worker was explicitly
forbidden from launching a browser or server.
