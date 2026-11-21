# Prompt: presentation mode for the Reef Margin live demo

Paste everything below into Claude Code (or your coding agent) on your machine.

---

Build a presentation-mode web page for a live hackathon demo. It runs fullscreen on a projector at 1920x1080 and walks judges through three beats, one keypress each. It must never stall in front of the judges.

## Context

We are pitching "Reef Margin" in the AI Track at EcoHack 2026 (London, judged by ARIA and partners). The claim: restoration money is planted on reefs that heat will kill, and our model checks a reef before money is spent. The model is a gradient-boosted ensemble trained on 40 years of NOAA daily sea temperature and 17,000 bleaching surveys. It never saw a bleaching survey after 2020.

The full explorer app already exists. This page is different: a scripted, 60 to 75 second live segment inside the pitch. Slides carry the rest of the story.

## The live model API

Base URL: `https://hridayahoney--reef-response-api-web.us-east.modal.run`. The first request after idle can take 20 to 40 seconds (cold start), so warm it with `GET /health` when the page loads and cache everything.

- `GET /health` returns `{ ok, reefs, model }`.
- `GET /layer` returns `{ deltas: number[13], n, reefs: Reef[] }`. `deltas` is added warming in °C: 0, 0.25 ... 3.0. Each `Reef` is `{ i, lat, lon, realm, eco, country, ref, risk: number[13], dhw: number[13], margin: number | null, resid, n_hot, max_dhw, labelled }`. `risk[k]` is the chance of at least 10% of corals bleaching with `deltas[k]` °C added to that reef's last three years. `margin` is the added warming at which risk crosses 50%: 0 means already past it, null means still under 50% at +3 °C.
- `GET /replay?date=YYYY-MM-DD` scores every reef cell on that past date. Returns `{ date, i: number[], risk: number[], dhw: number[] }`. Optional bounding box: `lat0, lat1, lon0, lon1`.
- `GET /reef/{i}?warming=1&date=YYYY-MM-DD` returns one reef's detail: `{ risk[13], dhw[13], margin, weekly_sst[156], weekly_clim[156], mmm, ref, surveys, projected_dhw, donors, donor_pool }`. `weekly_sst` is three years of weekly mean sea temperature ending on `ref`. The bleaching threshold is `mmm + 1`.

## The three beats

1. **Florida, August 2023, replayed.** Map of the Florida Keys (centre about 24.75 N, 81.0 W, zoom 7). Colour every reef cell by `/replay?date=2023-08-31` risk. Ring these seven restoration sites and label them: Carysfort Reef (25.222, -80.211), Horseshoe Reef (25.139, -80.294), Cheeca Rocks (24.904, -80.616), Sombrero Reef (24.627, -81.110), Newfound Harbor (24.615, -81.395), Looe Key (24.546, -81.406), Eastern Dry Rocks (24.457, -81.845). These coordinates are approximate; check them against a map before the pitch. Caption: "Trained only on surveys up to 2020. This is what it saw on 31 August 2023." Real outcome to show after a keypress: "NOAA: under 22% of about 1,500 planted staghorn corals survived at five of the seven sites."
2. **One reef's heat margin.** Pick the reef cell nearest Looe Key. Show its risk curve against added warming (x axis +0 to +3 °C, y axis 0 to 100%, dashed line at 50%) and its margin as one large number. Animate a marker along the curve from +0 to +1.5 °C over about 2 seconds.
3. **The world, triaged.** Zoom out to the globe. Colour all reef cells by `/layer` into three groups at +1 °C warming: holds (margin ≥ 1), savable with +0.5 °C of tolerance gain (margin between 0.5 and 1), beyond reach (margin under 0.5). Show the three counts, computed from the data, never typed.

## Hard requirements

- On load, fetch `/health`, `/layer`, `/replay?date=2023-08-31` and `/reef/{looe key index}` once, then never fetch during the demo.
- Ship a fallback: a script that saves those responses to `public/cache/*.json`. If the API fails, the page loads from the cache and shows nothing different. Test it with wifi off.
- Keyboard: right arrow or space for the next beat, left arrow to go back, R to reset. No clicking needed.
- Projector legibility: body text 24px or larger, numbers 48px or larger, high contrast on a dark ground.
- Map: MapLibre GL with the CARTO style `https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json`. No API key.
- Colours: ground #0d1216, ink #e8edf0, low risk #3e6272, 50% #e2a54b, high risk #ee5a4f, savable #7fdcc4.
- Respect `prefers-reduced-motion`. Transitions under 700 ms except the map flight.

## Do not

- Invent any number. Every figure comes from the API or from this brief, with the source named in small text.
- Use em dashes or en dashes in visible text.
- Use purple gradients, glows, stock imagery, or decorative animation.
- Fake a loading state or a live connection. If the page runs from cache, a small "cached" note in the corner is fine.

## Done means

All three beats run start to finish in under 75 seconds with wifi on and with wifi off, at 1920x1080, with no console errors. Record a screen capture of the full run as a backup video.
