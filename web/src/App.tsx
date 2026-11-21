import NumberFlow from "@number-flow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getHabitat, getLayer, getReef, postImpact, type Habitat, type ImpactResult, type Layer, type Reef, type ReefDetail } from "./api";
import { HeatCurve, SstChart } from "./charts";
import { MapView, type Paint } from "./MapView";
import { coord, deg, interp, isDonor, pct, placeName, triage, type Triage } from "./model";
import { frameColumn, frameRow, getFrames, indexOfDate, monthLabel, previewFrames, shareAbove, type Frames } from "./time";
import { RiskTimeline } from "./Timeline";

type Tab = "risk" | "donors" | "gap" | "impact";
const TABS: { id: Tab; label: string }[] = [
  { id: "risk", label: "Reef risk" },
  { id: "donors", label: "Donor reefs" },
  { id: "gap", label: "Adaptation gap" },
  { id: "impact", label: "Project impact" },
];

const C = { low: "#3e6272", mid: "#e2a54b", high: "#ee5a4f", sea: "#7fdcc4", dim: "#2a3740", ink: "#e8edf0" };
const RISK_PAINT: Paint = { kind: "ramp", stops: [[0, "#2f4a58"], [0.3, C.low], [0.5, C.mid], [0.75, "#ea7f45"], [1, C.high]] };
const TRIAGE_PAINT: Paint = { kind: "class", colors: { holds: C.low, savable: C.sea, beyond: C.high }, fallback: C.dim };
const DONOR_PAINT: Paint = { kind: "class", colors: { donor: C.sea, match: C.ink }, fallback: C.dim };
const IMPACT_PAINT: Paint = { kind: "ramp", stops: [[-1, C.dim], [0, C.low], [0.1, C.mid], [0.3, C.high]] };

const PRESETS = [
  { label: "Tanguisson power plant, Guam", lat: 13.546, lon: 144.806 },
  { label: "Maanshan nuclear outlet, Taiwan", lat: 21.932, lon: 120.742 },
];

type Jump = { id: string; label: string; date: string; lat: number; lon: number; zoom: number };
const JUMPS: Jump[] = [
  { id: "fl2023", label: "Florida, Aug 2023", date: "2023-08-31", lat: 24.75, lon: -81.0, zoom: 7 },
  { id: "gbr2024", label: "Great Barrier Reef, Mar 2024", date: "2024-03-31", lat: -18.0, lon: 147.5, zoom: 5 },
  { id: "w1998", label: "World, Apr 1998", date: "1998-04-30", lat: -8, lon: 150, zoom: 1.7 },
];

const ICONIC = [
  { name: "Carysfort Reef", lat: 25.222, lon: -80.211 },
  { name: "Horseshoe Reef", lat: 25.139, lon: -80.294 },
  { name: "Cheeca Rocks", lat: 24.904, lon: -80.616 },
  { name: "Sombrero Reef", lat: 24.627, lon: -81.11 },
  { name: "Newfound Harbor", lat: 24.615, lon: -81.395 },
  { name: "Looe Key", lat: 24.546, lon: -81.406 },
  { name: "Eastern Dry Rocks", lat: 24.457, lon: -81.845 },
];

type Load<T> = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: T };

function readHash() {
  const h = new URLSearchParams(window.location.hash.slice(1));
  const tab = TABS.some((t) => t.id === h.get("tab")) ? (h.get("tab") as Tab) : "risk";
  const reef = h.get("reef");
  return { tab, reef: reef === null ? null : Number(reef) };
}

