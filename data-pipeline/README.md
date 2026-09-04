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
- Water and bubble column: the plains biome `water_color`, `#3f76e4`
  (`data/minecraft/worldgen/biome/plains.json`).
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
