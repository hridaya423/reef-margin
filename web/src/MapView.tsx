import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as MLMap, type RasterDEMSourceSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { Reef } from "./api";

export type Paint =
  | { kind: "ramp"; stops: [number, string][] }
  | { kind: "class"; colors: Record<string, string>; fallback: string };

export type Plume = { lat: number; lon: number; radius_km: number };

type Props = {
  reefs: Reef[];
  values: (number | string)[];
  emphasis: number[];
  paint: Paint;
  selected: number | null;
  lines: [number, number][][];
  plume: Plume | null;
  markers: { name: string; lat: number; lon: number }[];
  placing: boolean;
  terrain: boolean;
  habitat: GeoJSON.FeatureCollection | null;
  cell: { lat: number; lon: number } | null;
  focus: { lat: number; lon: number; zoom: number; key: number } | null;
  onPick: (i: number | null) => void;
  onPlace: (lat: number, lon: number) => void;
};

const STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
const DEM_SOURCE: RasterDEMSourceSpecification = { type: "raster-dem", tiles: [DEM], tileSize: 256, maxzoom: 12, encoding: "terrarium", attribution: "Elevation: Mapzen Terrain Tiles" };
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function colorExpr(p: Paint): ExpressionSpecification {
  if (p.kind === "ramp") return ["interpolate", ["linear"], ["to-number", ["get", "v"]], ...p.stops.flat()] as ExpressionSpecification;
  return ["match", ["to-string", ["get", "v"]], ...Object.entries(p.colors).flat(), p.fallback] as ExpressionSpecification;
}

function circle(lat: number, lon: number, km: number): GeoJSON.Feature {
  const pts: [number, number][] = [];
  for (let k = 0; k <= 72; k++) {
    const a = (k / 72) * Math.PI * 2;
    const dLat = (km / 111.32) * Math.sin(a);
    const dLon = (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a);
    pts.push([lon + dLon, lat + dLat]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } };
}

