import { useState } from "react";
import type { Turn } from "../api";
import { useApi } from "../api";
import { Drawer } from "../drawer";
import { dur, pretty, tokens, usd, when } from "../format";
import { Load, Role, Status } from "../ui";
import { inputHint, toolName } from "./step-text";

interface Step {
  id: string;
  tool: string;
  input_json: string;
  output_preview: string;
  is_error: number;
  duration_ms: number;
  agent_id: string | null;
}
interface RunData {
  turn: Turn & { brief: string | null; session_id: string | null; kind: string };
  steps: Step[];
  item: { item_key: string | null; brief: string | null; result_kind: string | null; result_text: string | null } | null;
  approvals: { id: string; tool: string; summary: string; decision: string; requested_at: number; decided_at: number | null }[];
}

/** One run in a side sheet: four headline facts, tokens, brief and result, then every tool call in order. */
export function RunPanel({ turnId, onClose }: { turnId: string; onClose: () => void }) {
  const state = useApi<RunData>(`turns/${turnId}`);
  const [open, setOpen] = useState<string | null>(null);
  const t = state.data?.turn;

  return (
    <Drawer
      onClose={onClose}
      title={
        <div className="drawer-title">
          {t ? <Role role={t.role} /> : <strong>Run</strong>}
          {t?.item_key && <span className="mono muted">{t.item_key}</span>}
          {t && <Status value={t.ended_at ? (t.outcome ?? t.status) : "running"} />}
        </div>
      }
    >
      <Load state={state}>
        {({ turn, steps, item, approvals }) => {
          const maxMs = Math.max(1, ...steps.map((s) => s.duration_ms));
          const toolMs = steps.reduce((s, x) => s + x.duration_ms, 0);
          const wall = (turn.ended_at ?? Date.now()) - turn.started_at;
          const failed = steps.filter((s) => s.is_error).length;
          return (
            <div className="run">
              <div className="facts">
                <div><span>Duration</span><strong>{dur(wall)}</strong><small>{when(turn.started_at)}{turn.ended_at ? "" : " · running"}</small></div>
                <div><span>Cost</span><strong>{usd(turn.cost_usd)}</strong><small>{turn.ended_at ? turn.model : "known at the end"}</small></div>
                <div><span>SDK turns</span><strong>{turn.sdk_turns ?? "–"}</strong><small>{turn.compactions ? `${turn.compactions} compactions` : "no compaction"}</small></div>
                <div><span>Tool calls</span><strong>{steps.length}</strong><small className={failed ? "bad-text" : undefined}>{failed ? `${failed} failed` : "none failed"}</small></div>
              </div>
              <p className="run-line muted">
                Tokens: in {tokens(turn.input_tokens)} · out {tokens(turn.output_tokens)} · cache read {tokens(turn.cache_read_tokens)} · cache write {tokens(turn.cache_creation_tokens)}
                <br />
                Tools took {dur(toolMs)} of {dur(wall)} ({Math.round((toolMs / Math.max(wall, 1)) * 100)}%)
              </p>
              {(turn.brief || item?.brief) && (
                <details className="fold">
                  <summary>Brief</summary>
                  <pre>{turn.brief ?? item?.brief}</pre>
                </details>
              )}
              {item?.result_text && (
                <details className="fold">
                  <summary>Result <span className="faint">{item.result_kind}</span></summary>
                  <pre>{item.result_text}</pre>
                </details>
              )}
              {approvals.map((a) => (
                <p key={a.id} className="run-line">
                  Owner approval for {a.tool}: <strong>{a.decision}</strong> after {dur((a.decided_at ?? Date.now()) - a.requested_at)}
                  <span className="muted"> · {a.summary}</span>
                </p>
              ))}
              <h3 className="drawer-h">Steps</h3>
              {!steps.length && <div className="empty">No tool calls recorded for this run.</div>}
              <ol className="steps">
                {steps.map((s, i) => (
                  <li key={s.id} className={s.is_error ? "err" : undefined}>
                    <button type="button" className="step" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                      <span className="num faint">{i + 1}</span>
                      <span className="step-main">
                        <span className="step-tool">
                          {toolName(s.tool)}
                          {s.agent_id && <span className="tag">subagent</span>}
                          {s.is_error ? <span className="tag bad">error</span> : null}
                        </span>
                        <span className="step-hint mono">{inputHint(s.input_json)}</span>
                      </span>
                      <span className="step-dur">
                        <span className="num">{dur(s.duration_ms)}</span>
                        <i style={{ width: `${(s.duration_ms / maxMs) * 100}%` }} />
                      </span>
                    </button>
                    {open === s.id && (
                      <div className="step-io">
                        <div className="faint">Input</div>
                        <pre>{pretty(s.input_json)}</pre>
                        <div className="faint">Output (preview)</div>
                        <pre>{s.output_preview || "–"}</pre>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          );
        }}
      </Load>
    </Drawer>
  );
}
