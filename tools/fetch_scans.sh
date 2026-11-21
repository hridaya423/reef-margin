#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/scans/soneva data/scans/galapagos data/scans/sketchfab web/public/scans
PY="uv run -q --with numpy --with scipy --with trimesh --with pillow --with requests python -I"

for s in hb_20260304 ootbm_20251007 ootbr_20260304 ootsl1_20260218 ootsr2_20260303 ootsr3_20260303; do
  out=web/public/scans/soneva_${s%_*}.splat
  [ -f "$out" ] && continue
  src=data/scans/soneva/$s.ply
  curl -sL -o "$src" "https://huggingface.co/datasets/wildflow/soneva-corals/resolve/main/maldives_soneva_$s/splats/ply/lod2.ply"
  $PY tools/splat_convert.py "$src" "$out"
  rm -f "$src"
done

for entry in espanola:61151118:94220748 darwin:0:61151118; do
  IFS=: read -r name start end <<<"$entry"
  out=web/public/scans/galapagos_$name.splat
  [ -f "$out" ] && continue
  $PY - "$name" "$start" "$end" <<'EOF'
import struct, sys, zlib, requests
name, start, end = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
url = "https://zenodo.org/api/records/14914807/files/FinalPointClouds.zip/content"
b = requests.get(url, headers={"Range": f"bytes={start}-{end - 1}"}, timeout=900).content
nl, el = struct.unpack("<HH", b[26:30])
open(f"data/scans/galapagos/{name}.ply", "wb").write(zlib.decompressobj(-15).decompress(b[30 + nl + el:]))
EOF
  $PY -c "import sys; sys.path.insert(0, 'tools'); import points_convert as p; p.convert('data/scans/galapagos/$name.ply', '$out')"
  rm -f "data/scans/galapagos/$name.ply"
done

if [ -z "${SKETCHFAB_TOKEN:-}" ]; then
  echo "Set SKETCHFAB_TOKEN to fetch the Sketchfab scans" >&2
  exit 0
fi
for pair in f67977f513e74259ae2b3a9b36965641:heron 8bc72c9e4575470ea30d1313e48b730c:belize 56296264dad244eab43874fe8f419f99:okinawa 3f67b6d2bc77407abe2b36f982c28370:maui 0d30ab66bd53405890d1f449c08227d8:mayotte c76bb390aa7d4c069a51257cb5f9cbdf:usvi2016 7a1ec7e990f54c028b10ef1fe714c0c6:whitsunday a4334470bf9047edad8358475f10ff18:onetree 2c33a8d8962646e4afd17bb9566d22b6:thailand; do
  uid=${pair%%:*}
  name=${pair##*:}
  out=web/public/scans/sf_$name.splat
  [ -f "$out" ] && continue
  url=$(curl -s -H "Authorization: Token $SKETCHFAB_TOKEN" "https://api.sketchfab.com/v3/models/$uid/download" | python3 -c "import json, sys; print(json.load(sys.stdin)['glb']['url'])")
  curl -sL -o "data/scans/sketchfab/$name.glb" "$url"
  $PY -c "import sys; sys.path.insert(0, 'tools'); import mesh_convert as m; m.convert('data/scans/sketchfab/$name.glb', '$out')"
  rm -f "data/scans/sketchfab/$name.glb"
done