export function App() {
  const init = useMemo(readHash, []);
  const [tab, setTab] = useState<Tab>(init.tab);
  const [sel, setSel] = useState<number | null>(init.reef);
  const [layerKey, setLayerKey] = useState(0);
  const [layer, setLayer] = useState<Load<Layer>>({ state: "loading" });
  const [addWarm, setAddWarm] = useState(0);
  const [timeOn, setTimeOn] = useState(false);
  const [frames, setFrames] = useState<Load<Frames> | null>(null);
  const [t, setT] = useState(0);
  const [settledT, setSettledT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [terrain, setTerrain] = useState(false);
  const [habitat, setHabitat] = useState<Load<Habitat> | null>(null);
  const [donorWarm, setDonorWarm] = useState(1);
  const [gapWarm, setGapWarm] = useState(1);
  const [gain, setGain] = useState(0.5);
  const [outfall, setOutfall] = useState<{ lat: number; lon: number } | null>(null);
  const [heat, setHeat] = useState(2);
  const [radius, setRadius] = useState(2);
  const [detail, setDetail] = useState<Load<ReefDetail> | null>(null);
  const [impact, setImpact] = useState<Load<ImpactResult> | null>(null);
  const [focus, setFocus] = useState<{ lat: number; lon: number; zoom: number; key: number } | null>(null);
  const focusKey = useRef(0);

  useEffect(() => {
    const ctl = new AbortController();
    setLayer({ state: "loading" });
    getLayer(ctl.signal)
      .then((data) => setLayer({ state: "ready", data }))
      .catch((e: Error) => !ctl.signal.aborted && setLayer({ state: "error", message: e.message }));
    return () => ctl.abort();
  }, [layerKey]);

  useEffect(() => {
    const h = new URLSearchParams({ tab });
    if (sel !== null) h.set("reef", String(sel));
    window.history.replaceState(null, "", `#${h}`);
  }, [tab, sel]);

  const fr = frames?.state === "ready" ? frames.data : null;
  const timeView = tab === "risk" && timeOn && fr !== null;
  const detailDate = timeView ? fr.dates[settledT] : null;

  useEffect(() => {
    if (sel === null || layer.state !== "ready") {
      setDetail(null);
      return;
    }
    const ctl = new AbortController();
    setDetail((prev) => (prev?.state === "ready" && prev.data.i === sel ? prev : { state: "loading" }));
    getReef(sel, donorWarm, detailDate, ctl.signal)
      .then((data) => setDetail({ state: "ready", data }))
      .catch((e: Error) => !ctl.signal.aborted && setDetail({ state: "error", message: e.message }));
    return () => ctl.abort();
  }, [sel, donorWarm, layer.state, detailDate]);

  useEffect(() => {
    if (!timeOn || frames || layer.state !== "ready") return;
    setFrames({ state: "loading" });
    const reefList = layer.data.reefs;
    getFrames()
      .then((data) => {
        if (data.n !== reefList.length) throw new Error("Frame columns do not match the reef layer");
        return data;
      })
      .catch(() => previewFrames(reefList))
      .then((data) => {
        const k = indexOfDate(data, "2024-03-31");
        setFrames({ state: "ready", data });
        setT(k);
        setSettledT(k);
      });
  }, [timeOn, frames, layer]);

  useEffect(() => {
    if (!playing || !fr) return;
    const id = window.setInterval(() => {
      setT((k) => {
        if (k >= fr.dates.length - 1) {
          setPlaying(false);
          return k;
        }
        return k + 1;
      });
    }, 140);
    return () => window.clearInterval(id);
  }, [playing, fr]);

  useEffect(() => {
    if (playing) return;
    const id = window.setTimeout(() => setSettledT(t), 350);
    return () => window.clearTimeout(id);
  }, [t, playing]);

  const reefs = layer.state === "ready" ? layer.data.reefs : [];
  const deltas = layer.state === "ready" ? layer.data.deltas : [];
  useEffect(() => {
    if (layer.state !== "ready" || init.reef === null || init.tab !== "risk") return;
    const r = layer.data.reefs[init.reef];
    if (!r) return;
    setTerrain(true);
    focusKey.current += 1;
    setFocus({ lat: r.lat, lon: r.lon, zoom: 12.2, key: focusKey.current });
  }, [layer, init]);

  const closeReef = tab === "risk" && sel !== null && layer.state === "ready" ? layer.data.reefs[sel] : null;

  useEffect(() => {
    if (!closeReef) {
      setHabitat(null);
      return;
    }
    const ctl = new AbortController();
    setHabitat({ state: "loading" });
    getHabitat(closeReef.lat, closeReef.lon, ctl.signal)
      .then((data) => setHabitat({ state: "ready", data }))
      .catch((e: Error) => !ctl.signal.aborted && setHabitat({ state: "error", message: e.message }));
    return () => ctl.abort();
  }, [closeReef]);

  const habWeights = useMemo(() => {
    if (habitat?.state !== "ready" || !closeReef) return null;
    const kmLat = 111.32;
    const kmLon = 111.32 * Math.cos((closeReef.lat * Math.PI) / 180);
    const near = reefs.filter((r) => Math.abs(r.lat - closeReef.lat) < 0.2 && Math.abs(r.lon - closeReef.lon) < 0.2).map((r) => r.i);
    return habitat.data.features.map((f) => {
      const ws: [number, number][] = [];
      for (const i of near) {
        const d2 = ((reefs[i].lat - f.properties.y) * kmLat) ** 2 + ((reefs[i].lon - f.properties.x) * kmLon) ** 2;
        if (d2 < 144) ws.push([i, 1 / (d2 + 2.25)]);
      }
      return ws;
    });
  }, [habitat, closeReef, reefs]);

  const share = useMemo(() => (fr ? shareAbove(fr, 0.5) : null), [fr]);

  function jump(j: Jump) {
    if (!fr) return;
    setPlaying(false);
    const k = indexOfDate(fr, j.date);
    setT(k);
    setSettledT(k);
    if (sel !== null) return;
    focusKey.current += 1;
    setFocus({ lat: j.lat, lon: j.lon, zoom: j.zoom, key: focusKey.current });
  }

  useEffect(() => {
    if (!outfall) {
      setImpact(null);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setImpact((prev) => (prev?.state === "ready" ? prev : { state: "loading" }));
      postImpact({ lat: outfall.lat, lon: outfall.lon, delta_c: heat, radius_km: radius }, ctl.signal)
        .then((data) => setImpact({ state: "ready", data }))
        .catch((e: Error) => !ctl.signal.aborted && setImpact({ state: "error", message: e.message }));
    }, 220);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [outfall, heat, radius]);


  const view = useMemo(() => {
    const n = reefs.length;
    if (tab === "risk") {
      if (timeView) return { values: frameRow(fr, t), emphasis: new Array(n).fill(0), paint: RISK_PAINT };
      return { values: reefs.map((r) => interp(r.risk, deltas, addWarm)), emphasis: new Array(n).fill(0), paint: RISK_PAINT };
    }
    if (tab === "gap") {
      return { values: reefs.map((r) => triage(r, gapWarm, gain)), emphasis: new Array(n).fill(0), paint: TRIAGE_PAINT };
    }
    if (tab === "donors") {
      const matched = new Set(detail?.state === "ready" ? detail.data.donors.map((d) => d.i) : []);
      return {
        values: reefs.map((r) => (matched.has(r.i) ? "match" : isDonor(r) ? "donor" : "other")),
        emphasis: reefs.map((r) => (matched.has(r.i) ? 1 : isDonor(r) ? 0.6 : -1)),
        paint: DONOR_PAINT,
      };
    }
    const delta = new Map<number, number>();
    if (impact?.state === "ready") for (const a of impact.data.affected) delta.set(a.i, Math.max(0, a.risk_after - a.risk_before));
    return {
      values: reefs.map((r) => delta.get(r.i) ?? -1),
      emphasis: reefs.map((r) => (delta.has(r.i) ? 1 : -1)),
      paint: IMPACT_PAINT,
    };
  }, [tab, reefs, deltas, addWarm, gapWarm, gain, detail, impact, timeView, fr, t]);

  const closeup = useMemo(() => {
    if (habitat?.state !== "ready" || !habWeights || tab !== "risk") return null;
    const vals = view.values as number[];
    let coral = 0, hot = 0;
    const features = habitat.data.features.map((f, k) => {
      let sw = 0, sv = 0;
      for (const [i, w] of habWeights[k]) {
        sw += w;
        sv += w * vals[i];
      }
      const v = sw ? sv / sw : 0;
      if (f.properties.c === "Coral/Algae") {
        coral += f.properties.a;
        if (v >= 0.5) hot += f.properties.a;
      }
      return { ...f, properties: { ...f.properties, v } };
    });
    return { fc: { type: "FeatureCollection", features } as GeoJSON.FeatureCollection, coral, hot };
  }, [habitat, habWeights, view.values, tab]);

  const lines = useMemo<[number, number][][]>(() => {
    if (tab !== "donors" || sel === null || detail?.state !== "ready") return [];
    const me = reefs[sel];
    return detail.data.donors.map((d) => [[d.lon, d.lat], [me.lon, me.lat]]);
  }, [tab, sel, detail, reefs]);

  function pick(i: number | null, fly = false) {
    const prev = sel;
    setSel(i);
    if (tab === "risk" && i !== null) {
      setTerrain(true);
      focusKey.current += 1;
      setFocus({ lat: reefs[i].lat, lon: reefs[i].lon, zoom: 12.2, key: focusKey.current });
      return;
    }
    if (tab === "risk" && i === null && prev !== null) {
      focusKey.current += 1;
      setFocus({ lat: reefs[prev].lat, lon: reefs[prev].lon, zoom: 5, key: focusKey.current });
      return;
    }
    if (fly && i !== null) {
      focusKey.current += 1;
      setFocus({ lat: reefs[i].lat, lon: reefs[i].lon, zoom: 6, key: focusKey.current });
    }
  }

  function place(lat: number, lon: number, fly = false) {
    setOutfall({ lat, lon });
    if (fly) {
      focusKey.current += 1;
      setFocus({ lat, lon, zoom: 10, key: focusKey.current });
    }
  }

  const status =
    layer.state === "ready"
      ? { s: "up", text: `Live model · ${layer.data.n.toLocaleString("en-GB")} reef cells` }
      : layer.state === "loading"
        ? { s: "wait", text: "Connecting to the model" }
        : { s: "down", text: "Model offline" };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M3 21c4-6 8-6 11-2s7 4 15-3" stroke={C.mid} strokeWidth="3" fill="none" strokeLinecap="round" />
            <path d="M3 27h26" stroke={C.ink} strokeWidth="2" strokeLinecap="round" opacity="0.5" />
          </svg>
          Reef Margin
        </div>
        <nav className="tabs" role="tablist" aria-label="Views">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="status" role="status">
          <span className="dot" data-state={status.s} />
          {status.text}
        </div>
      </header>

      <main className="main">
        <div className="mapwrap" data-time={timeView}>
          <MapView
            reefs={reefs}
            values={view.values}
            emphasis={view.emphasis}
            paint={view.paint}
            selected={tab === "impact" ? null : sel}
            lines={lines}
            plume={tab === "impact" && outfall ? { ...outfall, radius_km: radius } : null}
            markers={timeView ? ICONIC : []}
            terrain={terrain}
            habitat={closeup?.fc ?? null}
            cell={closeReef ? { lat: closeReef.lat, lon: closeReef.lon } : null}
            placing={tab === "impact"}
            focus={focus}
            onPick={(i) => pick(i)}
            onPlace={(lat, lon) => place(lat, lon)}
          />
          {tab === "impact" && !outfall && layer.state === "ready" && <div className="maphint">Click the map to place a discharge point</div>}
          <button className="chip mapbtn" aria-pressed={terrain} onClick={() => setTerrain((v) => !v)}>3D seafloor</button>
          {timeView && <TimeBar frames={fr} t={t} setT={(k) => { setPlaying(false); setT(k); }} playing={playing} setPlaying={setPlaying} jump={jump} />}
          {layer.state === "ready" && <Legend tab={tab} closeup={closeup !== null} />}
        </div>

        <aside className="panel" aria-live="polite">
          {layer.state === "loading" && <PanelSkeleton />}
          {layer.state === "error" && (
            <div className="error">
              <h1>The model is not responding</h1>
              <p className="lede">{layer.message}. The map needs the live model to colour each reef.</p>
              <button className="chip" onClick={() => setLayerKey((k) => k + 1)}>Try again</button>
            </div>
          )}
          {layer.state === "ready" && tab === "risk" && (
            <RiskPanel
              reefs={reefs}
              deltas={deltas}
              sel={sel}
              detail={detail}
              addWarm={addWarm}
              setAddWarm={setAddWarm}
              pick={pick}
              time={{ on: timeOn, frames, t, share }}
              level={layer.data.level ?? 10}
              closeup={habitat?.state === "error" ? { error: habitat.message } : habitat?.state === "loading" ? "loading" : closeup ? { coral: closeup.coral, hot: closeup.hot } : null}
              setTimeOn={(on) => {
                setTimeOn(on);
                setPlaying(false);
              }}
              setT={(k) => {
                setPlaying(false);
                setT(k);
              }}
            />
          )}
          {layer.state === "ready" && tab === "donors" && (
            <DonorPanel reefs={reefs} sel={sel} detail={detail} warm={donorWarm} setWarm={setDonorWarm} pick={pick} />
          )}
          {layer.state === "ready" && tab === "gap" && (
            <GapPanel reefs={reefs} sel={sel} warm={gapWarm} setWarm={setGapWarm} gain={gain} setGain={setGain} pick={pick} />
          )}
          {layer.state === "ready" && tab === "impact" && (
            <ImpactPanel reefs={reefs} outfall={outfall} heat={heat} setHeat={setHeat} radius={radius} setRadius={setRadius} impact={impact} place={place} clear={() => setOutfall(null)} />
          )}
        </aside>
      </main>
    </div>
  );
}

