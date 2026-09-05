# Visible realism overhaul — 5 September 2026

This pass replaces the main characters' segmented bodies, rebuilds the vehicle
surfaces, and adds real architectural depth and scanned street materials. The
matched comparison uses the previous release, `e52d055`, and the current built
preview at the same camera positions, quality and afternoon lighting. Pedestrians
and traffic move independently between captures.

[Open the interactive before-and-after comparison](realism-comparison.html).

## What changed in the running game

- **Main cast:** continuous anatomical shoulders, hips, limbs and hands replace
  disconnected primitives. Authored skin weights transfer to the existing rig.
  Jacket, suit and tee silhouettes, garment layers, collars, lapels, seams and
  shoes distinguish the three characters. The photo-fitted heads from the earlier
  release remain attached to these new bodies.
- **Cars:** Dacia 1300/1310 and ARO bodies have crowned panels, curved roofs,
  inset glazing, wheel arches, model-specific lamps, grilles, bumpers, mirrors
  and padded seats. Full driveable models remain below 30,000 triangles including
  their wheels and driver. Parked cars across the city are now detailed Dacias
  with round tyres and period colours, replacing the box placeholders.
- **World:** windows and shopfronts are cut into the walls with actual jambs and
  reveals. Deep balconies have rails, side walls and varied enclosures. Sills,
  downpipes and entrance details cast shadows. Original CC0 Poly Haven asphalt,
  concrete and paving maps provide colour, normal and roughness detail, with
  bundled provenance and a procedural fallback.
- **Presentation:** trees and shrubs use thin leaves instead of solid polygon
  crowns. Compact ground rings and overhead indicators replace tall marker
  beams. Reduced film grain and a higher night fill keep dark streets readable.
  Reduced ambient occlusion avoids heavy dirty outlines. Dry streets no
  longer run the wet reflection raymarch that produced floating black marks.
- **Stability:** quality changes preserve live shadow uniforms for cached shaders.
  Left-side drivers and right-hand traffic remain the driving convention.
- **Blender:** regenerated vehicles and buildings match runtime geometry. A new
  full-body workshop contains all three complete rigs, Blink and walk actions;
  see [BLENDER.md](BLENDER.md) for reproducible commands and editing limits.

## Verification

The complete suite passes: **721 tests, zero failures**. Typecheck and production
build pass. The test run uses a 30-second timeout for the full-city setup hook;
its assertions are unchanged. An earlier run timed out while browser rendering
was competing for resources. The final run was isolated from browser rendering.
The JavaScript bundle remains large: approximately 13.47 MB, 4.45 MB gzipped.

Vehicle and building Blender workshops were regenerated and reopened. The body
workshop compares 432 skinned pose samples against the runtime with a maximum
position error of 2.23 micrometres.

The built preview completed a high → medium → low → high → ultra → high cycle
without fatal errors or newly captured page/console errors. Short RAF samples
were 59.3–60.6 fps on the test machine; these are not a broad hardware benchmark.
The Dacia moved 17.2 m during the throttle interval, and sprint moved 13.9 m.
Left-side exit offsets were 1.75 m and 1.80 m at two vehicle headings, followed
by successful re-entry. Six moving traffic samples were on the right of their
road centreline. These are control checks, not a campaign playthrough.
The final grain/night-fill tuning passed another 18 rendering tests and build.

Visual review remains necessary: numeric
geometry checks alone did not catch the garment overlap defects found during
this pass's browser captures.

## Limits

This is still a browser game with authored, relatively low-detail assets. It is
not a GTA VI-quality photorealistic world or a set of scanned digital doubles.
Close-up hair, facial acting, crowd anatomy, interiors and repeated architecture
remain visible limits. Skin detail is generic CC0 material, not the photographed
person's skin. Native Blender materials approximate the runtime shaders, and
manual workshop edits do not automatically cook back into the game.

The secondary [gameplay and story review](gameplay-story-review.md) identifies
cargo handling, speaker-aware performances, mission vehicle matching and dialogue
timing as remaining immersion work. This pass does not rewrite the campaign.
