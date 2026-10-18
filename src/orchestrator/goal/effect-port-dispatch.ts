import type { Database } from "bun:sqlite";
import { DISPATCH_AGENT_TOOL } from "../../mcp/orchestration/tools/DispatchAgentTool/constants";
import { excerpt } from "../../observability/logger";
import { GRANT_TOOL, grantRowId } from "../../policy/load-envelope";
import { LEAD_ROLE } from "../../roles/builtin/lead-role";
import { appendEffect } from "../../storage/effect-log-store";
import { insertOwnedTask } from "../../storage/owned-task-store";
import { appendEvent } from "../../storage/thread-event-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { closeIdleGoals } from "../plan/plan-waves";
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
      closeIdleGoals(db, threadId); // a new goal supersedes an old idle wave goal of the thread
      const goalId = crypto.randomUUID();
      const correlationId = correlationIdIn ?? goalId;
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
