import { MAX_DISPATCHES_PER_ITEM } from "../../config/resilience-caps";
import { RETRY_TASK_TOOL } from "../../mcp/orchestration/tools/RetryTaskTool/constants";
import { isHeld } from "../../storage/owned-item-store";
import { type Reply, refuse } from "../reply";
import { type LeadToolContext, leadCall } from "./lead-call";
import { badTask, ENDED } from "./lead-handlers";
import type { RetryInput } from "./lead-schemas";

/**
 * RetryTask: re-queue a held item (blocked after a failure the lead must decide on). The port moves it `ready` with a fresh
 * automatic-resume budget and records the `retry` event (the note); the next dispatch pass resumes its session. Refused:
 * ENDED (already finished), NOT_HELD (not waiting for a decision), BREAKER (dispatched too many times), OVER_BUDGET.
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
