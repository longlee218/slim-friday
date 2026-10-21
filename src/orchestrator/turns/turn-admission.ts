import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage, type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { logEvent } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { LeadQueue } from "../lead/lead-queue";
import { liveRunOf } from "../run/live-runs";
import type { SteerRegistry } from "./steer-registry";
import { stopThread } from "./turn-stop";

/** Log the crash of a turn (`task.finished` outcome crashed) and return the owner's generic error reply. Never throws. */
export function reportCrash(
  log: Logger,
  err: unknown,
  t: { location: string; t0: number; language: OwnerLanguage },
): string {
  logEvent(
    log,
    "task.finished",
    { location: t.location, outcome: "crashed", durationMs: Date.now() - t.t0, err: errText(err) },
    "error",
  );
  return renderUserNotice({ kind: "failure" }, t.language);
}

/** `/stop`: abort the thread's run (audit row first), drop its queued lead inputs. */
export function stopCommand(c: {
  db: Database;
  message: InboundMessage;
  steer?: SteerRegistry;
  /** The lead queue: `/stop` drops its queued inputs for the thread. */
  leadQueue?: Pick<LeadQueue, "stop" | "busy">;
}): string {
  const { message } = c;
  const running = liveRunOf(message.threadId); // the lead run, else the thread's newest worker run
  if (running) c.steer?.record(message, message.text, "stop"); // audit; stopThread aborts, the queue stays
  return stopThread(c.db, message.threadId, messageLanguage(message), c.leadQueue);
}
