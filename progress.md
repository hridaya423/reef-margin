# Progress

Plan: `docs/plans/2026-11-21-reef-base-model.md`. Slides due Sunday 22 November 2026, 09:00.

## Done

- Product direction agreed: one reef response model. Lead the pitch with donor reefs and the adaptation gap. Construction impact is a secondary use.
- Labels file fetched and inspected: 41,361 rows, 62 columns, 34,515 with `Percent_Bleaching`. A copy sits in the session scratchpad and must be re-downloaded into `data/gcbd.csv` (URL in the plan).
- Data links checked by header request on 21 November: CoralTemp daily file 200 (11.7 MB for 2020-01-01, 7.4 MB for 1985-01-01), DHW daily file 200 (2.2 MB), climatology 200 (81.5 MB), PacIOOS ERDDAP 200. Guessed AWS link for the 25 km record returned 404.

## Reef scene, 21 Nov 16:30 UTC

The reef view is now a reconstructed seafloor patch (`web/src/ReefScene.tsx`), not one specimen:
- Habitat mix (coral and algae, rock, rubble, sand, seagrass) from `/habitat` area fractions for that reef, so every reef differs.
- 15 Smithsonian CC0 scans in `web/public/models/reef/` (20k-triangle versions, about 3 MB total): 6 Caribbean, 9 Indo-Pacific. Chosen by realm.
- Colony count scales with coral fraction; layout seeded by reef index.
- Each colony bleaches when the model's yearly risk passes 0.22 + 0.62 x its taxon tolerance (Acropora, Pocillopora first; massive Porites, Diploastrea, Turbinaria last; Loya et al. 2001).
- Underwater fog, caustics, marine snow, swaying seagrass.

## Redesign, 21 Nov 16:00 UTC

The default page is now `web/src/Story.tsx` (light, Lime design system, `lime.css`). The previous explorer is at `#classic` (or any `#tab=` link).
- One question: "Which reefs are worth restoring?" Map dots coloured by verdict (holds, needs tougher coral, too hot). One switch: add 0.5 °C of future warming.
- Clicking a reef shows a Smithsonian CC0 coral scan (`public/models/staghorn.glb` for the Tropical Atlantic, `pocillopora.glb` elsewhere; Draco decoder in `public/draco/`). A shader paints the scan a living brown and fades it to bleached white as the model's yearly peak risk rises; upper surfaces pale first. It autoplays 1988 to 2025 on open.
- A 38-tile year strip uses the same colour mapping; tiles are the scrubber.
- Examples: Looe Key 16175, Heron Island 442, Moorea 3005, Okinawa 17268.

## Status, 21 Nov 15:40 UTC

Repo: github.com/hridaya423/reef-margin (private; LeebanY and BeaverLeChip invited with write).

Headline metric is now **bleaching years**: years in 2016-2025 when the live model put a reef past 50% risk of at least 30% of corals bleaching, at that year's peak month. Heat margin (risk at last 3 years' peak) was 0 for 87% of reefs because the 2023-24 event sits in every window, so it could not triage.

- Serving model target switched from >=10% to >=30% (`SERVE_LEVEL = 30` in reef_app.py). Benchmark for >=30%: 0.935 vs NOAA same-day 0.906, pooled and region-macro CIs above zero.
- `years_all` / `years_shift`: re-scores each reef's yearly peak month for 2016-2025 under shifts -1.5 to +2 °C. Writes `serve/years.json`, served at `GET /years`.
- Results: median reef 1 bleaching year in 1988-1997, 4 in 2016-2025. 35% of reefs at 5+, 29% at 2 or fewer. At +1 °C the median is 9. Triage at today's climate with +0.5 °C tolerance: holds 29%, savable 62%, beyond 10%. At +0.5 °C warming no reef holds without help.
- Reef close-up: clicking a reef flies to zoom 12 in 3D. `GET /habitat?lat&lon` fetches Allen Coral Atlas benthic polygons (public WFS; it blocks the python-requests user agent, so we send `reef-margin/0.1`), cuts them into 250 m tiles, caches in Modal Dict `reef-habitat`. Coral tiles are extruded and coloured by inverse-distance interpolation between nearby 5 km cells; the scored cell is a dashed square.
- Time view: `GET /frames/meta` + `/frames/data` (466 month-ends x 18,445 cells, uint8). Time bar with play and jumps (Florida Aug 2023, GBR Mar 2024, World Apr 1998). Falls back to labelled "Preview data" if frames fail.
- Gotcha: after `modal deploy`, old web containers keep serving the old routes. Stop only the web containers (find them with `modal container logs <id>` showing GET lines), never the GPU fine-tunes.
- Visual check: headless Chromium on Modal (`scratchpad/shoot.py`), never this MacBook's screen.

Open:
- Transformer pretraining pipeline still fine-tuning; hit the 10-GPU workspace cap (jobs queue). Scratch transformer 0.69-0.72 loses to NOAA; trees ship unless pretrained runs beat them.
- What-if monotonicity with the 30% model: 72% of cells within 1 point.
- Iconic Reefs coordinates are approximate.

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

