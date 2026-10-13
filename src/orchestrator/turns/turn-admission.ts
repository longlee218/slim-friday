import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { InboundMessage } from "../../ingress/discord-message-handler";
import { DRAIN_REPLY, isDraining } from "../../lifecycle/drain";
import { logEvent } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { createRolloverScheduler } from "./rollover-scheduler";
import type { RunLimiter } from "./run-limiter";
import type { SteerRegistry } from "./steer-registry";
import { OUTCOME_REPLY } from "./turn-result";
import { stopThread } from "./turn-tracker";

/** Whether a new turn may start: not draining (deploy) and under the global run cap. `release` frees the slot. */
export function admitTurn(
  limiter: RunLimiter | undefined,
  agentHome: string,
  log: Logger,
): { release: () => void } | { reply: string } {
  if (isDraining(agentHome)) {
    logEvent(log, "task.refused", { reason: "drain", reply: DRAIN_REPLY });
    return { reply: DRAIN_REPLY };
  }
  const release = limiter ? limiter.tryAcquire() : () => {};
  if (!release) {
    logEvent(log, "task.busy", { reason: "run_limit", active: limiter!.active() });
    return { reply: `busy, ${limiter!.active()} runs active, try again in a minute` };
  }
  return { release };
}

/** Log the crash of a turn (`task.finished` outcome crashed) and return the owner's generic error reply. Never throws. */
export function reportCrash(log: Logger, err: unknown, t: { repo: string; t0: number }): string {
  logEvent(
    log,
    "task.finished",
    { repo: t.repo, outcome: "crashed", durationMs: Date.now() - t.t0, err: errText(err) },
    "error",
  );
  return OUTCOME_REPLY.error!;
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
    return "Stopping the wrap-up of the previous turn...";
  if (running) c.steer?.record(message, message.text, "stop"); // audit; stopThread aborts, the queue stays
  return stopThread(c.db, message.threadId, running);
}
