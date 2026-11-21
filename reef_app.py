import modal

app = modal.App("reef-response")
vol = modal.Volume.from_name("reef-data", create_if_missing=True)

cpu_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "numpy==2.1.3",
    "pandas==2.2.3",
    "pyarrow==18.1.0",
    "scikit-learn==1.5.2",
    "lightgbm==4.5.0",
    "h5py==3.12.1",
    "requests==2.32.3",
    "scipy==1.14.1",
)

BASE = "https://www.star.nesdis.noaa.gov/pub/sod/mecb/crw/data/5km/v3.1_op"
GCBD_URL = "https://datadocs.bco-dmo.org/file/B11vA82u7y2Owp/global_bleaching_environmental.csv"
CLIM_URL = f"{BASE}/climatology/nc/ct5km_climatology_v3.1.nc"
UA = {"User-Agent": "Mozilla/5.0"}
HINT = {"sst": "sst", "dhw": "heating"}
LAST_DAY = (2026, 11, 15)
MISSING = -32768
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]


def day_url(kind, day):
    ymd = day.strftime("%Y%m%d")
    if kind == "sst":
        return f"{BASE}/nc/v1.0/daily/sst/{day.year}/coraltemp_v3.1_{ymd}.nc"
    return f"{BASE}/nc/v1.0/daily/dhw/{day.year}/ct5km_dhw_v3.1_{ymd}.nc"


def pick(f, hint):
    import h5py

    names = [k for k in f.keys() if isinstance(f[k], h5py.Dataset) and f[k].ndim >= 2 and hint in k.lower() and "mask" not in k.lower()]
    if len(names) != 1:
        raise KeyError(f"hint {hint!r} matched {names} among {list(f.keys())}")
    return f[names[0]]


def decode(d, raw):
    import numpy as np

    scale = float(np.ravel(d.attrs.get("scale_factor", 1.0))[0])
    offset = float(np.ravel(d.attrs.get("add_offset", 0.0))[0])
    vals = raw.astype("float32") * scale + offset
    if "_FillValue" in d.attrs:
        vals[raw == np.ravel(d.attrs["_FillValue"])[0]] = np.nan
    return vals


def read_grid(content, hint):
    import io

    import h5py
    import numpy as np

    with h5py.File(io.BytesIO(content), "r") as f:
        d = pick(f, hint)
        raw = d[...]
        raw = raw.reshape(raw.shape[-2:])
        return decode(d, raw), np.asarray(f["lat"][...], dtype="float64"), np.asarray(f["lon"][...], dtype="float64")


def read_points(content, hint, il, jl):
    import io

    import h5py
    import numpy as np

    with h5py.File(io.BytesIO(content), "r") as f:
        d = pick(f, hint)
        lat = f["lat"][...]
        rows = il if lat[0] < lat[-1] else len(lat) - 1 - il
        raw = d[...]
        raw = raw.reshape(raw.shape[-2:])[rows, jl]
        vals = decode(d, raw)
    out = np.full(vals.shape, MISSING, dtype="int16")
    ok = np.isfinite(vals)
    out[ok] = np.rint(vals[ok] * 100).astype("int16")
    return out


def auc_rows(y, score, regions):
    import numpy as np
    from sklearn.metrics import average_precision_score, roc_auc_score

    per = []
    for r in np.unique(regions):
        m = regions == r
        if m.sum() >= 30 and 0 < y[m].sum() < m.sum():
            per.append(roc_auc_score(y[m], score[m]))
    return {
        "n": int(len(y)),
        "pos_rate": round(float(y.mean()), 3),
        "auroc": round(float(roc_auc_score(y, score)), 4),
        "auprc": round(float(average_precision_score(y, score)), 4),
        "region_macro_auroc": round(float(np.mean(per)), 4) if per else None,
        "regions_scored": len(per),
    }


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=1800, memory=8192)
def prep():
    import datetime as dt
    import io
    import os

    import h5py
    import numpy as np
    import pandas as pd
    import requests

    os.makedirs("/data/shards", exist_ok=True)
    raw_csv = requests.get(GCBD_URL, timeout=600, headers=UA).content
    with open("/data/gcbd.csv", "wb") as fh:
        fh.write(raw_csv)
    df = pd.read_csv(io.BytesIO(raw_csv), na_values=["nd"], low_memory=False)
    for c in ["Latitude_Degrees", "Longitude_Degrees", "Depth_m", "Percent_Bleaching", "TSA_DHW"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df["date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Percent_Bleaching", "Latitude_Degrees", "Longitude_Degrees", "date"])
    g = df.groupby(["Site_ID", "date"], as_index=False).agg(
        lat=("Latitude_Degrees", "mean"),
        lon=("Longitude_Degrees", "mean"),
        depth_m=("Depth_m", "mean"),
        pct=("Percent_Bleaching", "mean"),
        tsa_dhw=("TSA_DHW", "mean"),
        source=("Data_Source", "first"),
        realm=("Realm_Name", "first"),
        ecoregion=("Ecoregion_Name", "first"),
        country=("Country_Name", "first"),
    )
    g = g[(g.date >= "1988-01-01") & (g.date <= "2020-12-31")].reset_index(drop=True)
    g["y_mod"] = (g.pct >= 10).astype("int8")
    g["y_sev"] = (g.pct >= 50).astype("int8")
    year = g.date.dt.year
    g["split"] = np.where(year <= 2013, "train", np.where(year <= 2015, "val", "test"))
    print("pct range", float(g.pct.min()), float(g.pct.max()), "surveys", len(g), "sites", g.Site_ID.nunique())

    sample_day = dt.date(2020, 1, 1)
    sst_bytes = requests.get(day_url("sst", sample_day), timeout=600).content
    dhw_bytes = requests.get(day_url("dhw", sample_day), timeout=600).content
    clim_bytes = requests.get(CLIM_URL, timeout=900).content
    for label, content in [("sst", sst_bytes), ("dhw", dhw_bytes), ("clim", clim_bytes)]:
        with h5py.File(io.BytesIO(content), "r") as f:
            print(label, {k: (f[k].shape, str(f[k].dtype), {a: str(v)[:40] for a, v in f[k].attrs.items() if a in ("scale_factor", "add_offset", "_FillValue", "units")}) for k in f.keys() if isinstance(f[k], h5py.Dataset)})

    sst_grid, lat, lon = read_grid(sst_bytes, HINT["sst"])
    ocean = np.isfinite(sst_grid)
    nlat, nlon = ocean.shape
    dlat, dlon = lat[1] - lat[0], lon[1] - lon[0]
    print("grid", ocean.shape, "lat0", lat[0], "dlat", dlat, "lon0", lon[0], "dlon", dlon, "ocean frac", round(float(ocean.mean()), 3))
    il = np.clip(np.rint((g.lat.values - lat[0]) / dlat).astype(int), 0, nlat - 1)
    jl = np.rint((g.lon.values - lon[0]) / dlon).astype(int) % nlon

    snapped = {}
    for i, j in set(zip(il.tolist(), jl.tolist())):
        if ocean[i, j]:
            snapped[(i, j)] = (i, j)
            continue
        best = None
        for di in range(-2, 3):
            for dj in range(-2, 3):
                a, b = i + di, (j + dj) % nlon
                if 0 <= a < nlat and ocean[a, b]:
                    dist = di * di + dj * dj
                    if best is None or dist < best[0]:
                        best = (dist, a, b)
        snapped[(i, j)] = (best[1], best[2]) if best else None
    keep = np.array([snapped[(i, j)] is not None for i, j in zip(il, jl)])
    print("surveys dropped as land", int((~keep).sum()), "snapped", sum(1 for k, v in snapped.items() if v is not None and v != k))
    g = g[keep].reset_index(drop=True)
    pairs = np.array([snapped[(i, j)] for i, j in zip(il[keep], jl[keep])])
    si, sj = pairs[:, 0], pairs[:, 1]

    keys = set()
    for i, j in set(zip(si.tolist(), sj.tolist())):
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                a, b = i + di, (j + dj) % nlon
                if 0 <= a < nlat and ocean[a, b]:
                    keys.add(a * nlon + b)
    keys = np.array(sorted(keys))
    ci, cj = keys // nlon, keys % nlon
    g["cell_id"] = np.searchsorted(keys, si * nlon + sj)
    labelled = np.zeros(len(keys), dtype=bool)
    labelled[g.cell_id.values] = True

    cells = pd.DataFrame({"cell_id": np.arange(len(keys)), "i_lat": ci, "j_lon": cj, "lat_c": lat[ci], "lon_c": lon[cj], "is_labelled": labelled})
    with h5py.File(io.BytesIO(clim_bytes), "r") as f:
        d = pick(f, "mmm")
        cells["mmm"] = decode(d, d[...].reshape(d.shape[-2:])[ci, cj])
        for m, name in enumerate(MONTHS, start=1):
            d = pick(f, name)
            cells[f"clim_{m:02d}"] = decode(d, d[...].reshape(d.shape[-2:])[ci, cj])
    print("cells", len(cells), "labelled", int(labelled.sum()), "mmm missing", int(cells.mmm.isna().sum()))

    cells.to_parquet("/data/cells.parquet")
    g.to_parquet("/data/surveys.parquet")
    np.save("/data/cell_idx.npy", np.stack([ci, cj], axis=1).astype("int32"))

    print(g.groupby("split").agg(n=("pct", "size"), mod=("y_mod", "mean"), sev=("y_sev", "mean"), sites=("Site_ID", "nunique")).round(3).to_string())
    print(g.groupby(["realm", "split"]).size().unstack(fill_value=0).to_string())
    test = g[(g.split == "test") & g.tsa_dhw.notna()]
    reg = test.ecoregion.fillna("NA").values
    for target in ["y_mod", "y_sev"]:
        print("PROVISIONAL benchmark (database DHW column), test split,", target, auc_rows(test[target].values, test.tsa_dhw.values, reg))
    for thr, target in [(4, "y_mod"), (8, "y_sev")]:
        pred = test.tsa_dhw.values >= thr
        y = test[target].values == 1
        tp = int((pred & y).sum())
        print(f"PROVISIONAL rule DHW>={thr} for {target}: precision {tp / max(int(pred.sum()), 1):.3f} recall {tp / max(int(y.sum()), 1):.3f} alerts {int(pred.sum())}")
    vol.commit()


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=4, memory=4096, max_containers=10, retries=1)
def extract_year(year: int, kind: str):
    import datetime as dt
    import os
    import time
    from concurrent.futures import ThreadPoolExecutor

    import numpy as np
    import requests

    out = f"/data/shards/{kind}_{year}.npy"
    vol.reload()
    if os.path.exists(out):
        return (kind, year, "exists", 0, 0.0)
    idx = np.load("/data/cell_idx.npy")
    il, jl = idx[:, 0], idx[:, 1]
    start, end = dt.date(year, 1, 1), min(dt.date(year, 12, 31), dt.date(*LAST_DAY))
    days = [start + dt.timedelta(d) for d in range((end - start).days + 1)]
    t0 = time.time()

    def one(day):
        for attempt in range(4):
            try:
                r = requests.get(day_url(kind, day), timeout=180)
                if r.status_code == 404:
                    return None
                r.raise_for_status()
                return read_points(r.content, HINT[kind], il, jl)
            except Exception:
                time.sleep(2**attempt)
        return None

    with ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(one, days))
    arr = np.full((len(days), len(il)), MISSING, dtype="int16")
    failed = 0
    for k, row in enumerate(rows):
        if row is None:
            failed += 1
        else:
            arr[k] = row
    os.makedirs("/data/shards", exist_ok=True)
    np.save(out, arr)
    vol.commit()
    return (kind, year, "done", failed, round(time.time() - t0, 1))


