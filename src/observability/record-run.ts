import type { Database } from "bun:sqlite";
import { insertRun, insertToolCall } from "../storage/run-store";
import { createLogger, fileDestination, logger, tryLog } from "./logger";
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
});

/** Records one run: raw JSONL stream per task, tool_calls rows, final runs row. */
export class RunRecorder {
  /** Pino destination for logs/tasks/<id>.jsonl (sync file stream). */
  private readonly dest: ReturnType<typeof fileDestination>;
  /** Pino logger writing the raw per-task event stream to `dest`. */
  private readonly taskLog: ReturnType<typeof createLogger>;
  /** Module logger for recorder failures. */
  private readonly log = logger.child({ module: "record-run" });

  /**
   * @param db sqlite handle
   * @param runId id of the runs row this recorder writes
   * @param taskId owning task id
   * @param model model name stored on the runs row
   * @param taskLogFile path of the per-task JSONL
   */
  constructor(
    private readonly db: Database,
    readonly runId: string,
    private readonly taskId: string,
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
      this.taskLog.trace({ runId: this.runId, msg: redactDeep(msg) }, "sdk message"),
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
      }),
    );
  }

  /** Insert the final runs row. */
  finish(outcome: RunOutcome, u: RunUsage): void {
    this.safely("finish", () =>
      insertRun(this.db, { id: this.runId, taskId: this.taskId, model: this.model, outcome, ...u }),
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
  };
}
