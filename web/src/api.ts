export type Reef = {
  i: number;
  lat: number;
  lon: number;
  realm: string;
  eco: string;
  country: string;
  ref: string;
  risk: number[];
  dhw: number[];
  margin: number | null;
  resid: number | null;
  n_hot: number;
  max_dhw: number | null;
  labelled: boolean;
};

export type Layer = { deltas: number[]; n: number; reefs: Reef[]; model: string; level?: number };

export type Donor = {
  i: number;
  lat: number;
  lon: number;
  eco: string;
  country: string;
  resid: number;
  n_hot: number;
  max_dhw: number;
  km: number;
};

export type Survey = [year: number, month: number, pct: number, dhw: number, resid: number];

export type ReefDetail = {
  i: number;
  risk: number[];
  dhw: number[];
  margin: number | null;
  weekly_sst: number[];
  weekly_clim: number[];
  mmm: number;
  ref: string;
  surveys: Survey[];
  projected_dhw: number;
  donors: Donor[];
  donor_pool: number;
};

export type ImpactRow = {
  i: number;
  lat: number;
  lon: number;
  eco: string;
  km: number;
  added_c: number;
  risk_before: number;
  risk_after: number;
  dhw_before: number;
  dhw_after: number;
};

export type ImpactQuery = { lat: number; lon: number; delta_c: number; radius_km: number };
export type ImpactResult = { affected: ImpactRow[]; searched_km: number };

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) throw new Error(`The model returned ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export const getLayer = (signal?: AbortSignal) => call<Layer>("/layer", { signal });

export const getReef = (i: number, warming: number, date: string | null, signal?: AbortSignal) =>
  call<ReefDetail>(`/reef/${i}?warming=${warming}${date ? `&date=${date}` : ""}`, { signal });

export type HabitatClass = "Coral/Algae" | "Rock" | "Rubble" | "Seagrass" | "Sand" | "Microalgal Mats";
export type Habitat = GeoJSON.FeatureCollection<GeoJSON.Geometry, { c: HabitatClass; x: number; y: number; a: number }> & {
  center: [number, number];
  area_km2: Partial<Record<HabitatClass, number>>;
};

export const getHabitat = (lat: number, lon: number, signal?: AbortSignal) => call<Habitat>(`/habitat?lat=${lat}&lon=${lon}`, { signal });

export type Replay = { date: string; i: number[]; risk: number[]; dhw: number[] };

export const getReplay = (date: string, signal?: AbortSignal) => call<Replay>(`/replay?date=${date}`, { signal });

export const postImpact = (q: ImpactQuery, signal?: AbortSignal) =>
  call<ImpactResult>("/impact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(q),
    signal,
  });

export type Years = { years: number[]; n: number; scale: number; ann: Uint8Array; shifts: number[]; window: [number, number]; counts: Uint8Array };

export async function getYears(signal?: AbortSignal): Promise<Years> {
  const raw = await call<{ years: number[]; n: number; scale: number; ann: string; shifts: number[]; window: [number, number]; counts: string }>("/years", { signal });
  const bytes = (b64: string) => Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return { ...raw, ann: bytes(raw.ann), counts: bytes(raw.counts) };
}

export type Depth = { source: string | null; citation?: string; res_m?: number; on_coral?: boolean; median?: number; p10?: number; p90?: number; n?: number };

export const getDepth = (lat: number, lon: number, signal?: AbortSignal) => call<Depth>(`/depth?lat=${lat}&lon=${lon}`, { signal });
