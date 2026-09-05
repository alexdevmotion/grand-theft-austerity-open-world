# Realism pass — 5 September 2026

The current direction is natural Romanian urban lighting, worn communist-era
vehicles and more restrained anatomy. The main characters remain fictional
composites; photographs guide their proportions rather than becoming textures.

## Implemented

- Blender 5.2.1 LTS installed and verified headlessly. Reproducible cast, vehicle
  and building workshop commands are in `BLENDER.md`.
- Four real portraits fitted and visually checked: Agatinei, Bolojan, Nedea and
  Dan. All three playable/story head identities use these fits. A CC0 MakeHuman
  anatomical base now provides proper lips, nostrils, ears and eyelid topology,
  fitted through 31 controls per character and subdivided in Blender.
- Three anatomical heads and blink shape keys are cooked into the runtime.
  Their original UVs carry locally bundled CC0 male skin detail. Pupil visibility,
  corneal highlights, skin shading, brows, lashes, beard and hairline were corrected. Acceleration/braking posture and pivot steps improved.
- Dacia proportions/brightwork and ARO utility body rebuilt or refined. Glazing,
  paint, aged clearcoat, wheels and corrosion use the scene lighting.
- Natural sky/key/fill and grading replace the strong magenta cast. Apartment
  windows vary in occupancy/colour; concrete has restrained weathering. Thin
  foliage replaces solid canopy lobes and wind now runs before projection.

## Verified locally

- Production build and typecheck passed. Vite still reports a large bundle
  warning (approximately 12.83 MB JavaScript before gzip, 4.24 MB gzipped).
- Full suite: 680 tests passed, zero failures, 60,687 assertions across 58 files
  after anatomical heads, skin textures, hair and paint changes. The final neck
  seam adjustment passed all three anatomical tests (78 assertions), and the
  regenerated fallback workshop passed seven sculpt tests (7,112 assertions).
- Reopened Blender files verified: three fitted anatomical heads with Blink and photo controls,
  six fallback sculpt meshes and assembly parts, nineteen vehicle variants with wheels/door pivots, three architectural
  collections with eight runtime meshes.
- Built preview rendered all three identities and a profile view, plus local
  street/landmark/day/night/rain captures. Screenshots are under
  `tools/out/anatomical-final/` for the current cast and
  `tools/out/realism-final/` for the environment and pristine Dacia. Earlier
  diagnostic portraits show superseded procedural geometry.
- In the built preview, the Dacia moved approximately 78 m from the broadcast
  plaza road spawn, collided and remained driveable; braking stopped it. Exit
  returned to on-foot mode, then sprint input moved the player approximately
  104 m. These are short control checks, not a campaign playthrough.
- Final built-preview blink replay observed 14 closing frames and 506 open
  frames with zero lash-visibility mismatches; browser page errors were empty.
- One shared Chrome test session was used and closed after verification. Observed high-quality screenshot
  samples ranged roughly 29–57 fps across views; this is not a controlled frame
  pacing benchmark and does not establish a steady 60 fps.

The first combined development screenshot/drive harness was interrupted by HMR
when another asset changed. Its partial driving output is not a passing test;
subsequent control checks used the static built preview.

## Remaining limits

These are fitted anatomical reconstructions, not scanned digital doubles or a
GTA VI-level asset set. Close-up hair, clothing, crowd models and facial acting
remain the largest fidelity limits. Generic skin detail is not the photographed
person's skin. Bundle size also needs a later streaming/asset compression pass. Vehicles and buildings have native
Blender authoring exports, but their manual Blender edits do not yet cook back
into the game; the cast has reproducible geometry/Blink cook scripts, but arbitrary manual
sculpts still require explicitly exporting through that pipeline.

The secondary source review is in `gameplay-story-review.md`: physical server
cargo, speaker-aware performances, mission vehicle matching and dialogue timing
are the most useful next immersion work. No campaign rewrite was made.

Changes are local. Nothing was committed, pushed or deployed.
