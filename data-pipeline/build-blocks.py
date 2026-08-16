# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
import collections
import csv
import io
import json
import sys
import zipfile
from pathlib import Path

import texture
from colorname import color_names

HERE = Path(__file__).resolve().parent
ANALYSIS = HERE / "../../analysis/mapartcraft"
JAR = ANALYSIS / "26x-data/minecraft-26.2-client.jar"
MAPDUMP = ANALYSIS / "26x-data/mapdump-26.2.tsv"
OUT_DIR = HERE / "../data"

TONE_NAMES = ["dark", "normal", "light", "unobtainable"]
MINEABLE = ["pickaxe", "axe", "shovel", "hoe"]
SHEARS_RULES = [("shears_extreme_breaking_speed", 15.0),
                ("shears_major_breaking_speed", 5.0),
                ("shears_minor_breaking_speed", 2.0)]
SHEARS_DIRECT = {"cobweb": 15.0}
TIER_TAGS = ["needs_stone_tool", "needs_iron_tool", "needs_diamond_tool"]
TIER_NAME = {"needs_stone_tool": "stone", "needs_iron_tool": "iron",
             "needs_diamond_tool": "diamond"}

NOT_MAPART_EXACT = {
    "decorated_pot", "copper_golem_statue", "turtle_egg", "lava", "heavy_core",
    "farmland", "dirt_path", "vault", "trial_spawner", "spawner", "creaking_heart",
    "pointed_dripstone", "sulfur_spike", "cactus_flower", "twisting_vines",
    "amethyst_cluster", "budding_amethyst", "leaf_litter", "brown_mushroom",
    "red_mushroom", "sniffer_egg", "dragon_egg", "bell", "campfire", "soul_campfire",
    "resin_clump", "chipped_anvil", "damaged_anvil", "anvil", "grindstone",
    "water_cauldron", "lava_cauldron", "powder_snow_cauldron",
    "dried_ghast", "conduit", "sea_pickle",
    "command_block", "chain_command_block", "repeating_command_block",
    "jigsaw", "structure_block", "test_block", "end_portal_frame",
}
NOT_MAPART_SUFFIX = (
    "_sign", "_banner", "_copper_golem_statue", "_fence", "_fence_gate", "_wall",
    "_amethyst_bud", "_lightning_rod", "_shelf",
)
NOT_MAPART_PREFIX = ("suspicious_", "infested_")
NOT_MAPART_SUBSTRING = ("chest",)

def not_mapart(bid):
    if bid in NOT_MAPART_EXACT or bid.endswith(NOT_MAPART_SUFFIX) \
            or bid.startswith(NOT_MAPART_PREFIX) \
            or any(s in bid for s in NOT_MAPART_SUBSTRING):
        return True
    if bid == "lightning_rod":
        return True
    if bid.endswith("_lantern") and bid not in ("sea_lantern", "jack_o_lantern"):
        return True
    if bid == "lantern":
        return True
    if "copper" in bid and not bid.startswith("waxed_") and "ore" not in bid:
        return True
    if bid.endswith("_coral_block") and not bid.startswith("dead_"):
        return True
    return False

def mapart_verdict(bid, row):
    if not_mapart(bid):
        return "not_mapart"
    if row.get("class") == "LiquidBlock":
        return None
    if row.get("fluid", "minecraft:empty") != "minecraft:empty":
        return "needs_fluid"
    if row.get("on_stone") == "false":
        return "needs_special_ground"
    return None

def parse_dump(path):
    headers = collections.defaultdict(list)
    table = []
    for ln in open(path).read().splitlines():
        if ln.startswith("#"):
            kind, *rest = ln[1:].split("\t")
            headers[kind].append(rest)
        else:
            table.append(ln)
    reg = {}
    for row in csv.DictReader(table, delimiter="\t"):
        reg[row["id"].removeprefix("minecraft:")] = row
    return headers, reg

