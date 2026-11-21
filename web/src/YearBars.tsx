import type { Survey } from "./api";

const W = 360;

type Props = { bars: { yr: number; v: number }[]; max?: number; line?: number | null; window?: [number, number]; surveys?: Survey[]; hitAt?: number; label: string; fmt?: (v: number) => string };

export function YearBars({ bars, max = 1, line = 0.5, window, surveys = [], hitAt = 30, label, fmt = (v) => `${Math.round(v * 100)}%` }: Props) {
  const H = surveys.length ? 160 : 140;
  const L = 34, R = 8, T = 10;
  const B = surveys.length ? 38 : 22;
  const n = bars.length;
  const bw = (W - L - R) / n;
  const x = (k: number) => L + k * bw;
  const y = (v: number) => T + (1 - Math.min(v, max) / max) * (H - T - B);
  const y0 = bars[0].yr;
  const axisY = H - B;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {window && <rect x={x(window[0] - y0)} y={T - 4} width={(window[1] - window[0] + 1) * bw} height={axisY - T + 4} fill="var(--well)" />}
      {[0, max / 2, max].map((v) => (
        <g key={v}>
          <line className="grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end">{fmt(v)}</text>
        </g>
      ))}
      {bars.map((b, k) => {
        const hot = line !== null && b.v >= line;
        return <rect key={b.yr} x={x(k) + 0.8} y={y(b.v)} width={Math.max(bw - 1.6, 1)} height={Math.max(axisY - y(b.v), 0.5)} rx={1} fill={hot ? "var(--risk-high)" : line === null ? "var(--risk-mid)" : "var(--ink-3)"} />;
      })}
      {line !== null && <line x1={L} x2={W - R} y1={y(line)} y2={y(line)} stroke="var(--ink-2)" strokeDasharray="4 4" />}
      {bars.filter((b) => b.yr % 5 === 0).map((b) => (
        <text key={b.yr} x={x(b.yr - y0) + bw / 2} y={axisY + 15} textAnchor="middle">{b.yr}</text>
      ))}
      {surveys.map(([yr, , pct], k) => {
        if (yr < y0 || yr > bars[n - 1].yr) return null;
        const hit = pct >= hitAt;
        return <circle key={k} cx={x(yr - y0) + bw / 2} cy={H - 7} r={3} fill={hit ? "var(--risk-high)" : "var(--surface)"} stroke={hit ? "var(--risk-high)" : "var(--ink-2)"} strokeWidth={1.2} />;
      })}
    </svg>
  );
}
