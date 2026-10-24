import type { HubContext } from "../hub/hub-context";
import type { Log } from "../ports/log";
import { RunClaimer } from "./run-claimer";
import { abortRun } from "./run-exec";
import { executeRun } from "./run-executor";
import type { InProcessHints } from "./run-hints";

/** A log that drops every line (the hub may run without one). */
const SILENT: Log = { info() {}, warn() {}, error() {} };

/**
 * The runner of the main process (no workers yet; Task 15 keeps it as the `workers = 0` mode): in-process
 * hints wake a claimer that executes runs here. A random boot id per start makes every lease of an earlier
 * boot reclaimable at once. The claimer starts on `start()` or on the first hint, whichever comes first.
 */
export class LocalRunner {
  /** Claims and executes the runs. */
  private claimer: RunClaimer;
  /** The claimer was started. */
  private started = false;

  constructor(
    private ctx: HubContext,
    hints: InProcessHints,
    freeMemoryMb: () => number = () => Number.POSITIVE_INFINITY,
  ) {
    const bootId = crypto.randomUUID();
    this.claimer = new RunClaimer({
      store: ctx.deps.store,
      clock: ctx.deps.clock,
      limits: ctx.limits,
      log: ctx.deps.log ?? SILENT,
      owner: `${bootId}:main`,
      bootId,
      execute: (row, lease) => executeRun(ctx, row, lease),
      freeMemoryMb,
    });
    hints.on((h) => {
      if (h.kind === "cancel") return this.cancel(h.wakeIds);
      if (h.kind === "configChanged") return;
      if (!this.started) this.start();
      else this.claimer.onHint();
    });
  }

  /** Begin claiming: one pass now (rows left by an earlier boot included), then on hints and every scan. */
  start(): void {
    this.started = true;
    this.claimer.start();
  }

  /** Abort every run of this process (`shutdown`: their rows stay claimable) and stop claiming. */
  async stop(): Promise<void> {
    // A run a pass still in progress starts now is aborted by the executor (`closing`).
    this.ctx.closing = true;
    for (const exec of this.ctx.runs.values()) abortRun(exec, { kind: "shutdown" });
    await this.claimer.stop();
  }

  /** Cancelled runs stop at once instead of at the next fence check. */
  private cancel(wakeIds: string[]): void {
    for (const exec of this.ctx.runs.values())
      if (wakeIds.includes(exec.row.id)) abortRun(exec, { kind: "lease", why: "cancelled" });
  }
}
