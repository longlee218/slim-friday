import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeEvent } from "@friday/core";
import { isSandboxFailure, SANDBOX_UNAVAILABLE } from "../floor/sandbox-errors";

/** Provider and network phrases that pass by themselves: overload, 5xx, rate limit, dropped connection. */
const TRANSIENT_TEXT =
  /overloaded|api error:?\s*(429|5\d\d)|status(?: code)?:?\s*(429|5\d\d)|(?<![:.\w])(502|503|504|529)(?![:.\w])|internal server error|bad gateway|service unavailable|gateway timeout|rate[ _]limit|too many requests|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network (error|socket)/i;

/** Loose view of the SDK messages this mapper reads (the SDK union is wide; only these fields matter). */
interface Loose {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: { type: string; text?: string }[] };
  task_id?: string;
  description?: string;
  status?: "completed" | "failed" | "stopped";
  summary?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  errors?: string[];
  result?: string;
}

/** The error text of a failed result: its errors, else its result text, else its subtype. */
function failureText(m: Loose): string {
  return m.errors?.length ? m.errors.join("; ") : (m.result ?? m.subtype ?? "unknown error");
}

/**
 * Pure map from one SDK message to the runtime events of the port. Only the bot's own text becomes `text`
 * (a subagent's chatter does not). An error result is an `error`, never a `turn_end`.
 */
export function mapMessage(message: SDKMessage): RuntimeEvent[] {
  const m = message as unknown as Loose;
  if (m.type === "assistant") {
    if (m.parent_tool_use_id) return [];
    const text = (m.message?.content ?? [])
      .map((b) => (b.type === "text" ? (b.text ?? "").trim() : ""))
      .filter(Boolean)
      .join("\n");
    return text ? [{ type: "text", text }] : [];
  }
  if (m.type === "system" && m.subtype === "task_started")
    return [{ type: "task_started", taskId: m.task_id ?? "", description: m.description ?? "" }];
  if (m.type === "system" && m.subtype === "task_notification")
    return [
      {
        type: "task_done",
        taskId: m.task_id ?? "",
        status: m.status ?? "failed",
        summary: m.summary ?? "",
      },
    ];
  if (m.type === "result") {
    const ended = m.subtype === "error_max_turns" || (m.subtype === "success" && !m.is_error);
    if (ended) return [{ type: "turn_end", costUsd: m.total_cost_usd ?? 0 }];
    const text = failureText(m);
    if (isSandboxFailure(text))
      return [{ type: "error", message: `${SANDBOX_UNAVAILABLE}: ${text}`, retryable: false }];
    return [{ type: "error", message: text, retryable: TRANSIENT_TEXT.test(text) }];
  }
  return [];
}
