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
  message?: {
    content?:
      | string
      | {
          type: string;
          text?: string;
          id?: string;
          name?: string;
          input?: Record<string, unknown>;
          tool_use_id?: string;
          is_error?: boolean;
          /** On a tool_result: the result text, or text blocks. */
          content?: string | { type: string; text?: string }[];
        }[];
  };
  task_id?: string;
  /** On task_started: the id of the Agent call that started the task. */
  tool_use_id?: string;
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

/** The content blocks of a message (a plain string content has none). */
function blocks(m: Loose) {
  const c = m.message?.content;
  return Array.isArray(c) ? c : [];
}

/** Most urls kept from one tool result. */
const MAX_RESULT_URLS = 50;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/g;

/** The http(s) urls in a tool result's text (trailing punctuation cut), at most `MAX_RESULT_URLS`. */
function urlsOf(content: string | { type: string; text?: string }[] | undefined): string[] {
  const text =
    typeof content === "string"
      ? content
      : (content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
  const urls = new Set<string>();
  for (const m of text.matchAll(URL_IN_TEXT)) {
    urls.add(m[0].replace(/[.,;:)\]}]+$/, ""));
    if (urls.size >= MAX_RESULT_URLS) break;
  }
  return [...urls];
}

/**
 * Pure map from one SDK message to the runtime events of the port. Only the bot's own text, tool calls and
 * results become events (a subagent's chatter does not), and thinking only as a presence marker. An error result is an `error`, never a `turn_end`.
 */
export function mapMessage(message: SDKMessage): RuntimeEvent[] {
  const m = message as unknown as Loose;
  if (m.type === "assistant") {
    if (m.parent_tool_use_id) return [];
    const events: RuntimeEvent[] = [];
    const texts: string[] = [];
    let thought = false;
    for (const b of blocks(m)) {
      // Thinking is presence only, once per message; its text is never passed on.
      if ((b.type === "thinking" || b.type === "redacted_thinking") && !thought) {
        thought = true;
        events.push({ type: "thinking" });
      } else if (b.type === "tool_use")
        events.push({
          type: "tool_call",
          toolUseId: b.id ?? "",
          tool: b.name ?? "",
          input: b.input ?? {},
        });
      else if (b.type === "text" && b.text?.trim()) texts.push(b.text.trim());
    }
    if (texts.length) events.push({ type: "text", text: texts.join("\n") });
    return events;
  }
  if (m.type === "user") {
    if (m.parent_tool_use_id) return [];
    return blocks(m)
      .filter((b) => b.type === "tool_result")
      .map((b) => {
        const urls = urlsOf(b.content);
        return {
          type: "tool_result",
          toolUseId: b.tool_use_id ?? "",
          ok: !b.is_error,
          ...(urls.length > 0 && { urls }),
        };
      });
  }
  if (m.type === "system" && m.subtype === "task_started")
    return [
      {
        type: "task_started",
        taskId: m.task_id ?? "",
        description: m.description ?? "",
        ...(m.tool_use_id && { toolUseId: m.tool_use_id }),
      },
    ];
  if (m.type === "system" && m.subtype === "task_notification")
    return [
      {
        type: "task_done",
        taskId: m.task_id ?? "",
        status: m.status ?? "failed",
        summary: m.summary ?? "",
      },
    ];
  if (m.type === "system" && m.subtype === "compact_boundary") return [{ type: "compacted" }];
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
