import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import { talksToOwner } from "./run-kind";
import { finishedPreview } from "./run-output";

/**
 * Toast the owner that a run ended without an answer (failed, cut too often, stopped): the same `run.finished`
 * event as an answer, with the notice text as the preview. Nothing for a run that does not talk to the owner
 * (ticket, intro, bot-to-bot). A surface failure never fails the caller.
 */
export function announceNotice(ctx: HubContext, row: WakeRow, text: string): void {
  if (!talksToOwner(row)) return;
  try {
    ctx.deps.surface.notifyFinished({
      conversationId: row.conversationId,
      botId: row.targetBot,
      preview: finishedPreview(ctx, text),
    });
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), wakeId: row.id }, "hub.finished_notice_failed");
  }
}
