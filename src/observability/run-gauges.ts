import type { TurnRecord } from "./turn-usage";

/** What a run's gauges say once the stream is over (merged into `RunUsage` by the caller). */
export interface GaugeSnapshot {
  peakContextTokens: number;
  lastContextTokens: number;
  /** Failed tool results of the MAIN agent that were not our guard's denials. */
  toolErrors: number;
  /** Tool calls our guard/owner denied (hook deny, canUseTool deny), counted once per tool_use_id. */
  toolDenied: number;
  /** Model of the last main-agent model call (key candidate for the `modelUsage` window lookup). */
  mainModel?: string;
}

/**
 * Per-stream tracker of the context gauges and tool failures. Pure (no logging). Context gauges follow the MAIN agent
 * only: a subagent has its own window. Tool errors: a subagent's messages carry `parent_tool_use_id`, so only top-level
 * tool results count (the subagent's failure still shows once, as the main agent's `Task` result when it failed).
 * Message text and tool output are never read, only ids and flags.
 * @param denied tool_use_ids our permission layer denied (filled while the run streams; read lazily here)
 */
export function createRunGauges(denied: ReadonlySet<string>) {
  let peak = 0;
  let last = 0;
  let mainModel: string | undefined;
  let toolErrors = 0;
  const deniedSeen = new Set<string>();
  return {
    /** A model call seen on the stream (record from `createTurnUsage`). */
    onTurn(t: TurnRecord): void {
      if (t.sub) return;
      peak = Math.max(peak, t.in);
      last = t.in;
      mainModel = t.model ?? mainModel;
    },
    /** `compact_boundary`: the context just shrank to `post_tokens`; 0/absent = unknown, keep the earlier value. */
    onBoundary(postTokens: number | undefined): void {
      if (postTokens && postTokens > 0) last = postTokens;
    },
    /** A user message: count its `tool_result` blocks flagged `is_error`. */
    onUser(msg: unknown): void {
      const m = msg as { parent_tool_use_id?: string | null; message?: { content?: unknown } };
      const content = m.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b?.type !== "tool_result" || b.is_error !== true) continue;
        if (typeof b.tool_use_id === "string" && denied.has(b.tool_use_id)) {
          deniedSeen.add(b.tool_use_id);
        } else if (!m.parent_tool_use_id) {
          toolErrors++;
        }
      }
    },
    snapshot(): GaugeSnapshot {
      return {
        peakContextTokens: peak,
        lastContextTokens: last,
        toolErrors,
        toolDenied: deniedSeen.size,
        mainModel,
      };
    },
  };
}
