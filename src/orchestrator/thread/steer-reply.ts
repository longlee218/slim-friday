import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import type { DispatchDeps } from "../dispatch/dispatch-role";
import { threadToolApproval } from "./thread-state";

/**
 * Plain user text into the running run's input: no scope, guard, budget or gate changes (see steer-registry.ts).
 * The reply says "received", never that the agent read it (it reads at its next turn boundary). While a tool approval
 * waits it says so (the message is stored and delivered after the decision).
 */
export function steerReply(deps: DispatchDeps, message: InboundMessage, text: string): string {
  const sent = deps.steer?.steer(message, text);
  const state =
    sent?.result === "queued" && threadToolApproval(deps.db, message.threadId)
      ? "waiting"
      : sent?.result === "queued"
        ? "queued"
        : sent?.result === "held"
          ? "held"
          : sent?.result === "full"
            ? "full"
            : "ended";
  return renderUserNotice({ kind: "steer", state }, messageLanguage(message));
}
