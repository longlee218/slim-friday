import type { CoreLimits } from "../config-defaults";
import type { WakeRow } from "../domain/wake";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { Store } from "../ports/store";
import { RunLease } from "./run-lease";

/** What a claimer needs. */
export interface RunClaimerDeps {
  store: Store;
  clock: Clock;
  limits: CoreLimits;
  log: Log;
  /** `<bootId>:<workerId>` written into every lease this claimer takes. */
  owner: string;
  bootId: string;
  /** Runs one claimed row; the lease is already held and renewed until `execute` returns. */
  execute: (row: WakeRow, lease: RunLease) => Promise<void>;
  /** Free memory of the machine in MB. */
  freeMemoryMb: () => number;
}

/**
 * Claims queued runs from the store while the worker has room: on a hint and on a fallback scan.
 * One claim pass runs at a time; a hint during a pass schedules one more pass.
 */
export class RunClaimer {
  /** Runs executing now. */
  private active = new Set<Promise<void>>();
  /** A claim pass is in progress. */
  private passing = false;
  /** The pass in progress, for `stop` to wait on. */
  private current?: Promise<void>;
  /** A hint arrived during the pass; run another one after it. */
  private again = false;
  /** Between `start` and `stop`; hints and scans do nothing outside it. */
  private started = false;
  /** Cancels the pending fallback-scan timer. */
  private cancelScan?: () => void;

  /** `d` holds the store, clock, limits, log, lease owner and the run executor. */
  constructor(private d: RunClaimerDeps) {}

  /** Number of runs executing now. */
  get running(): number {
    return this.active.size;
  }

  /** Begin the fallback scan and claim once right away. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.armScan();
    this.onHint();
  }

  /** Something claimable may exist; look now. */
  onHint(): void {
    if (!this.started) return;
    if (this.passing) this.again = true;
    else {
      const p: Promise<void> = this.pass().finally(() => {
        if (this.current === p) this.current = undefined;
      });
      this.current = p;
    }
  }

  /** Stop scanning and wait for running executions to finish (they are not cancelled). */
  async stop(): Promise<void> {
    this.started = false;
    this.cancelScan?.();
    while (this.current || this.active.size > 0) {
      await Promise.all([this.current, ...this.active]);
    }
  }

  /** Schedule the next fallback scan. */
  private armScan(): void {
    this.cancelScan = this.d.clock.setTimer(this.d.limits.scanMs, () => {
      if (!this.started) return;
      this.armScan();
      this.onHint();
    });
  }

  /** Claim rows until the worker is full, short of memory or the queue is empty. */
  private async pass(): Promise<void> {
    this.passing = true;
    try {
      do {
        this.again = false;
        while (this.started && this.hasRoom()) {
          const row = await this.d.store.wakes.claimNext({
            owner: this.d.owner,
            bootId: this.d.bootId,
            now: this.d.clock.now(),
            leaseMs: this.d.limits.leaseMs,
          });
          if (!row) break;
          this.launch(row);
        }
      } while (this.again && this.started);
    } catch (e) {
      this.d.log.error({ err: String(e) }, "run.claim_failed");
    } finally {
      this.passing = false;
    }
  }

  /** Room for one more run: under the cap and above the memory floor. */
  private hasRoom(): boolean {
    return (
      this.active.size < this.d.limits.runsPerWorker &&
      this.d.freeMemoryMb() >= this.d.limits.minFreeMemoryMb
    );
  }

  /** Start one claimed row in the background and track it until it settles. */
  private launch(row: WakeRow): void {
    const p = this.run(row).finally(() => {
      this.active.delete(p);
      // A slot freed: more queued rows may now fit.
      this.onHint();
    });
    this.active.add(p);
  }

  /** Record the attempt, move the row to running, then execute; the lease always stops. */
  private async run(row: WakeRow): Promise<void> {
    const { store, clock, log } = this.d;
    const now = clock.now();
    if (row.priority === "interactive" && now > row.createdAt + this.d.limits.queueDelayWarnMs) {
      log.warn(
        { wakeId: row.id, botId: row.targetBot, delayMs: now - row.createdAt },
        "run.queue_delayed",
      );
    }
    const lease = new RunLease(store, clock, this.d.limits, row, this.d.owner, (why) =>
      log.warn({ wakeId: row.id, why }, "run.lease_lost"),
    );
    lease.start();
    try {
      await store.attempts.start({
        id: `${row.id}:${row.leaseFence}`,
        wakeId: row.id,
        fence: row.leaseFence,
        owner: this.d.owner,
        startedAt: now,
      });
      const running = { status: "running" as const, startedAt: row.startedAt ?? now };
      const ok = await store.wakes.transition(row.id, row.leaseFence, ["leased"], running);
      if (!ok) {
        log.warn({ wakeId: row.id }, "run.claim_lost");
        return;
      }
      // The executor gets the row as stored: its start time bounds the scope's first idle flush.
      await this.d.execute({ ...row, ...running }, lease);
    } catch (e) {
      log.error({ wakeId: row.id, err: String(e) }, "run.execute_failed");
    } finally {
      lease.stop();
    }
  }
}