function Legend({ tab, closeup }: { tab: Tab; closeup: boolean }) {
  if (tab === "risk")
    return (
      <div className="legend">
        <div className="title">{closeup ? "Coral coloured by chance of bleaching" : "Chance of bleaching"}</div>
        <div className="ramp" style={{ background: `linear-gradient(90deg, #2f4a58, ${C.low} 30%, ${C.mid} 50%, #ea7f45 75%, ${C.high})` }} />
        <div className="ends num"><span>0%</span><span>50%</span><span>100%</span></div>
        {closeup && <p className="legend-note">Reef map: Allen Coral Atlas, 10 m. The model scores 5 km cells (dashed square); colour is interpolated between them.</p>}
      </div>
    );
  if (tab === "gap")
    return (
      <div className="legend">
        <ul>
          <li><span className="sw" style={{ background: C.low }} />Holds without help</li>
          <li><span className="sw" style={{ background: C.sea }} />Adaptation can close the gap</li>
          <li><span className="sw" style={{ background: C.high }} />Gap larger than the gain</li>
        </ul>
      </div>
    );
  if (tab === "donors")
    return (
      <div className="legend">
        <ul>
          <li><span className="sw" style={{ background: C.sea }} />Bleached less than expected</li>
          <li><span className="sw" style={{ background: C.ink }} />Matched donor</li>
          <li><span className="sw" style={{ background: C.dim }} />Other reef cells</li>
        </ul>
      </div>
    );
  return (
    <div className="legend">
      <div className="title">Added chance of bleaching</div>
      <div className="ramp" style={{ background: `linear-gradient(90deg, ${C.low}, ${C.mid} 33%, ${C.high})` }} />
      <div className="ends num"><span>0</span><span>+10 pts</span><span>+30 pts</span></div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div aria-busy="true">
      <div className="skel" style={{ height: 24, width: "70%", marginBottom: 10 }} />
      <div className="skel" style={{ height: 14, width: "95%", marginBottom: 6 }} />
      <div className="skel" style={{ height: 14, width: "80%", marginBottom: 24 }} />
      <div className="skel" style={{ height: 72, marginBottom: 16 }} />
      <div className="skel" style={{ height: 190 }} />
    </div>
  );
}