## Persuasion pass 16:30
- Home panel: world strip (share of reefs past 50% risk each year; 77% in 2024, about 11% a year in 1988 to 1997), "Best places to restore" ranking, Spermonde added first to "Try a reef".
- Local pressure and connectivity: WCS local-reef-pressures (Andrello et al. 2022, MIT, 54,596 pixels at 5 km) joined to our cells by nearest pixel (80% matched). File `web/public/data/pressure.json`, raw data in `data/pressures/`. Fields are percentiles; `pressure` is the cumulative score ranked to a percentile; `connect` ranks the 50 Reefs connectivity score; `refuge` is the 50 Reefs BCU flag.
- Ranking: savable reefs only, score = (100 - pressure) + connect, one per country in the home list. Reef panel "Will it recover?" shows pressure band, main pressure, larvae band, best action.
- Spermonde (cell 6426): holds today (0 of 10), 7 of 10 at +0.5 C, pressure 86th percentile (nitrogen 97). "Real scan" toggle embeds the SuperSplat Gaussian splat (id 392787d3) of a Mars-restored reef in Indonesia, credited. Exact site not confirmed as the same cell.
- About dialog: "Will it recover?" and "Limits and safeguards".
- Verified with headless screenshots: home, list, Spermonde model and scan views.

## Pipeline incident 16:20
- The pipeline call restarted itself at 16:16 and relaunched pretraining from step 0. Both pretrains had finished (checkpoints at step 60000, backed up to `ckpt_saved/`).
- Stopped the app, made `pipeline` skip finished stages (`ckpt/<name>.done`, existing trees and corpus), redeployed, relaunched as fc-01M7ZESW0NE4RS6D7KJD29ESQY. GBR depth download relaunched as fc-01M7ZESWATFD203KAAZMJQ12GH (curl was missing; now uses requests).

- Entity type for Realism: Open-source / Community-led (user choice, 21 Nov). About dialog has an "Open source" entry. Repo is still private; making it public is the user's call.

## Real reef scans and outside evidence 17:10
- Real Gaussian splats: Soneva Maldives restoration plots (wildflow/soneva-corals on Hugging Face, CC BY 4.0), 6 plots, lod2 (~450k splats) converted to `.splat` by `tools/splat_convert.py` (PCA levelling, floater removal, SH dropped). Rebuild with `tools/fetch_scans.sh`; output in `web/public/scans/` (gitignored, 88 MB).
- `ScanScene.tsx` renders them with Spark 2.4 (three bumped to 0.180). A dyno GLSL modifier whitens colourful mid-tone splats in noise-shaped colony patches as the model risk rises; easing is time-based.
- Stage tabs: "Real reef" (default, scan), "From satellite" (old reconstruction), "Mars reef" (Spermonde only, SuperSplat iframe).
- MERMAID (WCS open surveys, no login): `tools/mermaid_check.py` reproduces: bleaching AUROC 0.906 on 772 surveys, 0.840 on 201 surveys from 2021+ (10 countries, after training data); coral cover per bleaching year -1.91 points (p<0.001); no-take +3.21 points (p=0.002); no-take fish biomass x2.12. Shown in home panel ("proof" line) and About.
- Tried and rejected: a coral-cover model (country hold-out R2 -0.38) and a recovery model from repeat surveys (409 pairs, nothing significant). Not shipped.
- Reef soundscapes (bens-bots/marrs-global-coral-reef-soundscapes, CC BY 4.0) checked: daytime raw clips do not separate healthy from degraded by energy. Not used yet.
- Boström-Einarsson restoration database (Dryad) is behind a bot check; needs a browser download to `data/restoration/`.

## Coralytics, scans everywhere, restoration projects 17:40
- Renamed to Coralytics. Logo: "02 Decade ring" (user choice) from `design/logo-variants.html`. Mark = 22 year ticks forming a C, brown to bleached. `web/src/Mark.tsx`, assets in `web/public/brand/` (colour, black, white, icon). GitHub repo still named reef-margin; renaming it is the user's call.
- Real scans from 18 files: 6 Soneva (Maldives), 2 Galapagos_3D (Zenodo 14914807, point clouds -> disc splats via `tools/points_convert.py`), 10 Sketchfab CC BY meshes (GBR Heron/One Tree/Whitsundays, Belize, USVI x2, Okinawa, Maui, Mayotte, Thailand; `tools/mesh_convert.py` samples textured surfaces into disc splats). `web/src/scans.ts` picks the nearest scan per reef and the label states the distance. Sketchfab needs SKETCHFAB_TOKEN for `tools/fetch_scans.sh`.
- Restoration projects: Boström-Einarsson et al. 2020 database (user downloaded from Dryad; in `data/restoration/`). 304 projects, 224 within 25 km of a scored reef (`web/public/data/projects.json`). No project's location rationale names heat or bleaching. Today: 134 savable, 76 hold, 14 beyond (6%). At +0.5 C: 148 beyond (66%), 0 hold. Survival vs recent heat: no significant difference (short monitoring). Map shows projects as rings; home panel counts live with the warming switch.

