import type { ComputerSettings } from "@friday/config";
import type { Clock, ComputerProvider, Log } from "@friday/core";
import { computerSlots } from "./computer-plugins";

/** Least time between two capacity counts after a failed one. */
export const SLOT_RETRY_MS = 30_000;

/** The machine's slot count of one process. */
export interface SlotCount {
  slots(): number;
  text(): string;
  /** Settles once the first count is done (never rejects). */
  ready: Promise<void>;
  /** Waits for the first count; after a failed count, counts again when 30 s have passed (one count at a time). */
  refresh(): Promise<void>;
}

/**
 * Count the slots at start, in the background. A failed count (Docker not running) is 0 slots with the reason and is
 * counted again on a later `refresh` at least 30 s after it; a successful count logs `computer.slots` once.
 */
export function slotCount(d: {
  provider?: ComputerProvider;
  settings?: ComputerSettings;
  /** Why there is no provider (the slot text then). */
  problem: string;
  clock: Clock;
  log: Pick<Log, "warn" | "info">;
}): SlotCount {
  const { provider, settings } = d;
  let slots = 0;
  let text = provider ? "computer slots not computed yet" : d.problem;
  let failedAt: number | undefined;
  let counting: Promise<void> | undefined;
  const count = async (p: ComputerProvider, s: ComputerSettings) => {
    const r = await computerSlots(p, s);
    slots = r.slots;
    text = r.text;
    if (r.failed) {
      failedAt = d.clock.now();
      d.log.warn({ message: r.text }, "computer.problem");
      return;
    }
    failedAt = undefined;
    d.log.info({ slots: r.slots, limitedBy: r.limitedBy, text: r.text }, "computer.slots");
  };
  const ready = provider && settings ? count(provider, settings) : Promise.resolve();
  return {
    slots: () => slots,
    text: () => text,
    ready,
    async refresh() {
      await ready;
      if (counting) return counting;
      if (!provider || !settings || failedAt === undefined) return;
      if (d.clock.now() - failedAt < SLOT_RETRY_MS) return;
      counting = count(provider, settings).finally(() => {
        counting = undefined;
      });
      return counting;
    },
  };
}
