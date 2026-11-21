# Reef Base Model Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `executing-plans` to implement task-by-task.

**Goal:** Train one model that takes a reef's daily sea temperature history and predicts bleaching, and show on a held-out bleaching event that it beats NOAA's Degree Heating Weeks (DHW).

**Architecture:** Extract daily temperature for every surveyed reef cell into one array. Score NOAA's published DHW on a frozen test split first, then climb a ladder: boosted trees on features from the raw series, a small transformer trained on labels, the same transformer pretrained on all extracted reef history. Every rung is scored by the same harness and the best rung ships.

**Tech Stack:** Python 3.11, uv, Modal (CPU fan-out and GPU), xarray + h5netcdf, numpy, pandas, pyarrow, scikit-learn, LightGBM, PyTorch, pytest.

**Deadline:** slides due Sunday 22 November 09:00. Freeze numbers by 07:30.

---

## Datasets

| # | Dataset | Use | Size | Status |
|---|---|---|---|---|
| 1 | Global Coral Bleaching Database, BCO-DMO 773466 v2 | Labels | 41,361 rows, 62 columns, 16.8 MB CSV. 34,515 rows have `Percent_Bleaching`. 1980–2020. | Downloaded |
| 2 | NOAA CoralTemp v3.1 daily 5 km sea temperature, 1985–now | Model input | 7.4 MB (1985) to 11.7 MB (2020) per day. About 150 GB in total (estimate). | Link verified |
| 3 | NOAA Coral Reef Watch daily 5 km DHW | The benchmark | 2.2 MB per day. About 33 GB in total (estimate). | Link verified |
| 4 | CoralTemp climatology (monthly means and summer maximum) | Heat-above-normal channel | One file, 81.5 MB | Link verified |
| 5 | PacIOOS ERDDAP `dhw_5km` | Fallback: one request per cell | Point queries | Server reachable |

URLs:

- Labels: `https://datadocs.bco-dmo.org/file/B11vA82u7y2Owp/global_bleaching_environmental.csv`
- Temperature: `https://www.star.nesdis.noaa.gov/pub/sod/mecb/crw/data/5km/v3.1_op/nc/v1.0/daily/sst/YYYY/coraltemp_v3.1_YYYYMMDD.nc`
- DHW: `https://www.star.nesdis.noaa.gov/pub/sod/mecb/crw/data/5km/v3.1_op/nc/v1.0/daily/dhw/YYYY/ct5km_dhw_v3.1_YYYYMMDD.nc`
- Climatology: `https://www.star.nesdis.noaa.gov/pub/sod/mecb/crw/data/5km/v3.1_op/climatology/nc/ct5km_climatology_v3.1.nc`
- ERDDAP: `https://pae-paha.pacioos.hawaii.edu/erddap/griddap/dhw_5km`

Not needed for the base model, listed for the work on top:

| Dataset | Use | Status |
|---|---|---|
| NOAA Pacific reef carbonate chemistry (3,034 quality-flagged samples, 55 islands) | Acidification screen | Downloaded |
| Light and wind reanalysis | Version 2 input channels | Not located |
| Climate projections | 2050 gap map. Uniform warming offsets (+0.5, +1.0, +1.5 °C) replace this for the hackathon. | Not needed |
| Bleaching surveys after 2020 | Test on the 2023–2025 event | Not located |
| Global reef extent map | Coverage beyond surveyed cells | Not located |
| 25 km temperature record on AWS | Fallback | Guessed link returned 404. Treat as unavailable. |

---

## Decisions

**Labels**
- One row per `(Site_ID, Date)`, taking the mean of `Percent_Bleaching`. Drop rows where it is missing.
- Keep surveys dated 1988-01-01 or later. Earlier surveys lack three years of temperature history.
- Targets: `y_mod = pct >= 10`, `y_sev = pct >= 50`. If the test split has fewer than 200 severe positives, lower the severe threshold to 30 and record it in `progress.md`.

