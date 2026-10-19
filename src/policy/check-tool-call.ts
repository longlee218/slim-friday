/**
 * Single entry point for tool guardrails: maps (toolName, input) to allow / ask / deny.
 * Pure: no SDK, no Discord, no logging. The caller wires it into PreToolUse / canUseTool.
 *
 * Bash is not parsed: a role with the `shell` capability may call them and the OS sandbox of the run
 * (worker-sandbox.ts: writes only in the granted dirs, network open by owner decision) bounds them. `ask` is left for unknown tools (Monitor included).
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
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  SANDBOX_NETWORK_ACCESS_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import { autoAllowedTools, subagentToolsFor, toolsFor } from "../tools/tool-catalog";
import { checkFileRead, checkFileWrite } from "./deny-dangerous";
import type { DispatchEnvelope } from "./envelope";
import { envelopeGate } from "./envelope-guard";
import { checkWorktreePath } from "./worktree-path";

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
  /** Real path of the run's working dir: a relative EnterWorktree / search path resolves against it. */
  cwd?: string;
  /** Real dirs where writes are allowed (the workspace's locations, worktrees dir, scratch, plans dir). */
  writePaths?: string[];
  /** Real dirs Read/Glob/Grep may touch (scratch, plans dir, registered locations). Omitted = no limit. */
  readPaths?: string[];
  /** Real dirs where EnterWorktree may put a worktree (`workspace(ws).worktrees`). Omitted = none allowed. */
  worktreeDirs?: string[];
  /** Real dirs no tool may touch, read or write (AGENT_HOME), even inside a registered location. Omitted = none. */
  denyPaths?: string[];
  /** Real dirs under `denyPaths` that stay usable: the run's own scratch, worktrees, `cwd/`, attachments, skill dirs. */
  allowInside?: string[];
  /** Real dirs of the run's skill plugins (read-only, under the agent home): the sandbox lets a shell read them. Omitted = none. */
  skillDirs?: string[];
  /** False = the role has no shell capability: Bash is denied. Omitted (no role known) = allowed. */
  shell?: boolean;
  /** A dispatched worker's envelope: effect tools are checked against it and an `ask` is classified (fail closed). Omitted = no envelope. */
  envelope?: DispatchEnvelope;
  /** False = no SDK subagent tools (Agent, Task, SendMessage, ListAgents): denied. Omitted = allowed. */
  subagents?: boolean;
  /** Tools a subagent call may use (`subagentToolsFor(role)`); a subagent call of any other tool is denied. Omitted = a subagent may use none. */
  subagentTools?: string[];
  /** Orchestration tools of the current mode that need no approval (Skill, TodoWrite, WebFetch...). */
  allowTools?: string[];
}

/** What differs between runs of one mode: where it may read/write and which locations git may touch. */
export type GuardScope = Omit<GuardrailContext, "allowTools" | "subagents" | "subagentTools">;

/**
 * The guard context of a run: the role's auto-allowed tools come from the tool catalog, the paths from the caller.
 * One builder for every role.
 */
export function guardFor(role: RoleDefinition, scope: GuardScope): GuardrailContext {
  return {
    ...scope,
    allowTools: [...autoAllowedTools(role), ...mcpToolNamesOfRole(role)],
    shell: toolsFor(role).includes(BASH_TOOL_NAME),
    subagentTools: subagentToolsFor(role),
    // Subagent tools on/off comes from the role's data only.
    subagents: !role.noSubagents,
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
 * Decide whether a tool call may run. `caller.subagent` = the call comes from a subagent of the run (hook input has
 * `agent_id`): it may use only `ctx.subagentTools`, then the normal checks apply as for the parent. Unknown tools need
 * approval. The hard denies come first; a run with an envelope then passes through the envelope gate (envelope-guard.ts).
 */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
  caller: { subagent: boolean } = { subagent: false },
): Decision {
  // Subagent allowlist, first rule: files, shell, web and skills within the parent role's capabilities; no MCP, no owner questions.
  if (caller.subagent && !ctx.subagentTools?.includes(toolName))
    return {
      decision: "deny",
      reason: "a subagent may use only read, write, shell, web and skills tools",
    };
  const d = checkBase(toolName, input, ctx);
  return ctx.envelope ? envelopeGate(toolName, input, ctx, d) : d;
}

/** The role-independent rules of `checkToolCall` (paths, shell capability, MCP tools): allow / ask / deny without the envelope. */
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
  if (toolName === BASH_TOOL_NAME && ctx.shell === false)
    return { decision: "deny", reason: "no shell in this role" };
  // Monitor is not a shell capability of any role (its processes were not probed inside the OS sandbox): it falls to `ask`.
  if (toolName === BASH_TOOL_NAME) {
    const command = input.command;
    if (typeof command !== "string" || command.trim() === "") {
      return { decision: "deny", reason: "Bash: missing or invalid command" };
    }
    // Second lock behind the sandbox settings: a command may not ask to run outside the sandbox.
    if (input.dangerouslyDisableSandbox)
      return { decision: "deny", reason: "Bash: sandbox opt-out is not allowed" };
    return { decision: "allow", reason: "shell bounded by the OS sandbox" };
  }
  // The network is open (owner decision 2026-10-18): the SDK's per-host prompt of a sandboxed command is allowed (a shell worker only).
  if (toolName === SANDBOX_NETWORK_ACCESS_TOOL_NAME && ctx.shell)
    return { decision: "allow", reason: "network is open for a shell worker" };
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
