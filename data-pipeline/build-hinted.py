# /// script
# requires-python = ">=3.12"
# dependencies = ["fonttools[woff]", "pillow==12.3.0", "freetype-py==2.5.1"]
# ///
"""Render the one-bit glyph sheets for the hinted letter style.

Runs after build-fonts.py. For every picker family that is not a pixel
face, renders each character of CHARS at every size in SIZES and every
real weight the family ships (variable fonts through their wght axis,
static families through their 400 and 700 files) with FreeType's
monochrome target and its default hinter selection: the font's own
instructions where it has them, the auto-hinter where it has none.
Kerning pairs come from GPOS pair positioning and the kern table.
Writes data/fonts/<id>/hinted.bin and adds a "hinted" entry to each face
in data/fonts.json. See minecraft#87 and README.md for the file format.

The sheets are pinned to one FreeType build. freetype-py opens the
library file inside its own package first, so that open is redirected
to the copy Pillow ships, and the version is asserted; any other
FreeType refuses to build. Drift check: a line assembled from the
sheet's own metrics must equal Pillow's whole-line render of the same
text on the same library, or the build fails.
"""

import ctypes
import glob
import gzip
import io
import json
import os
import struct
import sys
import time
from pathlib import Path

import PIL
from fontTools.ttLib import TTFont
from PIL import ImageFont

FT_WANT = (2, 14, 3)


def load_freetype():
    pillow_lib = glob.glob(os.path.join(os.path.dirname(PIL.__file__), "..", "pillow.libs", "libfreetype*"))
    real = ctypes.CDLL

    def redirect(name, *args, **kwargs):
        target = pillow_lib[0] if pillow_lib and str(name).endswith("libfreetype.so") else name
        return real(target, *args, **kwargs)

    ctypes.CDLL = redirect
    try:
        import freetype
    finally:
        ctypes.CDLL = real
    if freetype.version() != FT_WANT:
        sys.exit(f"FreeType {freetype.version()} loaded, the sheets are pinned to {FT_WANT}")
    return freetype


ft = load_freetype()

HERE = Path(__file__).resolve().parent
FONTS = HERE / "../data/fonts"
MANIFEST = HERE / "../data/fonts.json"
SIZES = list(range(8, 20))
WEIGHTS = (400, 700)
CHARS = sorted(
    set(range(0x20, 0x7F))
    | set(range(0xA0, 0x180))
    | {0x2013, 0x2014, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E, 0x2022, 0x2026, 0x20AC, 0x2122}
)
FLAGS = ft.FT_LOAD_TARGET_MONO | ft.FT_LOAD_RENDER
MAGIC = b"AHNT"
FORMAT = 1
FILE = "hinted.bin"
PANGRAM = "Sphinx of black quartz, judge my vow. AVATAR fjord 07 Ærø Łódź"


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def has_glyph_instructions(font):
    if "glyf" not in font:
        return False
    glyf = font["glyf"]
    for name in glyf.keys():
        program = getattr(glyf[name], "program", None)
        if program is not None and program.getBytecode():
            return True
    return False


def sources(face):
    """(weight label, TTF bytes, fvar axes or None, design coords template) per real weight."""
    files = face["files"]
    var = next((f for f in files if f["weight"] == "variable"), None)
    if var:
        font = TTFont(FONTS / face["id"] / var["file"])
        font.flavor = None
        axes = [(a.axisTag, a.minValue, a.defaultValue, a.maxValue) for a in font["fvar"].axes]
        buf = io.BytesIO()
        font.save(buf)
        data = buf.getvalue()
        tags = [a[0] for a in axes]
        if "wght" not in tags:
            return [(400, data, axes)], font
        out = []
        seen = set()
        wmin, wmax = axes[tags.index("wght")][1], axes[tags.index("wght")][3]
        for w in WEIGHTS:
            ww = clamp(w, wmin, wmax)
            if ww in seen:
                continue
            seen.add(ww)
            out.append((w, data, axes))
        return out, font
    chosen = [f for f in files if f["style"] == "normal" and f["weight"] in WEIGHTS] or files[:1]
    out = []
    first = None
    for f in chosen:
        font = TTFont(FONTS / face["id"] / f["file"])
        font.flavor = None
        first = first or font
        buf = io.BytesIO()
        font.save(buf)
        out.append((f["weight"] if f["weight"] in WEIGHTS else 400, buf.getvalue(), None))
    return out, first


def coords_for(axes, weight, px):
    if axes is None:
        return None
    out = []
    for tag, lo, default, hi in axes:
        if tag == "wght":
            out.append(clamp(weight, lo, hi))
        elif tag == "opsz":
            out.append(clamp(px, lo, hi))
        else:
            out.append(default)
    return out


