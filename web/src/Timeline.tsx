import type { Survey } from "./api";
import { monthLabel } from "./time";

const W = 360;

type Props = {
  series: Float32Array;
  dates: string[];
  t: number;
  onSeek: (t: number) => void;
  label: string;
  surveys?: Survey[];
  max?: number;
  line?: number | null;
  hitAt?: number;
};

export function RiskTimeline({ series, dates, t, onSeek, label, surveys = [], max = 1, line = 0.5, hitAt = 10 }: Props) {
  const H = surveys.length ? 170 : 150;
  const L = 34, R = 10, T = 14;
  const B = surveys.length ? 40 : 22;
  const n = series.length;
  const x = (k: number) => L + (k / Math.max(n - 1, 1)) * (W - L - R);
  const y = (p: number) => T + (1 - Math.min(p, max) / max) * (H - T - B);
  let path = "";
  for (let k = 0; k < n; k++) path += `${k ? "L" : "M"}${x(k).toFixed(1)},${y(series[k]).toFixed(1)}`;
  const y0 = Number(dates[0].slice(0, 4));
  const m0 = Number(dates[0].slice(5, 7));
  const kOf = (yr: number, mo: number) => (yr - y0) * 12 + (mo - m0);
  const years: number[] = [];
  for (let yr = Math.ceil(y0 / 5) * 5; yr <= Number(dates[n - 1].slice(0, 4)); yr += 5) years.push(yr);
  const ticks = [0, max / 2, max];
  const axisY = H - B;
  function seek(e: React.PointerEvent<SVGSVGElement>) {
    if (e.type === "pointermove" && e.buttons !== 1) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    onSeek(Math.max(0, Math.min(n - 1, Math.round(((px - L) / (W - L - R)) * (n - 1)))));
  }
  return (
    <svg className="chart seekable" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerDown={seek} onPointerMove={seek}>
      {line !== null && (
        <defs>
          <clipPath id="tl-over">
            <rect x={0} y={0} width={W} height={y(line)} />
          </clipPath>
        </defs>
      )}
      {ticks.map((p) => (
        <g key={p}>
          <line className="grid" x1={L} x2={W - R} y1={y(p)} y2={y(p)} />
          <text x={L - 6} y={y(p) + 4} textAnchor="end">{Math.round(p * 100)}%</text>
        </g>
      ))}
      {line !== null && <line x1={L} x2={W - R} y1={y(line)} y2={y(line)} stroke="var(--ink-3)" strokeDasharray="4 4" />}
      {years.map((yr) => (
        <text key={yr} x={x(kOf(yr, 1))} y={axisY + 16} textAnchor="middle">{yr}</text>
      ))}
      <path d={path} fill="none" stroke={line === null ? "var(--risk-mid)" : "var(--ink-3)"} strokeWidth={1.2} strokeLinejoin="round" />
      {line !== null && <path d={path} fill="none" stroke="var(--risk-high)" strokeWidth={1.6} strokeLinejoin="round" clipPath="url(#tl-over)" />}
      {surveys.map(([yr, mo, pct], k) => {
        const kk = kOf(yr, mo);
        if (kk < 0 || kk >= n) return null;
        const hit = pct >= hitAt;
        return <circle key={k} cx={x(kk)} cy={H - 8} r={3} fill={hit ? "var(--risk-high)" : "var(--surface)"} stroke={hit ? "var(--risk-high)" : "var(--ink-2)"} strokeWidth={1.2} />;
      })}
      <line x1={x(t)} x2={x(t)} y1={T - 4} y2={axisY} stroke="var(--ink)" strokeWidth={1} />
      <circle cx={x(t)} cy={y(series[t])} r={3.5} fill="var(--ink)" />
      <text className="lbl" x={x(t) > W - 80 ? x(t) - 5 : x(t) + 5} y={T - 2} textAnchor={x(t) > W - 80 ? "end" : "start"}>{monthLabel(dates[t])}</text>
    </svg>
  );
}
