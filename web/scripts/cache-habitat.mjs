// Save /habitat responses for the demo reefs to public/cache/habitat/<i>.json,
// so the reef scene loads without calling the Allen Coral Atlas during a demo.
// Usage: node scripts/cache-habitat.mjs [reef indices...]
import { mkdir, writeFile } from "node:fs/promises";

const API = process.env.VITE_API_URL ?? "https://hridayahoney--reef-response-api-web.us-east.modal.run";
const DEMO = [16175, 442, 3005, 17268, 4313, 2342, 812];
const ids = process.argv.slice(2).map(Number);
const want = ids.length ? ids : DEMO;

const layer = await (await fetch(`${API}/layer`)).json();
const dir = new URL("../public/cache/habitat/", import.meta.url);
await mkdir(dir, { recursive: true });

for (const i of want) {
  const r = layer.reefs[i];
  const res = await fetch(`${API}/habitat?lat=${r.lat}&lon=${r.lon}`);
  if (!res.ok) {
    console.log(`${i}: ${res.status}, not cached`);
    continue;
  }
  // The story page only reads area_km2 (mixOf), so drop the polygons and keep the file tiny.
  const h = await res.json();
  const slim = { type: "FeatureCollection", features: [], center: h.center, area_km2: h.area_km2, cached: true };
  await writeFile(new URL(`${i}.json`, dir), JSON.stringify(slim));
  console.log(`${i} ${r.eco}: areas ${JSON.stringify(h.area_km2)}`);
}
