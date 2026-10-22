import { useEffect, useRef, useState } from "react";
import { usd } from "../format";
import { TipBody, useTooltip } from "../tooltip";
import { NAMED_ROLES, roleColor, roleKey } from "../ui";

export interface DayRow {
  day: string;
  role: string;
  cost_usd: number;
  runs: number;
}

const H = 248;
const PAD = { top: 16, right: 8, bottom: 30, left: 52 };
const BAR_MAX = 24;
const GAP = 2;
const MIN_SEG = 4;
const STACK = [...NAMED_ROLES, "other"];

/** Width of an element, kept current by a ResizeObserver. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** A 1-2-5 step that gives about four gridlines up to `max`. */
function niceStep(max: number): number {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  return ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw);
}

/** "Mon 21" style label from an ISO day. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Stacked columns of cost per local day, one segment per role (fixed order, bottom up). Hairline grid, columns capped
 * at 24px with a rounded top, 2px surface gaps between segments; hovering a day lists every role for it.
 */
export function CostDayChart({ rows }: { rows: DayRow[] }) {
  const [ref, width] = useWidth();
  const tip = useTooltip();
  const [hover, setHover] = useState<string | null>(null);

  const days = [...new Set(rows.map((r) => r.day))].sort();
  const byDay = new Map(
    days.map((d) => {
      const per = new Map<string, { cost: number; runs: number }>();
      for (const r of rows.filter((x) => x.day === d)) {
        const k = roleKey(r.role);
        const cur = per.get(k) ?? { cost: 0, runs: 0 };
        per.set(k, { cost: cur.cost + r.cost_usd, runs: cur.runs + r.runs });
      }
      return [d, per];
    }),
  );
  const total = (d: string) => [...byDay.get(d)!.values()].reduce((s, v) => s + v.cost, 0);
  const present = STACK.filter((k) => days.some((d) => byDay.get(d)!.has(k)));
  const step = niceStep(Math.max(0.01, ...days.map(total)));
  const top = Math.ceil(Math.max(0.01, ...days.map(total)) / step) * step;

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const band = days.length ? plotW / days.length : 0;
  const barW = Math.max(4, Math.min(BAR_MAX, band * 0.56));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(42 / Math.max(band, 1)));
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  return (
    <div className="chart panel">
      <div ref={ref} className="chart-plot">
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label="Cost per day by role">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
                <text x={PAD.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                  {t === 0 ? "$0" : usd(t).replace(/\.00$/, "")}
                </text>
              </g>
            ))}
            {days.map((d, i) => {
              const cx = PAD.left + band * i + band / 2;
              const per = byDay.get(d)!;
              // Drawing only: segments thinner than MIN_SEG px fold into "other", so a stack never ends in hairlines.
              // The day's largest role always keeps its color, even on a short column.
              const draw = new Map<string, number>();
              const own = present.filter((x) => per.has(x));
              const dominant = own.reduce((a, b) => (per.get(b)!.cost > per.get(a)!.cost ? b : a), own[0]!);
              for (const k of own) {
                const v = per.get(k)!.cost;
                const key = (v / top) * plotH < MIN_SEG && k !== dominant ? "other" : k;
                draw.set(key, (draw.get(key) ?? 0) + v);
              }
              const stack = present.filter((k) => draw.has(k));
              let acc = 0;
              return (
                <g
                  key={d}
                  // biome-ignore lint/a11y/noNoninteractiveTabindex: focus shows the same readout as hover
                  tabIndex={0}
                  className="col"
                  onPointerEnter={() => setHover(d)}
                  {...tip.bind(
                    <TipBody
                      title={`${dayLabel(d)} · ${usd(total(d))}`}
                      rows={present
                        .filter((k) => per.has(k))
                        .map((k) => ({ k, v: per.get(k)! }))
                        .sort((a, b) => b.v.cost - a.v.cost)
                        .map(({ k, v }) => ({ color: roleColor(k), value: usd(v.cost), label: `${k} · ${v.runs} ${v.runs === 1 ? "run" : "runs"}` }))}
                    />,
                  )}
                  onPointerLeave={() => {
                    setHover(null);
                    tip.hide();
                  }}
                >
                  <rect x={cx - band / 2} y={PAD.top} width={band} height={plotH} className="hit" />
                  {hover === d && (
                    <rect x={cx - barW / 2 - 8} y={PAD.top} width={barW + 16} height={plotH} rx={6} className="hit on" />
                  )}
                  {stack.map((k, si) => {
                    const v = draw.get(k)!;
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    const h = Math.max(0, y0 - y1 - (si > 0 ? GAP : 0));
                    if (h <= 0.5) return null;
                    const x = cx - barW / 2;
                    const isTop = si === stack.length - 1;
                    const r = isTop ? Math.min(4, h, barW / 2) : 0;
                    // Square at the baseline, rounded only at the data end of the stack.
                    const d0 = `M${x},${y0 - (si > 0 ? GAP : 0)}V${y1 + r}${r ? `q0,-${r} ${r},-${r}` : ""}H${x + barW - r}${r ? `q${r},0 ${r},${r}` : ""}V${y0 - (si > 0 ? GAP : 0)}Z`;
                    return <path key={k} d={d0} fill={roleColor(k)} />;
                  })}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={H - 10} textAnchor="middle" className="tick">
                      {dayLabel(d)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div className="legend">
        {present.map((k) => (
          <span key={k} className="legend-item">
            <i style={{ background: roleColor(k) }} />
            {k}
          </span>
        ))}
      </div>
      {tip.node}
    </div>
  );
}
