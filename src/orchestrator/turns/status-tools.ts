import type { Database } from "bun:sqlite";
import { redactClip, redactText } from "../../observability/redact";
import { BASH_TOOL_NAME } from "../../tools/sdk-tool-names";

/* The tool part of a status: how many tools a turn called and the last few, from `tool_calls` rows only. Of a tool's
   input ONLY the Bash `description` (the agent's own one-line purpose) is read, redacted and clipped; every other
   tool shows its name alone, so no path, command or file content can leak through a status. */

/** Number of recent tools listed. */
const RECENT_TOOLS = 5;

/** Longest Bash description shown (chars, after redaction). */
const TOOL_DESCRIPTION_MAX = 80;

/** One recent tool: its name and, for Bash, the redacted description. */
export interface RecentTool {
  tool: string;
  description?: string;
}

/** The `description` of a Bash input (JSON text), redacted and clipped; undefined for anything else or unparsable input. */
function bashDescription(inputJson: string): string | undefined {
  try {
    const d = (JSON.parse(inputJson) as { description?: unknown }).description;
    if (typeof d !== "string" || !d.trim()) return undefined;
    return redactClip(d.replace(/\s+/g, " ").trim(), TOOL_DESCRIPTION_MAX);
  } catch {
    return undefined; // input_json was cut by the store: name only
  }
}

/** Tool calls of a turn (any run, subagents included): total, and the last `RECENT_TOOLS` oldest first. */
export function toolFacts(db: Database, turnId: string): { count: number; recent: RecentTool[] } {
  const count =
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM tool_calls WHERE turn_id = ?")
      .get(turnId)?.n ?? 0;
  const rows = db
    .query<{ tool: string; input_json: string }, [string, number]>(
      "SELECT tool, input_json FROM tool_calls WHERE turn_id = ? ORDER BY rowid DESC LIMIT ?",
    )
    .all(turnId, RECENT_TOOLS);
  const recent = rows.reverse().map((r) => {
    const description = r.tool === BASH_TOOL_NAME ? bashDescription(r.input_json) : undefined;
    return { tool: redactText(r.tool), ...(description && { description }) };
  });
  return { count, recent };
}
