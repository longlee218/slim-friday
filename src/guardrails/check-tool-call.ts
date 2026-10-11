/**
 * Single entry point for tool guardrails: maps (toolName, input) to allow / ask / deny.
 * Pure: no SDK, no Discord, no logging. The caller wires it into PreToolUse / canUseTool.
 *
 * NOTE: Bash parsing is best effort and can be bypassed (variable tricks, scripts, etc).
 * The git worktree is the real security boundary; this layer reduces risk.
 */
import {
  GIT_MCP_SERVER,
  GIT_TOOL,
  GITHUB_MCP_SERVER,
  MCP_PREFIX,
  mcpServerPrefix,
} from "../mcp/mcp-tool-names";
import { type StageRef, stageOf } from "../roles/role-registry";
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
import {
  autoAllowedTools,
  GIT_GROUPS,
  GIT_READ_BY_MODE,
  PLAN_FLOW_TOOLS,
} from "../tools/tool-catalog";
import { checkBash } from "./bash-policy";
import { checkFileRead, checkFileWrite } from "./deny-dangerous";
import { resolveReal } from "./paths";

/** Outcome of a guardrail check. `deny` is never approvable; `ask` needs the owner. */
export type Decision = { decision: "allow" | "ask" | "deny"; reason: string };

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
  /** Exact bash commands auto-allowed besides the built-ins (the repo's test command). */
  allowedCommands?: string[];
}

/** What differs between runs of one mode: where it may read/write and which repos git may touch. */
export type GuardScope = Omit<GuardrailContext, "allowTools" | "allowedSubagents">;

/**
 * The guard context of a run: the stage's auto-allowed tools come from the tool catalog, its subagent
 * allowlist from the stage itself (none listed = none allowed, fail closed), the paths from the caller.
 * One builder for every stage.
 */
export function guardFor(stage: StageRef, scope: GuardScope): GuardrailContext {
  return {
    ...scope,
    allowTools: autoAllowedTools(stage),
    allowedSubagents: stageOf(stage).subagents ?? [],
  };
}

const WRITE_TOOLS = new Set([
  WRITE_TOOL_NAME,
  EDIT_TOOL_NAME,
  MULTI_EDIT_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
]);
const READ_TOOLS = new Set([READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME]);

/** Attribution lines that must never appear in a commit message (AI co-author / generated-with trailers). */
export const hasAttribution = (text: string): boolean =>
  /co-authored-by|generated (with|by)|🤖|noreply@anthropic\.com/i.test(text);

/** git MCP tools (@cyanheads/git-mcp-server) by risk. Everything else of that server is denied for agents. */
const GIT_READ = new Set<string>(GIT_GROUPS.read);

/** Decide a call of the git MCP server: allowed path only, then by risk. */
function checkGitMcp(
  name: string,
  input: Record<string, unknown>,
  ctx: GuardrailContext,
): Decision {
  const path = typeof input.path === "string" ? input.path : "";
  let real = "";
  try {
    real = path ? resolveReal(path) : "";
  } catch {
    /* unresolvable: denied below */
  }
  const isWorktree = !!ctx.gitWriteRepo && real === ctx.gitWriteRepo;
  if (!real || !(isWorktree || ctx.gitReadRepos?.includes(real))) {
    return {
      decision: "deny",
      reason: "git tools need an explicit path of the task worktree or a registered repo",
    };
  }
  const mode = typeof input.mode === "string" ? input.mode : undefined;
  const readModes = GIT_READ_BY_MODE[name];
  if (GIT_READ.has(name) || (readModes && (mode === undefined || readModes.includes(mode)))) {
    return { decision: "allow", reason: "git read tool" };
  }
  if (!isWorktree)
    return { decision: "deny", reason: "git changes are only allowed in the task worktree" };
  if (name === GIT_TOOL.ADD) return { decision: "allow", reason: "git tool in worktree" };
  if (name === GIT_TOOL.COMMIT) {
    // Identity comes from the server's env: the agent may not pick an author, amend, or skip hooks.
    if (input.author !== undefined || input.amend || input.noVerify) {
      return {
        decision: "deny",
        reason: "commit as configured: no author override, amend or no-verify",
      };
    }
    if (typeof input.message === "string" && hasAttribution(input.message)) {
      return {
        decision: "deny",
        reason:
          "commit as the owner only: remove Co-Authored-By / generated-with / AI attribution lines",
      };
    }
    return { decision: "allow", reason: "git commit in worktree" };
  }
  if (name === GIT_TOOL.CHECKOUT)
    return { decision: "ask", reason: `${name} changes branch or files` };
  if (name === GIT_TOOL.RESET && mode !== "hard")
    return { decision: "ask", reason: `${name} changes the index/history` };
  return { decision: "deny", reason: `${name} is not available to agents (the app handles it)` };
}

/** Decide whether a tool call may run. Unknown tools need approval. */
export function checkToolCall(
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
  if (toolName === AGENT_TOOL_NAME || toolName === LEGACY_AGENT_TOOL_NAME) {
    const type = input.subagent_type;
    const ok = typeof type === "string" && ctx.allowedSubagents?.includes(type);
    return ok
      ? { decision: "allow", reason: "configured subagent" }
      : { decision: "deny", reason: "only the configured subagents may be started" };
  }
  if (ctx.allowTools?.includes(toolName))
    return { decision: "allow", reason: "tool allowed in this mode" };
  if (PLAN_FLOW_TOOLS.has(toolName)) {
    return { decision: "allow", reason: "handled by approval flow" };
  }
  return { decision: "ask", reason: `tool ${toolName} needs approval` };
}
