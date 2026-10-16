import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RecentMessage } from "../ingress/intent-types";
import { MEMORY_MCP_SERVER, mcpToolName } from "../mcp/mcp-tool-names";
import { MEMORY_SAVE_TOOL } from "../mcp/memory/tools/MemorySaveTool/constants";
import { type ChatText, extractContext } from "../memory/extract-context";
import { buildMemoryToolContext } from "../memory/memory-context";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { FLUSH_PROMPT } from "../roles/prompts/rollover-prompts";
import { journalExtract } from "../runtime/compact-hooks";
import type { SessionRow } from "../storage/session-store";
import { type RolloverDeps, type RolloverRequest, runLean } from "./rollover-run";

/* Memory flush before the thread's session is dropped: an LLM run that saves durable memories with `MemorySave`,
   or, when it fails / saves nothing, the no-LLM extract of the phase 8 journal block. */

/** The flush reply that means "nothing worth storing". */
const FLUSH_NO_REPLY = "NO_REPLY";
/** Caps of the flush run (the budget is a FLOOR: it grows with the context, see `leanBudgetUsd`). */
const FLUSH_MAX_TURNS = 4;
const FLUSH_TIMEOUT_MS = 60_000;
const FLUSH_BUDGET_USD = 0.2;
/** Messages of the thread the extract fallback reads (with the previous summary). */
const EXTRACT_HISTORY_MESSAGES = 10;

const log = logger.child({ module: "rollover-flush" });
const MEMORY_SAVE_FULL_NAME = mcpToolName(MEMORY_MCP_SERVER, MEMORY_SAVE_TOOL);

/** Counts the `MemorySave` calls of a stream that came back without an error (tool_use id -> its tool_result). */
function rememberCounter() {
  const calls = new Set<string>();
  let ok = 0;
  return {
    onMessage(msg: SDKMessage): void {
      const content = (msg as { message?: { content?: unknown } }).message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b?.type === "tool_use" && b.name === MEMORY_SAVE_FULL_NAME) calls.add(b.id);
        else if (b?.type === "tool_result" && calls.delete(b.tool_use_id) && b.is_error !== true)
          ok++;
      }
    },
    get saved(): number {
      return ok;
    },
  };
}

/** Chat text of the extract: the previous summary (as assistant text) + the thread's last messages. */
const chatOf = (summary: string, history: readonly RecentMessage[]): ChatText[] => [
  ...(summary ? [{ role: "assistant" as const, text: summary }] : []),
  ...history.map((m) => ({
    role: m.from === "owner" ? ("user" as const) : ("assistant" as const),
    text: m.text,
  })),
];

/** No-LLM fallback: phase 8 extractor over the existing summary + the last messages -> journal block. Returns the notes written. */
async function flushByExtract(
  d: RolloverDeps,
  req: RolloverRequest,
  summary: string,
): Promise<number> {
  const history = await d.history?.(EXTRACT_HISTORY_MESSAGES).catch(() => []);
  const ctx = buildMemoryToolContext({
    db: d.db,
    home: d.config.agentHome,
    workspace: req.workspace,
    threadId: req.threadId,
    trackSummary: true,
  });
  return journalExtract(ctx, extractContext(chatOf(summary, history ?? [])));
}

/**
 * Flush the thread's memory: the LLM run first (tools: only `MemorySave`, NO compaction hooks because its memory
 * context carries no thread id); an error, timeout, `NO_REPLY` or zero successful `MemorySave` calls falls back to the
 * extract (one cheap pass, no model). Logs `memory.flush {mode, remembered, ms}` (counts only). Never throws.
 */
export async function flushMemory(
  d: RolloverDeps,
  req: RolloverRequest,
  session: SessionRow,
  summary: string,
): Promise<"llm" | "extract"> {
  const t0 = Date.now();
  const counter = rememberCounter();
  let mode: "llm" | "extract" = "extract";
  let remembered = 0;
  try {
    const res = await runLean(d, req, session, {
      prompt: FLUSH_PROMPT,
      lean: {
        memoryTools: [MEMORY_SAVE_TOOL],
        maxTurns: FLUSH_MAX_TURNS,
        budgetFloorUsd: FLUSH_BUDGET_USD,
      },
      timeoutMs: FLUSH_TIMEOUT_MS,
      // No thread id = no PreCompact/PostCompact hooks in this run.
      memory: (base) => ({ ...base, threadId: undefined, trackSummary: false }),
      onMessage: counter.onMessage,
    });
    // A run that ended in error / timeout may still have saved some notes: those count.
    if (counter.saved > 0) {
      mode = "llm";
      remembered = counter.saved;
    } else {
      logEvent(log, "memory.flush_empty", {
        outcome: res.outcome,
        noReply: res.text.trim() === FLUSH_NO_REPLY,
      });
    }
  } catch (err) {
    logEvent(log, "memory.flush_failed", { err: errText(err, 200) }, "warn");
  }
  if (mode === "extract") {
    try {
      remembered = await flushByExtract(d, req, summary);
    } catch (err) {
      logEvent(log, "memory.flush_extract_failed", { err: errText(err, 200) }, "warn");
    }
  }
  logEvent(log, "memory.flush", {
    mode: mode === "llm" ? "llm" : "fallback",
    remembered,
    ms: Date.now() - t0,
  });
  return mode;
}
