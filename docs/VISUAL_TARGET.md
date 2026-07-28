# Visual target

The single reference is `docs/reference/house-under-siege-duo.png`. The whole
playable game must feel like stepping inside that frame. Read the image before
touching any rendering code.

## What is actually in the frame

**Light.** A sun just below/at the horizon, low and to the left, behind the
tower. The sky is a violent magenta-orange rip: hot orange at the horizon,
salmon-pink above it, magenta bands, then deep violet-indigo at the zenith.
Clouds are backlit — warm amber rims, dusty rose middles, violet cores — and
they converge toward the horizon in long streaks. Nothing in the frame is lit
by a neutral white key light.

**Shadow.** There is no black. Every shadow is deep violet-blue, filled by the
enormous magenta sky dome acting as the real key light. Contrast is high but
the toe of the curve is lifted and tinted.

**Ground.** The street is wet, not raining. Asphalt reads near-black violet but
mirrors the sky in long vertical smears — orange and magenta streaks running
toward the camera. Kerbs, paving joints and puddle edges catch specular
highlights. Wet cobbles/pavers in the foreground have visible individual
reflections. Wet leaves and scattered papers lie on the ground.

**Architecture.** A dark glass tower dominates: mullioned curtain walls whose
panels each reflect a slightly different slice of sky, so the facade reads as a
mosaic of violet, steel-blue and warm sunset. Beside it, warm travertine/stone
cladding — the only genuinely warm surface — catching the low sun. Interiors
glow purple and magenta from within; you can see through the glass into lit
floors with people and desks. Facade-mounted screens show enormous political
portraits. Far down the boulevard, the Palace of Parliament sits pale and
monumental against the orange horizon.

**Street furniture.** Trolleybus/tram catenary wires cut across the sky. Tall
street lamps with warm sodium heads. Metal crowd-control barriers, red-and-white
hazard tape, wooden pallets, bollards, a Romanian tricolour flag, an acid-green
e-scooter, autumn trees with thinning amber foliage.

**The Dacia.** A battered yellow Dacia 1300 with mismatched purple panels,
sticker decals, dents, dirt and rust. Chrome bumper, round headlights, boxy
1970s silhouette. It is parked, not pristine.

**Camera.** Low — roughly chest height — with a slight upward tilt that makes
the tower loom. Long lens feel (~40–50mm equivalent), shallow-ish depth with
the far boulevard softening. Strong perspective convergence down the wet
street.

## Non-negotiable rules

1. **Never neutral.** No grey shadows, no white lights, no untinted ambient.
   Shadows go violet, highlights go orange. `src/artDirection.ts` holds the
   values; pull from it rather than hardcoding.
2. **Wet by default.** `clearSunset` is a *post-rain* state. Roads keep high
   specular response and screen-space reflection of the sky.
3. **Windows are light sources.** Every occupied building interior emits warm
   or purple light. A dark window at dusk is a bug.
4. **The sky is the key light.** Ambient/IBL must carry the magenta sky, not a
   flat hemisphere colour.
5. **No empty frame.** Any screenshot from a street should contain vehicles,
   pedestrians, street furniture, foliage, signage and litter. A clean street
   is a failed street.
6. **Silhouette variety.** Buildings must differ in height, footprint, setback,
   roof furniture and material. Repeating boxes are a failure.

## How visual work is judged

A critic receives the reference and a fresh capture from
`node tools/shot.mjs`, **without being told which is which**, and answers:

- Which frame is the reference?
- Where does the capture betray itself as real-time-generated?
- Score 0–10 on: sky, light direction, shadow colour, wet-surface response,
  material believability, architectural detail, world density, composition.

Anything below 7 on any axis is a fail and goes back into the loop.
