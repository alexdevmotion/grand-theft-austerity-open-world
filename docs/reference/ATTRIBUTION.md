# Reference image attribution

The photographs and concept images below are **studio reference only**, held
for modelling and offline landmark fitting. They are not shipped as game
textures. The separate CC0 runtime mesh and skin assets are identified in the
MakeHuman section below.

## Wikimedia Commons

The licence and attribution for each studio-reference file were rechecked on
1 August 2026. The photographs are not shipped in the game build and have not
been edited except where the table says a local reference copy was resized.

| Local file | Creator / source | Licence |
| --- | --- | --- |
| `likeness/bolojan.jpg` | [gov.ro / Romanian Government](https://commons.wikimedia.org/wiki/File:Ilie_Bolojan_(16_April_2026)_(cropped).jpg) | Attribution required by gov.ro |
| `likeness/nicusor-dan.jpg` | [U.S. Embassy Romania](https://commons.wikimedia.org/wiki/File:Nicusor_Dan_in_2026.jpg) | Public Domain Mark |
| `world/calea-victoriei.jpg` | [Mihai Petre / Stratoreaper](https://commons.wikimedia.org/wiki/File:Hotel_Continental_-_Calea_Victoriei.jpg) | [CC BY-SA 3.0 RO](https://creativecommons.org/licenses/by-sa/3.0/ro/deed.en) |
| `world/dacia-1300.jpg` | [dacia24.de](https://commons.wikimedia.org/wiki/File:Dacia_1300_(cropped).JPG) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| `world/lipscani-oldtown.jpg` | [Chainwit.](https://commons.wikimedia.org/wiki/File:Strada_Lipscani_18-20_Bucure%C8%99ti_(2023)_-_img_04.jpg) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `world/magheru-boulevard.jpg` | [Mihai Petre / Stratoreaper](https://commons.wikimedia.org/wiki/File:Bd._Magheru_1.jpg) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `world/parliament.jpg` | [Jorge Franganillo](https://en.wikivoyage.org/wiki/File:Bucharest_-_Palace_of_the_Parliament_(2024)_(2).jpg), resized reference copy | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| `world/piata-unirii.jpg` | [bogdan / psiho.child](https://commons.wikimedia.org/wiki/File:Piata_Unirii_-_Bucuresti.jpg) | [CC BY 2.0](https://creativecommons.org/licenses/by/2.0/) |
| `world/unirii-boulevard.jpg` | [Crislia](https://commons.wikimedia.org/wiki/File:Bucharest_Bucuresti_Romania.JPG) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| `world/university-square.jpg` | [Madalin Pentelie](https://commons.wikimedia.org/wiki/File:Bucharest_University_Square_(cropped).jpg) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

The Palace of Parliament image is retained only as a non-commercial studio
reference. Its former Commons page was removed because Romania does not provide
the same freedom-of-panorama treatment as many other countries; the linked
Wikivoyage file page preserves the photographer and CC BY 2.0 attribution.

## Concept owner's own material

| File | Origin |
| --- | --- |
| `house-under-siege-duo.png` | The project's target frame, supplied by the concept owner |
| `likeness/ref-lead-head.png` | Crop of the above |
| `likeness/ref-ally-head.png` | Crop of the above |

## Note on depicting real people

The cast are fictional composites drawn from public figures, in the tradition
of political satire. They carry altered names (Bolojan-Agatinei, Nicușor LAN,
Alex Need-Aid, George Georgescu). The three main heads use photo-fitted
anatomical geometry and generic skin maps. They are not validated digital
doubles, and no subject photograph is projected onto face geometry.

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
Universității. City building meshes are generated procedurally from those
footprints. The separately sourced CC0 character geometry and textures are
documented below.

ODbL requires attribution wherever the derived work is shown — the credits
screen must carry "© OpenStreetMap contributors".

Regenerate with `node tools/fetch-osm.mjs` then `node tools/curate-osm.mjs`.

### Deliberately NOT used

Scraped 3D building models (Sketchfab and similar) and Google's photogrammetric
3D tiles. The former are a mix of CC-BY, non-commercial and all-rights-reserved
and would need clearing model by model; the latter are forbidden by Google's
terms. Both would also import baked lighting and arbitrary topology, which would
read as imported furniture against a procedurally generated, stylised city.

## Real portrait refresh — 4 September 2026

The following publicly displayed photographs replace concept-art crops as
inputs to the offline landmark fitter. They are studio reference only, retain
their owners' copyright, and are not licensed here for redistribution as game
textures. Their pixels are not included in the runtime assets.

| Local file | Identity and source | Use |
| --- | --- | --- |
| `likeness/alex-nedea.jpg` | [Recorder team page](https://recorder.ro/cine-suntem/), [portrait](https://recorder.ro/wp-content/uploads/2023/05/DSC03352-RESIZE-1024x1024.jpg); photographer not identified on team listing | Proportions, blue-grey eyes, swept short hair for fictional Alex Need-Aid |
| `likeness/alexandru-agatinei.jpg` | [TechConnect speaker listing](https://techconnectfestival.eu/speakeri/), [portrait](https://techconnectfestival.eu/wp-content/uploads/2025/09/Alexandru-Agatinei-1.jpg); photographer not identified on listing | Player silhouette and face landmarks, blended with the existing Bolojan reference |

The existing Bolojan and Nicușor photographs above were inspected and refitted
in the same run. The old concept crops remain available for costume/fictional
character design history. George Georgescu remains the story's invented
composite broadcast antagonist; no single real-person identity was assigned.

## MakeHuman anatomical mesh and skin — 5 September 2026

The three main character heads derive from MakeHuman Community's CC0 HM08
`base.obj`, retained unmodified at `assets/source/hm08/base.obj`. The pinned
upstream source is [MPFB2 commit 437dd513888a92399d1d3200d2e80859fae55abc](https://github.com/makehumancommunity/mpfb2/blob/437dd513888a92399d1d3200d2e80859fae55abc/src/mpfb/data/3dobjs/base.obj).
The [local mesh provenance](../../assets/source/hm08/README.md) and
[CC0 license](../../assets/source/hm08/LICENSE.CC0.md) record the source and
separate the CC0 asset from GPL addon code; no addon program code is copied into
the runtime.

The generic male skin textures come from the [official MakeHuman system asset
pack](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html),
which lists both assets as CC0. The retained original materials explicitly
record the September 2020 CC0 release, naming Data Collection AB, Joel Palmius
and Jonas Hauquier as copyright holders at release.

| Material asset | Runtime texture |
| --- | --- |
| `middleage_caucasian_male` | `public/textures/characters/middleage_lightskinned_male_diffuse.png` |
| `young_caucasian_male` | `public/textures/characters/young_lightskinned_male_diffuse.png` |

Both 2048 × 2048 PNGs are unmodified. Original PNGs and `.mhmat` references,
license and [source notes](../../assets/source/hm08/skin/README.md) are retained
under `assets/source/hm08/skin/`; the [provenance manifest](../../assets/source/hm08/skin/provenance.json)
records exact archive members, CRCs and SHA-256 hashes. Runtime copies are
byte-identical. These maps supply generic skin colour and detail on preserved
HM08 UVs, not the photographed subject's albedo or a claim of scanned likeness.
