import NumberFlow from "@number-flow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getDepth, getHabitat, getLayer, getYears, type Depth, type Habitat, type Reef, type Years } from "./api";
import { ATLANTIC, PACIFIC, ReefScene, type Mix, type Taxon } from "./ReefScene";
import { bleachYears, decadeCount, gainNeeded, HOLD_MAX, type ReefYear, reefHistory, triageYears, type Triage } from "./model";
import { ReefMap, VERDICT_COLOR, type Project } from "./ReefMap";
import { Mark } from "./Mark";
import { ScanScene } from "./ScanScene";
import { scanFor } from "./scans";

const GAINS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
const gainText = (g: number) => `+${g} °C`;

const VERDICT: Record<Triage, { title: string; short: string }> = {
  holds: { title: "Holds on its own", short: "Holds on its own" },
  savable: { title: "Restore with heat-tolerant coral", short: "Needs tougher coral" },
  beyond: { title: "Too hot for today's restoration", short: "Too hot to save" },
};

const verdictLine = (v: Triage, g: number) =>
  v === "holds"
    ? "Bleaching-level heat hit it 2 or fewer years in 10. Corals here have time to recover."
    : v === "savable"
      ? `It bleaches too often for today's coral, but coral bred to handle water ${g} °C warmer would hold.`
      : `Even coral bred to handle water ${g} °C warmer would bleach too often. Money planted here is likely lost.`;

type View = "scan" | "rebuilt" | "partner";

type Example = { i: number; name: string; place: string; scan?: string; story?: string };

const EXAMPLES: Example[] = [
  { i: 6426, name: "Spermonde Islands", place: "South Sulawesi, Indonesia", scan: "https://superspl.at/s?id=392787d3&autoplay=false", story: "Mars and partners restore reefs here. At nearby Hope Reef, coral cover rose from 2% in 2019 to 82% in 2024." },
  { i: 16175, name: "Looe Key", place: "Florida Keys, United States" },
  { i: 442, name: "Heron Island", place: "Great Barrier Reef, Australia" },
  { i: 3005, name: "Moorea", place: "French Polynesia" },
  { i: 17268, name: "Okinawa", place: "Japan" },
];

type Pressure = Record<"fishing" | "coastal" | "industry" | "tourism" | "sediment" | "nitrogen" | "pressure" | "connect" | "refuge", number[]>;
type Data = { reefs: Reef[]; years: Years; pressure: Pressure; projects: Project[] };
const NO_PROJECTS: Project[] = [];

const PRESSURES: { k: keyof Pressure; label: string }[] = [
  { k: "fishing", label: "Fishing" },
  { k: "nitrogen", label: "Nitrogen runoff" },
  { k: "sediment", label: "Sediment runoff" },
  { k: "coastal", label: "Coastal population" },
  { k: "tourism", label: "Tourism" },
  { k: "industry", label: "Ports and industry" },
];

const band = (p: number, words: [string, string, string]) => (p < 34 ? words[0] : p < 67 ? words[1] : words[2]);
const mainPressure = (pr: Pressure, i: number) => PRESSURES.reduce((a, b) => (pr[b.k][i] > pr[a.k][i] ? b : a));
const priorityOf = (pr: Pressure, i: number) => 100 - pr.pressure[i] + (pr.connect[i] < 0 ? 50 : pr.connect[i]);

const getStatic = <T,>(file: string, signal: AbortSignal) =>
  fetch(`${import.meta.env.BASE_URL}data/${file}`, { signal }).then((r) => {
    if (!r.ok) throw new Error(`${file} returned ${r.status}`);
    return r.json() as Promise<T>;
  });

const coords = (r: Reef) => `${Math.abs(r.lat).toFixed(2)}° ${r.lat >= 0 ? "N" : "S"}, ${Math.abs(r.lon).toFixed(2)}° ${r.lon >= 0 ? "E" : "W"}`;

const reefName = (r: Reef) => {
  const ex = EXAMPLES.find((e) => e.i === r.i);
  if (ex) return { name: ex.name, place: ex.place };
  return { name: r.eco || r.country || "Reef", place: r.country && r.eco && r.country !== r.eco ? r.country : coords(r) };
};

