import type { InboundMessage } from "../ingress/discord-message-handler";
import { renderStatus } from "../ingress/status-copy";
import { localizeUserCopy, messageLanguage, renderUserNotice } from "../ingress/user-copy";
import { DRAIN_REPLY, isDraining } from "../lifecycle/drain";
import { logEvent, logger, runWithLogContext } from "../observability/logger";
import { ownerConfirm } from "../owner-approval/owner-confirm";
import { purgeThreadTrash } from "./effects/purge-trash";
import { createHandlerServices } from "./handler-services";
import type { TurnHandlerDeps } from "./handler-types";
import { closeThreadAsk } from "./lead/pending-asks";
import { parseMessageCommand } from "./message-commands";
import { statusFacts } from "./turns/status-snapshot";
import { reportCrash, stopCommand } from "./turns/turn-admission";
import { turnLogContext } from "./turns/turn-tracker";
import type { RecoveryReport } from "./worker/recover-in-flight";

/**
 * Build `handleMessage`: Discord-free entry. Commands (`/stop`, `/status`, `/purge`) are answered by app code. Every other owner message goes to the thread's lead (queue): the handler
 * returns nothing and the lead posts its own reply, so the owner hears one voice.
 */
export function createTurnHandler(deps: TurnHandlerDeps) {
  const { config } = deps;
  const log = logger.child({ module: "handle-message" });
  const { tracker, memoryJobs, dispatchDeps, lead, inline, shutdown } = createHandlerServices(
    deps,
    log,
  );
  /** Handle one message and return the reply text to post (undefined = the lead answers on its own). */
  const run = async (message: InboundMessage): Promise<string | undefined> => {
    const { threadId } = message;
    const parsed = parseMessageCommand(message.text);
    logEvent(log, "task.routed", { kind: parsed.kind });
    if (parsed.kind === "stop") {
      return stopCommand({
        db: deps.db,
        message,
        leadQueue: { stop: lead.stopThread, busy: lead.queue.busy },
        steer: dispatchDeps.steer,
      });
    }
    // `/status`: facts of the thread's tasks rendered by app code (no model, no lock, answered while work runs).
    if (parsed.kind === "status")
      return renderStatus(statusFacts(deps.db, threadId), messageLanguage(message));
    // `/purge`: the trash of this thread's goals is emptied after one owner click (app code; the owner-only ingress already filtered the sender).
    if (parsed.kind === "purge") {
      const language = messageLanguage(message);
      // Emptying the trash is final, so the owner confirms with one click.
      return purgeThreadTrash(deps.db, config.agentHome, threadId, language, (summary) =>
        ownerConfirm(deps.approvals, {
          kind: "purge_trash",
          turnId: crypto.randomUUID(),
          threadId,
          summary,
          language,
        }),
      );
    }
    if (isDraining(config.agentHome)) {
      logEvent(log, "task.refused", { reason: "drain", reply: DRAIN_REPLY });
      return renderUserNotice({ kind: "failure", cause: "drain" }, messageLanguage(message));
    }
    const ctx = lead.remember(message);
    if ("refusal" in ctx) return ctx.refusal;
    // A reply to the question message of a waiting task resumes that task; any other message goes to the lead.
    // The owner sees at once that the answer reached the task (the lead may take a while to speak).
    if (lead.answerReply(message))
      return renderUserNotice({ kind: "steer", state: "resumed" }, messageLanguage(message));
    // A plain message while the lead waits on its own question is the answer to it (the lead run would otherwise stay
    // blocked on the question and this message would queue behind it).
    if (closeThreadAsk(threadId, message.text)) return undefined;
    lead.submit(message);
    return undefined;
  };
  const handleMessage = (message: InboundMessage): Promise<string | undefined> =>
    // Every line logged while this call runs (any module, any await) carries the thread id and channel id.
    tracker
      .track(
        runWithLogContext(turnLogContext(message), () =>
          run(message).catch((err: unknown) =>
            // Never throw from the error path (db may be closed during shutdown).
            reportCrash(log, err, {
              location: "*",
              t0: Date.now(),
              language: messageLanguage(message),
            }),
          ),
        ),
      )
      .then((text) =>
        text === undefined ? undefined : localizeUserCopy(text, messageLanguage(message)),
      );
  handleMessage.inline = inline; // same runner for ingress (inline channel replies, #ops-control)
  handleMessage.memoryJobs = memoryJobs; // tests await its drain
  handleMessage.abortAll = shutdown.abortAll;
  handleMessage.drain = shutdown.drain;
  /** Boot: wake the lead of the threads the recovery found work for. */
  handleMessage.wake = (report: RecoveryReport) => lead.wake(report);
  return handleMessage;
}
