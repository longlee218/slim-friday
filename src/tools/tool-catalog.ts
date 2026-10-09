import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { GIT_MCP_SERVER, GIT_TOOL, mcpToolName } from "../mcp/mcp-tool-names";
import { type StageRef, stageOf } from "../roles/role-registry";
import type { Capability } from "../roles/role-types";
import { DELEGATE_TASK_MCP_TOOL_NAME } from "./DelegateTaskTool/constants";
import { GIT_GROUPS } from "./git-tool-groups";
import {
  AGENT_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  TODO_WRITE_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "./sdk-tool-names";

export { GIT_GROUPS };

/**
 * The single place that says WHICH tools exist. WHICH stage gets what is data in `src/roles` (capabilities,
 * gitGroups, subagents); everything here (SDK options, the guard's auto-allowed list, hidden git tools) is
 * derived from a stage by the functions below. Functions take a StageDefinition (or its name).
 */

/**
 * Plan-flow tools: ExitPlanMode and AskUserQuestion are answered by the owner (canUseTool); Enter is harmless.
 * The guard lets these through; the approval flow (not the guard) decides on them.
 */
export const PLAN_FLOW_TOOLS: ReadonlySet<string> = new Set([
  EXIT_PLAN_MODE_TOOL_NAME,
  ASK_USER_QUESTION_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
]);

/** Built-in tools of each capability. */
const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  read: [READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME],
  write: [WRITE_TOOL_NAME, EDIT_TOOL_NAME],
  shell: [BASH_TOOL_NAME],
  web: [WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME],
  skills: [SKILL_TOOL_NAME],
  subagents: [AGENT_TOOL_NAME],
  tasks: [
    TODO_WRITE_TOOL_NAME,
    TASK_CREATE_TOOL_NAME,
    TASK_UPDATE_TOOL_NAME,
    TASK_LIST_TOOL_NAME,
    TOOL_SEARCH_TOOL_NAME,
  ],
  ask: [ASK_USER_QUESTION_TOOL_NAME],
  planControl: [EXIT_PLAN_MODE_TOOL_NAME, ENTER_PLAN_MODE_TOOL_NAME],
  // The handoff tool is an MCP tool (not in `tools`); this capability only gates its server and prompt.
  recommend: [],
};

/** Tools that run without asking anyone (the other tools go through path/policy checks or the owner). */
const AUTO_ALLOWED = new Set<string>([
  ...CAPABILITY_TOOLS.web,
  ...CAPABILITY_TOOLS.skills,
  ...CAPABILITY_TOOLS.tasks,
  ENTER_PLAN_MODE_TOOL_NAME,
]);

/** Built-in tools of a stage (the SDK `tools` option). */
export const toolsFor = (stage: StageRef): string[] =>
  stageOf(stage).capabilities.flatMap((c) => CAPABILITY_TOOLS[c]);

/**
 * Tools of a stage that need no approval (the guard's `allowTools`). `DelegateTask` exists in stages with the
 * `recommend` capability, and is allowed only when the run registers it (`delegate`, default true); otherwise
 * the guard denies the unknown tool.
 */
export const autoAllowedTools = (stage: StageRef, opts: { delegate?: boolean } = {}): string[] => {
  const s = stageOf(stage);
  return [
    ...toolsFor(s).filter((t) => AUTO_ALLOWED.has(t)),
    ...(s.capabilities.includes("recommend") && (opts.delegate ?? true)
      ? [DELEGATE_TASK_MCP_TOOL_NAME]
      : []),
  ];
};

/* ---------------- git MCP tools (@cyanheads/git-mcp-server 2.15.3) ---------------- */

/**
 * Tools visible in every stage that are reads only in some `mode` values (an absent mode is the server's
 * default: list). The guard derives its check from this table: tool -> read-only modes (the git tool's own `mode` argument).
 */
export const GIT_READ_BY_MODE: Record<string, readonly string[]> = {
  [GIT_TOOL.BRANCH]: ["list", "show-current"],
};

/** Every tool of the server. Agents never get push/pull/fetch/clone/worktree/...: the app calls those. */
const ALL_GIT_TOOLS: readonly string[] = Object.values(GIT_TOOL);

/** Git MCP tools a stage may see (its groups, plus the by-mode reads, always). */
export const gitToolsFor = (stage: StageRef): string[] => [
  ...stageOf(stage).gitGroups.flatMap((g) => GIT_GROUPS[g]),
  ...Object.keys(GIT_READ_BY_MODE),
];

/** Git MCP tools to hide from a stage (`mcp__git__…`): a shorter tool list and a second lock behind the guard. */
export const hiddenGitTools = (stage: StageRef): string[] => {
  const allowed = new Set<string>(gitToolsFor(stage));
  return ALL_GIT_TOOLS.filter((t) => !allowed.has(t)).map((t) => mcpToolName(GIT_MCP_SERVER, t));
};

/* ---------------- SDK options + subagents ---------------- */

/**
 * Scoped deny rules for secret files (documented: disallowedTools accepts `Tool(pattern)` rules
 * that are denied in every permission mode). Backstop for the prompt rule; redaction is the other.
 */
export const SECRET_FILE_RULES = [
  `${READ_TOOL_NAME}(**/.env*)`,
  `${READ_TOOL_NAME}(**/*.pem)`,
  `${READ_TOOL_NAME}(**/*.key)`,
  `${READ_TOOL_NAME}(**/id_rsa*)`,
  `${READ_TOOL_NAME}(**/credentials*)`,
];

/**
 * SDK options fragment for a stage, derived from this catalog. ONLY `tools` restricts the built-in set
 * (we trust the SDK for that, verified per mode with the real SDK); `allowedTools` would auto-approve and
 * bypass canUseTool, so it is never used. `disallowedTools` only carries what `tools` cannot express: the
 * path-scoped secret-file rules and the git MCP tools of other stages.
 */
export function toolOptions(stage: StageRef) {
  return {
    tools: toolsFor(stage),
    disallowedTools: [...hiddenGitTools(stage), ...SECRET_FILE_RULES],
    // Only the MCP servers we pass in `mcpServers`; ignore account connectors and project .mcp.json.
    strictMcpConfig: true,
  };
}

/**
 * Subagents the main agent may start. Each one gets EXPLICIT tools: a subagent otherwise inherits the
 * default set (Bash, Write...), not the parent's restricted one (spike finding). Read-only on purpose.
 */
export const SUBAGENTS: Record<string, AgentDefinition> = {
  "repo-searcher": {
    description:
      "Searches code across the registered repos and reports findings with file:line. Use for broad lookups.",
    prompt:
      "You search code. Use Glob/Grep/Read with absolute paths. Report only what you found, each item with file:line. Do not modify anything.",
    tools: [READ_TOOL_NAME, GLOB_TOOL_NAME, GREP_TOOL_NAME],
  },
};