**Splits, frozen before any model is trained**
- Temporal: train through 2013-12-31, validation 2014–2015, test 2016–2020.
- Spatial: leave one `Realm_Name` out, for every realm with at least 300 surveys.
- The test split is scored once per rung. Tuning uses validation only.

**Benchmark (NOAA)**
- Score per survey: the maximum of NOAA's published DHW over the 90 days ending on the survey date. Bleaching is surveyed after the heat peak, so the same-day value understates exposure. Report the same-day value as a secondary row.
- `B0-rule`: NOAA's alert thresholds, DHW ≥ 4 for moderate and DHW ≥ 8 for severe. Report precision, recall, F1.
- `B0-score`: DHW as a continuous score, no fitting. Report AUROC and AUPRC.
- `B0-logit`: logistic regression on DHW fitted on train. Gives a Brier score.

**Metrics**
- AUROC, AUPRC, Brier, pooled and region-macro. Region-macro is the mean AUROC over ecoregions that have at least 30 test surveys and both classes. It stops Florida's dense surveys from dominating.
- 95% intervals from 1,000 bootstrap resamples clustered by `Site_ID`.

**Pass criterion for "beats NOAA"**
- On the temporal test split, the model's AUROC minus `B0-score` AUROC has a 95% interval above zero, both pooled and region-macro.
- On held-out realms, the model wins in more than half of them.
- Anything less is reported as a tie.

**Leakage rules**
- Features use temperature up to and including the survey date only.
- The database's own summary columns (`TSA_DHWMax`, `SSTA_DHWMean` and similar) are computed over the whole record and leak the future. Never use them as inputs.
- No latitude or longitude as inputs. Absolute latitude is allowed. A model that memorises places absorbs the donor signal.
- The headline temporal score uses a model pretrained only on windows ending by 2013-12-31.
- The climatology is NOAA's fixed 1985–2012 file. For surveys before 2012 it contains some future data. This matches how NOAA computes DHW, so the comparison stays fair.

**Data shapes**
- `data/surveys.parquet`: `survey_id, site_id, date, lat, lon, depth_m, pct, y_mod, y_sev, source, realm, ecoregion, cell_id, split`.
- `data/cells.parquet`: `cell_id, i_lat, i_lon, lat_c, lon_c, is_labelled, mmm, clim_01..clim_12`.
- `data/sst.npy`: int16 `[n_cells, n_days]`, hundredths of a degree, `-32768` for missing. Day 0 is 1985-01-01.
- `data/dhw.npy`: same shape and scaling.
- `data/predictions.parquet`: `survey_id, rung, fold, seed, p_mod, p_sev`. Everything built later (graphs, donor residuals, what-if) reads this file.

**Cells**
- Every surveyed cell plus its eight neighbours. Expect 40,000 to 50,000 cells (estimate), so each array is about 1.5 GB.
- A coastal survey can land on a masked land cell. Snap it to the nearest ocean cell within two cells, otherwise drop the survey and count it.

**Sharing across six Modal accounts**
- Credits and Volumes do not pool across workspaces. One account runs extraction. The assembled files go to one private Hugging Face dataset repo. Every other account pulls from there into its own Volume. Use R2 if nobody has a Hugging Face token.

---

## Repo layout

```
pyproject.toml
progress.md
src/reef/labels.py      load and clean surveys, assign splits
src/reef/metrics.py     scores, region-macro, clustered bootstrap
src/reef/grid.py        lat/lon to cell, neighbours, land snapping
src/reef/extract.py     Modal app: one year of files to one shard
src/reef/assemble.py    shards to sst.npy and dhw.npy
src/reef/noaa.py        the three benchmark rows
src/reef/heat.py        hotspot and DHW recomputed from temperature
src/reef/features.py    tree features from a series
src/reef/trees.py       LightGBM train and predict
src/reef/windows.py     series to model tensors, apply_delta
src/reef/model.py       transformer encoder and heads
src/reef/pretrain.py    Modal GPU job
src/reef/finetune.py    Modal GPU job
src/reef/evaluate.py    one results table for all rungs and splits
tests/
data/                   gitignored
```

---

### Task 0: Project setup

