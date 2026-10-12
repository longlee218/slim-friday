import type { InboundMessage } from "../../ingress/discord-message-handler";
import { PLAN_NOT_REAPPROVED } from "../../storage/ledger-store";
import type { DispatchDeps } from "../dispatch/dispatch-role";
import {
  STEER_ENDED,
  STEER_FULL,
  STEER_HELD,
  STEER_RECEIVED,
  STEER_WAITING,
} from "./intent-replies";
import { threadToolApproval } from "./thread-state";

/** The steer reply plus, when the task already passed its approved plan, the one-line warning. */
const withPlanNote = (text: string, afterPlan: boolean): string =>
  afterPlan ? `${text}\n${PLAN_NOT_REAPPROVED}` : text;

/**
 * Plain user text into the running stage's input: no scope, guard, budget or gate changes (see steer-registry.ts).
 * The reply says "received", never that the agent read it (it reads at its next turn boundary). While a tool approval
 * waits it says so (the message is stored and delivered after the decision). A steer into work that sits after the
 * approved plan gate says that the plan is NOT approved again for that change.
 */
export function steerReply(deps: DispatchDeps, message: InboundMessage, text: string): string {
  const sent = deps.steer?.steer(message, text);
  if (sent?.result === "held") return withPlanNote(STEER_HELD, sent.afterPlan);
  if (sent?.result === "queued") {
    const waiting = threadToolApproval(deps.db, message.threadId);
    return withPlanNote(waiting ? STEER_WAITING(waiting.tool) : STEER_RECEIVED, sent.afterPlan);
  }
  return sent?.result === "full" ? STEER_FULL : STEER_ENDED;
}
