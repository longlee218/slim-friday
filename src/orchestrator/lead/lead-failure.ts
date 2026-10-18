import { LEAD_FAILED_NOTICE } from "../budget/lead-budget";
import type { LeadInput } from "./lead-queue";

/** Failed runs allowed per announce batch (key = its event ids): past it the news is dropped, the owner told once. */
const ANNOUNCE_ATTEMPTS = 2;
const failedBatches = new Map<string, number>();

/** A batch ended well or was dropped: forget its failure count. */
export const forgetBatch = (announced: string[]): boolean =>
  failedBatches.delete(announced.join(","));

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
