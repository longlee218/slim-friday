import { LEAD_FAILED_NOTICE } from "../budget/lead-budget";
import type { LeadInput } from "./lead-queue";

/** Failed runs allowed per announce batch (key = its event ids): past it the news is dropped, the owner told once. */
const ANNOUNCE_ATTEMPTS = 2;
const failedBatches = new Map<string, number>();
/** Re-arms of a limit-stopped batch (own budget: a re-run that then errors still gets its retry from `failed`). */
const rearmedBatches = new Map<string, number>();

/** A batch ended well or was dropped: forget its failure count. */
export const forgetBatch = (announced: string[]): boolean => {
  rearmedBatches.delete(announced.join(","));
  return failedBatches.delete(announced.join(","));
};

/** A lead run failed: an owner input gets the notice at once; an announce batch is retried (true) until the cap. */
export async function failed(
  post: (text: string) => Promise<void>,
  input: LeadInput,
  announced: string[],
): Promise<boolean> {
  if (input.kind === "announce") {
    const key = announced.join(",");
    const n = (failedBatches.get(key) ?? 0) + 1;
    if (n < ANNOUNCE_ATTEMPTS) {
      failedBatches.set(key, n);
      return true;
    }
  }
  await post(LEAD_FAILED_NOTICE);
  return false;
}

/**
 * A lead run stopped (turn or budget limit) with its news unread: arm the announce again (true), at most as often as a
 * failed batch is retried (its own count, apart from `failed`). Past the cap the news stays pending until the next event or owner message.
 */
export function rearm(announced: string[]): boolean {
  const key = announced.join(",");
  const n = (rearmedBatches.get(key) ?? 0) + 1;
  if (n >= ANNOUNCE_ATTEMPTS) {
    rearmedBatches.delete(key);
    return false;
  }
  rearmedBatches.set(key, n);
  return true;
}
