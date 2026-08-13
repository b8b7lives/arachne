#!/usr/bin/env python3
"""Emit data/versions.json: when each block id first appeared, and which map
color sets each release can make.

Block ids come from assets/minecraft/lang/en_us.json inside each client jar.
That file is a resource, not code, so it reads the same in every release and
needs no remapper. Only the one entry is fetched, by HTTP range request, so a
full sweep costs ~1.5 MB per version instead of a whole jar.

Color set availability comes from upstream's coloursJSON validVersions, which
gates per (block, color set) rather than per block, and carries the per-version
block name alongside.
"""

import json
import struct
import sys
import urllib.request
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ANALYSIS = ROOT.parent / "analysis/mapartcraft"
COLOURSJSON = ANALYSIS / "upstream/src/components/mapart/json/coloursJSON.json"
OUT = ROOT / "data/versions.json"
CACHE = HERE / ".version-cache.json"
DV_CACHE = HERE / ".dataversion-cache.json"
MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
LANG = "assets/minecraft/lang/en_us.json"
FLOOR = "1.13"
LANG_PREFIX = "block.minecraft."


def fetch(url, start=None, end=None):
    req = urllib.request.Request(url)
    if start is not None:
        req.add_header("Range", f"bytes={start}-{end}")
    return urllib.request.urlopen(req)


def jar_entry(url, entry):
    size = int(fetch(url).headers["Content-Length"])
    tail_len = min(size, 65536)
    tail = fetch(url, size - tail_len, size - 1).read()
    i = tail.rfind(b"PK\x05\x06")
    if i < 0:
        raise RuntimeError("no end-of-central-directory in the last 64 KiB")
    cd_size, cd_off = struct.unpack("<II", tail[i + 12 : i + 20])
    cd = fetch(url, cd_off, cd_off + cd_size - 1).read()
    p = 0
    while p < len(cd) and cd[p : p + 4] == b"PK\x01\x02":
        nlen, elen, clen = struct.unpack("<HHH", cd[p + 28 : p + 34])
        name = cd[p + 46 : p + 46 + nlen].decode("utf-8", "replace")
        if name == entry:
            comp, = struct.unpack("<I", cd[p + 20 : p + 24])
            method, = struct.unpack("<H", cd[p + 10 : p + 12])
            lho, = struct.unpack("<I", cd[p + 42 : p + 46])
            hdr = fetch(url, lho, lho + 29).read()
            n2, e2 = struct.unpack("<HH", hdr[26:30])
            body = fetch(url, lho + 30 + n2 + e2, lho + 30 + n2 + e2 + comp - 1).read()
            return json.loads(zlib.decompress(body, -15) if method == 8 else body)
        p += 46 + nlen + elen + clen
    return None


def lang_entry(url):
    doc = jar_entry(url, LANG)
    if doc is None:
        raise RuntimeError(f"{LANG} not found in the jar")
    return doc


def block_ids(url):
    return sorted(
        k[len(LANG_PREFIX) :] for k in lang_entry(url) if k.startswith(LANG_PREFIX)
    )


# version.json first shipped in the 1.14 snapshots; the three older releases we
# support have fixed, well-published DataVersions. minecraft#17.
DATA_VERSION_FALLBACK = {"1.13": 1519, "1.13.1": 1628, "1.13.2": 1631}


def data_version(url, version_id):
    doc = jar_entry(url, "version.json")
    if doc is not None and "world_version" in doc:
        return int(doc["world_version"])
    if version_id in DATA_VERSION_FALLBACK:
        return DATA_VERSION_FALLBACK[version_id]
    raise RuntimeError(f"{version_id}: no version.json and no fallback")


def key(version):
    out = []
    for part in version.split("."):
        out.append(int(part) if part.isdigit() else 0)
    return out + [0] * (3 - len(out))


def releases():
    manifest = json.load(urllib.request.urlopen(MANIFEST))
    rel = [v for v in manifest["versions"] if v["type"] == "release"]
    rel.sort(key=lambda v: v["releaseTime"])
    floor = key(FLOOR)
    return [v for v in rel if key(v["id"]) >= floor]


def color_sets_by_version(order):
    """Map colors each release can make, for every release we support.

    Upstream only gates nine point releases, so its table is read for set
    membership and then applied across the three tiers the map palette has
    actually had. Boundaries are verified in research/map-color-versions.md.
    """
    colours = json.load(open(COLOURSJSON))
    per = {}
    for cset in colours.values():
        for block in cset.get("blocks", {}).values():
            for version in block.get("validVersions", {}):
                per.setdefault(version, set()).add(cset["mapdatId"])
    tiers = [(FLOOR, per["1.15.2"]), ("1.16", per["1.16.5"]), ("1.17", per["1.17.1"])]
    out = {}
    for version in order:
        chosen = None
        for start, ids in tiers:
            if key(version) >= key(start):
                chosen = ids
        out[version] = sorted(chosen)
    return out


def main():
    cache = json.load(open(CACHE)) if CACHE.exists() else {}
    rel = releases()
    only = sys.argv[1:]
    if only:
        rel = [v for v in rel if v["id"] in only]
    print(f"{len(rel)} releases from {FLOOR}", file=sys.stderr)

    dv_cache = json.load(open(DV_CACHE)) if DV_CACHE.exists() else {}
    for i, v in enumerate(rel, 1):
        if v["id"] in cache and v["id"] in dv_cache:
            continue
        meta = json.load(urllib.request.urlopen(v["url"]))
        url = meta["downloads"]["client"]["url"]
        if v["id"] not in cache:
            cache[v["id"]] = block_ids(url)
            json.dump(cache, open(CACHE, "w"))
        if v["id"] not in dv_cache:
            dv_cache[v["id"]] = data_version(url, v["id"])
            json.dump(dv_cache, open(DV_CACHE, "w"))
        print(
            f"  [{i}/{len(rel)}] {v['id']}: {len(cache[v['id']])} blocks, "
            f"DataVersion {dv_cache[v['id']]}",
            file=sys.stderr,
        )

    order = [v["id"] for v in releases() if v["id"] in cache]
    since = {}
    for version in order:
        for bid in cache[version]:
            since.setdefault(bid, version)

    doc = {
        "meta": {
            "generator": "arachne data-pipeline/build-versions.py",
            "floor": FLOOR,
            "sources": "Mojang version manifest (client jar lang entries) "
            "+ rebane2001/mapartcraft coloursJSON (GPL-3.0)",
        },
        "versions": order,
        "data_versions": {v: dv_cache[v] for v in order},
        "color_sets": color_sets_by_version(order),
        "since": dict(sorted(since.items())),
    }
    OUT.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    print(
        f"wrote {OUT.relative_to(ROOT)}: {len(order)} versions, {len(since)} block ids",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
