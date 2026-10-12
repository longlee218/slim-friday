import type { Database } from "bun:sqlite";
import { insertRun, insertToolCall } from "../storage/run-metrics-store";
import { createLogger, fileDestination, logger, tryLog } from "./logger";
import {
  type ModelUsage,
  mergeModelUsage,
  modelUsageFromResult,
  type ResultModelUsage,
} from "./model-usage";
import { redactDeep, safePreview } from "./redact";

/** How a run ended. */
export type RunOutcome =
  | "success"
  | "max_turns"
  | "max_budget"
  | "error"
  | "aborted"
  | "timeout"
  | "quota";

/** Token/cost/time metrics of one run. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  turns: number;
  durationMs: number;
  compactions: number;
  /** Largest main-agent context (input + cache read + cache create of one model call) seen in the run; log only. */
  peakContextTokens: number;
  /** Context of the LAST main-agent model call: what a rollover rule compares to the model window. Log/memory only. */
  lastContextTokens: number;
  /** Tool results flagged `is_error` in the run (main + subagents). */
  toolErrors: number;
  /** Tool calls our guard / the owner denied (not counted in `toolErrors`). */
  toolDenied: number;
  /** Window (tokens) of the main model, from the SDK result `modelUsage[model].contextWindow`; undefined = unknown. */
  contextWindow?: number;
  /** Per-model split of the run (all agents), from the result message; absent when the SDK gave none. */
  modelUsage?: ModelUsage;
}

/** Zeroed usage used when no result message arrived (abort/crash). */
export const emptyUsage = (): RunUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  turns: 0,
  durationMs: 0,
  compactions: 0,
  peakContextTokens: 0,
  lastContextTokens: 0,
  toolErrors: 0,
  toolDenied: 0,
});

/** Average context (input + cache read + cache creation tokens per turn) of a run, from its usage totals (0 when no turn ran). */
export function avgContextTokens(u: RunUsage): number {
  const turns = Math.max(u.turns, 1);
  return Math.round((u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens) / turns);
}

/** Records one run: raw JSONL stream per task, tool_calls rows, final runs row. */
export class RunRecorder {
  /** tool_use_ids our permission layer denied in this run; the stream tells them apart from tool failures. */
  readonly denied = new Set<string>();
  /** Pino destination for logs/tasks/<id>.jsonl (sync file stream). */
  private readonly dest: ReturnType<typeof fileDestination>;
  /** Pino logger writing the raw per-task event stream to `dest`. */
  private readonly taskLog: ReturnType<typeof createLogger>;
  /** Module logger for recorder failures. */
  private readonly log = logger.child({ module: "record-run" });

  /**
   * @param db sqlite handle
   * @param runId id of the runs row this recorder writes
   * @param turnId owning turn id
   * @param model model name stored on the runs row
   * @param taskLogFile path of the per-task JSONL
   */
  constructor(
    private readonly db: Database,
    readonly runId: string,
    private readonly turnId: string,
    private readonly model: string,
    taskLogFile: string,
  ) {
    this.dest = fileDestination(taskLogFile);
    this.taskLog = createLogger(this.dest, "trace");
  }

  /** Run a recorder action; failures are logged (redacted) and never thrown into the SDK. */
  private safely(what: string, fn: () => void): void {
    tryLog(this.log.child({ runId: this.runId }), `recorder failed: ${what}`, fn);
  }

  /** Append one SDK message (redacted) to the per-task JSONL. */
  logMessage(msg: unknown): void {
    this.safely("logMessage", () =>
      this.taskLog.trace({ runId: this.runId, sdk: redactDeep(msg) }, "sdk message"),
    );
  }

  /** Insert a tool_calls row; input and output are redacted and truncated here. */
  recordToolCall(c: {
    id: string;
    tool: string;
    input: unknown;
    output: unknown;
    isError: boolean;
    durationMs: number;
    /** Subagent that made the call; absent for the main agent. */
    agentId?: string;
  }): void {
    this.safely("recordToolCall", () =>
      insertToolCall(this.db, {
        id: c.id,
        runId: this.runId,
        tool: c.tool,
        inputJson: safePreview(c.input),
        outputPreview: safePreview(c.output),
        isError: c.isError,
        durationMs: c.durationMs,
        agentId: c.agentId,
        turnId: this.turnId,
      }),
    );
  }

  /** Insert the final runs row. */
  finish(outcome: RunOutcome, u: RunUsage): void {
    this.safely("finish", () =>
      insertRun(this.db, {
        id: this.runId,
        turnId: this.turnId,
        model: this.model,
        outcome,
        ...u,
      }),
    );
  }

  /** Flush and close the JSONL file. */
  close(): void {
    this.safely("close", () => {
      this.dest.flushSync();
      this.dest.end();
    });
  }
}

/** Map SDK result subtype to our outcome. */
export function outcomeFromSubtype(subtype: string): RunOutcome {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "max_turns";
  if (subtype === "error_max_budget_usd") return "max_budget";
  return "error";
}

/** Subset of the SDK result message we read (real shape from spike q06/q08b). */
export interface ResultShape {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  num_turns?: number;
  modelUsage?: ResultModelUsage;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** Convert a result message into RunUsage. */
export function usageFromResult(r: ResultShape, compactions: number): RunUsage {
  return {
    inputTokens: r.usage?.input_tokens ?? 0,
    outputTokens: r.usage?.output_tokens ?? 0,
    cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
    costUsd: r.total_cost_usd ?? 0,
    turns: r.num_turns ?? 0,
    durationMs: r.duration_ms ?? 0,
    compactions,
    peakContextTokens: 0,
    lastContextTokens: 0,
    toolErrors: 0,
    toolDenied: 0,
    modelUsage: modelUsageFromResult(r.modelUsage),
  };
}

/**
 * Usage of a run that produced several `result`s (streaming input: one per owner message; a resumed round counts as
 * one more). `total_cost_usd` is CUMULATIVE per the SDK doc (each result carries the running total; a resumed
 * session continues from the saved total), so the cost keeps the largest value. `num_turns` is per result (spike
 * q16, scenario C: 1, 1, 1), so turns are summed. Tokens and duration are not proven by any fixture: summed as
 * per-result figures (they only feed logs, never a budget).
 */
export function addUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: Math.max(a.costUsd, b.costUsd),
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
    compactions: a.compactions + b.compactions,
    // Context gauges are not summed: peak = larger, last = the later round's (kept when it had no model call).
    peakContextTokens: Math.max(a.peakContextTokens, b.peakContextTokens),
    lastContextTokens: b.lastContextTokens || a.lastContextTokens,
    toolErrors: a.toolErrors + b.toolErrors,
    toolDenied: a.toolDenied + b.toolDenied,
    contextWindow: b.contextWindow ?? a.contextWindow,
    // modelUsage follows the cost semantics (cumulative, per-field max), NOT the summed top-level tokens above:
    // an unverified assumption until a live multi-result run (see mergeModelUsage).
    modelUsage: mergeModelUsage(a.modelUsage, b.modelUsage),
  };
}
