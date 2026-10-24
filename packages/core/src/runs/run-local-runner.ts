import type { HubContext } from "../hub/hub-context";
import type { Log } from "../ports/log";
import { applyCardAnswer } from "./run-cards";
import { RunClaimer } from "./run-claimer";
import { abortRun } from "./run-exec";
import { executeRun } from "./run-executor";
import type { HintSource, RunnerIdentity } from "./run-hints";
import { deliverSteering } from "./run-steering";

/** A log that drops every line (the hub may run without one). */
const SILENT: Log = { info() {}, warn() {}, error() {} };

/**
 * Claims and executes runs in this process: in the main process when there are no workers (`workers = 0`),
 * or in a worker process. Hints from `hints` wake a claimer; the lease owner is `<bootId>:<name>`, so every
 * lease of an earlier boot is reclaimable at once. The claimer starts on `start()` or on the first hint,
 * whichever comes first. Without an identity a random boot id is drawn and the name is `main`.
 */
export class LocalRunner {
  /** Claims and executes the runs. */
  private claimer: RunClaimer;
  /** The claimer was started. */
  private started = false;

  constructor(
    private ctx: HubContext,
    hints: HintSource,
    freeMemoryMb: () => number = () => Number.POSITIVE_INFINITY,
    who: RunnerIdentity = { bootId: crypto.randomUUID(), name: "main" },
  ) {
    const { bootId } = who;
    this.claimer = new RunClaimer({
      store: ctx.deps.store,
      clock: ctx.deps.clock,
      limits: ctx.limits,
      log: ctx.deps.log ?? SILENT,
      owner: `${bootId}:${who.name}`,
      bootId,
      execute: (row, lease) => executeRun(ctx, row, lease),
      freeMemoryMb,
    });
    hints.on((h) => {
      if (h.kind === "cancel") return this.cancel(h.wakeIds);
      if (h.kind === "configChanged") return;
      if (!this.started) this.start();
      else if (h.kind !== "steer") this.claimer.onHint();
      // Steering for a run of this process goes into its open turn at once (a queued run claims it at start).
      if (h.kind === "steer") this.steer(h.wakeId);
      // An answer for a run of this process that waits in place (background tasks) is applied without a resume.
      if (h.kind === "cardAnswered")
        for (const exec of this.ctx.runs.values()) void applyCardAnswer(this.ctx, exec, h.cardId);
    });
  }

  /** Begin claiming: one pass now (rows left by an earlier boot included), then on hints and every scan. */
  start(): void {
    this.started = true;
    this.claimer.start();
  }

  /** Abort every run of this process (`shutdown`: their rows go back to queued, no cut) and stop claiming. */
  async stop(): Promise<void> {
    // A run a pass still in progress starts now is aborted by the executor (`closing`).
    this.ctx.closing = true;
    for (const exec of this.ctx.runs.values()) abortRun(exec, { kind: "shutdown" });
    await this.claimer.stop();
  }

  /** Push the rows bound to run `wakeId` into its turn when this process executes it. */
  private steer(wakeId: string): void {
    for (const exec of this.ctx.runs.values())
      if (exec.row.id === wakeId) void deliverSteering(this.ctx, exec, true);
  }

  /** Cancelled runs stop at once instead of at the next fence check. */
  private cancel(wakeIds: string[]): void {
    for (const exec of this.ctx.runs.values())
      if (wakeIds.includes(exec.row.id)) abortRun(exec, { kind: "lease", why: "cancelled" });
  }
}