def kern_pairs(font, cmap):
    """(left cp, right cp) -> font units, from GPOS pair positioning then the kern table."""
    glyph_cp = {}
    for cp in CHARS:
        g = cmap.get(cp)
        if g:
            glyph_cp.setdefault(g, cp)
    out = {}
    if "GPOS" in font:
        gpos = font["GPOS"].table
        lookups = set()
        for fr in gpos.FeatureList.FeatureRecord:
            if fr.FeatureTag == "kern":
                lookups.update(fr.Feature.LookupListIndex)

        def visit(st):
            if st.LookupType == 9:
                visit(st.ExtSubTable)
                return
            if st.LookupType != 2:
                return
            cov = st.Coverage.glyphs
            if st.Format == 1:
                for g1, ps in zip(cov, st.PairSet):
                    if g1 not in glyph_cp:
                        continue
                    for pvr in ps.PairValueRecord:
                        if pvr.SecondGlyph in glyph_cp:
                            v = getattr(pvr.Value1, "XAdvance", 0) or 0
                            if v:
                                out.setdefault((glyph_cp[g1], glyph_cp[pvr.SecondGlyph]), v)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs
                c2 = st.ClassDef2.classDefs
                for g1 in cov:
                    if g1 not in glyph_cp:
                        continue
                    rec1 = st.Class1Record[c1.get(g1, 0)]
                    for g2, cp2 in glyph_cp.items():
                        v = getattr(rec1.Class2Record[c2.get(g2, 0)].Value1, "XAdvance", 0) or 0
                        if v:
                            out.setdefault((glyph_cp[g1], cp2), v)

        for i in sorted(lookups):
            for st in gpos.LookupList.Lookup[i].SubTable:
                visit(st)
    if "kern" in font:
        for sub in font["kern"].kernTables:
            for (g1, g2), v in (getattr(sub, "kernTable", None) or {}).items():
                if v and g1 in glyph_cp and g2 in glyph_cp:
                    out.setdefault((glyph_cp[g1], glyph_cp[g2]), v)
    return {k: v for k, v in out.items() if -32768 <= v <= 32767}


def kern_classes(pairs, cps):
    """Pairs as left classes, right classes and a matrix: code points whose
    rows agree share a left class, columns likewise, so the matrix is exact
    and about the size of the font's own class kerning."""
    lefts = sorted({a for a, _ in pairs})
    rights = sorted({b for _, b in pairs})
    rows = {}
    left_class = {}
    for a in lefts:
        row = tuple(pairs.get((a, b), 0) for b in rights)
        left_class[a] = rows.setdefault(row, len(rows))
    row_list = [None] * len(rows)
    for row, i in rows.items():
        row_list[i] = row
    cols = {}
    right_class = {}
    for j, b in enumerate(rights):
        col = tuple(row[j] for row in row_list)
        right_class[b] = cols.setdefault(col, len(cols))
    col_list = [None] * len(cols)
    for col, i in cols.items():
        col_list[i] = col
    matrix = [[col_list[c][r] for c in range(len(col_list))] for r in range(len(row_list))]
    return left_class, right_class, matrix


def render_band(face, px, cps):
    face.set_pixel_sizes(0, px)
    glyphs = []
    for cp in cps:
        idx = face.get_char_index(cp)
        if idx == 0:
            continue
        face.load_glyph(idx, FLAGS)
        slot = face.glyph
        bm = slot.bitmap
        if bm.rows and bm.pixel_mode != ft.FT_PIXEL_MODE_MONO:
            sys.exit(f"glyph U+{cp:04X} at {px} px is not one bit per pixel")
        if slot.advance.x % 64:
            sys.exit(f"glyph U+{cp:04X} at {px} px has a fractional advance")
        stride = (bm.width + 7) // 8
        rows = b"".join(bytes(bm.buffer[y * bm.pitch : y * bm.pitch + stride]) for y in range(bm.rows))
        adv = slot.advance.x // 64
        if not (0 <= adv <= 255 and -128 <= slot.bitmap_left <= 127 and -128 <= slot.bitmap_top <= 127 and bm.width <= 255 and bm.rows <= 255):
            sys.exit(f"glyph U+{cp:04X} at {px} px does not fit the record")
        glyphs.append((cp, adv, slot.bitmap_left, slot.bitmap_top, bm.width, bm.rows, rows))
    return face.size.ascender // 64, face.size.descender // 64, glyphs


