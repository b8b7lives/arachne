# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow"]
# ///
import io
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

import texture
from PIL import Image

HERE = Path(__file__).resolve().parent
JAR = HERE / "../../analysis/mapartcraft/26x-data/minecraft-26.2-client.jar"
BLOCKS = HERE / "../data/blocks-26.2.json"
OUT_PNG = HERE / "../web/public/atlas.png"
OUT_META = HERE / "../web/public/atlas.json"

TILE = texture.TILE
ATLAS_COLS = 32

GRASS_DEFAULT = (124, 189, 107)
FOLIAGE_DEFAULT = (72, 181, 24)
GRASS_TINTED = {
    "grass_block", "short_grass", "tall_grass", "fern", "large_fern",
    "sugar_cane", "potted_fern",
}
FOLIAGE_TINTED = {
    "vine", "lily_pad", "melon_stem", "pumpkin_stem",
    "attached_melon_stem", "attached_pumpkin_stem",
}
FOLIAGE_SUFFIX = ("_leaves",)

def default_tint(bid):
    """Vanilla's default client tint for a grayscale texture, or None."""
    if bid in GRASS_TINTED:
        return GRASS_DEFAULT
    if bid in FOLIAGE_TINTED or bid.endswith(FOLIAGE_SUFFIX):
        return FOLIAGE_DEFAULT
    return None

def tint(img, rgb):
    r, g, b = rgb
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            pr, pg, pb, pa = px[x, y]
            px[x, y] = (pr * r // 255, pg * g // 255, pb * b // 255, pa)
    return out

def tint_tile(rgb):
    img = Image.new("RGBA", (TILE, TILE), (*rgb, 255))
    edge = tuple(c * 3 // 4 for c in rgb)
    for i in range(TILE):
        for x, y in ((i, 0), (i, TILE - 1), (0, i), (TILE - 1, i)):
            img.putpixel((x, y), (*edge, 255))
    return img

SHAPES = [("_slab", "slab"), ("_stairs", "stairs"),
          ("_carpet", "carpet"), ("_pressure_plate", "plate")]

def shape_of(bid):
    for suffix, kind in SHAPES:
        if bid.endswith(suffix):
            return kind
    return None

def center_narrow(img):
    px = img.load()
    cols = [x for x in range(img.width) for y in range(img.height) if px[x, y][3]]
    if not cols:
        return img
    lo, hi = min(cols), max(cols)
    w = hi - lo + 1
    if w > img.width // 2:
        return img
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img.crop((lo, 0, hi + 1, img.height)), ((img.width - w) // 2, 0))
    return out

def side_view(img, kind):
    w, h = img.size
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if kind == "slab":
        out.paste(img.crop((0, h // 2, w, h)), (0, h // 2))
    elif kind == "stairs":
        out.paste(img.crop((0, h // 2, w, h)), (0, h // 2))
        out.paste(img.crop((w // 2, 0, w, h // 2)), (w // 2, 0))
    elif kind == "carpet":
        t = max(2, h // 8)
        out.paste(img.crop((0, h - t, w, h)), (0, h - t))
    elif kind == "plate":
        t = max(2, h // 8)
        pad = max(1, w // 8)
        out.paste(img.crop((pad, h - t, w - pad, h)), (pad, h - t))
    return out

def main():
    for p in (JAR, BLOCKS):
        if not p.exists():
            sys.exit(f"missing input: {p}")
    data = json.load(open(BLOCKS))
    colors = {c["id"]: tuple(c["rgb"]) for c in data["colors"]}
    zf = zipfile.ZipFile(JAR)

    entries = data["blocks"]
    rows = (len(entries) + ATLAS_COLS - 1) // ATLAS_COLS
    atlas = Image.new("RGBA", (ATLAS_COLS * TILE, rows * TILE), (0, 0, 0, 0))
    fallbacks = []
    for i, entry in enumerate(entries):
        rgb = colors[entry["color_id"]]
        img = texture.resolve(zf, entry["block_id"], entry["properties"])
        if img is None:
            img = tint_tile(rgb)
            fallbacks.append(entry["block_id"])
        else:
            biome_tint = default_tint(entry["block_id"])
            if biome_tint:
                img = tint(img, biome_tint)
            img = center_narrow(img)
            kind = shape_of(entry["block_id"])
            if kind:
                img = side_view(img, kind)
        atlas.paste(img, ((i % ATLAS_COLS) * TILE, (i // ATLAS_COLS) * TILE))

    OUT_PNG.parent.mkdir(exist_ok=True)
    for name in ("blocks-26.2.json", "mapartcraft-presets-26.2.json"):
        shutil.copyfile(BLOCKS.parent / name, OUT_PNG.parent / name)
    atlas.save(OUT_PNG, optimize=True)
    digest = hashlib.sha1(OUT_PNG.read_bytes()).hexdigest()[:12]
    json.dump(
        {"tile": TILE, "cols": ATLAS_COLS, "count": len(entries), "hash": digest},
        open(OUT_META, "w"),
    )
    print(f"atlas: {len(entries)} tiles ({len(fallbacks)} tint fallbacks), "
          f"{atlas.width}x{atlas.height} -> {OUT_PNG.name}")
    if fallbacks:
        print("fallbacks:", " ".join(sorted(set(fallbacks))[:40]))

if __name__ == "__main__":
    main()
