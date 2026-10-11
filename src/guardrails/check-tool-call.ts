/**
 * Single entry point for tool guardrails: maps (toolName, input) to allow / ask / deny.
 * Pure: no SDK, no Discord, no logging. The caller wires it into PreToolUse / canUseTool.
 *
 * NOTE: Bash parsing is best effort and can be bypassed (variable tricks, scripts, etc).
 * The git worktree is the real security boundary; this layer reduces risk.
 */
import {
  GIT_MCP_SERVER,
  GITHUB_MCP_SERVER,
  MCP_PREFIX,
  mcpServerPrefix,
} from "../mcp/mcp-tool-names";
import { type StageRef, stageOf } from "../roles/role-registry";
import { type SubagentScope, scopesOf } from "../roles/subagents/subagent-registry";
import {
  AGENT_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LEGACY_AGENT_TOOL_NAME,
  MONITOR_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  READ_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../tools/sdk-tool-names";
import { autoAllowedTools, PLAN_FLOW_TOOLS } from "../tools/tool-catalog";
import { checkBash } from "./bash-policy";
import { checkFileRead, checkFileWrite } from "./deny-dangerous";
import { checkGitMcp, hasAttribution } from "./git-mcp-guard";
import { type AgentCaller, checkSpawn, checkSubagentCall } from "./subagent-guard";

export { hasAttribution };

/** Outcome of a guardrail check. `deny` is never approvable; `ask` needs the owner. */
export type Decision = {
  decision: "allow" | "ask" | "deny";
  reason: string;
  /** `ask` only: the owner decides even in SDK auto mode (see owner-only.ts); other asks may go to the classifier. */
  ownerOnly?: boolean;
};

/**
 * Decision as logged on `tool.done`: the guard's, "auto" = guard asked, the SDK classifier decided,
 * "bypass" = guard asked, the bypass-mode stage let the call run without approval.
 */
export type LoggedDecision = { decision: Decision["decision"] | "auto" | "bypass"; reason: string };

/** Per-task settings for guardrail checks. */
export interface GuardrailContext {
  /** Real path of the run's working dir: relative paths of a Bash line resolve against it. Omitted = unknown (read commands with relative paths ask). */
  cwd?: string;
  /** Real dirs where writes are allowed (plan stage: scratch + plans dir; execute stage: the worktree). */
  writePaths?: string[];
  /** Real dirs Read/Glob/Grep may touch (scratch, plans dir, registered repos). Omitted = no limit. */
  readPaths?: string[];
  /** Real path of the worktree: the only repo git MCP tools may WRITE to (add/commit/...). */
  gitWriteRepo?: string;
  /** Real paths of registered repos: git MCP tools may READ (log/diff/show/...) these. */
  gitReadRepos?: string[];
  /** Orchestration tools of the current mode that need no approval (Skill, TodoWrite, WebFetch...). */
  allowTools?: string[];
  /** Subagent types the Agent tool may start (each has explicit tools); anything else is denied. */
  allowedSubagents?: string[];
  /** Guard scope per subagent type the stage may start (registry data). A caller type missing here is denied. */
  subagentScopes?: Record<string, SubagentScope>;
  /** Set only for a call made inside a subagent (hook input `agent_id`/`agent_type`); the main agent has none. */
  agent?: AgentCaller;
  /** Exact bash commands auto-allowed besides the built-ins (the repo's test command). */
  allowedCommands?: string[];
}

/** What differs between runs of one mode: where it may read/write and which repos git may touch. */
export type GuardScope = Omit<
  GuardrailContext,
  "allowTools" | "allowedSubagents" | "subagentScopes" | "agent"
>;

/**
 * The guard context of a run: the stage's auto-allowed tools come from the tool catalog, its subagent
 * allowlist from the stage itself (none listed = none allowed, fail closed), the paths from the caller.
 * One builder for every stage.
 */
export function guardFor(stage: StageRef, scope: GuardScope): GuardrailContext {
  const subagents = stageOf(stage).subagents ?? [];
  return {
    ...scope,
    allowTools: autoAllowedTools(stage),
    allowedSubagents: subagents,
    subagentScopes: scopesOf(subagents),
  };
}

const WRITE_TOOLS = new Set([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);
const READ_TOOLS = new Set([READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]);

/**
 * Decide whether a tool call may run. Unknown tools need approval. A call inside a subagent (`ctx.agent`) also
 * goes through the subagent rules: scope, no owner questions, no nested spawn, and every ask becomes a deny.
 */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  return ctx.agent
    ? checkSubagentCall(toolName, input, ctx, checkMainCall)
    : checkMainCall(toolName, input, ctx);
}

/** The checks every call goes through (the main agent's rules). */
function checkMainCall(
  toolName: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  if (WRITE_TOOLS.has(toolName)) return checkFileWrite(toolName, input, ctx.writePaths ?? []);
  if (READ_TOOLS.has(toolName)) return checkFileRead(toolName, input, ctx.readPaths);
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
  // GitHub MCP is started read-only for agents (the app creates PRs itself): every tool it has is a read.
  if (toolName.startsWith(mcpServerPrefix(GITHUB_MCP_SERVER)))
    return { decision: "allow", reason: "github read tool" };
  if (toolName.startsWith(MCP_PREFIX)) return { decision: "deny", reason: "unknown MCP tool" };
  if (toolName === AGENT_TOOL_NAME || toolName === LEGACY_AGENT_TOOL_NAME)
    return checkSpawn(input, ctx);
  if (ctx.allowTools?.includes(toolName))
    return { decision: "allow", reason: "tool allowed in this mode" };
  if (PLAN_FLOW_TOOLS.has(toolName)) {
    return { decision: "allow", reason: "handled by approval flow" };
  }
  return { decision: "ask", reason: `tool ${toolName} needs approval` };
}