**Files:** Create `pyproject.toml`, `.gitignore`, `src/reef/__init__.py`, `tests/__init__.py`.

**Step 1:** `uv init --package reef-response` inside `~/honey/reef-response`, then `uv add numpy pandas pyarrow scikit-learn lightgbm xarray h5netcdf requests modal torch huggingface_hub` and `uv add --dev pytest`.
**Step 2:** Add `data/` to `.gitignore`.
**Step 3:** Copy the labels CSV to `data/gcbd.csv`.
**Step 4:** Run `uv run pytest -q`. Expected: "no tests ran".
**Step 5:** Each teammate runs `uv run modal token new --profile <name>`. Later commands select an account with `MODAL_PROFILE=<name>`. Confirm the profile flag against Modal's docs on first use.

### Task 1: Labels and splits

**Files:** Create `src/reef/labels.py`, `tests/test_labels.py`.

**Step 1: Write the failing tests**
- `test_one_row_per_site_date`: two input rows with the same `Site_ID` and `Date` and percentages 10 and 30 give one row with 20.
- `test_split_boundaries`: 2013-12-31 is train, 2014-01-01 is validation, 2015-12-31 is validation, 2016-01-01 is test.
- `test_drops_missing_and_early`: a row with missing percentage and a row dated 1987 are both dropped.
- `test_targets`: 9.9 gives `y_mod` 0, 10 gives 1, 50 gives `y_sev` 1.

**Step 2:** `uv run pytest tests/test_labels.py -v`. Expected: FAIL, `load_surveys` not defined.
**Step 3: Implement** `load_surveys(csv_path) -> DataFrame` with the `surveys.parquet` columns except `cell_id`. Read with `na_values=["nd"]`.
**Step 4:** Same command. Expected: PASS.
**Step 5:** Print survey counts and positive rates per split and per realm. Record them in `progress.md`. Apply the severe-threshold rule above.

### Task 2: Metrics harness

**Files:** Create `src/reef/metrics.py`, `tests/test_metrics.py`.

**Step 1: Write the failing tests**
- `test_region_macro_ignores_small_and_single_class`: three regions, one with 10 rows, one all-negative, one valid with a hand-computed AUROC of 0.75. Result is 0.75.
- `test_perfect_and_random`: perfect scores give AUROC 1.0, constant scores give 0.5.
- `test_bootstrap_clusters_by_site`: with every site duplicated, the interval is no narrower than without duplication.

**Step 2:** Run. Expected: FAIL.
**Step 3: Implement** `score(y, p, regions, sites) -> dict` returning pooled and region-macro AUROC, AUPRC, Brier, each with a 95% interval. Implement `paired_diff(y, p_a, p_b, sites)` for the model-minus-benchmark interval, resampling the same sites for both.
**Step 4:** Run. Expected: PASS.

### Task 3: Provisional benchmark, no downloads

**Files:** Create `src/reef/noaa.py`, `tests/test_noaa.py`.

The labels file carries a DHW column, `TSA_DHW`, computed by the database authors from a different temperature product. It gives a benchmark number within minutes. Label it provisional. Task 6 replaces it with NOAA's own values.

**Step 1: Write the failing test** `test_rule_thresholds`: DHW values 3.9, 4.0, 8.0 give moderate alerts 0, 1, 1 and severe alerts 0, 0, 1.
**Step 2:** Run. Expected: FAIL.
**Step 3: Implement** `benchmark_rows(surveys, dhw_col) -> DataFrame` producing `B0-rule`, `B0-score`, `B0-logit`.
**Step 4:** Run. Expected: PASS.
**Step 5:** Run it on the test split with `dhw_col="TSA_DHW"`. Write the three rows to `progress.md` under "provisional benchmark".

### Task 4: Grid and cells

**Files:** Create `src/reef/grid.py`, `tests/test_grid.py`.