@app.local_entrypoint()
def main(stage: str = "prep", years: str = "", kinds: str = "dhw,sst", steps: int = 60000, inits: str = "scratch,pre_2013", seeds: int = 3):
    if stage == "prep":
        prep.remote()
    elif stage == "features":
        build_features.remote()
    elif stage == "trees":
        train_trees.remote()
    elif stage == "reextract":
        extract_all.remote(kinds)
    elif stage == "export":
        export_serving.remote()
    elif stage == "pipeline":
        print(pipeline.remote(seeds, steps))
    elif stage == "smoke":
        smoke.remote()
    elif stage == "corpus":
        build_corpus.remote()
    elif stage == "pretrain":
        calls = [pretrain.spawn("pre_2013", CUTOFF_2013, steps), pretrain.spawn("pre_full", 10**6, steps)]
        for c in calls:
            print(c.get())
    elif stage == "finetune":
        calls = [finetune.spawn(i, s) for i in inits.split(",") for s in range(seeds)]
        for c in calls:
            print(c.get())
    elif stage == "extract":
        ys = [int(y) for y in years.split(",")] if years else list(range(1985, LAST_DAY[0] + 1))
        calls = [extract_year.spawn(y, k) for k in kinds.split(",") for y in ys]
        for c in calls:
            print(c.get())


def load_kind(kind):
    import numpy as np

    parts = [np.load(f"/data/shards/{kind}_{y}.npy") for y in range(1985, LAST_DAY[0] + 1)]
    arr = np.concatenate(parts, axis=0).astype("float32")
    arr[arr == MISSING] = np.nan
    return arr / 100.0


def ffill_rows(a):
    import pandas as pd

    return pd.DataFrame(a).ffill(axis=1).bfill(axis=1).to_numpy(dtype="float32")


def site_weights(sites, rng):
    import numpy as np

    codes, inv = np.unique(sites, return_inverse=True)
    counts = rng.multinomial(len(codes), np.full(len(codes), 1 / len(codes)))
    return counts[inv].astype("float64")


def macro_auc(y, p, regions, w=None):
    import numpy as np
    from sklearn.metrics import roc_auc_score

    out = []
    for r in np.unique(regions):
        m = regions == r
        if w is not None:
            m = m & (w > 0)
        yy = y[m]
        if m.sum() >= 30 and 0 < yy.sum() < len(yy):
            out.append(roc_auc_score(yy, p[m], sample_weight=None if w is None else w[m]))
    return float(np.mean(out)) if out else float("nan")


