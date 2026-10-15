import type { Database } from "bun:sqlite";
import { DISPATCH_AGENT_TOOL } from "../../mcp/mcp-tool-names";
import { excerpt } from "../../observability/logger";
import { LEAD_ROLE } from "../../roles/builtin/lead-role";
import { appendEffect } from "../../storage/effect-log-store";
import { childrenOf, getItem, type ItemRow } from "../../storage/owned-item-store";
import { insertOwnedTask, threadOfTask } from "../../storage/owned-task-store";
import { moveTaskTo, SCOPE_CHARS } from "../../tasks/task-resolver";
import { appendEvent } from "../events/event-store";
import type { PolicyEnv } from "../strategy/caps";
import type {
  DispatchResult,
  DispatchWrite,
  EffectPort,
  OwnerAnswer,
  OwnerQuestion,
  Post,
  SteerReply,
} from "./effect-port";
import {
  cancelSet,
  goalCaps,
  openGoalIdOf,
  pendingQuestionOf,
  snapshotOf,
} from "./effect-port-queries";
import { taskRunOf } from "./task-runs";

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
  /** Clock (tests pass a fixed one): "today" for the daily lead budget. */
  now?: () => number;
}

/** The port plus what the lead runner reads after the run. */
export interface DbEffectPort extends EffectPort {
  /** The escalation the lead asked for in this run, or undefined. */
  escalation(): { to: "high" | "opus"; reason: string } | undefined;
}

/** Create the db-backed port of one lead run on one thread. */
export function createDbEffectPort(d: PortDeps): DbEffectPort {
  const { db, threadId } = d;
  let escalation: { to: "high" | "opus"; reason: string } | undefined;
  const mine = (id: string): boolean => threadOfTask(db, id) === threadId;

  /** Move the whole cancel set to `cancelled` (CAS: an ended task keeps its status); returns the set to abort. */
  const markCancelled = (taskId: string): { all: string[]; moved: string[] } => {
    const all = cancelSet(db, taskId);
    return { all, moved: all.filter((id) => moveTaskTo(db, id, "cancelled")) };
  };
  const abortRuns = (ids: string[]): void => {
    for (const id of ids) taskRunOf(id)?.ac.abort();
  };

  /** The dispatch transaction (see `EffectPort.dispatch`); returns what to abort after the commit. */
  const writeDispatch = (x: DispatchWrite) =>
    db.transaction(() => {
      const old = x.supersedes ? markCancelled(x.supersedes) : { all: [], moved: [] };
      const goalId = crypto.randomUUID();
      const correlationId = d.correlationId ?? goalId;
      insertOwnedTask(db, {
        id: goalId,
        threadId,
        ownerRole: LEAD_ROLE.name,
        status: "open",
        scope: excerpt(x.intent, SCOPE_CHARS),
        correlationId,
      });
      const itemIds = x.items.map((it) => {
        const id = crypto.randomUUID();
        insertOwnedTask(db, {
          id,
          threadId,
          ownerRole: it.role,
          status: it.status,
          scope: excerpt(it.brief, SCOPE_CHARS),
          correlationId,
          parentId: goalId,
          itemKey: it.key,
          dependsOn: it.dependsOn,
          brief: it.brief,
          ...(it.location && { location: it.location }),
        });
        return id;
      });
      for (const [i, it] of x.items.entries())
        appendEvent(db, {
          id: `${x.key}:${i}`,
          threadId,
          kind: "start",
          taskId: goalId,
          itemId: itemIds[i],
          correlationId,
          payload: {
            key: it.key,
            role: it.role,
            strategy: x.strategy,
            reason: x.reason,
            by: "lead",
            tool: DISPATCH_AGENT_TOOL,
          },
        });
      appendEffect(db, {
        id: x.key,
        threadId,
        goalId,
        tool: DISPATCH_AGENT_TOOL,
        scope: "lead tool call",
        grantedBy: "role",
        result: JSON.stringify({ ok: true, goalId, itemIds }),
      });
      return { goalId, itemIds, abort: old.all };
    })();

  return {
    recall: (key) =>
      db.query<{ r: string }, [string]>("SELECT result AS r FROM effect_log WHERE id = ?").get(key)
        ?.r,
    remember: (key, e) => {
      appendEffect(db, {
        id: key,
        threadId,
        ...(e.goalId && { goalId: e.goalId }),
        ...(e.itemId && { itemId: e.itemId }),
        tool: e.tool,
        scope: "lead tool call",
        grantedBy: "role",
        result: e.reply,
      });
    },
    state: () => {
      const openGoalId = openGoalIdOf(db, threadId);
      return {
        ...(openGoalId && { openGoalId }),
        items: openGoalId ? childrenOf(db, openGoalId) : [],
      };
    },
    caps: () => goalCaps(db, threadId, (d.now ?? Date.now)()),
    env: () => d.env,
    snapshot: (taskId) => (taskId && !mine(taskId) ? undefined : snapshotOf(db, threadId, taskId)),
    item: (taskId): ItemRow | undefined => (mine(taskId) ? getItem(db, taskId) : undefined),
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
    appendEvent: (e) => appendEvent(db, { ...e, threadId }),
    steer: (taskId, text): SteerReply => {
      if (pendingQuestionOf(db, taskId) && d.io.answerPending?.(taskId, text)) return "answered";
      const r = d.io.steerTask(taskId, text);
      return r === "none" ? "ended" : r;
    },
    cancel: (taskId) => {
      const { all, moved } = markCancelled(taskId);
      abortRuns(all);
      return moved;
    },
    askOwner: (q) => d.io.askOwner(q),
    post: (p) => d.io.post(p),
    requestEscalation: (to, reason) => {
      if (escalation) return false;
      escalation = { to, reason };
      return true;
    },
    escalation: () => escalation,
  };
}