**Step 1:** Download one temperature file, one DHW file and the climatology file to `data/sample/`. Print each header with `uv run python -c "import xarray as xr,sys; print(xr.open_dataset(sys.argv[1]))" <file>`. Record the variable names, the scale factor, the fill value and whether latitude runs north to south. Expected names, to confirm: `analysed_sst`, `degree_heating_week`, `sst_clim_mmm`.

**Step 2: Write the failing tests**
- `test_cell_index_corners`: the first and last grid coordinates read from the sample file map to `(0, 0)` and `(3599, 7199)`.
- `test_neighbours`: an interior cell gives nine cells, and a cell on the date line wraps in longitude.
- `test_snap_to_ocean`: a masked cell with a valid neighbour one cell east snaps to it. A masked cell with no valid cell within two is dropped.

**Step 3:** Run. Expected: FAIL.
**Step 4: Implement** `latlon_to_cell`, `neighbours`, `snap_to_ocean(mask)` and `build_cells(surveys, sample_file, clim_file) -> (cells, surveys_with_cell_id)`.
**Step 5:** Run. Expected: PASS.
**Step 6:** Build `data/cells.parquet` and `data/surveys.parquet`. Record the cell count and the number of dropped surveys in `progress.md`.

### Task 5: Extraction on Modal

**Files:** Create `src/reef/extract.py`, `src/reef/assemble.py`, `tests/test_assemble.py`.

**Step 1: Implement** `extract_year(year, kind)` as a Modal function with a 1-hour timeout and a Volume named `reef-data`. For each day: download to `/tmp`, read the full grid, index the cell list, append one int16 row, delete the file. Eight download threads. Three retries with backoff. A day that still fails is written as the missing sentinel and logged. Output: `shards/{kind}_{year}.npy` with shape `[n_days, n_cells]`.
**Step 2:** `uv run modal run src/reef/extract.py --year 2020 --kind sst`. Record the wall time and failed-day count. This measures NOAA's throughput, the one unknown in the plan.
**Step 3:** Decide concurrency from Step 2. Start at 10 containers. If Step 2 shows throttling or errors, drop to 4.
**Step 4:** Run all years for `dhw` first (33 GB, unblocks the benchmark), then `sst`.
**Step 5: Write the failing test** `test_assemble_orders_days`: shards for two fake years concatenate in date order, and a leap year has 366 columns.
**Step 6: Implement** `assemble(kind) -> data/{kind}.npy` transposed to `[n_cells, n_days]`.
**Step 7:** Run. Expected: PASS. Upload `sst.npy`, `dhw.npy`, `cells.parquet`, `surveys.parquet` to the shared repo.

**Fallback:** if NOAA's file server is unusable, query ERDDAP once per labelled cell for the full series. This supports the benchmark, the trees and the label-only transformer. The pretraining corpus shrinks to labelled cells.

### Task 6: Official NOAA benchmark

**Files:** Modify `src/reef/noaa.py`, `tests/test_noaa.py`.

**Step 1: Write the failing test** `test_dhw_window_max`: for a synthetic series with DHW 6 at 40 days before the survey and 2 on the day, the 90-day score is 6 and the same-day score is 2.
**Step 2:** Run. Expected: FAIL.
**Step 3: Implement** `dhw_at_surveys(surveys, dhw, window_days=90)`.
**Step 4:** Run. Expected: PASS.
**Step 5:** Produce the three benchmark rows on the test split and on each held-out realm. Write them to `data/results.parquet` and `progress.md`. This is the number to beat.

### Task 7: Boosted trees (rung 1)

**Files:** Create `src/reef/heat.py`, `src/reef/features.py`, `src/reef/trees.py`, `tests/test_heat.py`, `tests/test_features.py`.

**Step 1: Write the failing tests**
- `test_recomputed_dhw_matches_noaa`: for 200 sampled cells and 50 dates, DHW recomputed from temperature and the summer maximum is within 0.3 of NOAA's value. This validates the heat code that every feature uses.
- `test_no_future`: changing temperature after the survey date leaves every feature unchanged.
- `test_missing_days`: a series with a 5-day gap gives finite features.

