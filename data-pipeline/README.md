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
| `build-atlas.py` | jar, blocks json | `web/public/atlas.png`, `atlas.json` |
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

## Dependencies

Run the two image scripts with [uv](https://docs.astral.sh/uv/), the
estate's standard Python runner; their inline script metadata pins
Pillow so no environment setup or system package is needed:

    uv run build-blocks.py
    uv run build-atlas.py

The other scripts are stdlib only and run under either `uv run` or
plain `python3`.
