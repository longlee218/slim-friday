import type { Database } from "bun:sqlite";
import { type SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { ceilingBinds, type Route } from "../config/model-routing";
import { workspacePaths } from "../config/workspace-paths";
import type { AppCtxFactory } from "../mcp/manifest-types";
import type { MemoryToolContext } from "../memory/memory-tool-context";
import { logEvent, logger } from "../observability/logger";
import { dumpPrompt } from "../observability/prompt-dump";
import { RunRecorder } from "../observability/record-run";
import {
  avgContextTokens,
  emptyUsage,
  type RunOutcome,
  type RunUsage,
} from "../observability/run-usage";
import { logSkillsUsed } from "../observability/skills-used";
import type { GuardrailContext } from "../policy/check-tool-call";
import type { RoleDefinition } from "../roles/role-types";
import { type ModeActive, resolvePermissionMode } from "./permission-mode";
import { createPermissionWatch } from "./permission-watch";
import type { SteerHook } from "./run-input-channel";
import { consumeStream, type QueryFn, type StreamResult } from "./run-stream";
import type { RunControlEvent } from "./run-supervisor";
import { SandboxUnavailableError } from "./sandbox-errors";
import { buildSdkOptions, roleConfig } from "./sdk-options";
import { NO_SKILLS, type RunSkills } from "./skills-plugin/plugin-builder";
import { buildRoleSkills } from "./skills-plugin/role-skills";
import { consumeSteered } from "./steered-stream";
import type { ToolPermissionInput } from "./tool-permissions";

export type { QueryFn };

/** A lean run (rollover flush, `/compact`): no built-in tool, thinking off, only the role's MCP tools; its caps replace the role's. */
export interface LeanRun {
  maxTurns: number;
  budgetUsd: number;
}

/** Inputs for one agent run. */
export interface RunAgentInput {
  /** User question sent to the agent. */
  prompt: string;
  /** Task id; names the per-task JSONL and tags logs. */
  turnId: string;
  /** Location directory the agent runs in. */
  cwd: string;
  /** Extra location directories the agent may read (multi-location registry). */
  additionalDirectories?: string[];
  /** Extra prompt context blocks (persona, registry, memory...); empty ones are dropped. */
  extraContext?: string[];
  /** Guardrails of the run (paths, git locations, allowed tools); omitted only in unit tests. */
  guard?: GuardrailContext;
  /** The role to run: its tools, model slot, permission mode and prompt. */
  role: RoleDefinition;
  /** Permission layer of the run (gateway, ask limit). Omitted = a run without a gateway (ask = deny). */
  code?: Omit<ToolPermissionInput, "turnId" | "guard">;
  /** Where the agent may put a git worktree (`<workspace worktrees dir>/<location>`). */
  worktreesDir?: string;
  /** Workspace whose curated skills dir the run may use, via an app-owned plugin copy. */
  skillsWorkspace?: string;
  /** Context of the memory tools and `Orchestrate set_title`; omitted = no memory tools. */
  memory?: MemoryToolContext;
  /** Builds the app ctx parts of ONE query() call; the role's `mcpTools` picks the tools. */
  appCtx?: AppCtxFactory;
  /** Per-run facts (internal hint, budget raise, spent so far); omitted = the role defaults. */
  route?: Route;
  /** Existing Claude session id to resume. */
  resume?: string;
  /** Lean run (see `LeanRun`). */
  lean?: LeanRun;
  /** Run supervisor events (`model_turn`, `guard_denied`); observation only. */
  onControlEvent?: (event: RunControlEvent) => void;
  /** A tool call is about to start: a sign of life for the watchdog. */
  onToolStart?: () => void;
  /** Sees every stream message of a plain (non-steered) run (the rollover flush counts `MemorySave`). */
  onMessage?: (msg: SDKMessage) => void;
  /** Called with each assistant text of the run (the status progress note). */
  onProgress?: (text: string) => void;
  /** Streaming-input mode (background roles): the owner's later messages reach the model (channel, registration and the step-7 wait live in steered-stream.ts). Omitted = plain string prompt. */
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
  /** Budget (USD) this run was capped at; undefined = no cap. */
  budgetUsd?: number;
  /** The task ceiling (TASK_BUDGET_USD minus earlier spend), not the role budget, capped this run. */
  ceilingBound?: boolean;
  /** What the task's earlier runs already cost (USD). */
  spentBeforeUsd?: number;
  /** Quota outcome: when the limit resets (epoch ms), if the SDK reported it. */
  resetsAt?: number;
  /** Text of the assistant's last message with text. */
  lastText?: string;
  /** The failure was a transient provider / network error (see failure-class.ts). */
  transient?: true;
}

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-agent" });

/** Run the agent once (an answer, or a code task: the role says), recording messages, tool calls and the run row. */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { abortController: ac, role } = input;
  const base = roleConfig(role, input.config, input.route);
  const config = input.lean
    ? { ...base, limits: { ...base.limits, maxBudgetUsd: input.lean.budgetUsd } }
    : base;
  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const recorder = new RunRecorder(
    input.db,
    runId,
    input.turnId,
    config.model,
    workspacePaths(config.agentHome).taskLog(input.turnId),
  );

  // No run timeout (owner): ends by result, budget, turn ceiling or abort.
  let res: StreamResult = { text: "", sessionId: undefined, outcome: "error", usage: emptyUsage() };
  // Skills plugin (fail closed); built inside the try so `finally` removes it.
  let sk: RunSkills = NO_SKILLS;
  const skillsCalled = new Set<string>(); // filled by the tool hooks, logged as `skills.used` at the end
  try {
    sk = buildRoleSkills(role, input.skillsWorkspace, config.agentHome);
    // Auto mode is requested here and confirmed by the SDK init message (permission-watch.ts).
    const requestedMode = resolvePermissionMode(role, config, input.guard);
    const autoState: ModeActive = { active: requestedMode === "auto" };
    const bypassState: ModeActive = { active: requestedMode === "bypassPermissions" };
    const options = buildSdkOptions(role, input, {
      config,
      recorder,
      skills: sk,
      autoState,
      bypassState,
      skillsCalled,
    });
    // Debug dump of exactly what the SDK receives (FRIDAY_DUMP_PROMPTS=1); never throws.
    dumpPrompt({
      config,
      role: role.name,
      threadId: input.code?.threadId ?? input.memory?.threadId ?? input.turnId,
      turnId: input.turnId,
      options,
      prompt: input.prompt,
    });
    logEvent(log, "run.started", {
      model: config.model,
      cwd: input.cwd,
      resume: !!input.resume,
      tools: Array.isArray(options.tools) ? options.tools.length : undefined,
      mcpServers: Object.keys(options.mcpServers ?? {}),
    });
    if (input.resume) logEvent(log, "session.resumed", { sessionId: input.resume });
    const common = {
      run: input.queryFn ?? (sdkQuery as QueryFn),
      options,
      recorder,
      ac,
      db: input.db,
      turnId: input.turnId,
      cwd: input.cwd,
      onProgress: input.onProgress,
      permissionWatch: createPermissionWatch(requestedMode, autoState, bypassState),
      onTurn:
        input.onControlEvent &&
        ((turn: number) => input.onControlEvent?.({ kind: "model_turn", turn })),
    };
    res = input.steer
      ? await consumeSteered({ ...common, first: input.prompt, hook: input.steer, runId })
      : await consumeStream({ ...common, prompt: input.prompt, onMessage: input.onMessage });
    // A run that REQUIRED the OS sandbox and could not get it fails, never hangs or retries unsandboxed.
    if (options.sandbox && res.sandboxFailure)
      throw new SandboxUnavailableError(res.sandboxFailure);
  } finally {
    sk.cleanup();
    recorder.finish(res.outcome, res.usage);
    recorder.close();
  }
  const { sandboxFailure: _handled, ...result } = res; // not part of the result
  const { outcome, usage } = result;
  // `usage` = main agent tokens; `costUsd` = all agents; `modelUsage` splits both per model.
  logEvent(log, "run.finished", {
    outcome,
    ...usage,
    avgContextTokens: avgContextTokens(usage),
    maxTurnsHit: outcome === "max_turns",
    durationMs: Date.now() - startedAt,
  });
  if (role.kind === "worker")
    logSkillsUsed(log, { role: role.name, available: sk.skills, called: skillsCalled });
  return {
    ...result,
    budgetUsd: config.limits.maxBudgetUsd,
    ceilingBound: ceilingBinds(config.limits.maxBudgetUsd, input.route?.spentUsd),
    spentBeforeUsd: input.route?.spentUsd,
  };
}