**Step 2:** Run. Expected: FAIL.
**Step 3: Implement** `hotspot(sst, mmm)`, `dhw(hotspot, weeks, threshold)` and `build_features(series, day_index, static) -> vector`. Features:
- Accumulated heat over 4, 8, 12, 16 and 24 weeks, at thresholds 0 and 1 °C above the summer maximum.
- Maximum hotspot over 30 and 90 days. Mean temperature over 7, 30 and 90 days.
- Departure from the day-of-year normal, averaged over 30 and 90 days.
- Heating rate: slope of temperature over the last 30 and 60 days.
- Variability: standard deviation of day-to-day change over 30 and 90 days.
- Days above the summer maximum in the last 90 and 365 days.
- Days since the last DHW ≥ 4, capped at 3,650.
- Peak DHW in each of the previous three years, the all-time peak before the last year, and the count of past years with DHW ≥ 4.
- Mean and spread of hotspot across the eight neighbours.
- Summer maximum, seasonal range, absolute latitude, depth, months from the warmest climatological month.

**Step 4:** Run. Expected: PASS.
**Step 5: Implement** `train_trees(X, y, X_val, y_val)` with LightGBM, early stopping on validation, and a monotone-increasing constraint on the 12-week accumulation and the 90-day maximum hotspot.
**Step 6:** Train for both targets. Score on test and held-out realms. Append predictions to `data/predictions.parquet` and rows to `data/results.parquet`.
**Gate 1:** if rung 1 passes the criterion, the pitch claim is secured. Everything after this improves the number.

### Task 8: Windows and the what-if operator

**Files:** Create `src/reef/windows.py`, `tests/test_windows.py`.

**Step 1: Write the failing tests**
- `test_window_shape`: a survey gives a `[1092, 3]` tensor (departure from day-of-year normal, hotspot, valid mask) ending on the survey date.
- `test_apply_delta_no_adaptation`: adding 1.5 °C from a start day raises temperature by exactly 1.5 on and after that day and leaves the climatology unchanged.
- `test_apply_delta_full_adaptation`: adding the same shift to temperature and climatology leaves hotspot unchanged.
- `test_history_vector`: the annual-peak vector contains only years before the window.

**Step 2:** Run. Expected: FAIL.
**Step 3: Implement** `make_window(cell, day)`, `history_vector(cell, day)`, `static_vector(cell, survey)`, and `apply_delta(sst, clim, start_day, delta, adapt: bool)`. The trees and the transformer both call `apply_delta`, so the what-if has one definition.
**Step 4:** Run. Expected: PASS.

### Task 9: Transformer and pretraining

**Files:** Create `src/reef/model.py`, `src/reef/pretrain.py`, `tests/test_model.py`.

**Step 1: Write the failing tests**
- `test_forward_shapes`: a batch of 4 gives two logits per example.
- `test_mask_spans`: the masked fraction is between 0.3 and 0.5 and masks form contiguous runs of 4 to 12 patches.
- `test_overfits_tiny_batch`: 32 examples reach training loss below 0.05 in 300 steps. A model that cannot do this has a wiring bug.

**Step 2:** Run. Expected: FAIL.
**Step 3: Implement** the encoder: 7-day patches give 156 tokens, a linear patch embedding to width 192, one token for the static vector, one for the history vector, one class token, 6 layers, 6 heads, dropout 0.1. Two heads: a reconstruction head for pretraining and a two-logit head for fine-tuning. About 3 million parameters.
**Step 4:** Run. Expected: PASS.
**Step 5: Implement** `pretrain(cutoff_day)` as a Modal GPU function. Sample windows at random from all cells with the window end at or before `cutoff_day`. Mask contiguous spans covering about 40% of patches, and half the time also mask the last four patches. Huber loss on masked patches. AdamW, learning rate 3e-4, cosine decay, 2,000 warm-up steps, batch 512, mixed precision, 100,000 steps. Checkpoint every 10,000 steps to the Volume.
**Step 6:** Run a 2,000-step smoke test. Expected: validation reconstruction loss falls and beats linear interpolation across the masked span. If it does not beat interpolation, lengthen the spans before running the full job.
**Step 7:** Launch two runs on two accounts: `pre_2013` (cutoff 2013-12-31) and `pre_full`.

