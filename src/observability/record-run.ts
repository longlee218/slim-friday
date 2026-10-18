import type { Database } from "bun:sqlite";
import { insertRun, insertToolCall } from "../storage/run-metrics-store";
import { createLogger, fileDestination, logger, tryLog } from "./logger";
import { redactDeep, safePreview } from "./redact";
import type { RunOutcome, RunUsage } from "./run-usage";

/** Records one run: raw JSONL stream per task, tool_calls rows, final runs row. */
export class RunRecorder {
  /** tool_use_ids our permission layer denied (told apart from tool failures). */
  readonly denied = new Set<string>();
  /** Sync file stream of logs/tasks/<id>.jsonl. */
  private readonly dest: ReturnType<typeof fileDestination>;
  /** Writes the raw per-task event stream to `dest`. */
  private readonly taskLog: ReturnType<typeof createLogger>;
  /** Module logger for recorder failures. */
  private readonly log = logger.child({ module: "record-run" });

  /** `runId` = id of the runs row written; `model` is stored on it; `taskLogFile` = per-task JSONL path. */
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

  /** Run a recorder action; failures are logged and never thrown into the SDK. */
  private safely(what: string, fn: () => void): void {
    tryLog(this.log.child({ runId: this.runId }), `recorder failed: ${what}`, fn);
  }

  /** Append one SDK message (redacted) to the per-task JSONL. */
  logMessage(msg: unknown): void {
    this.safely("logMessage", () =>
      this.taskLog.trace({ runId: this.runId, sdk: redactDeep(msg) }, "sdk message"),
    );
  }

  /** Insert a tool_calls row (input and output redacted and truncated). */
  recordToolCall(c: {
    id: string;
    tool: string;
    input: unknown;
    output: unknown;
    isError: boolean;
    durationMs: number;
    agentId?: string; // subagent that made the call; absent = main agent
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
