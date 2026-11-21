// Local context around a reef: at-risk species (OBIS), land cover (Impact Observatory 10 m via Esri),
// coastal development and rivers (OpenStreetMap via Overpass), and IMOS acoustic telemetry (precomputed).
// None of these are model inputs. Demo reefs read saved copies from /cache/local and /telemetry first.
// Plain fetch and erasable TypeScript only, so scripts/cache-local.mjs can import this file in Node.

export type Category = "CR" | "EN" | "VU" | "NT" | "LC" | "DD";
export type RedSpecies = { name: string; common: string | null; category: Category; records: number; group: string };

export const LAND_CLASSES = {
  1: "Water",
  2: "Trees",
  4: "Flooded vegetation",
  5: "Crops",
  7: "Built area",
  8: "Bare ground",
  9: "Snow or ice",
  10: "Clouds",
  11: "Rangeland",
} as const;
export type LandYear = { year: number; land_km2: number; km2: Record<string, number> };
export type Land = { radius_km: number; now: LandYear; then: LandYear | null };

export type PressureKind = "port" | "marina" | "sewage" | "resort" | "industrial" | "airport" | "coastal works" | "river";
export type Pressure = { kind: PressureKind; name: string | null; lat: number; lon: number; km: number };

export type Local = { at: string; radius_km: number; redlist: RedSpecies[] | null; land: Land | null; pressures: Pressure[] | null };

export type Telemetry = {
  reef: { i: number; name: string; lat: number; lon: number };
  radius_km: number;
  source: string;
  stations: { name: string; lat: number; lon: number; animals: number; detections: number; first: string; last: string }[];
  species: { common: string | null; scientific: string | null; animals: number; days: number; first: string; last: string }[];
  links: { station: string; lat: number; lon: number; km: number; animals: number; species: string[] }[];
};

const OBIS = "https://api.obis.org/v3/checklist/redlist";
const LULC = "https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer";
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

export const SPECIES_RADIUS_KM = 11;
export const LAND_RADIUS_KM = 25;

// Common names for well-known reef species; OBIS returns scientific names only.
const COMMON: Record<string, string> = {
  "Chelonia mydas": "Green turtle",
  "Caretta caretta": "Loggerhead turtle",
  "Eretmochelys imbricata": "Hawksbill turtle",
  "Natator depressus": "Flatback turtle",
  "Dermochelys coriacea": "Leatherback turtle",
  "Dugong dugon": "Dugong",
  "Rhincodon typus": "Whale shark",
  "Sphyrna mokarran": "Great hammerhead",
  "Sphyrna lewini": "Scalloped hammerhead",
  "Galeocerdo cuvier": "Tiger shark",
  "Carcharhinus amblyrhynchos": "Grey reef shark",
  "Carcharhinus melanopterus": "Blacktip reef shark",
  "Carcharhinus leucas": "Bull shark",
  "Triaenodon obesus": "Whitetip reef shark",
  "Stegostoma tigrinum": "Zebra shark",
  "Mobula alfredi": "Reef manta ray",
  "Mobula birostris": "Giant manta ray",
  "Glaucostegus typus": "Giant shovelnose ray",
  "Aetobatus ocellatus": "Ocellated eagle ray",
  "Cheilinus undulatus": "Humphead wrasse",
  "Bolbometopon muricatum": "Bumphead parrotfish",
  "Tridacna gigas": "Giant clam",
};

const RANK: Record<string, number> = { CR: 0, EN: 1, VU: 2, NT: 3, LC: 4, DD: 5 };

function groupOf(t: Record<string, string | undefined>): string {
  if (t.order === "Testudines") return "Turtles";
  if (t.class === "Mammalia") return "Mammals";
  if (t.class === "Hexacorallia" || t.class === "Anthozoa" || t.class === "Octocorallia") return "Corals";
  if (t.class === "Elasmobranchii") return "Sharks and rays";
  if (t.class === "Teleostei" || t.class === "Actinopteri") return "Fish";
  if (t.class === "Aves") return "Seabirds";
  if (t.class === "Holothuroidea") return "Sea cucumbers";
  if (t.class === "Bivalvia" || t.class === "Gastropoda") return "Molluscs";
  return "Other";
}

// Coral genera (and three species) found only in the Atlantic. On an Indo-Pacific reef such a record is
// almost certainly a misidentification, e.g. Agaricia humilis and Orbicella annularis at Orpheus Island.
const ATLANTIC_CORALS =
  /^(Agaricia|Colpophyllia|Dendrogyra|Dichocoenia|Diploria|Eusmilia|Helioseris|Isophyllia|Manicina|Meandrina|Montastraea|Mussa|Mycetophyllia|Orbicella|Pseudodiploria|Solenastrea|Undaria)\b|^(Acropora palmata|Acropora cervicornis|Porites astreoides)$/;

/** Drops Atlantic-only corals from Indo-West Pacific reefs (30°E eastward to 120°W). */
export function inRange(list: RedSpecies[], lon: number): RedSpecies[] {
  const indoPacific = lon >= 30 || lon <= -120;
  return indoPacific ? list.filter((s) => !(s.group === "Corals" && ATLANTIC_CORALS.test(s.name))) : list;
}