def compare(y, p_model, p_base, regions, sites, n_boot=1000, seed=0):
    import numpy as np
    from sklearn.metrics import average_precision_score, roc_auc_score

    rng = np.random.default_rng(seed)
    res = {
        "n": int(len(y)),
        "positives": int(y.sum()),
        "model_auroc": float(roc_auc_score(y, p_model)),
        "base_auroc": float(roc_auc_score(y, p_base)),
        "model_auprc": float(average_precision_score(y, p_model)),
        "base_auprc": float(average_precision_score(y, p_base)),
        "model_macro": macro_auc(y, p_model, regions),
        "base_macro": macro_auc(y, p_base, regions),
    }
    pooled, macro = [], []
    for _ in range(n_boot):
        w = site_weights(sites, rng)
        k = w > 0
        if 0 < y[k].sum() < k.sum():
            pooled.append(roc_auc_score(y[k], p_model[k], sample_weight=w[k]) - roc_auc_score(y[k], p_base[k], sample_weight=w[k]))
            macro.append(macro_auc(y, p_model, regions, w) - macro_auc(y, p_base, regions, w))
    pooled, macro = np.array(pooled), np.array(macro)
    macro = macro[np.isfinite(macro)]
    res["diff_auroc_ci"] = [float(np.percentile(pooled, 2.5)), float(np.percentile(pooled, 97.5))]
    res["diff_macro_ci"] = [float(np.percentile(macro, 2.5)), float(np.percentile(macro, 97.5))]
    res["beats_noaa"] = bool(res["diff_auroc_ci"][0] > 0 and res["diff_macro_ci"][0] > 0)
    return {k: (round(v, 4) if isinstance(v, float) else v) for k, v in res.items()}


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=8, memory=49152)
def build_features():
    import datetime as dt

    import numpy as np
    import pandas as pd

    vol.reload()
    cells = pd.read_parquet("/data/cells.parquet")
    s = pd.read_parquet("/data/surveys.parquet").reset_index(drop=True)
    sst = load_kind("sst")
    noaa = load_kind("dhw")
    n_days, n_cells = sst.shape
    base = dt.date(1985, 1, 1)
    dates = pd.date_range(base, periods=n_days, freq="D")
    month = dates.month.values

    clim_mask = dates.year.values <= 2012
    clim = np.stack([np.nanmean(sst[clim_mask & (month == m)], axis=0) for m in range(1, 13)])
    mmm = np.nanmax(clim, axis=0)
    warm_month = np.nanargmax(np.nan_to_num(clim, nan=-99), axis=0) + 1
    print("own mmm vs NOAA mmm, median abs diff", float(np.nanmedian(np.abs(mmm - cells.mmm.values))))

    t = (s.date.dt.date.map(lambda d: (d - base).days)).values.astype(int)
    c = s.cell_id.values
    ok = (t >= 1095) & (t < n_days) & np.isfinite(mmm[c])
    s, t, c = s[ok].reset_index(drop=True), t[ok], c[ok]
    print("surveys with full window", len(s))

    off = np.arange(-1095, 1)
    win = ffill_rows(sst[t[:, None] + off[None, :], c[:, None]])
    m0 = mmm[c][:, None]
    hs = np.clip(win - m0, 0, None)
    mon = month[t[:, None] + off[None, :]]
    anom = win - clim[mon - 1, c[:, None]]

    f = {}
    for weeks in (4, 8, 12, 16, 24):
        for thr in (0, 1):
            f[f"acc_{weeks}w_t{thr}"] = np.where(hs[:, -weeks * 7 :] >= thr, hs[:, -weeks * 7 :], 0).sum(1) / 7
    for d in (30, 90):
        f[f"hs_max_{d}"] = hs[:, -d:].max(1)
        f[f"anom_mean_{d}"] = anom[:, -d:].mean(1)
        f[f"diff_std_{d}"] = np.diff(win[:, -d:], axis=1).std(1)
    for d in (7, 30, 90):
        f[f"sst_minus_mmm_{d}"] = (win[:, -d:] - m0).mean(1)
    for d in (30, 60):
        x = np.arange(d) - (d - 1) / 2
        f[f"slope_{d}"] = ((win[:, -d:] - win[:, -d:].mean(1, keepdims=True)) * x).sum(1) / (x**2).sum()
    for d in (90, 365):
        f[f"days_above_{d}"] = (win[:, -d:] > m0).sum(1)

    cs = np.cumsum(np.where(hs >= 1, hs, 0), axis=1)
    dhw_series = np.full_like(cs, np.nan)
    dhw_series[:, 84:] = (cs[:, 84:] - cs[:, :-84]) / 7
    prior = dhw_series[:, 84:916]
    f["prior_peak_dhw"] = np.nanmax(prior, axis=1)
    f["peak_dhw_y1"] = np.nanmax(dhw_series[:, 551:916], axis=1)
    f["peak_dhw_y2"] = np.nanmax(dhw_series[:, 186:551], axis=1)
    f["prior_years_dhw4"] = (f["peak_dhw_y1"] >= 4).astype(int) + (f["peak_dhw_y2"] >= 4).astype(int)
    hit = prior >= 4
    last = np.where(hit.any(1), hit.shape[1] - 1 - np.argmax(hit[:, ::-1], axis=1), -1)
    f["days_since_dhw4"] = np.where(last >= 0, (915 - (84 + last)) + 180, 1095)

    key = {(i, j): k for k, i, j in zip(cells.cell_id, cells.i_lat, cells.j_lon)}
    nb = np.array([[key.get((i + di, (j + dj) % 7200), cid) for di in (-1, 0, 1) for dj in (-1, 0, 1)] for cid, i, j in zip(cells.cell_id, cells.i_lat, cells.j_lon)])
    nbc = nb[c]
    o90 = np.arange(-89, 1)
    nwin = sst[t[:, None, None] + o90[None, None, :], nbc[:, :, None]]
    nhs = np.clip(nwin - mmm[nbc][:, :, None], 0, None)
    nmax = np.nanmax(np.nan_to_num(nhs, nan=0), axis=2)
    f["nb_hsmax_mean"] = nmax.mean(1)
    f["nb_hsmax_std"] = nmax.std(1)

    f["mmm"] = mmm[c]
    f["seasonal_range"] = (np.nanmax(clim, 0) - np.nanmin(clim, 0))[c]
    f["abs_lat"] = np.abs(s.lat.values)
    f["depth"] = s.depth_m.values
    f["months_from_warmest"] = (s.date.dt.month.values - warm_month[c]) % 12

    nwin_noaa = noaa[t[:, None] + o90[None, :], c[:, None]]
    f["noaa_dhw_same_day"] = noaa[t, c]
    f["noaa_dhw_max90"] = np.nanmax(nwin_noaa, axis=1)

    F = pd.DataFrame(f)
    ok2 = np.isfinite(F.noaa_dhw_max90.values)
    print("surveys missing NOAA DHW", int((~ok2).sum()))
    F, s = F[ok2].reset_index(drop=True), s[ok2].reset_index(drop=True)
    sub = F.noaa_dhw_same_day.notna()
    print("own 12-week DHW vs NOAA same-day DHW: corr", round(float(np.corrcoef(F.acc_12w_t1[sub], F.noaa_dhw_same_day[sub])[0, 1]), 3), "median abs diff", round(float(np.median(np.abs(F.acc_12w_t1[sub] - F.noaa_dhw_same_day[sub]))), 3))
    keep_idx = np.flatnonzero(ok2)
    np.save("/data/windows.npy", np.stack([anom[keep_idx], hs[keep_idx]], axis=-1).astype("float16"))
    pd.concat([s, F], axis=1).to_parquet("/data/features.parquet")
    np.save("/data/clim.npy", clim.astype("float32"))
    vol.commit()
    print("features", F.shape)


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=8, memory=16384)
def train_trees():
    import json

    import lightgbm as lgb
    import numpy as np
    import pandas as pd
    from scipy.stats import spearmanr

    vol.reload()
    d = pd.read_parquet("/data/features.parquet")
    d["y30"] = (d.pct >= 30).astype(int)
    meta = set(["Site_ID", "date", "lat", "lon", "pct", "tsa_dhw", "source", "realm", "ecoregion", "country", "y_mod", "y_sev", "y30", "split", "cell_id"])
    feats = [c for c in d.columns if c not in meta]
    mono = [1 if c in ("noaa_dhw_max90", "acc_12w_t1", "hs_max_90") else 0 for c in feats]
    params = dict(objective="binary", learning_rate=0.03, num_leaves=31, min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, monotone_constraints=mono, verbose=-1)

    def fit_predict(tr, va, te, target, seeds=5):
        preds = []
        for seed in range(seeds):
            p = dict(params, seed=seed)
            m = lgb.train(p, lgb.Dataset(tr[feats], tr[target]), 3000, valid_sets=[lgb.Dataset(va[feats], va[target])], callbacks=[lgb.early_stopping(150, verbose=False)])
            preds.append(m.predict(te[feats], num_iteration=m.best_iteration))
        return np.mean(preds, 0), m

    results, pred_rows = {}, []
    tr, va, te = d[d.split == "train"], d[d.split == "val"], d[d.split == "test"]
    print("test surveys", len(te))
    for target in ("y_mod", "y30", "y_sev"):
        p, m = fit_predict(tr, va, te, target)
        for base in ("noaa_dhw_max90", "noaa_dhw_same_day"):
            k = te[base].notna().values
            r = compare(te[target].values[k], p[k], te[base].values[k], te.ecoregion.fillna("NA").values[k], te.Site_ID.values[k])
            results[f"temporal|{target}|vs_{base}"] = r
            print(f"temporal {target} vs {base}:", r)
        pred_rows.append(pd.DataFrame({"row": te.index, "target": target, "split": "temporal", "p": p}))
        if target == "y_mod":
            imp = pd.Series(m.feature_importance("gain"), index=feats).sort_values(ascending=False)
            print("top features by gain:", imp.head(12).round(0).to_dict())

    for realm, n in d.realm.value_counts().items():
        if n < 300:
            continue
        te_r = d[d.realm == realm]
        rest = d[d.realm != realm]
        rng = np.random.default_rng(0)
        vsites = set(rng.choice(rest.Site_ID.unique(), size=rest.Site_ID.nunique() // 10, replace=False))
        va_r, tr_r = rest[rest.Site_ID.isin(vsites)], rest[~rest.Site_ID.isin(vsites)]
        p, _ = fit_predict(tr_r, va_r, te_r, "y_mod", seeds=3)
        r = compare(te_r.y_mod.values, p, te_r.noaa_dhw_max90.values, te_r.ecoregion.fillna("NA").values, te_r.Site_ID.values, n_boot=300)
        results[f"realm_out|{realm}|y_mod"] = r
        print(f"held-out realm {realm}:", r)

    folds = d.ecoregion.fillna("NA").astype("category").cat.codes.values % 5
    oof = np.zeros(len(d))
    for k in range(5):
        trk = d[folds != k]
        vs = trk.sample(frac=0.1, random_state=k)
        oof[folds == k], _ = fit_predict(trk.drop(vs.index), vs, d[folds == k], "y_mod", seeds=1)
    d["resid"] = d.y_mod - oof
    hot = d[d.noaa_dhw_max90 >= 4]
    a = hot[hot.date.dt.year <= 2015].groupby("Site_ID").resid.mean()
    b = hot[hot.date.dt.year >= 2016].groupby("Site_ID").resid.mean()
    j = pd.concat([a, b], axis=1, keys=["early", "late"]).dropna()
    eco = d.groupby("Site_ID").ecoregion.first()
    j = j.join(eco)
    jd = j.copy()
    jd[["early", "late"]] = j[["early", "late"]] - j.groupby("ecoregion")[["early", "late"]].transform("mean")
    if len(j) >= 10:
        rho, pv = spearmanr(j.early, j.late)
        rho2, pv2 = spearmanr(jd.early, jd.late)
        results["persistence"] = {"sites": len(j), "rho": round(float(rho), 3), "p": float(pv), "rho_within_ecoregion": round(float(rho2), 3), "p_within": float(pv2)}
    else:
        results["persistence"] = {"sites": len(j)}
    print("outlier persistence:", results["persistence"])

    pd.concat(pred_rows).to_parquet("/data/predictions_trees.parquet")
    d[["Site_ID", "date", "lat", "lon", "ecoregion", "realm", "noaa_dhw_max90", "y_mod", "resid"]].to_parquet("/data/residuals.parquet")
    with open("/data/results_trees.json", "w") as fh:
        json.dump(results, fh, indent=1)
    vol.commit()


gpu_image = modal.Image.debian_slim(python_version="3.11").pip_install(
    "torch==2.5.1",
    "numpy==2.1.3",
    "pandas==2.2.3",
    "pyarrow==18.1.0",
    "scikit-learn==1.5.2",
    "scipy==1.14.1",
)
P, PD, S_DIM = 156, 7, 8
CUTOFF_2013 = 10591


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=8, memory=65536)
def build_corpus():
    import json

    import numpy as np
    import pandas as pd

    vol.reload()
    cells = pd.read_parquet("/data/cells.parquet")
    sst = load_kind("sst")
    clim = np.load("/data/clim.npy")
    mmm = np.nanmax(clim, 0)
    month = pd.date_range("1985-01-01", periods=sst.shape[0], freq="D").month.values
    valid = np.isfinite(mmm) & (np.isfinite(sst).mean(0) > 0.9)
    sst = pd.DataFrame(sst[:, valid]).ffill().bfill().to_numpy(dtype="float32")
    anom = sst - clim[month - 1][:, valid]
    hs = np.clip(sst - mmm[valid], 0, None)
    np.save("/data/corpus_anom.npy", np.ascontiguousarray(anom.T).astype("float16"))
    np.save("/data/corpus_hs.npy", np.ascontiguousarray(hs.T).astype("float16"))
    warm = np.nanargmax(np.nan_to_num(clim, nan=-99), 0) + 1
    sr = np.nanmax(clim, 0) - np.nanmin(clim, 0)
    lat = np.abs(cells.lat_c.values)
    np.save("/data/corpus_static.npy", np.stack([mmm[valid], sr[valid], lat[valid], warm[valid]], 1).astype("float32"))
    norm = {
        "anom_mean": float(anom.mean()), "anom_std": float(anom.std()),
        "hs_mean": float(hs.mean()), "hs_std": float(hs.std()),
        "mmm_mean": float(np.mean(mmm[valid])), "mmm_std": float(np.std(mmm[valid])),
        "sr_mean": float(np.mean(sr[valid])), "sr_std": float(np.std(sr[valid])),
        "lat_mean": float(np.mean(lat[valid])), "lat_std": float(np.std(lat[valid])),
        "n_cells": int(valid.sum()), "n_days": int(sst.shape[0]),
    }
    with open("/data/norm.json", "w") as fh:
        json.dump(norm, fh, indent=1)
    vol.commit()
    print(norm)


def make_net():
    import torch
    from torch import nn

    class Net(nn.Module):
        def __init__(self, d=192, layers=6, heads=6):
            super().__init__()
            self.patch = nn.Linear(2 * PD, d)
            self.mask_tok = nn.Parameter(torch.zeros(d))
            self.pos = nn.Parameter(torch.randn(P + 2, d) * 0.02)
            self.static = nn.Linear(S_DIM, d)
            self.cls = nn.Parameter(torch.zeros(1, 1, d))
            layer = nn.TransformerEncoderLayer(d, heads, 4 * d, 0.1, batch_first=True, norm_first=True, activation="gelu")
            self.enc = nn.TransformerEncoder(layer, layers)
            self.norm = nn.LayerNorm(d)
            self.recon = nn.Linear(d, 2 * PD)
            self.head = nn.Linear(d, 3)

        def forward(self, x, st, mask=None):
            h = self.patch(x)
            if mask is not None:
                h = torch.where(mask[..., None], self.mask_tok.to(h.dtype), h)
            b = x.shape[0]
            z = torch.cat([self.cls.expand(b, -1, -1), self.static(st)[:, None], h], 1) + self.pos
            z = self.norm(self.enc(z))
            return self.head(z[:, 0]), self.recon(z[:, 2:])

    return Net()


def to_patches(anom, hs, norm):
    import torch

    a = (anom - norm["anom_mean"]) / norm["anom_std"]
    h = (hs - norm["hs_mean"]) / norm["hs_std"]
    b = a.shape[0]
    return torch.cat([a.reshape(b, P, PD), h.reshape(b, P, PD)], -1)


def static_vec(mmm, sr, lat, months_from_warm, depth, is_survey, norm):
    import math

    import torch

    ang = months_from_warm * (2 * math.pi / 12)
    dmiss = torch.isnan(depth)
    dep = torch.where(dmiss, torch.zeros_like(depth), depth / 20)
    return torch.stack([
        (mmm - norm["mmm_mean"]) / norm["mmm_std"],
        (sr - norm["sr_mean"]) / norm["sr_std"],
        (lat - norm["lat_mean"]) / norm["lat_std"],
        torch.sin(ang), torch.cos(ang), dep, dmiss.float(), is_survey,
    ], 1)


@app.function(image=gpu_image, gpu="L40S", volumes={"/data": vol}, timeout=6 * 3600, memory=32768)
def pretrain(name: str, cutoff_day: int, steps: int = 60000, batch: int = 512):
    import json
    import math
    import os
    import time

    import numpy as np
    import torch
    import torch.nn.functional as F

    vol.reload()
    dev = "cuda"
    norm = json.load(open("/data/norm.json"))
    A = torch.from_numpy(np.load("/data/corpus_anom.npy")).to(dev)
    H = torch.from_numpy(np.load("/data/corpus_hs.npy")).to(dev)
    st = torch.from_numpy(np.load("/data/corpus_static.npy")).to(dev)
    n_cells, n_days = A.shape
    last = min(cutoff_day, n_days - 1)
    month_of_day = torch.from_numpy(np.array([d.month for d in __import__("pandas").date_range("1985-01-01", periods=n_days, freq="D")])).to(dev)
    W = P * PD
    ar = torch.arange(W, device=dev)
    pa = torch.arange(P, device=dev)
    net = make_net().to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=3e-4, weight_decay=0.05)
    warm = 2000
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(1, s / steps))))
    g = torch.Generator(device=dev).manual_seed(0)

    def batch_of(bs, gen):
        c = torch.randint(0, n_cells, (bs,), device=dev, generator=gen)
        e = torch.randint(W - 1, last + 1, (bs,), device=dev, generator=gen)
        idx = e[:, None] - (W - 1) + ar
        x = to_patches(A[c[:, None], idx].float(), H[c[:, None], idx].float(), norm)
        mfw = ((month_of_day[e] - st[c, 3]) % 12).float()
        s = static_vec(st[c, 0], st[c, 1], st[c, 2], mfw, torch.full((bs,), float("nan"), device=dev), torch.zeros(bs, device=dev), norm)
        mask = torch.zeros(bs, P, dtype=torch.bool, device=dev)
        for _ in range(7):
            s0 = torch.randint(0, P, (bs,), device=dev, generator=gen)
            ln = torch.randint(4, 13, (bs,), device=dev, generator=gen)
            mask |= (pa >= s0[:, None]) & (pa < (s0 + ln)[:, None])
        fc = torch.rand(bs, device=dev, generator=gen) < 0.5
        mask |= fc[:, None] & (pa >= P - 4)
        return x, s, mask

    gv = torch.Generator(device=dev).manual_seed(123)
    val = [batch_of(1024, gv) for _ in range(4)]
    os.makedirs("/data/ckpt", exist_ok=True)
    t0 = time.time()
    for step in range(steps + 1):
        if step % 2000 == 0:
            net.eval()
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                lv, l0 = 0.0, 0.0
                for x, s, m in val:
                    _, r = net(x, s, m)
                    lv += F.huber_loss(r.float()[m], x[m]).item()
                    l0 += F.huber_loss(torch.zeros_like(x[m]), x[m]).item()
            print(f"{name} step {step} val_recon {lv / 4:.4f} zero_baseline {l0 / 4:.4f} elapsed {time.time() - t0:.0f}s", flush=True)
            net.train()
        if step % 10000 == 0 and step > 0 or step == steps:
            torch.save({"state": net.state_dict(), "norm": norm, "step": step, "cutoff": cutoff_day}, f"/data/ckpt/{name}.pt")
            vol.commit()
        if step == steps:
            break
        x, s, m = batch_of(batch, g)
        with torch.autocast("cuda", dtype=torch.bfloat16):
            _, r = net(x, s, m)
            loss = F.huber_loss(r.float()[m], x[m])
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
        opt.step()
        sched.step()
    return name


