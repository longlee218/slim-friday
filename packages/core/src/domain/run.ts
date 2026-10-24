export type RunStepKind =
  | "thinking"
  | "tool"
  | "skill"
  | "mcp"
  | "subagent"
  | "command"
  | "writing";

/** One step of a bot's turn, shown as a line in the run block. */
export interface RunStep {
  id: string;
  kind: RunStepKind;
  label: string;
  target?: string;
  state: "running" | "done" | "failed";
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt?: number;
  /** Line counts; Edit and Write only. */
  added?: number;
  removed?: number;
}

/** Longest `target` kept; longer ones are cut and end with an ellipsis. */
const MAX_TARGET = 120;

/** A string field of the tool input, or undefined when absent or not a string. */
function str(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

/** Number of `\n`-separated lines; the empty string has none. */
function lines(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  return s === "" ? 0 : s.split("\n").length;
}

/** Cuts a target to `MAX_TARGET` chars plus an ellipsis. */
function cut(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s.length > MAX_TARGET ? `${s.slice(0, MAX_TARGET)}…` : s;
}

/** Builds the running step for a tool call; never throws on odd input. */
export function stepFromToolCall(
  toolUseId: string,
  tool: string,
  rawInput: Record<string, unknown>,
  now: number,
): RunStep {
  // A null or non-object input is treated as empty.
  const input = rawInput && typeof rawInput === "object" ? rawInput : {};
  let kind: RunStepKind = "tool";
  let label = tool;
  let target: string | undefined;
  let added: number | undefined;
  let removed: number | undefined;

  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    kind = "mcp";
    label = "Called";
    target = `${mcp[1]} · ${mcp[2]}`;
  } else {
    switch (tool) {
      case "Skill":
        kind = "skill";
        label = "Used skill";
        target = str(input, "skill");
        break;
      case "Task":
      case "Agent":
        kind = "subagent";
        label = "Started subagent";
        target = str(input, "description");
        break;
      case "Bash":
        kind = "command";
        label = "Ran";
        target = str(input, "command")?.split("\n")[0];
        break;
      case "Read":
        label = "Read";
        target = str(input, "file_path");
        break;
      case "Edit":
        label = "Edited";
        target = str(input, "file_path");
        added = lines(str(input, "new_string"));
        removed = lines(str(input, "old_string"));
        break;
      case "Write":
        label = "Wrote";
        target = str(input, "file_path");
        added = lines(str(input, "content"));
        break;
      case "Grep":
        label = "Searched";
        target = str(input, "pattern");
        break;
      case "Glob":
        label = "Listed";
        target = str(input, "pattern");
        break;
      case "WebFetch":
        label = "Fetched";
        target = str(input, "url");
        break;
      case "WebSearch":
        label = "Searched the web";
        target = str(input, "query");
        break;
    }
  }

  return {
    id: toolUseId,
    kind,
    label,
    ...(target !== undefined && { target: cut(target) }),
    state: "running",
    startedAt: now,
    ...(added !== undefined && { added }),
    ...(removed !== undefined && { removed }),
  };
}
