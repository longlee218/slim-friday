import type { BlockReason, WakeRow } from "../domain/wake";
import type { Clock } from "../ports/clock";
import type { Log } from "../ports/log";
import type { Store } from "../ports/store";

/** The fields every wake event carries (ids and enums only, never message text). */
function base(w: WakeRow) {
  return {
    wakeId: w.id,
    chainId: w.chainId,
    botId: w.targetBot,
    intent: w.intent,
    hop: w.hop,
    attempts: w.attempts,
    ...(w.ticketId && { ticketId: w.ticketId }),
    ...(w.rewake && { rewake: true }),
    ...(w.scheduleId && { scheduleId: w.scheduleId }),
  };
}

/** Run fields a new wake may leave out. */
type RunDefaults =
  | "scopeKey"
  | "priority"
  | "leaseFence"
  | "cuts"
  | "transientRetries"
  | "setupFailures"
  | "nudges";

/** What a caller gives for a new wake; the rest gets defaults. */
export type NewWake = Omit<
  WakeRow,
  "id" | "status" | "attempts" | "createdAt" | "chainId" | RunDefaults
> &
  Partial<Pick<WakeRow, RunDefaults>> & { chainId?: string };

/** Per-process counter so ids made in this process sort in creation order (the chain guard breaks createdAt ties by id). */
let wakeSeq = 0;

/** A wake id: a zero-padded counter, then a UUID. Ids of one process sort as created; the UUID keeps them unique across processes. */
function nextWakeId(): string {
  wakeSeq += 1;
  return `${wakeSeq.toString(36).padStart(8, "0")}-${crypto.randomUUID()}`;
}

/**
 * The life of a wake in the store, with one log line per step: queued, started, done, blocked,
 * expired, dropped. Timings are measured from the time the wake was created. The executor writes a
 * run's own changes with fenced transitions and only logs them here (`logStarted`, `logDone`).
 */
export class WakeLog {
  constructor(
    private store: Store,
    private clock: Clock,
    private log?: Log,
    private newId: () => string = nextWakeId,
  ) {}

  /** Store a new queued wake. A user wake (no `chainId`) starts its own chain. */
  async create(w: NewWake): Promise<WakeRow> {
    const row = this.build(w);
    await this.store.wakes.insert(row);
    this.stored(row);
    return row;
  }

  /** A new queued wake row with its defaults, not stored yet (the caller stores it, e.g. deduped). */
  build(w: NewWake): WakeRow {
    const id = this.newId();
    return {
      // Run fields start as a plain interactive run in the target bot's own scope.
      scopeKey: w.targetBot,
      priority: "interactive",
      leaseFence: 0,
      cuts: 0,
      transientRetries: 0,
      setupFailures: 0,
      nudges: 0,
      ...w,
      id,
      chainId: w.chainId ?? id,
      status: "queued",
      attempts: 1,
      createdAt: this.clock.now(),
    };
  }

  /** Log a row the caller has just stored. */
  stored(row: WakeRow): void {
    this.log?.info({ event: "wake.queued", ...base(row), status: row.status }, "wake.queued");
  }

  /** Log a run that a worker started at `startedAt` (the row is already `running`). */
  logStarted(w: WakeRow, startedAt: number): void {
    this.log?.info(
      {
        event: "wake.started",
        ...base(w),
        status: "running",
        queue_wait_ms: startedAt - w.createdAt,
      },
      "wake.started",
    );
  }

  /** Log a run that finished normally at `endedAt` (the row is already `done`). */
  logDone(w: WakeRow, endedAt: number): void {
    this.log?.info(
      {
        event: "wake.done",
        ...base(w),
        status: "done",
        queue_wait_ms: (w.startedAt ?? endedAt) - w.createdAt,
        ...(w.firstTextAt !== undefined && { first_response_ms: w.firstTextAt - w.createdAt }),
        total_ms: endedAt - w.createdAt,
      },
      "wake.done",
    );
  }

  /** A cap stopped the wake. */
  async blocked(w: WakeRow, reason: BlockReason): Promise<void> {
    const endedAt = this.clock.now();
    await this.store.wakes.update(w.id, { status: "blocked", blockReason: reason, endedAt });
    this.log?.warn(
      { event: "wake.blocked", ...base(w), status: "blocked", blockReason: reason },
      "wake.blocked",
    );
  }

  /** The wake is sent again after a restart (`attempts` already counts the new send). */
  redelivered(w: WakeRow): void {
    this.log?.info({ event: "wake.redelivered", ...base(w), status: "queued" }, "wake.redelivered");
  }

  /** The wake waited too long while the app was down. */
  async expired(id: string): Promise<void> {
    await this.end(id, "expired", "wake.expired");
  }

  /** The wake will never be delivered (its queue was cleared, or its bot or conversation is gone). */
  async dropped(id: string): Promise<void> {
    await this.end(id, "dropped", "wake.dropped");
  }

  private async end(id: string, status: "dropped" | "expired", event: string): Promise<void> {
    const w = await this.store.wakes.get(id);
    if (!w) return;
    await this.store.wakes.update(id, { status, endedAt: this.clock.now() });
    this.log?.warn({ event, ...base(w), status }, event);
  }
}
