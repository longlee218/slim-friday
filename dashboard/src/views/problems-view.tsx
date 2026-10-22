import { useState } from "react";
import { useApi } from "../api";
import { ago } from "../format";
import { go, link } from "../router";
import { Load } from "../ui";
import { eventText } from "./event-text";

export interface Problem {
  kind: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  at: number;
  goal_id: string | null;
  turn_id: string | null;
  thread_id: string | null;
}

/** Where a finding opens: its run inside its goal, else its goal, else its thread. */
function target(p: Problem): string | null {
  if (p.goal_id) return link("goals", p.goal_id, { run: p.turn_id });
  if (p.thread_id) return link("threads", p.thread_id, { run: p.turn_id });
  return null;
}

/** Detector findings (held, stale, failed runs, tool errors, loops, retries, costly runs), filterable by kind. */
export function ProblemsView() {
  const state = useApi<Problem[]>("problems", true);
  const [kind, setKind] = useState<string | null>(null);
  return (
    <Load state={state} isEmpty={(d) => !d.length} empty="No problems detected in this window.">
      {(all) => {
        const kinds = [...new Set(all.map((p) => p.kind))];
        const rows = kind ? all.filter((p) => p.kind === kind) : all;
        return (
          <>
            <div className="chips">
              <button type="button" className="chip" aria-pressed={!kind} onClick={() => setKind(null)}>
                all <span className="num faint">{all.length}</span>
              </button>
              {kinds.map((k) => (
                <button key={k} type="button" className="chip" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k} <span className="num faint">{all.filter((p) => p.kind === k).length}</span>
                </button>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <tbody>
                  {rows.map((p, i) => {
                    const href = target(p);
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: findings have no id
                      <tr key={i} className={href ? "click" : undefined} onClick={() => href && go(href)}>
                        <td style={{ width: 80 }}><span className={`sev ${p.severity}`}>{p.severity}</span></td>
                        <td style={{ width: 110 }} className="mono muted">{p.kind}</td>
                        <td>
                          {p.title}
                          {p.detail && (
                            <div className="sub clip">
                              {p.detail.startsWith("{") ? eventText(p.kind, p.detail) : p.detail}
                            </div>
                          )}
                        </td>
                        <td className="r num muted" style={{ width: 90 }}>{ago(p.at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        );
      }}
    </Load>
  );
}
