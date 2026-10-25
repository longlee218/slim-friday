import type { ToolCall, ToolSpec } from "../domain/tool";
import { classifyTool } from "./classify-tool";
import { externalServerOf } from "./taint-policy";

/**
 * True for a call a scheduled run may make without a card (spec 6.4): `WebFetch`, or a tool of an external MCP
 * server that `classifyTool` judges `read`. Nothing else qualifies: not a built-in tool, not one of Friday's own
 * servers, not a write-class external call. The caller still applies it only to a scheduled run.
 */
export function isScheduledRead(call: Pick<ToolCall, "tool">, spec: ToolSpec | undefined): boolean {
  if (call.tool === "WebFetch") return true;
  return externalServerOf(call.tool) !== undefined && classifyTool(spec, call.tool) === "read";
}
