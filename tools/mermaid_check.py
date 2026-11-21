import base64
import json
import os

import numpy as np
import pandas as pd
import requests
import statsmodels.formula.api as smf
from scipy.spatial import cKDTree
from sklearn.metrics import roc_auc_score

API = os.environ.get("REEF_API", "https://hridayahoney--reef-response-api-web.us-east.modal.run")
ROOT = os.path.join(os.path.dirname(__file__), "..")
RAW = os.path.join(ROOT, "data/mermaid/summarysampleevents.json")
UA = {"User-Agent": "coralitics/0.1 (research prototype)"}


def fetch():
    if os.path.exists(RAW):
        return json.load(open(RAW))
    out, url = [], "https://api.datamermaid.org/v1/summarysampleevents/?limit=1000"
    while url:
        page = requests.get(url, headers=UA, timeout=180).json()
        out += page["results"]
        url = page["next"]
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    json.dump(out, open(RAW, "w"))
    return out


def rows(events):
    for r in events:
        p = r.get("protocols") or {}
        hc = next((p[k].get("percent_cover_benthic_category_avg", {}).get("Hard coral") for k in ("benthicpit", "benthicpqt", "benthiclit") if k in p), None)
        if hc is None and "quadrat_benthic_percent" in p:
            hc = p["quadrat_benthic_percent"].get("percent_hard_avg_avg")
        rules = r.get("management_rules") or []
        yield dict(
            lat=r["latitude"], lon=r["longitude"], year=float((r.get("sample_date") or "0")[:4]), hc=hc,
            bio=p.get("beltfish", {}).get("biomass_kgha_avg"), bl=p.get("colonies_bleached", {}).get("percent_bleached_avg"),
            notake=int("no take" in rules), site=r["site_id"], country=r.get("country_name") or "",
        )


def main():
    reefs = requests.get(f"{API}/layer", timeout=120).json()["reefs"]
    y = requests.get(f"{API}/years", timeout=120).json()
    ann = np.frombuffer(base64.b64decode(y["ann"]), np.uint8).reshape(-1, y["n"]) / y["scale"]
    years = np.array(y["years"])
    pressure = json.load(open(os.path.join(ROOT, "web/public/data/pressure.json")))

    df = pd.DataFrame(rows(fetch()))
    dist, cell = cKDTree([[r["lat"], r["lon"]] for r in reefs]).query(df[["lat", "lon"]].values)
    df["cell"] = cell
    df = df[(dist < 0.1) & (df.year >= 1998) & (df.year <= years[-1])].copy()
    index = {int(v): k for k, v in enumerate(years)}
    df["risk"] = [ann[index[int(a)], c] for a, c in zip(df.year, df.cell)]
    df["heat10"] = [int((ann[(years < a) & (years >= a - 10), c] >= 0.5).sum()) for a, c in zip(df.year, df.cell)]
    df["fishing"] = [pressure["fishing"][c] for c in df.cell]

    bleach = df[df.bl.notna()]
    for label, part in (("all", bleach), ("2021+", bleach[bleach.year >= 2021])):
        hit = part.bl >= 30
        print(f"bleaching {label}: n={len(part)} countries={part.country.nunique()} AUROC={roc_auc_score(hit, part.risk):.3f}")

    cover = df[df.hc.notna()]
    clusters = pd.factorize(cover.site)[0]
    fit = smf.ols("hc ~ heat10 + notake + C(country)", data=cover).fit(cov_type="cluster", cov_kwds={"groups": clusters})
    print(f"cover n={int(fit.nobs)}: per bleaching year {fit.params.heat10:.2f} (p={fit.pvalues.heat10:.3f}), no-take {fit.params.notake:.2f} (p={fit.pvalues.notake:.3f})")

    fish = df[df.bio.notna() & (df.fishing >= 0)].assign(lbio=lambda d: np.log1p(d.bio))
    fit = smf.ols("lbio ~ notake + fishing + C(country)", data=fish).fit(cov_type="cluster", cov_kwds={"groups": pd.factorize(fish.site)[0]})
    print(f"fish n={int(fit.nobs)}: no-take x{np.exp(fit.params.notake):.2f} biomass (p={fit.pvalues.notake:.4f})")


if __name__ == "__main__":
    main()