def tones_rgb(packed, tones):
    r, g, b = packed >> 16 & 255, packed >> 8 & 255, packed & 255
    return {k: [r * m // 255, g * m // 255, b * m // 255] for k, m in tones.items()}

def jar_json(zf, path):
    return json.load(io.TextIOWrapper(zf.open(path), encoding="utf-8"))

def tag_members(zf, tag, seen=None, kind="block"):
    seen = seen or set()
    out = set()
    for v in jar_json(zf, f"data/minecraft/tags/{kind}/{tag}.json")["values"]:
        if v.startswith("#minecraft:"):
            sub = v.removeprefix("#minecraft:")
            if sub not in seen:
                seen.add(sub)
                out |= tag_members(zf, sub, seen, kind)
        else:
            out.add(v.removeprefix("minecraft:"))
    return out

UNKNOWN_GATES = set()

# Yield-boost tool tags, reviewed: guard shard/count branches only, so the
# pessimistic silk classification for self-drop is correct. minecraft#26.
REVIEWED_TOOL_TAGS = {"#minecraft:cluster_max_harvestables"}

def gates_of(cond):
    """Which tool satisfies a match_tool condition: 'shears' or 'silk'.

    An unrecognized match_tool predicate is recorded and treated as silk —
    pessimistic on purpose (a cost model must not promise a drop it cannot
    verify); build() prints them so drift is visible.
    """
    out = set()
    if cond.get("condition") == "minecraft:any_of":
        for t in cond.get("terms", []):
            out |= gates_of(t)
        return out
    if cond.get("condition") != "minecraft:match_tool":
        return out
    pred = cond.get("predicate", {})
    items = pred.get("items")
    if items and "shears" in json.dumps(items):
        out.add("shears")
    if "silk_touch" in json.dumps(pred.get("predicates", {})):
        out.add("silk")
    if not out:
        if isinstance(items, str) and items in REVIEWED_TOOL_TAGS and not pred.get("predicates"):
            return {"silk"}
        UNKNOWN_GATES.add(json.dumps(pred, sort_keys=True)[:80])
        return {"silk"}
    return out

def inverted_gates(conds):
    """Gates that, when present, make these conditions FAIL.

    In an `alternatives` list a later branch is only reached once every
    earlier branch failed, so an earlier `inverted(match_tool silk)` means
    the later branch is itself silk-gated (vanilla snow works exactly so).
    """
    out = set()
    for c in conds or []:
        if c.get("condition") == "minecraft:inverted":
            out |= gates_of(c.get("term", {}))
    return out

def has_tool_condition(conds):
    return any(c.get("condition") in ("minecraft:match_tool", "minecraft:any_of")
               and gates_of(c) for c in conds or [])

def self_drops(node, block_item, guarded, hits, gates=frozenset()):
    if isinstance(node, dict):
        here = set()
        for c in node.get("conditions") or []:
            here |= gates_of(c)
        g = guarded or bool(here)
        gates = gates | here
        if node.get("type") == "minecraft:item" and node.get("name") == block_item:
            hits.append((g, frozenset(gates)))
        if node.get("type") == "minecraft:alternatives":
            implicit = set()
            for child in node.get("children") or []:
                self_drops(child, block_item, g or bool(implicit), hits, gates | implicit)
                implicit |= inverted_gates(child.get("conditions"))
            for k, v in node.items():
                if k not in ("conditions", "children"):
                    self_drops(v, block_item, g, hits, gates)
            return
        for k, v in node.items():
            if k != "conditions":
                self_drops(v, block_item, g, hits, gates)
    elif isinstance(node, list):
        for v in node:
            self_drops(v, block_item, guarded, hits, gates)

def recoverability(zf, block):
    """(recoverability, gate) — gate names the tool that unlocks a gated drop."""
    path = f"data/minecraft/loot_table/blocks/{block}.json"
    try:
        table = jar_json(zf, path)
    except KeyError:
        return "no_table", "none"
    hits = []
    self_drops(table, f"minecraft:{block}", False, hits)
    if not hits:
        return "never", "none"
    if any(not g for g, _ in hits):
        return "unconditional", "none"
    gates = set()
    for _, g in hits:
        gates |= g
    if gates == {"shears"}:
        return "silk_gated", "shears"
    if "shears" in gates:
        return "silk_gated", "silk_or_shears"
    return "silk_gated", "silk"

PLACEMENT_DEFAULTS = {"persistent": "true"}
MULTIFACE = ("GlowLichenBlock", "SculkVeinBlock", "MultifaceBlock")


def version_key(v):
    parts = [int(p) if p.isdigit() else 0 for p in v.split(".")]
    return parts + [0] * (3 - len(parts))


def stamp_since(blocks_out):
    """First release each block id can actually be placed.

    The lang sweep is the authority: an id either has a name in that
    release's en_us.json or the block is not there. Upstream's
    validVersions is deliberately NOT merged in. It tracks a color-set
    entry across renames and splits, so it reports smooth_stone_slab back
    to 1.13 when 1.13 has only stone_slab — a different block, from a
    different material. Trusting it would offer a 1.13 player a block
    their game cannot place, which is the one failure this field exists
    to prevent.

    Renames still matter, but for writing the schematic, not for deciding
    availability. That belongs to the export path.
    """
    versions = json.load(open(OUT_DIR / "versions.json"))
    since = versions["since"]
    missing = sorted({b["block_id"] for b in blocks_out if b["block_id"] not in since})
    if missing:
        raise SystemExit(
            f"no first release for {len(missing)} block(s): {missing[:8]} — "
            "run data-pipeline/build-versions.py, or drop them in the pipeline"
        )
    for b in blocks_out:
        b["since"] = since[b["block_id"]]


def stamp_color_since(colors_out, versions):
    """First release each map color exists. Colors are only ever added, so
    the first release whose set contains an id is its whole history."""
    order, sets = versions["versions"], versions["color_sets"]
    first = {}
    for version in order:
        for cid in sets[version]:
            first.setdefault(cid, version)
    missing = sorted(c["id"] for c in colors_out if c["id"] not in first)
    if missing:
        raise SystemExit(f"no first release for map color(s): {missing}")
    for c in colors_out:
        c["since"] = first[c["id"]]


def main():
    for p in (JAR, MAPDUMP):
        if not p.exists():
            sys.exit(f"missing input: {p} (see README for re-fetch/clone steps)")

    zf = zipfile.ZipFile(JAR)
    data_version = jar_json(zf, "version.json")["world_version"]
    mineable = {t: tag_members(zf, f"mineable/{t}") for t in MINEABLE}
    tiers = {t: tag_members(zf, t) for t in TIER_TAGS}
    lang = jar_json(zf, "assets/minecraft/lang/en_us.json")
    eff_json = json.dumps(jar_json(zf, "data/minecraft/enchantment/efficiency.json"))
    assert "levels_squared" in eff_json, "efficiency enchant formula changed"

    headers, reg = parse_dump(MAPDUMP)
    mapcolors = {int(i): (name, int(col)) for i, name, col in headers["mapcolor"] if int(i) != 0}
    assert len(mapcolors) == 61, f"expected 61 map colors, dump has {len(mapcolors)}"
    assert [n for n, _ in headers["brightness"]] == ["LOW", "NORMAL", "HIGH", "LOWEST"], \
        f"MapColor.Brightness order changed: {[n for n, _ in headers['brightness']]}"
    tones = dict(zip(TONE_NAMES, (int(m) for _, m in headers["brightness"]), strict=True))

    tier_meta = {}
    for name, speed, tag, durability in headers["tier"]:
        raw = jar_json(zf, f"data/minecraft/tags/block/{tag.removeprefix('minecraft:')}.json")
        excluded = {v.removeprefix("#minecraft:needs_").removesuffix("_tool")
                    for v in raw["values"] if v.startswith("#minecraft:needs_")}
        gate = next((g for g in ("diamond", "iron", "stone") if g not in excluded), "none")
        tier_meta[name.lower()] = {"speed": float(speed), "gate": gate,
                                   "durability": int(durability)}

    ench = {name: tag_members(zf, f"enchantable/{name}", kind="item")
            for name in ("mining", "mining_loot")}
    TOOL_ITEM = {"pickaxe": "diamond_pickaxe", "axe": "diamond_axe",
                 "shovel": "diamond_shovel", "hoe": "diamond_hoe", "shears": "shears"}
    tool_meta = {
        kind: {"efficiency": item in ench["mining"],
               "silk_touch": item in ench["mining_loot"],
               "tiered": kind != "shears"}
        for kind, item in TOOL_ITEM.items()
    }
    assert tool_meta["shears"] == {"efficiency": True, "silk_touch": False, "tiered": False}, \
        "shears enchantability changed — recheck enchantable/* tags"

    def display_of(bid):
        return lang.get(f"block.minecraft.{bid}",
                        " ".join(w.capitalize() for w in bid.split("_")))

    shears_speed = dict(SHEARS_DIRECT)
    for tag, speed in SHEARS_RULES:
        for b in tag_members(zf, tag):
            shears_speed.setdefault(b, speed)

    def tool_of(b):
        for t in MINEABLE:
            if b in mineable[t]:
                return t
        return "none"

    def tier_of(b):
        for t in reversed(TIER_TAGS):
            if b in tiers[t]:
                return TIER_NAME[t]
        return "none"

    def unstable_of(row):
        return row["rt_min"] == "true" or row["class"].startswith("Coral")

    def curation_verdict(row):
        if row["item"] != "true" and row["class"] != "LiquidBlock":
            return "no_item"
        if row["multiblock"] == "true":
            return "multiblock"
        return None

    def color_entries(row):
        if "," not in row["all_mapcolors"]:
            entries = [(int(row["default_mapcolor"]), {})]
        else:
            entries = []
            for part in row["color_states"].split(";"):
                c, _, ps = part.partition(":")
                if int(c) == 0:
                    continue
                props = dict(kv.split("=", 1) for kv in ps.split("&")) if ps else {}
                entries.append((int(c), props))
        have = set(row["props"].split(",")) if row["props"] else set()
        defaults = dict(PLACEMENT_DEFAULTS)
        if row.get("class") in MULTIFACE:
            defaults["down"] = "true"
        for cid, props in entries:
            for prop, value in defaults.items():
                if prop in have and prop not in props:
                    props[prop] = value
        return entries

    ids = sorted(mapcolors)
    rgbs = [tuple(mapcolors[cid][1].to_bytes(3, "big")) for cid in ids]
    names = color_names(rgbs)
    assert len(set(names)) == len(ids), "color names must be unique"
    colors_out = [
        {"id": cid, "name": name,
         "constant": mapcolors[cid][0], "rgb": list(rgb),
         "tones": tones_rgb(mapcolors[cid][1], tones)}
        for cid, rgb, name in zip(ids, rgbs, names, strict=True)
    ]

    blocks_out = []
    excluded = []
    for bid, row in sorted(reg.items()):
        if row["default_mapcolor"] == "0":
            continue
        reason = curation_verdict(row)
        if reason:
            excluded.append({
                "block_id": bid,
                "default_color_id": int(row["default_mapcolor"]),
                "reason": reason,
            })
            continue
        for cid, props in color_entries(row):
            blocks_out.append({
                "color_id": cid,
                "block_id": bid,
                "display_name": display_of(bid),
                "properties": props,
                "hardness": float(row["hardness"]),
                "tool": tool_of(bid),
                "min_tier": tier_of(bid),
                "requires_tool": row["req_tool"] == "true",
                "recoverability": recoverability(zf, bid)[0],
                "gate": recoverability(zf, bid)[1],
                "shears_speed": shears_speed.get(bid),
                "gravity": row["falling"] == "true",
                "support_mandatory": row["falling"] == "true"
                or row["constrained"] == "true",
                "flammable": int(row["burn"]) > 0,
                "unstable": unstable_of(row),
                "constrained": row["constrained"] == "true",
                "fluid": row.get("class") == "LiquidBlock",
            })

    kept = []
    dropped = {}
    for e in blocks_out:
        bid = e["block_id"]
        reason = mapart_verdict(bid, reg.get(bid, {}))
        if reason is None and texture.resolve(zf, bid, e["properties"]) is None:
            reason = "no_texture"
        if reason:
            dropped.setdefault(bid, (e["color_id"], reason))
        else:
            kept.append(e)
    blocks_out = kept
    for bid, (cid, reason) in sorted(dropped.items()):
        excluded.append({"block_id": bid, "default_color_id": cid, "reason": reason})

    stamp_since(blocks_out)

    blocks_out.sort(key=lambda b: (b["color_id"], b["block_id"], sorted(b["properties"].items())))

    versions = json.load(open(OUT_DIR / "versions.json"))
    stamp_color_since(colors_out, versions)
    meta = {"mc_version": "26.2", "data_version": data_version,
            "versions": versions["versions"],
            "data_versions": versions["data_versions"],
            "tiers": tier_meta, "tools": tool_meta,
            "generator": "arachne data-pipeline/build-blocks.py",
            "sources": "26.2 client jar"}

    OUT_DIR.mkdir(exist_ok=True)
    with open(OUT_DIR / "blocks-26.2.json", "w") as f:
        json.dump({"meta": meta, "colors": colors_out, "blocks": blocks_out},
                  f, indent=1, sort_keys=True)
        f.write("\n")

    with open(OUT_DIR / "additions-26.2-excluded.json", "w") as f:
        json.dump({"meta": meta, "blocks": excluded}, f, indent=1, sort_keys=True)
        f.write("\n")

    if UNKNOWN_GATES:
        print(f"WARNING: {len(UNKNOWN_GATES)} unrecognized match_tool predicate(s), "
              f"treated as silk-gated: {sorted(UNKNOWN_GATES)}")
    n_silk = sum(1 for b in blocks_out if b["recoverability"] == "silk_gated")
    n_unstable = sum(1 for b in blocks_out if b["unstable"])
    from collections import Counter
    reasons = Counter(e["reason"] for e in excluded)
    print(f"colors: {len(colors_out)}  candidates: {len(blocks_out)} "
          f"({len({b['block_id'] for b in blocks_out})} block ids; "
          f"{n_silk} silk-gated, {n_unstable} unstable entries)  "
          f"excluded: {len(excluded)} {dict(reasons)}  data_version: {data_version}")

if __name__ == "__main__":
    main()
