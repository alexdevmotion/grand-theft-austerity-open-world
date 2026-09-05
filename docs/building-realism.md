# Editable building workshop

`assets/blender/buildings.blend` contains three metre-scale architectural collections exported from the game's actual TypeScript constructors. These are editable indexed meshes, not images or screenshot planes.

| Collection | Runtime source | Editable meshes | Triangles |
| --- | --- | ---: | ---: |
| `socialist-bloc` | `buildBuilding` with `DISTRICTS.cartier`, a 46 × 13 m plot and nine storeys | 2 | 1,560 |
| `builders-house` | `buildBuildersHouse` | 3 | 27,942 |
| `parliament` | `buildParliament` | 3 | 39,190 |

The bloc is a representative runtime archetype. The landmark constructors are the ones used by the game. Their workshop seeds reproduce the same export deterministically; this is not a dump of a running city save.

## Open and edit

Open `assets/blender/buildings.blend` in Blender. Each asset-marked collection has an empty parent, an editable facade mesh, and a detail mesh. The landmarks also retain their actual forecourt surface meshes. In Edit Mode, **Select Linked** selects an individual connected component of the merged detail geometry.

Four cameras provide a workshop overview and individual building views. The scene has metric units, Z-up coordinates, a daylight rig and a neutral ground. Runtime `(x, y, z)` becomes Blender `(x, -z, y)`, retaining a right-handed coordinate system. The parent objects record the original world origins and constructor parameters; their workshop layout offsets are separate from the mesh coordinates.

Retained data includes:

- Indexed triangles and custom normals.
- `RuntimeMetreUV` on facades and surfaces.
- Per-vertex facade style, storey height, bay width, seed, ground-floor height, occupancy and tint.
- Per-vertex detail colour, emission, metalness and roughness.
- Foliage transmission/wind attributes and ground surface parameters.
- Runtime collision/landmark metadata on each parent, for reference.

## Rebuild and verify

Run from the repository root with Bun and Blender available on `PATH`:

```sh
bun tools/blender/export-buildings.ts
blender -b -t 2 --python tools/blender/build-buildings.py
blender -b -t 2 --python tools/blender/build-buildings.py -- --verify
```

Export writes ignored intermediate JSON to `tools/blender/input/buildings.json`. Build writes the `.blend` and `assets/blender/buildings-manifest.json`. **Rebuilding replaces the workshop file; save manual edits under a different filename first.**

Verification reopens the saved file and checks the source hash, every vertex and triangle, material slots, custom normals, metre UVs, detail colours/PBR values, asset collections, camera and lighting. Coordinate tolerance is 0.00005 m after float conversion. It also checks that no material uses an image texture.

For an optional Cycles overview render while rebuilding:

```sh
blender -b -t 2 --python tools/blender/build-buildings.py -- --render
```

## Material and runtime boundary

Detail colour and PBR attributes feed Blender's Principled shader directly. Facade and ground materials are editable Blender-node approximations: windows, frame bands, recessed bump and weathering provide a useful authoring view, but they are **not a pixel-identical port of the browser's GLSL**. The original facade, landmark and material TypeScript sources are retained as Blender text blocks for comparison. Runtime wind data is retained as attributes; it is not animated in this workshop.

This is an authoring export. Saving edits in Blender does not alter the browser game. A building mesh/material cook and import path still needs to be implemented before Blender changes can replace the runtime geometry. No runtime construction, palette or gameplay files were changed to create this workshop.

Validated with Blender 5.2.1 LTS: three asset collections, eight runtime meshes, 111,638 vertices and 68,692 triangles, plus the separate workshop ground.
