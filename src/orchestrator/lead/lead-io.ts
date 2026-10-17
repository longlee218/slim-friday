import { readFileSync } from "node:fs";
import { attachmentName, headingTitle } from "../../ingress/attachment-name";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { artifactIdByPath } from "../../storage/artifact-path-store";
import { openLinks } from "../../viewer/signed-link";
import type { OwnerAnswer } from "../goal/effect-port";
import type { PortIo } from "../goal/effect-port-db";
import { ASK_OWNER_TIMEOUT_MS } from "./lead-limits";
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
        deps.approvals.askChoice({
          turnId,
          threadId,
          question: q.question,
          options: q.options,
          yesno: q.yesno,
        }),
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
        // A result file is posted as a file (the lead summarizes it in its own words), never as inline text; its
        // name is its `# <title>` heading made filesystem-safe.
        if (text.trim() && !ac.aborted)
          await postTo(ctx, text, {
            asFile: !!p.filePath,
            ...(p.filePath && {
              fileName: attachmentName(headingTitle(text), "md"),
              // The artifact of that file opens in the viewer (no links when the viewer is off or the file is no artifact).
              links: openLinks(deps.config.viewer, artifactIdByPath(deps.db, p.filePath)),
            }),
          });
      } catch (err) {
        logEvent(log, "lead.post_failed", { threadId, err: errText(err) }, "warn");
      }
    },
  };
}
