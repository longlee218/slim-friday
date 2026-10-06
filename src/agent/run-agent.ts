import type { Database } from "bun:sqlite";
import {
  type HookCallbackMatcher,
  type Options,
  type SDKMessage,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig } from "../config/agent-config";
import { workspacePaths } from "../config/workspace-paths";
import type { GuardrailContext } from "../guardrails/check-tool-call";
import type { GitIdentity } from "../mcp/git-mcp";
import { mcpServersFor } from "../mcp/mcp-servers";
import { logEvent, logger, tryLog } from "../observability/logger";
import {
  emptyUsage,
  outcomeFromSubtype,
  type ResultShape,
  type RunOutcome,
  RunRecorder,
  type RunUsage,
  usageFromResult,
} from "../observability/record-run";
import { errText, redactText } from "../observability/redact";
import { buildToolHooks } from "../observability/tool-hooks";
import { setTaskSession } from "../storage/run-store";
import { SUBAGENTS, type ToolMode, toolOptions } from "../tools/tool-catalog";
import { listRepoSkills } from "./repo-skills";
import { isQuotaFailure, RESUME_FAILED, resetFromInfo } from "./run-errors";
import { sdkEnv } from "./sdk-env";
import { buildSystemPrompt } from "./system-prompt";
import { buildToolPermissions, type ToolPermissionInput } from "./tool-permissions";

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
  /** Repo (workspace) the run belongs to: its raw task log goes to that workspace's logs dir. */
  logRepo?: string;
  /** GitHub login whose token the read-only GitHub MCP server uses (code tasks); default = active gh account. */
  githubAccount?: string;
  /** Code task: plan mode + write tools behind guardrails and owner approval. Omitted = read-only Q&A. */
  code?: Omit<ToolPermissionInput, "taskId" | "guard"> & {
    /** "plan" (default): plan mode, read-only dirs. "exec": runs in the worktree after plan approval. */
    stage?: "plan" | "exec";
  };
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
  /** Quota outcome: when the limit resets (epoch ms), if the SDK reported it. */
  resetsAt?: number;
}

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-agent" });

/** Code tasks include owner approval waits (10 min each), so their run timeout is at least this. */
const CODE_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/** Outcome for a run that ended by abort: timeout if our timer fired, else user stop. */
const abortOutcome = (timedOut: boolean): RunOutcome => (timedOut ? "timeout" : "aborted");

/** Put the guardrail PreToolUse matchers before the recording hooks (deny must win early). */
function mergeHooks(
  rec: ReturnType<typeof buildToolHooks>,
  guard: HookCallbackMatcher[] | undefined,
): ReturnType<typeof buildToolHooks> {
  if (!guard) return rec;
  return { ...rec, PreToolUse: [...guard, ...(rec.PreToolUse ?? [])] };
}