const taxaFor = (r: Reef): Taxon[] => (r.realm === "Tropical Atlantic" ? ATLANTIC : PACIFIC);
const DEFAULT_MIX: Mix = { coral: 0.3, rock: 0.25, rubble: 0.1, sand: 0.35, seagrass: 0 };
const MIX_PARTS: { k: keyof Mix; label: string; color: string }[] = [
  { k: "coral", label: "Coral and algae", color: "#a8703f" },
  { k: "rock", label: "Rock", color: "#8d8a78" },
  { k: "rubble", label: "Rubble", color: "#cbbfa6" },
  { k: "sand", label: "Sand", color: "#e6dcc4" },
  { k: "seagrass", label: "Seagrass", color: "#5f8a45" },
];

function mixOf(h: Habitat): Mix | null {
  const a = h.area_km2;
  const m = { coral: a["Coral/Algae"] ?? 0, rock: a.Rock ?? 0, rubble: a.Rubble ?? 0, sand: (a.Sand ?? 0) + (a["Microalgal Mats"] ?? 0), seagrass: a.Seagrass ?? 0 };
  const total = m.coral + m.rock + m.rubble + m.sand + m.seagrass;
  if (total < 0.05) return null;
  return { coral: m.coral / total, rock: m.rock / total, rubble: m.rubble / total, sand: m.sand / total, seagrass: m.seagrass / total };
}
const LIVING = "#9a6235";
const BLEACHED = "#f3efe6";
const DEAD = "#5f6652";
const coverBar = (h: ReefYear) => {
  const live = (1 - h.dead - h.white) * 100;
  const white = live + h.white * 100;
  return `linear-gradient(to top, ${LIVING} 0 ${live}%, ${BLEACHED} ${live}% ${white}%, ${DEAD} ${white}% 100%)`;
};

function readReef() {
  const v = new URLSearchParams(window.location.hash.slice(1)).get("reef");
  return v === null ? null : Number(v);
}

