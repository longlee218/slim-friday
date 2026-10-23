import type { Turn } from "../api";
import { useApi } from "../api";
import { ago, dur, usd, when } from "../format";
import { go, link } from "../router";
import { Load, Role, Section, Status } from "../ui";
import { eventText } from "./event-text";
import { RunPanel } from "./run-panel";

interface ThreadRow {
  thread_id: string;
  title: string | null;
  workspace: string;
  runs: number;
  cost_usd: number;
  goals: number;
  running: number;
  last_at: number;
}

/** Threads with activity in the window, newest first. */
export function ThreadsList() {
  const state = useApi<ThreadRow[]>("threads", true);
  return (
    <Load state={state} isEmpty={(d) => !d.length} empty="No thread activity in this window.">
      {(rows) => (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Thread</th>
                <th className="r">Goals</th>
                <th className="r">Runs</th>
                <th className="r">Cost</th>
                <th className="r">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.thread_id} className="click" onClick={() => go(link("threads", t.thread_id))}>
                  <td>
                    <a href={link("threads", t.thread_id)}>{t.title || "untitled thread"}</a>
                    {t.running > 0 && <span className="status run" style={{ marginLeft: 8 }}><i />{t.running} running</span>}
                    <div className="sub">{t.workspace}</div>
                  </td>
                  <td className="r num">{t.goals}</td>
                  <td className="r num">{t.runs}</td>
                  <td className="r num">{usd(t.cost_usd)}</td>
                  <td className="r num muted">{ago(t.last_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Load>
  );
}

interface Replay {
  thread: { thread_id: string; title: string | null; workspace: string };
  goals: { id: string; status: string; subject: string | null; scope: string }[];
  stream: (
    | { type: "event"; at: number; event: { seq: number; kind: string; item_id: string | null; payload: string; redelivered: number } }
    | { type: "run"; at: number; run: Turn }
  )[];
}

/** A thread replayed top to bottom: owner messages, teammate runs, dispatches, worker runs, reports, in time order. */
export function ThreadReplay({ id, run }: { id: string; run: string | null }) {
  const state = useApi<Replay>(`threads/${id}`);
  const pick = (turnId: string | null) => go(link("threads", id, { run: turnId }));
  return (
    <Load state={state}>
      {({ thread, goals, stream }) => (
        <>
          <Section title={thread.title || "untitled thread"} note={thread.workspace}>
            {goals.length > 0 && (
              <div className="chips">
                {goals.map((g) => (
                  <a key={g.id} className="chip" href={link("goals", g.id)}>
                    <Status value={g.status} />
                    <span className="clip">{g.subject ?? g.scope}</span>
                  </a>
                ))}
              </div>
            )}
          </Section>
          <ol className="replay">
            {stream.map((s) =>
              s.type === "run" ? (
                <li key={`r${s.run.id}`} className="rp-run">
                  <button type="button" aria-pressed={run === s.run.id} onClick={() => pick(s.run.id)}>
                    <span className="num faint">{when(s.at)}</span>
                    <Role role={s.run.role} />
                    <span className="mono muted">{s.run.item_key ?? ""}</span>
                    <span className="rp-meta num">
                      {dur((s.run.ended_at ?? Date.now()) - s.run.started_at)} · {usd(s.run.cost_usd)} · {s.run.sdk_turns ?? "–"} turns · {s.run.tool_calls} tools
                      {s.run.tool_errors > 0 && <span style={{ color: "var(--danger)" }}> · {s.run.tool_errors} failed</span>}
                    </span>
                    {!s.run.ended_at && <Status value="running" />}
                    {s.run.outcome && s.run.outcome !== "success" && <Status value={s.run.outcome} />}
                  </button>
                </li>
              ) : (
                <li key={`e${s.event.seq}`} className={`rp-ev rp-${s.event.kind}`}>
                  <span className="num faint">{when(s.at)}</span>
                  <span className={`ev ev-${s.event.kind}`}>{s.event.kind}</span>
                  <span className="rp-text">
                    {eventText(s.event.kind, s.event.payload)}
                    {s.event.redelivered > 0 && <span className="tag bad">redelivered {s.event.redelivered}x</span>}
                  </span>
                </li>
              ),
            )}
          </ol>
          {run && <RunPanel turnId={run} onClose={() => pick(null)} />}
        </>
      )}
    </Load>
  );
}
