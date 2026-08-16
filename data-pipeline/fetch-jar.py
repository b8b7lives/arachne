"""Fetch a Minecraft client jar and its version json into the analysis
jar cache, sha1-verified against the Mojang manifest.

    uv run fetch-jar.py <version> [dest_dir]

Default dest is analysis/mapartcraft/26x-data, where build-blocks.py
and build-atlas.py expect jars. MC_MANIFEST_URL overrides the manifest
for tests. minecraft#17.
"""

import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DEST = HERE / "../../analysis/mapartcraft/26x-data"
MANIFEST = os.environ.get(
    "MC_MANIFEST_URL",
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
)


def fetch_json(url):
    with urllib.request.urlopen(url) as r:
        return json.load(r)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    version = sys.argv[1]
    dest = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DEST
    dest.mkdir(parents=True, exist_ok=True)

    manifest = fetch_json(MANIFEST)
    entry = next((v for v in manifest["versions"] if v["id"] == version), None)
    if entry is None:
        sys.exit(f"unknown version: {version}")

    vdoc = fetch_json(entry["url"])
    client = vdoc["downloads"]["client"]

    jar_path = dest / f"minecraft-{version}-client.jar"
    json_path = dest / f"minecraft-{version}.json"
    with urllib.request.urlopen(client["url"]) as r:
        blob = r.read()
    digest = hashlib.sha1(blob).hexdigest()
    if digest != client["sha1"]:
        sys.exit(f"sha1 mismatch: got {digest}, manifest says {client['sha1']}")
    jar_path.write_bytes(blob)
    json_path.write_text(json.dumps(vdoc, indent=1))
    print(f"{jar_path} ({len(blob)} bytes, sha1 verified)")
    print(f"{json_path}")


if __name__ == "__main__":
    main()
