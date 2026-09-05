# Vehicle realism pass — 4 September 2026

The vehicle builders remain editable runtime geometry. No photograph is used as a billboard or claimed as a scanned 3D vehicle.

## References

- Existing `docs/reference/world/dacia-1300.jpg`: the front three-quarter photograph used for the narrow rectangular headlamps, chrome surrounds, bonnet, windscreen rake, slim roof edge, steel wheel proportions and period brightwork. Auxiliary lamps are accessories on this reference, retained on the game's established hero car.
- [1970 Dacia 1300 photographs](https://www.lesanciennes.com/annonce/dacia-1300-berline-1970-a588408): original white saloon proportions and trim.
- [Dacia 1300 dimensions](https://www.automobile-catalog.com/car/1970/128075/dacia_1300.html): 4.340 m long, 1.636 m wide, 1.434 m high. The existing 2.44 m wheelbase remains.
- [ARO 244 historic vehicle photographs](https://aro4x4.ro/aro-244-istoric/): upright utility body, separate low engine bay, round lamp clusters and steel fittings.
- [ARO 24 photo gallery](https://auto.vercity.ru/gallery/automobiles/aro/model_24/): cargo glazing, tall sidewalls and spare-wheel mounting. ARO grille/lamp arrangements varied by year; the game uses the four-round-lamp 244 interpretation.

## Changes

- Removed duplicate sRGB conversion from vehicle paint, wheel and damage colours. Three r185 already converts hexadecimal colours to its linear working space; the previous second conversion reduced middle grey from 0.21586 to 0.03826.
- Vehicle paint and glazing now reflect the live scene environment. Removed the extra emissive painted-sky layer, which made unlit metal glow independently of time of day.
- Curved front/rear screens, readable green-grey glazing, thinner roof edges and correctly parked two-part wipers improve the cabin silhouette. Four working door contracts remain.
- Retained the hero Dacia's yellow/purple repair history with aged ochre and subdued donor purple. Headlamps and their effect anchors sit higher in the fascia; corrected production dimensions.
- Rebuilt the ARO from the car body kit. Its old full-height van loft ran through the entire engine bay; the replacement has a low bonnet, four passenger doors, fixed cargo panes, quad lamps, exposed hinges, ribbed steps, gutters, bonnet catches and an upright rear spare.
- Tires use 32 circumference segments with molded sidewall rings, valves and stamped steel-wheel ventilation details. Geometry remains cached and shares the existing material buckets.
- Corrosion concentrates along underside seams. Modern clean-paint atlas cells no longer receive automatic rust blooms, and hero rust decals sit on metal beside the arches instead of covering rotating tires.

## Verification boundary

CPU tests cover the paint colour-space regression, ARO bonnet/roof separation and four doors, finite geometry for every model, a 30,000-triangle body ceiling, existing Dacia silhouette contracts, damage and vehicle placement/lifecycle. Lighting, transparency sorting and perceived realism require the main task's browser review. Alpha-blended glazing is an efficient approximation; this pass does not add ray-traced transmission or photogrammetry.

## Editable Blender workshop

Run from the repository root:

```sh
bun tools/blender/export-vehicles.ts
/opt/homebrew/bin/blender -b -t 2 --python tools/blender/build-vehicles.py
```

This creates `assets/blender/vehicles.blend`: all 18 fleet models plus the hero Dacia, with separate shells, glazing, wheels and door hinge controls. Vehicles are arranged in a metre-scale workshop. Rotate each door's `.hinge` empty around local Z; its `open_angle_radians` custom property records the runtime opening limit. Wheels spin on local X and steer on local Z. Source Three coordinates `(x,y,z)` become Blender `(x,-z,y)`.

The `paint`, `chrome`, `rubber`, `glass`, `interior` and `lamp` materials retain linear vertex colour, roughness, metalness and clearcoat attributes. Atlas UVs and eight lamp-channel weights are preserved for authoring. The canvas-generated runtime atlas is not baked into this Blender file, so microtexture and decal appearance differ. Regeneration overwrites the workshop: save hand-edited variants under another filename.

To export selected models, append their IDs, for example `bun tools/blender/export-vehicles.ts dacia1300 aro24`. Add `-- --render` to the Blender command for an optional overview render. The generated `tools/blender/input/vehicles.json` is an intermediate (~80 MB for the whole fleet); the compressed Blender file is about 5 MB. `assets/blender/vehicles-manifest.json` lists part, door and triangle counts, including wheels. Blender edits are not automatically imported into the running game.
