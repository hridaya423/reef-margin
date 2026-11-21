const W = 360;

type Mark = { x: number; label: string };

export function HeatCurve({ risk, deltas, margin, mark }: { risk: number[]; deltas: number[]; margin: number | null; mark?: Mark }) {
  const H = 190;
  const L = 34, R = 12, T = 18, B = 26;
  const xmax = deltas[deltas.length - 1];
  const x = (d: number) => L + (d / xmax) * (W - L - R);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const path = risk.map((p, k) => `${k ? "L" : "M"}${x(deltas[k]).toFixed(1)},${y(p).toFixed(1)}`).join("");
  const marginLabel = margin === null ? null : margin === 0 ? "already past 50%" : `margin +${margin.toFixed(1)} °C`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bleaching risk rises from ${Math.round(risk[0] * 100)}% with no added heat to ${Math.round(risk[risk.length - 1] * 100)}% with 3 °C added.`}>
      {[0, 0.25, 0.75, 1].map((p) => (
        <line key={p} className="grid" x1={L} x2={W - R} y1={y(p)} y2={y(p)} />
      ))}
      <line x1={L} x2={W - R} y1={y(0.5)} y2={y(0.5)} stroke="var(--ink-3)" strokeDasharray="4 4" />
      <text className="lbl" x={W - R} y={y(0.5) - 5} textAnchor="end">50% risk</text>
      {[0, 0.5, 1].map((p) => (
        <text key={p} x={L - 6} y={y(p) + 4} textAnchor="end">{Math.round(p * 100)}%</text>
      ))}
      {[0, 1, 2, 3].map((d) => (
        <text key={d} x={x(d)} y={H - 6} textAnchor={d === 0 ? "start" : d === 3 ? "end" : "middle"}>+{d} °C</text>
      ))}
      <line className="base" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
      {mark && (
        <g>
          <line x1={x(mark.x)} x2={x(mark.x)} y1={T} y2={y(0)} stroke="var(--ink-2)" strokeDasharray="2 3" />
          <text className="lbl" x={x(mark.x) + 4} y={T + 2}>{mark.label}</text>
        </g>
      )}
      <path d={path} fill="none" stroke="var(--risk-mid)" strokeWidth={2} strokeLinejoin="round" />
      {margin !== null && margin > 0 && (
        <g>
          <circle cx={x(margin)} cy={y(0.5)} r={4} fill="var(--risk-mid)" stroke="var(--surface)" strokeWidth={2} />
          <text className="lbl" x={x(margin) + 7} y={y(0.5) + 16}>{marginLabel}</text>
        </g>
      )}
    </svg>
  );
}

export function SstChart({ weekly, mmm, refDate }: { weekly: number[]; mmm: number; refDate: string }) {
  const H = 150;
  const L = 34, R = 12, T = 10, B = 22;
  const thr = mmm + 1;
  const lo = Math.floor(Math.min(...weekly, thr) - 0.5);
  const hi = Math.ceil(Math.max(...weekly, thr) + 0.3);
  const x = (k: number) => L + (k / (weekly.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = weekly.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const end = new Date(refDate);
  const years: { k: number; label: string }[] = [];
  for (let k = 0; k < weekly.length; k++) {
    const d = new Date(end.getTime() - (weekly.length - 1 - k) * 7 * 86400000);
    const prev = new Date(d.getTime() - 7 * 86400000);
    if (d.getUTCFullYear() !== prev.getUTCFullYear() && k > 4 && k < weekly.length - 4) years.push({ k, label: String(d.getUTCFullYear()) });
  }
  const step = Math.max(1, Math.round((hi - lo) / 3));
  const ticks: number[] = [];
  for (let v = lo; v <= hi; v += step) ticks.push(v);
  const clipId = `above-${refDate}`;
  const peak = Math.max(...weekly);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly sea temperature for the three years to ${refDate}. Peak ${peak.toFixed(1)} °C against a bleaching threshold of ${thr.toFixed(1)} °C.`}>
      <defs>
        <clipPath id={clipId}>
          <rect x={L} y={0} width={W - L - R} height={y(thr)} />
        </clipPath>
      </defs>
      {ticks.map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end">{v}°</text>
        </g>
      ))}
      {years.map((t) => (
        <text key={t.k} x={x(t.k)} y={H - 4} textAnchor="middle">{t.label}</text>
      ))}
      <path d={path} fill="none" stroke="var(--ink-2)" strokeWidth={1.5} strokeLinejoin="round" />
      <path d={path} fill="none" stroke="var(--risk-high)" strokeWidth={2.5} strokeLinejoin="round" clipPath={`url(#${clipId})`} />
      <line x1={L} x2={W - R} y1={y(thr)} y2={y(thr)} stroke="var(--risk-high)" strokeDasharray="4 4" strokeWidth={1} />
      <text className="lbl" x={L + 4} y={y(thr) - 5}>Bleaching threshold {thr.toFixed(1)} °C</text>
    </svg>
  );
}
