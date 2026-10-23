import type { Reply } from "../effects/reply";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";

const log = logger.child({ module: "teammate-tool" });

/** Tool result with one text block; `isError` marks a refused or failed call. */
export const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError && { isError: true as const }),
});

/** MCP tool result: the reply as JSON text; a coded refusal sets `isError`. */
export const toToolResult = (reply: Reply) => ({
  content: [{ type: "text" as const, text: JSON.stringify(reply) }],
  ...(!reply.ok && { isError: true }),
});

/** Run a handler for a tool call: an unexpected throw becomes one coded error result (details only in the log). */
export async function runTool(tool: string, fn: () => Promise<Reply>) {
  try {
    return toToolResult(await fn());
  } catch (err) {
    log.warn({ tool, err: errText(err) }, "teammate tool failed");
    return toToolResult({ ok: false, code: "INTERNAL", message: "The tool failed (see logs)." });
  }
}
