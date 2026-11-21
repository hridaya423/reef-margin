import csv
import json
import subprocess
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BASE = "https://cumulus-ags.tnc.org/arcgis/rest/services/nascience/Mapping_Ocean_Wealth/MapServer"
OUT = Path(__file__).resolve().parent.parent / "data" / "impact" / "tnc_mow"
PAGE = 2000

LAYERS = {
    "reef_tourism_usd": (314, ["Val_per_km2", "sq_km", "Total_Val", "Jurisdiction"], 0.005),
    "people_protected_per_km": (11, ["grid_code"], 0),
    "flood_benefit_segments": (22, ["E2E1_DIF_ANN_PF", "E2E1_DIF_ANN_BCF", "E2E1_DIF_100RP_PF", "COUNTRY", "SHORE_ID"], 0.05),
    "reef_fisheries_catch": (36, ["Catch", "MMSYV1", "Pop45km", "ISO", "Region"], 0),
}


def get(layer, params):
    url = f"{BASE}/{layer}/query?" + urllib.parse.urlencode(params)
    out = subprocess.run(["curl", "-sL", "-m", "120", "--retry", "3", url], capture_output=True, text=True).stdout
    return json.loads(out)


def centre(geom):
    if "x" in geom:
        return geom["x"], geom["y"]
    parts = geom.get("rings") or geom.get("paths")
    pts = [p for part in parts for p in part]
    return sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)


def page(layer, fields, offset, simplify):
    d = get(layer, {"where": "1=1", "outFields": ",".join(fields), "outSR": 4326, "returnGeometry": "true",
                    "geometryPrecision": 4, "maxAllowableOffset": simplify, "orderByFields": "OBJECTID",
                    "resultOffset": offset, "resultRecordCount": PAGE, "f": "json"})
    rows = []
    for f in d["features"]:
        x, y = centre(f["geometry"])
        rows.append([round(x, 4), round(y, 4)] + [f["attributes"][k] for k in fields])
    return rows


def run(name):
    layer, fields, simplify = LAYERS[name]
    n = get(layer, {"where": "1=1", "returnCountOnly": "true", "f": "json"})["count"]
    offsets = list(range(0, n, PAGE))
    with ThreadPoolExecutor(8) as ex:
        pages = list(ex.map(lambda o: page(layer, fields, o, simplify), offsets))
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.csv"
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["lon", "lat"] + fields)
        for p in pages:
            w.writerows(p)
    rows = sum(len(p) for p in pages)
    print(name, "layer", layer, "expected", n, "rows", rows, path.stat().st_size, "bytes")


if __name__ == "__main__":
    for name in sys.argv[1:] or list(LAYERS):
        run(name)
