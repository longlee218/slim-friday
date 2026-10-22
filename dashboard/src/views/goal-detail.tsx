import { useState } from "react";
import type { Turn } from "../api";
import { useApi } from "../api";
import { dur, parseJson, usd, when } from "../format";
import { go, link } from "../router";
import { Load, Role, Status, Tabs } from "../ui";
import { eventText } from "./event-text";
import { toolName } from "./step-text";
import { type GoalSummary, goalTitle } from "./goals-list";
import { RunPanel } from "./run-panel";
import { Waterfall, type WaterfallEvent, type WaterfallItem } from "./waterfall";

interface Item extends WaterfallItem {
  subject: string | null;
  depends_on: string | null;
  attempt: number;
  dispatch_count: number;
  priority: number;
  location: string | null;
  result_kind: string | null;
  result_excerpt: string | null;
  last_progress_at: number;
}
interface Plan {
  id: string;
  version: number;
  status: string;
  strategy: string;
  budget_usd: number | null;
}
interface Effect {
  id: string;
  tool: string;
  scope: string;
  granted_by: string;
  result: string;
  created_at: number;
}
interface GoalDetailData {
  goal: GoalSummary;
  items: Item[];
  turns: Turn[];
  plans: Plan[];
  events: (WaterfallEvent & { payload: string })[];
  effects: Effect[];
}

/** One goal: where it is now (timeline), each item, every event in order, and the run picked from the timeline. */
export function GoalDetail({ id, run }: { id: string; run: string | null }) {
  const state = useApi<GoalDetailData>(`goals/${id}`);
  const [tab, setTab] = useState("timeline");
  const pick = (turnId: string | null) => go(link("goals", id, { run: turnId }));
  return (
    <Load state={state}>
      {({ goal, items, turns, plans, events, effects }) => {
        const keyOf = new Map(items.map((i) => [i.id, i.item_key ?? i.id.slice(0, 8)]));
        const costOf = (itemId: string) =>
          turns.filter((t) => t.owned_task_id === itemId).reduce((s, t) => s + (t.cost_usd ?? 0), 0);
        const plan = plans[plans.length - 1];
        const live = turns.filter((t) => !t.ended_at);
        const toolCalls = turns.reduce((s, t) => s + t.tool_calls, 0);
        const toolErrors = turns.reduce((s, t) => s + t.tool_errors, 0);
        return (
          <>
            <div className="page-title">
              <div className="title-meta">
                <Status value={goal.status} />
                <span className="faint">·</span>
                <span className="muted">{goal.workspace}</span>
                <span className="faint">·</span>
                <a className="muted link" href={link("threads", goal.thread_id)}>{goal.thread_title || "thread"}</a>
              </div>
              <h2>{goalTitle(goal)}</h2>
              {goal.scope !== goalTitle(goal) && <p className="clip scope">{goal.scope}</p>}
            </div>
            <dl className="facts-line">
              <div><dt>Items</dt><dd>{goal.done}/{goal.items}</dd></div>
              <div><dt>Cost</dt><dd>{usd(goal.worker_cost + goal.lead_cost)}</dd><small>lead {usd(goal.lead_cost)}</small></div>
              <div><dt>Runs</dt><dd>{turns.length}</dd></div>
              <div><dt>SDK turns</dt><dd>{turns.reduce((s, t) => s + (t.sdk_turns ?? 0), 0)}</dd></div>
              <div><dt>Tool calls</dt><dd>{toolCalls}</dd>{toolErrors > 0 && <small className="bad-text">{toolErrors} failed</small>}</div>
              <div><dt>Span</dt><dd>{dur((goal.status === "open" ? Date.now() : goal.end_at) - goal.created_at)}</dd></div>
              {plan && <div><dt>Plan</dt><dd>v{plan.version}</dd><small>{plan.status}{plan.budget_usd != null && ` · ${usd(plan.budget_usd)} budget`}</small></div>}
            </dl>

            {live.length > 0 && (
              <p className="now-line">
                <span className="status run"><i /></span>
                {live.map((t) => `${t.role}${t.item_key ? ` (${t.item_key})` : ""} is running ${t.last_tool ? toolName(t.last_tool) : "its first step"}`).join(" · ")}
              </p>
            )}

            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                ["timeline", "Timeline"],
                ["items", `Items ${items.length}`],
                ["events", `Events ${events.length}`],
                ...(effects.length ? ([["effects", `Effects ${effects.length}`]] as [string, string][]) : []),
              ]}
            />

            {tab === "timeline" && (
              <Waterfall turns={turns} items={items} events={events} selected={run} onPick={pick} open={goal.status === "open"} />
            )}

            {tab === "items" && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Depends on</th>
                      <th className="r">Dispatch</th>
                      <th className="r">Cost</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => {
                      const last = turns.filter((t) => t.owned_task_id === i.id).at(-1);
                      return (
                        <tr key={i.id} className={last ? "click" : undefined} onClick={() => last && pick(last.id)}>
                          <td>
                            <span className="mono">{i.item_key}</span>
                            <div className="sub clip">{i.subject}</div>
                          </td>
                          <td><Role role={i.owner_role} /></td>
                          <td><Status value={i.status} /></td>
                          <td className="mono muted">{(parseJson(i.depends_on) as string[] | null)?.join(", ") || "–"}</td>
                          <td className="r num">{i.dispatch_count}{i.attempt ? ` · a${i.attempt}` : ""}</td>
                          <td className="r num">{usd(costOf(i.id))}</td>
                          <td><div className="clip muted">{i.result_kind ? `${i.result_kind}: ${i.result_excerpt ?? ""}` : "–"}</div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "events" && (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {events.map((e) => (
                      <tr key={e.seq}>
                        <td className="num muted" style={{ width: 90 }}>{when(e.created_at)}</td>
                        <td style={{ width: 130 }}><span className={`ev ev-${e.kind}`}>{e.kind.replace("_", " ")}</span></td>
                        <td className="mono muted" style={{ width: 110 }}>{e.item_id ? keyOf.get(e.item_id) : ""}</td>
                        <td><div className="clip">{eventText(e.kind, e.payload)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === "effects" && (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {effects.map((f) => (
                      <tr key={f.id}>
                        <td className="num muted" style={{ width: 90 }}>{when(f.created_at)}</td>
                        <td className="mono">{f.tool}</td>
                        <td className="muted">{f.granted_by}</td>
                        <td><div className="clip">{f.scope}</div></td>
                        <td><div className="clip muted">{f.result}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {run && <RunPanel turnId={run} onClose={() => pick(null)} />}
          </>
        );
      }}
    </Load>
  );
}
