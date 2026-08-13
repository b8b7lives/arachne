#!/usr/bin/env python3
"""Emit data/mapartcraft-presets-26.2.json, the table the mapartcraft import
reads.

This is the only part of the pipeline that reads rebane2001/mapartcraft, and
it exists to understand their file format, not to describe Minecraft. Nothing
Arachne does on its own depends on it: build-blocks.py builds the candidate
pool from the 26.2 jar alone.

Entries map upstream's (colourSetId, presetIndex) to a block by identity, so a
regenerated pool that reorders blocks[] cannot invalidate them.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
COLOURSJSON = (
    ROOT.parent / "analysis/mapartcraft/upstream/src/components/mapart/json/coloursJSON.json"
)
OUT = ROOT / "data/mapartcraft-presets-26.2.json"
PIN = "1.20"


def main():
    colours = json.load(open(COLOURSJSON))
    blocks = {}
    for set_id, cset in colours.items():
        for blk in cset["blocks"].values():
            if blk.get("presetIndex") is None:
                continue
            valid = blk["validVersions"]
            if PIN not in valid:
                continue
            entry = valid[PIN]
            if isinstance(entry, str):
                entry = valid[entry[1:]]
            props = ",".join(f"{k}={v}" for k, v in sorted(entry["NBTArgs"].items()))
            name = entry["NBTName"]
            blocks[f"{set_id}:{blk['presetIndex']}"] = f"{name}[{props}]" if props else name

    meta = json.load(open(ROOT / "data/blocks-26.2.json"))["meta"]
    doc = {
        "meta": {
            "mc_version": meta["mc_version"],
            "data_version": meta["data_version"],
            "generator": "arachne data-pipeline/build-mapartcraft-presets.py",
            "sources": f"rebane2001/mapartcraft coloursJSON (GPL-3.0), {PIN} entries",
        },
        "sets": {k: v["mapdatId"] for k, v in colours.items()},
        "blocks": blocks,
    }
    OUT.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    print(f"wrote {OUT.name}: {len(blocks)} preset entries")


if __name__ == "__main__":
    main()