@app.function(image=gpu_image, gpu="L40S", volumes={"/data": vol}, timeout=2 * 3600, memory=32768)
def finetune(init: str, seed: int, mode: str = "temporal", realm: str = ""):
    import copy
    import json
    import os

    import numpy as np
    import pandas as pd
    import torch
    import torch.nn.functional as F

    vol.reload()
    dev = "cuda"
    torch.manual_seed(seed)
    np.random.seed(seed)
    norm = json.load(open("/data/norm.json"))
    d = pd.read_parquet("/data/features.parquet")
    win = np.load("/data/windows.npy")[:, -P * PD :].astype("float32")
    d["y30"] = (d.pct >= 30).astype(int)
    Y = torch.tensor(d[["y_mod", "y30", "y_sev"]].values, dtype=torch.float32)
    X = to_patches(torch.from_numpy(win[..., 0]), torch.from_numpy(win[..., 1]), norm)
    t = lambda col: torch.tensor(d[col].values, dtype=torch.float32)
    S = static_vec(t("mmm"), t("seasonal_range"), t("abs_lat"), t("months_from_warmest"), t("depth"), torch.ones(len(d)), norm)
    eco_year = d.ecoregion.fillna("NA") + "_" + d.date.dt.year.astype(str)
    Wt = torch.tensor((1 / np.sqrt(eco_year.map(eco_year.value_counts()).values)), dtype=torch.float32)

    if mode == "temporal":
        tr = np.flatnonzero(d.split.values == "train")
        va = np.flatnonzero(d.split.values == "val")
        te = np.flatnonzero(d.split.values == "test")
    else:
        te = np.flatnonzero(d.realm.values == realm)
        rest = d[d.realm != realm]
        rng = np.random.default_rng(0)
        vs = set(rng.choice(rest.Site_ID.unique(), size=rest.Site_ID.nunique() // 10, replace=False))
        va = np.flatnonzero((d.realm.values != realm) & d.Site_ID.isin(vs).values)
        tr = np.flatnonzero((d.realm.values != realm) & ~d.Site_ID.isin(vs).values)

    net = make_net().to(dev)
    if init != "scratch":
        net.load_state_dict(torch.load(f"/data/ckpt/{init}.pt", map_location=dev)["state"])
    enc_lr = 1e-4 if init != "scratch" else 3e-4
    head_params = list(net.head.parameters())
    other = [p for n, p in net.named_parameters() if not n.startswith("head.")]
    opt = torch.optim.AdamW([{"params": other, "lr": enc_lr}, {"params": head_params, "lr": 1e-3}], weight_decay=0.05)

    def predict(ix):
        net.eval()
        out = []
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            for k in range(0, len(ix), 1024):
                b = ix[k : k + 1024]
                logit, _ = net(X[b].to(dev), S[b].to(dev))
                out.append(torch.sigmoid(logit.float()).cpu())
        net.train()
        return torch.cat(out).numpy()

    regions = d.ecoregion.fillna("NA").values
    best, best_state, bad = -1.0, None, 0
    for epoch in range(25):
        perm = np.random.permutation(tr)
        for k in range(0, len(perm), 256):
            b = perm[k : k + 256]
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logit, _ = net(X[b].to(dev), S[b].to(dev))
                loss = (F.binary_cross_entropy_with_logits(logit.float(), Y[b].to(dev), reduction="none").mean(1) * Wt[b].to(dev)).sum() / Wt[b].sum().to(dev)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
        pv = predict(va)
        score = macro_auc(d.y_mod.values[va], pv[:, 0], regions[va])
        if score > best:
            best, best_state, bad = score, copy.deepcopy(net.state_dict()), 0
        else:
            bad += 1
            if bad >= 5:
                break
    net.load_state_dict(best_state)
    pt = predict(te)
    os.makedirs("/data/pred_tf", exist_ok=True)
    tag = f"{init}_{mode}{('_' + realm.replace(' ', '')) if realm else ''}_s{seed}"
    pd.DataFrame({"row": te, "p_mod": pt[:, 0], "p30": pt[:, 1], "p_sev": pt[:, 2]}).to_parquet(f"/data/pred_tf/{tag}.parquet")
    vol.commit()
    r = compare(d.y_mod.values[te], pt[:, 0], d.noaa_dhw_max90.values[te], regions[te], d.Site_ID.values[te], n_boot=300)
    print(tag, "val_macro", round(best, 4), r, flush=True)
    return tag, round(best, 4), r


@app.function(image=gpu_image, gpu="T4", timeout=900)
def smoke():
    import torch
    import torch.nn.functional as F

    norm = {"anom_mean": 0, "anom_std": 1, "hs_mean": 0, "hs_std": 1, "mmm_mean": 28, "mmm_std": 1.5, "sr_mean": 4, "sr_std": 2, "lat_mean": 15, "lat_std": 8}
    net = make_net().cuda()
    print("params", sum(p.numel() for p in net.parameters()))
    x = to_patches(torch.randn(32, P * PD), torch.rand(32, P * PD), norm).cuda()
    s = static_vec(torch.full((32,), 28.0), torch.full((32,), 4.0), torch.full((32,), 15.0), torch.arange(32.0) % 12, torch.full((32,), float("nan")), torch.ones(32), norm).cuda()
    y = (torch.rand(32, 3) < 0.3).float().cuda()
    logit, rec = net(x, s)
    assert logit.shape == (32, 3) and rec.shape == (32, P, 2 * PD)
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3)
    for i in range(300):
        logit, _ = net(x, s)
        loss = F.binary_cross_entropy_with_logits(logit, y)
        opt.zero_grad()
        loss.backward()
        opt.step()
    print("tiny-batch final loss", round(loss.item(), 4), "PASS" if loss.item() < 0.05 else "FAIL")


def ensemble_report(d, init, seeds, trees):
    import numpy as np
    import pandas as pd

    parts = [pd.read_parquet(f"/data/pred_tf/{init}_temporal_s{k}.parquet").set_index("row").p_mod for k in seeds]
    p = pd.concat(parts, axis=1).mean(1)
    te = d.loc[p.index]
    args = (te.ecoregion.fillna("NA").values, te.Site_ID.values)
    out = {"ensemble": compare(te.y_mod.values, p.values, te.noaa_dhw_max90.values, *args)}
    if trees is not None:
        b = (p.rank(pct=True) + trees.loc[p.index].rank(pct=True)) / 2
        out["blend_with_trees"] = compare(te.y_mod.values, b.values, te.noaa_dhw_max90.values, *args)
    return out


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=10 * 3600, cpu=0.25, memory=4096)
def pipeline(seeds: int = 3, steps: int = 60000):
    import json
    import os
    import time

    import numpy as np
    import pandas as pd

    log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)
    while True:
        vol.reload()
        n = len([f for f in os.listdir("/data/shards") if f.endswith(".npy")])
        if n >= 84:
            break
        log("waiting for shards", n, "/ 84")
        time.sleep(30)
    if not os.path.exists("/data/features.parquet"):
        log("features start")
        build_features.remote()
    log("features done; launching trees + corpus")
    trees_call = train_trees.spawn()
    build_corpus.remote()
    log("corpus done; launching pretraining x2 and scratch fine-tunes")
    pre13 = pretrain.spawn("pre_2013", CUTOFF_2013, steps)
    prefull = pretrain.spawn("pre_full", 10**6, steps)
    scratch = [finetune.spawn("scratch", k) for k in range(seeds)]
    trees_call.get()
    log("trees done")
    pre13.get()
    log("pre_2013 done; launching its fine-tunes")
    tuned = [finetune.spawn("pre_2013", k) for k in range(seeds)]
    res_scratch = [c.get() for c in scratch]
    res_pre = [c.get() for c in tuned]
    vol.reload()
    d = pd.read_parquet("/data/features.parquet")
    tp = pd.read_parquet("/data/predictions_trees.parquet")
    trees = tp[(tp.target == "y_mod") & (tp.split == "temporal")].set_index("row").p
    val_scratch = float(np.mean([r[1] for r in res_scratch]))
    val_pre = float(np.mean([r[1] for r in res_pre]))
    report = {
        "val_macro_scratch": round(val_scratch, 4),
        "val_macro_pre_2013": round(val_pre, 4),
        "scratch": ensemble_report(d, "scratch", range(seeds), trees),
        "pre_2013": ensemble_report(d, "pre_2013", range(seeds), trees),
        "trees": json.load(open("/data/results_trees.json")),
    }
    log("temporal report", json.dumps({k: report[k] for k in ("val_macro_scratch", "val_macro_pre_2013")}))
    with open("/data/results_pipeline.json", "w") as fh:
        json.dump(report, fh, indent=1)
    vol.commit()
    prefull.get()
    best = "pre_full" if val_pre >= val_scratch else "scratch"
    realms = [r for r, n in d.realm.value_counts().items() if n >= 300]
    log("realm hold-outs with", best, realms)
    realm_calls = [finetune.spawn(best, k, "realm", r) for r in realms for k in range(2)]
    report["realm_out_" + best] = {}
    for c in realm_calls:
        tag, v, r = c.get()
        report["realm_out_" + best][tag] = r
    with open("/data/results_pipeline.json", "w") as fh:
        json.dump(report, fh, indent=1)
    vol.commit()
    log("pipeline complete")
    return report


