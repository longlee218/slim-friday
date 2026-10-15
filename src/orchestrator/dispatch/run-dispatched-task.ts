import type { InboundMessage } from "../../ingress/discord-message-handler";
import { messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import type { Location } from "../../locations/location-registry";
import { logEvent, logger, tryLog } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { ownedTaskOfTurn } from "../../storage/owned-task-store";
import type { RoleRunInput } from "../engine/role-run-types";
import { runRole } from "../engine/run-role";
import { registerTaskRun } from "../engine/task-runs";
import { appendEvent } from "../events/event-store";
import { closeTurn } from "../turns/turn-result";
import { failTurn } from "../turns/turn-tracker";
import type { DispatchDeps } from "./dispatch-role";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-dispatched-task" });

/** What the dispatcher hands over once the task's turn row exists. */
export interface DispatchedRun {
  /** Role run input; `ac` is the dispatch's (thread) controller, replaced by an own one when detached. */
  input: RoleRunInput;
  message: InboundMessage;
  location: string;
  locations: Location[];
  t0: number;
  /** Source answer + start notice, and whether `notify` already posted them. */
  head: string;
  posted: boolean;
  /** Run in the background: return at once, the run keeps going without holding the thread. */
  detach: boolean;
}

/** Run the role, close the turn, return the owner-facing reply (the crash path fails the turn row first). */
async function runAndClose(deps: DispatchDeps, r: DispatchedRun, ac: AbortController) {
  const { db, config } = deps;
  const { turnId, threadId } = r.input;
  const res = await runRole(deps, { ...r.input, ac }).catch((err: unknown) => {
    // The caller's crash path only knows the source row: close this one so its slot is released.
    failTurn(db, log, turnId);
    throw err;
  });
  return closeTurn(db, { turnId, threadId }, res, {
    language: messageLanguage(r.message),
    stopping: deps.stopping(),
    t0: r.t0,
    location: r.location,
    locations: r.locations,
    agentHome: config.agentHome,
  });
}

/**
 * Start the task's role run. Attached (default): the caller waits for the run and gets the reply, as before.
 * Detached: the run has its own controller and global slot, is registered as a task run, and this returns the head
 * at once; the result is posted through `notify` when it ends, a crash is logged and appended as a `failure` event.
 */
export async function runDispatchedTask(deps: DispatchDeps, r: DispatchedRun): Promise<string> {
  const { db } = deps;
  const { turnId, threadId, role } = r.input;
  const taskId = ownedTaskOfTurn(db, turnId) ?? turnId;
  if (!r.detach) {
    const settle = registerTaskRun(taskId, { threadId, turnId, role, ac: r.input.ac });
    try {
      const reply = await runAndClose(deps, r, r.input.ac);
      return r.posted ? reply : `${r.head}\n\n${reply}`;
    } finally {
      settle();
    }
  }
  const release = deps.limiter ? deps.limiter.tryAcquire() : () => {};
  if (!release) {
    failTurn(db, log, turnId);
    logEvent(log, "task.busy", {
      reason: "run_limit",
      detached: true,
      active: deps.limiter?.active(),
    });
    return renderUserNotice({ kind: "failure", cause: "busy" }, messageLanguage(r.message));
  }
  const ac = new AbortController();
  const settle = registerTaskRun(taskId, { threadId, turnId, role, ac });
  void (async () => {
    try {
      const reply = await runAndClose(deps, r, ac);
      // The task is complete here: a failed post is logged, never turned into a `failure` event.
      await r.message.notify?.(reply).catch((err: unknown) => {
        logEvent(log, "task.detached_notify_failed", { taskId, err: errText(err) }, "warn");
      });
    } catch (err) {
      logEvent(log, "task.detached_failed", { taskId, err: errText(err) }, "error");
      tryLog(log, "failure event append failed", () =>
        appendEvent(db, {
          id: `failure:${turnId}`,
          threadId,
          taskId,
          kind: "failure",
          payload: { error: errText(err) },
        }),
      );
    } finally {
      settle();
      release();
    }
  })();
  return r.posted ? "" : r.head;
}