function ReefHead({ r, onClose, closeLabel }: { r: Reef; onClose: () => void; closeLabel: string }) {
  const p = placeName(r);
  return (
    <div className="reefhead">
      <div>
        <h1>{p.title}</h1>
        <div className="where">{[p.sub, coord(r.lat, r.lon)].filter(Boolean).join(", ")}</div>
      </div>
      <button className="linkbtn" onClick={onClose}>{closeLabel}</button>
    </div>
  );
}

function marginText(m: number | null) {
  if (m === null) return { v: 3, prefix: "> +", note: "stays under 50% risk with 3 °C added" };
  if (m === 0) return { v: 0, prefix: "", note: "already past 50% risk at its last peak" };
  return { v: m, prefix: "+", note: "added warming before 50% risk" };
}

function DetailError({ message }: { message: string }) {
  return <p className="error">Could not load this reef from the model. {message}.</p>;
}

type Closeup = null | "loading" | { error: string } | { coral: number; hot: number };

function CloseupSection({ c, when }: { c: Closeup; when: string }) {
  if (c === null) return null;
  return (
    <div className="section">
      <h2>The reef up close</h2>
      {c === "loading" && <div className="skel" style={{ height: 64 }} />}
      {typeof c === "object" && "error" in c && <p className="error">Could not load the reef map. {c.error}.</p>}
      {typeof c === "object" && "coral" in c && (
        <>
          <p className="note">Coral and algae mapped from satellite within about 7 km, coloured by the model's chance of bleaching {when}.</p>
          <div className="kpis two">
            <div><div className="label">Coral mapped</div><div className="value num">{c.coral.toFixed(1)} km²</div></div>
            <div><div className="label"><span className="sw" style={{ background: C.high }} />Past 50% risk</div><div className="value num">{c.hot.toFixed(1)} km²</div></div>
          </div>
        </>
      )}
    </div>
  );
}

type Time = { on: boolean; frames: Load<Frames> | null; t: number; share: Float32Array | null };

