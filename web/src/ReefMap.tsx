import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { Reef } from "./api";

const STYLE = "https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json";
export const VERDICT_COLOR = { holds: "#1e8e4a", savable: "#c27a00", beyond: "#d93636" } as const;

export type Project = [lat: number, lon: number, cell: number, place: string];
type Props = { reefs: Reef[]; verdicts: string[]; projects: Project[]; selected: number | null; compact: boolean; onPick: (i: number) => void };

export function ReefMap({ reefs, verdicts, projects, selected, compact, onPick }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const m = new maplibregl.Map({ container: el.current!, style: STYLE, center: [150, -5], zoom: 1.6, minZoom: 1, dragRotate: false, attributionControl: { compact: true } });
    m.on("load", () => {
      m.addSource("reefs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "reefs",
        type: "circle",
        source: "reefs",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 2.2, 5, 4, 9, 7],
          "circle-color": ["match", ["get", "v"], "holds", VERDICT_COLOR.holds, "savable", VERDICT_COLOR.savable, VERDICT_COLOR.beyond],
          "circle-opacity": 0.9,
        },
      });
      m.addSource("projects", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "projects",
        type: "circle",
        source: "projects",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, 4.5, 5, 7, 9, 11],
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#0f0f0d",
          "circle-stroke-width": 1.4,
          "circle-stroke-opacity": 0.85,
        },
      });
      m.addLayer({
        id: "sel",
        type: "circle",
        source: "reefs",
        filter: ["==", ["get", "i"], -1],
        paint: { "circle-radius": 9, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#0f0f0d", "circle-stroke-width": 2 },
      });
      m.on("mouseenter", "reefs", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "reefs", () => (m.getCanvas().style.cursor = ""));
      m.on("click", (e) => {
        const hits = m.queryRenderedFeatures([[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]], { layers: ["reefs"] });
        if (!hits.length) return;
        let best = hits[0], bestD = Infinity;
        for (const h of hits) {
          const q = m.project((h.geometry as GeoJSON.Point).coordinates as [number, number]);
          const d = (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2;
          if (d < bestD) [best, bestD] = [h, d];
        }
        pick.current(Number(best.properties!.i));
      });
      setReady(true);
    });
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el.current!);
    map.current = m;
    return () => {
      ro.disconnect();
      m.remove();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    (map.current!.getSource("reefs") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: reefs.map((r, k) => ({ type: "Feature", properties: { i: r.i, v: verdicts[k] }, geometry: { type: "Point", coordinates: [r.lon, r.lat] } })),
    });
  }, [ready, reefs, verdicts]);

  useEffect(() => {
    if (!ready) return;
    (map.current!.getSource("projects") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: projects.map(([lat, lon, cell]) => ({ type: "Feature", properties: { cell }, geometry: { type: "Point", coordinates: [lon, lat] } })),
    });
  }, [ready, projects]);

  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    m.setFilter("sel", ["==", ["get", "i"], selected ?? -1]);
    if (compact) el.current!.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (selected !== null) {
      const r = reefs[selected];
      m.flyTo({ center: [r.lon, r.lat], zoom: compact ? 4 : 6, duration: reduce ? 0 : 1200 });
    }
  }, [ready, selected, compact, reefs]);

  return <div ref={el} className="reefmap" role="application" aria-label="World map of coral reefs, coloured by verdict" />;
}