function box(lat: number, lon: number, km: number) {
  const dLat = km / 111.32;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * p) / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export async function getRedlist(lat: number, lon: number, signal?: AbortSignal): Promise<RedSpecies[]> {
  const b = box(lat, lon, SPECIES_RADIUS_KM);
  const wkt = `POLYGON((${b.w} ${b.s},${b.e} ${b.s},${b.e} ${b.n},${b.w} ${b.n},${b.w} ${b.s}))`;
  const res = await fetch(`${OBIS}?geometry=${encodeURIComponent(wkt)}&size=500`, { signal });
  if (!res.ok) throw new Error(`OBIS returned ${res.status}`);
  const body = (await res.json()) as { results: Record<string, string | number | undefined>[] };
  return body.results
    .map((t) => ({
      name: String(t.scientificName),
      common: COMMON[String(t.scientificName)] ?? null,
      category: String(t.category) as Category,
      records: Number(t.records ?? 0),
      group: groupOf(t as Record<string, string | undefined>),
    }))
    .sort((a, b) => RANK[a.category] - RANK[b.category] || b.records - a.records);
}

async function landYear(lat: number, lon: number, year: number, signal?: AbortSignal): Promise<LandYear> {
  const b = box(lat, lon, LAND_RADIUS_KM);
  const geometry = JSON.stringify({ xmin: b.w, ymin: b.s, xmax: b.e, ymax: b.n, spatialReference: { wkid: 4326 } });
  const px = 0.001;
  const pixelSize = JSON.stringify({ x: px, y: px, spatialReference: { wkid: 4326 } });
  const time = `${Date.UTC(year, 0, 1)},${Date.UTC(year, 11, 31)}`;
  const q = new URLSearchParams({ geometry, geometryType: "esriGeometryEnvelope", pixelSize, time, f: "json" });
  const res = await fetch(`${LULC}/computeHistograms?${q}`, { signal });
  if (!res.ok) throw new Error(`Land cover returned ${res.status}`);
  const body = (await res.json()) as { histograms?: { counts: number[] }[] };
  const counts = body.histograms?.[0]?.counts;
  if (!counts) throw new Error("No land cover for this area");
  const pxKm2 = px * 111.32 * (px * 111.32 * Math.cos((lat * Math.PI) / 180));
  const km2: Record<string, number> = {};
  let land = 0;
  for (const [v, name] of Object.entries(LAND_CLASSES)) {
    const c = counts[Number(v)] ?? 0;
    if (!c) continue;
    km2[name] = c * pxKm2;
    if (name !== "Water" && name !== "Clouds") land += c * pxKm2;
  }
  return { year, land_km2: land, km2 };
}

export async function getLand(lat: number, lon: number, signal?: AbortSignal): Promise<Land> {
  const [now, then] = await Promise.all([landYear(lat, lon, 2024, signal), landYear(lat, lon, 2017, signal).catch(() => null)]);
  return { radius_km: LAND_RADIUS_KM, now, then };
}

const KIND: [PressureKind, (t: Record<string, string>) => boolean][] = [
  ["river", (t) => t.waterway === "river"],
  ["port", (t) => t.landuse === "port" || t.industrial === "port"],
  ["marina", (t) => t.leisure === "marina"],
  ["sewage", (t) => t.man_made === "wastewater_plant"],
  ["resort", (t) => t.tourism === "resort"],
  ["airport", (t) => t.aeroway === "aerodrome"],
  ["coastal works", (t) => ["pier", "breakwater", "groyne"].includes(t.man_made)],
  ["industrial", (t) => t.landuse === "industrial"],
];

export async function getPressures(lat: number, lon: number, signal?: AbortSignal): Promise<Pressure[]> {
  const b = box(lat, lon, LAND_RADIUS_KM);
  const bb = `(${b.s},${b.w},${b.n},${b.e})`;
  const q = `[out:json][timeout:40];(way["waterway"="river"]${bb};nwr["landuse"="port"]${bb};nwr["industrial"="port"]${bb};nwr["leisure"="marina"]${bb};nwr["man_made"="wastewater_plant"]${bb};nwr["tourism"="resort"]${bb};nwr["landuse"="industrial"]${bb};nwr["aeroway"="aerodrome"]${bb};nwr["man_made"~"^(pier|breakwater|groyne)$"]${bb};);out center tags;`;
  let last: Error = new Error("Overpass unavailable");
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }), signal });
      if (!res.ok) throw new Error(`Overpass returned ${res.status}`);
      const body = (await res.json()) as { elements: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] };
      const out: Pressure[] = [];
      const seenRiver = new Set<string>();
      for (const el of body.elements) {
        const t = el.tags ?? {};
        const kind = KIND.find(([, test]) => test(t))?.[0];
        const at = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : null);
        if (!kind || !at) continue;
        if (kind === "river") {
          const key = t.name ?? `${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
          if (seenRiver.has(key)) continue;
          seenRiver.add(key);
        }
        out.push({ kind, name: t.name ?? null, lat: at.lat, lon: at.lon, km: distanceKm(lat, lon, at.lat, at.lon) });
      }
      return out.sort((a, c) => a.km - c.km);
    } catch (e) {
      if (signal?.aborted) throw e;
      last = e as Error;
    }
  }
  throw last;
}

async function cached<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(path, { signal });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Local context for one reef: the saved copy for demo reefs, otherwise live calls (each part may fail on its own). */
export async function getLocal(i: number, lat: number, lon: number, signal?: AbortSignal): Promise<Local> {
  const saved = await cached<Local>(`/cache/local/${i}.json`, signal);
  if (saved) return saved;
  const [redlist, land, pressures] = await Promise.all([
    getRedlist(lat, lon, signal).catch(() => null),
    getLand(lat, lon, signal).catch(() => null),
    getPressures(lat, lon, signal).catch(() => null),
  ]);
  return { at: new Date().toISOString(), radius_km: LAND_RADIUS_KM, redlist, land, pressures };
}

export const getTelemetry = (i: number, signal?: AbortSignal) => cached<Telemetry>(`/telemetry/${i}.json`, signal);
