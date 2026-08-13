# Map colors per release: verification

How many map colors each supported release can make, and how we know.
Consumed by `build-versions.py` when it writes `data/versions.json`.

## The answer

| releases | base colors |
|---|---|
| 1.13 to 1.15.2 | 51 |
| 1.16 to 1.16.5 | 58 |
| 1.17 to 26.2 | 61 |

No map color has ever been removed, and none has been added since 1.17.

## Why this needed checking

Everything else in the version picker rests on block availability, which
the language-file sweep answers directly. Map colors are different: the
table lives in code, so it is obfuscated before 26.1 and cannot be dumped
the way a modern jar can. The count was the one claim resting on
inference: 1.20 is 61 (upstream mapartcraft) and 26.2 is 61 (our dump),
so the assumption was that nothing moved in between.

That is the kind of gap where a wrong assumption is invisible, so it was
checked against sources that share none of our machinery.

## Three sources, independently

1. **Our own 26.2 jar dump** (`mapdump-26.2.tsv`, see the pipeline
   README): 61 colors.
2. **Upstream [mapartcraft](https://github.com/rebane2001/mapartcraft)**:
   its `coloursJSON` gates nine point releases and shows 51 at
   1.12.2 to 1.15.2, 58 at 1.16.5, 61 at 1.17.1 to 1.20.
3. **[cerus/minecraft-map-colors](https://github.com/cerus/minecraft-map-colors)**:
   per-version colors scraped from Spigot's `MaterialMapColor.java`,
   covering 1.8.3 to 1.21.9. Independent of both the client jar and
   upstream.

Source 3 records map color changes in exactly three releases ever (1.12,
1.16.1 and 1.17), with no removals. Its add counts are per shade, four
per base color: 64, 28 and 12, so 16, 7 and 3 base colors. Those
reconcile with source 2 exactly: 35 + 16 = 51, 51 + 7 = 58, 58 + 3 = 61.

Nothing changed after 1.17, which closes the 1.20 to 26.2 gap, and our
own dump confirms 61 at the far end.

## Where the sources disagreed

Source 3 attributes the Nether Update colors to 1.16.1. It has no 1.16
build at all (Spigot skips some `.0` releases), so that is an artifact of
a missing file, not a finding.

Settled from our own sweep instead: `crimson_planks`, `warped_planks`,
`crimson_nylium` and `warped_nylium` are all present in 1.16 and absent
in 1.15.2. The seven colors arrive at 1.16, so that is the boundary in
`versions.json`.

Source 3's other gaps (1.16, 1.20.3, and some `.0` releases) cannot hide
a change elsewhere: a color added in a missing release would still show
up as a difference at the next release the dataset does have, and none
does after 1.17.

## A claim that did not survive

A search summary suggested cherry wood and bamboo "would push the total
above 61" in 1.20. Source 3 records no 1.20 change, upstream shows 61 at
1.20, and our dump shows 61 at 26.2. Cherry and bamboo were assigned to
existing colors. Recorded because it is a plausible-sounding claim that
all three sources refute.

## What is still assumed

Nothing about the counts. The remaining assumption is that a color's RGB
values never changed within a tier. That was checked only at the
endpoints, where upstream's 1.20 `tonesRGB` matches our computed 26.2
tones across all 61 sets and 4 shades, 244 values, exactly. A mid-range
recolour that was later reverted would be invisible to that check, which
is not a realistic failure mode but is not proven either.