def assemble(glyphs, text):
    """Ink pixels of text laid out from the band's advances alone."""
    by_cp = {g[0]: g for g in glyphs}
    pts = set()
    pen = 0
    for ch in text:
        g = by_cp.get(ord(ch))
        if g is None:
            continue
        cp, adv, left, top, w, h, rows = g
        stride = (w + 7) // 8
        for y in range(h):
            for x in range(w):
                if rows[y * stride + x // 8] & (0x80 >> (x % 8)):
                    pts.add((pen + left + x, y - top))
        pen += adv
    return pts


def pillow_font(data, coords, px):
    font = ImageFont.truetype(io.BytesIO(data), px, layout_engine=ImageFont.Layout.BASIC)
    if coords:
        font.set_variation_by_axes(coords)
    return font


def fixture_text(font, cmap):
    """The pangram's characters spaced apart, so no pair of the font's kern
    table applies and the check is about advances and bitmaps alone."""
    space = font.getlength(" ", mode="1")
    keep = []
    for ch in dict.fromkeys(PANGRAM):
        if ch == " " or ord(ch) not in cmap:
            continue
        if font.getlength(f" {ch} ", mode="1") == 2 * space + font.getlength(ch, mode="1"):
            keep.append(ch)
    return " ".join(keep)


def pillow_line(font, text):
    mask, _ = font.getmask2(text, mode="1", anchor="ls")
    w = mask.size[0]
    return {(i % w, i // w) for i, v in enumerate(list(mask)) if v}


def normalized(pts):
    if not pts:
        return frozenset()
    x0 = min(x for x, _ in pts)
    y0 = min(y for _, y in pts)
    return frozenset((x - x0, y - y0) for x, y in pts)


def build_face(face_meta):
    srcs, font = sources(face_meta)
    if not srcs:
        return None
    cmap = font.getBestCmap() or {}
    cps = [cp for cp in CHARS if cp in cmap]
    own = has_glyph_instructions(font)
    upem = font["head"].unitsPerEm
    kern = kern_pairs(font, cmap)
    weights = [w for w, _, _ in srcs]
    body = bytearray()
    drift = []
    for weight, data, axes in srcs:
        face = ft.Face(io.BytesIO(data))
        for px in SIZES:
            coords = coords_for(axes, weight, px)
            if coords:
                face.set_var_design_coords(coords)
            asc, desc, glyphs = render_band(face, px, cps)
            body += struct.pack("<bbH", asc, desc, len(glyphs))
            for cp, adv, left, top, w, h, rows in glyphs:
                body += struct.pack("<HBbbBB", cp, adv, left, top, w, h) + rows
            pf = pillow_font(data, coords, px)
            text = fixture_text(pf, cmap)
            mine = normalized(assemble(glyphs, text))
            theirs = normalized(pillow_line(pf, text))
            if mine != theirs:
                drift.append(f"{face_meta['id']} {weight} {px}px: {len(mine ^ theirs)} pixels differ")
    if drift:
        sys.exit("drift between the sheet and FreeType's own line render:\n  " + "\n  ".join(drift))
    head = MAGIC + struct.pack("<BBBBHBBB", FORMAT, *FT_WANT, upem, len(weights), len(SIZES), 1 if own else 0)
    head += b"".join(struct.pack("<H", w) for w in weights) + bytes(SIZES)
    left, right, matrix = kern_classes(kern, cps)
    n1, n2 = len(matrix), len(matrix[0]) if matrix else 0
    tail = struct.pack("<HHHH", n1, n2, len(left), len(right))
    tail += b"".join(struct.pack("<HH", cp, c) for cp, c in sorted(left.items()))
    tail += b"".join(struct.pack("<HH", cp, c) for cp, c in sorted(right.items()))
    tail += b"".join(struct.pack("<h", v) for row in matrix for v in row)
    raw = head + bytes(body) + tail
    return gzip.compress(raw, 9, mtime=0), weights, own, len(cps), len(kern), (n1, n2)


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    t0 = time.time()
    total = changed = built = 0
    hinting = {"own": 0, "auto": 0}
    for face in manifest["faces"]:
        if face.get("hidden") or face.get("native"):
            face.pop("hinted", None)
            continue
        result = build_face(face)
        if result is None:
            face.pop("hinted", None)
            continue
        blob, weights, own, nchars, nkern, classes = result
        dest = FONTS / face["id"] / FILE
        if not dest.exists() or dest.read_bytes() != blob:
            dest.write_bytes(blob)
            changed += 1
        face["hinted"] = {"file": FILE, "bytes": len(blob), "weights": weights, "hinting": "own" if own else "auto"}
        hinting["own" if own else "auto"] += 1
        total += len(blob)
        built += 1
        print(
            f"{face['id']}: {len(weights)} weight(s), {nchars} chars, {nkern} pairs as {classes[0]}x{classes[1]} classes, {len(blob) // 1024} KB",
            file=sys.stderr,
        )
    manifest["hinted"] = {"freetype": ".".join(map(str, FT_WANT)), "sizes": SIZES, "chars": len(CHARS)}
    MANIFEST.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"{built} sheets, {total / 1e6:.1f} MB, {changed} changed, {hinting['own']} hinted by their own "
        f"instructions and {hinting['auto']} by FreeType {'.'.join(map(str, FT_WANT))}, {time.time() - t0:.0f}s"
    )


if __name__ == "__main__":
    main()
