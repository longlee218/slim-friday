/**
 * Single entry point for tool guardrails: maps (toolName, input) to allow / ask / deny.
 * Pure: no SDK, no Discord, no logging. The caller wires it into PreToolUse / canUseTool.
 *
 * NOTE: Bash parsing is best effort and can be bypassed (variable tricks, scripts, etc).
 * Worktree isolation in phase 4 is the real security boundary; this layer reduces risk.
 */
import { checkBash } from "./bash-policy";
import { checkFileRead, checkFileWrite } from "./deny-dangerous";

/** Outcome of a guardrail check. `deny` is never approvable; `ask` needs the owner. */
export type Decision = { decision: "allow" | "ask" | "deny"; reason: string };

/** Per-task settings for guardrail checks. */
export interface GuardrailContext {
  /** Absolute dirs where writes are allowed (task scratch now, worktree in phase 4). */
  allowedPaths: string[];
  /** Real dirs Read/Glob/Grep may touch (scratch, plans dir, registered repos). Omitted = no limit. */
  allowedReadPaths?: string[];
  /** Hosts curl/wget may reach without asking. Default: github.com, api.github.com, registry.npmjs.org. */
  allowedHosts?: string[];
  /** Exact bash commands auto-allowed besides the built-ins (git status/diff/log). */
  allowedCommands?: string[];
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
/** Plan/question tools are handled elsewhere (Discord flow); guardrails just let them through. */
const PASSTHROUGH_TOOLS = new Set(["ExitPlanMode", "AskUserQuestion", "EnterPlanMode"]);

/** Decide whether a tool call may run. Unknown tools need approval. */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  if (WRITE_TOOLS.has(toolName)) return checkFileWrite(toolName, input, ctx.allowedPaths);
  if (READ_TOOLS.has(toolName)) return checkFileRead(toolName, input, ctx.allowedReadPaths);
  if (toolName === "Bash") {
    const command = input.command;
    if (typeof command !== "string" || command.trim() === "") {
      return { decision: "deny", reason: "Bash: missing or invalid command" };
    }
    return checkBash(command, ctx);
  }
  if (PASSTHROUGH_TOOLS.has(toolName)) {
    return { decision: "allow", reason: "handled by approval flow" };
  }
  return { decision: "ask", reason: `tool ${toolName} needs approval` };
}
