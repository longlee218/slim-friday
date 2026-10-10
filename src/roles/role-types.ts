import type { ModelTier, TaskClass } from "../config/model-routing";
import type { Workflow } from "../repos/repo-registry";
import type { GIT_GROUPS } from "../tools/git-tool-groups";

/** A group of tools that belong together; a stage lists the groups it may use. */
export type Capability =
  | "read" // look at files
  | "write" // change files (paths limited by the guard)
  | "shell" // Bash (policy + owner approval)
  | "web" // search / fetch
  | "skills"
  | "subagents" // Agent: only the subagents named by the stage (guard)
  | "tasks" // progress tracking
  | "ask" // AskUserQuestion: answered by the owner through Discord buttons
  | "planControl"; // enter / leave plan mode (leaving needs the owner's approval)

/** What the role hands back to the owner (the engine picks the output module from it). */
export type OutputContract = "answer" | "plan" | "pr" | "verdict";

/**
 * Owner gate that follows a stage (closed set, each implemented once in `orchestrator/engine/gates.ts`):
 * `none` runs straight on, `plan-approval` waits for the owner to approve the plan, `delivery` offers the
 * result (the PR) to the owner, `owner-confirm` asks a yes/no before a costlier step (vocabulary only: no
 * stage uses it yet, the engine fails closed on it).
 */
export type Gate = "none" | "plan-approval" | "delivery" | "owner-confirm";

/**
 * Where a stage runs: `none` = no isolation (registered repos read-only, or the task scratch dir); `clone` =
 * an isolated checkout on its own branch. Today `clone` is the git worktree path; Part 2 swaps the
 * implementation without touching roles.
 */
export type Isolation = "none" | "clone";

/**
 * What a stage hands on to the next one, as data. `template` words the next stage's prompt; `{plan}`,
 * `{planPath}`, `{task}` and `{testLine}` are replaced in ONE pass (text inserted is never re-expanded).
 */
export interface StageHandoff {
  /** File name the approved plan is saved under in the task scratch dir. */
  planFile: string;
  template: string;
}

/** Run-time facts a stage needs to word its prompt. */
export interface PromptCtx {
  /** Plan/exec: `full` adds the repo-workflow rules. */
  workflow?: Workflow;
  /** Answer output on the cheap tier: adds the `ESCALATE: sonnet|opus` rule (never on an already escalated run). */
  escalation?: boolean;
}

/** One run of a role: WHAT it may do (tools, git, prompt, limits). HOW stages chain is the orchestrator's job. */
export interface StageDefinition {
  /** Stage name: the log `mode` value and the registry key (unique across roles, e.g. "qa", "plan", "exec"). */
  name: string;
  /** Built-in tools (and the guard's auto-allow list) derive from these. */
  capabilities: Capability[];
  /** Git MCP tool groups the stage may use (read-only by-mode tools are always visible). */
  gitGroups: (keyof typeof GIT_GROUPS)[];
  /** SDK permission mode; only the plan stage uses `plan` (ExitPlanMode lives there). */
  permissionMode?: "plan";
  /** Where the stage runs. Omitted = `none`. */
  isolation?: Isolation;
  /** Owner gate that follows the stage. Omitted = `none`. */
  gate?: Gate;
  /** What this stage hands on to the next one (the plan stage of a role whose next stage starts from it). */
  handoff?: StageHandoff;
  /** Prompt sections between the run contract start and the COMMON safety rules. */
  promptSections: (ctx: PromptCtx) => string[];
  /** Default model: a tier name (`haiku|sonnet|opus`) or an explicit model id. Class and effort may override it. */
  model: ModelTier | (string & {});
  /** Default budget (USD) of one run of this stage (env BUDGET_<ROLE>_<STAGE>_USD overrides). */
  budgetUsd: number;
  /** Tier per task class (mechanical|standard|design) for stages whose model depends on the class. Omitted = `model`. */
  classTiers?: Record<TaskClass, ModelTier>;
  /** OpenRouter only (tiers are not used there): model of this stage unless an env pin or nothing is set. Omitted = the config default. */
  openrouterModel?: string;
  /** Budget of an escalated re-run of this stage (`answer` output only). Omitted = `budgetUsd`. */
  escalatedBudgetUsd?: number;
  /** Minimum run timeout (stages with owner gates wait for approvals). Omitted = config timeout. */
  timeoutMs?: number;
  /** Subagent names (from the subagent registry) the Agent tool may start. Omitted = none (fail closed). */
  subagents?: string[];
}

/**
 * Direct-route words of a role. `tag` is the message prefix that always wins (`[dev]`); `strong` phrases decide
 * when EXACTLY ONE role matches; `weak` phrases count only on an idle thread. Written with diacritics (the intent
 * layer normalizes them). The same strong phrase in two roles is a startup error.
 */
export interface RoleAliases {
  tag: string;
  strong: string[];
  weak?: string[];
}

/** A named job the agent can do: a short chain of stages. */
export interface RoleDefinition {
  name: string;
  /** Mutually exclusive wording; the intent layer reads it from the registry (P1.4c). */
  whenToUse: string;
  /** Words the owner uses to reach this role directly (intent layer L3, P1.4c); omitted = never routed by alias. */
  aliases?: RoleAliases;
  /** What the role hands back: picks the output module (`answer` escalation, `pr` delivery). */
  output: OutputContract;
  /** Runs of this role count toward the concurrent task cap (checked by the dispatcher). */
  countsTowardCap: boolean;
  /** The cheap-tier answer may end in `ESCALATE: sonnet|opus` and be re-run on that tier (`answer` output). */
  escalation?: boolean;
  /** A follow-up message in a thread that already has this role's clone starts at this stage (name), not at the first. */
  followUp?: { startAtStage: string };
  /** The role a plain message starts, until the intent layer picks one (exactly one role sets it). */
  entry?: boolean;
  /** Extra context the role's runs get. Omitted = none. */
  context?: {
    /** On an idle thread the run sees the thread's task ledger (earlier staged tasks). */
    ledger?: boolean;
  };
  /** Repos the run sees: `all` = every repo of the workspace (read-only roles); `candidates` = the managed clones the plan may pick from. Omitted = `candidates`. */
  repoScope?: "all" | "candidates";
  stages: StageDefinition[];
}
