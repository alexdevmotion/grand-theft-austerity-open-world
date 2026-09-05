# Blender asset workflow

Blender 5.2.1 LTS is installed at `/Applications/Blender.app`. Its CLI is
`/opt/homebrew/bin/blender`. Installation was verified with a headless Python
run; no third-party Blender extensions or online reconstruction service is
required.

## Cast

`bun run assets:cast` exports the three cast inputs, runs the fallback workshop
builder, then runs `tools/blender/fit-anatomical-cast.py` for the main anatomical
heads. The primary outputs are:

- `assets/blender/anatomical-cast.blend`: three editable photo-fitted HM08 heads,
  preserved UVs, `Basis`/`Blink` shape keys, eyes, camera and studio lights.
- `src/characters/face/generated/anatomical-cast.json`: fitted positions, normals,
  UVs, triangles, blink offsets and eye anchors bundled into the game.
- `tools/out/anatomical-cast/`: studio render, fitting report and explicit source
  correspondences for inspection.

The fitter starts from the CC0 MakeHuman HM08 anatomical mesh, crops it at the
neck, fits sparse facial controls to the de-rotated photo landmark clouds, and
subdivides once. The player blends Agatinei and Bolojan references; the other two
heads use Nedea and Dan. Original face-corner UVs survive fitting, subdivision
and seam splitting. Generic CC0 MakeHuman male skin maps supply surface colour
and detail. They are not the photographed subjects' skin albedo. Mesh and skin
provenance is retained in [assets/source/hm08](../assets/source/hm08/README.md)
and [its skin directory](../assets/source/hm08/skin/README.md).

Runtime geometry uses the existing head frame, look-at, body rig and ragdoll.
The anatomical `Blink` morph closes the fitted eye aperture. The game loads
local cooked data and textures; playing requires neither Blender nor the
reference-photo downloads.

`tools/blender/build-cast.py` still creates the fallback workshop at
`assets/blender/cast.blend` and sparse procedural sculpt/blink offsets in
`src/characters/face/generated/cast-sculpts.json`. Its six meshes cover two
procedural detail levels for the three characters. The runtime uses these
sculpts when an anatomical cook is unavailable or invalid; unsupported fallback
topology retains the procedural head. This workshop is separate from the main
anatomical mesh and is not its authoring source.

Rebuilding replaces generated blend files and cooked data. Preserve manual
artist variants separately before running it. The current fitting is an
anatomical reconstruction guided by sparse photo landmarks, not a scan or a
validated digital double. Unobserved anatomy and likeness still require visual
review and, where needed, manual sculpting.

## Vehicles and buildings

`bun run assets:vehicles` builds `assets/blender/vehicles.blend` from the actual
runtime fleet, including separate body materials, wheels and door pivots. See
[vehicle-realism.md](vehicle-realism.md) for photo references and model changes.

`bun run assets:buildings` builds `assets/blender/buildings.blend` from the
runtime socialist bloc and landmark constructors. See
[building-realism.md](building-realism.md) for mesh and material details.

These workshops preserve editable runtime geometry. Their Blender materials
approximate the WebGL shaders; vehicle and building edits are not automatically
cooked back into the game. The anatomical cast geometry and both pipelines'
blink offsets do have a runtime cook step. Rebuild commands overwrite their generated workshop files.

## Real-photo inputs

The offline fitter at `/tools/facefit/index.html` now reads photographs for
Alexandru Agatinei, Alex Nedea, Ilie Bolojan and Nicușor Dan. It extracted 478
landmarks per photograph; the overlays were inspected. Agatinei and Bolojan
remain blended for the player. Nedea guides the Recorder ally, with blue-grey
eyes and a cleaner, swept hairstyle. See `reference/ATTRIBUTION.md` for sources.

The Nedea and Agatinei portrait files remain local and are ignored by Git.
To refit from a fresh clone, obtain them from the linked source portraits in
`reference/ATTRIBUTION.md` and save them under the listed local filenames.
The committed landmark data and cooked meshes do not require those downloads.

After a reference change, run the fitter through the development server,
inspect every overlay, export `window.__FACEFIT__` to
`tools/facefit/out/faces.json`, then rebuild the cast. Photo lighting is not
used as albedo. Studio inputs are excluded from the Vite production bundle.

## Checks

`bun test src/characters/face` checks anatomical bounds, actual pupil visibility
against the face mesh, anatomical rig alignment and blink closure, both fallback
Blender topology levels, and stable finite geometry. `bun run typecheck` and
`bun run build` verify integration.
Use rendered portrait views as well: geometric checks cannot judge likeness,
hair quality or skin under the scene's lighting.
