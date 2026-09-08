# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]", "pillow"]
# ///
"""Mirror the curated font families from google/fonts at a pinned commit.

Reads fonts-catalog.json, downloads each family's font files and license,
compresses each font file whole into WOFF2 (no subsetting, no instancing),
and writes data/fonts/<id>/ plus data/fonts.json. Also renders two sprite
sheets, one row per family: the family name in its own face for the app's
picker and a pangram sample for the fonts page, and writes
data/fonts-coverage.json, each face's cmap as hex code point ranges, loaded
by the app only once text exists. See minecraft#87.
"""

import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
CATALOG = HERE / "fonts-catalog.json"
CACHE = HERE / ".fonts-cache"
OUT_DIR = HERE / "../data/fonts"
OUT_MANIFEST = HERE / "../data/fonts.json"
OUT_NAMES = HERE / "../data/fonts-names.webp"
OUT_SAMPLES = HERE / "../data/fonts-samples.webp"
OUT_COVERAGE = HERE / "../data/fonts-coverage.json"
NAME_W, NAME_H, NAME_PX = 240, 32, 20
SAMPLE_W, SAMPLE_H, SAMPLE_PX = 720, 44, 26
INK = (230, 230, 230, 255)
PANGRAMS = [
    "The quick brown fox jumps over the lazy dog",
    "Sphinx of black quartz, judge my vow",
    "Pack my box with five dozen liquor jugs",
    "How vexingly quick daft zebras jump",
    "The five boxing wizards jump quickly",
    "Jackdaws love my big sphinx of quartz",
    "Waltz, bad nymph, for quick jigs vex",
    "Glib jocks quiz nymph to vex dwarf",
]
SYMBOLS = "☀★♥☾☺✈❤♪♫✓✗→←☂☃⚡"
RAW = "https://raw.githubusercontent.com/google/fonts/{commit}/{path}"
LICENSE_FILES = {"ofl": "OFL.txt", "apache": "LICENSE.txt", "ufl": "UFL.txt"}
LICENSE_NAMES = {"ofl": "OFL-1.1", "apache": "Apache-2.0", "ufl": "UFL-1.0"}


def fetch(commit, path):
    dest = CACHE / commit / path
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        url = RAW.format(commit=commit, path=urllib.parse.quote(path))
        with urllib.request.urlopen(url, timeout=60) as r:
            dest.write_bytes(r.read())
    return dest


def parse_metadata(text):
    meta = {"fonts": []}
    cur = None
    for raw in text.splitlines():
        line = raw.strip()
        if line == "fonts {":
            cur = {}
            meta["fonts"].append(cur)
        elif line == "}":
            cur = None
        elif cur is not None or "{" not in line:
            m = re.match(r'^(\w+):\s*"?([^"]*)"?$', line)
            if m:
                (cur if cur is not None else meta).setdefault(m.group(1), m.group(2))
    return meta


def tags_for(commit):
    table = {}
    with open(fetch(commit, "tags/all/families.csv"), newline="", encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) >= 4 and not row[1]:
                try:
                    table.setdefault(row[0], {})[row[2]] = int(float(row[3]))
                except ValueError:
                    pass
    return table


def pick_files(fonts):
    variable = [f["filename"] for f in fonts if "[" in f["filename"] and f.get("style") != "italic"]
    if variable:
        return variable
    wanted = []
    for f in fonts:
        if f.get("style") == "normal" and f.get("weight") in ("400", "700"):
            wanted.append(f["filename"])
    return wanted or [fonts[0]["filename"]]


def to_woff2(src, dest):
    if dest.exists() and "--refresh" not in sys.argv:
        return dest.stat().st_size
    font = TTFont(src)
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    dest.write_bytes(buf.getvalue())
    return len(buf.getvalue())


def covered(path, text):
    cmap = TTFont(path).getBestCmap() or {}
    return "".join(c for c in text if ord(c) in cmap)


def coverage_ranges(path):
    points = sorted(TTFont(path).getBestCmap() or {})
    ranges = []
    for cp in points:
        if ranges and cp == ranges[-1][1] + 1:
            ranges[-1][1] = cp
        else:
            ranges.append([cp, cp])
    return ranges


