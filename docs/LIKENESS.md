# Likeness and landmark brief

Reference images live in `docs/reference/`. **Look at them with the Read tool
before modelling anything.** The notes below are what the lead observed in each
image; they are a checklist, not a replacement for looking.

## Approach, and its limits

The offline fitter measures real photographs, then deforms a shared head.
Blender refines that mesh and produces runtime eyelid shape keys. This is
landmark-guided reconstruction, not scanned head data. Use natural proportions
and restrained shading; the current direction is in `VISUAL_TARGET.md` and the
reproducible workflow is in `BLENDER.md`.

Recognition at 5–20 m comes from **silhouette, hairline, brow and build** — not
from skin pores. Get those right and the character reads instantly; get them
wrong and no amount of shading rescues it.

Do **not** paste photographs onto face geometry as textures. It looks like a
mask, it breaks under any lighting that isn't the source photo's, and the
photos are third-party material. Author skin, hair and cloth procedurally, and
use the photos only as things to look at.

## Cast

### Ilie Bolojan-Agatinei — the player

A fictional fusion of two real people.
`docs/reference/likeness/alexandru-agatinei.jpg` supplies the lead anatomy;
`likeness/bolojan.jpg` supplies the broader jaw and heavier brows. The old
concept crop is a clothing reference only.

From the Agatinei photograph:
- Short dark hair, cut close at the sides, distinctly greying at the temples.
- Full but short, dark beard with discrete grey strands, heaviest on the chin.
- Permanently furrowed brow; a vertical crease between the brows.
- Deep-set dark eyes, prominent cheekbones, strong straight nose.
- Olive/tanned skin, mid-40s to 50s, lean but solid.
- Dark navy work jacket over a black t-shirt, collar up.

Pushed in from `likeness/bolojan.jpg` (the Bolojan half):
- Heavier, broader jaw and the beginnings of jowls — widen the lower face.
- The signature **heavy, dark, slightly angled eyebrows** that stay dark even
  as the hair greys. This is his single most recognisable feature.
- Deeper nasolabial folds; a tired, heavy-lidded set to the eyes.
- A higher, more receding hairline than the reference frame shows, nodding to
  Bolojan's bald crown without going fully bald — he must stay recognisable as
  the man in the target frame.
- Thicker neck, stockier torso.

Plus the story's one authored flourish: an exaggerated **purple builder
accessory** (see `docs/STORY.md`).

### Nicușor LAN — infrastructure ally

From `docs/reference/likeness/nicusor-dan.jpg`:
- The defining feature is **hair volume**: a thick, curly, slightly unruly mop,
  dark brown going grey, sitting high off the head.
- Deeply receding at the temples, so the hair mass reads as two lobes with a
  high forehead between them.
- Lean, narrow face; long straight prominent nose; thin lips; mild, almost
  apologetic half-smile.
- Slight build, narrow shoulders, ~55.
- Dark suit, no tie in-game (he is the network guy) — swap the formal shirt for
  something plainer, with a lanyard and cable coils as role props.

He must be silhouette-distinct from the player at a glance: **tall hair + lean
frame** against the player's **cropped hair + heavy build**.

### Alex Need-Aid — Recorder operative

From `docs/reference/likeness/alex-nedea.jpg`, identified by Recorder
on its team page (studio reference only):
- Short dark brown hair swept to the side, with restrained volume.
- Blue-grey eyes with dark pupils and a subtle limbal ring.
- Clean-shaven with a faint stubble shadow along the jaw.
- Lean, angular face; high cheekbones; prominent straight nose; thin lips.
- Alert, mildly sceptical expression. Early 40s, slim athletic build.
- Black **`recorder`** t-shirt with the small red circular logo at the chest —
  this is his identifier, keep it legible. Carries a laptop and a camera.

### George Georgescu — antagonist

Stays a fictional composite with no photo reference, per `docs/STORY.md`. He
appears on facade screens, posters and broadcasts rather than as a gameplay
character. Theatrical nationalist styling: heavy dark suit, tricolour sash,
over-lit studio portrait, aggressive broadcast framing.

