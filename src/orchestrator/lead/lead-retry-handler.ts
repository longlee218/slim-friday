import { MAX_DISPATCHES_PER_ITEM, MAX_FIX_LOOPS } from "../../config/resilience-caps";
import { ORCHESTRATE_ACTION_RETRY } from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { isHeld } from "../../storage/owned-item-store";
import { fixesAt, isVerifyKey } from "../plan/verify-items";
import { type Reply, refuse } from "../reply";
import { type LeadToolContext, leadCall } from "./lead-call";
import { badTask, ENDED } from "./lead-handlers";
import type { RetryInput } from "./lead-schemas";

/**
 * Orchestrate retry: re-queue a held item (blocked: a failure, a budget hit or a BLOCKED / NEEDS_PLANNING report the lead must decide on). The port moves it `ready` with a fresh
 * automatic-resume budget and records the `retry` event (the note); the next dispatch pass resumes its session. Refused:
 * ENDED (already finished), NOT_HELD (not waiting for a decision), BREAKER (dispatched too many times), VERIFY_LOOP_CAP (a verify that ran and reported FAILED after the last fix loop; a crashed one stays retryable), OVER_BUDGET.
 */
export const handleRetry = (ctx: LeadToolContext, input: RetryInput): Promise<Reply> =>
  leadCall(ctx, ORCHESTRATE_ACTION_RETRY, input, () => {
    const item = ctx.port.item(input.taskId);
    if (!item) return { reply: badTask(input.taskId) };
    if (ENDED.has(item.status))
      return {
        reply: refuse(
          "ENDED",
          `Task already ${item.status}: nothing to do; dispatch new work if the owner wants a rerun.`,
        ),
      };
    if (!isHeld(item))
      return {
        reply: refuse(
          "NOT_HELD",
          "Only a held (blocked) task can be retried; a task waiting for the owner is resumed by Orchestrate steer.",
        ),
      };
    if (item.dispatchCount >= MAX_DISPATCHES_PER_ITEM)
      return {
        reply: refuse(
          "BREAKER",
          `Task was dispatched ${item.dispatchCount} times: no more retries. Cancel it, or tell the owner and re-plan.`,
        ),
      };
    // A verify that RAN and reported FAILED after the last fix loop (it wrote a result file) is the owner's call, not another
    // run. A verify that crashed, went stale or hit its budget / age wrote none: it stays retryable. Loop count = the fix
    // items in the verify's location (the cap is per location).
    if (
      isVerifyKey(item.itemKey) &&
      (item.resultPath || item.resultText) &&
      fixesAt(ctx.port.snapshot(item.id)?.items ?? [], item.location) >= MAX_FIX_LOOPS
    )
      return {
        reply: refuse(
          "VERIFY_LOOP_CAP",
          `Verify failed after ${MAX_FIX_LOOPS} fix loops: ask the owner, or Orchestrate cancel.`,
        ),
      };
    const moved = ctx.port.retry(item.id, input.note);
    if (moved === "over_budget")
      return {
        reply: refuse(
          "OVER_BUDGET",
          "The goal budget is used up: retry would not start. Cancel, or ask the owner what to do (ask_owner).",
        ),
      };
    if (moved === "not_held")
      return { reply: refuse("NOT_HELD", "The task changed state: read its status again.") };
    return { reply: { ok: true, retried: item.id }, itemId: item.id };
  });
