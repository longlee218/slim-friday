import { MAX_DISPATCHES_PER_ITEM, MAX_FIX_LOOPS } from "../../config/resilience-caps";
import { RETRY_TASK_TOOL } from "../../mcp/orchestration/tools/RetryTaskTool/constants";
import { isHeld } from "../../storage/owned-item-store";
import { fixesAt, isVerifyKey } from "../plan/verify-items";
import { type Reply, refuse } from "../reply";
import { type LeadToolContext, leadCall } from "./lead-call";
import { badTask, ENDED } from "./lead-handlers";
import type { RetryInput } from "./lead-schemas";

/**
 * RetryTask: re-queue a held item (blocked after a failure the lead must decide on). The port moves it `ready` with a fresh
 * automatic-resume budget and records the `retry` event (the note); the next dispatch pass resumes its session. Refused:
 * ENDED (already finished), NOT_HELD (not waiting for a decision), BREAKER (dispatched too many times), VERIFY_LOOP_CAP (a verify that ran and reported FAILED after the last fix loop; a crashed one stays retryable), OVER_BUDGET.
 */
export const handleRetry = (ctx: LeadToolContext, input: RetryInput): Promise<Reply> =>
  leadCall(ctx, RETRY_TASK_TOOL, input, () => {
    const item = ctx.port.item(input.taskId);
    if (!item) return { reply: badTask(input.taskId) };
    if (ENDED.has(item.status)) return { reply: refuse("ENDED", `Task already ${item.status}.`) };
    if (!isHeld(item))
      return { reply: refuse("NOT_HELD", "Only a held (failed, waiting) task can be retried.") };
    if (item.dispatchCount >= MAX_DISPATCHES_PER_ITEM)
      return {
        reply: refuse(
          "BREAKER",
          `Task was dispatched ${item.dispatchCount} times: no more retries.`,
        ),
      };
    // A verify that RAN and reported FAILED after the last fix loop (it wrote a result file) is the owner's call, not another
    // run. A verify that crashed, went stale or hit its budget / age wrote none: it stays retryable. Loop count = the fix
    // items in the verify's location (the cap is per location).
    if (
      isVerifyKey(item.itemKey) &&
      item.resultPath &&
      fixesAt(ctx.port.snapshot(item.id)?.items ?? [], item.location) >= MAX_FIX_LOOPS
    )
      return {
        reply: refuse(
          "VERIFY_LOOP_CAP",
          `Verify failed after ${MAX_FIX_LOOPS} fix loops: ask the owner, or CancelTask.`,
        ),
      };
    const moved = ctx.port.retry(item.id, input.note);
    if (moved === "over_budget")
      return {
        reply: refuse(
          "OVER_BUDGET",
          "The goal budget is used up: retry would not start. Cancel or tell the owner.",
        ),
      };
    if (moved === "not_held")
      return { reply: refuse("NOT_HELD", "The task changed state: read its status again.") };
    return { reply: { ok: true, retried: item.id }, itemId: item.id };
  });
