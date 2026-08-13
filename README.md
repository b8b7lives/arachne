# Arachne

Minecraft map art generator: image in, palette-optimized schematic out.
It runs entirely in your browser, and it is live at
**<https://b8b7.live/arachne/>**.

Arachne is in **beta**. The math is tested and the output is verified
in game. The remaining rough edges are mostly cosmetic; phone layouts
are a known one.

## What it does

- Turns a picture into a map art schematic for survival or creative
  building, staircased or flat, from a single map up to a 16x16 grid.
- Prices every block choice by what it costs to build and tear down
  with the tools you actually carry: tier, Efficiency, Silk Touch,
  haste, flying, and whether the block drops itself when broken. The
  cost formulas are checked against the game's own code.
- Dithers with error diffusion (Floyd-Steinberg, Jarvis, Burkes,
  Stucki, Atkinson, Sierra Lite), ordered patterns, and color mixing
  based on [Joel Yliluoma's arbitrary-palette positional
  dithering](https://bisqwit.iki.fi/story/howto/dither/jy/). An
  optional refinement pass optimizes for viewing distance using the
  S-CIELAB perceptual metric of Zhang and Wandell.
- Handles transparency the way the game does: holes place no blocks,
  and pixels along a transparency edge are quantized against the
  shades the game can actually render there.
- Targets any release from 1.13 to the current one. The palette, the
  blocks on offer, and the DataVersion your files carry all follow the
  release you pick.
- Exports vanilla structure files that litematica reads, split per map
  panel with correct reference rows, plus optional map data files and
  a plain-text build sheet.
- Keeps your data yours. The image never leaves your browser, the site
  has no backend and collects nothing, and presets save inside your
  own browser.

## Layout

    web/            the app: TypeScript shell, canvas preview, worker
    core/           Rust compute core: quantize, dither, solver, export
    wasm/           the thin wasm-bindgen boundary between the two
    data/           generated block and color data, committed
    data-pipeline/  build-time extraction from the game's own files
    golden/         pinned fixtures the test suites verify against

## Building it

You need Node 20 or newer, a Rust toolchain, and wasm-pack.

    cd web
    npm ci
    npm run build        # builds the wasm, copies data, bundles

For development, `npm run dev` starts a dev server. Rust changes need
`npm run wasm` to regenerate the pkg.

## Testing

    ./verify.sh          # the whole gate: cargo, tsc, e2e

The Rust suites (`cargo test --workspace`) carry the logic tests and
golden fixtures. The e2e run drives a real browser against the dev
server and needs system chromium.

## Where this source lives

This source ships two ways. The running site's footer offers an
archive of the exact build you are using, and the GitHub mirror
carries one commit per published build, tagged with the build id the
footer shows. Either one is the corresponding source for the build,
offered under the license below.

## License and lineage

GPL-3.0. Arachne began as a study of
[rebane2001/mapartcraft](https://github.com/rebane2001/mapartcraft)
(GPL-3.0) and inherits its license with gratitude; the two tools have
since diverged in most of what they do. Block textures and game data
are extracted at build time from Minecraft's own files and remain the
property of Mojang.
