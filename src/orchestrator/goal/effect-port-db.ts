import type { Database } from "bun:sqlite";
import { taskStoreArtifacts } from "../../storage/artifact-list-store";
import { appendEffect, effectResult } from "../../storage/effect-log-store";
import { childrenOf, getItem, goalOf, type ItemRow } from "../../storage/owned-item-store";
import { structureOwnerOf, threadOfTask } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { closePendingPlans } from "../../storage/work-plan-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { waveHeldGoalOf } from "../plan/plan-waves";
import { runOfTask } from "../run/live-runs";
import type { PolicyEnv } from "../strategy/caps";
import { resumeWaiting } from "../worker/resume-waiting";
import type {
  DispatchResult,
  EffectPort,
  OwnerAnswer,
  OwnerQuestion,
  Post,
  SteerReply,
} from "./effect-port";
import { createDispatchWriter } from "./effect-port-dispatch";
import { createPlanPort } from "./effect-port-plan";
import {
  cancelSet,
  goalCaps,
  openGoalIdOf,
  pendingQuestionOf,
  snapshotOf,
} from "./effect-port-queries";
import { cancelHeld, createRetryPort } from "./effect-port-retry";

/* The real EffectPort: db reads and writes are here; the IO that needs Discord or a live run is injected. */

/** IO the db cannot do itself (wired by the lead runner). */
export interface PortIo {
  /** Push text into a task's live run: the steer registry's `steerTask` result (`none` = no run takes it). */
  steerTask(taskId: string, text: string): "queued" | "held" | "full" | "none";
  /** Hand the text to a worker that waits on a question; true = it was resolved. Omitted = never resolves one. */
  answerPending?(taskId: string, text: string): boolean;
  askOwner(q: OwnerQuestion): Promise<OwnerAnswer>;
  post(p: Post): Promise<void>;
}

/** What the port is built from (per lead run). */
export interface PortDeps {
  db: Database;
  threadId: string;
  correlationId?: string;
  /** Registry facts for the dispatch policy (dispatchable roles, workspace locations). */
  env: PolicyEnv;
  io: PortIo;
}

/** Create the db-backed port of one lead run on one thread. */
export function createDbEffectPort(d: PortDeps): EffectPort {
  const { db, threadId } = d;
  const mine = (id: string): boolean => threadOfTask(db, id) === threadId;

  /** Move the whole cancel set to `cancelled` (CAS: an ended task keeps its status); returns the set to abort. */
  const markCancelled = (taskId: string): { all: string[]; moved: string[] } => {
    const all = cancelSet(db, taskId);
    // A plan waiting for the owner dies with its GOAL: a later approve must create nothing. Cancelling one item (a stuck
    // task, a planner) leaves the goal's plan versions alone, same as `cancelHeld`.
    if (goalOf(db, taskId) === undefined) closePendingPlans(db, taskId, "cancelled");
    return { all, moved: all.filter((id) => moveTaskTo(db, id, "cancelled")) };
  };
  const abortRuns = (ids: string[]): void => {
    for (const id of ids) runOfTask(id)?.ac.abort();
  };

  const writeDispatch = createDispatchWriter(db, threadId, d.correlationId, markCancelled);

  return {
    recall: (key) => effectResult(db, key),
    remember: (key, e) => {
      appendEffect(db, {
        id: key,
        threadId,
        ...(e.goalId && { goalId: e.goalId }),
        ...(e.itemId && { itemId: e.itemId }),
        tool: e.tool,
        scope: e.scope ?? "lead tool call",
        grantedBy: e.grantedBy ?? "role",
        result: e.reply,
        ...(e.createdAt !== undefined && { createdAt: e.createdAt }),
      });
    },
    state: () => {
      const openGoalId = openGoalIdOf(db, threadId);
      const waveHeldGoalId = openGoalId ? undefined : waveHeldGoalOf(db, threadId);
      return {
        ...(openGoalId && { openGoalId, structureOwner: structureOwnerOf(db, openGoalId) }),
        ...(waveHeldGoalId && { waveHeldGoalId }),
        items: openGoalId ? childrenOf(db, openGoalId) : [],
      };
    },
    caps: () => goalCaps(db, threadId),
    env: () => d.env,
    snapshot: (taskId) => (taskId && !mine(taskId) ? undefined : snapshotOf(db, threadId, taskId)),
    item: (taskId): ItemRow | undefined => (mine(taskId) ? getItem(db, taskId) : undefined),
    resultFiles: (taskId) =>
      mine(taskId) ? taskStoreArtifacts(db, taskId).map((a) => a.path) : [],
    dispatch: (x): DispatchResult => {
      // Only the thread's own open goal may be replaced (a foreign or stale id changes nothing).
      if (x.supersedes && (!mine(x.supersedes) || x.supersedes !== openGoalIdOf(db, threadId)))
        return {
          ok: false,
          code: "BAD_TASK",
          message: `Goal ${x.supersedes} is not this thread's open goal.`,
        };
      const w = writeDispatch(x);
      abortRuns(w.abort); // after the commit: a rolled-back dispatch aborts nothing
      return { ok: true, goalId: w.goalId, itemIds: w.itemIds };
    },
    ...createPlanPort(db, threadId, d.correlationId),
    ...createRetryPort(db, threadId),
    appendEvent: (e) => appendEvent(db, { ...e, threadId }),
    steer: (taskId, text): SteerReply => {
      if (pendingQuestionOf(db, taskId) && d.io.answerPending?.(taskId, text)) return "answered";
      // A `waiting_user` item has no run: the lead's answer re-queues it (the lead's own answer event is no news).
      if (resumeWaiting(db, taskId, text, "lead")) return "resumed";
      const r = d.io.steerTask(taskId, text);
      return r === "none" ? "ended" : r;
    },
    cancel: (taskId) => {
      const held = cancelHeld(db, taskId); // a held failure the lead gives up: failed + dependents cancelled
      if (held) return held;
      const { all, moved } = markCancelled(taskId);
      abortRuns(all);
      return moved;
    },
    askOwner: (q) => d.io.askOwner(q),
    post: (p) => d.io.post(p),
  };
}
