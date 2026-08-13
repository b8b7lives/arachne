import io
import json

from PIL import Image

TILE = 16

SUFFIX_RULES = [
    ("_stairs", ["{b}", "{b}s", "{b}_planks", "{b}_top"]),
    ("_slab", ["{b}", "{b}s", "{b}_planks", "{b}_top"]),
    ("_wall", ["{b}", "{b}s", "{b}_top"]),
    ("_fence_gate", ["{b}_planks", "{b}"]),
    ("_fence", ["{b}_planks", "{b}"]),
    ("_pressure_plate", ["{b}_planks", "{b}", "{b}_block"]),
    ("_button", ["{b}_planks", "{b}"]),
    ("_carpet", ["{b}_wool", "{b}", "{b}_block"]),
    ("_shelf", ["{b}_planks", "{b}"]),
]

def base_forms(bid):
    forms = [bid]
    for prefix in ("waxed_", "infested_", "smooth_"):
        if bid.startswith(prefix):
            forms.append(bid.removeprefix(prefix))
    out = []
    for f in forms:
        out.append(f)
        for suffix, _ in SUFFIX_RULES:
            if f.endswith(suffix):
                out.append(f.removesuffix(suffix))
    return out

def texture_names(block_id, properties):
    axis = (properties or {}).get("axis")
    names = ([block_id, f"{block_id}_top"] if axis in ("x", "z")
             else [f"{block_id}_top", block_id])
    names.append(f"{block_id}_still")
    for wood, log in (("_wood", "_log"), ("_hyphae", "_stem")):
        if block_id.endswith(wood):
            names.append(block_id.removesuffix(wood) + log)
    for f in base_forms(block_id):
        names += [f"{f}_top", f, f"{f}_block_top", f"{f}_block"]
        if f.endswith("_block"):
            names.append(f.removesuffix("_block"))
    for suffix, templates in SUFFIX_RULES:
        if block_id.endswith(suffix):
            b = block_id.removesuffix(suffix)
            names += [t.format(b=b) for t in templates]
    seen = set()
    return [n for n in names if not (n in seen or seen.add(n))]

def load_texture(zf, name):
    try:
        raw = zf.read(f"assets/minecraft/textures/block/{name}.png")
    except KeyError:
        return None
    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    if img.height > img.width:
        img = img.crop((0, 0, img.width, img.width))
    if img.size != (TILE, TILE):
        img = img.resize((TILE, TILE), Image.NEAREST)
    return img

FACE_ORDER = ("top", "up", "all", "end", "side", "texture", "cross", "plant",
              "crop", "fan", "log", "front", "pane", "rail", "flowerpot", "bottom")

def _jar_json(zf, path):
    try:
        return json.load(io.TextIOWrapper(zf.open(path), encoding="utf-8"))
    except KeyError:
        return None

def _model_faces(zf, model, depth=0):
    if depth > 8:
        return {}
    m = _jar_json(zf, f"assets/minecraft/models/{model.split(':')[-1]}.json")
    if m is None:
        return {}
    faces = dict(m.get("textures") or {})
    if m.get("parent"):
        merged = _model_faces(zf, m["parent"], depth + 1)
        merged.update(faces)
        faces = merged
    return faces

def _blockstate_models(zf, block_id):
    j = _jar_json(zf, f"assets/minecraft/blockstates/{block_id}.json")
    if j is None:
        return []
    out = []
    for v in (j.get("variants") or {}).values():
        out += [v] if isinstance(v, dict) else list(v)
    for part in j.get("multipart") or []:
        a = part.get("apply")
        out += [a] if isinstance(a, dict) else list(a or [])
    return [e["model"] for e in out if isinstance(e, dict) and e.get("model")]

def from_model(zf, block_id):
    for model in _blockstate_models(zf, block_id):
        faces = _model_faces(zf, model)
        usable = {k: v for k, v in faces.items()
                  if k != "particle" and isinstance(v, str) and not v.startswith("#")}
        for key in FACE_ORDER:
            if key in usable:
                img = load_texture(zf, usable[key].split("/")[-1])
                if img is not None:
                    return img
        for v in usable.values():
            img = load_texture(zf, v.split("/")[-1])
            if img is not None:
                return img
    return None

def resolve(zf, block_id, properties):
    for name in texture_names(block_id, properties):
        img = load_texture(zf, name)
        if img is not None:
            return img
    return from_model(zf, block_id)
