import base64
import json
import os

import numpy as np
import pandas as pd
import requests
from scipy.spatial import cKDTree

API = os.environ.get("REEF_API", "https://hridayahoney--reef-response-api-web.us-east.modal.run")
ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "data/impact/tnc_mow")
RADIUS_KM = 25
EARTH_KM = 6371.0088


def unit(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1)


def near(tree, centres):
    chord = 2 * np.sin(RADIUS_KM / EARTH_KM / 2)
    return tree.query_ball_point(centres, chord)


def main():
    reefs = requests.get(f"{API}/layer", timeout=120).json()["reefs"]
    y = requests.get(f"{API}/years", timeout=120).json()
    counts = np.frombuffer(base64.b64decode(y["counts"]), np.uint8).reshape(len(y["shifts"]), y["n"])
    s = {v: k for k, v in enumerate(y["shifts"])}
    centres = unit(np.array([r["lat"] for r in reefs]), np.array([r["lon"] for r in reefs]))

    tourism = pd.read_csv(os.path.join(SRC, "reef_tourism_usd.csv"))
    flood = pd.read_csv(os.path.join(SRC, "people_protected_per_km.csv"))
    out = {"radius_km": RADIUS_KM}
    hits = {}
    for key, df, col, step in (("tourism", tourism, "Total_Val", 1000), ("flood", flood, "grid_code", 10)):
        vals = df[col].clip(lower=0).to_numpy()
        idx = near(cKDTree(unit(df.lat.to_numpy(), df.lon.to_numpy())), centres)
        hits[key] = (idx, vals)
        out[key] = [int(round(vals[i].sum() / step) * step) for i in idx]

    fails_2040 = counts[s[0.5]] > 2
    held_2040 = fails_2040 & (counts[s[0.0]] <= 2)
    for key, (idx, vals) in hits.items():
        for label, mask in (("all", np.ones(len(reefs), bool)), ("today's coral fails by 2040", fails_2040), ("held by coral bred +0.5 C", held_2040)):
            seen = set()
            for k in np.flatnonzero(mask):
                seen.update(idx[k])
            print(f"{key} near {label} ({mask.sum()} reefs): {vals[list(seen)].sum():,.0f}")
    for name, i in (("spermonde", 6426), ("okinawa", 17268), ("heron", 442), ("looe", 16175), ("moorea", 3005)):
        print(name, out["tourism"][i], out["flood"][i])
    json.dump(out, open(os.path.join(ROOT, "web/public/data/impact.json"), "w"), separators=(",", ":"))


if __name__ == "__main__":
    main()