def fitted_size(path, text, px, max_w, native):
    if native:
        size = max(native, (px // native) * native)
        while size > native and ImageFont.truetype(str(path), size).getlength(text) > max_w:
            size -= native
        return size
    size = px
    while size > 8 and ImageFont.truetype(str(path), size).getlength(text) > max_w:
        size -= 1
    return size


def strip(path, text, w, h, px, native):
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    if not text:
        return img
    size = fitted_size(path, text, px, w - 16, native)
    font = ImageFont.truetype(str(path), size)
    ImageDraw.Draw(img).text((8, h // 2), text, font=font, fill=INK, anchor="lm")
    return img


def sample_text(path, index):
    if covered(path, "abcdefghijklmnopqrstuvwxyz") == "abcdefghijklmnopqrstuvwxyz":
        return PANGRAMS[index % len(PANGRAMS)]
    return covered(path, SYMBOLS)


def main():
    catalog = json.loads(CATALOG.read_text())
    commit = catalog["source"]["commit"]
    tags = tags_for(commit)
    out_faces = []
    coverage = {}
    names_sheet = Image.new("RGBA", (NAME_W, NAME_H * len(catalog["faces"])), (0, 0, 0, 0))
    samples_sheet = Image.new("RGBA", (SAMPLE_W, SAMPLE_H * len(catalog["faces"])), (0, 0, 0, 0))
    label_font = None
    for index, face in enumerate(catalog["faces"]):
        lic_dir = face["dir"].split("/")[0]
        meta = parse_metadata(fetch(commit, f"{face['dir']}/METADATA.pb").read_text(encoding="utf-8"))
        lic_name = LICENSE_FILES[lic_dir]
        lic_src = fetch(commit, f"{face['dir']}/{lic_name}")
        target = OUT_DIR / face["id"]
        target.mkdir(parents=True, exist_ok=True)
        (target / lic_name).write_bytes(lic_src.read_bytes())
        files = []
        first_src = None
        for filename in pick_files(meta["fonts"]):
            src = fetch(commit, f"{face['dir']}/{filename}")
            first_src = first_src or src
            stem = re.sub(r"\[.*\]", "-VF", Path(filename).stem)
            dest = target / f"{stem}.woff2"
            size = to_woff2(src, dest)
            entry = next((f for f in meta["fonts"] if f["filename"] == filename), {})
            files.append({
                "file": dest.name,
                "weight": "variable" if "[" in filename else int(entry.get("weight", 400)),
                "style": entry.get("style", "normal"),
                "bytes": size,
                "upstream": filename,
            })
        out_faces.append({
            "id": face["id"],
            "name": face["name"],
            "designer": meta.get("designer", ""),
            "category": meta.get("category", ""),
            "license": LICENSE_NAMES[lic_dir],
            "license_file": lic_name,
            "dir": face["dir"],
            "tags": tags.get(face["name"], {}),
            "native": face.get("native"),
            "small": face["small"],
            "big": face["big"],
            "hidden": face.get("hidden", False),
            "files": files,
            "strip": index,
        })
        coverage[face["id"]] = ",".join(
            f"{a:x}-{b:x}" if a != b else f"{a:x}" for a, b in coverage_ranges(first_src)
        )
        native = face.get("native")
        has_latin = covered(first_src, "abc") == "abc"
        if has_latin:
            name_img = strip(first_src, face["name"], NAME_W, NAME_H, NAME_PX, native)
        else:
            label_font = label_font or fetch(commit, "ofl/notosans/NotoSans[wdth,wght].ttf")
            name_img = strip(label_font, face["name"], NAME_W, NAME_H, NAME_PX, None)
        names_sheet.paste(name_img, (0, index * NAME_H))
        samples_sheet.paste(
            strip(first_src, sample_text(first_src, index), SAMPLE_W, SAMPLE_H, SAMPLE_PX, native),
            (0, index * SAMPLE_H),
        )
        print(f"{face['id']}: {len(files)} file(s), {sum(f['bytes'] for f in files) // 1024} KB", file=sys.stderr)
    names_sheet.save(OUT_NAMES, "WEBP", lossless=True)
    samples_sheet.save(OUT_SAMPLES, "WEBP", lossless=True)
    manifest = {
        "contract": 1,
        "source": catalog["source"],
        "strips": {
            "names": {"file": OUT_NAMES.name, "w": NAME_W, "h": NAME_H},
            "samples": {"file": OUT_SAMPLES.name, "w": SAMPLE_W, "h": SAMPLE_H},
        },
        "faces": out_faces,
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    OUT_COVERAGE.write_text(
        json.dumps({"contract": 1, "faces": coverage}, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    total = sum(f["bytes"] for face in out_faces for f in face["files"])
    print(
        f"{len(out_faces)} faces, {total / 1e6:.1f} MB of woff2, manifest {OUT_MANIFEST.name}, "
        f"sprites {OUT_NAMES.stat().st_size // 1024} KB + {OUT_SAMPLES.stat().st_size // 1024} KB"
    )


if __name__ == "__main__":
    main()
