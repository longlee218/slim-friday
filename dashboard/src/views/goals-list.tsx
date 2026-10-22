import { useState } from "react";
import { useApi } from "../api";
import { ago, dur, usd } from "../format";
import { go, link } from "../router";
import { Icon, Load, Status } from "../ui";
import { LiveNow } from "./live-now";

/** A goal row as GET /api/goals returns it. */
export interface GoalSummary {
  id: string;
  thread_id: string;
  status: string;
  subject: string | null;
  scope: string;
  created_at: number;
  thread_title: string | null;
  workspace: string | null;
  items: number;
  done: number;
  held: number;
  running: number;
  worker_cost: number;
  lead_cost: number;
  end_at: number;
}

/** A goal's name: its subject, else the first line of what the owner asked. */
export function goalTitle(g: { subject: string | null; scope: string }): string {
  return g.subject ?? g.scope.split("\n")[0]!;
}

const FILTERS = ["all", "open", "completed", "failed", "cancelled"] as const;

/** Goals in the window: what runs now, then every goal with progress and cost; filter by status, search by text. */
export function GoalsList() {
  const state = useApi<GoalSummary[]>("goals", true);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [query, setQuery] = useState("");
  return (
    <>
      <LiveNow />
      <Load state={state} isEmpty={(d) => !d.length} empty="No goals in this window. Pick a wider window above.">
        {(goals) => {
          const open = goals.filter((g) => g.status === "open");
          const cost = goals.reduce((s, g) => s + g.worker_cost + g.lead_cost, 0);
          const held = open.reduce((s, g) => s + g.held, 0);
          const q = query.trim().toLowerCase();
          const rows = [...open, ...goals.filter((g) => g.status !== "open")].filter(
            (g) =>
              (filter === "all" || g.status === filter) &&
              (!q || `${g.subject ?? ""} ${g.scope} ${g.workspace ?? ""} ${g.thread_title ?? ""}`.toLowerCase().includes(q)),
          );
          const count = (f: string) => (f === "all" ? goals.length : goals.filter((g) => g.status === f).length);
          return (
            <div className="stack">
              <div className="toolbar">
                <div className="seg" role="group" aria-label="Status filter">
                  {FILTERS.map((f) => (
                    <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                      {f} <span className="faint num">{count(f)}</span>
                    </button>
                  ))}
                </div>
                <span className="muted toolbar-note">
                  {usd(cost)} spent
                  {held > 0 && <> · <span className="bad-text">{held} held in open goals</span></>}
                </span>
                <label className="search">
                  <Icon name="search" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search goals, workspaces, threads" />
                </label>
              </div>
              {!rows.length ? (
                <div className="empty">No goal matches this filter.</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 118 }}>Status</th>
                        <th>Goal</th>
                        <th>Progress</th>
                        <th className="r">Cost</th>
                        <th className="r">Span</th>
                        <th className="r">Started</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((g) => (
                        <tr key={g.id} className="click" onClick={() => go(link("goals", g.id))}>
                          <td><Status value={g.status} /></td>
                          <td>
                            <a href={link("goals", g.id)} className="clip goal-name">{goalTitle(g)}</a>
                            <div className="sub one clip">{g.workspace} · {g.thread_title || "untitled thread"}</div>
                          </td>
                          <td className="num">
                            {g.items ? <Progress done={g.done} total={g.items} /> : <span className="faint">no items</span>}
                            {(g.running > 0 || g.held > 0) && (
                              <div className="sub">
                                {g.running > 0 && `${g.running} running`}
                                {g.running > 0 && g.held > 0 && " · "}
                                {g.held > 0 && <span className="bad-text">{g.held} held</span>}
                              </div>
                            )}
                          </td>
                          <td className="r">
                            {usd(g.worker_cost + g.lead_cost)}
                            <div className="sub">lead {usd(g.lead_cost)}</div>
                          </td>
                          <td className="r muted">{dur((g.status === "open" ? Date.now() : g.end_at) - g.created_at)}</td>
                          <td className="r muted">{ago(g.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        }}
      </Load>
    </>
  );
}

/** "5/8" plus a thin bar. */
function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="prog">
      <b><i style={{ width: `${(done / total) * 100}%` }} /></b>
      {done}/{total}
    </span>
  );
}