DELTAS = [round(k * 0.25, 2) for k in range(13)]
NOAA_COLS = ("noaa_dhw_same_day", "noaa_dhw_max90")


def heat_features(win, mmm, dclim, nwin, nmmm, sr, abs_lat, depth, months_from_warmest):
    import numpy as np

    m0 = mmm[:, None]
    hs = np.clip(win - m0, 0, None)
    anom = win - dclim
    f = {}
    for weeks in (4, 8, 12, 16, 24):
        for thr in (0, 1):
            f[f"acc_{weeks}w_t{thr}"] = np.where(hs[:, -weeks * 7 :] >= thr, hs[:, -weeks * 7 :], 0).sum(1) / 7
    for d in (30, 90):
        f[f"hs_max_{d}"] = hs[:, -d:].max(1)
        f[f"anom_mean_{d}"] = anom[:, -d:].mean(1)
        f[f"diff_std_{d}"] = np.diff(win[:, -d:], axis=1).std(1)
    for d in (7, 30, 90):
        f[f"sst_minus_mmm_{d}"] = (win[:, -d:] - m0).mean(1)
    for d in (30, 60):
        x = np.arange(d) - (d - 1) / 2
        f[f"slope_{d}"] = ((win[:, -d:] - win[:, -d:].mean(1, keepdims=True)) * x).sum(1) / (x**2).sum()
    for d in (90, 365):
        f[f"days_above_{d}"] = (win[:, -d:] > m0).sum(1)
    cs = np.cumsum(np.where(hs >= 1, hs, 0), axis=1)
    dhw_series = np.full_like(cs, np.nan)
    dhw_series[:, 84:] = (cs[:, 84:] - cs[:, :-84]) / 7
    prior = dhw_series[:, 84:916]
    f["prior_peak_dhw"] = np.nanmax(prior, axis=1)
    f["peak_dhw_y1"] = np.nanmax(dhw_series[:, 551:916], axis=1)
    f["peak_dhw_y2"] = np.nanmax(dhw_series[:, 186:551], axis=1)
    f["prior_years_dhw4"] = (f["peak_dhw_y1"] >= 4).astype(int) + (f["peak_dhw_y2"] >= 4).astype(int)
    hit = prior >= 4
    last = np.where(hit.any(1), hit.shape[1] - 1 - np.argmax(hit[:, ::-1], axis=1), -1)
    f["days_since_dhw4"] = np.where(last >= 0, (915 - (84 + last)) + 180, 1095)
    nhs = np.clip(nwin - nmmm[:, :, None], 0, None)
    nmax = np.nanmax(np.nan_to_num(nhs, nan=0), axis=2)
    f["nb_hsmax_mean"] = nmax.mean(1)
    f["nb_hsmax_std"] = nmax.std(1)
    f["mmm"] = mmm
    f["seasonal_range"] = sr
    f["abs_lat"] = abs_lat
    f["depth"] = depth
    f["months_from_warmest"] = months_from_warmest
    return f


SERVE_LEVEL = 30
CURRENT_HEAT = ("acc_", "hs_max_", "sst_minus_mmm_", "anom_mean_", "days_above_90", "nb_hsmax_mean")


def bump(a, dl, days=120):
    out = a.copy()
    out[..., -days:] += dl
    return out


def interp_cross(curve, level=0.5):
    import numpy as np

    c = np.asarray(curve)
    if c[0] >= level:
        return 0.0
    above = np.flatnonzero(c >= level)
    if not len(above):
        return None
    k = above[0]
    x0, x1, y0, y1 = DELTAS[k - 1], DELTAS[k], c[k - 1], c[k]
    return float(x0 + (level - y0) * (x1 - x0) / max(y1 - y0, 1e-9))


