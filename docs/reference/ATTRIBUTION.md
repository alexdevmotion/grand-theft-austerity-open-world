# Reference image attribution

These files are **studio reference only** — held so that modellers (human or
agent) can look at them while authoring procedural geometry. They are **not**
shipped as game textures and are not redistributed as part of any build.

## Wikimedia Commons

Each file below was retrieved from Wikimedia Commons and remains under its
original licence and attribution. Before any public release of this project,
re-check each file's current licence page and either remove the file or comply
with its terms.

| File | Commons source page |
| --- | --- |
| `likeness/bolojan.jpg` | `File:Ilie Bolojan (16 April 2026) (cropped).jpg` |
| `likeness/nicusor-dan.jpg` | `File:Nicusor Dan in 2026.jpg` |
| `world/dacia-1300.jpg` | `File:Dacia 1300 (cropped).JPG` |
| `world/parliament.jpg` | `File:Bucharest - Palace of the Parliament (2024) (2).jpg` |
| `world/unirii-boulevard.jpg` | `File:Bucharest Bucuresti Romania.JPG` |
| `world/lipscani-oldtown.jpg` | `File:Strada Lipscani 18-20 București (2023) - img 04.jpg` |
| `world/university-square.jpg` | `File:Bucharest University Square (cropped).jpg` |

Resolve any of these at `https://commons.wikimedia.org/wiki/<page>`.

## Concept owner's own material

| File | Origin |
| --- | --- |
| `house-under-siege-duo.png` | The project's target frame, supplied by the concept owner |
| `likeness/ref-lead-head.png` | Crop of the above |
| `likeness/ref-ally-head.png` | Crop of the above |

## Note on depicting real people

The cast are fictional composites drawn from public figures, in the tradition
of political satire. They carry altered names (Bolojan-Agatinei, Nicușor LAN,
Alex Need-Aid, George Georgescu) and are authored as stylised caricatures
rather than photoreal digital doubles — no photograph is projected onto face
geometry.

## Audio

Copied from the concept repo's `output/reference-assets/audio/`. Like the image
references, these are **third-party recordings held as prototype material only**
— they are gitignored, exactly as the upstream repo keeps them, and are restored
with `bun run audio:sync`.

| Set | Files | Source |
| --- | --- | --- |
| `vo/ce-ne-enerveaza-55-intro-clips` | 23 | *Ce Ne Enervează*, a Romanian satirical show |
| `vo/ce-ne-enerveaza-55-matze-clips` | 20 | as above |
| `vo/ce-ne-enerveaza-61-matze-clips` | 22 | as above |
| `vo/ce-ne-enerveaza-intro-clips` | 14 | as above |
| `music/fecioreasca-de-pe-mures-dumitru-farcas.mp3` | 1 | Romanian folk recording — the Builders House afterparty in `docs/STORY.md` |

### Deliberately NOT copied

- **`gta-iv-theme.mp3`** — Rockstar's copyrighted score. This game is a
  Grand Theft Auto parody, which makes shipping the actual GTA theme the single
  most likely thing to attract a takedown. The title/menu music should be an
  original composition in that register instead.
- **`ce-ne-enerveaza-55-full.mp3` and `-61-full.mp3`** (103 MB) — the complete
  episodes the clips were cut from. The clips are what the game needs; the full
  episodes are redundant weight.

### Not present anywhere, and still required

The concept repo contains **no sound effects at all** — no engine, tyres,
collisions, sirens, horns, footsteps, rain or city ambience. Every one of those
has to be synthesised procedurally with the WebAudio API. The imported files
cover voice and the finale music only.

## Map data

`src/content/bucharest.json` is derived from **OpenStreetMap**, © OpenStreetMap
contributors, licensed **ODbL 1.0** — https://www.openstreetmap.org/copyright

It contains *data*, not art: building footprints with storey counts, street
centrelines with classification, tram routes, parks and squares for central
Bucharest, projected to metres on a local tangent plane centred on Piața
Universității. Every mesh in the game is still generated procedurally from that
data in the game's own style, so nothing third-party is shipped as geometry or
texture.

ODbL requires attribution wherever the derived work is shown — the credits
screen must carry "© OpenStreetMap contributors".

Regenerate with `node tools/fetch-osm.mjs` then `node tools/curate-osm.mjs`.

### Deliberately NOT used

Scraped 3D building models (Sketchfab and similar) and Google's photogrammetric
3D tiles. The former are a mix of CC-BY, non-commercial and all-rights-reserved
and would need clearing model by model; the latter are forbidden by Google's
terms. Both would also import baked lighting and arbitrary topology, which would
read as imported furniture against a procedurally generated, stylised city.
