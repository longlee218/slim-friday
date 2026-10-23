import type { InboundMessage } from "../../ingress/inbound-message";
import { logEvent, logger } from "../../observability/logger";
import { itemOfQuestionMessage } from "../../storage/item-question-store";
import { dispatchReady } from "../worker/dispatch-ready";
import { resumeWaiting } from "../worker/resume-waiting";
import { closeAsk } from "./pending-asks";
import type { TeammateRuntime } from "./teammate-runtime";

/** Logger of this module. */
const log = logger.child({ module: "teammate-answer-reply" });

/**
 * A Discord reply to a task's question message: when that task is `waiting_user`, code resumes it with the text as its
 * answer (an `answer` event tells the teammate) and the teammate does not take the message. Returns false = not such a reply
 * (the message goes to the teammate as any other).
 */
export function answerReply(rt: TeammateRuntime, message: InboundMessage): boolean {
  const { db } = rt.deps;
  const itemId =
    message.replyToMessageId &&
    itemOfQuestionMessage(db, message.replyToMessageId, message.threadId);
  if (!itemId || !resumeWaiting(db, itemId, message.text, "owner")) return false;
  closeAsk(message.replyToMessageId as string, message.text); // the teammate's Orchestrate ask_owner on that message ends: buttons gone, run released
  logEvent(log, "teammate.reply_resumed", { threadId: message.threadId, itemId });
  rt.announce(message.threadId); // the teammate reads the owner's answer as news
  void dispatchReady(rt, message.threadId); // and the item starts again
  return true;
}
