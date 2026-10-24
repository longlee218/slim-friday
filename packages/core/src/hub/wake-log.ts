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
  };
}

/**
 * The life of a wake in the store, with one log line per step: queued, started, done, blocked,
 * interrupted, dropped. Timings are measured from the time the wake was created.
 */
export class WakeLog {
  constructor(
    private store: Store,
    private clock: Clock,
    private log?: Log,
    private newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** Store a new queued wake. A user wake (no `chainId`) starts its own chain. */
  async create(
    w: Omit<WakeRow, "id" | "status" | "attempts" | "createdAt" | "chainId"> & { chainId?: string },
  ): Promise<WakeRow> {
    const id = this.newId();
    const row: WakeRow = {
      ...w,
      id,
      chainId: w.chainId ?? id,
      status: "queued",
      attempts: 1,
      createdAt: this.clock.now(),
    };
    await this.store.wakes.insert(row);
    this.log?.info({ event: "wake.queued", ...base(row), status: row.status }, "wake.queued");
    return row;
  }

  /** The wake was sent into the session. */
  async started(id: string): Promise<void> {
    const w = await this.store.wakes.get(id);
    if (!w) return;
    const startedAt = this.clock.now();
    await this.store.wakes.update(id, { status: "running", startedAt });
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

  /** The bot said something; only the first text counts. */
  async firstText(id: string): Promise<void> {
    const w = await this.store.wakes.get(id);
    if (w && w.firstTextAt === undefined)
      await this.store.wakes.update(id, { firstTextAt: this.clock.now() });
  }

  /** The turn ended normally. */
  async done(id: string): Promise<void> {
    const w = await this.store.wakes.get(id);
    if (!w) return;
    const endedAt = this.clock.now();
    await this.store.wakes.update(id, { status: "done", endedAt });
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

  /** The session died while the wake ran. */
  async interrupted(id: string): Promise<void> {
    await this.end(id, "interrupted", "wake.interrupted");
  }

  /** The wake will never be delivered (its queue was cleared, or its bot or conversation is gone). */
  async dropped(id: string): Promise<void> {
    await this.end(id, "dropped", "wake.dropped");
  }

  private async end(
    id: string,
    status: "interrupted" | "dropped" | "expired",
    event: string,
  ): Promise<void> {
    const w = await this.store.wakes.get(id);
    if (!w) return;
    await this.store.wakes.update(id, { status, endedAt: this.clock.now() });
    this.log?.warn({ event, ...base(w), status }, event);
  }
}
