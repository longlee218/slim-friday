import type { Database } from "bun:sqlite";
import {
  ORCHESTRATE_ACTION_ADD,
  orchestrateAudit,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import { excerpt } from "../../observability/logger";
import { appendEffect } from "../../storage/effect-log-store";
import { editNotStartedItem } from "../../storage/item-edit-store";
import { insertOwnedTask, structureOwnerOf, threadOfTask } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { goalOverBudget } from "../budget/task-budget";
import type { TaskPort } from "./effect-port-item-types";
import { searchTasks, similarOpenWork, taskDetail } from "./task-reads";

/* The task-tool methods of the db-backed EffectPort. */

/** Task methods of one lead run on one thread. */
export function createTaskPort(db: Database, threadId: string, correlationId?: string): TaskPort {
  const mine = (id: string): boolean => threadOfTask(db, id) === threadId;
  return {
    goal: (goalId) =>
      mine(goalId)
        ? { structureOwner: structureOwnerOf(db, goalId), overBudget: goalOverBudget(db, goalId) }
        : undefined,
    // One transaction: the item, its `start` work order (counted in the chain cap like a dispatch) and the audit row.
    addItem: (w) =>
      db.transaction(() => {
        const id = crypto.randomUUID();
        const corr = correlationId ?? w.goalId;
        const it = w.item;
        insertOwnedTask(db, {
          id,
          threadId,
          ownerRole: it.role,
          status: it.status,
          scope: excerpt(it.brief, SCOPE_CHARS),
          correlationId: corr,
          parentId: w.goalId,
          itemKey: it.key,
          dependsOn: it.dependsOn,
          brief: it.brief,
          subject: it.subject,
          priority: it.priority ?? 0,
          ...(it.location && { location: it.location }),
        });
        appendEvent(db, {
          id: `${w.key}:0`,
          threadId,
          kind: "start",
          taskId: w.goalId,
          itemId: id,
          correlationId: corr,
          payload: {
            key: it.key,
            role: it.role,
            strategy: "DELEGATE",
            by: "lead",
            tool: ORCHESTRATE_TOOL,
            action: ORCHESTRATE_ACTION_ADD,
          },
        });
        appendEffect(db, {
          id: w.key,
          threadId,
          goalId: w.goalId,
          itemId: id,
          tool: orchestrateAudit(ORCHESTRATE_ACTION_ADD),
          scope: "lead tool call",
          grantedBy: "role",
          result: JSON.stringify({ ok: true, goalId: w.goalId, itemId: id, status: it.status }), // = the first reply, for a replay
        });
        return id;
      })(),
    editItem: (taskId, edit) => mine(taskId) && editNotStartedItem(db, taskId, edit),
    similar: (drafts, exclude) => similarOpenWork(db, threadId, drafts, exclude),
    detail: (taskId) => taskDetail(db, threadId, taskId),
    search: (query) => searchTasks(db, threadId, query),
  };
}
