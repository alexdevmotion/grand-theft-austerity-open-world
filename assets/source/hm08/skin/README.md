# MakeHuman HM08 male skin textures

Unmodified skin assets extracted on 2026-09-05 from the [official MakeHuman system
asset pack](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html).
That page lists both skin assets as CC0. Each retained `.mhmat` also records the
explicit September 2020 CC0 release, with Data Collection AB, Joel Palmius, and
Jonas Hauquier as the copyright holders at release. `LICENSE.CC0.md` is the same
upstream CC0 text retained with the HM08 mesh one directory above.

The archive was fetched through the page's HTTPS mirror2 using byte ranges; only
these four members were extracted. ZIP CRC checks verified extraction. See
`provenance.json` for the archive URL, member paths, sizes, and SHA-256 hashes.

| Source material | Referenced texture |
| --- | --- |
| `skins/middleage_caucasian_male/middleage_caucasian_male.mhmat` | `middleage_lightskinned_male_diffuse.png` |
| `skins/young_caucasian_male/young_caucasian_male.mhmat` | `young_lightskinned_male_diffuse.png` |

Both PNGs are 2048 × 2048 and use the standard MakeHuman body UV layout.
Visual inspection confirms skin colour variation, lips, and scalp stubble. Source
nose vertex 297 has UV `(0.87319, 0.483168)`, which lands on the texture nose
at image coordinates `(1788, 1058)` with the usual image-top/UV-bottom origin. The fitted anatomical
head preserves those original HM08 OBJ face-corner UVs, including after
subdivision and seam splitting; the maps require no UV rebake. Runtime PNG copies
are byte-identical at `public/textures/characters/`. Use the PNGs as sRGB colour
maps with the preserved OBJ UV orientation; do not apply another colour-space
conversion or copy the old MakeHuman litsphere shader settings wholesale.

The source material display names have upstream inconsistencies: the young
material says `name old_caucasian_male_detailed`, and the middle-age name spells
`cauasian`. File paths, texture references, and age tags identify the correct
assets; the originals are preserved verbatim. These are generic skin textures,
not photographs or likeness textures of the game's named characters. Runtime
material integration and rendered alignment are validated separately.
