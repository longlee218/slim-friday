import { readFileSync } from "node:fs";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { ASK_OWNER_TIMEOUT_MS } from "../../tools/AskOwnerTool/constants";
import type { OwnerAnswer } from "./effect-port";
import type { PortIo } from "./effect-port-db";
import { type LeadRuntime, type LeadThreadCtx, postTo } from "./lead-runtime";

/** Logger of this module. */
const log = logger.child({ module: "lead-io" });

/**
 * The IO a lead run's effect port needs: steer a live worker, hand an answer to a waiting worker, ask the owner with
 * buttons (10 min), post text or a result file. A post failure is logged, never thrown into the lead's tool call.
 */
export function createLeadIo(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  threadId: string,
  turnId: string,
  ac: AbortSignal,
  waitMs = ASK_OWNER_TIMEOUT_MS,
): PortIo {
  const { relay, deps } = rt;
  return {
    steerTask: (taskId, text) => deps.steer?.steerTask(taskId, text).result ?? "none",
    answerPending: (taskId, text) => relay.answer(taskId, text),
    askOwner: async (q): Promise<OwnerAnswer> => {
      if (!deps.approvals) return { timedOut: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      // No answer within the limit, or `/stop` ends the lead run: the question is dropped.
      const limit = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), waitMs);
        timer.unref();
        ac.addEventListener("abort", () => r(undefined), { once: true });
      });
      const answer = await Promise.race([
        deps.approvals.askChoice({ turnId, threadId, question: q.question, options: q.options }),
        limit,
      ]).finally(() => clearTimeout(timer));
      if (answer === undefined) {
        deps.approvals.cancelTurn(turnId); // the buttons go away with the wait
        return { timedOut: true };
      }
      // An answer to a worker's question reaches the waiting worker too; nobody waiting (stopped, ended) is no success.
      if (q.workerAskId && !relay.answer(q.taskId ?? q.workerAskId, answer))
        return { timedOut: true };
      return { answer, timedOut: false };
    },
    post: async (p) => {
      try {
        const text = p.filePath ? readFileSync(p.filePath, "utf8") : (p.text ?? "");
        if (text.trim() && !ac.aborted) await postTo(ctx, text);
      } catch (err) {
        logEvent(log, "lead.post_failed", { threadId, err: errText(err) }, "warn");
      }
    },
  };
}
