import type { CSSProperties } from "react";
import type { Turn } from "../api";
import { dur, parseJson, usd, when } from "../format";
import { TipBody, useTooltip } from "../tooltip";
import { roleColor } from "../ui";
import { buildScale } from "./waterfall-scale";

export interface WaterfallItem {
  id: string;
  item_key: string | null;
  owner_role: string;
  status: string;
  depends_on?: string | null;
}
export interface WaterfallEvent {
  seq: number;
  kind: string;
  item_id: string | null;
  created_at: number;
}

/** Only events that change the reading get a mark: the owner speaking, and trouble. Starts and results are bar edges. */
const OWNER = "owner_message";
const BAD = new Set(["blocked", "failure", "timeout"]);

/**
 * Goal timeline: one lane for the teammate, one per item, bars from run start to end on a time axis whose idle gaps are
 * folded into narrow bands. Vertical hairlines at the ticks run through every lane; an open goal shows a "now" line.
 * A lane with no run yet says what it waits for. Click a bar for its steps.
 */
export function Waterfall({
  turns,
  items,
  events,
  selected,
  onPick,
  open,
}: {
  turns: Turn[];
  items: WaterfallItem[];
  events: WaterfallEvent[];
  selected: string | null;
  onPick: (turnId: string) => void;
  open: boolean;
}) {
  const tip = useTooltip();
  const now = Date.now();
  const end = (t: Turn) => t.ended_at ?? now;
  const marks = events.filter((e) => e.kind === OWNER || BAD.has(e.kind));
  const scale = buildScale(
    [...turns.map((t): [number, number] => [t.started_at, end(t)]), ...(open ? [[now, now] as [number, number]] : [])],
    marks.map((e) => e.created_at),
  );
  const keyOf = new Map(items.map((i) => [i.id, i.item_key ?? i.id.slice(0, 8)]));
  const lanes = [
    { id: "teammate", label: "teammate", role: "chief-of-staff", status: "", waits: "" },
    ...items.map((i) => ({
      id: i.id,
      label: i.item_key ?? i.id.slice(0, 8),
      role: i.owner_role,
      status: i.status,
      waits: ((parseJson(i.depends_on) as string[] | null) ?? []).join(", "),
    })),
  ];
  const laneOf = (t: Turn) => (t.role === "chief-of-staff" ? "teammate" : (t.owned_task_id ?? "teammate"));
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const grid = (
    <>
      {scale.ticks.map((t) => <span key={t.t} className="wf-grid" style={{ left: pct(t.x) }} />)}
      {scale.breaks.map((b) => <span key={b.x} className="wf-fold" style={{ left: pct(b.x0), width: pct(b.x1 - b.x0) }} />)}
      {open && <span className="wf-now" style={{ left: pct(scale.x(now)) }} />}
    </>
  );

  return (
    <div className="wf" role="figure" aria-label="Run timeline">
      <div className="wf-row wf-axis">
        <span className="wf-label faint">Lane</span>
        <div className="wf-track">
          {scale.ticks.map((t) => (
            <span key={t.t} className="wf-tick" style={{ left: pct(t.x) }}>{when(t.t)}</span>
          ))}
          {scale.breaks.map((b) => (
            <span key={b.x} className="wf-fold-label" style={{ left: pct((b.x0 + b.x1) / 2) }} title={`idle ${dur(b.ms)}`}>
              {dur(b.ms).split(" ")[0]}
            </span>
          ))}
        </div>
      </div>
      {lanes.map((lane) => {
        const runs = turns.filter((t) => laneOf(t) === lane.id);
        return (
          <div className="wf-row wf-lane" key={lane.id}>
            <div className="wf-label">
              <i style={{ background: roleColor(lane.role) }} />
              <span className="mono">{lane.label}</span>
              {lane.status && lane.status !== "completed" && <span className={`wf-st ${lane.status}`}>{lane.status}</span>}
            </div>
            <div className="wf-track">
              {grid}
              {!runs.length && (
                <span className="wf-wait">{lane.waits ? `waits for ${lane.waits.split(", ").map((k) => keyOf.get(k) ?? k).join(", ")}` : "not started"}</span>
              )}
              {runs.map((t) => {
                const x0 = scale.x(t.started_at);
                const x1 = scale.x(end(t));
                const style = { left: pct(x0), width: `max(6px, ${pct(x1 - x0)})`, "--rc": roleColor(t.role) } as CSSProperties;
                return (
                  <button
                    type="button"
                    key={t.id}
                    className={`wf-bar${t.ended_at ? "" : " live"}${t.outcome && t.outcome !== "success" ? " bad" : ""}`}
                    aria-pressed={selected === t.id}
                    aria-label={`${t.role} run at ${when(t.started_at)}`}
                    style={style}
                    onClick={() => onPick(t.id)}
                    {...tip.bind(
                      <TipBody
                        title={<>{t.role}{t.item_key ? ` · ${t.item_key}` : ""} <span className="faint">{when(t.started_at)}</span></>}
                        rows={[
                          { value: dur(end(t) - t.started_at), label: t.ended_at ? "duration" : "so far" },
                          { value: usd(t.cost_usd), label: "cost" },
                          { value: t.sdk_turns ?? "–", label: "SDK turns" },
                          { value: t.tool_calls, label: t.tool_errors ? `tool calls, ${t.tool_errors} failed` : "tool calls" },
                        ]}
                        foot={t.ended_at ? (t.outcome ?? t.status) : `now: ${t.last_tool ?? "starting"}`}
                      />,
                    )}
                  />
                );
              })}
              {marks
                .filter((e) => (e.kind === OWNER ? "teammate" : (e.item_id ?? "teammate")) === lane.id)
                .map((e) => (
                  <span
                    key={e.seq}
                    className={`wf-mark${e.kind === OWNER ? " owner" : " bad"}`}
                    style={{ left: pct(scale.x(e.created_at)) }}
                    {...tip.bind(<TipBody title={e.kind === OWNER ? "Owner message" : e.kind} rows={[]} foot={when(e.created_at)} />)}
                  />
                ))}
            </div>
          </div>
        );
      })}
      <div className="wf-legend">
        <span><i className="k-owner" /> owner message</span>
        <span><i className="k-bad" /> blocked or failed</span>
        <span><i className="k-fold" /> idle time, folded</span>
        {open && <span><i className="k-now" /> now</span>}
      </div>
      {tip.node}
    </div>
  );
}
