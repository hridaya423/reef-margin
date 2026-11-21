import { useEffect, useMemo, useState } from "react";
import { getLocal, getTelemetry, inRange, type Category, type Local, type Pressure, type PressureKind, type Telemetry } from "./local";

type Tab = "species" | "animals" | "land";
type Load<T> = { state: "loading" } | { state: "ready"; data: T };

const CAT: Record<Category, { label: string; color: string }> = {
  CR: { label: "Critically endangered", color: "#b42318" },
  EN: { label: "Endangered", color: "#d9480f" },
  VU: { label: "Vulnerable", color: "#c27a00" },
  NT: { label: "Near threatened", color: "#85827a" },
  LC: { label: "Least concern", color: "#85827a" },
  DD: { label: "Data deficient", color: "#85827a" },
};

// Impact Observatory land-cover palette.
const LAND_COLOR: Record<string, string> = {
  Trees: "#397d49",
  Rangeland: "#d8d39c",
  Crops: "#e49635",
  "Built area": "#c4281b",
  "Flooded vegetation": "#7a87c6",
  "Bare ground": "#a59b8f",
  "Snow or ice": "#a8ebff",
};

const KIND_LABEL: Record<PressureKind, string> = {
  river: "Rivers",
  port: "Ports",
  marina: "Marinas",
  sewage: "Sewage plants",
  resort: "Resorts",
  industrial: "Industrial areas",
  airport: "Airports",
  "coastal works": "Piers and breakwaters",
};

const km = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString());

