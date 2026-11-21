# Progress

Plan: `docs/plans/2026-11-21-reef-base-model.md`. Slides due Sunday 22 November 2026, 09:00.

## Done

- Product direction agreed: one reef response model. Lead the pitch with donor reefs and the adaptation gap. Construction impact is a secondary use.
- Labels file fetched and inspected: 41,361 rows, 62 columns, 34,515 with `Percent_Bleaching`. A copy sits in the session scratchpad and must be re-downloaded into `data/gcbd.csv` (URL in the plan).
- Data links checked by header request on 21 November: CoralTemp daily file 200 (11.7 MB for 2020-01-01, 7.4 MB for 1985-01-01), DHW daily file 200 (2.2 MB), climatology 200 (81.5 MB), PacIOOS ERDDAP 200. Guessed AWS link for the 25 km record returned 404.

## Demo app (web/)

- Vite + React + MapLibre + NumberFlow. Product name "Reef Margin" (working name).
- One figure runs every view: heat margin, the added warming before the live model puts a reef past 50% bleaching risk.
- Tabs: Reef risk, Donor reefs, Adaptation gap, Project impact. State in the URL hash.
- Talks to the Modal web API (`Api` class in reef_app.py): `GET /layer`, `GET /reef/{i}?warming=`, `POST /impact`, `GET /health`. Set `VITE_API_URL` in `web/.env.local`.
- Serving data comes from `export_serving`, which retrains a deployment LightGBM ensemble without NOAA columns and asserts feature parity between the serving code and the training table.
- Type-checks clean. Not yet rendered against the live API.

## Next steps once the pipeline finishes

1. `modal run reef_app.py --stage export` (needs features.parquet and residuals.parquet).
2. `modal deploy reef_app.py`, then put the `Api.web` URL in `web/.env.local` as `VITE_API_URL`.
3. `cd web && npm run dev`, screenshot every tab at 1440 and 390.

## Not done

- Code lives in `reef_app.py` (single Modal app). Stages: prep, extract, features, trees, corpus, pretrain, finetune.
- Extraction runs at about 5 year-files per minute across two detached apps.
- Modal GPU prices unchecked.
- The claim that outperforming reefs stay outperformers is untested (plan Task 11 Step 7).

## Results

### Labels (Modal `prep`, 21 Nov)
- 17,332 site-date surveys from 11,039 sites, 1988–2020. 7 dropped as land, 225 snapped to an ocean cell.
- 18,445 grid cells (surveyed cells plus neighbours), 3,801 labelled. NOAA's summer-maximum file is missing for 3,532 cells, so the climatology is recomputed from the temperature series.
- Splits: train 13,009 (30.1% moderate, 10.6% severe), val 1,545, test 2,771 (20.9% moderate, 7.1% severe).
- Test realms: Central Indo-Pacific 1,654, Tropical Atlantic 489, Western Indo-Pacific 313, Eastern Indo-Pacific 182.

### Provisional benchmark (database DHW column, test split, 2,728 surveys)
| Target | AUROC | AUPRC | Region-macro AUROC |
|---|---|---|---|
| Moderate (>=10%) | 0.736 | 0.460 | 0.697 (18 regions) |
| Severe (>=50%) | 0.856 | 0.299 | 0.738 (11 regions) |
- NOAA alert rule DHW>=4 for moderate: precision 0.647, recall 0.298.
- DHW>=8 for severe: precision 0.333, recall 0.097.

### Transformer smoke test
- 2.7M parameters. Overfits a 32-example batch to loss 0.0015. Pass.

### Corrected benchmark (21 Nov, after the latitude-flip fix)
NOAA's DHW and climatology files store latitude north to south; CoralTemp stores it south to north. The first DHW extraction read mirrored latitudes. Fixed in `read_points`; DHW re-extracted (83 of ~15,300 days missing). NOAA DHW now correlates 0.89 with our recomputation; 0 surveys missing.

Temporal test 2016-2020, 2,771 surveys. Tree model inputs include NOAA DHW, so the claim is "adds to NOAA", not "replaces NOAA".

| Target | Model AUROC | NOAA same-day | Pooled diff 95% CI | Region-macro diff 95% CI |
|---|---|---|---|---|
| >=10% | 0.869 | 0.797 | +0.055 to +0.088 | -0.001 to +0.072 |
| >=30% | 0.935 | 0.906 | +0.019 to +0.040 | +0.000 to +0.066 |
| >=50% | 0.939 | 0.917 | +0.012 to +0.034 | -0.020 to +0.041 |

NOAA 90-day max is weaker (0.756 at >=10%), so same-day is the fair baseline.

Held-out realms (>=10%, vs NOAA 90-day max): Central Indo-Pacific 0.848 vs 0.778 (win), Tropical Atlantic 0.725 vs 0.722 (tie), Western Indo-Pacific 0.849 vs 0.794 (pooled win, macro tie), Eastern Indo-Pacific 0.783 vs 0.691 (pooled win, macro tie).

Transformer from scratch: 0.69-0.73, loses to NOAA. Pretrained runs pending.

Outlier persistence (sites with DHW>=4 in both periods): 24 sites, rho 0.31 (p 0.14), within-ecoregion -0.32 (p 0.13). Inconclusive; do not claim persistence or non-persistence.
