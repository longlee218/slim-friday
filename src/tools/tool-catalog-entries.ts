import { MCP_TOOL_ENTRIES } from "./tool-catalog-mcp-entries";
import { SDK_TOOL_ENTRIES } from "./tool-catalog-sdk-entries";
import type { ToolDecl } from "./tool-decl";

/** The tool catalog: one entry per assignable tool id (SDK groups, then MCP tools). The ONE place that says what a tool is. */
export const TOOL_CATALOG: readonly ToolDecl[] = [...SDK_TOOL_ENTRIES, ...MCP_TOOL_ENTRIES];

/** Entry by id (built once). */
export const TOOL_BY_ID: ReadonlyMap<string, ToolDecl> = new Map(
  TOOL_CATALOG.map((d) => [d.id, d]),
);