export function Around({ i, lat, lon }: { i: number; lat: number; lon: number }) {
  const [tab, setTab] = useState<Tab>("species");
  const [local, setLocal] = useState<Load<Local>>({ state: "loading" });
  const [tele, setTele] = useState<Load<Telemetry | null>>({ state: "loading" });

  useEffect(() => {
    const ctl = new AbortController();
    setLocal({ state: "loading" });
    setTele({ state: "loading" });
    getLocal(i, lat, lon, ctl.signal).then((data) => !ctl.signal.aborted && setLocal({ state: "ready", data }));
    getTelemetry(i, ctl.signal).then((data) => !ctl.signal.aborted && setTele({ state: "ready", data }));
    return () => ctl.abort();
  }, [i, lat, lon]);

  const tabs: { id: Tab; label: string }[] = [
    { id: "species", label: "At-risk species" },
    { id: "animals", label: "Tagged animals" },
    { id: "land", label: "Land and coast" },
  ];

  return (
    <section className="around" aria-labelledby="around-h">
      <h2 id="around-h">Around this reef</h2>
      <p className="fine tight">Local context from open data. None of it feeds the bleaching model.</p>
      <div className="seg" role="tablist" aria-label="Around this reef">
        {tabs.map((t) => (
          <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`pane-${t.id}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`pane-${tab}`} aria-labelledby={`tab-${tab}`} className="pane">
        {tab === "species" && <Species local={local} lon={lon} />}
        {tab === "animals" && <Animals tele={tele} />}
        {tab === "land" && <LandCoast local={local} />}
      </div>
    </section>
  );
}

function Wait() {
  return <div className="skel" style={{ height: 96 }} aria-busy="true" />;
}

function Species({ local, lon }: { local: Load<Local>; lon: number }) {
  const raw = local.state === "ready" ? local.data.redlist : undefined;
  const list = useMemo(() => raw && inRange(raw, lon), [raw, lon]);
  const hidden = raw && list ? raw.length - list.length : 0;
  const summary = useMemo(() => {
    if (!list) return null;
    const byCat = new Map<Category, number>();
    const byGroup = new Map<string, number>();
    for (const s of list) {
      byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
      byGroup.set(s.group, (byGroup.get(s.group) ?? 0) + 1);
    }
    const animals = list.filter((s) => s.group !== "Corals");
    const named = [...animals.filter((s) => s.common), ...animals.filter((s) => !s.common)].slice(0, 7);
    // Best-recorded corals first: single stray records (some look misidentified) should not lead.
    const corals = list.filter((s) => s.group === "Corals").sort((a, b) => b.records - a.records);
    return { byCat, byGroup: [...byGroup.entries()].sort((a, b) => b[1] - a[1]), named, corals };
  }, [list]);

  if (local.state === "loading") return <Wait />;
  if (!list || !summary) return <p className="fine">The species list did not load (OBIS). Try again later.</p>;
  if (!list.length) return <p className="fine">No IUCN Red List species recorded in OBIS within 11 km.</p>;

  return (
    <>
      <div className="stat-row">
        <div className="stat"><div className="stat-n num">{list.length}</div><div className="stat-l">threatened species recorded within 11 km</div></div>
        <div className="cats">
          {(["CR", "EN", "VU"] as const).map((c) =>
            summary.byCat.get(c) ? (
              <span key={c} className="cat" title={CAT[c].label}>
                <span className="dot" style={{ background: CAT[c].color }} />
                {CAT[c].label} <span className="num">{summary.byCat.get(c)}</span>
              </span>
            ) : null,
          )}
        </div>
      </div>
      <p className="groups">{summary.byGroup.map(([g, n]) => `${g} ${n}`).join(" · ")}</p>
      <ul className="rows">
        {summary.named.map((s) => (
          <li key={s.name}>
            <span>
              <span className="row-name">{s.common ?? <i>{s.name}</i>}</span>
              {s.common && <span className="row-sub"><i>{s.name}</i>, {s.group.toLowerCase()}</span>}
              {!s.common && <span className="row-sub">{s.group.toLowerCase()}</span>}
            </span>
            <span className="tag"><span className="dot" style={{ background: CAT[s.category].color }} />{s.category}</span>
          </li>
        ))}
      </ul>
      {summary.corals.length > 0 && (
        <p className="fine">
          {summary.corals.length} threatened coral species, including{" "}
          {summary.corals.slice(0, 3).map((c, k) => (
            <span key={c.name}>
              <i>{c.name}</i> ({c.category}){k < Math.min(3, summary.corals.length) - 1 ? ", " : ""}
            </span>
          ))}
          . Branching corals like these bleach first.
        </p>
      )}
      <p className="fine">
        Occurrence records from OBIS (Ocean Biodiversity Information System) with IUCN Red List categories. A record means the species was seen here at some point, not that it lives here now.
        {hidden > 0 && ` ${hidden} Atlantic-only coral ${hidden === 1 ? "record is" : "records are"} hidden as likely misidentifications.`}
      </p>
    </>
  );
}

function Animals({ tele }: { tele: Load<Telemetry | null> }) {
  if (tele.state === "loading") return <Wait />;
  const t = tele.data;
  if (!t) return <p className="fine">Acoustic telemetry is prepared for the Australian demo reefs (Heron, Lizard and Orpheus Islands, Ningaloo). Select one of those to see tagged animals.</p>;
  if (!t.stations.length) return <p className="fine">No IMOS acoustic receivers within {t.radius_km} km of this reef.</p>;
  const animals = t.species.reduce((s, x) => s + x.animals, 0);
  const first = t.stations.reduce((m, s) => (s.first < m ? s.first : m), t.stations[0].first).slice(0, 4);
  const last = t.stations.reduce((m, s) => (s.last > m ? s.last : m), t.stations[0].last).slice(0, 4);
  return (
    <>
      <div className="kpi3">
        <div><div className="stat-n num">{animals.toLocaleString("en-GB")}</div><div className="stat-l">tagged animals heard</div></div>
        <div><div className="stat-n num">{t.species.length}</div><div className="stat-l">species</div></div>
        <div><div className="stat-n num">{t.stations.length}</div><div className="stat-l">receivers within {t.radius_km} km</div></div>
      </div>
      <p className="fine tight">Detections {first} to {last}.</p>
      <ul className="rows">
        {t.species.slice(0, 7).map((s) => (
          <li key={`${s.scientific}-${s.common}`}>
            <span>
              <span className="row-name">{s.common ?? <i>{s.scientific}</i>}</span>
              {s.common && s.scientific && <span className="row-sub"><i>{s.scientific}</i></span>}
            </span>
            <span className="tag num">{s.animals} tagged · {s.days} days</span>
          </li>
        ))}
      </ul>
      {t.links.length > 0 && (
        <>
          <h3 className="h3">Where these animals also went</h3>
          <ul className="rows">
            {t.links.slice(0, 4).map((l) => (
              <li key={l.station}>
                <span>
                  <span className="row-name">{l.station}</span>
                  <span className="row-sub">{l.species.slice(0, 3).join(", ")}</span>
                </span>
                <span className="tag num">{km(l.km)} km · {l.animals}</span>
              </li>
            ))}
          </ul>
          <p className="fine">Reefs linked by moving animals share their fate: losing coral habitat here affects species that use reefs far away.</p>
        </>
      )}
      <p className="fine">{t.source}.</p>
    </>
  );
}

function LandCoast({ local }: { local: Load<Local> }) {
  if (local.state === "loading") return <Wait />;
  const { land, pressures, radius_km } = local.data;
  return (
    <>
      {land ? <LandCover land={land} radius={radius_km} /> : <p className="fine">Land cover did not load.</p>}
      <h3 className="h3">Coastal development within {radius_km} km</h3>
      {pressures === null && <p className="fine">OpenStreetMap did not respond. Try again later.</p>}
      {pressures && <PressureList items={pressures} />}
      <p className="fine">Land cover: Impact Observatory, Microsoft and Esri, 10 m Sentinel-2 (2017 and 2024). Coastal features: OpenStreetMap contributors. Counts reflect what is mapped, which varies by place.</p>
    </>
  );
}

function LandCover({ land, radius }: { land: Local["land"] & object; radius: number }) {
  const parts = Object.entries(land.now.km2).filter(([k]) => k !== "Water" && k !== "Clouds" && land.now.km2[k] > 0);
  const total = land.now.land_km2;
  if (total < 5)
    return <p className="note-box">Almost no land within {radius} km ({total.toFixed(1)} km²). This reef sits offshore, so river runoff and coastal building are distant pressures here.</p>;
  const delta = (k: string) => (land.then ? (land.now.km2[k] ?? 0) - (land.then.km2[k] ?? 0) : null);
  const crops = delta("Crops");
  const built = delta("Built area");
  return (
    <>
      <h3 className="h3">Land within {radius} km, 2024</h3>
      <div className="mixbar" role="img" aria-label={parts.map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`).join(", ")}>
        {parts.map(([k, v]) => <span key={k} style={{ flexGrow: v, background: LAND_COLOR[k] ?? "#ccc" }} />)}
      </div>
      <ul className="mixlegend">
        {parts.filter(([, v]) => v / total >= 0.01).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
          <li key={k}><span className="dot" style={{ background: LAND_COLOR[k] ?? "#ccc" }} />{k} <span className="num">{Math.round((v / total) * 100)}%</span></li>
        ))}
      </ul>
      {land.then && crops !== null && built !== null && (
        <p className="fine">
          Since 2017: crops {crops >= 0 ? "+" : ""}{crops.toFixed(1)} km², built area {built >= 0 ? "+" : ""}{built.toFixed(1)} km², of {total.toFixed(0)} km² of land.
        </p>
      )}
    </>
  );
}

function PressureList({ items }: { items: Pressure[] }) {
  const byKind = new Map<PressureKind, Pressure[]>();
  for (const p of items) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p]);
  const order: PressureKind[] = ["river", "sewage", "port", "marina", "industrial", "resort", "airport", "coastal works"];
  const rows = order.filter((k) => byKind.has(k));
  if (!rows.length) return <p className="fine">None mapped.</p>;
  return (
    <ul className="rows">
      {rows.map((k) => {
        const ps = byKind.get(k)!;
        const near = ps[0];
        return (
          <li key={k}>
            <span>
              <span className="row-name">{KIND_LABEL[k]}</span>
              <span className="row-sub">nearest{near.name ? `: ${near.name}` : ""}, {km(near.km)} km</span>
            </span>
            <span className="tag num">{ps.length}</span>
          </li>
        );
      })}
    </ul>
  );
}
