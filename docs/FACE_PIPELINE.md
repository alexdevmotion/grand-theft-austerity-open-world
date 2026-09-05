# Face pipeline

Real photographs guide the fictional cast; they are not pasted onto the mesh.
The reproducible Blender commands and authoring limits are in [BLENDER.md](BLENDER.md).

## Data flow

1. Serve the project with `bun run dev` and visit `/tools/facefit/index.html`.
2. MediaPipe fits 478 landmarks and a head-pose matrix to each of four photos:
   Alexandru Agatinei, Alex Nedea, Ilie Bolojan and Nicușor Dan.
3. Inspect every overlay, then export `window.__FACEFIT__` to
   `tools/facefit/out/faces.json`. The runtime derives frontal measurements;
   the player combines Agatinei and Bolojan, while the allies use Nedea and Dan.
4. `bun run assets:cast` exports cast inputs and runs both Blender scripts.
   `tools/blender/fit-anatomical-cast.py` fits the CC0 MakeHuman HM08 head to the
   three cast landmark clouds, preserves its UVs and authors a `Blink` shape key.
5. The main workshop is `assets/blender/anatomical-cast.blend`. Its cooked
   positions, normals, UVs, indices, blink offsets and eye anchors in
   `src/characters/face/generated/anatomical-cast.json` are bundled into the game
   and mapped to the existing head frame.
6. Generic CC0 HM08 skin PNGs in `public/textures/characters/` supply colour
   variation and skin detail using those preserved UVs. They contain no pixels
   from the named subjects' reference photographs. Source PNGs, material files,
   license and hashes live in [assets/source/hm08/skin](../assets/source/hm08/skin/README.md).

The fitter crops the anatomical mesh at the neck, constrains it with sparse
photo correspondences, and applies one subdivision step. Photographs constrain
proportions; they cannot recover hidden anatomy or the subject's skin
reflectance. This is a photo-fitted anatomical reconstruction, not a scan.
Likeness and facial performance still need rendered review.

`tools/blender/build-cast.py`, `assets/blender/cast.blend` and
`src/characters/face/generated/cast-sculpts.json` form the fallback procedural
workshop. It exports two detail levels and sparse sculpt/blink offsets. Runtime
uses that path if an anatomical cook is missing or malformed; the fallback
workshop does not generate the main HM08 topology.

## Rendering and animation

The near-camera heroes combine the generic skin colour maps with character
shading, restrained pore normals, scattering and regional roughness. Separate
recessed irises, corneal shells and lid geometry provide depth. Pupil visibility is tested against the actual
concave iris surface, because testing against an imaginary eyeball sphere can
miss skin occlusion. Blender eyelid morphs close that aperture during blinks.

Hair, brows, lashes and beard use geometric shells and strands. Their materials
must use consistent colour and coordinate spaces: Three colours are already
linear after construction from sRGB hex values, and light/view/tangent vectors
must share a space. Avoid extra colour conversion and broad reflective sheets
that make dark hair look like grey plastic.

The existing head bone, look-at, locomotion and ragdoll remain in use. Ambient
pedestrians keep their instanced path. Distance disables expensive hero detail;
missing or invalid anatomical data falls back to procedural geometry.

## Verification

Run `bun test src/characters/face`, `bun run typecheck` and `bun run build`.
Inspect front, three-quarter and profile portraits under daylight and dusk.
Tests cover finite geometry, anatomical constraints, pupil visibility, fitted
head rig alignment and blink closure, plus both fallback topology levels. They
cannot establish likeness or cinematic quality; rendered review remains necessary.

Source photos and attribution stay in `docs/reference/`, outside the production
asset bundle. Refit and regenerate when those inputs change. Do not overwrite
an artist's manual Blender work without preserving a separate source file.
