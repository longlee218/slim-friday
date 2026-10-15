import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage, type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { DRAIN_REPLY, isDraining } from "../../lifecycle/drain";
import { logEvent } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { createRolloverScheduler } from "./rollover-scheduler";
import type { RunLimiter } from "./run-limiter";
import type { SteerRegistry } from "./steer-registry";
import { stopThread } from "./turn-stop";

/** Whether a new turn may start: not draining (deploy) and under the global run cap. `release` frees the slot. */
export function admitTurn(
  limiter: RunLimiter | undefined,
  agentHome: string,
  log: Logger,
  language: OwnerLanguage,
): { release: () => void } | { reply: string } {
  if (isDraining(agentHome)) {
    logEvent(log, "task.refused", { reason: "drain", reply: DRAIN_REPLY });
    return { reply: renderUserNotice({ kind: "failure", cause: "drain" }, language) };
  }
  const release = limiter ? limiter.tryAcquire() : () => {};
  if (!release) {
    logEvent(log, "task.busy", { reason: "run_limit", active: limiter?.active() });
    return { reply: renderUserNotice({ kind: "failure", cause: "busy" }, language) };
  }
  return { release };
}

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

/** `/stop`: abort the wrap-up of the previous turn when no run is active, else the thread's run (audit row first). */
export function stopCommand(c: {
  db: Database;
  message: InboundMessage;
  running?: AbortController;
  rollovers: ReturnType<typeof createRolloverScheduler>;
  steer?: SteerRegistry;
}): string {
  const { message, running } = c;
  // No run, but the previous turn's wrap-up (flush / summary) is working: `/stop` aborts it (the session is kept).
  if (!running && c.rollovers.abort(message.threadId))
    return renderUserNotice({ kind: "stop", active: true }, messageLanguage(message));
  if (running) c.steer?.record(message, message.text, "stop"); // audit; stopThread aborts, the queue stays
  return stopThread(c.db, message.threadId, messageLanguage(message), running);
}
