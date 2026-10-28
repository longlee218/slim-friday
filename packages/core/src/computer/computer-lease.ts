import type { BotId } from "../domain/bot";
import type { Clock } from "../ports/clock";
import type { ComputerHold, Store } from "../ports/store";

/** Poll interval while waiting for a busy computer or slot. */
const POLL_MS = 250;

/** The computer or a slot stayed busy for the whole wait, or a held lease was lost. */
export class ComputerBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerBusyError";
  }
}

/** What the lease helpers need: the holds store, a clock and an injectable sleep. */
export interface LeaseDeps {
  holds: Store["computerHolds"];
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
}

/** Try `take` every 250 ms until it yields a hold or `waitMs` has passed. */
async function pollFor(
  d: LeaseDeps,
  waitMs: number,
  what: "input" | "slot",
  computer: string,
  take: () => Promise<ComputerHold | undefined>,
): Promise<ComputerHold> {
  const deadline = d.clock.now() + waitMs;
  for (;;) {
    const hold = await take();
    if (hold) return hold;
    if (d.clock.now() >= deadline) {
      throw new ComputerBusyError(
        `computer "${computer}" is busy (${what}); waited ${waitMs / 1000} s`,
      );
    }
    await d.sleep(POLL_MS);
  }
}

/**
 * Run `fn` while holding the exclusive input lease of a computer.
 * `check()` renews the lease and throws when it was taken over; the lease is always released.
 */
export async function withInputLease<T>(
  d: LeaseDeps,
  a: { computer: string; botId: BotId; holder: string; waitMs?: number; ttlMs?: number },
  fn: (check: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const ttlMs = a.ttlMs ?? 30_000;
  const hold = await pollFor(d, a.waitMs ?? 60_000, "input", a.computer, () =>
    d.holds.acquire({
      kind: "input",
      computer: a.computer,
      botId: a.botId,
      holder: a.holder,
      ttlMs,
      now: d.clock.now(),
    }),
  );
  const check = async () => {
    const ok = await d.holds.renew({
      key: hold.key,
      holder: hold.holder,
      fence: hold.fence,
      ttlMs,
      now: d.clock.now(),
    });
    if (!ok) throw new ComputerBusyError("lease lost");
  };
  try {
    return await fn(check);
  } finally {
    try {
      await d.holds.release({ key: hold.key, holder: hold.holder, fence: hold.fence });
    } catch {
      // The TTL frees the lease anyway; a release error must not replace fn's result or error.
    }
  }
}

/** Wait for one of `slotLimit` browser slots; fails at once when the machine has none. */
export async function acquireSlot(
  d: LeaseDeps,
  a: {
    computer: string;
    botId: BotId;
    holder: string;
    slotLimit: number;
    slotsText?: string;
    waitMs?: number;
  },
): Promise<ComputerHold> {
  if (a.slotLimit === 0) {
    throw new ComputerBusyError(`no computer slot on this machine: ${a.slotsText ?? ""}`);
  }
  return pollFor(d, a.waitMs ?? 600_000, "slot", a.computer, () =>
    d.holds.acquire({
      kind: "slot",
      computer: a.computer,
      botId: a.botId,
      holder: a.holder,
      ttlMs: 120_000,
      now: d.clock.now(),
      slotLimit: a.slotLimit,
    }),
  );
}

/** Extend a slot hold; false when it was taken over or released. */
export function renewSlot(d: LeaseDeps, hold: ComputerHold, ttlMs = 120_000): Promise<boolean> {
  return d.holds.renew({
    key: hold.key,
    holder: hold.holder,
    fence: hold.fence,
    ttlMs,
    now: d.clock.now(),
  });
}

/** Give a slot back. */
export function releaseSlot(d: LeaseDeps, hold: ComputerHold): Promise<void> {
  return d.holds.release({ key: hold.key, holder: hold.holder, fence: hold.fence });
}
