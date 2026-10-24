import type { WakeRow } from "../domain/wake";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";

/** Why a worker lost its right to run a row. */
export type LeaseLoss = "renew" | "cancelled" | "fence";

/**
 * The lease one worker holds on one run: renews it on a heartbeat and watches the row for a cancel or
 * a newer fence. Reports a loss once; after that it stops itself.
 */
export class RunLease {
  /** Cancels the pending heartbeat timer. */
  private cancelBeat?: () => void;
  /** Cancels the pending fence-check timer. */
  private cancelCheck?: () => void;
  /** Set by `stop` or after a loss; no timer re-arms then. */
  private stopped = true;

  constructor(
    private store: Store,
    private clock: Clock,
    private limits: { [K in "leaseMs" | "heartbeatMs" | "fenceCheckMs"]: number },
    private row: WakeRow,
    private owner: string,
    private onLost: (why: LeaseLoss) => void,
  ) {}

  /** The fence this lease was claimed with; every write of the run carries it. */
  get fence(): number {
    return this.row.leaseFence;
  }

  /** Begin renewing and checking. */
  start(): void {
    this.stopped = false;
    this.armBeat();
    this.armCheck();
  }

  /** Stop both timers; safe to call twice. */
  stop(): void {
    this.stopped = true;
    this.cancelBeat?.();
    this.cancelCheck?.();
  }

  /** Schedule the next heartbeat. */
  private armBeat(): void {
    this.cancelBeat = this.clock.setTimer(this.limits.heartbeatMs, () => void this.beat());
  }

  /** Schedule the next fence check. */
  private armCheck(): void {
    this.cancelCheck = this.clock.setTimer(this.limits.fenceCheckMs, () => void this.check());
  }

  /** Extend the lease; a refusal means another worker owns the row now. */
  private async beat(): Promise<void> {
    if (this.stopped) return;
    try {
      const ok = await this.store.wakes.renew(
        this.row.id,
        this.owner,
        this.fence,
        this.clock.now() + this.limits.leaseMs,
      );
      if (!ok) return this.lose("renew");
    } catch {
      // A store error is not a loss; the next heartbeat tries again before the lease ends.
    }
    if (!this.stopped) this.armBeat();
  }

  /** Read the row: cancelled, another owner or another fence ends the hold. */
  private async check(): Promise<void> {
    if (this.stopped) return;
    try {
      const cur = await this.store.wakes.get(this.row.id);
      if (!cur || cur.status === "cancelled") return this.lose("cancelled");
      if (cur.leaseOwner !== this.owner || cur.leaseFence !== this.fence) return this.lose("fence");
    } catch {
      // A failed read is retried at the next check.
    }
    if (!this.stopped) this.armCheck();
  }

  /** Stop and tell the owner of the lease, once. */
  private lose(why: LeaseLoss): void {
    if (this.stopped) return;
    this.stop();
    this.onLost(why);
  }
}
