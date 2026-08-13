"""Perceptual color names for map colors — generated, never hand-written.

Family from OKLab hue against anchors measured from canonical sRGB colors;
lightness/saturation words from HSL (gamut-relative, so saturated primaries
read "Red", not "Light Red"). Within a family, lightness words are assigned
in rank order, so same-family colors come out as a unique ordered scale
(Black -> Charcoal -> ... -> White). minecraft#17.
"""

import math

ANCHORS = [
    (2.5, "Rose"), (29.2, "Red"), (53.0, "Orange"), (84.1, "Amber"),
    (109.8, "Yellow"), (135.9, "Lime"), (142.5, "Green"), (170.0, "Sea Green"),
    (194.8, "Cyan"), (230.0, "Sky Blue"), (264.1, "Blue"), (293.9, "Purple"),
    (328.4, "Magenta"),
]
LIGHT = [(0.15, "Deep"), (0.27, "Dark"), (0.37, "Dusky"), (0.47, "Medium"),
         (0.58, ""), (0.68, "Soft"), (0.78, "Light"), (0.88, "Pale"),
         (1.01, "Very Pale")]
GRAY = [(0.12, "Black"), (0.20, "Near Black"), (0.29, "Charcoal"),
        (0.38, "Dark Gray"), (0.47, "Slate Gray"), (0.56, "Medium Gray"),
        (0.66, "Gray"), (0.76, "Light Gray"), (0.86, "Pale Gray"),
        (0.97, "Off White"), (1.01, "White")]
NEUTRAL_C = 0.030
TINT_C = 0.008
MUTED_C = 0.055
VIVID_C = 0.150

def _srgb_to_linear(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def oklch(rgb):
    r, g, b = (_srgb_to_linear(v) for v in rgb)
    l = 0.4122214708*r + 0.5363325363*g + 0.0514459929*b
    m = 0.2119034982*r + 0.6806995451*g + 0.1073969566*b
    s = 0.0883024619*r + 0.2817188376*g + 0.6299787005*b
    l, m, s = l ** (1/3), m ** (1/3), s ** (1/3)
    L = 0.2104542553*l + 0.7936177850*m - 0.0040720468*s
    a = 1.9779984951*l - 2.4285922050*m + 0.4505937099*s
    bb = 0.0259040371*l + 0.7827717662*m - 0.8086757660*s
    return L, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360

def hsl(rgb):
    r, g, b = (v / 255 for v in rgb)
    mx, mn = max(r, g, b), min(r, g, b)
    L = (mx + mn) / 2
    if mx == mn:
        return 0.0, L
    d = mx - mn
    return (d / (2 - mx - mn) if L > 0.5 else d / (mx + mn)), L

def _anchor(h):
    return min(range(len(ANCHORS)),
               key=lambda i: min(abs(h - ANCHORS[i][0]), 360 - abs(h - ANCHORS[i][0])))

def _features(rgb):
    _, C, h = oklch(rgb)
    S, L = hsl(rgb)
    if C < NEUTRAL_C:
        tint = ""
        if C > TINT_C:
            tint = "Warm" if 300 <= h or h < 150 else "Cool"
        return {"gray": True, "stem": tint, "C": C, "L": L, "quals": []}

    i = _anchor(h)
    anchor = ANCHORS[i][1]
    fam = anchor
    if anchor in ("Red", "Orange", "Amber") and L < 0.52 and C < VIVID_C:
        fam = "Brown"
    elif anchor in ("Yellow", "Lime") and L < 0.52 and C < VIVID_C:
        fam = "Olive"
    elif anchor == "Cyan" and L < 0.45:
        fam = "Teal"
    elif anchor == "Rose" and L >= 0.58:
        fam = "Pink"

    d = (h - ANCHORS[i][0] + 180) % 360 - 180
    lean = ANCHORS[(i - 1) % len(ANCHORS)][1] if d < 0 else ANCHORS[(i + 1) % len(ANCHORS)][1]
    quals = [q for q in (anchor if anchor != fam else "", lean if lean != fam else "") if q]
    stem = f"Vivid {fam}" if C > VIVID_C else (f"Muted {fam}" if C < MUTED_C else fam)
    return {"gray": False, "stem": stem, "C": C, "L": L, "quals": quals}

def _assign(members, ladder, stem, gray):
    """Lightness words in rank order; strictly increasing so all differ."""
    order = sorted(members, key=lambda m: (m["L"], m["idx"]))
    used = -1
    out = {}
    for m in order:
        nat = next(i for i, (lim, _) in enumerate(ladder) if m["L"] < lim)
        pick = max(nat, used + 1)
        if pick >= len(ladder):
            pick = len(ladder) - 1
        used = pick
        word = ladder[pick][1]
        parts = (stem, word) if gray else (word, stem)
        out[m["idx"]] = " ".join(w for w in parts if w)
    return out

def color_names(rgbs):
    """Unique human color names for a palette. Deterministic, order-stable."""
    feats = [dict(_features(c), idx=i) for i, c in enumerate(rgbs)]
    groups = {}
    for f in feats:
        groups.setdefault(("gray" if f["gray"] else "hue", f["stem"]), []).append(f)

    final = {}
    for (kind, stem), members in groups.items():
        ladder = GRAY if kind == "gray" else LIGHT
        if len(members) <= 4 or not any(m["quals"] for m in members):
            final[(kind, stem)] = members
            continue
        for m in members:
            q = m["quals"][0] if m["quals"] else ""
            final.setdefault((kind, f"{q} {stem}".strip()), []).append(m)

    labels = [""] * len(rgbs)
    for (kind, stem), members in final.items():
        ladder = GRAY if kind == "gray" else LIGHT
        for idx, label in _assign(members, ladder, stem, kind == "gray").items():
            labels[idx] = label

    for _ in range(3):
        dupes = {n for n in labels if labels.count(n) > 1}
        if not dupes:
            break
        for f in feats:
            if labels[f["idx"]] not in dupes:
                continue
            extra = "Muted" if f["C"] < MUTED_C else ""
            if not extra and f["quals"]:
                extra = f["quals"][0]
            if extra and extra not in labels[f["idx"]]:
                parts = labels[f["idx"]].split(" ")
                labels[f["idx"]] = " ".join(parts[:-1] + [extra, parts[-1]])
    return labels