def make_windows(sst, clim, month, nb, mmm_all, cids, days):
    import numpy as np

    off, o90 = np.arange(-1095, 1), np.arange(-89, 1)

    def f32(a):
        if a.dtype == np.int16:
            out = a.astype("float32") / 100.0
            out[a == MISSING] = np.nan
            return out
        return a

    win = ffill_rows(f32(sst[days[:, None] + off[None, :], cids[:, None]]))
    dclim = clim[month[days[:, None] + off[None, :]] - 1, cids[:, None]]
    nbc = nb[cids]
    nwin = f32(sst[days[:, None, None] + o90[None, None, :], nbc[:, :, None]])
    return win, dclim, nwin, mmm_all[nbc]


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=8, memory=49152)
def export_serving():
    import json
    import os

    import lightgbm as lgb
    import numpy as np
    import pandas as pd

    vol.reload()
    os.makedirs("/data/serve", exist_ok=True)
    d = pd.read_parquet("/data/features.parquet")
    d["yt"] = (d.pct >= SERVE_LEVEL).astype(int)
    cells = pd.read_parquet("/data/cells.parquet")
    clim = np.load("/data/clim.npy")
    mmm_all = np.nanmax(clim, 0)
    sr_all = np.nanmax(clim, 0) - np.nanmin(clim, 0)
    warm_all = np.nanargmax(np.nan_to_num(clim, nan=-99), 0) + 1
    sst = load_kind("sst")
    n_days = sst.shape[0]
    month = pd.date_range("1985-01-01", periods=n_days, freq="D").month.values
    meta = {"Site_ID", "date", "lat", "lon", "pct", "tsa_dhw", "source", "realm", "ecoregion", "country", "y_mod", "y_sev", "yt", "split", "cell_id", "depth_m", "depth"}
    feats = [c for c in d.columns if c not in meta and c not in NOAA_COLS]

    key = {(i, j): k for k, i, j in zip(cells.cell_id, cells.i_lat, cells.j_lon)}
    nb = np.array([[key.get((i + di, (j + dj) % 7200), cid) for di in (-1, 0, 1) for dj in (-1, 0, 1)] for cid, i, j in zip(cells.cell_id, cells.i_lat, cells.j_lon)])

    def windows(cids, days):
        return make_windows(sst, clim, month, nb, mmm_all, cids, days)

    rng = np.random.default_rng(0)
    chk = d.sample(600, random_state=0)
    base = pd.Timestamp("1985-01-01")
    t = ((chk.date - base).dt.days).values
    c = chk.cell_id.values
    win, dclim, nwin, nmmm = windows(c, t)
    f = heat_features(win, mmm_all[c], dclim, nwin, nmmm, sr_all[c], np.abs(chk.lat.values), chk.depth.values, (chk.date.dt.month.values - warm_all[c]) % 12)
    worst = max((float(np.nanmax(np.abs(np.asarray(f[k], dtype="float64") - chk[k].values.astype("float64")))), k) for k in feats)
    print("feature parity check (serving function vs training table), worst abs diff:", worst)
    assert worst[0] < 1e-3, worst

    boosters = []
    params = dict(objective="binary", learning_rate=0.03, num_leaves=31, min_data_in_leaf=50, feature_fraction=0.8, bagging_fraction=0.8, bagging_freq=1, lambda_l2=1.0, verbose=-1)
    val_sites = set(rng.choice(d.Site_ID.unique(), size=d.Site_ID.nunique() // 10, replace=False))
    va, tr = d[d.Site_ID.isin(val_sites)], d[~d.Site_ID.isin(val_sites)]
    mono = [1 if c.startswith(CURRENT_HEAT) else 0 for c in feats]
    check = dict(params, seed=0, monotone_constraints=mono)
    trc, vac, tec = d[d.split == "train"], d[d.split == "val"], d[d.split == "test"]
    mc = lgb.train(check, lgb.Dataset(trc[feats], trc.yt), 3000, valid_sets=[lgb.Dataset(vac[feats], vac.yt)], callbacks=[lgb.early_stopping(150, verbose=False)])
    pc = mc.predict(tec[feats], num_iteration=mc.best_iteration)
    print("serving-model check (no NOAA inputs, no depth, monotone heat), temporal test vs NOAA same-day:", compare(tec.yt.values, pc, tec.noaa_dhw_same_day.values, tec.ecoregion.fillna("NA").values, tec.Site_ID.values, n_boot=300), flush=True)
    for seed in range(3):
        m = lgb.train(dict(params, seed=seed, monotone_constraints=mono), lgb.Dataset(tr[feats], tr.yt), 3000, valid_sets=[lgb.Dataset(va[feats], va.yt)], callbacks=[lgb.early_stopping(150, verbose=False)])
        m.save_model(f"/data/serve/deploy_{seed}.txt", num_iteration=m.best_iteration)
        boosters.append(m)

    def predict(fd):
        X = pd.DataFrame({k: fd[k] for k in feats})
        return np.mean([b.predict(X, num_iteration=b.best_iteration) for b in boosters], 0)

    valid = np.isfinite(mmm_all) & (np.isfinite(sst[-1100:]).mean(0) > 0.9)
    cids = np.flatnonzero(valid)
    lo = n_days - 1096
    hs_recent = np.clip(np.nan_to_num(sst[lo - 84 :, cids], nan=-99) - mmm_all[cids], 0, None)
    hs_recent = np.where(hs_recent >= 1, hs_recent, 0)
    cs = np.cumsum(hs_recent, axis=0)
    dhw_recent = (cs[84:] - cs[:-84]) / 7
    ref = lo + np.argmax(dhw_recent, axis=0)
    ref = np.maximum(ref, 1095)
    print("serving cells", len(cids), "reference days range", int(ref.min()), int(ref.max()))

    lab = d.groupby("cell_id").agg(realm=("realm", "first"), eco=("ecoregion", "first"), country=("country", "first"))
    info = {k: lab.loc[k].to_dict() for k in lab.index}
    for cid in lab.index:
        for n in nb[cid]:
            info.setdefault(int(n), info[cid])
    win, dclim, nwin, nmmm = windows(cids, ref)
    mfw = (month[ref] - warm_all[cids]) % 12
    nan_depth = np.full(len(cids), np.nan)
    risk = np.zeros((len(cids), len(DELTAS)))
    dhw = np.zeros((len(cids), len(DELTAS)))
    for k, dl in enumerate(DELTAS):
        fd = heat_features(bump(win, dl), mmm_all[cids], dclim, bump(nwin, dl), nmmm, sr_all[cids], np.abs(cells.lat_c.values[cids]), nan_depth, mfw)
        risk[:, k] = predict(fd)
        dhw[:, k] = fd["acc_12w_t1"]
    print("risk monotone in added heat for", round(float((np.diff(risk, axis=1) >= -1e-6).all(1).mean()), 4), "of cells")

    res = pd.read_parquet("/data/residuals.parquet")
    res = res.merge(d[["Site_ID", "date", "cell_id", "pct"]], on=["Site_ID", "date"], how="left")
    hot = res[res.noaa_dhw_max90 >= 4]
    rs = hot.groupby("cell_id").agg(resid=("resid", "mean"), n_hot=("resid", "size"), max_dhw=("noaa_dhw_max90", "max"))
    surveys = res.groupby("cell_id").apply(lambda g: [[int(x.year), int(x.month), round(float(p), 1), round(float(h), 1), round(float(r), 3)] for x, p, h, r in zip(g.date, g.pct, g.noaa_dhw_max90, g.resid)], include_groups=False)

    rows = []
    for k, cid in enumerate(cids):
        inf = info.get(int(cid), {})
        r = rs.loc[cid] if cid in rs.index else None
        rows.append({
            "i": k,
            "lat": round(float(cells.lat_c.values[cid]), 3),
            "lon": round(float(cells.lon_c.values[cid]), 3),
            "realm": inf.get("realm") or "",
            "eco": inf.get("eco") or "",
            "country": inf.get("country") or "",
            "ref": str((base + pd.Timedelta(days=int(ref[k]))).date()),
            "risk": [round(float(v), 3) for v in risk[k]],
            "dhw": [round(float(v), 2) for v in dhw[k]],
            "margin": interp_cross(risk[k]),
            "resid": None if r is None else round(float(r.resid), 3),
            "n_hot": 0 if r is None else int(r.n_hot),
            "max_dhw": None if r is None else round(float(r.max_dhw), 1),
            "labelled": bool(cid in lab.index),
        })
    layer = {"deltas": DELTAS, "n": len(rows), "reefs": rows, "level": SERVE_LEVEL, "model": "LightGBM ensemble on daily NOAA CoralTemp history, trained on the Global Coral Bleaching Database"}
    with open("/data/serve/layer.json", "w") as fh:
        json.dump(layer, fh, separators=(",", ":"))
    np.savez_compressed(
        "/data/serve/serve.npz",
        cids=cids, ref=ref, win=win.astype("float32"), dclim=dclim.astype("float32"), nwin=nwin.astype("float32"), nmmm=nmmm.astype("float32"),
        mmm=mmm_all[cids], sr=sr_all[cids], abs_lat=np.abs(cells.lat_c.values[cids]), mfw=mfw, lat=cells.lat_c.values[cids], lon=cells.lon_c.values[cids],
    )
    with open("/data/serve/feats.json", "w") as fh:
        json.dump(feats, fh)
    surveys.to_frame("s").reset_index().assign(s=lambda x: x.s.map(json.dumps)).to_parquet("/data/serve/surveys.parquet")
    sst_i16 = np.where(np.isfinite(sst), np.rint(sst * 100), MISSING).astype("int16")
    np.save("/data/serve/sst_i16.npy", sst_i16)
    np.save("/data/serve/nb.npy", nb)
    np.save("/data/serve/clim_all.npy", clim.astype("float32"))
    vol.commit()
    print("export done", len(rows), "layer MB", round(os.path.getsize("/data/serve/layer.json") / 1e6, 2))


web_image = cpu_image.pip_install("fastapi[standard]==0.115.6", "shapely==2.0.6", "requests==2.32.3")
habitat_cache = modal.Dict.from_name("reef-habitat", create_if_missing=True)
ACA_WFS = "https://allencoralatlas.org/geoserver/wfs"
ACA_CLASSES = ("Coral/Algae", "Rock", "Rubble", "Seagrass", "Sand", "Microalgal Mats")


def build_habitat(lat, lon, half_lat=0.06, half_lon=0.07, step=0.0025):
    import json
    import math

    import numpy as np
    import requests
    import shapely
    from shapely.geometry import box, mapping, shape

    q = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typeNames": "coral-atlas:benthic_data_verbose",
        "outputFormat": "application/json",
        "bbox": f"{lon - half_lon},{lat - half_lat},{lon + half_lon},{lat + half_lat},EPSG:4326",
        "count": 60000,
    }
    res = requests.get(ACA_WFS, params=q, timeout=60, headers={"User-Agent": "reef-margin/0.1 (research prototype)"})
    res.raise_for_status()
    by_class = {}
    for f in res.json()["features"]:
        c = f["properties"]["class_name"]
        if c in ACA_CLASSES:
            by_class.setdefault(c, []).append(shape(f["geometry"]))
    xs = np.arange(lon - half_lon, lon + half_lon, step)
    ys = np.arange(lat - half_lat, lat + half_lat, step)
    cells = np.array([box(x, y, x + step, y + step) for x in xs for y in ys])
    km2 = (111.32 ** 2) * math.cos(math.radians(lat))
    out, area = [], {}
    for c, geoms in by_class.items():
        u = shapely.make_valid(shapely.union_all(geoms))
        tree = shapely.STRtree(cells)
        hit = tree.query(u, predicate="intersects")
        pieces = shapely.intersection(cells[hit], u)
        for g in pieces:
            if g.is_empty or g.area <= 0:
                continue
            a = g.area * km2
            area[c] = area.get(c, 0) + a
            g = shapely.set_precision(g.simplify(0.00002), 0.00001)
            if g.is_empty:
                continue
            ctr = g.centroid
            out.append({"type": "Feature", "properties": {"c": c, "x": round(ctr.x, 5), "y": round(ctr.y, 5), "a": round(a, 5)}, "geometry": mapping(g)})
    return json.dumps({"type": "FeatureCollection", "center": [lon, lat], "area_km2": {k: round(v, 3) for k, v in area.items()}, "features": out}, separators=(",", ":"))


@app.cls(image=web_image, volumes={"/data": vol}, cpu=2, memory=8192, scaledown_window=1200, timeout=600)
class Api:
    @modal.enter()
    def load(self):
        import json

        import lightgbm as lgb
        import numpy as np
        import pandas as pd

        vol.reload()
        z = np.load("/data/serve/serve.npz")
        self.z = {k: z[k] for k in z.files}
        self.feats = json.load(open("/data/serve/feats.json"))
        self.boosters = [lgb.Booster(model_file=f"/data/serve/deploy_{s}.txt") for s in range(3)]
        self.layer_bytes = open("/data/serve/layer.json", "rb").read()
        self.layer = json.loads(self.layer_bytes)
        self.sst = np.load("/data/serve/sst_i16.npy", mmap_mode="r")
        self.nb = np.load("/data/serve/nb.npy")
        self.clim = np.load("/data/serve/clim_all.npy")
        self.mmm_all = np.nanmax(self.clim, 0)
        self.month = pd.date_range("1985-01-01", periods=self.sst.shape[0], freq="D").month.values
        sv = pd.read_parquet("/data/serve/surveys.parquet")
        cid_to_i = {int(c): k for k, c in enumerate(self.z["cids"])}
        self.surveys = {cid_to_i[int(c)]: json.loads(s) for c, s in zip(sv.cell_id, sv.s) if int(c) in cid_to_i}
        self.lat, self.lon = self.z["lat"], self.z["lon"]

    def window_at(self, idx, day):
        import numpy as np

        z = self.z
        idx = np.asarray(idx)
        if day is None:
            return {"win": z["win"][idx], "dclim": z["dclim"][idx], "nwin": z["nwin"][idx], "nmmm": z["nmmm"][idx], "mfw": z["mfw"][idx]}
        cids = z["cids"][idx]
        days = np.full(len(idx), day)
        win, dclim, nwin, nmmm = make_windows(self.sst, self.clim, self.month, self.nb, self.mmm_all, cids, days)
        warm = np.nanargmax(np.nan_to_num(self.clim, nan=-99), 0) + 1
        return {"win": win, "dclim": dclim, "nwin": nwin, "nmmm": nmmm, "mfw": (self.month[day] - warm[cids]) % 12}

    def curves(self, idx, deltas_per_cell, day=None):
        import numpy as np
        import pandas as pd

        z = self.z
        idx = np.asarray(idx)
        w = self.window_at(idx, day)
        k = len(deltas_per_cell[0])
        rep = np.repeat(np.arange(len(idx)), k)
        g = idx[rep]
        dl = np.concatenate([np.asarray(d) for d in deltas_per_cell])
        f = heat_features(bump(w["win"][rep], dl[:, None]), z["mmm"][g], w["dclim"][rep], bump(w["nwin"][rep], dl[:, None, None]), w["nmmm"][rep], z["sr"][g], z["abs_lat"][g], np.full(len(rep), np.nan), w["mfw"][rep])
        X = pd.DataFrame({c: f[c] for c in self.feats})
        p = np.mean([b.predict(X) for b in self.boosters], 0)
        return p.reshape(len(idx), k), np.asarray(f["acc_12w_t1"]).reshape(len(idx), k), w

    def day_of(self, date):
        import datetime as dt

        from fastapi import HTTPException

        try:
            day = (dt.date.fromisoformat(date) - dt.date(1985, 1, 1)).days
        except ValueError:
            raise HTTPException(400, "Date must be YYYY-MM-DD")
        if not 1095 <= day < self.sst.shape[0]:
            raise HTTPException(400, f"Date must fall between 1988-01-01 and the last day of data, day {self.sst.shape[0] - 1}")
        return day

    @modal.asgi_app()
    def web(self):
        import math

        import numpy as np
        from fastapi import FastAPI, HTTPException
        from fastapi.middleware.cors import CORSMiddleware
        from fastapi.responses import Response
        from pydantic import BaseModel, Field

        api = FastAPI()
        from fastapi.middleware.gzip import GZipMiddleware

        api.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
        api.add_middleware(GZipMiddleware, minimum_size=2000)

        def dist_km(lat, lon):
            p = math.pi / 180
            a = np.sin((self.lat - lat) * p / 2) ** 2 + np.cos(lat * p) * np.cos(self.lat * p) * np.sin((self.lon - lon) * p / 2) ** 2
            return 12742 * np.arcsin(np.sqrt(a))

        @api.get("/layer")
        def layer():
            return Response(self.layer_bytes, media_type="application/json")

        @api.get("/reef/{i}")
        def reef(i: int, warming: float = 1.0, date: str | None = None):
            reefs = self.layer["reefs"]
            if not 0 <= i < len(reefs):
                raise HTTPException(404, "No reef with that index")
            day = self.day_of(date) if date else None
            risk, dhw, w = self.curves([i], [DELTAS], day)
            z = self.z
            weekly = (w["win"][0][-1092:].reshape(156, 7).mean(1)).round(2).tolist()
            clim_w = (w["dclim"][0][-1092:].reshape(156, 7).mean(1)).round(2).tolist()
            me = reefs[i]
            proj = float(np.interp(warming, DELTAS, dhw[0]))
            dk = dist_km(me["lat"], me["lon"])
            donors = []
            for r in reefs:
                if r["realm"] == me["realm"] and r["n_hot"] >= 2 and r["resid"] is not None and r["resid"] < -0.1 and (r["max_dhw"] or 0) >= proj and r["i"] != i:
                    donors.append((r["resid"], float(dk[r["i"]]), r))
            donors.sort(key=lambda x: (x[0], x[1]))
            return {
                "i": i,
                "risk": risk[0].round(4).tolist(),
                "dhw": dhw[0].round(2).tolist(),
                "margin": interp_cross(risk[0]),
                "weekly_sst": weekly,
                "weekly_clim": clim_w,
                "mmm": round(float(z["mmm"][i]), 2),
                "ref": date or me["ref"],
                "surveys": self.surveys.get(i, []),
                "projected_dhw": round(proj, 2),
                "donors": [{"i": r["i"], "lat": r["lat"], "lon": r["lon"], "eco": r["eco"], "country": r["country"], "resid": r["resid"], "n_hot": r["n_hot"], "max_dhw": r["max_dhw"], "km": round(km)} for _, km, r in donors[:6]],
                "donor_pool": len(donors),
            }

        class Impact(BaseModel):
            lat: float = Field(ge=-90, le=90)
            lon: float = Field(ge=-180, le=180)
            delta_c: float = Field(gt=0, le=6)
            radius_km: float = Field(gt=0, le=50)

        @api.post("/impact")
        def impact(q: Impact):
            dk = dist_km(q.lat, q.lon)
            near = np.flatnonzero(dk <= 3 * q.radius_km)
            if not len(near):
                return {"affected": [], "searched_km": 3 * q.radius_km}
            near = near[np.argsort(dk[near])][:400]
            add = q.delta_c * np.exp(-((dk[near] / q.radius_km) ** 2))
            risk, dhw, _ = self.curves(near, [[0.0, float(a)] for a in add])
            out = []
            for k, i in enumerate(near):
                r = self.layer["reefs"][int(i)]
                out.append({"i": int(i), "lat": r["lat"], "lon": r["lon"], "eco": r["eco"], "km": round(float(dk[i]), 2), "added_c": round(float(add[k]), 2), "risk_before": round(float(risk[k, 0]), 4), "risk_after": round(float(risk[k, 1]), 4), "dhw_before": round(float(dhw[k, 0]), 2), "dhw_after": round(float(dhw[k, 1]), 2)})
            return {"affected": out, "searched_km": 3 * q.radius_km}

        @api.get("/replay")
        def replay(date: str, lat0: float = -90, lat1: float = 90, lon0: float = -180, lon1: float = 180):
            day = self.day_of(date)
            idx = np.flatnonzero((self.lat >= lat0) & (self.lat <= lat1) & (self.lon >= lon0) & (self.lon <= lon1))
            out_r, out_d = [], []
            for k in range(0, len(idx), 4000):
                r, dh, _ = self.curves(idx[k : k + 4000], [[0.0]] * len(idx[k : k + 4000]), day)
                out_r.append(r[:, 0])
                out_d.append(dh[:, 0])
            r = np.concatenate(out_r) if out_r else np.array([])
            dh = np.concatenate(out_d) if out_d else np.array([])
            return {"date": date, "i": idx.tolist(), "risk": np.round(r, 3).tolist(), "dhw": np.round(dh, 2).tolist()}

        @api.get("/frames/meta")
        def frames_meta():
            import os

            if not os.path.exists("/data/serve/frames.json"):
                raise HTTPException(404, "Time frames are still being computed")
            return Response(open("/data/serve/frames.json", "rb").read(), media_type="application/json")

        @api.get("/frames/data")
        def frames_data():
            import os

            if not os.path.exists("/data/serve/frames.bin"):
                raise HTTPException(404, "Time frames are still being computed")
            return Response(open("/data/serve/frames.bin", "rb").read(), media_type="application/octet-stream")

        @api.get("/years")
        def years():
            import os

            if not os.path.exists("/data/serve/years.json"):
                raise HTTPException(404, "Bleaching years are still being computed")
            return Response(open("/data/serve/years.json", "rb").read(), media_type="application/json")

        @api.get("/habitat")
        def habitat(lat: float, lon: float):
            key = f"{round(lat, 3):.3f},{round(lon, 3):.3f}"
            body = habitat_cache.get(key)
            if body is None:
                try:
                    body = build_habitat(round(lat, 3), round(lon, 3))
                except Exception as e:
                    raise HTTPException(502, f"Allen Coral Atlas did not respond: {e}")
                habitat_cache[key] = body
            return Response(body, media_type="application/json")

        @api.get("/health")
        def health():
            return {"ok": True, "reefs": self.layer["n"], "model": self.layer["model"]}

        return api


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3 * 3600, cpu=0.25)
def extract_all(kind: str):
    import os

    vol.reload()
    years = list(range(1985, LAST_DAY[0] + 1))
    for y in years:
        path = f"/data/shards/{kind}_{y}.npy"
        if os.path.exists(path):
            os.remove(path)
    vol.commit()
    for r in extract_year.starmap([(y, kind) for y in years]):
        print(r, flush=True)


