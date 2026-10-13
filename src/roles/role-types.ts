import type { ModelTier, TaskClass } from "../config/model-routing";
import type { Workflow } from "../repos/repo-registry";
import type { GIT_GROUPS } from "../tools/git-tool-groups";

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
  /** `full` adds the repo-workflow rules. */
  workflow?: Workflow;
  /** Where the agent puts a git worktree it creates (`<workspace worktrees dir>/<repo>`); omitted = no line. */
  worktreesDir?: string;
  /** Answer run on a cheaper tier: the tiers the `ESCALATE: <tier>` rule offers (empty/omitted = no rule; never on an escalated run). */
  escalationTiers?: ("sonnet" | "opus")[];
}

/**
 * Publisher skills of a role: `all` = every installed publisher skill (the skills lock + dirs on disk decide, no names in
 * code), `none` = the workspace's own curated skills only. Widening or narrowing a role is a one-word edit.
 */
export type RoleSkills = "all" | "none";

/**
 * A named job the agent can do. ONE role run = ONE agent run: what it may do (tools, git, prompt, limits) is flat data
 * here, so a config file can replace the TS object later. HOW the agent works (brainstorm, plan, owner approval,
 * implement, deliver) comes from its skills and context: no code enforces an order.
 */
export interface RoleDefinition {
  /** Role name: the registry key and the log `mode` value. */
  name: string;
  /** Mutually exclusive wording; the intent layer reads it from the registry (P1.4c). */
  whenToUse: string;
  /**
   * Explicit role tag (`[dev]`): a message that STARTS with it goes to this role (intent layer L1) and the tag is
   * stripped from the brief. Case-insensitive, unique across roles (startup error otherwise); omitted = no tag.
   */
  tag?: string;
  /**
   * Background role: a task. Its run counts toward the concurrent task cap, takes a start notice, is queued behind a
   * busy thread, and works in a repo; the owner steers it. Not background = a short foreground answer (plus the side lane).
   */
  background: boolean;
  /** The role a plain message starts, until the intent layer picks one (exactly one role sets it). */
  entry?: boolean;
  /** The cheap-tier answer may end in `ESCALATE: sonnet|opus` and be re-run on that tier. */
  escalation?: boolean;
  /** Extra context the role's runs get. Omitted = none. */
  context?: {
    /** On an idle thread the run sees the thread's task ledger (earlier tasks). */
    ledger?: boolean;
  };
  /** Repos the run sees: `all` = every repo of the workspace; `candidates` = the workspace repos or the one the owner named. Omitted = `candidates`. */
  repoScope?: "all" | "candidates";
  /** Publisher skills the role gets (see `RoleSkills`). Omitted = `none`. */
  skills?: RoleSkills;
  /** Limits of one run: AskUserQuestion calls (enforced in the permission guard). */
  limits: { maxAsk: number };
  /** Default model: a tier name (`haiku|sonnet|opus`) or an explicit model id. Class and effort may override it. */
  model: ModelTier | (string & {});
  /** Tier per task class (mechanical|standard|design) for roles whose model depends on the class. Omitted = `model`. */
  classTiers?: Record<TaskClass, ModelTier>;
  /** OpenRouter only (tiers are not used there): model of this role unless an env pin or nothing is set. Omitted = the config default. */
  openrouterModel?: string;
  /** Default budget (USD) of one run (env BUDGET_<ROLE>_USD overrides). */
  budgetUsd: number;
  /** Budget of an escalated re-run (`escalation` roles only). Omitted = `budgetUsd`. */
  escalatedBudgetUsd?: number;
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
  /** Built-in tools (and the guard's auto-allow list) derive from these. */
  capabilities: Capability[];
  /** Git MCP tool groups the role may use (read-only by-mode tools are always visible). */
  gitGroups: (keyof typeof GIT_GROUPS)[];
  /**
   * Override of the app default compaction window (tokens, CLAUDE_CODE_AUTO_COMPACT_WINDOW; default
   * `COMPACT_WINDOW_TOKENS` in runtime/sdk-env.ts). Omitted = the app default. The 75% share applies to it.
   */
  autoCompactWindow?: number;
  /** Prompt sections between the run contract start and the COMMON safety rules. */
  promptSections: (ctx: PromptCtx) => string[];
}