function RiskPanel(p: {
  reefs: Reef[];
  deltas: number[];
  sel: number | null;
  detail: Load<ReefDetail> | null;
  addWarm: number;
  setAddWarm: (v: number) => void;
  pick: (i: number | null, fly?: boolean) => void;
  time: Time;
  setTimeOn: (on: boolean) => void;
  setT: (t: number) => void;
  closeup: Closeup;
  level: number;
}) {
  const f = p.time.on && p.time.frames?.state === "ready" ? p.time.frames.data : null;
  const month = f ? monthLabel(f.dates[p.time.t]) : null;
  const counts = useMemo(() => {
    let past = 0, close = 0, room = 0;
    p.reefs.forEach((r, k) => {
      const now = f ? f.data[p.time.t * f.n + k] / f.scale : interp(r.risk, p.deltas, p.addWarm);
      if (now >= 0.5) past++;
      else if (f ? now >= 0.3 : r.margin !== null && r.margin - p.addWarm <= 1) close++;
      else room++;
    });
    return { past, close, room };
  }, [p.reefs, p.deltas, p.addWarm, f, p.time.t]);

  const mode = (
    <div className="control">
      <span className="clabel">View</span>
      <div className="seg" role="group" aria-label="Time view">
        <button aria-pressed={!p.time.on} onClick={() => p.setTimeOn(false)}>Now</button>
        <button aria-pressed={p.time.on} onClick={() => p.setTimeOn(true)}>1988 to 2026</button>
      </div>
      {p.time.on && p.time.frames?.state === "loading" && <p className="fine">Loading 466 months of live model scores for every reef cell.</p>}
      {f?.preview && <p className="error">Preview data. The month by month scores did not load, so this view shows a synthetic pattern built from each reef's current risk. Not model output.</p>}
    </div>
  );

  const edge = useMemo(
    () => p.reefs.filter((r) => r.labelled && r.margin !== null && r.margin > p.addWarm).sort((a, b) => a.margin! - b.margin!).slice(0, 5),
    [p.reefs, p.addWarm],
  );

  if (p.sel !== null) {
    const r = p.reefs[p.sel];
    const d = p.detail?.state === "ready" ? p.detail.data : null;
    const curve = d?.risk ?? r.risk;
    const m = marginText(d ? d.margin : r.margin);
    const column = f ? frameColumn(f, p.sel) : null;
    return (
      <>
        <ReefHead r={r} onClose={() => p.pick(null)} closeLabel="All reefs" />
        <div className="answer">
          {f && column ? (
            <div>
              <div className="label">Risk, end of {month}</div>
              <div className="big num"><NumberFlow value={Math.round(column[p.time.t] * 100)} suffix="%" /></div>
              <div className="sub">{f.dates[p.time.t] > "2020-12-31" ? "after the last training survey" : "inside the training years"}</div>
            </div>
          ) : (
            <div>
              <div className="label">Heat margin</div>
              <div className="big num"><NumberFlow value={m.v} prefix={m.prefix} suffix=" °C" format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} /></div>
              <div className="sub">{m.note}</div>
            </div>
          )}
          {f ? (
            <div>
              <div className="label">Heat margin today</div>
              <div className="mid num">{m.prefix}{m.v.toFixed(1)} °C</div>
              <div className="sub">{m.note}</div>
            </div>
          ) : (
            <div>
              <div className="label">Risk at its last peak</div>
              <div className="mid num"><NumberFlow value={Math.round(curve[0] * 100)} suffix="%" /></div>
              <div className="sub">peak heat on {r.ref}</div>
            </div>
          )}
        </div>
        <CloseupSection c={p.closeup} when={f ? `at the end of ${month}` : p.addWarm > 0 ? `at its last peak plus ${p.addWarm} °C` : "at its last peak"} />
        {mode}
        {f && column && (
          <div className="section">
            <h2>Bleaching risk, month by month</h2>
            <p className="note">Line: the live model at the end of each month. Dots: diver surveys, filled where {p.level}% or more of corals bleached. Drag to move through time.</p>
            <RiskTimeline series={column} dates={f.dates} t={p.time.t} onSeek={p.setT} surveys={d?.surveys ?? []} hitAt={p.level} label={`Monthly bleaching risk for this reef, ${f.dates[0].slice(0, 4)} to ${f.dates[f.dates.length - 1].slice(0, 4)}`} />
          </div>
        )}
        <div className="section">
          <h2>{d && f ? `Risk as the water warms, from ${d.ref}` : "Risk as the water warms"}</h2>
          <p className="note">The live model re-scores this reef with heat added to its last three years.</p>
          <HeatCurve risk={curve} deltas={p.deltas} margin={d ? d.margin : r.margin} mark={!f && p.addWarm > 0 ? { x: p.addWarm, label: `+${p.addWarm} °C` } : undefined} />
        </div>
        <div className="section">
          <h2>Three years of sea temperature</h2>
          {p.detail?.state === "loading" && <div className="skel" style={{ height: 150 }} />}
          {p.detail?.state === "error" && <DetailError message={p.detail.message} />}
          {d && <SstChart weekly={d.weekly_sst} mmm={d.mmm} refDate={d.ref} />}
        </div>
        {d && <SurveyTable detail={d} />}
      </>
    );
  }

  if (f && p.time.share) {
    return (
      <>
        <h1>Forty years of bleaching risk</h1>
        <p className="lede">Every 5 km reef cell scored by the live model at the end of each month since 1988. It never saw a bleaching survey after 2020, so every month from 2021 is out of sample. Bleaching means at least {p.level}% of corals bleached.</p>
        {mode}
        <div className="kpis">
          <div><div className="label"><span className="sw" style={{ background: C.high }} />Past 50%</div><div className="value num"><NumberFlow value={counts.past} /></div></div>
          <div><div className="label"><span className="sw" style={{ background: C.mid }} />30 to 50%</div><div className="value num"><NumberFlow value={counts.close} /></div></div>
          <div><div className="label"><span className="sw" style={{ background: C.low }} />Under 30%</div><div className="value num"><NumberFlow value={counts.room} /></div></div>
        </div>
        <div className="section">
          <h2>Share of the world's reef cells past 50% risk</h2>
          <p className="note">Each spike is a global heatwave. Drag to move the map through time.</p>
          <RiskTimeline series={p.time.share} dates={f.dates} t={p.time.t} onSeek={p.setT} max={Math.max(0.1, Math.ceil(Math.max(...p.time.share) * 10) / 10)} line={null} label="Share of reef cells past 50% bleaching risk, each month since 1988" />
        </div>
        <p className="fine">Select any reef on the map to see its own forty years against what divers recorded.</p>
      </>
    );
  }

  return (
    <>
      <h1>How much more heat can each reef take?</h1>
      <p className="lede">Each dot is a 5 km reef cell. Colour is the live model's chance of bleaching at that reef's worst heat of the last three years, plus the warming you add. Bleaching means at least {p.level}% of corals bleached.</p>
      {mode}
      <div className="control">
        <label htmlFor="addwarm">Added warming <output className="num">+{p.addWarm.toFixed(2)} °C</output></label>
        <input id="addwarm" type="range" min={0} max={3} step={0.25} value={p.addWarm} onChange={(e) => p.setAddWarm(Number(e.target.value))} />
      </div>
      <div className="kpis">
        <div><div className="label"><span className="sw" style={{ background: C.high }} />Past 50%</div><div className="value num"><NumberFlow value={counts.past} /></div></div>
        <div><div className="label"><span className="sw" style={{ background: C.mid }} />Within 1 °C</div><div className="value num"><NumberFlow value={counts.close} /></div></div>
        <div><div className="label"><span className="sw" style={{ background: C.low }} />More room</div><div className="value num"><NumberFlow value={counts.room} /></div></div>
      </div>
      <div className="section">
        <h2>Surveyed reefs closest to the edge</h2>
        <p className="note">Smallest margin left at +{p.addWarm.toFixed(2)} °C.</p>
        <ul className="rows">
          {edge.map((r) => {
            const pn = placeName(r);
            return (
              <li key={r.i}>
                <button className="row" onClick={() => p.pick(r.i, true)}>
                  <span><div className="name">{pn.title}</div><div className="meta">{pn.sub || coord(r.lat, r.lon)}</div></span>
                  <span className="fig">+{(r.margin! - p.addWarm).toFixed(1)} °C<small>left</small></span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="fine">Select any reef on the map to see its heat response curve.</p>
    </>
  );
}

function TimeBar(p: { frames: Frames; t: number; setT: (t: number) => void; playing: boolean; setPlaying: (v: boolean) => void; jump: (j: Jump) => void }) {
  const date = p.frames.dates[p.t];
  return (
    <div className="timebar">
      <button className="play" aria-label={p.playing ? "Pause" : "Play through time"} onClick={() => p.setPlaying(!p.playing)}>
        {p.playing ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="2" y="1" width="3.5" height="12" rx="1" fill="currentColor" /><rect x="8.5" y="1" width="3.5" height="12" rx="1" fill="currentColor" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9.5-5.5z" fill="currentColor" /></svg>
        )}
      </button>
      <div className="when num" aria-live="off">{monthLabel(date)}</div>
      <input type="range" min={0} max={p.frames.dates.length - 1} step={1} value={p.t} aria-label="Month" aria-valuetext={monthLabel(date)} onChange={(e) => p.setT(Number(e.target.value))} />
      <div className="jumps">
        {JUMPS.map((j) => (
          <button key={j.id} className="chip" aria-pressed={date.slice(0, 7) === j.date.slice(0, 7)} onClick={() => p.jump(j)}>{j.label}</button>
        ))}
      </div>
      {p.frames.preview && <span className="badge">Preview data</span>}
    </div>
  );
}

function SurveyTable({ detail }: { detail: ReefDetail }) {
  const [all, setAll] = useState(false);
  const rows = [...detail.surveys].reverse();
  const shown = all ? rows : rows.slice(0, 6);
  if (!rows.length)
    return (
      <div className="section">
        <h2>Bleaching surveys here</h2>
        <div className="empty">No surveys in this 5 km cell. The model's answer here comes from its temperature history alone.</div>
      </div>
    );
  return (
    <div className="section">
      <h2>Bleaching surveys here</h2>
      <p className="note">What divers recorded, against the model's expectation from heat alone.</p>
      <table className="surveys">
        <thead>
          <tr><th>Date</th><th>Bleached</th><th>Heat stress</th><th>Model expected</th></tr>
        </thead>
        <tbody>
          {shown.map(([y, m, p, h, resid], k) => {
            const expected = (p >= 10 ? 1 : 0) - resid;
            return (
              <tr key={k}>
                <td>{y}-{String(m).padStart(2, "0")}</td>
                <td>{p.toFixed(0)}%</td>
                <td>{h.toFixed(1)}</td>
                <td>{Number.isFinite(expected) ? pct(Math.min(1, Math.max(0, expected))) : <span className="dash">-</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > 6 && <button className="linkbtn" onClick={() => setAll(!all)}>{all ? "Show fewer" : `View all ${rows.length}`}</button>}
      <p className="fine">Heat stress is NOAA degree heating weeks over the 90 days before the survey. Model expected is the chance of at least 10% of corals bleaching.</p>
    </div>
  );
}

function DonorPanel(p: {
  reefs: Reef[];
  sel: number | null;
  detail: Load<ReefDetail> | null;
  warm: number;
  setWarm: (v: number) => void;
  pick: (i: number | null, fly?: boolean) => void;
}) {
  const donors = useMemo(() => p.reefs.filter(isDonor).sort((a, b) => a.resid! - b.resid!), [p.reefs]);
  const realms = useMemo(() => new Set(donors.map((d) => d.realm)).size, [donors]);
  const seg = (
    <div className="control">
      <span className="clabel">Warming to plan for</span>
      <div className="seg" role="group" aria-label="Warming to plan for">
        {[0.5, 1, 1.5].map((w) => (
          <button key={w} aria-pressed={p.warm === w} onClick={() => p.setWarm(w)}>+{w} °C</button>
        ))}
      </div>
    </div>
  );

  if (p.sel !== null) {
    const r = p.reefs[p.sel];
    const d = p.detail?.state === "ready" ? p.detail.data : null;
    return (
      <>
        <ReefHead r={r} onClose={() => p.pick(null)} closeLabel="All donors" />
        {seg}
        {p.detail?.state === "loading" && <div className="skel" style={{ height: 200 }} />}
        {p.detail?.state === "error" && <DetailError message={p.detail.message} />}
        {d && (
          <>
            <p className="lede">
              At +{p.warm} °C this reef would face about <span className="num">{d.projected_dhw.toFixed(1)}</span> °C-weeks of heat stress at its peak. A donor must already have lived through that much and bleached less than the model expected, in the same ocean realm.
            </p>
            {d.donors.length ? (
              <div className="section">
                <h2>{d.donor_pool} matched donor{d.donor_pool === 1 ? "" : "s"}, best {d.donors.length} shown</h2>
                <ul className="rows">
                  {d.donors.map((x) => (
                    <li key={x.i}>
                      <button className="row" onClick={() => p.pick(x.i, true)}>
                        <span><div className="name">{x.eco || "Reef cell"}</div><div className="meta">{x.country}, {x.km.toLocaleString("en-GB")} km away, survived {x.max_dhw.toFixed(1)} °C-weeks</div></span>
                        <span className="fig">{Math.round(-x.resid * 100)} pts<small>below expected</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="empty">No reef in this realm has survived {d.projected_dhw.toFixed(1)} °C-weeks while beating the model. Assisted gene flow alone cannot cover this reef at +{p.warm} °C.</div>
            )}
          </>
        )}
        <p className="fine">These are candidates to test in contained settings, not a plan to move corals. Translocation carries disease and genetic risks and needs local consent.</p>
      </>
    );
  }

  return (
    <>
      <h1>Which reefs beat the heat?</h1>
      <p className="lede">Sea-glass reefs bleached less than the model expected in at least two heat events. They are the places to look for heat-tolerant corals.</p>
      <div className="kpis" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <div><div className="label">Candidate donor cells</div><div className="value num">{donors.length.toLocaleString("en-GB")}</div></div>
        <div><div className="label">Ocean realms covered</div><div className="value num">{realms}</div></div>
      </div>
      <div className="section">
        <h2>Strongest outperformers</h2>
        <p className="note">Average gap between what bleached and what the model expected, in heat-stress events.</p>
        <ul className="rows">
          {donors.slice(0, 6).map((r) => {
            const pn = placeName(r);
            return (
              <li key={r.i}>
                <button className="row" onClick={() => p.pick(r.i, true)}>
                  <span><div className="name">{pn.title}</div><div className="meta">{pn.sub}, {r.n_hot} heat events</div></span>
                  <span className="fig">{Math.round(-r.resid! * 100)} pts<small>below expected</small></span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="fine">Select any reef to find donors matched to the heat it will face.</p>
    </>
  );
}

function GapPanel(p: {
  reefs: Reef[];
  sel: number | null;
  warm: number;
  setWarm: (v: number) => void;
  gain: number;
  setGain: (v: number) => void;
  pick: (i: number | null, fly?: boolean) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<Triage, number> = { holds: 0, savable: 0, beyond: 0 };
    for (const r of p.reefs) c[triage(r, p.warm, p.gain)]++;
    return c;
  }, [p.reefs, p.warm, p.gain]);
  const total = p.reefs.length;
  const most = useMemo(
    () => p.reefs.filter((r) => r.labelled && triage(r, p.warm, p.gain) === "savable").sort((a, b) => (a.margin ?? 0) - (b.margin ?? 0)).slice(0, 5),
    [p.reefs, p.warm, p.gain],
  );
  const parts: { k: Triage; label: string; color: string }[] = [
    { k: "holds", label: "Holds without help", color: C.low },
    { k: "savable", label: "Adaptation can close the gap", color: C.sea },
    { k: "beyond", label: "Gap larger than the gain", color: C.high },
  ];
  const r = p.sel !== null ? p.reefs[p.sel] : null;
  return (
    <>
      {r ? <ReefHead r={r} onClose={() => p.pick(null)} closeLabel="All reefs" /> : <h1>Which reefs can adaptation save?</h1>}
      {!r && <p className="lede">Compare each reef's heat margin with the warming it will face, then ask how much tolerance breeding or assisted gene flow would need to add.</p>}
      <div className="control">
        <span className="clabel">Warming scenario</span>
        <div className="seg" role="group" aria-label="Warming scenario">
          {[0.5, 1, 1.5, 2].map((w) => (
            <button key={w} aria-pressed={p.warm === w} onClick={() => p.setWarm(w)}>+{w} °C</button>
          ))}
        </div>
      </div>
      <div className="control">
        <label htmlFor="gain">Tolerance gain we can add <output className="num">+{p.gain.toFixed(1)} °C</output></label>
        <input id="gain" type="range" min={0} max={1.5} step={0.1} value={p.gain} onChange={(e) => p.setGain(Number(e.target.value))} />
      </div>
      {r ? (
        <div className="answer">
          <div>
            <div className="label">Tolerance needed</div>
            <div className="big num"><NumberFlow value={Math.max(0, p.warm - (r.margin ?? 3))} prefix="+" suffix=" °C" format={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} /></div>
            <div className="sub">to stay under 50% risk at +{p.warm} °C</div>
          </div>
          <div>
            <div className="label">Heat margin today</div>
            <div className="mid num">{r.margin === null ? "> +3.0 °C" : deg(r.margin)}</div>
            <div className="sub">{triage(r, p.warm, p.gain) === "holds" ? "holds without help" : triage(r, p.warm, p.gain) === "savable" ? "within reach of the gain" : "beyond the gain"}</div>
          </div>
        </div>
      ) : (
        <div className="section">
          <h2>{total.toLocaleString("en-GB")} reef cells at +{p.warm} °C</h2>
          <div className="stack" role="img" aria-label={parts.map((x) => `${x.label}: ${counts[x.k]}`).join(", ")}>
            {parts.map((x) => counts[x.k] > 0 && <span key={x.k} style={{ flexGrow: counts[x.k], background: x.color }} />)}
          </div>
          <ul className="rows">
            {parts.map((x) => (
              <li key={x.k} className="row" style={{ cursor: "default" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span className="sw" style={{ background: x.color }} />{x.label}</span>
                <span className="fig"><NumberFlow value={counts[x.k]} /><small>{pct(counts[x.k] / Math.max(total, 1))}</small></span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!r && most.length > 0 && (
        <div className="section">
          <h2>Where the gain matters most</h2>
          <p className="note">Surveyed reefs that need the most tolerance but are still within reach.</p>
          <ul className="rows">
            {most.map((x) => {
              const pn = placeName(x);
              return (
                <li key={x.i}>
                  <button className="row" onClick={() => p.pick(x.i, true)}>
                    <span><div className="name">{pn.title}</div><div className="meta">{pn.sub}</div></span>
                    <span className="fig">+{(p.warm - (x.margin ?? 0)).toFixed(1)} °C<small>needed</small></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="fine">Warming is applied evenly to each reef's last three years. Scenario values are inputs, not projections from a named climate model.</p>
    </>
  );
}

function ImpactPanel(p: {
  reefs: Reef[];
  outfall: { lat: number; lon: number } | null;
  heat: number;
  setHeat: (v: number) => void;
  radius: number;
  setRadius: (v: number) => void;
  impact: Load<ImpactResult> | null;
  place: (lat: number, lon: number, fly?: boolean) => void;
  clear: () => void;
}) {
  const res = p.impact?.state === "ready" ? p.impact.data : null;
  const rows = useMemo(
    () => (res ? [...res.affected].filter((a) => a.risk_after - a.risk_before >= 0.01).sort((a, b) => b.risk_after - b.risk_before - (a.risk_after - a.risk_before)) : []),
    [res],
  );
  const tipped = rows.filter((a) => a.risk_before < 0.5 && a.risk_after >= 0.5).length;
  const worst = rows.length ? rows[0].risk_after - rows[0].risk_before : 0;
  return (
    <>
      <h1>What would this project do to nearby reefs?</h1>
      <p className="lede">Place a warm-water discharge. The live model adds the plume's heat to every reef cell within reach and re-scores each one.</p>
      <div className="control">
        <span className="clabel">Start from a real outfall</span>
        <div className="presets">
          {PRESETS.map((x) => (
            <button key={x.label} className="chip" onClick={() => p.place(x.lat, x.lon, true)}>{x.label}</button>
          ))}
        </div>
      </div>
      <div className="control">
        <label htmlFor="heat">Added heat at the outfall <output className="num">+{p.heat.toFixed(1)} °C</output></label>
        <input id="heat" type="range" min={0.5} max={5} step={0.5} value={p.heat} onChange={(e) => p.setHeat(Number(e.target.value))} />
      </div>
      <div className="control">
        <label htmlFor="radius">Plume radius <output className="num">{p.radius.toFixed(1)} km</output></label>
        <input id="radius" type="range" min={0.5} max={20} step={0.5} value={p.radius} onChange={(e) => p.setRadius(Number(e.target.value))} />
      </div>
      {!p.outfall && <div className="empty">No discharge point yet. Click the map or start from a real outfall.</div>}
      {p.outfall && (
        <div className="section">
          <div className="reefhead" style={{ marginBottom: 12 }}>
            <div className="where">Outfall at {coord(p.outfall.lat, p.outfall.lon)}</div>
            <button className="linkbtn" onClick={p.clear}>Remove</button>
          </div>
          {p.impact?.state === "loading" && <div className="skel" style={{ height: 160 }} />}
          {p.impact?.state === "error" && <DetailError message={p.impact.message} />}
          {res && (
            <>
              <div className="kpis">
                <div><div className="label">Reef cells hit</div><div className="value num"><NumberFlow value={rows.length} /></div></div>
                <div><div className="label">Pushed past 50%</div><div className="value num"><NumberFlow value={tipped} /></div></div>
                <div><div className="label">Worst increase</div><div className="value num"><NumberFlow value={Math.round(worst * 100)} prefix="+" suffix=" pts" /></div></div>
              </div>
              {rows.length ? (
                <ul className="rows">
                  {rows.slice(0, 8).map((a) => (
                    <li key={a.i}>
                      <div className="row" style={{ cursor: "default" }}>
                        <span><div className="name">{a.eco || "Reef cell"}</div><div className="meta">{a.km.toFixed(1)} km away, +{a.added_c.toFixed(1)} °C</div></span>
                        <span className="fig">{pct(a.risk_before)} to {pct(a.risk_after)}<small>chance of bleaching</small></span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="empty">No reef cell within {res.searched_km.toFixed(0)} km gains a point of risk from this plume.</div>
              )}
              <p className="fine">These are no-acclimation figures: corals keep their current tolerance. If they fully acclimated to the plume, risk would not change. The truth sits between, so treat these as the upper bound.</p>
            </>
          )}
        </div>
      )}
    </>
  );
}