def month_end_days(year, n_days):
    import datetime as dt

    base = dt.date(1985, 1, 1)
    out = []
    for m in range(1, 13):
        nxt = dt.date(year + (m == 12), m % 12 + 1, 1)
        day = (nxt - dt.timedelta(days=1) - base).days
        if 1095 <= day < n_days:
            out.append((str(nxt - dt.timedelta(days=1)), day))
    return out


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=1800, cpu=4, memory=8192)
def frames_year(year: int):
    import json

    import lightgbm as lgb
    import numpy as np
    import pandas as pd

    vol.reload()
    z = np.load("/data/serve/serve.npz")
    cids, mmm, sr, abs_lat = z["cids"], z["mmm"], z["sr"], z["abs_lat"]
    sst = np.load("/data/serve/sst_i16.npy")
    nb = np.load("/data/serve/nb.npy")
    clim = np.load("/data/serve/clim_all.npy")
    mmm_all = np.nanmax(clim, 0)
    warm = np.nanargmax(np.nan_to_num(clim, nan=-99), 0) + 1
    month = pd.date_range("1985-01-01", periods=sst.shape[0], freq="D").month.values
    feats = json.load(open("/data/serve/feats.json"))
    boosters = [lgb.Booster(model_file=f"/data/serve/deploy_{k}.txt") for k in range(3)]
    dates, frames = [], []
    for date, day in month_end_days(year, sst.shape[0]):
        risk = np.zeros(len(cids), dtype="float32")
        for k in range(0, len(cids), 3000):
            c = cids[k : k + 3000]
            win, dclim, nwin, nmmm = make_windows(sst, clim, month, nb, mmm_all, c, np.full(len(c), day))
            f = heat_features(win, mmm[k : k + 3000], dclim, nwin, nmmm, sr[k : k + 3000], abs_lat[k : k + 3000], np.full(len(c), np.nan), (month[day] - warm[c]) % 12)
            X = pd.DataFrame({n: f[n] for n in feats})
            risk[k : k + 3000] = np.mean([b.predict(X) for b in boosters], 0)
        dates.append(date)
        frames.append(np.clip(np.rint(risk * 250), 0, 250).astype("uint8"))
    return year, dates, (np.stack(frames) if frames else np.zeros((0, len(cids)), dtype="uint8"))


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=1, memory=4096)
def frames_all():
    import json

    import numpy as np

    years = list(range(1988, LAST_DAY[0] + 1))
    dates, frames = [], []
    for year, ds, fr in sorted(frames_year.map(years), key=lambda r: r[0]):
        dates += ds
        frames.append(fr)
    arr = np.concatenate(frames)
    with open("/data/serve/frames.bin", "wb") as fh:
        fh.write(arr.tobytes())
    with open("/data/serve/frames.json", "w") as fh:
        json.dump({"dates": dates, "n": int(arr.shape[1]), "scale": 250}, fh)
    vol.commit()
    print("frames", arr.shape, dates[0], dates[-1])


