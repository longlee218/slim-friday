import type { Database } from "bun:sqlite";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { ceilingBinds, type Route } from "../config/model-routing";
import { workspacePaths } from "../config/workspace-paths";
import type { GuardrailContext } from "../guardrails/check-tool-call";
import { logEvent, logger } from "../observability/logger";
import {
  emptyUsage,
  type RunOutcome,
  RunRecorder,
  type RunUsage,
} from "../observability/record-run";
import type { Workflow } from "../repos/repo-registry";
import type { RoleDefinition } from "../roles/role-types";
import { type ModeActive, resolvePermissionMode } from "./permission-mode";
import { createPermissionWatch } from "./permission-watch";
import type { SteerHook } from "./run-input-channel";
import { consumeStream, type QueryFn, type StreamResult } from "./run-stream";
import { buildSdkOptions, roleConfig } from "./sdk-options";
import { NO_SKILLS, type RunSkills } from "./skills-plugin/plugin-builder";
import { buildRoleSkills } from "./skills-plugin/role-skills";
import { consumeSteered } from "./steered-stream";
import type { ToolPermissionInput } from "./tool-permissions";

export type { QueryFn };

/** Inputs for one agent run. */
export interface RunAgentInput {
  /** User question sent to the agent. */
  prompt: string;
  /** Task id; names the per-task JSONL and tags logs. */
  turnId: string;
  /** Repo directory the agent runs in. */
  cwd: string;
  /** Extra repo directories the agent may read (multi-repo registry). */
  additionalDirectories?: string[];
  /** Extra prompt context blocks (persona, registry, memory...); empty ones are dropped, the rest joined once. */
  extraContext?: string[];
  /** Guardrails of the run (paths, git repos, allowed tools). Every mode has one; omitted only in unit tests. */
  guard?: GuardrailContext;
  /** The role to run: its tools, model slot, permission mode and prompt. */
  role: RoleDefinition;
  /** Permission layer of the run (gateway, ask limit). Omitted = a run without a gateway (ask = deny). */
  code?: Omit<ToolPermissionInput, "turnId" | "guard">;
  /** `full` repo workflow (the repo, or some repo in scope, is full): adds its rules to the prompt. */
  workflow?: Workflow;
  /** Where the agent may put a git worktree (`<workspace worktrees dir>/<repo>`), told in one prompt line. */
  worktreesDir?: string;
  /** Workspace whose curated skills dir the run may use, via an app-owned plugin copy (never repo content). */
  skillsWorkspace?: string;
  /** Routing facts (class, effort, forced tier, escalation); omitted = the role defaults. */
  route?: Route;
  /** Existing Claude session id to resume. */
  resume?: string;
  /**
   * Streaming-input mode (background roles): the prompt goes in as the first item of an input channel whose
   * sink is registered here, so the owner's later messages reach the model. Omitted = a plain string prompt.
   */
  steer?: SteerHook;
  config: AgentConfig;
  /** sqlite handle for runs/tool_calls rows. */
  db: Database;
  /** Caller keeps this to support `stop`; runAgent adds the timeout to it. */
  abortController: AbortController;
  /** Override the SDK query (tests). */
  queryFn?: QueryFn;
}

/** Result of one agent run. */
export interface RunAgentResult {
  /** Reply text (answer, or error description). */
  text: string;
  /** Claude session id, when the SDK reported one. */
  sessionId: string | undefined;
  /** How the run ended. */
  outcome: RunOutcome;
  /** Token/cost/time metrics. */
  usage: RunUsage;
  /** Budget (USD) this run was capped at; undefined = no cap. Read by the budget-hit message. */
  budgetUsd?: number;
  /** The task ceiling (TASK_BUDGET_USD minus the task's earlier spend), not the role budget, was the cap of this run. */
  ceilingBound?: boolean;
  /** What the task's earlier runs already cost (USD), for the budget-hit message's raise offer. */
  spentBeforeUsd?: number;
  /** Quota outcome: when the limit resets (epoch ms), if the SDK reported it. */
  resetsAt?: number;
  /** Last thing the assistant said (text of its last message with text); the budget-hit message shows it. */
  lastText?: string;
}

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-agent" });

/** Run the agent once (an answer, or a code task: the role says), recording messages, tool calls and the run row. */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { abortController: ac } = input;
  // The role definition decides tools, model slot, permission mode and prompt.
  const { role } = input;
  const config = roleConfig(role, input.config, input.route);
  // OpenRouter without a real key would only retry on 401 until timeout: fail fast instead.
  if (config.provider === "openrouter" && !config.hasRealAuth) {
    log.error("OPENROUTER_API_KEY missing or placeholder");
    return {
      text: "Agent error: OpenRouter API key not configured",
      sessionId: undefined,
      outcome: "error",
      usage: emptyUsage(),
    };
  }
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const recorder = new RunRecorder(
    input.db,
    runId,
    input.turnId,
    config.model,
    workspacePaths(config.agentHome).taskLog(input.turnId),
  );
  const run = input.queryFn ?? (sdkQuery as QueryFn);

  // No run timeout (owner): a run ends by its result, the budget, the turn ceiling or an abort (/stop, shutdown).

  let res: StreamResult = { text: "", sessionId: undefined, outcome: "error", usage: emptyUsage() };
  // Workspace skills plugin (fail closed, never throws); built inside the try so `finally` always removes it.
  let sk: RunSkills = NO_SKILLS;

  try {
    sk = buildRoleSkills(role, input.skillsWorkspace, config.agentHome);
    // Auto mode is requested here and confirmed by the SDK init message (permission-watch.ts).
    const requestedMode = resolvePermissionMode(role, config);
    const autoState: ModeActive = { active: requestedMode === "auto" };
    const bypassState: ModeActive = { active: requestedMode === "bypassPermissions" };
    const options = buildSdkOptions(role, input, {
      config,
      recorder,
      skills: sk,
      autoState,
      bypassState,
    });
    logEvent(log, "run.started", {
      model: config.model,
      provider: config.provider,
      cwd: input.cwd,
      resume: !!input.resume,
      tools: Array.isArray(options.tools) ? options.tools.length : undefined,
      mcpServers: Object.keys(options.mcpServers ?? {}),
    });
    if (input.resume) logEvent(log, "session.resumed", { sessionId: input.resume });
    // Streaming input (steer): the channel, its registration and the step-7 wait live in steered-stream.ts.
    const common = {
      run,
      options,
      recorder,
      ac,
      db: input.db,
      turnId: input.turnId,
      cwd: input.cwd,
      permissionWatch: createPermissionWatch(requestedMode, autoState, bypassState),
    };
    res = input.steer
      ? await consumeSteered({ ...common, first: input.prompt, hook: input.steer, runId })
      : await consumeStream({ ...common, prompt: input.prompt });
  } finally {
    sk.cleanup();
    recorder.finish(res.outcome, res.usage);
    recorder.close();
  }
  const { text, sessionId, outcome, usage, resetsAt, lastText } = res;
  // `usage` is the main agent's tokens; `costUsd` is the total cost (all agents); `modelUsage` splits both per model.
  logEvent(log, "run.finished", { outcome, ...usage, durationMs: Date.now() - startedAt });
  return {
    text,
    sessionId,
    outcome,
    usage,
    resetsAt,
    lastText,
    budgetUsd: config.limits.maxBudgetUsd,
    ceilingBound: ceilingBinds(config.limits.maxBudgetUsd, input.route?.spentUsd),
    spentBeforeUsd: input.route?.spentUsd,
  };
}
