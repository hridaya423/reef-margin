// Save local context (OBIS red list, land cover, OpenStreetMap pressures) for the demo reefs to
// public/cache/local/<i>.json, so the demo does not wait on Overpass (about 30 s live) or venue wifi.
// Uses the same code as the app (src/local.ts; Node 23.6+ strips the types).
// Usage: node scripts/cache-local.mjs [reef indices...]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getLand, getPressures, getRedlist, LAND_RADIUS_KM } from "../src/local.ts";

const API = process.env.VITE_API_URL ?? "https://hridayahoney--reef-response-api-web.us-east.modal.run";
const DEMO = [442, 4313, 2342, 812, 16175, 3005, 17268];
const ids = process.argv.slice(2).map(Number);
const want = ids.length ? ids : DEMO;

const layer = await (await fetch(`${API}/layer`)).json();
const dir = new URL("../public/cache/local/", import.meta.url);
await mkdir(dir, { recursive: true });

const settle = async (label, p) => {
  try {
    return await p;
  } catch (e) {
    console.log(`  ${label} failed: ${e.message}`);
    return null;
  }
};

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

for (const i of want) {
  const r = layer.reefs[i];
  console.log(`${i} ${r.eco} (${r.lat}, ${r.lon})`);
  // Keep parts already saved; only fetch what is missing (Overpass rate-limits hard).
  const prev = await readFile(new URL(`${i}.json`, dir), "utf8").then(JSON.parse).catch(() => ({}));
  const redlist = prev.redlist ?? (await settle("red list", getRedlist(r.lat, r.lon)));
  const land = prev.land ?? (await settle("land cover", getLand(r.lat, r.lon)));
  let pressures = prev.pressures ?? null;
  if (!pressures) {
    pressures = await settle("pressures", getPressures(r.lat, r.lon));
    await sleep(15000);
  }
  const out = { at: new Date().toISOString(), radius_km: LAND_RADIUS_KM, redlist, land, pressures };
  await writeFile(new URL(`${i}.json`, dir), JSON.stringify(out));
  const byKind = {};
  for (const p of pressures ?? []) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  console.log(`  red list ${redlist?.length ?? "-"}, land ${land ? land.now.land_km2.toFixed(0) + " km2" : "-"}, pressures ${JSON.stringify(byKind)}`);
}