/** Run the agent once (read-only Q&A, or a code task when `code` is set), recording messages, tool calls and the run row. */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const { abortController: ac } = input;
  // Code tasks use the code model (plan mode needs a stronger one than cheap Q&A).
  const config = input.code ? { ...input.config, model: input.config.codeModel } : input.config;
  // Mode picks the tool set: Q&A, plan stage, or execute stage of a code task.
  const mode: ToolMode = input.code ? (input.code.stage === "exec" ? "exec" : "plan") : "qa";
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
  const recorder = new RunRecorder(
    input.db,
    crypto.randomUUID(),
    input.taskId,
    config.model,
    workspacePaths(config.agentHome).taskLog(input.taskId, input.logRepo),
  );
  const run = input.queryFn ?? (sdkQuery as QueryFn);

  // Timeout is mandatory: an invalid auth token otherwise retries forever.
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      ac.abort();
    },
    input.code ? Math.max(config.limits.timeoutMs, CODE_TASK_TIMEOUT_MS) : config.limits.timeoutMs,
  );

  let text = "";
  let sessionId: string | undefined;
  let outcome: RunOutcome = "error";
  let usage = emptyUsage();
  let compactions = 0;
  let startupError = "";
  /** Quota evidence: last assistant `error`, a rejected rate_limit_event (with its reset time). */
  let assistantError: string | undefined;
  let rejected = false;
  let resetsAt: number | undefined;

  // Every mode goes through the permission layer when it has a guard (Q&A has no gateway: ask = deny).
  const perms = input.guard
    ? buildToolPermissions({
        taskId: input.taskId,
        threadId: input.code?.threadId ?? "",
        guard: input.guard,
        gateway: input.code?.gateway,
        plan: input.code?.plan,
      })
    : undefined;

  try {
    const options: Options = {
      cwd: input.cwd,
      ...(input.additionalDirectories?.length && {
        additionalDirectories: input.additionalDirectories,
      }),
      model: config.model,
      resume: input.resume,
      ...toolOptions(mode),
      mcpServers: await mcpServersFor(mode, input),
      ...(mode === "plan" && { permissionMode: "plan" as const }),
      ...(perms && { canUseTool: perms.canUseTool }),
      // Subagents with explicit read-only tools in every mode. Skills: the repos' own, except in the execute
      // stage, which loads no project settings; there none, hiding the SDK's bundled ones too
      // (a model once reached for `update-config` there).
      agents: SUBAGENTS,
      skills:
        mode === "exec" ? [] : listRepoSkills([input.cwd, ...(input.additionalDirectories ?? [])]),
      maxTurns: config.limits.maxTurns,
      // Omitted (undefined) on openrouter unless MAX_BUDGET_USD is set: SDK cost uses Anthropic prices.
      ...(config.limits.maxBudgetUsd !== undefined && { maxBudgetUsd: config.limits.maxBudgetUsd }),
      abortController: ac,
      // Execute stage runs in a worktree the agent writes to: never load settings/hooks planted there
      // (spike q17: even projectConfigRoot does not stop a planted .claude/CLAUDE.md from loading).
      settingSources: mode === "exec" ? [] : ["project"],
      systemPrompt: buildSystemPrompt(
        (input.extraContext ?? []).filter(Boolean).join("\n\n"),
        mode,
      ),
      hooks: mergeHooks(buildToolHooks(recorder, perms?.decisions, config.agentHome), perms?.hooks),
      env: sdkEnv(config),
    };
    logEvent(log, "run.started", {
      model: config.model,
      provider: config.provider,
      cwd: input.cwd,
      resume: !!input.resume,
      tools: Array.isArray(options.tools) ? options.tools.length : undefined,
      mcpServers: Object.keys(options.mcpServers ?? {}),
    });
    if (input.resume) logEvent(log, "session.resumed", { sessionId: input.resume });
    try {
      for await (const msg of run({ prompt: input.prompt, options })) {
        recorder.logMessage(msg);
        const m = msg as SDKMessage & { subtype?: string; session_id?: string };
        sessionId = m.session_id ?? sessionId;
        if (m.type === "system" && m.subtype === "compact_boundary") compactions++;
        // Record the session on the task row at once (not in `sessions`: that table is only updated by a
        // successful finish, so a failed run never replaces the thread's good session). Resume reads it.
        if (m.type === "system" && m.subtype === "init" && m.session_id) {
          const sid = m.session_id;
          tryLog(log, "early session save failed", () =>
            setTaskSession(input.db, input.taskId, sid, input.cwd),
          );
        }
        const ext = m as unknown as { error?: string; rate_limit_info?: { status?: string } };
        // A later assistant message without `error` means the SDK retry worked: forget the old error.
        if (m.type === "assistant") assistantError = ext.error;
        if (m.type === "rate_limit_event") {
          // Raw shape at debug: the real payload of limit events is still being learned.
          log.debug({ info: ext.rate_limit_info }, "rate_limit_event");
          if (ext.rate_limit_info?.status === "rejected") {
            rejected = true;
            resetsAt = resetFromInfo(ext.rate_limit_info);
          }
        }
        // The execute stage is useless without its git tools: fail fast instead of letting the model flail.
        if (m.type === "system" && m.subtype === "init" && mode === "exec") {
          const servers = (m as unknown as { mcp_servers?: { name: string; status: string }[] })
            .mcp_servers;
          const git = servers?.find((x) => x.name === "git");
          if (git && git.status !== "connected") {
            startupError =
              "The git MCP server failed to start (check gitAuthor in the workspace config.yaml).";
            ac.abort();
          }
        }
        if (m.type === "result") {
          const r = m as unknown as ResultShape;
          outcome = outcomeFromSubtype(r.subtype);
          text = r.subtype === "success" ? (r.result ?? "") : (r.errors ?? []).join("; ");
          usage = usageFromResult(r, compactions);
          // Failure (error subtype, or success flagged is_error): quota, or unknown (raw error to the log only).
          if (outcome === "error" || (outcome === "success" && r.is_error)) {
            const errors = outcome === "error" ? text : (r.result ?? "");
            if (isQuotaFailure({ subtype: r.subtype, errors, assistantError, rejected })) {
              outcome = "quota";
              text = "";
            } else if (outcome === "error") {
              log.warn({ subtype: r.subtype, err: redactText(errors) }, "run failed");
              // Only a failed resume needs the raw text (handle-task drops the stale session); else generic reply.
              if (!RESUME_FAILED.test(errors)) text = "";
            }
          }
        }
      }
    } catch (err) {
      // max_turns/max_budget throw AFTER the result message (outcome already set).
      // Abort throws "process aborted" with no result message.
      if (outcome === "error" && !ac.signal.aborted) text = "Agent error";
      log.warn({ err: errText(err), outcome }, "query loop ended with throw");
      // A limit can also surface only as a thrown error (no result message).
      if (outcome === "error" && !ac.signal.aborted) {
        const errors = errText(err);
        if (isQuotaFailure({ errors, assistantError, rejected })) {
          outcome = "quota";
          text = "";
        }
      }
    }
    // No result message + abort (user stop or our timeout): relabel once, for throw or clean end.
    if (outcome === "error" && ac.signal.aborted) outcome = abortOutcome(timedOut);
    if (startupError) {
      outcome = "error";
      text = startupError;
    }
    usage = { ...usage, compactions };
  } finally {
    clearTimeout(timer);
    recorder.finish(outcome, usage);
    recorder.close();
  }
  logEvent(log, "run.finished", { outcome, ...usage, durationMs: Date.now() - startedAt });
  return { text, sessionId, outcome, usage, resetsAt };
}
