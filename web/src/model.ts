import type { Reef, Years } from "./api";

export const DONOR_RESID = -0.1;

export function interp(curve: number[], deltas: number[], x: number) {
  if (x <= deltas[0]) return curve[0];
  for (let k = 1; k < deltas.length; k++) {
    if (x <= deltas[k]) {
      const t = (x - deltas[k - 1]) / (deltas[k] - deltas[k - 1]);
      return curve[k - 1] + t * (curve[k] - curve[k - 1]);
    }
  }
  return curve[curve.length - 1];
}

export const isDonor = (r: Reef) => r.resid !== null && r.resid < DONOR_RESID && r.n_hot >= 2;

export type Triage = "holds" | "savable" | "beyond";

export function triage(r: Reef, warming: number, gain: number): Triage {
  const m = r.margin;
  if (m === null) return "holds";
  if (m >= warming) return "holds";
  return warming - m <= gain ? "savable" : "beyond";
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
export const deg = (c: number, digits = 1) => `${c.toFixed(digits)} °C`;

export function placeName(r: { eco: string; country: string }) {
  if (r.eco && r.country) return { title: r.eco, sub: r.country };
  return { title: r.eco || r.country || "Unnamed reef cell", sub: "" };
}

export function coord(lat: number, lon: number) {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}

export const HOLD_MAX = 2;

export function bleachYears(y: Years, k: number, shift: number) {
  const s = Math.max(0, Math.min(y.shifts.length - 1, Math.round((shift - y.shifts[0]) / 0.25)));
  return y.counts[s * y.n + k];
}

export function triageYears(y: Years, k: number, warming: number, gain: number): Triage {
  if (bleachYears(y, k, warming) <= HOLD_MAX) return "holds";
  return bleachYears(y, k, warming - gain) <= HOLD_MAX ? "savable" : "beyond";
}

export function gainNeeded(y: Years, k: number, warming: number) {
  for (let g = 0; g <= 1.5 + 1e-9; g += 0.25) if (bleachYears(y, k, warming - g) <= HOLD_MAX) return g;
  return null;
}

export function annual(y: Years, k: number) {
  return y.years.map((yr, t) => ({ yr, risk: y.ann[t * y.n + k] / y.scale }));
}

export function decadeCount(y: Years, k: number, from: number) {
  let c = 0;
  y.years.forEach((yr, t) => {
    if (yr >= from && yr < from + 10 && y.ann[t * y.n + k] >= y.scale / 2) c++;
  });
  return c;
}

export const bleachShare = (risk: number) => {
  const x = Math.min(1, Math.max(0, (risk - 0.25) / 0.45));
  return x * x * (3 - 2 * x);
};

export const MORTALITY = 0.4;
export const REGROWTH = 0.14;

export type ReefYear = { white: number; dead: number; left: number };

export function reefHistory(y: Years, k: number): ReefYear[] {
  let dead = 0;
  return y.years.map((_, t) => {
    const before = dead * (1 - REGROWTH);
    const white = bleachShare(y.ann[t * y.n + k] / y.scale) * (1 - before);
    dead = before + MORTALITY * white;
    return { white, dead: before, left: 1 - dead };
  });
}
