import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";

/** Longest text of an external MCP result the model sees. */
const RESULT_MAX_CHARS = 12_000;

/** In-process Friday servers: their results are clipped when built (`textResult` in packages/tools). */
const OWN_SERVERS = ["memory", "effects", "chat", "design", "tickets", "scratchpad"];

/**
 * Copy of `clipResult` in packages/tools/src/clip-result.ts (runtime-claude may not import that package): same cut
 * on a code-point boundary, same marker. Keep both in step.
 */
export function clipText(text: string, max = RESULT_MAX_CHARS): string {
  if (text.length <= max) return text;
  let cut = max;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}\n…[output cut: ${text.length - cut} more characters not shown]`;
}

/** The text of an MCP tool response: a string, or `{ content: [{ type: "text", text }] }` / the bare block array. */
function textOf(response: unknown): string | undefined {
  if (typeof response === "string") return response;
  const blocks = Array.isArray(response)
    ? response
    : (response as { content?: unknown } | null)?.content;
  if (!Array.isArray(blocks) || !blocks.length) return undefined;
  // Images and other parts stay untouched: only an all-text result is rewritten.
  if (!blocks.every((b) => b?.type === "text" && typeof b.text === "string")) return undefined;
  return blocks.map((b) => b.text as string).join("\n");
}

/**
 * The `PostToolUse` hook of a session: an EXTERNAL MCP tool result (an `mcp__` tool of a server that is not one of
 * Friday's in-process servers) over 12 000 chars is replaced by its clipped text through `updatedMCPToolOutput`
 * (a plain string; the shape the Task 1 spike verified). Error results are clipped too. Everything else passes.
 */
export function postToolUseHook(): HookCallback {
  return async (hook) => {
    if (hook.hook_event_name !== "PostToolUse") return { continue: true };
    const match = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(hook.tool_name);
    if (!match) return { continue: true };
    const server = hook.mcp_server?.name ?? match[1] ?? "";
    // In-process servers are Friday's own; with no provenance, fall back to the name.
    const own = hook.mcp_server ? hook.mcp_server.source === "sdk" : OWN_SERVERS.includes(server);
    if (own) return { continue: true };
    const text = textOf(hook.tool_response);
    if (text === undefined || text.length <= RESULT_MAX_CHARS) return { continue: true };
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse" as const,
        updatedMCPToolOutput: clipText(text),
      },
    };
  };
}
