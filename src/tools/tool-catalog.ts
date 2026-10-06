import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

/**
 * The single place that says WHICH tools exist and WHICH mode gets what. Everything else (SDK options,
 * the guard's auto-allowed list, hidden git tools) is derived by the functions below: change a mode here,
 * nothing else needs editing.
 */

/** Where a run is: Q&A, the plan stage of a code task, or its execute stage in the worktree. */
export type ToolMode = "qa" | "plan" | "exec";

/** A group of built-in tools that belong together. */
export type Capability =
  | "read" // look at files
  | "write" // change files (paths limited by the guard)
  | "shell" // Bash (policy + owner approval)
  | "web" // search / fetch
  | "skills"
  | "subagents" // Agent: only the configured read-only subagents (guard)
  | "tasks" // progress tracking
  | "ask" // AskUserQuestion: answered by the owner through Discord buttons
  | "planControl"; // enter / leave plan mode (leaving needs the owner's approval)

/** Plan-flow tools: ExitPlanMode and AskUserQuestion are answered by the owner (canUseTool); Enter is harmless. */
export const EXIT_PLAN = "ExitPlanMode";
export const ASK_USER = "AskUserQuestion";
const ENTER_PLAN = "EnterPlanMode";
/** The guard lets these through; the approval flow (not the guard) decides on them. */
export const PLAN_FLOW_TOOLS: ReadonlySet<string> = new Set([EXIT_PLAN, ASK_USER, ENTER_PLAN]);

/** Built-in tools of each capability. */
const CAPABILITY_TOOLS: Record<Capability, readonly string[]> = {
  read: ["Read", "Glob", "Grep"],
  write: ["Write", "Edit"],
  shell: ["Bash"],
  web: ["WebSearch", "WebFetch"],
  skills: ["Skill"],
  subagents: ["Agent"],
  tasks: ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "ToolSearch"],
  ask: [ASK_USER],
  planControl: [EXIT_PLAN, ENTER_PLAN],
};

/** Capabilities of a code task. Plan and execute stages share them: the guard narrows what a call may do. */
const CODE_CAPABILITIES: readonly Capability[] = [
  "read",
  "write",
  "shell",
  "skills",
  "subagents",
  "tasks",
  "ask",
  "planControl",
];

/** The owner-approved matrix: which capabilities each mode has. */
const MODE_CAPABILITIES: Record<ToolMode, readonly Capability[]> = {
  qa: ["read", "web", "skills", "subagents"],
  plan: CODE_CAPABILITIES,
  exec: CODE_CAPABILITIES,
};

/** Tools that run without asking anyone (the other tools go through path/policy checks or the owner). */
const AUTO_ALLOWED = new Set<string>([
  ...CAPABILITY_TOOLS.web,
  ...CAPABILITY_TOOLS.skills,
  ...CAPABILITY_TOOLS.tasks,
  ENTER_PLAN,
]);

/** Built-in tools of a mode (the SDK `tools` option). */
export const toolsFor = (mode: ToolMode): string[] =>
  MODE_CAPABILITIES[mode].flatMap((c) => CAPABILITY_TOOLS[c]);

/** Tools of a mode that need no approval (the guard's `allowTools`). */
export const autoAllowedTools = (mode: ToolMode): string[] =>
  toolsFor(mode).filter((t) => AUTO_ALLOWED.has(t));

/* ---------------- git MCP tools (@cyanheads/git-mcp-server 2.15.3) ---------------- */

/** Git MCP tools by purpose. */
export const GIT_GROUPS = {
  /** Pure reads, allowed on the worktree and on registered repos. */
  read: ["git_status", "git_diff", "git_log", "git_show", "git_blame"],
  /** Staging and committing: the task worktree only. */
  commit: ["git_add", "git_commit"],
  /** Moves HEAD / the index: the worktree only, owner is asked. */
  change: ["git_checkout", "git_reset"],
} as const;

/**
 * Tools visible in every mode that are reads only in some `mode` values (an absent mode is the server's
 * default: list). The guard derives its check from this table: tool -> read-only modes.
 */
export const GIT_READ_BY_MODE: Record<string, readonly string[]> = {
  git_branch: ["list", "show-current"],
};

/** Every tool of the server. Agents never get push/pull/fetch/clone/worktree/...: the app calls those. */
const ALL_GIT_TOOLS: readonly string[] = [
  ...Object.values(GIT_GROUPS).flat(),
  ...Object.keys(GIT_READ_BY_MODE),
  ...["git_changelog_analyze", "git_cherry_pick", "git_clean", "git_clear_working_dir"],
  ...["git_clone", "git_fetch", "git_init", "git_merge", "git_pull", "git_push", "git_rebase"],
  ...["git_reflog", "git_remote", "git_set_working_dir", "git_stash", "git_tag", "git_worktree"],
  "git_wrapup_instructions",
];

/** Git tool groups each mode may use (plus the by-mode reads, always). */
const MODE_GIT_GROUPS: Record<ToolMode, readonly (keyof typeof GIT_GROUPS)[]> = {
  qa: ["read"],
  plan: ["read"],
  exec: ["read", "commit", "change"],
};

/** Git MCP tools a mode may see. */
export const gitToolsFor = (mode: ToolMode): string[] => [
  ...MODE_GIT_GROUPS[mode].flatMap((g) => GIT_GROUPS[g]),
  ...Object.keys(GIT_READ_BY_MODE),
];

/** Git MCP tools to hide from a mode (`mcp__git__…`): a shorter tool list and a second lock behind the guard. */
export const hiddenGitTools = (mode: ToolMode): string[] => {
  const allowed = new Set<string>(gitToolsFor(mode));
  return ALL_GIT_TOOLS.filter((t) => !allowed.has(t)).map((t) => `mcp__git__${t}`);
};

/* ---------------- SDK options + subagents ---------------- */

/**
 * Scoped deny rules for secret files (documented: disallowedTools accepts `Tool(pattern)` rules
 * that are denied in every permission mode). Backstop for the prompt rule; redaction is the other.
 */
export const SECRET_FILE_RULES = [
  "Read(**/.env*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(**/id_rsa*)",
  "Read(**/credentials*)",
];

/**
 * SDK options fragment for a mode, derived from this catalog. ONLY `tools` restricts the built-in set
 * (we trust the SDK for that, verified per mode with the real SDK); `allowedTools` would auto-approve and
 * bypass canUseTool, so it is never used. `disallowedTools` only carries what `tools` cannot express: the
 * path-scoped secret-file rules and the git MCP tools of other modes.
 */
export function toolOptions(mode: ToolMode) {
  return {
    tools: toolsFor(mode),
    disallowedTools: [...hiddenGitTools(mode), ...SECRET_FILE_RULES],
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
    tools: ["Read", "Glob", "Grep"],
  },
};

/** Names for the guard's Agent-tool allowlist. */
export const SUBAGENT_NAMES = Object.keys(SUBAGENTS);
