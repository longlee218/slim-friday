import type { Turn } from "../api";
import { useApi } from "../api";
import { dur, usd } from "../format";
import { link } from "../router";
import { Role, Section } from "../ui";
import { inputHint, toolName } from "./step-text";

interface LiveRun extends Turn {
  goal_id: string | null;
  goal_title: string | null;
  thread_title: string | null;
  last_input: string | null;
}

/** Runs in flight across every thread: who is working, on what, which step, for how long. Hidden when idle. */
export function LiveNow() {
  const { data } = useApi<LiveRun[]>("live");
  if (!data?.length) return null;
  return (
    <Section title="Running now" note={`${data.length} ${data.length === 1 ? "run" : "runs"}`}>
      <div className="live-list">
        {data.map((r) => (
          <a
            key={r.id}
            className="live-row"
            href={r.goal_id ? link("goals", r.goal_id, { run: r.id }) : link("threads", r.thread_id, { run: r.id })}
          >
            <span className="status run"><i /></span>
            <span className="live-who">
              <Role role={r.role} />
              {r.item_key && <span className="mono faint">{r.item_key}</span>}
            </span>
            <span className="live-what">
              <span className="one clip">{r.goal_title ?? r.thread_title ?? "thread"}</span>
              <span className="live-step mono">
                {r.last_tool ? `${toolName(r.last_tool)} · ${inputHint(r.last_input ?? "")}` : "starting"}
              </span>
            </span>
            <span className="live-meta num">
              {dur(Date.now() - r.started_at)}
              <span className="faint"> · {r.tool_calls} steps{r.tool_errors ? ` · ${r.tool_errors} failed` : ""}</span>
            </span>
            {r.cost_usd != null && <span className="num faint">{usd(r.cost_usd)}</span>}
          </a>
        ))}
      </div>
    </Section>
  );
}
