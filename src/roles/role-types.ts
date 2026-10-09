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
  | "planControl" // enter / leave plan mode (leaving needs the owner's approval)
  | "recommend"; // DelegateTask handoff tool; removed when the intent layer lands (P1.4c)

/** What the role hands back to the owner. */
export type OutputContract = "answer" | "report" | "verdict" | "pr";

/** Run-time facts a stage needs to word its prompt. */
export interface PromptCtx {
  /** Plan/exec: `full` adds the repo-workflow rules. */
  workflow?: Workflow;
  /** The handoff tool is registered in this run: adds the HANDOFF section (stages with `recommend` only). */
  handoff?: boolean;
}

/** One run of a role: WHAT it may do (tools, git, prompt, limits). HOW stages chain is the orchestrator's job. */
export interface StageDefinition {
  /** Log `mode` value and registry key: "qa" | "plan" | "exec". */
  name: string;
  /** Built-in tools (and the guard's auto-allow list) derive from these. */
  capabilities: Capability[];
  /** Git MCP tool groups the stage may use (read-only by-mode tools are always visible). */
  gitGroups: (keyof typeof GIT_GROUPS)[];
  /** SDK permission mode; only the plan stage uses `plan` (ExitPlanMode lives there). */
  permissionMode?: "plan";
  /** Where the stage runs: today's git worktree for exec; Part 2 swaps it for a clone; read by the Part 2 isolation step. */
  isolation?: "none" | "worktree";
  /** Owner gate that follows the stage. */
  gate?: "plan-approval" | "delivery";
  /** Prompt sections between the run contract start and the COMMON safety rules. */
  promptSections: (ctx: PromptCtx) => string[];
  /** Model slot: "default" = config.model, "code" = config.codeModel. */
  model?: "default" | "code";
  /** Minimum run timeout (code stages wait for owner approvals). Omitted = config timeout. */
  timeoutMs?: number;
  /** Subagent names (from the subagent registry) the Agent tool may start. Omitted = none (fail closed). */
  subagents?: string[];
}

/** A named job the agent can do: a short chain of stages. */
export interface RoleDefinition {
  name: string;
  /** Mutually exclusive wording; the intent layer reads it from the registry (P1.4c). */
  whenToUse: string;
  /** True when the intent `class` picks a model tier for this role (P1.3b). */
  modelTiers?: boolean;
  /** Read by the orchestrator in a later phase (not yet consumed). */
  output: OutputContract;
  /** Runs of this role count toward the concurrent code-task cap. */
  /** Read by the orchestrator in a later phase (concurrent-task cap; not yet consumed). */
  countsTowardCap: boolean;
  readOnly: boolean;
  stages: StageDefinition[];
}
