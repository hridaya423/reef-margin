"""Extract IMOS acoustic telemetry for the demo reefs into web/public/telemetry/<i>.json.

Source: IMOS Animal Tracking Facility, quality-controlled summarised detections (2007 - ongoing),
AODN cloud-optimised Parquet on public S3 (CC BY 4.0, no credentials):
  s3://aodn-cloud-optimised/animal_acoustic_tracking_delayed_summarised_detection_qc.parquet/

The dataset is partitioned by month (timestamp=) and by 10-degree box (polygon= as WKB hex).
Only the boxes that contain a demo reef are downloaded.

Usage:
  uv run --system-certs --no-project --with duckdb python scripts/imos_telemetry.py --data <download dir> [--inspect]
"""

import argparse
import hashlib
import json
import math
import struct
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BUCKET = "https://aodn-cloud-optimised.s3.ap-southeast-2.amazonaws.com"
PREFIX = "animal_acoustic_tracking_delayed_summarised_detection_qc.parquet/"
NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

# Reef cells from the live model's /layer (index i), named demo reefs.
REEFS = [
    {"i": 442, "name": "Heron Island", "lat": -23.44, "lon": 151.91},
    {"i": 4313, "name": "Lizard Island", "lat": -14.67, "lon": 145.45},
    {"i": 2342, "name": "Orpheus Island", "lat": -18.61, "lon": 146.49},
    {"i": 812, "name": "Ningaloo (Exmouth)", "lat": -21.9, "lon": 113.95},
]
RADIUS_KM = 15.0


def list_keys():
    keys, token = [], None
    while True:
        q = {"list-type": "2", "prefix": PREFIX, "max-keys": "1000"}
        if token:
            q["continuation-token"] = token
        with urllib.request.urlopen(f"{BUCKET}/?{urllib.parse.urlencode(q)}", timeout=60) as r:
            root = ET.fromstring(r.read())
        keys += [c.find("s3:Key", NS).text for c in root.findall("s3:Contents", NS)]
        nxt = root.find("s3:NextContinuationToken", NS)
        if nxt is None:
            return keys
        token = nxt.text


