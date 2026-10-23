import type { Database } from "bun:sqlite";
import {
  ORCHESTRATE_ACTION_DISPATCH,
  orchestrateAudit,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import { excerpt } from "../../observability/logger";
import { GRANT_TOOL, grantRowId } from "../../policy/load-envelope";
import { CHIEF_OF_STAFF } from "../../roles/role-names";
import { appendEffect } from "../../storage/effect-log-store";
import { insertOwnedTask } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import type { DispatchWrite } from "./effect-port";

/**
 * The dispatch transaction (see `EffectPort.dispatch`): goal, items, start events, effect row and grants land
 * together. Returns what to abort after the commit.
 */
export function createDispatchWriter(
  db: Database,
  threadId: string,
  correlationIdIn: string | undefined,
  markCancelled: (taskId: string) => { all: string[] },
): (x: DispatchWrite) => { goalId: string; itemIds: string[]; abort: string[] } {
  return (x) =>
    db.transaction(() => {
      const old = x.supersedes ? markCancelled(x.supersedes) : { all: [], moved: [] };
      const goalId = crypto.randomUUID();
      const correlationId = correlationIdIn ?? goalId;
      insertOwnedTask(db, {
        id: goalId,
        threadId,
        ownerRole: CHIEF_OF_STAFF,
        status: "open",
        scope: excerpt(x.intent, SCOPE_CHARS),
        correlationId,
        structureOwner: "teammate", // DIRECT / DELEGATE: the teammate owns the items
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
          subject: it.subject,
          priority: it.priority ?? 0,
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
            by: "teammate",
            tool: ORCHESTRATE_TOOL,
            action: ORCHESTRATE_ACTION_DISPATCH,
          },
        });
      appendEffect(db, {
        id: x.key,
        threadId,
        goalId,
        tool: orchestrateAudit(ORCHESTRATE_ACTION_DISPATCH),
        scope: "teammate tool call",
        grantedBy: "role",
        result: JSON.stringify({ ok: true, goalId, itemIds }),
      });
      // The grants the owner confirmed are read back by every worker start (the envelope), never kept in memory.
      if (x.grants?.length)
        appendEffect(db, {
          id: grantRowId(goalId),
          threadId,
          goalId,
          tool: GRANT_TOOL,
          scope: JSON.stringify(x.grants),
          grantedBy: "owner",
          result: "granted",
        });
      return { goalId, itemIds, abort: old.all };
    })();
}
