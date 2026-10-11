import type { Database } from "bun:sqlite";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import type { Route } from "../config/model-routing";
import { workspacePaths } from "../config/workspace-paths";
import type { GuardrailContext } from "../guardrails/check-tool-call";
import type { GitIdentity } from "../mcp/git-mcp";
import { logEvent, logger } from "../observability/logger";
import {
  emptyUsage,
  type RunOutcome,
  RunRecorder,
  type RunUsage,
} from "../observability/record-run";
import type { Workflow } from "../repos/repo-registry";
import type { StageDefinition } from "../roles/role-types";
import { type ModeActive, resolvePermissionMode } from "./permission-mode";
import { createPermissionWatch } from "./permission-watch";
import type { SteerHook } from "./run-input-channel";
import { consumeStream, type QueryFn, type StreamResult } from "./run-stream";
import { buildSdkOptions, stageConfig, stageTimeoutMs } from "./sdk-options";
import { consumeSteered } from "./steered-stream";
import type { ToolPermissionInput } from "./tool-permissions";
import { type RunSkills, workspaceSkills } from "./workspace-skills-plugin";

export type { QueryFn };

/** Inputs for one agent run. */
export interface RunAgentInput {
  /** User question sent to the agent. */
  prompt: string;
  /** Task id; names the per-task JSONL and tags logs. */
  taskId: string;
  /** Repo directory the agent runs in. */
  cwd: string;
  /** Extra repo directories the agent may read (multi-repo registry). */
  additionalDirectories?: string[];
  /** Extra prompt context blocks (persona, registry, memory...); empty ones are dropped, the rest joined once. */
  extraContext?: string[];
  /** Guardrails of the run (paths, git repos, allowed tools). Every mode has one; omitted only in unit tests. */
  guard?: GuardrailContext;
  /** Commit identity of the agent's git MCP server (execute stage): every commit is made as this user. */
  gitAuthor?: GitIdentity;
  /** Directory tree the agent's git MCP server is sandboxed to (execute stage: the worktree). */
  gitBaseDir?: string;
  /** GitHub login whose token the read-only GitHub MCP server uses (code tasks); default = active gh account. */
  githubAccount?: string;
  /** The stage to run: its tools, model slot, permission mode, timeout and prompt. */
  stage: StageDefinition;
  /** Permission layer of a gated stage (gateway, plan, ask limits). Omitted = a stage without a gateway (ask = deny). */
  code?: Omit<ToolPermissionInput, "taskId" | "guard">;
  /** `full` repo workflow (plan: some candidate repo is full; exec: the repo is): adds its rules to the prompt. */
  workflow?: Workflow;
  /** Workspace whose curated skills dir the run may use, via an app-owned plugin copy (never repo content). */
  skillsWorkspace?: string;
  /** Routing facts (class, effort, forced tier, escalation); omitted = the stage defaults. */
  route?: Route;
  /** Index of the stage this run executes (written to runs.stage_idx); omitted for non-stage runs. */
  stageIdx?: number;
  /** Existing Claude session id to resume. */
  resume?: string;
  /**
   * Streaming-input mode (plan / exec stages): the prompt goes in as the first item of an input channel whose
   * sink is registered here, so the owner's later messages reach the model. Omitted = a plain string prompt (qa).
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
  /** Quota outcome: when the limit resets (epoch ms), if the SDK reported it. */
  resetsAt?: number;
  /** Last thing the assistant said (text of its last message with text); the budget-hit message shows it. */
  lastText?: string;
}

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-agent" });

/** Run the agent once (read-only Q&A, or a code task when `code` is set), recording messages, tool calls and the run row. */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { abortController: ac } = input;
  // The stage (role definition) decides tools, model slot, permission mode, timeout and prompt.
  const { stage } = input;
  const config = stageConfig(stage, input.config, input.route);
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
    input.taskId,
    config.model,
    workspacePaths(config.agentHome).taskLog(input.taskId),
    input.stageIdx,
  );
  const run = input.queryFn ?? (sdkQuery as QueryFn);

  // Timeout is mandatory: an invalid auth token otherwise retries forever.
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      ac.abort();
    },
    stageTimeoutMs(stage, config),
  );

  let res: StreamResult = { text: "", sessionId: undefined, outcome: "error", usage: emptyUsage() };
  // Workspace skills plugin (fail closed, never throws); built inside the try so `finally` always removes it.
  let sk: RunSkills = { skills: [], dirs: [], cleanup: () => {} };

  try {
    sk = workspaceSkills(input.skillsWorkspace, config.agentHome);
    // Auto mode is requested here and confirmed by the SDK init message (permission-watch.ts).
    const requestedMode = resolvePermissionMode(stage, config);
    const autoState: ModeActive = { active: requestedMode === "auto" };
    const bypassState: ModeActive = { active: requestedMode === "bypassPermissions" };
    const options = await buildSdkOptions(stage, input, {
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
      timedOut: () => timedOut,
      db: input.db,
      taskId: input.taskId,
      cwd: input.cwd,
      requireGit: stage.gitGroups.includes("commit"),
      permissionWatch: createPermissionWatch(requestedMode, autoState, bypassState),
    };
    res = input.steer
      ? await consumeSteered({ ...common, first: input.prompt, hook: input.steer, runId })
      : await consumeStream({ ...common, prompt: input.prompt });
  } finally {
    clearTimeout(timer);
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
  };
}
