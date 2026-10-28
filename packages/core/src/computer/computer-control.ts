import type { BotId } from "../domain/bot";
import type { ComputerHold } from "../ports/store";
import { ComputerBusyError, type LeaseDeps, OWNER_HOLDER } from "./computer-lease";

/** The web page renews its control every this many ms. */
export const CONTROL_RENEW_MS = 10_000;

/** Input TTL: an owner who vanishes loses control after this long. */
const CONTROL_TTL_MS = 30_000;
/** Longest wait for a running bot batch to end (a batch is seconds). */
const TAKE_WAIT_MS = 15_000;
const POLL_MS = 250;

/** Who holds the input lease of a computer. */
export interface ControlState {
  holder: "owner" | "bot" | "none";
  botId?: string;
  expiresAt?: number;
}

/** Take the input lease for the owner; waits up to 15 s for a bot batch. Idempotent. */
export async function takeControl(d: LeaseDeps, computer: string): Promise<ComputerHold> {
  const deadline = d.clock.now() + TAKE_WAIT_MS;
  for (;;) {
    const hold = await d.holds.acquire({
      kind: "input",
      computer,
      botId: OWNER_HOLDER as BotId,
      holder: OWNER_HOLDER,
      ttlMs: CONTROL_TTL_MS,
      now: d.clock.now(),
    });
    if (hold) return hold;
    if (d.clock.now() >= deadline) {
      throw new ComputerBusyError(
        `computer "${computer}" is busy (input); waited ${TAKE_WAIT_MS / 1000} s`,
      );
    }
    await d.sleep(POLL_MS);
  }
}

/** Extend the owner's hold; false when it lapsed or was given back. */
export function renewControl(d: LeaseDeps, hold: ComputerHold): Promise<boolean> {
  return d.holds.renew({
    key: hold.key,
    holder: hold.holder,
    fence: hold.fence,
    ttlMs: CONTROL_TTL_MS,
    now: d.clock.now(),
  });
}

/** Hand the computer back to the bots. */
export function giveBack(d: LeaseDeps, hold: ComputerHold): Promise<void> {
  return d.holds.release({ key: hold.key, holder: hold.holder, fence: hold.fence });
}

/** Who holds the input lease of `computer` right now. */
export async function controlState(d: LeaseDeps, computer: string): Promise<ControlState> {
  const key = `input:${computer}`;
  const h = (await d.holds.live(d.clock.now())).find((x) => x.key === key);
  if (!h) return { holder: "none" };
  if (h.holder === OWNER_HOLDER) return { holder: "owner", expiresAt: h.expiresAt };
  return { holder: "bot", botId: h.botId, expiresAt: h.expiresAt };
}
