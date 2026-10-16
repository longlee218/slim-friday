import type { OwnerLanguage } from "../../ingress/user-copy";
import type { Location } from "../../locations/location-registry";
import { getLogContext, logEvent, logger, tryLog } from "../../observability/logger";
import { errText } from "../../observability/redact";
import type { ResultKind } from "../../storage/owned-item-store";
import { appendEvent } from "../../storage/thread-event-store";
import { closeTurn } from "../turns/turn-result";
import { failTurn } from "../turns/turn-tracker";
import type { DispatchDeps, RoleRunInput } from "./role-run-types";
import { runRole } from "./run-role";
import { registerTaskRun } from "./task-runs";

/** Logger of this module. */
const log = logger.child({ module: "worker-detached-run" });

/** What `runDetached` needs besides the role input. */
interface DetachedOpts {
  /** Language of the owner-facing notices. */
  language: OwnerLanguage;
  /** Owned task of the run (log + registry + failure event). */
  taskId: string;
  location: string;
  locations: Location[];
  /** Global run slot already taken by the caller: freed when the run ends. */
  slot: () => void;
  /** Typed result the worker reported (read after the run ends): it decides the task status over the derived one. */
  resultKind: () => ResultKind | undefined;
  /** Called last, once the run ended and its slot is free (end event, goal settle, next item). */
  onSettled: () => void;
}

/**
 * Run the role in the background and return at once: the run is registered as a task run, its turn is closed when it
 * ends; a crash is logged, closes the turn row and is appended as a `failure` event. Never throws.
 */
export function runDetached(deps: DispatchDeps, input: RoleRunInput, o: DetachedOpts): void {
  const { db, config } = deps;
  const { turnId, threadId, role, ac } = input;
  const t0 = Date.now();
  const settle = registerTaskRun(o.taskId, { threadId, turnId, role, ac });
  void (async () => {
    try {
      const res = await runRole(deps, input).catch((err: unknown) => {
        failTurn(db, log, turnId); // a crashed run must still release its turn row
        throw err;
      });
      closeTurn(db, { turnId, threadId }, res, {
        language: o.language,
        stopping: deps.stopping(),
        t0,
        location: getLogContext().location ?? o.location, // tool hooks move an unpinned task to the location it worked in
        locations: o.locations,
        agentHome: config.agentHome,
        resultKind: o.resultKind(),
      });
    } catch (err) {
      logEvent(log, "task.detached_failed", { taskId: o.taskId, err: errText(err) }, "error");
      tryLog(log, "failure event append failed", () =>
        appendEvent(db, {
          id: `failure:${turnId}`,
          threadId,
          taskId: o.taskId,
          kind: "failure",
          payload: { error: errText(err) },
        }),
      );
    } finally {
      settle();
      o.slot();
      tryLog(log, "onSettled failed", () => o.onSettled());
    }
  })();
}
