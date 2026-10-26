import { useDirectory } from "../../api/directory";
import { formatCost } from "../../lib/format";
import type { SpendDay } from "./activity-math";

/** Bot colours (prototype SPEND_COL order); bots past the fourth fold into "Others". */
const PALETTE = ["var(--tint)", "#30b0c7", "#ff9f0a", "#34c759"];
const OTHER = "var(--fill-strong)";

/** `2026-10-24` -> `24 Oct`, or the day number alone when 30 columns must fit. */
const label = (day: string, short: boolean): string =>
  short
    ? String(Number(day.slice(8)))
    : `${Number(day.slice(8))} ${new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" })}`;

/**
 * Stacked daily bars per bot with the period total, today's spend and a legend; with no spend in
 * the period, one quiet row instead. `bare` drops
 * the panel frame (the phone puts the chart in an inset). Bars grow from the baseline with a
 * 40 ms stagger; Reduce Motion cuts the animation and the stagger (base.css, activity.css).
 */
export function SpendChart({ days, bare }: { days: SpendDay[]; bare?: boolean }) {
  const dir = useDirectory();
  const totals = new Map<string, number>();
  for (const d of days)
    for (const [b, v] of Object.entries(d.byBot)) totals.set(b, (totals.get(b) ?? 0) + v);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const colour = new Map(ranked.map((id, i) => [id, PALETTE[i] ?? OTHER]));
  const sum = days.reduce((a, d) => a + d.total, 0);
  const max = Math.max(...days.map((d) => d.total));
  const cols = {
    gridTemplateColumns: `repeat(${days.length}, 1fr)`,
    gap: days.length > 7 ? 4 : 16,
  };
  const today = days.at(-1)?.total ?? 0;
  // Nothing spent: one quiet row instead of an empty chart.
  if (sum === 0)
    return (
      <div className={bare ? "chart-none" : "panel chart-none"}>
        No spend in the last {days.length} days · <span className="num">{formatCost(0)}</span>
      </div>
    );
  return (
    <div className={bare ? "chart" : "panel chart"}>
      <div className="chart-total">
        <b className="num">{formatCost(sum)}</b>
        <span>
          {days.length} days · today {formatCost(today)}
        </span>
      </div>
      <>
        <div className="bars" style={cols}>
          {days.map((d, i) => (
            <div
              key={d.day}
              className="bar"
              title={`${label(d.day, false)}: ${formatCost(d.total)}`}
              style={{ height: `${(d.total / max) * 100}%`, animationDelay: `${i * 40}ms` }}
            >
              {Object.entries(d.byBot).map(([b, v]) => (
                <i key={b} style={{ flex: v, background: colour.get(b) }} />
              ))}
            </div>
          ))}
        </div>
        <div className="bar-l" style={cols}>
          {days.map((d, i) => (
            <span key={d.day}>
              {days.length > 7 && i % 5 !== 4 ? "" : label(d.day, days.length > 7)}
            </span>
          ))}
        </div>
        <div className="legend">
          {ranked.slice(0, PALETTE.length).map((id) => (
            <span key={id}>
              <i style={{ background: colour.get(id) }} />
              {dir.botName(id)}
            </span>
          ))}
          {ranked.length > PALETTE.length && (
            <span>
              <i style={{ background: OTHER }} />
              Others
            </span>
          )}
        </div>
      </>
    </div>
  );
}
