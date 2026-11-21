import base64
import json
import time
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

API = "https://hridayahoney--reef-response-api-web.us-east.modal.run"
URL = (
    "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/GHSL/GHS_POP_GLOBE_R2023A/"
    "GHS_POP_E2020_GLOBE_R2023A_4326_30ss/V1-0/GHS_POP_E2020_GLOBE_R2023A_4326_30ss_V1_0.zip"
)
RADIUS_KM = 50
EARTH_KM = 6371.0088
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "people"
OUT = ROOT / "web" / "public" / "data" / "people.json"
ZIP = DATA / URL.rsplit("/", 1)[1]
TIF = DATA / (ZIP.stem + ".tif")


def get_json(path):
    with urllib.request.urlopen(API + path, timeout=120) as r:
        return json.load(r)


def fetch_raster():
    DATA.mkdir(parents=True, exist_ok=True)
    if not ZIP.exists():
        urllib.request.urlretrieve(URL, ZIP)
    if not TIF.exists():
        with zipfile.ZipFile(ZIP) as z:
            z.extract(TIF.name, DATA)


def load_band(lat_min, lat_max):
    with rasterio.open(TIF) as src:
        t = src.transform
        r0 = max(0, int((t.f - lat_max) / -t.e) - 1)
        r1 = min(src.height, int((t.f - lat_min) / -t.e) + 2)
        band = np.empty((r1 - r0, src.width), dtype=np.float32)
        for a in range(r0, r1, 512):
            b = min(a + 512, r1)
            blk = src.read(1, window=Window(0, a, src.width, b - a))
            blk[~np.isfinite(blk) | (blk < 0)] = 0
            band[a - r0 : b - r0] = blk
    lats = t.f + (np.arange(r0, r1) + 0.5) * t.e
    return band, lats, t.c, t.a


def reef_windows(lats, lons, band_lats, width, lon0, dx):
    dlat = np.degrees(RADIUS_KM / EARTH_KM) * 1.02
    h_max = np.sin(RADIUS_KM / (2 * EARTH_KM)) ** 2
    top = band_lats[0]
    dy = band_lats[0] - band_lats[1]
    H, W = len(band_lats), width
    lat_rad = np.radians(band_lats)
    cos_lat = np.cos(np.radians(band_lats))
    for k in range(len(lats)):
        la, lo = lats[k], lons[k]
        i0 = max(0, int((top - (la + dlat)) / dy))
        i1 = min(H, int((top - (la - dlat)) / dy) + 2)
        if i1 <= i0:
            continue
        cl = cos_lat[i0:i1]
        dlon = dlat / max(cl.min(), 1e-3)
        cla = np.cos(np.radians(la))
        hlat = np.sin((lat_rad[i0:i1] - np.radians(la)) / 2) ** 2
        for shift in (-360.0, 0.0, 360.0):
            c = lo + shift
            j0 = int(np.floor((c - dlon - lon0) / dx))
            j1 = int(np.ceil((c + dlon - lon0) / dx)) + 1
            j0, j1 = max(0, j0), min(W, j1)
            if j1 <= j0:
                continue
            lon_c = lon0 + (np.arange(j0, j1) + 0.5) * dx
            hlon = np.sin(np.radians(lon_c - c) / 2) ** 2
            h = hlat[:, None] + (cl * cla)[:, None] * hlon[None, :]
            yield k, i0, i1, j0, j1, h <= h_max


def triage(counts, shifts):
    ix = {round(s, 2): i for i, s in enumerate(shifts)}
    c = lambda s: counts[ix[s]] > 2
    return {
        "savable_0": c(0.0) & ~c(-0.5),
        "beyond_0": c(0.0) & c(-0.5),
        "savable_plus": c(0.5) & ~c(0.0),
        "beyond_plus": c(0.5) & c(0.0),
    }


def main():
    t0 = time.time()
    fetch_raster()
    reefs = get_json("/layer")["reefs"]
    reefs.sort(key=lambda r: r["i"])
    assert [r["i"] for r in reefs] == list(range(len(reefs)))
    lats = np.array([r["lat"] for r in reefs])
    lons = np.array([r["lon"] for r in reefs])
    n = len(reefs)

    yrs = get_json("/years")
    shifts = yrs["shifts"]
    counts = np.frombuffer(base64.b64decode(yrs["counts"]), dtype=np.uint8)
    assert counts.size == len(shifts) * yrs["n"] and yrs["n"] == n
    counts = counts.reshape(len(shifts), n)
    groups = triage(counts, shifts)
    print("counts shape", counts.shape, "max", counts.max(), "monotone in shift:", bool((np.diff(counts.astype(int), axis=0) >= 0).all()))
    print("group sizes", {k: int(v.sum()) for k, v in groups.items()})

    band, band_lats, lon0, dx = load_band(lats.min() - 1, lats.max() + 1)
    print("band", band.shape, f"{time.time() - t0:.0f}s")

    masks = {"all": np.zeros(band.shape, dtype=bool)}
    masks.update({k: np.zeros(band.shape, dtype=bool) for k in groups})
    pop = np.zeros(n)
    for k, i0, i1, j0, j1, within in reef_windows(lats, lons, band_lats, band.shape[1], lon0, dx):
        pop[k] += band[i0:i1, j0:j1][within].sum(dtype=np.float64)
        masks["all"][i0:i1, j0:j1] |= within
        for g, sel in groups.items():
            if sel[k]:
                masks[g][i0:i1, j0:j1] |= within

    rounded = (np.round(pop / 100) * 100).astype(np.int64)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"radius_km": RADIUS_KM, "pop": rounded.tolist()}, separators=(",", ":")))

    print("per-reef median", np.median(pop), "p90", np.percentile(pop, 90), "mean", pop.mean(), "max", pop.max())
    print("rounded median", np.median(rounded), "p90", np.percentile(rounded, 90))
    print("reefs with zero people", int((rounded == 0).sum()))
    for g, m in masks.items():
        print("dedup total", g, int(band[m].sum(dtype=np.float64)))
    print("global raster total check (band)", int(band.sum(dtype=np.float64)))
    print(f"runtime {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
