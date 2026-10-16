import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** A group of tools that belong together; a role lists the groups it may use. */
export type Capability =
  | "read" // look at files
  | "write" // change files: Write, Edit, MultiEdit, NotebookEdit (paths limited by the guard)
  | "shell" // Bash (bounded by the OS sandbox of the run)
  | "web" // search / fetch
  | "skills"
  | "subagents" // Agent + SendMessage + ListAgents: the SDK's own built-in subagent; EVERY role gets them (toolsFor)
  | "tasks" // progress tracking; TaskStop (stops a worker task) needs the owner
  | "mcp" // MCP resource reads (+ refresh of the app's own MCP servers)
  | "feedback" // SendFeedback: sends a report to Anthropic, always owner-approved
  | "ask"; // AskUserQuestion: answered by the owner through Discord buttons

/** Run-time facts a role needs to word its prompt. */
export interface PromptCtx {
  /** Where the agent puts a git worktree it creates (`<workspace worktrees dir>/<location>`); omitted = no line. */
  worktreesDir?: string;
}

/**
 * Skills of a role: bare names of installed skills (`.agents/skills/<name>`, pinned by the skills lock); exactly those
 * load (a name not installed is skipped). `[]` = none of them (the workspace's curated skills still load). Widening or
 * narrowing a role is a data edit.
 */
export type RoleSkills = string[];

/**
 * A named job the agent can do. ONE role run = ONE agent run: what it may do (tools, git, prompt, limits) is flat data
 * here, so a config file can replace the TS object later. HOW the agent works (brainstorm, plan, owner approval,
 * implement, deliver) comes from its skills and context: no code enforces an order.
 */
export interface RoleDefinition {
  /** Role name: the registry key and the log `mode` value. */
  name: string;
  /** Mutually exclusive wording; the lead's LEAD.md, the lead and the planner read it from the registry. */
  whenToUse: string;
  /**
   * What the role is. `worker` = a detached task: its run counts toward the concurrent task cap, takes a start notice,
   * is queued behind a busy thread, works in a location, and the owner steers it. `lead` = the thread's router (a short
   * foreground answer, reached only through the lead runner). `control` = the #ops-control role (no workspace).
   */
  kind: "lead" | "worker" | "control";
  /** Skills the role gets (see `RoleSkills`). Omitted = `[]`. */
  skills?: RoleSkills;
  /** No SDK subagent tools (Agent, SendMessage, ListAgents): not offered and denied by the guard. Lead and workers set it (depth 1). Omitted = allowed. */
  noSubagents?: boolean;
  /** The lead may dispatch this role as a worker (`DispatchAgent`); LEAD.md lists these roles. Omitted = not dispatchable. */
  dispatchable?: boolean;
  /**
   * Bare names of the in-process MCP tools the role gets (from each tool's `constants.ts`). A run builds only these,
   * and only when it has the tool's ctx part; the guard denies every other `mcp__*` tool. Omitted = none.
   */
  mcpTools?: string[];
  /** Limits of one run: AskUserQuestion calls (enforced in the permission guard). */
  limits: { maxAsk: number };
  /** Fixed model id of the role's runs (a full id, e.g. `claude-sonnet-5-5`; see `config/model-ids.ts`). Changing it is a data edit. */
  model: string;
  /** Fixed SDK thinking config of the role's runs (`{ type: "adaptive" }`, `{ type: "disabled" }`, ...). Omitted = the SDK default. */
  thinking?: Options["thinking"];
  /** Default budget (USD) of one run (env BUDGET_<ROLE>_USD overrides). */
  budgetUsd: number;
  /**
   * Streaming input: the run takes the owner's later messages while it works ("steer"). Omitted = a string prompt, no
   * steer (a short answer). Data, so any role can opt in; the engine reads no role name.
   */
  streaming?: boolean;
  /**
   * SDK permission mode: `auto` (the classifier decides what the guard leaves open; resolved against availability in
   * `resolvePermissionMode`); `bypassPermissions` (the SDK asks nothing; only the guard's hard denies stop a call).
   */
  permissionMode?: "auto" | "bypassPermissions";
  /**
   * What the role may change: `none` (answers only), `location` (files / git of a checkout), `external` (outside systems).
   * Data for the lead, the planner and the outcome check. Authorization stays in the guards.
   */
  sideEffects: "none" | "location" | "external";
  /** Built-in tools (and the guard's auto-allow list) derive from these. */
  capabilities: Capability[];
  /**
   * Override of the app default compaction window (tokens, CLAUDE_CODE_AUTO_COMPACT_WINDOW; default
   * `COMPACT_WINDOW_TOKENS` in runtime/sdk-env.ts). Omitted = the app default. The 75% share applies to it.
   */
  autoCompactWindow?: number;
  /** Prompt sections between the run contract start and the COMMON safety rules. */
  promptSections: (ctx: PromptCtx) => string[];
}
