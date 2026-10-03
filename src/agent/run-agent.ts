import type { Database } from "bun:sqlite";
import { type Options, type SDKMessage, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { logger } from "../observability/logger";
import {
  emptyUsage,
  type RunOutcome,
  RunRecorder,
  type RunUsage,
} from "../observability/record-run";
import { redactText } from "../observability/redact";
import { buildToolHooks } from "../observability/tool-hooks";
import { readOnlyToolOptions } from "../tools/tool-config";
import { workspacePaths } from "../workspace/workspace-paths";
import { buildRepoContext } from "./context";
import { buildSystemPrompt } from "./system-prompt";

/** Signature of the SDK `query` function; injectable for tests. */
export type QueryFn = (args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** Inputs for one agent run. */
export interface RunAgentInput {
  /** User question sent to the agent. */
  prompt: string;
  /** Task id; names the per-task JSONL and tags logs. */
  taskId: string;
  /** Repo directory the agent runs in. */
  cwd: string;
  /** Existing Claude session id to resume. */
  resume?: string;
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
}

/** Map SDK result subtype to our outcome. */
function outcomeFromSubtype(subtype: string): RunOutcome {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "max_turns";
  if (subtype === "error_max_budget_usd") return "max_budget";
  return "error";
}

/** Env vars the SDK child may inherit. Everything else (GITHUB_TOKEN, AWS_*, ...) is withheld. */
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"];

/** Build the SDK child env from an allowlist; OAuth token only when real (never the placeholder). */
export function sdkEnv(
  config: AgentConfig,
  source: Record<string, string | undefined> = process.env,
) {
  const env: Record<string, string | undefined> = {};
  for (const k of ENV_ALLOWLIST) if (source[k] !== undefined) env[k] = source[k];
  if (config.hasRealAuthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.oauthToken;
  return env;
}

/** Outcome for a run that ended by abort: timeout if our timer fired, else user stop. */
const abortOutcome = (timedOut: boolean): RunOutcome => (timedOut ? "timeout" : "aborted");

/** Run the agent once (read-only Q&A), recording messages, tool calls and the run row. */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { config, abortController: ac } = input;
  const log = logger.child({ module: "run-agent", taskId: input.taskId });
  const recorder = new RunRecorder(
    input.db,
    crypto.randomUUID(),
    input.taskId,
    config.model,
    workspacePaths(config.agentHome).taskLog(input.taskId),
  );
  const run = input.queryFn ?? (sdkQuery as QueryFn);

  // Timeout is mandatory: an invalid auth token otherwise retries forever.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, config.limits.timeoutMs);

  let text = "";
  let sessionId: string | undefined;
  let outcome: RunOutcome = "error";
  let usage = emptyUsage();
  let compactions = 0;

  try {
    const options: Options = {
      cwd: input.cwd,
      model: config.model,
      resume: input.resume,
      ...readOnlyToolOptions(),
      maxTurns: config.limits.maxTurns,
      maxBudgetUsd: config.limits.maxBudgetUsd,
      abortController: ac,
      settingSources: ["project"],
      systemPrompt: buildSystemPrompt(await buildRepoContext(input.cwd)),
      hooks: buildToolHooks(recorder),
      env: sdkEnv(config),
    };
    try {
      for await (const msg of run({ prompt: input.prompt, options })) {
        recorder.logMessage(msg);
        const m = msg as SDKMessage & { subtype?: string; session_id?: string };
        sessionId = m.session_id ?? sessionId;
        if (m.type === "system" && m.subtype === "compact_boundary") compactions++;
        if (m.type === "result") {
          const r = m as unknown as ResultShape;
          outcome = outcomeFromSubtype(r.subtype);
          text = r.subtype === "success" ? (r.result ?? "") : (r.errors ?? []).join("; ");
          usage = usageFromResult(r, compactions);
        }
      }
    } catch (err) {
      // max_turns/max_budget throw AFTER the result message (outcome already set).
      // Abort throws "process aborted" with no result message.
      if (outcome === "error" && !ac.signal.aborted) text = "Agent error";
      log.warn({ err: redactText(String(err)), outcome }, "query loop ended with throw");
    }
    // No result message + abort (user stop or our timeout): relabel once, for throw or clean end.
    if (outcome === "error" && ac.signal.aborted) outcome = abortOutcome(timedOut);
    usage = { ...usage, compactions };
  } finally {
    clearTimeout(timer);
    recorder.finish(outcome, usage);
    recorder.close();
  }
  log.info({ outcome, ...usage }, "run finished");
  return { text, sessionId, outcome, usage };
}

/** Subset of the SDK result message we read (real shape from spike q06/q08b). */
interface ResultShape {
  subtype: string;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Convert a result message into RunUsage. */
function usageFromResult(r: ResultShape, compactions: number): RunUsage {
  return {
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
    costUsd: r.total_cost_usd ?? 0,
    turns: r.num_turns ?? 0,
    durationMs: r.duration_ms ?? 0,
    compactions,
  };
}
