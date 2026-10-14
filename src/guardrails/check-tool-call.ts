/**
 * Single entry point for tool guardrails: maps (toolName, input) to allow / ask / deny.
 * Pure: no SDK, no Discord, no logging. The caller wires it into PreToolUse / canUseTool.
 *
 * A deny list: Bash never asks (see bash-policy.ts); `ask` is left for unknown tools and a Monitor WebSocket.
 * NOTE: Bash parsing is best effort and can be bypassed (variable tricks, scripts, etc).
 */

import {
  GIT_MCP_SERVER,
  MCP_PREFIX,
  MEMORY_MCP_SERVER,
  MEMORY_TOOLS,
  mcpServerPrefix,
} from "../mcp/mcp-tool-names";
import type { RoleDefinition } from "../roles/role-types";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  LSP_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import { autoAllowedTools, toolsFor } from "../tools/tool-catalog";
import { checkBash, checkWorktreePath } from "./bash-policy";
import { checkFileRead, checkFileWrite } from "./deny-dangerous";
import { checkGitMcp } from "./git-mcp-guard";

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
  /** Real paths of registered locations: git MCP tools (the assistant's read tools) may READ these. */
  gitReadPaths?: string[];
  /** False = the role has no shell capability: Bash and Monitor are denied. Omitted (no role known) = allowed. */
  shell?: boolean;
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
    allowTools: autoAllowedTools(role),
    shell: toolsFor(role).includes(BASH_TOOL_NAME),
  };
}

const WRITE_TOOLS = new Set([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);
const READ_TOOLS = new Set([READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME, LSP_TOOL_NAME]);

/** Decide whether a tool call may run (any caller, subagents included). Unknown tools need approval. */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  if (WRITE_TOOLS.has(toolName)) return checkFileWrite(toolName, input, ctx.writePaths ?? []);
  if (READ_TOOLS.has(toolName)) return checkFileRead(toolName, input, ctx.readPaths);
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
  if (toolName.startsWith(mcpServerPrefix(GIT_MCP_SERVER))) {
    return checkGitMcp(toolName.slice(mcpServerPrefix(GIT_MCP_SERVER).length), input, ctx);
  }
  // The app's own memory server: exactly its listed tools (they only write the memory files, by their own rules).
  const memoryPrefix = mcpServerPrefix(MEMORY_MCP_SERVER);
  if (toolName.startsWith(memoryPrefix))
    return MEMORY_TOOLS.includes(toolName.slice(memoryPrefix.length))
      ? { decision: "allow", reason: "memory tool" }
      : { decision: "deny", reason: "unknown memory tool" };
  if (toolName.startsWith(MCP_PREFIX)) return { decision: "deny", reason: "unknown MCP tool" };
  // `Task` is the legacy name of the Agent tool: same decision.
  if (ctx.allowTools?.includes(toolName === LEGACY_AGENT_TOOL_NAME ? AGENT_TOOL_NAME : toolName))
    return { decision: "allow", reason: "tool allowed in this mode" };
  if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
    return { decision: "allow", reason: "handled by approval flow" };
  }
  return { decision: "ask", reason: `tool ${toolName} needs approval` };
}
