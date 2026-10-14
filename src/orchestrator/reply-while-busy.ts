import type { Logger } from "pino";
import type { InboundMessage } from "../ingress/discord-message-handler";
import type { IntentDeps } from "../intent/decide-intent";
import { logEvent } from "../observability/logger";
import { getSession } from "../storage/session-store";
import { channelLocations, selectWorkspace } from "../workspaces/task-workspace";
import type { DispatchDeps } from "./dispatch/dispatch-role";
import { intentTurn } from "./intent-turn";
import type { MessageCommand } from "./message-commands";
import type { EffortFloors } from "./thread/effort-floor";
import { STILL_WORKING } from "./thread/intent-replies";
import type { IntentOutcome } from "./thread/route-by-intent";

/**
 * The thread's run holds the lock. A plain message may steer the running run (or wait until it has started), be answered
 * at once by the side lane (an independent question for a foreground role), be queued as independent work, or answer a
 * pending question (read by L3, intent layer on); everything else is
 * `still working...`. Returns the outcome: a reply text, or `side` for the handler to run next to the task.
 */
export async function replyWhileBusy(c: {
  deps: DispatchDeps;
  log: Logger;
  message: InboundMessage;
  parsed: MessageCommand;
  ac: AbortController;
  intent?: IntentDeps;
  floors: EffortFloors;
}): Promise<Exclude<IntentOutcome, { kind: "run" }>> {
  const picked =
    c.intent && c.parsed.kind === "message"
      ? selectWorkspace(c.deps.config.agentHome, c.message.channelId)
      : undefined;
  const still = (): { kind: "reply"; text: string } => {
    logEvent(c.log, "task.still_working");
    // Never lost: the message is stored even when nothing acts on it.
    if (c.parsed.kind === "message")
      c.deps.steer?.record(c.message, c.message.text, "other", "skipped");
    return { kind: "reply", text: STILL_WORKING };
  };
  if (!c.intent || c.parsed.kind !== "message" || !picked || "reply" in picked) return still();
  const { ws, channel } = picked;
  const out = await intentTurn({
    ...c,
    intent: c.intent,
    workspace: ws.name,
    channel: channel.name,
    locations: channelLocations(ws, channel),
    stored: getSession(c.deps.db, c.message.threadId),
    busy: true,
    cmd: c.parsed,
  });
  // A busy thread never starts a run (the table rows that would give `still working...`); its row is stored already.
  if (out.kind === "run") return { kind: "reply", text: STILL_WORKING };
  if (out.kind === "reply" && out.text === STILL_WORKING) logEvent(c.log, "task.still_working");
  return out;
}
