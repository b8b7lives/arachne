# data-pipeline

Build-time extraction. Everything under `data/` and the two atlas files
under `web/public/` are generated here and committed, so **building and
running Arachne never requires this pipeline**. You only need it to
regenerate data, typically for a new game version.

## Inputs it expects

The scripts read two kinds of input that do not ship in this repo,
because they are Mojang's files or another project's checkout:

- **A Minecraft client jar** (`minecraft-<version>-client.jar`).
  Download via Mojang's version manifest
  (<https://launchermeta.mojang.com/mc/game/version_manifest_v2.json>:
  follow your version's entry to its `client` download). 26.x jars are
  unobfuscated, which is what makes direct extraction possible.
- **A map color dump** (`mapdump-<version>.tsv`): the game's map color
  table and each block state's assigned color, produced by a small
  reflection dump run against that same client jar (the game's own
  classes report their own values; the tool is a page of Java that
  walks `BuiltInRegistries` and the `MapColor` table).
- **An upstream [mapartcraft](https://github.com/rebane2001/mapartcraft)
  checkout** (only for `build-mapartcraft-presets.py` and
  `build-versions.py`'s color-set gates, both reading its
  `coloursJSON.json`).

Paths are set at the top of each script; point them at wherever you
keep these inputs.

## Scripts

| Script | Reads | Writes |
|---|---|---|
| `build-blocks.py` | jar, mapdump tsv | `data/blocks-<v>.json` |
| `build-atlas.py` | jar, blocks json | `web/public/atlas.webp` (lossless, exact), `atlas.json` |
| `build-versions.py` | Mojang version manifest (network), upstream coloursJSON | `data/versions.json` |
| `build-mapartcraft-presets.py` | upstream coloursJSON | `data/mapartcraft-presets-<v>.json` |
| `build-fonts.py` | `fonts-catalog.json`, google/fonts at its pinned commit (network) | `data/fonts/<id>/` (WOFF2 files + license), `data/fonts.json` |
| `build-hinted.py` | `data/fonts.json`, the mirrored WOFF2 files | `data/fonts/<id>/hinted.bin`, the `hinted` entries in `data/fonts.json` |

## Fonts

`fonts-catalog.json` is the curated list for the text layer
(minecraft#87): which families ship, a hand-set native pixel size for
pixel faces, and the operator's small/big review. `build-fonts.py`
downloads each family's upright font files and license file from
google/fonts at the pinned commit, compresses each font file whole into
WOFF2 (no subsetting, no instancing, so every file is the designer's
unmodified font under its own name), and writes the manifest with
Google's tags and scores verbatim. Downloads cache under
`.fonts-cache/` (gitignored). `npm run data` copies the result to
`web/public/fonts/catalog/`; `verify.sh` refuses a family without a
license file.

Run `build-hinted.py` after `build-fonts.py`: it reads the manifest and
the mirrored files and adds the `hinted` entries back into the
manifest, which `build-fonts.py` does not carry over. It renders the
one-bit glyph sheets for the hinted letter style (minecraft#87): every
picker family except the pixel faces, sizes 8 to 19 px, the real 400
and 700 weights only (variable fonts through their `wght` axis with
`opsz` set to the size where the font has it, static families through
the files they ship), Latin-1 printable plus Latin Extended-A plus a
dozen typographic marks, each face trimmed to its cmap. Rendering is
FreeType's monochrome target with its default hinter selection: the
font's own instructions where it has any, the auto-hinter where it
has none. Kerning pairs come from GPOS pair positioning (formats 1 and
2 under the `kern` feature, at the default instance) and the legacy
`kern` table; contextual kerning is not read. The sheets are pinned
to one FreeType build, the one inside the pinned Pillow wheel:
freetype-py opens the library in its own package first, so that open
is redirected and the version asserted, and any other FreeType refuses
to build. A rebuild on the pinned versions reproduces the committed
files byte for byte, so `git status` after a run is the drift check
across builds; within a run, a spaced test line assembled from each
band must equal Pillow's whole-line render of the same text or the
build fails. `verify.sh` refuses a picker family without its sheet.

`hinted.bin` is gzip; inside, little-endian: magic `AHNT`, u8 format
(1), u8 u8 u8 FreeType version, u16 unitsPerEm, u8 weight count, u8
size count, u8 flags (bit 0 set when the font's own instructions
hinted it); then u16 per weight, u8 per size; then one band per weight
and size in that order: i8 ascent, i8 descent, u16 glyph count, and
per glyph u16 code point, u8 advance, i8 bearing x, i8 bearing y (top
above the baseline), u8 width, u8 rows, then the rows packed one bit
per pixel, most significant bit first, each row padded to a byte; then
the kerning as classes, the way the font stores it: u16 left class
count, u16 right class count, u16 left entries, u16 right entries, per
left entry u16 code point and u16 class, per right entry the same,
then the matrix of i16 font units, left class major. The reader is
`web/src/hinted.ts`.

Run `build-blocks.py` before `build-atlas.py`: atlas tile indices
follow the block list, so regenerating one without the other desyncs
them.

`build-versions.py` fetches one lang file per release by HTTP range
request (about 1.5 MB per version rather than a whole jar). The
per-release map color counts it encodes are verified against three
independent sources in
[`research/map-color-versions.md`](research/map-color-versions.md).

## Tints

`build-atlas.py` tints grayscale textures the way the client does with
no world loaded. The table is `TINTS`, verified against the 26.2
client's `BlockColors.createDefault` on 2026-09-03 by reading the
unobfuscated jar's class files (constant pools and bytecode; `javap -c
-p` from a JDK is the tool for repeating it):

- Grass color: grass block, short and tall grass, ferns, potted fern,
  bush, pink petals, wildflowers, sugar cane. Default is
  `GrassColor.getDefaultColor()`, which samples `colormap/grass.png` at
  `get(0.5, 1.0)`, pixel (127, 127): `#7cbd6b`.
- Biome foliage: oak, jungle, acacia, dark oak and mangrove leaves,
  vine. Default is what the foliage tint source returns with no world
  (`BlockTintSources$6.color`), the literal `#48b518`, the same value
  as `FoliageColor.FOLIAGE_DEFAULT`. It is not a colormap sample;
  `colormap/foliage.png` at the grass default's pixel is `#5bab46` and
  nothing reads it without a world.
- Fixed colors from the same class: spruce leaves `#619961`, birch
  leaves `#80a755`, lily pad `#208030` (in-world value), attached melon
  and pumpkin stems `#e0c71c`.
- Untinted, so absent from the table on purpose: cherry, pale oak,
  azalea and flowering azalea leaves ship pre-colored textures.
- Omitted because the tint depends on state and the block never
  reaches the pool: melon and pumpkin stems (age), redstone wire
  (power), water cauldron (level), leaf litter (dry foliage).

Any block that ends in `_leaves` used to be tinted by suffix; that
painted cherry and pale oak leaves green (fixed 2026-09-03).

## Dependencies

Run the two image scripts with [uv](https://docs.astral.sh/uv/), the
estate's standard Python runner; their inline script metadata pins
Pillow so no environment setup or system package is needed:

    uv run build-blocks.py
    uv run build-atlas.py

The other scripts are stdlib only and run under either `uv run` or
plain `python3`.
