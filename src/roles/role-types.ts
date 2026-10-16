import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** A group of tools that belong together; a role lists the groups it may use. */
export type Capability =
  | "read" // look at files
  | "write" // change files: Write, Edit, MultiEdit, NotebookEdit (paths limited by the guard)
  | "shell" // Bash and Monitor (policy + owner approval)
  | "web" // search / fetch
  | "skills"
  | "subagents" // Agent + SendMessage + ListAgents: the SDK's own built-in subagent; EVERY role gets them (toolsFor)
  | "tasks" // progress tracking; TaskStop (stops a background task) needs the owner
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
  /** Mutually exclusive wording; the lead's LEAD.md, the planner and the outcome check read it from the registry. */
  whenToUse: string;
  /**
   * Background role: a task. Its run counts toward the concurrent task cap, takes a start notice, is queued behind a
   * busy thread, and works in a location; the owner steers it. Not background = a short foreground answer (plus the side lane).
   */
  background: boolean;
  /** Skills the role gets (see `RoleSkills`). Omitted = `[]`. */
  skills?: RoleSkills;
  /**
   * Where the role runs: `control` = only in the owner's #ops-control channel, with no workspace; `lead` = reached only
   * through the lead (the lead itself, or a worker it dispatches). Omitted = neither.
   */
  surface?: "control" | "lead";
  /** No SDK subagent tools (Agent, SendMessage, ListAgents): not offered and denied by the guard. Lead and workers set it (depth 1). Omitted = allowed. */
  noSubagents?: boolean;
  /** Shell of a role with the `shell` capability: `read` = read-only commands only (allowlist class R0, fail closed). Omitted = the full shell policy (a worker with an envelope gets the R0 + R1 allowlist). */
  shellMode?: "read";
  /** The lead may dispatch this role as a worker (`DispatchAgent`); LEAD.md lists these roles. Omitted = not dispatchable. */
  dispatchable?: boolean;
  /** In-process app MCP servers the role gets (names in `APP_MCP_TOOLS`; the caller supplies the instances). Omitted = none. */
  mcpServers?: string[];
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
