import NumberFlow from "@number-flow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getLayer, getYears, type Reef, type Years } from "./api";
import { CoralView, type Species } from "./CoralView";
import { bleachYears, decadeCount, triageYears, type Triage } from "./model";
import { ReefMap, VERDICT_COLOR } from "./ReefMap";

const GAIN = 0.5;

const VERDICT: Record<Triage, { title: string; line: string; short: string }> = {
  holds: { title: "Holds on its own", line: "Bleaching-level heat hit it 2 or fewer years in 10. Corals here have time to recover.", short: "Holds on its own" },
  savable: { title: "Restore with heat-tolerant coral", line: "It bleaches too often for today's coral, but coral half a degree tougher would hold.", short: "Needs tougher coral" },
  beyond: { title: "Too hot for today's restoration", line: "Even coral half a degree tougher would bleach too often. Money planted here is likely lost.", short: "Too hot to save" },
};

const EXAMPLES = [
  { i: 16175, name: "Looe Key", place: "Florida Keys, United States" },
  { i: 442, name: "Heron Island", place: "Great Barrier Reef, Australia" },
  { i: 3005, name: "Moorea", place: "French Polynesia" },
  { i: 17268, name: "Okinawa", place: "Japan" },
];

type Data = { reefs: Reef[]; years: Years };

const reefName = (r: Reef) => {
  const ex = EXAMPLES.find((e) => e.i === r.i);
  if (ex) return { name: ex.name, place: ex.place };
  return { name: r.eco || r.country || "Reef", place: r.country && r.eco ? r.country : `${Math.abs(r.lat).toFixed(2)}° ${r.lat >= 0 ? "N" : "S"}, ${Math.abs(r.lon).toFixed(2)}° ${r.lon >= 0 ? "E" : "W"}` };
};