def box_of(key):
    """Bounding box (lon0, lat0, lon1, lat1) of the polygon= partition, decoded from WKB hex."""
    part = next((p for p in key.split("/") if p.startswith("polygon=")), None)
    if part is None:
        return None
    raw = bytes.fromhex(part[len("polygon="):])
    n = struct.unpack_from("<I", raw, 9)[0]
    pts = [struct.unpack_from("<dd", raw, 13 + 16 * k) for k in range(n)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def km(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(a))


def download(keys, data):
    def get(key):
        # Partition paths exceed Windows' 260-character limit, so name files by a hash of the key.
        dest = data / f"{hashlib.sha1(key.encode()).hexdigest()[:20]}.parquet"
        if dest.exists():
            return dest
        for attempt in range(5):
            try:
                with urllib.request.urlopen(f"{BUCKET}/{urllib.parse.quote(key)}", timeout=120) as r:
                    dest.write_bytes(r.read())
                return dest
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(2 * (attempt + 1))

    with ThreadPoolExecutor(4) as ex:
        return list(ex.map(get, keys))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path, help="empty directory for downloaded Parquet files")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "web" / "public" / "telemetry")
    ap.add_argument("--inspect", action="store_true")
    a = ap.parse_args()
    a.data.mkdir(parents=True, exist_ok=True)

    keys = [k for k in list_keys() if k.endswith(".parquet")]
    boxes = {k: box_of(k) for k in keys}
    want = [k for k, b in boxes.items() if b and any(b[0] <= r["lon"] <= b[2] and b[1] <= r["lat"] <= b[3] for r in REEFS)]
    print(f"files listed {len(keys)}, in demo-reef boxes {len(want)}")
    files = download(want, a.data)

    import duckdb

    con = duckdb.connect()
    src = f"read_parquet('{a.data.as_posix()}/*.parquet', union_by_name=true)"
    cols = con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()
    if a.inspect:
        for c in cols:
            print(" ", c[0], c[1])
        print(con.execute(f"SELECT * FROM {src} LIMIT 3").df().T.to_string())
        return

    names = {c[0] for c in cols}

    def pick(*cands):
        for c in cands:
            if c in names:
                return c
        raise SystemExit(f"none of {cands} in columns: {sorted(names)}")

    LAT = pick("receiver_deployment_latitude", "latitude", "station_latitude")
    LON = pick("receiver_deployment_longitude", "longitude", "station_longitude")
    STA = pick("station_name", "installation_name")
    ANI = pick("transmitter_id", "tag_id", "animal_id")
    COM = pick("common_name", "species_common_name")
    SCI = pick("species_scientific_name", "scientific_name")
    DAY = pick("date_hour_UTC", "date", "detection_date", "first_detection_datetime", "timestamp")
    NDET = next((c for c in ("nb_detections", "detection_count", "number_of_detections", "detections") if c in names), None)

    con.execute(f"CREATE TABLE d AS SELECT {LAT} AS lat, {LON} AS lon, {STA} AS station, {ANI} AS animal, {COM} AS common, {SCI} AS sci, CAST({DAY} AS DATE) AS day, {NDET or 1} AS n FROM {src}")
    a.out.mkdir(parents=True, exist_ok=True)

    for r in REEFS:
        # Same haversine as km(), in SQL so DuckDB does not call back into Python per row.
        def dist(la, lo, r=r):
            return (f"12742 * asin(sqrt(pow(sin(radians({la} - {r['lat']}) / 2), 2) + cos(radians({r['lat']})) * cos(radians({la}))"
                    f" * pow(sin(radians({lo} - {r['lon']}) / 2), 2)))")
        near = f"SELECT * FROM d WHERE lat IS NOT NULL AND {dist('lat', 'lon')} <= {RADIUS_KM}"
        stations = con.execute(f"SELECT station, avg(lat), avg(lon), count(DISTINCT animal), sum(n), min(day), max(day) FROM ({near}) GROUP BY station ORDER BY 4 DESC").fetchall()
        species = con.execute(f"SELECT common, sci, count(DISTINCT animal), count(DISTINCT day), min(day), max(day) FROM ({near}) GROUP BY common, sci ORDER BY 3 DESC, 4 DESC").fetchall()
        # Where else the animals detected here were heard: the reef's movement links.
        links = con.execute(
            f"""SELECT o.station, avg(o.lat), avg(o.lon), count(DISTINCT o.animal), list(DISTINCT o.common)
                FROM d o WHERE o.animal IN (SELECT DISTINCT animal FROM ({near}))
                AND o.lat IS NOT NULL AND {dist('o.lat', 'o.lon')} > {RADIUS_KM}
                GROUP BY o.station ORDER BY 4 DESC LIMIT 25"""
        ).fetchall()
        out = {
            "reef": r,
            "radius_km": RADIUS_KM,
            "source": "IMOS Animal Tracking Facility, quality-controlled summarised acoustic detections (2007 - ongoing), AODN, CC BY 4.0",
            "stations": [{"name": s, "lat": round(la, 4), "lon": round(lo, 4), "animals": na, "detections": int(nd), "first": str(f), "last": str(l)} for s, la, lo, na, nd, f, l in stations],
            "species": [{"common": c, "scientific": s, "animals": na, "days": nd, "first": str(f), "last": str(l)} for c, s, na, nd, f, l in species],
            "links": [{"station": s, "lat": round(la, 4), "lon": round(lo, 4), "km": round(km(r["lat"], r["lon"], la, lo)), "animals": na, "species": sorted(x for x in sp if x)} for s, la, lo, na, sp in links],
        }
        (a.out / f"{r['i']}.json").write_text(json.dumps(out, indent=1))
        print(f"{r['name']}: {len(stations)} receivers, {len(species)} species, {sum(s['animals'] for s in out['species'])} animal-species, {len(links)} linked stations")


if __name__ == "__main__":
    main()