SHIFTS = [k * 0.25 for k in range(-6, 9)]
RECENT = (2016, 2025)


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=1800, cpu=4, memory=8192)
def years_shift(year: int, days):
    import json

    import lightgbm as lgb
    import numpy as np
    import pandas as pd

    vol.reload()
    z = np.load("/data/serve/serve.npz")
    cids, mmm, sr, abs_lat = z["cids"], z["mmm"], z["sr"], z["abs_lat"]
    sst = np.load("/data/serve/sst_i16.npy")
    nb = np.load("/data/serve/nb.npy")
    clim = np.load("/data/serve/clim_all.npy")
    mmm_all = np.nanmax(clim, 0)
    warm = np.nanargmax(np.nan_to_num(clim, nan=-99), 0) + 1
    month = pd.date_range("1985-01-01", periods=sst.shape[0], freq="D").month.values
    feats = json.load(open("/data/serve/feats.json"))
    boosters = [lgb.Booster(model_file=f"/data/serve/deploy_{k}.txt") for k in range(3)]
    days = np.asarray(days)
    out = np.zeros((len(SHIFTS), len(cids)), dtype=bool)
    for k in range(0, len(cids), 2000):
        c = cids[k : k + 2000]
        dd = days[k : k + 2000]
        win, dclim, nwin, nmmm = make_windows(sst, clim, month, nb, mmm_all, c, dd)
        for s, sh in enumerate(SHIFTS):
            f = heat_features(bump(win, sh), mmm[k : k + 2000], dclim, bump(nwin, sh), nmmm, sr[k : k + 2000], abs_lat[k : k + 2000], np.full(len(c), np.nan), (month[dd] - warm[c]) % 12)
            X = pd.DataFrame({n: f[n] for n in feats})
            out[s, k : k + 2000] = np.mean([b.predict(X) for b in boosters], 0) >= 0.5
    return year, out


@app.function(image=cpu_image, volumes={"/data": vol}, timeout=3600, cpu=1, memory=4096)
def years_all():
    import base64
    import datetime as dt
    import json

    import numpy as np

    vol.reload()
    meta = json.load(open("/data/serve/frames.json"))
    arr = np.frombuffer(open("/data/serve/frames.bin", "rb").read(), dtype=np.uint8).reshape(len(meta["dates"]), meta["n"])
    yr = np.array([int(d[:4]) for d in meta["dates"]])
    day = np.array([(dt.date.fromisoformat(d) - dt.date(1985, 1, 1)).days for d in meta["dates"]])
    years = list(range(1988, RECENT[1] + 1))
    ann = np.stack([arr[yr == y].max(0) for y in years])
    jobs = []
    for y in range(RECENT[0], RECENT[1] + 1):
        rows = np.where(yr == y)[0]
        jobs.append((y, day[rows[arr[rows].argmax(0)]].tolist()))
    counts = np.zeros((len(SHIFTS), meta["n"]), dtype=np.uint8)
    for y, hit in years_shift.starmap(jobs):
        counts += hit
    with open("/data/serve/years.json", "w") as fh:
        json.dump({"years": years, "scale": meta["scale"], "n": meta["n"], "ann": base64.b64encode(ann.tobytes()).decode(), "shifts": SHIFTS, "window": list(RECENT), "counts": base64.b64encode(counts.tobytes()).decode()}, fh)
    vol.commit()
    base = counts[SHIFTS.index(0.0)]
    print("bleaching years", RECENT, "at +0:", np.percentile(base, [10, 25, 50, 75, 90]).tolist(), "share <=2:", round(float((base <= 2).mean()), 3), "share >=5:", round(float((base >= 5).mean()), 3))
    print("at +1:", np.percentile(counts[SHIFTS.index(1.0)], [25, 50, 75]).tolist(), "with -0.5:", np.percentile(counts[SHIFTS.index(-0.5)], [25, 50, 75]).tolist())
