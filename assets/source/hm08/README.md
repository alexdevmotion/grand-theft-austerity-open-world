# MakeHuman HM08 anatomical source

`base.obj` is unmodified CC0 asset data from MakeHuman Community MPFB2 commit
`437dd513888a92399d1d3200d2e80859fae55abc`, downloaded 2026-09-05.

Source: https://github.com/makehumancommunity/mpfb2/blob/437dd513888a92399d1d3200d2e80859fae55abc/src/mpfb/data/3dobjs/base.obj

`LICENSE.CC0.md` is the upstream asset license. `UPSTREAM-LICENSE.md` explains the
separation between CC0 assets and GPL addon code. No addon program code is copied
into the game. The OBJ header also records the explicit September 2020 CC0 release
and its original copyright holders.

The independent `tools/blender/fit-anatomical-cast.py` crops the body group at the
neck, fits 31 sparse facial controls to the existing de-rotated photo landmark
clouds, and applies one Catmull-Clark subdivision step. It retains source UVs,
provides an editable Basis/Blink workshop scene, and exports the game mesh.

Run:

```sh
bun tools/blender/export-cast.ts
/opt/homebrew/bin/blender -b -t 2 --python tools/blender/fit-anatomical-cast.py
```

Outputs: `src/characters/face/generated/anatomical-cast.json`,
`assets/blender/anatomical-cast.blend`, and the studio image and fitting reports in
`tools/out/anatomical-cast/`. The workshop globe/iris display approximates the
runtime's layered eye shader.

Correspondence names and zero-based source vertex indices are explicit in the
script. The nose tip is source vertex 297; the source metadata's head-extrema
vertex 5320 is on the forehead and is not a nose landmark. Eye rims follow actual
skin vertices and use symmetrical source pairs validated by their coordinates.
The photo silhouette and monocular depth are uncertain: depth displacements are
restrained by per-control confidence, and unobserved skull/neck controls stay near
the neutral source. This is a fitted anatomical reconstruction, not a scan or a
validated digital double. Individual likeness still requires portrait review.

After subdivision, `sourceIndices` records the nearest original control vertex
for provenance, not a one-to-one topology identity. Original fitting control IDs
remain exact in the `correspondences` field. The emitted mesh and Blink array use
identical vertex ordering; UV seam duplicates retain matching positions/normals.