const speciesFor = (r: Reef): Species => (r.realm === "Tropical Atlantic" ? "staghorn" : "pocillopora");
const bleachOf = (risk: number) => {
  const x = Math.min(1, Math.max(0, (risk - 0.3) / 0.3));
  return x * x * (3 - 2 * x);
};
const tileColor = (risk: number) => {
  const b = bleachOf(risk);
  const mix = (a: number, c: number) => Math.round(a + (c - a) * b);
  return `rgb(${mix(140, 247)} ${mix(88, 244)} ${mix(44, 236)})`;
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
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const about = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setFailed(null);
    Promise.all([getLayer(ctl.signal), getYears(ctl.signal)])
      .then(([layer, years]) => setData({ reefs: layer.reefs, years }))
      .catch((e: Error) => !ctl.signal.aborted && setFailed(e.message));
    return () => ctl.abort();
  }, [attempt]);

  useEffect(() => {
    window.history.replaceState(null, "", sel === null ? window.location.pathname : `#reef=${sel}`);
  }, [sel]);

  const shift = warm ? 0.5 : 0;
  const verdicts = useMemo(() => (data ? data.reefs.map((_, k) => triageYears(data.years, k, shift, GAIN)) : []), [data, shift]);
  const shares = useMemo(() => {
    const c = { holds: 0, savable: 0, beyond: 0 };
    for (const v of verdicts) c[v]++;
    const n = Math.max(verdicts.length, 1);
    return { holds: c.holds / n, savable: c.savable / n, beyond: c.beyond / n };
  }, [verdicts]);

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

  return (
    <div className="shell">
      <header className="bar">
        <a className="mark" href="#" onClick={(e) => { e.preventDefault(); choose(null); }}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#e4f222" /><path d="M5 12.5c2-3 4-3 5-1s3 2 5-1" stroke="#0f0f0d" strokeWidth="1.6" fill="none" strokeLinecap="round" /></svg>
          Reef Margin
        </a>
        <button className="ghost" onClick={() => about.current?.showModal()}>How it works</button>
      </header>

      <main className="body">
        <section className="stage" data-reef={r !== null}>
          {data && <ReefMap reefs={data.reefs} verdicts={verdicts} selected={sel} compact={r !== null} onPick={choose} />}
          {!data && !failed && <div className="stage-wait">Loading 18,445 reefs</div>}
          {r && (
            <div className="specimen">
              <CoralView species={speciesFor(r)} bleach={bleachOf(risk)} label={`Coral shown ${risk >= 0.5 ? "bleached" : "healthy"} for ${y!.years[year]}`} />
              <div className="specimen-year num" aria-live="polite">{y!.years[year]}</div>
              <p className="specimen-note">Museum scan of {speciesFor(r) === "staghorn" ? "staghorn coral" : "cauliflower coral"} (Smithsonian, CC0). Colour shows the model's risk for this reef that year.</p>
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
              <h1>Which reefs are worth restoring?</h1>
              <p className="lede">Coral planted where the water gets too hot dies, and the money goes with it. We trained a model on 40 years of ocean temperature and 17,000 diver surveys to tell the reefs apart.</p>
              <div className="shares">
                {(["holds", "savable", "beyond"] as const).map((k) => (
                  <div key={k} className="share">
                    <div className="share-n num"><NumberFlow value={Math.round(shares[k] * 100)} suffix="%" /></div>
                    <div className="share-l"><span className="dot" style={{ background: VERDICT_COLOR[k] }} />{VERDICT[k].short}</div>
                  </div>
                ))}
              </div>
              <Warm warm={warm} setWarm={setWarm} />
              <h2>Try a reef</h2>
              <ul className="list">
                {EXAMPLES.map((e) => {
                  const v = verdicts[e.i];
                  return (
                    <li key={e.i}>
                      <button className="item" onClick={() => choose(e.i)}>
                        <span><span className="item-name">{e.name}</span><span className="item-place">{e.place}</span></span>
                        <span className="tag"><span className="dot" style={{ background: VERDICT_COLOR[v] }} />{VERDICT[v].short}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="fine">Or click any dot on the map. Each one is 5 km of reef.</p>
            </>
          )}

          {data && r && y && (
            <ReefPanel r={r} y={y} verdict={verdicts[r.i]} shift={shift} year={year} setYear={(k) => { setPlaying(false); setT(k); }} playing={playing} play={play} warm={warm} setWarm={setWarm} back={() => choose(null)} />
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
            <dt>A bleaching year</dt>
            <dd>A year in which the model put the reef past 50% risk at its hottest month. Fast-growing corals need 10 to 15 years to recover (Hughes et al. 2018), so a reef holds if this happens 2 or fewer years in 10.</dd>
            <dt>Heat-tolerant coral</dt>
            <dd>Selective breeding and assisted gene flow aim to give corals more heat tolerance. We model a gain of 0.5 °C as the same reef in cooler water.</dd>
            <dt>The coral you see</dt>
            <dd>A Smithsonian museum scan (CC0), not a photo of this reef. Its colour shows the model's risk for the reef in the chosen year.</dd>
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

function Warm({ warm, setWarm }: { warm: boolean; setWarm: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={warm} onChange={(e) => setWarm(e.target.checked)} />
      <span className="track" aria-hidden="true"><span className="thumb" /></span>
      <span>Add 0.5 °C of future warming</span>
    </label>
  );
}

function ReefPanel(p: { r: Reef; y: Years; verdict: Triage; shift: number; year: number; setYear: (k: number) => void; playing: boolean; play: () => void; warm: boolean; setWarm: (v: boolean) => void; back: () => void }) {
  const { r, y } = p;
  const name = reefName(r);
  const now = bleachYears(y, r.i, p.shift);
  const before = decadeCount(y, r.i, 1988);
  const v = VERDICT[p.verdict];
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
        <p>{v.line}</p>
      </div>

      <div className="figure">
        <div className="figure-n num"><NumberFlow value={now} /><span className="of"> of 10</span></div>
        <p>years since 2016 hot enough to bleach this reef{p.warm ? ", with 0.5 °C more warming" : ""}. In 1988 to 1997 it was {before} of 10.</p>
      </div>

      <div className="years">
        <div className="years-head">
          <h2>Forty years of this reef</h2>
          <button className="btn glow" onClick={p.play}>{p.playing ? "Pause" : "Play"}</button>
        </div>
        <div className="strip" role="group" aria-label="Choose a year">
          {y.years.map((yr, k) => {
            const risk = y.ann[k * y.n + r.i] / y.scale;
            return (
              <button
                key={yr}
                className="tile"
                aria-pressed={k === p.year}
                aria-label={`${yr}: ${Math.round(risk * 100)}% bleaching risk`}
                style={{ background: tileColor(risk) }}
                onClick={() => p.setYear(k)}
              />
            );
          })}
        </div>
        <div className="strip-axis num" aria-hidden="true">
          {y.years.map((yr, k) => (yr % 10 === 0 ? <span key={yr} style={{ gridColumn: `${k + 1} / span 6` }}>{yr}</span> : null))}
        </div>
        <p className="fine">Brown is healthy. White is a year the model put this reef past 50% bleaching risk. {y.years[p.year]}: {Math.round((y.ann[p.year * y.n + r.i] / y.scale) * 100)}% risk.</p>
      </div>

      <Warm warm={p.warm} setWarm={p.setWarm} />
    </>
  );
}