## Dashboard streamline, reef history, blue mark 18:40
- Home panel is a tool, not a pitch: search by country or region, warming switch, triage bar with three shares, ranked "Best places to restore" with bleaching years and local pressure columns, CSV download of the whole scoped ranking. Pitch stats (world strip, projects block, proof line) removed from the dashboard; they live in About and the slides.
- Bleaching now accumulates. `reefHistory` in `model.ts`: each year a share of living coral bleaches (smoothstep of risk 0.25 to 0.7), 40% of bleached coral dies, dead coral regrows 14% a year. Illustrative, stated in About. The scan shows living (scan colours), bleached (white), dead (grey-green algae); the year strip shows the same three as stacked bars, plus "% of coral left".
- Name spelled Coralytics everywhere (brand files renamed). Mark gradient is ocean blue #1666a8 to pale #b9daf0 (option A).
- Search results with repeated region names show coordinates.
- Scan check (local headless Chrome, `scratchpad/shoot_local.py`, 52 s for all shots): Heron, Mayotte, Whitsundays, Belize, Galapagos look right. Maui dropped: its Sketchfab mesh is mostly a stretched base skirt with the reef on one edge. 17 scans remain. USVI is a single coral mound, framed close.

## Judging push 19:10
- Heat tolerance needed: `gainNeeded` per reef (0 to warming+1.5 °C in 0.25 steps). Reef panel shows it as a breeding target. Home panel "How much tougher must coral be?" bar chart: share of scoped reefs that hold at each gain (world today: 29% at 0, 74% at +0.25, 90% at +0.5, 97% at +0.75, 99% at +1). Clicking a bar sets the gain used for verdicts, ranking and CSV (`heat_tolerance_needed_C` column).
- Evidence: Humanes et al. 2024 Nature Communications, one generation of selection adds about 1 °C-week; so +0.5 °C is several generations. Warming 0.27 °C/decade (Forster et al. 2025, IGCC 2024) puts +0.5 °C around 2040; switch label says so.
- Live: https://coralytics.pages.dev (Cloudflare Pages project `coralytics`, deploy with `npx wrangler pages deploy dist --project-name coralytics --branch main` from `web/`; scans included, each under 25 MiB). QR code: `design/coralytics-qr.png`.
- Repo public (user approved 21 Nov: "Yes, both"): github.com/hridaya423/reef-margin, MIT LICENSE, README with banner (`.github/assets/`), description, homepage and topics set. Repo name unchanged.
- Pitch day: open the site 5 minutes before presenting so the Modal API container is warm (scaledown_window 1200 s).
- People layer: delegated (GHS-POP 2020 within 50 km per reef, `tools/people.py`, `web/public/data/people.json`). Pending.
- People layer done (subagent, verified against brute force on 33 reefs): `tools/people.py`, GHS-POP R2023A 2020 30 arcsec (doi:10.2905/2FF68A52-5B5B-4A22-8F40-C41DA8332CFE, CC BY 4.0). Median 60,300 per reef; 369.4M people within 50 km of any scored reef (deduplicated). Near reefs savable with +0.5 °C coral today: 294.6M; near reefs too hot today: 100.9M; with +0.5 °C warming, near too-hot reefs: 323.5M. Shown under each reef's name, in About, and in the CSV. Caveat from the subagent: about 5% of reefs have slightly non-monotone counts across shifts (dips of at most 3).
- Home map is a spinning globe (MapLibre 5.24.0 globe projection, @types/geojson added). Spins about 4° a second on the home view, stops on any touch, off with reduced motion; search and reef selection fly in and back out. Water tinted #c6dbe8 with an atmosphere halo.
- What people would lose (reef panel block, CSV columns, About): `tools/impact.py` joins TNC Mapping Ocean Wealth layers fetched by `tools/fetch_impact.py` (subagent; raw files in gitignored `data/impact/`). Reef tourism USD/yr within 25 km (Spalding et al. 2017, layer 314, totals match the paper's $35.8B) and people protected from flooding within 25 km (Burke and Spalding 2022, layer 11, totals 5.3M). Deduplicated near scored reefs: $30.6B/yr tourism, 3.02M flood-protected people. Today's coral fails by ~2040 (+0.5 °C) on 18,435 of 18,445 reefs; coral bred +0.5 °C would hold 5,281 of them, near $12.1B/yr tourism and 1.39M flood-protected people. TNC states no open licence; we ship per-reef sums with credit. Fisheries layer skipped (no units).
- Reef view: 'Loading the real reef scan…' label until the splat loads; timelapse waits for it (tested with a throttled scan). Ranking toggle 'Best odds of lasting' / 'Most people nearby' (sorts by people within 50 km; CSV follows the order). Flood shows 'No estimate' where people live nearby but the TNC flood layer has no figure.
