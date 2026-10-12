import type { InboundMessage } from "../../ingress/discord-message-handler";
import type { DispatchDeps } from "../dispatch/dispatch-role";
import {
  STEER_ENDED,
  STEER_FULL,
  STEER_HELD,
  STEER_RECEIVED,
  STEER_WAITING,
} from "./intent-replies";
import { threadToolApproval } from "./thread-state";

/**
 * Plain user text into the running run's input: no scope, guard, budget or gate changes (see steer-registry.ts).
 * The reply says "received", never that the agent read it (it reads at its next turn boundary). While a tool approval
 * waits it says so (the message is stored and delivered after the decision).
 */
export function steerReply(deps: DispatchDeps, message: InboundMessage, text: string): string {
  const sent = deps.steer?.steer(message, text);
  if (sent?.result === "held") return STEER_HELD;
  if (sent?.result === "queued") {
    const waiting = threadToolApproval(deps.db, message.threadId);
    return waiting ? STEER_WAITING(waiting.tool) : STEER_RECEIVED;
  }
  return sent?.result === "full" ? STEER_FULL : STEER_ENDED;
}
