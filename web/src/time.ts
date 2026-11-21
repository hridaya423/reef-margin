import { API, type Reef } from "./api";

export type Frames = { dates: string[]; n: number; scale: number; data: Uint8Array; preview: boolean };

export async function getFrames(signal?: AbortSignal): Promise<Frames> {
  const meta = await fetch(`${API}/frames/meta`, { signal });
  if (!meta.ok) throw new Error(`frames ${meta.status}`);
  const m = (await meta.json()) as { dates: string[]; n: number; scale: number };
  const bin = await fetch(`${API}/frames/data`, { signal });
  if (!bin.ok) throw new Error(`frames ${bin.status}`);
  const data = new Uint8Array(await bin.arrayBuffer());
  if (data.length !== m.dates.length * m.n) throw new Error("Frame data does not match its index");
  return { ...m, data, preview: false };
}

const EVENTS: Record<number, number> = { 1998: 1.5, 2002: 1.2, 2005: 1.25, 2010: 1.3, 2016: 1.5, 2017: 1.3, 2020: 1.3, 2023: 1.6, 2024: 1.6 };

export function previewFrames(reefs: Reef[]): Frames {
  const dates: string[] = [];
  for (let y = 1988; y <= 2026; y++) {
    for (let mo = 1; mo <= 12; mo++) {
      if (y === 2026 && mo > 10) break;
      const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      dates.push(`${y}-${String(mo).padStart(2, "0")}-${String(last).padStart(2, "0")}`);
    }
  }
  const n = reefs.length;
  const scale = 250;
  const data = new Uint8Array(dates.length * n);
  dates.forEach((d, t) => {
    const y = Number(d.slice(0, 4));
    const mo = Number(d.slice(5, 7));
    const trend = 0.35 + (0.65 * (y - 1988)) / 38;
    const boost = EVENTS[y] ?? 1;
    for (let k = 0; k < n; k++) {
      const r = reefs[k];
      const peak = r.lat >= 0 ? 9 : 3;
      const season = Math.max(0, Math.cos((2 * Math.PI * (mo - peak)) / 12));
      const v = Math.min(1, r.risk[0] * season * trend * boost);
      data[t * n + k] = Math.round(v * scale);
    }
  });
  return { dates, n, scale, data, preview: true };
}

export function frameRow(f: Frames, t: number) {
  const out = new Array<number>(f.n);
  for (let k = 0; k < f.n; k++) out[k] = f.data[t * f.n + k] / f.scale;
  return out;
}

export function shareAbove(f: Frames, level: number) {
  const cut = level * f.scale;
  const out = new Float32Array(f.dates.length);
  for (let t = 0; t < f.dates.length; t++) {
    let c = 0;
    for (let k = 0; k < f.n; k++) if (f.data[t * f.n + k] >= cut) c++;
    out[t] = c / f.n;
  }
  return out;
}

export function frameColumn(f: Frames, k: number) {
  const out = new Float32Array(f.dates.length);
  for (let t = 0; t < f.dates.length; t++) out[t] = f.data[t * f.n + k] / f.scale;
  return out;
}

export function indexOfDate(f: Frames, date: string) {
  const ym = date.slice(0, 7);
  const k = f.dates.findIndex((d) => d.slice(0, 7) === ym);
  return k < 0 ? f.dates.length - 1 : k;
}

export function monthLabel(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}
