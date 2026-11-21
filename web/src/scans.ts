export type Scan = { file: string; place: string; lat: number; lon: number; credit: string };

const SONEVA = ["hb", "ootbm", "ootbr", "ootsl1", "ootsr2", "ootsr3"].map((k) => ({
  file: `scans/soneva_${k}.splat`,
  place: "a restoration plot at Soneva, Maldives",
  lat: 5.11,
  lon: 73.07,
  credit: "Soneva and Wildflow",
}));

export const SCANS: Scan[] = [
  ...SONEVA,
  { file: "scans/galapagos_espanola.splat", place: "Española, Galápagos", lat: -1.37, lon: -89.65, credit: "Yuval, Keith et al., Galapagos_3D" },
  { file: "scans/galapagos_darwin.splat", place: "Darwin Island, Galápagos", lat: 1.68, lon: -92.0, credit: "Yuval, Keith et al., Galapagos_3D" },
  { file: "scans/sf_heron.splat", place: "Heron Reef, Great Barrier Reef", lat: -23.44, lon: 151.91, credit: "Renata Ferrari" },
  { file: "scans/sf_onetree.splat", place: "One Tree Island, Great Barrier Reef", lat: -23.49, lon: 152.07, credit: "John Turnbull" },
  { file: "scans/sf_whitsunday.splat", place: "the Whitsunday Islands, Great Barrier Reef", lat: -20.25, lon: 148.95, credit: "Marco Ka Ho Cheung" },
  { file: "scans/sf_belize.splat", place: "South Water Caye, Belize", lat: 16.8, lon: -88.08, credit: "Ben M. Ritt" },
  { file: "scans/sf_usvi2016.splat", place: "Flat Key, US Virgin Islands", lat: 18.32, lon: -64.85, credit: "Lauren Olinger" },
  { file: "scans/sf_okinawa.splat", place: "Sakimotobu, Okinawa", lat: 26.69, lon: 127.88, credit: "yuma.jp" },
  { file: "scans/sf_mayotte.splat", place: "Îlots Choisils, Mayotte", lat: -12.65, lon: 45.1, credit: "DroneGo" },
  { file: "scans/sf_thailand.splat", place: "Ko Pha-ngan, Thailand", lat: 9.75, lon: 100.05, credit: "QQman" },
];

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export function scanFor(reef: { i: number; lat: number; lon: number }) {
  const ranked = SCANS.map((s) => ({ s, d: km(reef, s) })).sort((a, b) => a.d - b.d);
  const near = ranked.filter((x) => x.d - ranked[0].d < 1);
  const pick = near[reef.i % near.length];
  return { ...pick.s, km: Math.round(pick.d) };
}
