import type { InboundMessage } from "../../ingress/discord-message-handler";
import { logEvent, logger } from "../../observability/logger";
import { itemOfQuestionMessage } from "../../storage/item-question-store";
import { dispatchReady } from "../worker/dispatch-ready";
import { resumeWaiting } from "../worker/resume-waiting";
import type { LeadRuntime } from "./lead-runtime";
import { closeAsk } from "./pending-asks";

/** Logger of this module. */
const log = logger.child({ module: "lead-answer-reply" });

/**
 * A Discord reply to a task's question message: when that task is `waiting_user`, code resumes it with the text as its
 * answer (an `answer` event tells the lead) and the lead does not take the message. Returns false = not such a reply
 * (the message goes to the lead as any other).
 */
export function answerReply(rt: LeadRuntime, message: InboundMessage): boolean {
  const { db } = rt.deps;
  const itemId =
    message.replyToMessageId &&
    itemOfQuestionMessage(db, message.replyToMessageId, message.threadId);
  if (!itemId || !resumeWaiting(db, itemId, message.text, "owner")) return false;
  closeAsk(message.replyToMessageId as string, message.text); // the lead's Orchestrate ask_owner on that message ends: buttons gone, run released
  logEvent(log, "lead.reply_resumed", { threadId: message.threadId, itemId });
  rt.announce(message.threadId); // the lead reads the owner's answer as news
  void dispatchReady(rt, message.threadId); // and the item starts again
  return true;
}