export function MapView(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const m = new maplibregl.Map({
      container: el.current!,
      style: STYLE,
      center: [150, -8],
      zoom: 1.7,
      minZoom: 1,
      attributionControl: { compact: true },
      dragRotate: false,
      maxPitch: 70,
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    m.on("load", () => {
      m.addSource("dem", DEM_SOURCE);
      m.addSource("dem-terrain", DEM_SOURCE);
      m.addLayer({
        id: "hillshade",
        type: "hillshade",
        source: "dem",
        paint: { "hillshade-exaggeration": 0.55, "hillshade-shadow-color": "#04070a", "hillshade-highlight-color": "#3a5866", "hillshade-accent-color": "#0b1418", "hillshade-illumination-direction": 315 },
      });
      m.addSource("plume", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "plume-fill", type: "fill", source: "plume", paint: { "fill-color": "#ee5a4f", "fill-opacity": 0.08 } });
      m.addLayer({ id: "plume-line", type: "line", source: "plume", paint: { "line-color": "#ee5a4f", "line-width": 1, "line-dasharray": [3, 3] } });
      m.addSource("lines", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "lines", type: "line", source: "lines", paint: { "line-color": "#7fdcc4", "line-width": 1.2, "line-opacity": 0.7 } });
      m.addSource("habitat", { type: "geojson", data: EMPTY, attribution: "Reef habitat: Allen Coral Atlas" });
      m.addLayer({
        id: "hab-flat",
        type: "fill",
        source: "habitat",
        filter: ["in", ["get", "c"], ["literal", ["Sand", "Seagrass", "Microalgal Mats"]]],
        paint: { "fill-color": ["match", ["get", "c"], "Seagrass", "#1f3a33", "#2c3b43"], "fill-opacity": 0.7 },
      });
      m.addLayer({
        id: "hab-reef",
        type: "fill-extrusion",
        source: "habitat",
        filter: ["in", ["get", "c"], ["literal", ["Coral/Algae", "Rock", "Rubble"]]],
        paint: {
          "fill-extrusion-color": "#3e6272",
          "fill-extrusion-height": ["match", ["get", "c"], "Coral/Algae", 40, "Rock", 18, 8],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.95,
          "fill-extrusion-vertical-gradient": true,
        },
      });
      m.addSource("cell", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "cell", type: "line", source: "cell", minzoom: 9, paint: { "line-color": "#e8edf0", "line-width": 1.2, "line-dasharray": [4, 3], "line-opacity": 0.8 } });
      m.addSource("markers", { type: "geojson", data: EMPTY });
      m.addSource("reefs", { type: "geojson", data: EMPTY });
      m.addLayer({
        id: "reefs",
        type: "circle",
        source: "reefs",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 1, ["+", 1.8, ["*", 1.6, ["get", "e"]]], 5, ["+", 3.2, ["*", 2.2, ["get", "e"]]], 9, ["+", 6, ["*", 3, ["get", "e"]]]],
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["<", ["get", "e"], 0], 0.35, 0.92], 11.5, 0.08],
          "circle-color": "#3e6272",
          "circle-pitch-alignment": "map",
        },
      });
      m.addLayer({
        id: "reef-sel",
        type: "circle",
        source: "reefs",
        filter: ["==", ["get", "i"], -1],
        maxzoom: 10.5,
        paint: { "circle-radius": 9, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#e8edf0", "circle-stroke-width": 2 },
      });
      m.addLayer({
        id: "markers",
        type: "circle",
        source: "markers",
        minzoom: 5,
        paint: { "circle-radius": 5, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#e8edf0", "circle-stroke-width": 1.5 },
      });
      m.addLayer({
        id: "marker-labels",
        type: "symbol",
        source: "markers",
        minzoom: 6,
        layout: { "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Open Sans Regular"] },
        paint: { "text-color": "#e8edf0", "text-halo-color": "#0d1216", "text-halo-width": 1.2 },
      });
      m.on("mouseenter", "reefs", () => {
        if (!latest.current.placing) m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "reefs", () => {
        if (!latest.current.placing) m.getCanvas().style.cursor = "";
      });
      m.on("click", (e) => {
        if (latest.current.placing) {
          latest.current.onPlace(e.lngLat.lat, e.lngLat.lng);
          return;
        }
        const box: [maplibregl.PointLike, maplibregl.PointLike] = [
          [e.point.x - 7, e.point.y - 7],
          [e.point.x + 7, e.point.y + 7],
        ];
        const hits = m.queryRenderedFeatures(box, { layers: ["reefs"] });
        if (!hits.length) return latest.current.onPick(null);
        let best = hits[0];
        let bestD = Infinity;
        for (const h of hits) {
          const [x, y] = (h.geometry as GeoJSON.Point).coordinates;
          const q = m.project([x, y]);
          const d = (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2;
          if (d < bestD) {
            bestD = d;
            best = h;
          }
        }
        latest.current.onPick(Number(best.properties!.i));
      });
      setReady(true);
    });
    map.current = m;
    return () => m.remove();
  }, []);

  useEffect(() => {
    if (!ready) return;
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: p.reefs.map((r, k) => ({
        type: "Feature",
        id: r.i,
        properties: { i: r.i, v: p.values[k], e: p.emphasis[k] },
        geometry: { type: "Point", coordinates: [r.lon, r.lat] },
      })),
    };
    (map.current!.getSource("reefs") as GeoJSONSource).setData(fc);
  }, [ready, p.reefs, p.values, p.emphasis]);

  useEffect(() => {
    if (!ready) return;
    map.current!.setPaintProperty("reefs", "circle-color", colorExpr(p.paint));
    if (p.paint.kind === "ramp") map.current!.setPaintProperty("hab-reef", "fill-extrusion-color", ["interpolate", ["linear"], ["get", "v"], ...p.paint.stops.flat()] as ExpressionSpecification);
  }, [ready, p.paint]);

  useEffect(() => {
    if (!ready) return;
    map.current!.setFilter("reef-sel", ["==", ["get", "i"], p.selected ?? -1]);
  }, [ready, p.selected]);

  useEffect(() => {
    if (!ready) return;
    const fc: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: p.lines.map((coords) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } })),
    };
    (map.current!.getSource("lines") as GeoJSONSource).setData(fc);
  }, [ready, p.lines]);

  useEffect(() => {
    if (!ready) return;
    const src = map.current!.getSource("plume") as GeoJSONSource;
    if (!p.plume) {
      src.setData(EMPTY);
      return;
    }
    src.setData({
      type: "FeatureCollection",
      features: [circle(p.plume.lat, p.plume.lon, p.plume.radius_km), circle(p.plume.lat, p.plume.lon, p.plume.radius_km * 3)],
    });
  }, [ready, p.plume]);

  useEffect(() => {
    if (!ready) return;
    (map.current!.getSource("markers") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: p.markers.map((mk) => ({ type: "Feature", properties: { name: mk.name }, geometry: { type: "Point", coordinates: [mk.lon, mk.lat] } })),
    });
  }, [ready, p.markers]);

  useEffect(() => {
    if (!ready) return;
    (map.current!.getSource("habitat") as GeoJSONSource).setData(p.habitat ?? EMPTY);
  }, [ready, p.habitat]);

  useEffect(() => {
    if (!ready) return;
    const c = p.cell;
    const h = 0.025;
    (map.current!.getSource("cell") as GeoJSONSource).setData(
      c
        ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[c.lon - h, c.lat - h], [c.lon + h, c.lat - h], [c.lon + h, c.lat + h], [c.lon - h, c.lat + h], [c.lon - h, c.lat - h]] } }
        : EMPTY,
    );
  }, [ready, p.cell]);

  useEffect(() => {
    if (!ready) return;
    const m = map.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (p.terrain) {
      m.setTerrain({ source: "dem-terrain", exaggeration: 2.5 });
      m.dragRotate.enable();
      m.easeTo({ pitch: 62, bearing: -18, duration: reduce ? 0 : 900 });
    } else {
      m.setTerrain(null);
      m.dragRotate.disable();
      m.easeTo({ pitch: 0, bearing: 0, duration: reduce ? 0 : 600 });
    }
  }, [ready, p.terrain]);

  useEffect(() => {
    if (!ready || !p.focus) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.current!.flyTo({ center: [p.focus.lon, p.focus.lat], zoom: p.focus.zoom, ...(p.terrain ? { pitch: 62 } : {}), duration: reduce ? 0 : 1400, essential: false });
  }, [ready, p.focus]);

  return <div ref={el} className="map" data-placing={p.placing} role="application" aria-label="Map of reef cells" />;
}
