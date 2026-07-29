# Face pipeline: photo → 3D head, without the mask look

Two separate problems. Geometry gets you *who it is*; shading gets you
*that it's alive*. Solving only the first is exactly what produces the flat
pasted-mask look, and it is the more common failure.

## Part 1 — Geometry: photo → head

### Why not image-to-3D generators

TRELLIS, TripoSR, Hunyuan3D and friends produce good meshes from one photo, and
they are the wrong tool here. They emit arbitrary topology with no edge loops
around the eyes and mouth, no separate eyeballs or teeth, no rig, and lighting
baked into the texture. You cannot animate that with the state machine in
`src/characters/`, and you cannot relight it into a sunset.

### What we use instead: landmark-driven morphable fitting

Consistent topology is the whole point. Every character comes out with the same
vertex ordering, so **one rig, one blendshape set and one skin shader serve the
entire cast**, and a person's identity reduces to a small parameter vector
rather than a mesh asset.

The pipeline, which runs **offline, once per character**:

```
reference photo
  └─ MediaPipe FaceLandmarker (Apache-2.0, 3.7 MB model)
       └─ 478 3D landmarks + 52 blendshape scores + head-pose matrix
            └─ normalised proportion measurements
                 └─ deformation applied to the shared procedural head
```

Run it with:

```
bun run dev                      # serves the repo
open /tools/facefit/index.html   # fits every subject, draws an overlay
```

It writes `tools/facefit/out/faces.json` (~100 KB for four subjects) and
renders each photo with the landmark mesh drawn on top so a human can confirm
the fit actually landed on the face. **Always look at that overlay** — a
silently mis-fitted landmark set produces a confidently wrong head.

Measured for the current cast (normalised by face height, so crop-independent):

| measure | lead | ally | bolojan | nicusor |
| --- | --- | --- | --- | --- |
| jaw width | 0.781 | 0.783 | **0.887** | **0.928** |
| mouth width | 0.328 | 0.343 | 0.392 | **0.464** |
| nose width | 0.277 | 0.292 | 0.312 | **0.347** |
| brow raise | 0.082 | 0.092 | **0.111** | 0.105 |
| lip thickness | 0.006 | **0.017** | 0.006 | 0.004 |

These are genuinely discriminative and they are what carries recognition at
gameplay distance.

**Known caveat:** width measurements are foreshortened on three-quarter-view
photos (the `lead` and `ally` crops), so they read narrower than they are.
Before measuring, de-rotate the landmarks to frontal using the
`facialTransformationMatrixes` output, which the fitter already requests.

### Upgrade path, if more fidelity is wanted later

Swap the deformation step for a true morphable basis. **ICT-FaceKit** (MIT, USC
light-stage scans, 100 PCA identity modes) is the permissive choice;
**FLAME 2023 Open** (CC-BY-4.0) is the other. Both keep everything downstream
in this document unchanged — only the fitting step changes, because both emit
fixed topology exactly like the current path.

## Part 2 — Shading: why faces look like masks, and the fix

A head can have perfect geometry and still read as a photo glued to a
mannequin. Every item below is a cause, and all of them compound.

### 1. Baked lighting in the albedo — the biggest offender

A photograph already contains its own lighting. Use it directly as base colour
and the scene's sunset light multiplies *on top* of the studio light already in
the pixels. The result is double-lit, contrastless and pasted-on.

**Fix:** de-light the photo. Estimate the low-frequency lighting from the
fitted geometry (spherical harmonics) and divide it out to recover true albedo.
The cheap, effective version: keep only the *high-frequency* detail from the
photo (pores, stubble, blemishes) and rebuild the low frequencies from a flat
skin tone. Never let a shadow or a highlight survive into the albedo map.

### 2. No subsurface scattering

Skin is translucent. Light enters, bounces beneath the surface, and leaves
somewhere else, reddening as it goes. Without this, skin is indistinguishable
from painted plastic — this is the single most important shading effect for
organic material.

**Fix:** pre-integrated skin shading (Penner, SIGGRAPH 2011). A 2D lookup table
indexed by `N·L` and surface curvature, sampled in one pixel shader with no
blur passes — ideal for a forward renderer like ours. Generate the LUT
procedurally at boot. Scattering is only visible where incident light changes,
which is why curvature is the second axis.

### 3. No transmission through thin parts

Ears, nostrils and lips glow orange-red when lit from behind. With this game's
low sunset key light, that is constantly visible and enormously convincing.

**Fix:** a thickness map driving back-lit transmission.

### 4. One specular lobe, uniform roughness

Real skin has two specular lobes (a sharp oily layer over a broader one) and
roughness that varies across the face — glossy T-zone on forehead and nose,
matte cheeks, wet lips.

**Fix:** dual-lobe specular plus a roughness map with a real T-zone.

### 5. No micro-detail

At conversational distance, pores and fine wrinkles are what say "skin".
A smooth normal map reads as a balloon.

**Fix:** a high-frequency procedural pore/wrinkle normal layered over the base
normal, plus a cavity map darkening creases (nasolabial folds, eye corners,
under the brow).

### 6. Dead eyes — the single biggest tell

Eyes done as a flat textured sphere kill the whole face, no matter how good the
skin is.

**Fix:** cornea as a separate transparent shell with clearcoat and refraction;
iris set *behind* it with parallax so it has real depth; a darkened limbal ring;
sclera slightly subsurface with faint veins; a wet meniscus where the lid meets
the eyeball; and a genuine catchlight from the key light.

### 7. Hair as a solid blob

**Fix:** layered cards with alpha and anisotropic (Kajiya-Kay) specular, plus
some flyaway strands breaking the silhouette. Brows and lashes are separate
alpha geometry — Bolojan's heavy brows are his signature feature and must not
be painted on.

### 8. Perfect symmetry

Real faces are asymmetric; a mirrored face reads as CG instantly.

**Fix:** apply a small asymmetric offset to the fitted parameters, and let the
brow and mouth corners sit at slightly different heights.

### Budget

The full stack runs only for **hero characters near the camera** — four people,
not the crowd. Ambient pedestrians keep the cheap instanced path in
`src/ai/peds/rig.ts`. LOD the skin shader out by distance: past roughly 15 m,
drop SSS and micro-detail; past 30 m, fall back to the standard material.