export function Story() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sel, setSel] = useState<number | null>(readReef);
  const [warm, setWarm] = useState(false);
  const [gain, setGain] = useState(0.5);
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const about = useRef<HTMLDialogElement>(null);
  const [habitat, setHabitat] = useState<{ i: number; mix: Mix | null } | null>(null);
  const [depth, setDepth] = useState<{ i: number; d: Depth } | null>(null);
  const [view, setView] = useState<View>("scan");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const ctl = new AbortController();
    setFailed(null);
    Promise.all([getLayer(ctl.signal), getYears(ctl.signal), getStatic<Pressure>("pressure.json", ctl.signal), getStatic<Project[]>("projects.json", ctl.signal)])
      .then(([layer, years, pressure, projects]) => setData({ reefs: layer.reefs, years, pressure, projects }))
      .catch((e: Error) => !ctl.signal.aborted && setFailed(e.message));
    return () => ctl.abort();
  }, [attempt]);

  useEffect(() => {
    window.history.replaceState(null, "", sel === null ? window.location.pathname : `#reef=${sel}`);
  }, [sel]);

  useEffect(() => {
    if (!data || sel === null) return;
    const ctl = new AbortController();
    const r = data.reefs[sel];
    const timer = window.setTimeout(() => ctl.abort(), 12000);
    getHabitat(r.lat, r.lon, ctl.signal)
      .then((h) => setHabitat({ i: sel, mix: mixOf(h) }))
      .catch(() => setHabitat({ i: sel, mix: null }))
      .finally(() => window.clearTimeout(timer));
    getDepth(r.lat, r.lon, ctl.signal)
      .then((d) => setDepth({ i: sel, d }))
      .catch(() => setDepth({ i: sel, d: { source: null } }));
    return () => ctl.abort();
  }, [data, sel]);

  const shift = warm ? 0.5 : 0;
  const verdicts = useMemo(() => (data ? data.reefs.map((_, k) => triageYears(data.years, k, shift, gain)) : []), [data, shift, gain]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data || q.length < 2) return null;
    return new Set(data.reefs.filter((x) => `${x.eco} ${x.country} ${reefName(x).name}`.toLowerCase().includes(q)).map((x) => x.i));
  }, [data, query]);

  const shares = useMemo(() => {
    const c = { holds: 0, savable: 0, beyond: 0 };
    let n = 0;
    verdicts.forEach((v, i) => {
      if (matches && !matches.has(i)) return;
      c[v]++;
      n++;
    });
    const d = Math.max(n, 1);
    return { n, holds: c.holds / d, savable: c.savable / d, beyond: c.beyond / d };
  }, [verdicts, matches]);

  const curve = useMemo(() => {
    if (!data) return GAINS.map(() => 0);
    const hold = GAINS.map(() => 0);
    let n = 0;
    for (const x of data.reefs) {
      if (matches && !matches.has(x.i)) continue;
      n++;
      GAINS.forEach((g, k) => {
        if (bleachYears(data.years, x.i, shift - g) <= HOLD_MAX) hold[k]++;
      });
    }
    return hold.map((h) => h / Math.max(n, 1));
  }, [data, matches, shift]);

  const ranking = useMemo(() => {
    if (!data) return { order: [] as number[], rank: new Map<number, number>() };
    const pr = data.pressure;
    const order = data.reefs.map((r) => r.i).filter((i) => verdicts[i] === "savable" && pr.pressure[i] >= 0).sort((a, b) => priorityOf(pr, b) - priorityOf(pr, a));
    return { order, rank: new Map(order.map((i, k) => [i, k])) };
  }, [data, verdicts]);

  const focus = useMemo((): [number, number, number, number] | null => {
    if (!data || !matches || matches.size === 0) return null;
    let [w, so, e, n] = [180, 90, -180, -90];
    for (const i of matches) {
      const r = data.reefs[i];
      w = Math.min(w, r.lon); e = Math.max(e, r.lon); so = Math.min(so, r.lat); n = Math.max(n, r.lat);
    }
    return e - w > 180 ? null : [w, so, e, n];
  }, [data, matches]);

  const scoped = useMemo(() => (matches ? ranking.order.filter((i) => matches.has(i)) : ranking.order), [ranking, matches]);

  const shortlist = useMemo(() => {
    if (!data) return [];
    if (matches) return scoped.slice(0, 6);
    const seen = new Set<string>();
    const out: number[] = [];
    for (const i of scoped) {
      const key = data.reefs[i].country || data.reefs[i].eco;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(i);
      if (out.length === 6) break;
    }
    return out;
  }, [data, scoped, matches]);

  function download() {
    if (!data) return;
    const pr = data.pressure;
    const rows = scoped.map((i, k) => {
      const x = data.reefs[i];
      return [k + 1, reefName(x).name, x.country, x.lat, x.lon, bleachYears(data.years, i, shift), bleachYears(data.years, i, shift + 0.5), gainNeeded(data.years, i, shift) ?? "", pr.pressure[i], mainPressure(pr, i).label, pr.connect[i]];
    });
    const head = ["rank", "reef", "country", "lat", "lon", "bleaching_years_last_10", "bleaching_years_plus_0_5C", "heat_tolerance_needed_C", "local_pressure_percentile", "main_pressure", "larvae_supply_percentile"];
    const csv = [head, ...rows].map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `coralytics-restoration-${query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") || "world"}${warm ? "-plus-0.5C" : ""}-coral-plus-${gain}C.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const lastYear = data ? data.years.years.length - 1 : 0;
  const year = t ?? lastYear;

  useEffect(() => {
    if (!playing || !data) return;
    const id = window.setInterval(() => {
      setT((k) => {
        const next = (k ?? lastYear) + 1;
        if (next > lastYear) {
          setPlaying(false);
          return lastYear;
        }
        return next;
      });
    }, 260);
    return () => window.clearInterval(id);
  }, [playing, data, lastYear]);

  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function choose(i: number | null) {
    setSel(i);
    setView("scan");
    setT(i === null || reduce ? null : 0);
    setPlaying(i !== null && !reduce);
  }

  const started = useRef(false);
  useEffect(() => {
    if (!data || started.current) return;
    started.current = true;
    if (sel !== null && !reduce) {
      setT(0);
      setPlaying(true);
    }
  }, [data, sel, reduce]);

  function play() {
    if (playing) return setPlaying(false);
    setT(0);
    setPlaying(true);
  }

  const r = data && sel !== null ? data.reefs[sel] : null;
  const y = data?.years;
  const risk = r && y ? y.ann[year * y.n + r.i] / y.scale : 0;
  const history = useMemo(() => (data && sel !== null ? reefHistory(data.years, sel) : null), [data, sel]);
  const now = history ? history[year] : null;
  const example = r ? EXAMPLES.find((e) => e.i === r.i) : undefined;
  const scan = r ? scanFor(r) : null;

  return (
    <div className="shell">
      <header className="bar">
        <a className="mark" href="#" onClick={(e) => { e.preventDefault(); choose(null); }}>
          <Mark size={28} />
          coralytics
        </a>
        <button className="ghost" onClick={() => about.current?.showModal()}>How it works</button>
      </header>

      <main className="body">
        <section className="stage" data-reef={r !== null} data-view={view}>
          {data && <ReefMap reefs={data.reefs} verdicts={verdicts} projects={r ? NO_PROJECTS : data.projects} selected={sel} focus={focus} compact={r !== null} onPick={choose} />}
          {!data && !failed && <div className="stage-wait">Loading 18,445 reefs</div>}
          {data && !r && (
            <ul className="maplegend" aria-label="Map legend">
              {(["holds", "savable", "beyond"] as const).map((k) => <li key={k}><span className="dot" style={{ background: VERDICT_COLOR[k] }} />{VERDICT[k].short}</li>)}
              <li><span className="ring" />Restoration project</li>
            </ul>
          )}
          {r && (
            <div className="specimen">
              <div className="seg" role="group" aria-label="View">
                <button aria-pressed={view === "scan"} onClick={() => setView("scan")}>Real reef</button>
                <button aria-pressed={view === "rebuilt"} onClick={() => setView("rebuilt")}>From satellite</button>
                {example?.scan && <button aria-pressed={view === "partner"} onClick={() => setView("partner")}>Mars reef</button>}
              </div>
              {view === "partner" && example?.scan ? (
                <iframe className="scan" src={example.scan} title="Gaussian splat of a Mars-restored reef in Indonesia" allow="fullscreen; xr-spatial-tracking" />
              ) : view === "scan" ? (
                <ScanScene url={`${import.meta.env.BASE_URL}${scan!.file}`} white={now!.white} dead={now!.dead} label={`Real reef scan coloured by ${reefName(r).name}'s ${Math.round(risk * 100)}% bleaching risk in ${y!.years[year]}`} />
              ) : habitat?.i === r.i ? (
                <ReefScene seed={r.i} mix={habitat.mix ?? DEFAULT_MIX} taxa={taxaFor(r)} risk={risk} depth={depth?.i === r.i ? depth.d.median ?? null : null} label={`Reconstructed reef patch for ${reefName(r).name} in ${y!.years[year]}, at ${Math.round(risk * 100)}% bleaching risk`} />
              ) : (
                <div className="stage-wait light">Mapping this reef from satellite</div>
              )}
              {view !== "partner" && (
                <div className="specimen-year" aria-live="polite">
                  <span className="num">{y!.years[year]}</span>
                  {view === "scan" && <span className="left num">{Math.round(now!.left * 100)}% of coral left</span>}
                </div>
              )}
              {view === "scan" && (
                <ul className="key" aria-label="Legend">
                  <li><span style={{ background: "linear-gradient(135deg, #2fb6c4, #9a6235)" }} />Living, as scanned</li>
                  <li><span style={{ background: BLEACHED }} />Bleached this year</li>
                  <li><span style={{ background: DEAD }} />Dead, overgrown by algae</li>
                </ul>
              )}
              {view === "partner" && <p className="specimen-note">Real 3D scan of a reef in Indonesia restored by Mars. Data: J. Stratford, B. Williams, A. Dwiyanto, Mars Coral Restoration Project, T.B. Razak, T.A.C. Lamont.</p>}
              {view === "scan" && <p className="specimen-note">{scan!.km < 60 ? `Real 3D scan from ${scan!.place}` : `Real 3D scan from ${scan!.place}, the nearest open scan, ${scan!.km.toLocaleString("en-GB")} km away`} ({scan!.credit}, CC BY 4.0). Colours follow the model's heat risk for this reef each year.</p>}
              {view === "rebuilt" && <p className="specimen-note">Rebuilt from this reef's satellite habitat map (Allen Coral Atlas), with Smithsonian scans of {r.realm === "Tropical Atlantic" ? "Caribbean" : "Indo-Pacific"} corals. Colour follows the model's risk.</p>}
            </div>
          )}
        </section>

        <aside className="panel" aria-live="polite">
          {failed && (
            <div className="block">
              <h1>The model is not responding</h1>
              <p className="lede">{failed}</p>
              <button className="btn" onClick={() => setAttempt((a) => a + 1)}>Try again</button>
            </div>
          )}
          {!failed && !data && (
            <div aria-busy="true">
              <div className="skel" style={{ height: 34, width: "80%" }} />
              <div className="skel" style={{ height: 72, marginTop: 16 }} />
              <div className="skel" style={{ height: 120, marginTop: 24 }} />
            </div>
          )}

          {data && !r && (
            <>
              <h1>Find reefs worth restoring</h1>
              <p className="lede">Every reef scored on how often heat bleaches it, whether heat-tolerant coral would hold, and what else stops it recovering.</p>
              <label className="search">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" fill="none" /><path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search a country or reef region" aria-label="Search a country or reef region" />
              </label>
              <Warm warm={warm} setWarm={setWarm} />
              <div className="triage" role="img" aria-label={`${shares.n} reefs: ${Math.round(shares.holds * 100)}% hold, ${Math.round(shares.savable * 100)}% need tougher coral, ${Math.round(shares.beyond * 100)}% too hot`}>
                <div className="triage-bar">
                  {(["holds", "savable", "beyond"] as const).map((k) => <span key={k} style={{ flexGrow: shares[k], background: VERDICT_COLOR[k] }} />)}
                </div>
                <ul>
                  {(["holds", "savable", "beyond"] as const).map((k) => (
                    <li key={k}><span className="num"><NumberFlow value={Math.round(shares[k] * 100)} suffix="%" /></span><span><span className="dot" style={{ background: VERDICT_COLOR[k] }} />{VERDICT[k].short}</span></li>
                  ))}
                </ul>
                <p className="fine">{shares.n.toLocaleString("en-GB")} reefs{matches ? ` matching "${query.trim()}"` : " worldwide"}{warm ? ", with 0.5 °C more warming" : ""}.</p>
              </div>
              <Tolerance curve={curve} gain={gain} setGain={setGain} />
              <div className="listhead">
                <h2>Best places to restore{matches ? ` in "${query.trim()}"` : ""}</h2>
                {scoped.length > 0 && <button className="ghost small" onClick={download}>Download {scoped.length.toLocaleString("en-GB")} as CSV</button>}
              </div>
              {shortlist.length === 0 && <p className="fine">No reef here needs heat-tolerant coral{warm ? "" : " today"}. Try turning on warming, or another search.</p>}
              <ul className="list">
                {shortlist.map((i, k) => {
                  const n = reefName(data.reefs[i]);
                  if (shortlist.some((j) => j !== i && data.reefs[j].eco === data.reefs[i].eco)) n.place = `${n.place} · ${coords(data.reefs[i])}`;
                  return (
                    <li key={i}>
                      <button className="item" onClick={() => choose(i)}>
                        <span className="rank num">{k + 1}</span>
                        <span className="grow"><span className="item-name">{n.name}</span><span className="item-place">{n.place}</span></span>
                        <span className="cols num"><span>{bleachYears(data.years, i, shift)}/10</span><span>{band(data.pressure.pressure[i], ["Low", "Mid", "High"])}</span></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {shortlist.length > 0 && <p className="fine">Reefs that bleach too often today but would hold with coral bred {gainText(gain)} tougher, ranked by local pressure and larvae from nearby reefs. Columns: bleaching years in the last 10, local pressure.</p>}
              <div className="chips">
                <span>Examples</span>
                {EXAMPLES.map((e) => <button key={e.i} onClick={() => choose(e.i)}>{e.name}</button>)}
              </div>
            </>
          )}

          {data && r && y && (
            <ReefPanel history={history!} pressure={data.pressure} rank={ranking.rank.get(r.i)} ranked={ranking.order.length} example={example} depth={depth?.i === r.i ? depth.d : undefined} mix={habitat?.i === r.i ? habitat.mix : undefined} r={r} y={y} verdict={verdicts[r.i]} gain={gain} shift={shift} year={year} setYear={(k) => { setPlaying(false); setT(k); }} playing={playing} play={play} warm={warm} setWarm={setWarm} back={() => choose(null)} />
          )}
        </aside>
      </main>

      <dialog ref={about} className="about" onClick={(e) => e.target === about.current && about.current?.close()}>
        <div className="about-body">
          <h2>How it works</h2>
          <dl>
            <dt>The model</dt>
            <dd>Gradient-boosted trees trained on daily NOAA sea temperature since 1985, at 5 km, and 17,332 diver surveys from the Global Coral Bleaching Database. It predicts the chance that at least 30% of a reef's corals bleach.</dd>
            <dt>Tested on years it never saw</dt>
            <dd>Trained on surveys up to 2013, scored on 2016 to 2020. It ranks bleaching better than NOAA's standard heat alert: 0.935 against 0.906 (AUROC, 2,771 surveys).</dd>
            <dt>Checked against new surveys</dt>
            <dd>MERMAID, WCS's open reef survey platform, holds 201 bleaching surveys from 2021 to 2025 in 10 countries, all after our training data ends. The model ranks them at 0.84 AUROC for 30% or more of corals bleached.</dd>
            <dt>What protection is worth</dt>
            <dd>In 3,385 MERMAID coral surveys, compared within the same country, each bleaching year in the past decade went with 1.9 fewer points of hard coral cover. No-take reserves held 3.2 more points and about twice the fish. So a reserve is worth roughly 1.7 bleaching years. This is an association across sites, not a controlled trial.</dd>
            <dt>Bleached, then dead</dt>
            <dd>Bleached coral is alive but starving. In the scene, about 40% of the coral that bleaches in a year dies and is overgrown by algae; the rest regains its colour. Dead patches regrow at about 14% a year, so a reef takes 10 to 15 years to come back (Hughes et al. 2018). "Coral left" is this illustration, not a survey.</dd>
            <dt>A bleaching year</dt>
            <dd>A year in which the model put the reef past 50% risk at its hottest month. Fast-growing corals need 10 to 15 years to recover (Hughes et al. 2018), so a reef holds if this happens 2 or fewer years in 10.</dd>
            <dt>Depth</dt>
            <dd>From the sharpest open survey that covers the reef: NOAA's 3 m depth models for US reefs, Digital Earth Pacific's 10 m satellite depth for Pacific islands, and Geoscience Australia's 30 m model for the Great Barrier Reef. Deeper reefs are shown darker and bluer. Depth is not a model input.</dd>
            <dt>Heat-tolerant coral</dt>
            <dd>Selective breeding and assisted gene flow aim to give corals more heat tolerance. We model a gain of X °C as the same reef in water X °C cooler, and you choose X. Breeding is real but slow: one generation of selection adds about 1 °C-week of tolerance (Humanes et al. 2024, Nature Communications), and a 0.5 °C warmer heatwave adds several °C-weeks. So +0.5 °C is several generations of breeding, not one. "Heat tolerance needed" tells a breeding program the target for each reef.</dd>
            <dt>Future warming</dt>
            <dd>The world is warming about 0.27 °C a decade (Forster et al. 2025, Indicators of Global Climate Change). At that rate, 0.5 °C more arrives around 2040. Tropical seas warm a little more slowly, so this is an early estimate.</dd>
            <dt>Restoration projects</dt>
            <dd>The 304 projects in Boström-Einarsson et al. (2020, PLoS ONE, data on Dryad). 224 sit within 25 km of a reef we score. The review records why each site was chosen: an existing restoration site, a disturbance, logistics or "favourable conditions". None names heat or bleaching. With 0.5 °C more warming, 66% of these projects would sit on reefs too hot for today's coral.</dd>
            <dt>Will it recover?</dt>
            <dd>Local pressure comes from WCS's global map of six human pressures on reefs (Andrello et al. 2022): fishing, nitrogen and sediment runoff, coastal population, tourism, and ports. Connection to other reefs, which brings in coral larvae, comes from the 50 Reefs analysis (Beyer et al. 2018). Neither changes the bleaching model. They rank where restoration is most likely to last.</dd>
            <dt>Limits and safeguards</dt>
            <dd>Surveys are densest in Australia, the Caribbean and Southeast Asia, so the model is least sure elsewhere. It shows where heat makes restoration hard. It does not decide for the people who depend on a reef. A reef marked too hot still needs protection, and the call stays with local communities. Heat-tolerant coral from breeding or assisted gene flow can cut genetic diversity, so sourcing stays local and is monitored. Code and data are open so anyone can check the numbers.</dd>
            <dt>Open source</dt>
            <dd>Coralytics is an open, community-led tool. The model, the data joins and this map are public, built only on open data. Restoration teams and divers can add their own surveys, which retrain the model and make it surer where it is weakest today.</dd>
            <dt>The reef you see</dt>
            <dd>Real 3D scans of reefs, all CC BY 4.0: Soneva and Wildflow's Gaussian splats of Maldives restoration plots, the Galapagos_3D survey (Yuval, Keith et al.), and diver photogrammetry from the Great Barrier Reef, Belize, the US Virgin Islands, Okinawa, Mayotte and Thailand shared on Sketchfab. Each reef shows the nearest scan. Each year, living tissue turns white in colony-sized patches as the model's risk for that reef rises, and some of the bleached coral dies. "From satellite" instead rebuilds the reef from its Allen Coral Atlas habitat map with Smithsonian coral scans (CC0).</dd>
          </dl>
          <div className="about-foot">
            <a href="#classic" onClick={() => window.location.reload()}>Open the full explorer</a>
            <button className="btn" onClick={() => about.current?.close()}>Close</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

function Tolerance({ curve, gain, setGain }: { curve: number[]; gain: number; setGain: (g: number) => void }) {
  return (
    <div className="tolerance">
      <h2>How much tougher must coral be?</h2>
      <p className="fine">Share of these reefs that hold if restored coral handles warmer water. Pick a target.</p>
      <div className="tol-bars" role="group" aria-label="Heat tolerance of restored coral">
        {GAINS.map((g, k) => (
          <button key={g} className="tol" aria-pressed={g === gain} disabled={g === 0} onClick={() => setGain(g)} aria-label={`${g === 0 ? "Today's coral" : `Coral ${gainText(g)}`}: ${Math.round(curve[k] * 100)}% of reefs hold`}>
            <span className="tol-pct num">{Math.round(curve[k] * 100)}%</span>
            <span className="tol-bar"><span style={{ height: `${curve[k] * 100}%` }} /></span>
            <span className="tol-x num">{g === 0 ? "Today" : gainText(g)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Warm({ warm, setWarm }: { warm: boolean; setWarm: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={warm} onChange={(e) => setWarm(e.target.checked)} />
      <span className="track" aria-hidden="true"><span className="thumb" /></span>
      <span>Add 0.5 °C of warming, about 2040</span>
    </label>
  );
}

function ReefPanel(p: { history: ReefYear[]; pressure: Pressure; rank: number | undefined; ranked: number; example: Example | undefined; depth: Depth | undefined; mix: Mix | null | undefined; r: Reef; y: Years; verdict: Triage; gain: number; shift: number; year: number; setYear: (k: number) => void; playing: boolean; play: () => void; warm: boolean; setWarm: (v: boolean) => void; back: () => void }) {
  const { r, y } = p;
  const name = reefName(r);
  const now = bleachYears(y, r.i, p.shift);
  const before = decadeCount(y, r.i, 1988);
  const v = VERDICT[p.verdict];
  const need = gainNeeded(y, r.i, p.shift);
  return (
    <>
      <button className="back" onClick={p.back}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        All reefs
      </button>
      <h1>{name.name}</h1>
      <p className="place">{name.place}</p>

      <div className="verdict" style={{ ["--v" as string]: VERDICT_COLOR[p.verdict] }}>
        <div className="verdict-title"><span className="dot" />{v.title}</div>
        <p>{verdictLine(p.verdict, p.gain)}</p>
      </div>
      {p.example?.story && <p className="story">{p.example.story} {bleachYears(y, r.i, 0.5) > HOLD_MAX && bleachYears(y, r.i, 0) <= HOLD_MAX ? `Today it holds. With half a degree more warming it would bleach ${bleachYears(y, r.i, 0.5)} years in 10.` : ""}</p>}

      <div className="figure">
        <div className="figure-n num"><NumberFlow value={now} /><span className="of"> of 10</span></div>
        <p>years since 2016 hot enough to bleach this reef{p.warm ? ", with 0.5 °C more warming" : ""}. In 1988 to 1997 it was {before} of 10.</p>
      </div>

      <div className="need">
        <h2>Heat tolerance needed</h2>
        <div className="need-n num">{need === null ? `Over ${gainText(p.shift + 1.5)}` : need === 0 ? "None" : gainText(need)}</div>
        <p className="fine">{need === null ? "No coral we model would hold here. Spend restoration money elsewhere." : need === 0 ? "Today's coral holds here. Protect it and cut local pressure." : `Coral bred to handle water ${need} °C warmer would keep bleaching to 2 years in 10${p.warm ? ", even with 0.5 °C more warming" : ""}. The target for a breeding program.`}</p>
      </div>

      <div className="years">
        <div className="years-head">
          <h2>Forty years of this reef</h2>
          <button className="btn glow" onClick={p.play}>{p.playing ? "Pause" : "Play"}</button>
        </div>
        <div className="strip" role="group" aria-label="Choose a year">
          {y.years.map((yr, k) => {
            const risk = y.ann[k * y.n + r.i] / y.scale;
            const h = p.history[k];
            return (
              <button
                key={yr}
                className="tile"
                aria-pressed={k === p.year}
                aria-label={`${yr}: ${Math.round(risk * 100)}% heat risk, ${Math.round(h.left * 100)}% of coral left`}
                style={{ background: coverBar(h) }}
                onClick={() => p.setYear(k)}
              />
            );
          })}
        </div>
        <div className="strip-axis num" aria-hidden="true">
          {y.years.map((yr, k) => (yr % 10 === 0 ? <span key={yr} style={{ gridColumn: `${k + 1} / span 6` }}>{yr}</span> : null))}
        </div>
        <p className="fine">Each bar is the reef that year: <b style={{ color: LIVING }}>living coral</b>, <b>bleached</b>, and <b style={{ color: DEAD }}>dead</b>. Coral that dies takes 10 to 15 years to grow back, so bleaching years stack up. {y.years[p.year]}: {Math.round((y.ann[p.year * y.n + r.i] / y.scale) * 100)}% heat risk, {Math.round(p.history[p.year].left * 100)}% of coral left.</p>
      </div>

      <Warm warm={p.warm} setWarm={p.setWarm} />

      <Recover pr={p.pressure} i={r.i} verdict={p.verdict} rank={p.rank} ranked={p.ranked} />

      <div className="onreef">
        <h2>On this reef</h2>
        {p.mix === undefined && <div className="skel" style={{ height: 10, marginTop: 12 }} />}
        {p.mix === null && <p className="fine">No satellite habitat map covers this reef, so the scene uses a typical mix.</p>}
        {p.mix && (
          <>
            <div className="mixbar" role="img" aria-label={MIX_PARTS.map((m) => `${m.label} ${Math.round(p.mix![m.k] * 100)}%`).join(", ")}>
              {MIX_PARTS.map((m) => p.mix![m.k] > 0.005 && <span key={m.k} style={{ flexGrow: p.mix![m.k], background: m.color }} />)}
            </div>
            <ul className="mixlegend">
              {MIX_PARTS.filter((m) => p.mix![m.k] >= 0.01).map((m) => (
                <li key={m.k}><span className="dot" style={{ background: m.color }} />{m.label} <span className="num">{Math.round(p.mix![m.k] * 100)}%</span></li>
              ))}
            </ul>
          </>
        )}
        <div className="depthline">
          <span className="depth-label">Depth</span>
          {p.depth === undefined && <span className="skel" style={{ height: 14, width: 120, display: "inline-block" }} />}
          {p.depth && p.depth.source && (
            <span><span className="num">{p.depth.p10 === p.depth.p90 ? `${p.depth.median} m` : `${p.depth.p10} to ${p.depth.p90} m`}</span>{p.depth.on_coral ? " where coral is mapped" : " across this reef"}<span className="depth-src">{p.depth.source}, {p.depth.res_m} m grid</span></span>
          )}
          {p.depth && !p.depth.source && <span className="depth-none">No open depth survey covers this reef yet</span>}
        </div>
        <p className="fine">Mapped from satellite within 7 km (Allen Coral Atlas). In the scene, {taxaFor(r)[0].name.toLowerCase()} bleaches first and {taxaFor(r)[taxaFor(r).length - 1].name.toLowerCase()} last, the order seen in past heatwaves (Loya et al. 2001).</p>
      </div>
    </>
  );
}

function Recover({ pr, i, verdict, rank, ranked }: { pr: Pressure; i: number; verdict: Triage; rank: number | undefined; ranked: number }) {
  if (pr.pressure[i] < 0) {
    return (
      <div className="onreef">
        <h2>Will it recover?</h2>
        <p className="fine">No local pressure data covers this reef.</p>
      </div>
    );
  }
  const main = mainPressure(pr, i);
  const top = rank === undefined ? null : Math.max(1, Math.ceil(((rank + 1) / ranked) * 100));
  return (
    <div className="onreef">
      <h2>Will it recover?</h2>
      <dl className="facts">
        <div><dt>Local pressure</dt><dd>{band(pr.pressure[i], ["Low", "Moderate", "High"])}<span className="sub">Worse than {pr.pressure[i]}% of reefs. Mostly {main.label.toLowerCase()}.</span></dd></div>
        {pr.connect[i] >= 0 && <div><dt>Coral larvae from other reefs</dt><dd>{band(pr.connect[i], ["Few", "Average", "Many"])}<span className="sub">{pr.refuge[i] ? "One of the 50 Reefs climate refuges." : "Helps a restored reef reseed itself."}</span></dd></div>}
        <div><dt>Best action</dt><dd>{verdict === "savable" ? (top !== null ? `Restore, top ${top}% priority` : "Restore") : verdict === "holds" ? (pr.pressure[i] >= 67 ? `Cut ${main.label.toLowerCase()}` : "Protect it") : "Spend elsewhere"}<span className="sub">{verdict === "savable" ? `Ranked among ${ranked.toLocaleString("en-GB")} reefs that need heat-tolerant coral, by local pressure and larvae.` : verdict === "holds" ? (pr.pressure[i] >= 67 ? "Heat still lets it recover. In surveys, no-take reserves hold about 3 more points of coral." : "Heat lets it recover on its own.") : "Heat would undo the work. Protection still matters for the people who use it."}</span></dd></div>
      </dl>
    </div>
  );
}
