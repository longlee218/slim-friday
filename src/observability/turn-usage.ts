/** Fields of one `llm.turn` log line (numbers and ids only, never content). */
export type TurnRecord = {
  /** 1-based count of distinct model calls seen so far in this stream. */
  turn: number;
  /** Context size of the call: input + cache read + cache creation tokens. */
  in: number;
  cacheRead: number;
  cacheCreate: number;
  /** Output tokens of the first message of the call: a partial snapshot, the exact total is on `run.finished`. */
  outApprox: number;
  /** Sum of the context sizes of all turns so far (main + subagents); a growth gauge, not billing. */
  ctxTotal: number;
  /** Model that answered (from `message.model`), when the SDK gave it. */
  model?: string;
  /** True when the turn belongs to a subagent (the message has a `parent_tool_use_id`). */
  sub?: true;
  /** Subagent id, present only on subagent turns (the main agent has none). */
  agentId?: string;
};

/** Subset of an assistant message we read. */
interface AssistantShape {
  type?: string;
  parent_tool_use_id?: string | null;
  agent_id?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Per-stream tracker behind the `llm.turn` lines. One model call can arrive as several assistant messages
 * (parallel tool_use blocks) that share a `message.id` and the same usage: only the first of an id counts.
 * Pure: no logging here, the caller logs the returned record.
 */
export function createTurnUsage(): { onMessage(msg: unknown): TurnRecord | undefined } {
  const seen = new Set<string>();
  let turn = 0;
  let ctxTotal = 0;
  return {
    onMessage(msg) {
      const m = (msg ?? {}) as AssistantShape;
      const id = m.message?.id;
      const u = m.message?.usage;
      // Not an assistant message, no usage, or an id already seen: nothing to report.
      // No id at all: cannot dedupe, so every such message counts as its own turn.
      if (m.type !== "assistant" || !u || (id && seen.has(id))) return undefined;
      if (id) seen.add(id);
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const cacheCreate = u.cache_creation_input_tokens ?? 0;
      const ctx = (u.input_tokens ?? 0) + cacheRead + cacheCreate;
      ctxTotal += ctx;
      return {
        turn: ++turn,
        in: ctx,
        cacheRead,
        cacheCreate,
        outApprox: u.output_tokens ?? 0,
        ctxTotal,
        ...(m.message?.model && { model: m.message.model }),
        ...(m.parent_tool_use_id && { sub: true as const }),
        ...(m.agent_id && { agentId: m.agent_id }),
      };
    },
  };
}
