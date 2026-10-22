import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { attachmentName, headingTitle } from "../../ingress/attachment-name";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { artifactIdByPath } from "../../storage/artifact-path-store";
import { linkQuestionMessage } from "../../storage/item-question-store";
import { openLinks } from "../../viewer/signed-link";
import type { OwnerAnswer } from "../goal/effect-port";
import type { PortIo } from "../goal/effect-port-db";
import { ASK_OWNER_TIMEOUT_MS } from "./lead-limits";
import { type LeadRuntime, type LeadThreadCtx, postTo } from "./lead-runtime";
import { registerAsk, registerThreadAsk } from "./pending-asks";

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
      let unregister = () => {};
      // No answer within the limit, or `/stop` ends the lead run: the question is dropped.
      const limit = new Promise<undefined>((r) => {
        timer = setTimeout(() => r(undefined), waitMs);
        timer.unref();
        ac.addEventListener("abort", () => r(undefined), { once: true });
      });
      // The owner replied to the question message (not a button): that text answers this ask too.
      let replied: ((text: string) => void) | undefined;
      const repliedP = new Promise<{ replied: string }>((r) => {
        replied = (text) => r({ replied: text });
      });
      // The lead's own select or text question (no task behind it, not a Yes/No): the owner's next plain message in the
      // thread answers it, so the run is not blocked until the limit while that message waits in the queue.
      const unregisterThread =
        !q.taskId && !q.workerAskId && !q.yesno && replied
          ? registerThreadAsk(threadId, replied)
          : () => {};
      const answer = await Promise.race([
        deps.approvals.askChoice({
          turnId,
          threadId,
          question: q.question,
          options: q.options,
          yesno: q.yesno,
          stem: q.stem,
          fileName: q.fileName,
          // A question about a task: a Discord reply to this message answers that task (even after the buttons timed out).
          onMessage: (messageId) => {
            if (!q.taskId) return;
            linkQuestionMessage(deps.db, messageId, threadId, q.taskId);
            if (replied) unregister = registerAsk(messageId, replied);
          },
        }),
        limit,
        repliedP,
      ]).finally(() => {
        clearTimeout(timer);
        unregister();
        unregisterThread();
      });
      if (answer === undefined) {
        deps.approvals.cancelTurn(turnId); // the buttons go away with the wait
        return { timedOut: true };
      }
      if (typeof answer === "object") {
        // The reply already resumed the task (code did it): only the buttons and the lead's wait end here.
        deps.approvals.cancelTurn(turnId);
        return { answer: answer.replied, timedOut: false };
      }
      // An answer to a worker's question reaches the waiting worker too; nobody waiting (stopped, ended) is no success.
      if (q.workerAskId && !relay.answer(q.taskId ?? q.workerAskId, answer))
        return { timedOut: true };
      return { answer, timedOut: false };
    },
    post: async (p) => {
      try {
        const text = p.filePath ? readFileSync(p.filePath, "utf8") : (p.text ?? "");
        // A result file is posted as a file (the lead summarizes it in its own words), never as inline text. A markdown
        // file is named from its `# <title>` heading made filesystem-safe; any other kind (html, code, ...) keeps its real
        // file name, so an html artifact is never posted as `reply.md`.
        if (text.trim() && !ac.aborted)
          await postTo(ctx, text, {
            asFile: !!p.filePath,
            ...(p.filePath && {
              fileName:
                extname(p.filePath).toLowerCase() === ".md"
                  ? attachmentName(headingTitle(text), "md")
                  : basename(p.filePath),
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