## Vehicles

### Dacia 1300 — `docs/reference/world/dacia-1300.jpg`

**A correction to earlier work: the headlights are RECTANGULAR, not round.**
An earlier brief said round twin headlights; that is wrong and must be fixed.

- Boxy three-box saloon. Flat bonnet with a faint centre crease and vent slots
  at the base of the windscreen.
- **Rectangular headlamps** outboard, with a pair of **round auxiliary lamps**
  mounted lower in the grille aperture.
- Black grille of fine horizontal slats, Dacia badge centred.
- Slim chrome bumpers with rubber-faced overriders; amber indicators in the
  outer corners under the headlights.
- Flat, upright greenhouse; slim A/B/C pillars; chrome window surrounds; large
  glass area with excellent visibility.
- Steel wheels with **chrome hubcaps**; modest wheel arches.
- Chrome door handles and a chrome wing mirror on the driver's side.
- Subtle haunch over the rear wheel; short boot with a flat lid.

Game livery on top of that shape: yellow body, mismatched purple panels, taped
bumper, dents, rust, sticker decals, dirty glass.

## Landmarks

### Palatul Parlamentului — `docs/reference/world/parliament.jpg`

The current in-game version is a flat pale block and reads as nothing. The real
building's recognition comes from:
- **Tiered, stepped, ziggurat-like massing** — a tall central block with wings
  descending in setbacks left and right. Never a single slab.
- A pedimented central tower with tall arched windows.
- **Repeated arcades and loggias** — rows of round-arched openings with columns
  at several levels. This rhythm is the building's signature.
- Heavy cornices and entablatures banding each level.
- A grand entrance portico with double-height columns.
- Raised on a hill/plinth with a retaining wall and a balustrade of square
  pillars; landscaped hedge terraces below.
- Cream/white limestone that goes warm gold in low sun.
- Ornate multi-globe cast-iron street lamps along the approach — distinctively
  Bucharest, worth reproducing.

Scale is the whole point: it must be readable in silhouette from across the map
and feel oppressive up close.

### Bulevardul Unirii — `docs/reference/world/unirii-boulevard.jpg`

The axis that terminates at Parliament:
- Dead straight to the horizon, symmetrical about a central tree-lined median
  with fountains, multi-lane carriageways on both sides.
- Flanked by cream/beige neoclassical-socialist blocks, 8–10 storeys, with
  **arcaded ground floors**, rhythmic repeated windows, recessed loggias,
  balustrades and cornices at the roofline.
- **Curved, sweeping corner facades** where the boulevard opens onto the plaza.
- Beyond the flanking blocks, a dense low-rise city with scattered mid-rises.

This is the `bulevard` district's authority. The current generic blocks should
be replaced with this vocabulary.

### Old town — `docs/reference/world/lipscani-oldtown.jpg`
### University Square — `docs/reference/world/university-square.jpg`

Reference for the `centruVechi` district and general street vibe.

### Builders House

No public reference exists; it is fictional. Its authority is the target frame
`docs/reference/house-under-siege-duo.png`: a dark mullioned glass tower with a
warm travertine-clad podium, purple/magenta-lit interiors visible through the
glass, facade-mounted political screens, and an enterable ground-floor lobby.

## Attribution

The Agatinei and Nedea photographs come from their speaker and team pages.
Their inclusion as studio reference does not imply a redistribution licence.
Exact sources and rights boundaries are in `reference/ATTRIBUTION.md`.


`likeness/bolojan.jpg`, `likeness/nicusor-dan.jpg`, `world/dacia-1300.jpg`,
`world/parliament.jpg`, `world/unirii-boulevard.jpg`, `world/lipscani-oldtown.jpg`
and `world/university-square.jpg` come from Wikimedia Commons and remain under
their original licences — see `docs/reference/ATTRIBUTION.md`. They are held as
studio reference only and are not shipped as game textures.

`likeness/ref-lead-head.png` and `likeness/ref-ally-head.png` are crops of the
concept owner's own target frame.
