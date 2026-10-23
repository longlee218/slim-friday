import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** A group of tools that belong together; a role lists the groups it may use. */
export type Capability =
  | "read" // look at files
  | "write" // change files: Write, Edit, MultiEdit, NotebookEdit (paths limited by the guard)
  | "shell" // Bash (bounded by the OS sandbox of the run)
  | "web" // search / fetch
  | "skills"
  | "subagents" // Agent + SendMessage + ListAgents: the SDK's own built-in subagent; every role gets them unless `noSubagents` (toolsFor)
  | "tasks" // progress tracking; TaskStop (stops a worker task) needs the owner
  | "mcp" // MCP resource reads (+ refresh of the app's own MCP servers)
  | "review" // ReportFindings: SDK built-in tool that reports review findings
  | "feedback" // SendFeedback: sends a report to Anthropic, always owner-approved
  | "ask"; // AskUserQuestion: answered by the owner through Discord buttons

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
  /** Mutually exclusive wording; the teammate's TEAM.md, the teammate reads it from the registry. */
  whenToUse: string;
  /**
   * Work that looks like this role's but is not (and where it goes instead): the "Not for" column of the teammate's TEAM
   * table reads it, so routing between roles is role data, not prompt text. Every
   * dispatchable role has one (test).
   */
  notFor?: string;
  /**
   * What the role is. `worker` = a detached task: its run counts toward the concurrent task cap, takes a start notice,
   * is queued behind a busy thread, works in a location, and the owner steers it. `teammate` = the thread's router (a short
   * foreground answer, reached only through the teammate runner).
   */
  kind: "teammate" | "worker";
  /** Skills the role gets (see `RoleSkills`). Omitted = `[]`. */
  skills?: RoleSkills;
  /**
   * Names (a subset of `skills`) whose SKILL.md text is added to the system prompt, so the method is always in front of
   * the run and does not depend on the model calling the Skill tool. Their `references/` stay on demand. Omitted = none.
   */
  preloadSkills?: RoleSkills;
  /**
   * Names (a subset of `skills`) the role calls with the Skill tool before its first edit or command, unconditionally.
   * The run's prompt names them in one generated line (the data is not repeated in contracts). Omitted = none.
   */
  requiredSkills?: RoleSkills;
  /** No SDK subagent tools (Agent, SendMessage, ListAgents): not offered and denied by the guard. The on/off switch of `subagents`. Omitted = allowed. */
  noSubagents?: boolean;
  /** Subagent bounds of a run: `parallel` = most subagents running at once (the guard denies the next start), `depth` = nesting levels (>= 1; 1 = a subagent has no Agent tool). Only used when `noSubagents` is not set. */
  subagents: { parallel: number; depth: number };
  /** The teammate may dispatch this role as a worker (`Orchestrate dispatch`); TEAM.md lists these roles. Omitted = not dispatchable. */
  dispatchable?: boolean;
  /**
   * Bare names of the in-process MCP tools the role gets (from each tool's `constants.ts`). A run builds only these,
   * and only when it has the tool's ctx part; the guard denies every other `mcp__*` tool. Omitted = none.
   */
  mcpTools?: string[];
  /** Limits of one run: agent loops (SDK turns, `maxTurns`). Owner questions have no count: the `ask` capability is the only switch. */
  limits: { maxTurns: number };
  /** Fixed model id of the role's runs (a full id, e.g. `claude-sonnet-5-5`; see `config/model-ids.ts`). Changing it is a data edit. */
  model: string;
  /** Fixed SDK thinking config of the role's runs (`{ type: "adaptive" }`, `{ type: "disabled" }`, ...). Omitted = the SDK default. */
  thinking?: Options["thinking"];
  /** Default budget (USD) of one run; capped by the task ceiling and env MAX_BUDGET_USD. */
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
   * Data for the teammate and the outcome check. Authorization stays in the guards.
   */
  sideEffects: "none" | "location" | "external";
  /**
   * Base of the role's system prompt: `custom` = our text alone (a role that writes no code: the SDK's coding, terminal and
   * file-memory guidance would compete with it); omitted = the SDK `claude_code` preset with our text appended (a coding role).
   */
  basePrompt?: "custom";
  /** Built-in tools (and the guard's auto-allow list) derive from these. */
  capabilities: Capability[];
  /**
   * Pinned native binaries (names in `config/data/pinned-binaries.yaml`) the role's shell may run: a dispatched run gets
   * each verified file's env var and the sandbox lets the shell read (not write) it. Omitted = none.
   */
  binaries?: string[];
  /** Prompt sections between the run contract start and the COMMON safety rules. */
  promptSections: () => string[];
}
