import type { OwnerLanguage } from "../../ingress/user-copy";
import { getLogContext, logEvent, logger, tryLog } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { getItem, type ResultKind } from "../../storage/owned-item-store";
import type { DeliveryExpectation } from "../turns/completion";
import type { ArtifactScope } from "../turns/result-file-save";
import { closeTurn, type FlowResult } from "../turns/turn-result";
import { appendCrashEvent, recoverCrashedRun } from "./detached-crash";
import { liveRunsOf, registerRun } from "./live-runs";
import type { DispatchDeps, RoleRunInput } from "./role-run-types";
import { runAndClose } from "./run-and-close";
import { claimZombieLocation } from "./zombie-claims";

/** Logger of this module. */
const log = logger.child({ module: "run-detached" });

/** What a detached worker run needs besides the role input. */
export interface DetachedOpts {
  /** Language of the owner-facing notices. */
  language: OwnerLanguage;
  /** Owned task of the run (log + registry + failure event). */
  taskId: string;
  location: string;
  /** Delivery effects the worker's envelope grants (its COMPLETED report is checked against the effect log). */
  delivery?: DeliveryExpectation;
  /** Global run slot already taken by the caller: freed when the run ends. */
  slot: () => void;
  /** Typed result the worker reported (read after the run ends): it decides the task status over the derived one. */
  resultKind: () => ResultKind | undefined;
  /** Workspace and channel of the run: its result artifact is stored in that channel. */
  artifactScope?: ArtifactScope;
  /** Title the worker reported (read after the run ends): the heading and file name of its result artifact. */
  resultTitle?: () => string | undefined;
  /** The role changes files of the location: after a force-close the location stays claimed until the run really returns. */
  writer?: boolean;
  /** Goal-item failure policy (see `closeTurn`): a failed run resumes or holds its item instead of failing it. */
  failurePolicy?: (res: FlowResult, status: string) => boolean;
  /**
   * Called last, once the run ended and its slot is free (end event, goal settle, next item). `crash` = the run crashed or
   * was force-closed (error text); `ownerStopped` = the owner's `/stop` aborted it (its end must not wake the lead).
   */
  onSettled: (crash?: string, ownerStopped?: boolean) => void;
}

/**
 * Run the role in the background and return at once: the run is registered as a task run, its turn is closed when it
 * ends; a crash is logged, closes the turn row, settles the item (stored report kept, else the failure policy) and
 * reaches the lead as a `failure` event. A run that ignores its abort is force-closed by the reaper the same way
 * (`forceClose`). Never throws.
 */
export function runDetached(deps: DispatchDeps, input: RoleRunInput, o: DetachedOpts): void {
  const { db, config } = deps;
  const { turnId, threadId, role, ac } = input;
  const t0 = Date.now();
  /** Set once the run is finalized (ended or force-closed): a late finish of a force-closed run must change nothing. */
  let finalized = false;
  /** Location claim of a force-closed writer run, released when the run really returns. */
  let releaseZombie: (() => void) | undefined;
  const settle = registerRun({
    kind: "worker",
    taskId: o.taskId,
    threadId,
    turnId,
    role,
    ac,
    forceClose: () => {
      if (finalized) return;
      // The run may still write: keep its location claimed (the lead hears it in the failure, and again if it stays stuck).
      if (o.writer)
        releaseZombie = claimZombieLocation(o.location, {
          threadId,
          itemId: o.taskId,
          goalId: getItem(db, o.taskId)?.parentId ?? undefined,
        });
      finalize(
        crashed(
          new Error(
            `the run did not exit after its abort${o.writer ? `; its location ${o.location} stays claimed until it returns` : ""}`,
          ),
        ),
      );
    },
  });
  const crashRun = {
    threadId,
    turnId,
    taskId: o.taskId,
    resultKind: o.resultKind,
    failurePolicy: o.failurePolicy,
    agentHome: config.agentHome,
    artifactScope: o.artifactScope,
    resultTitle: o.resultTitle,
  };
  /** Log + recover a crash; returns the error text for the end event, or undefined when the bare event was appended. */
  const crashed = (err: unknown): string | undefined => {
    try {
      logEvent(log, "task.detached_failed", { taskId: o.taskId, err: errText(err) }, "error");
      if (recoverCrashedRun(db, crashRun, err)) return errText(err);
      appendCrashEvent(db, crashRun, err);
      return undefined;
    } catch (inner) {
      // Total: a db error here must never become an unhandled rejection (the process would shut down).
      log.error({ err: errText(inner) }, "crash handling failed");
      return errText(err);
    }
  };
  /** Free the run's registry entry and slot, then settle: once only. */
  const finalize = (crash?: string) => {
    if (finalized) return;
    finalized = true;
    // Read before the registry entry goes: `/stop` marked it.
    const ownerStopped = liveRunsOf(threadId).some((h) => h.turnId === turnId && h.ownerStopped);
    settle();
    o.slot();
    tryLog(log, "onSettled failed", () => o.onSettled(crash, ownerStopped));
  };
  void (async () => {
    let crash: string | undefined;
    try {
      await runAndClose(
        deps,
        input,
        () => {}, // the catch below recovers the item and the turn row
        (res) =>
          finalized
            ? "" // force-closed while it ran: its item is settled already
            : closeTurn(db, { turnId, threadId }, res, {
                language: o.language,
                stopping: deps.stopping(),
                t0,
                location: getLogContext().location ?? o.location, // tool hooks move an unpinned task to the location it worked in
                ...(o.delivery && { delivery: o.delivery }),
                agentHome: config.agentHome,
                ...(o.artifactScope && { artifactScope: o.artifactScope }),
                resultKind: o.resultKind(),
                resultTitle: o.resultTitle?.(),
                ...(o.failurePolicy && { failurePolicy: o.failurePolicy }),
              }),
      );
    } catch (err) {
      if (!finalized) crash = crashed(err);
    } finally {
      finalize(crash);
      releaseZombie?.(); // a force-closed writer run returned (or threw) at last: its location is free
    }
  })();
}
