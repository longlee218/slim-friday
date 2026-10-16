/**
 * Single entry point for tool guardrails: maps (toolName, input) to allow / ask / deny.
 * Pure: no SDK, no Discord, no logging. The caller wires it into PreToolUse / canUseTool.
 *
 * A deny list: Bash never asks (see bash-policy.ts); `ask` is left for unknown tools and a Monitor WebSocket.
 * NOTE: Bash parsing is best effort and can be bypassed (variable tricks, scripts, etc).
 */

import { MCP_PREFIX } from "../mcp/mcp-tool-names";
import { mcpToolNamesOfRole } from "../mcp/tool-names-of-role";
import type { RoleDefinition } from "../roles/role-types";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  LSP_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import { autoAllowedTools, toolsFor } from "../tools/tool-catalog";
import { checkBash, checkWorktreePath } from "./bash-policy";
import { checkFileRead, checkFileWrite } from "./deny-dangerous";
import type { DispatchEnvelope } from "./envelope";
import { envelopeGate } from "./envelope-guard";

/** Outcome of a guardrail check. `deny` is never approvable; `ask` needs the owner. */
export type Decision = {
  decision: "allow" | "ask" | "deny";
  reason: string;
};

/**
 * Decision as logged on `tool.done`: the guard's, "auto" = guard asked, the SDK classifier decided,
 * "bypass" = guard asked, the bypass-mode run let the call run without approval.
 */
export type LoggedDecision = { decision: Decision["decision"] | "auto" | "bypass"; reason: string };

/** Per-task settings for guardrail checks. */
export interface GuardrailContext {
  /** Real path of the run's working dir: relative paths of a Bash line resolve against it. Omitted = relative `rm -r` / worktree paths are denied. */
  cwd?: string;
  /** Real dirs where writes are allowed (the workspace's locations, worktrees dir, scratch, plans dir). */
  writePaths?: string[];
  /** Real dirs Read/Glob/Grep may touch (scratch, plans dir, registered locations). Omitted = no limit. */
  readPaths?: string[];
  /** Real dirs where `git worktree add` / EnterWorktree may put a worktree (`workspace(ws).worktrees`). Omitted = none allowed. */
  worktreeDirs?: string[];
  /** Real dirs no tool may touch, read or write (AGENT_HOME), even inside a registered location. Omitted = none. */
  denyPaths?: string[];
  /** Real dirs under `denyPaths` that stay usable: the run's own scratch, worktrees, `cwd/`, attachments, skill dirs. */
  allowInside?: string[];
  /** Real dirs of the run's skill plugins (read-only, under the agent home): the only place a worker's shell may run a script from. Omitted = none. */
  skillDirs?: string[];
  /** False = the role has no shell capability: Bash and Monitor are denied. Omitted (no role known) = allowed. */
  shell?: boolean;
  /** `read` = the shell may run read-only commands only (role data `shellMode`); omitted = the role's deny-list shell. */
  shellMode?: "read";
  /** A dispatched worker's envelope: the shell is an allowlist and every call is checked against it (fail closed). Omitted = no envelope (deny-list only). */
  envelope?: DispatchEnvelope;
  /** False = no SDK subagent tools (Agent, Task, SendMessage, ListAgents): denied. Omitted = allowed. */
  subagents?: boolean;
  /** Orchestration tools of the current mode that need no approval (Skill, TodoWrite, WebFetch...). */
  allowTools?: string[];
}

/** What differs between runs of one mode: where it may read/write and which locations git may touch. */
export type GuardScope = Omit<GuardrailContext, "allowTools">;

/**
 * The guard context of a run: the role's auto-allowed tools come from the tool catalog, the paths from the caller.
 * One builder for every role.
 */
export function guardFor(role: RoleDefinition, scope: GuardScope): GuardrailContext {
  return {
    ...scope,
    allowTools: [...autoAllowedTools(role), ...mcpToolNamesOfRole(role)],
    shell: toolsFor(role).includes(BASH_TOOL_NAME),
    ...(role.shellMode && { shellMode: role.shellMode }),
    // Depth 1: the role's data wins; a run (a dispatched worker) may also turn subagents off through the scope.
    subagents: role.noSubagents ? false : (scope.subagents ?? true),
  };
}

const WRITE_TOOLS = new Set([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);
const SUBAGENT_TOOLS = new Set([AGENT_TOOL_NAME, SEND_MESSAGE_TOOL_NAME, LIST_AGENTS_TOOL_NAME]);
const READ_TOOLS = new Set([READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, LSP_TOOL_NAME]);

/**
 * Decide whether a tool call may run (any caller, subagents included). Unknown tools need approval. The hard denies
 * come first; a run with an envelope then passes through the envelope gate (envelope-guard.ts).
 */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  const d = checkBase(toolName, input, ctx);
  return ctx.envelope ? envelopeGate(toolName, input, ctx, d) : d;
}

/** The role-independent rules of `checkToolCall` (paths, shell, MCP tools): allow / ask / deny without the envelope. */
function checkBase(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  // Depth 1: a lead or worker spawns no subagent of its own (second lock behind `tools`).
  if (ctx.subagents === false && SUBAGENT_TOOLS.has(toolName))
    return { decision: "deny", reason: "no subagents in this role" };
  if (WRITE_TOOLS.has(toolName)) return checkFileWrite(toolName, input, ctx.writePaths ?? [], ctx);
  if (READ_TOOLS.has(toolName)) return checkFileRead(toolName, input, ctx.readPaths, ctx);
  // EnterWorktree: only an existing worktree under the worktrees dir (`name` would create one in the location's .claude dir).
  if (toolName === ENTER_WORKTREE_TOOL_NAME)
    return checkWorktreePath(typeof input.path === "string" ? input.path : undefined, ctx.cwd, ctx);
  // A role without the shell capability never runs a shell, whatever the SDK offers (second lock behind `tools`).
  if ((toolName === BASH_TOOL_NAME || toolName === MONITOR_TOOL_NAME) && ctx.shell === false)
    return { decision: "deny", reason: "no shell in this role" };
  // Monitor runs a shell command (same policy as Bash); a WebSocket watch has no command -> owner decides.
  if (toolName === MONITOR_TOOL_NAME && typeof input.command !== "string")
    return {
      decision: "ask",
      reason: "Monitor without a shell command (WebSocket) needs approval",
    };
  if (toolName === BASH_TOOL_NAME || toolName === MONITOR_TOOL_NAME) {
    const command = input.command;
    if (typeof command !== "string" || command.trim() === "") {
      return { decision: "deny", reason: "Bash: missing or invalid command" };
    }
    return checkBash(command, ctx);
  }
  // An app MCP tool: allowed only when the role's `mcpTools` lists it (`guardFor` puts those in `allowTools`); any other
  // `mcp__*` tool is denied (second lock behind the per-run server build).
  if (toolName.startsWith(MCP_PREFIX))
    return ctx.allowTools?.includes(toolName)
      ? { decision: "allow", reason: "MCP tool of this role" }
      : { decision: "deny", reason: "unknown MCP tool" };
  if (ctx.allowTools?.includes(toolName))
    return { decision: "allow", reason: "tool allowed in this mode" };
  if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
    return { decision: "allow", reason: "handled by approval flow" };
  }
  return { decision: "ask", reason: `tool ${toolName} needs approval` };
}