### Task 10: Fine-tuning (rungs 2 and 3)

**Files:** Create `src/reef/finetune.py`.

**Step 1: Implement** `finetune(init, fold, seed)` as a Modal GPU function. `init` is `scratch`, `pre_2013` or `pre_full`. Binary cross-entropy on both targets. Each survey is weighted by one over the square root of the survey count in its ecoregion and year. Learning rate 1e-4 for the encoder and 1e-3 for the head. Up to 15 epochs, early stopping on validation region-macro AUROC.
**Step 2:** Run `scratch` and `pre_2013` on the temporal split, three seeds each. Score on test.
**Gate 2:** compare `pre_2013` against rung 1 and `scratch` on the test split.
- `pre_2013` beats rung 1: it becomes the engine.
- It ties or loses: rung 1 is the engine. Report the transformer as an ablation.
- `pre_2013` does not beat `scratch`: pretraining did not help. Say so and stop spending on it.

### Task 11: Ensemble, held-out realms, final table

**Files:** Create `src/reef/evaluate.py`, `tests/test_evaluate.py`.

**Step 1:** For the winning rung, train 10 seeds on the temporal split and 3 seeds per held-out realm. Fan these out across the remaining accounts.
**Step 2: Write the failing test** `test_ensemble_interval`: for three member predictions 0.2, 0.4, 0.6 the mean is 0.4 and the interval spans 0.2 to 0.6.
**Step 3: Implement** `ensemble(predictions)`, then isotonic calibration fitted on validation.
**Step 4:** Run. Expected: PASS.
**Step 5:** Build the final table: every rung by every split, with intervals and the paired difference against `B0-score`.
**Step 6: What-if sanity check.** For 2,000 random test surveys, add 0, 0.5, 1, 2 and 3 °C from one year before the survey with `adapt=False`. Pass: predicted risk never falls with added heat on at least 95% of surveys. Below that, the what-if mode is not shown.
**Step 7: Outlier persistence check.** Using out-of-fold predictions, compute each site's mean residual through 2015 and from 2016 on, for surveys with DHW ≥ 4. Report the rank correlation within ecoregions. A value near zero means the donor signal is noise, and the pitch says so.
**Step 8:** Freeze `data/results.parquet` and `data/predictions.parquet`. Graphs, the donor list and the gap map read these two files.

---

## Compute and people

| Account | Job |
|---|---|
| 1 | Extraction (CPU), then hosting the shared files |
| 2 | Pretraining `pre_2013` |
| 3 | Pretraining `pre_full` |
| 4, 5 | Fine-tuning seeds and held-out realms |
| 6 | Reserve, then a prediction endpoint for the demo |

The models are small. Expected spend is a fraction of the $510. Check current GPU prices on Modal's pricing page before launching the overnight jobs. The constraint is hours.

Three people can start at once: one on Tasks 4 and 5, one on Tasks 1, 2, 3, 6 and 7, one on Tasks 8, 9 and 10 against synthetic series until the real arrays land.

## Order and cut-offs

1. Tasks 0 to 3: provisional benchmark number.
2. Tasks 4 to 6: official benchmark number.
3. Task 7: rung 1 scored. Gate 1.
4. Tasks 8 to 10: rungs 2 and 3. Gate 2.
5. Task 11 runs overnight.
6. 07:30 Sunday: freeze numbers. Whatever rung is best at that point ships.

## Risks

- **NOAA download speed is unmeasured.** Task 5 Step 2 measures it on one year before anything else is launched.
- **The transformer may only tie the trees.** Gate 1 secures the claim before any GPU is used.
- **Survey bias.** People survey when they expect bleaching. Region-macro scores and site-clustered intervals reduce this and do not remove it.
- **The model is correlational.** The what-if output is shown only if it passes the sanity check, and always as two bounds: no adaptation and full adaptation.
- **Variable names in the NOAA files are from memory.** Task 4 Step 1 confirms them.
