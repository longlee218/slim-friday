import type { Database } from "bun:sqlite";
import type { AppServersFactory } from "../../mcp/mcp-servers";
import { PLANNER_MCP_SERVER, WORKER_MCP_SERVER } from "../../mcp/mcp-tool-names";
import { createPlannerServer } from "../../mcp/planner-server";
import { createWorkerServer } from "../../mcp/worker-server";
import { channelDigestBlock } from "../../memory/channel-digest";
import { dispatchableWorkers } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { channelDigest } from "../../storage/thread-store";
import type { ReportSink } from "../../tools/ReportResultTool/report-result-tool";
import type { LeadThreadCtx } from "./lead-runtime";

/**
 * The app MCP servers of ONE worker run, from its role DATA: every worker gets `worker` (ReportResult); a role that lists
 * the `planner` server also gets it, bound to the goal it plans for. No role name is read here.
 */
export function workerServers(o: {
  db: Database;
  role: RoleDefinition;
  sink: ReportSink;
  ctx: LeadThreadCtx;
  threadId: string;
  goalId: string;
}): AppServersFactory {
  const { db, ctx } = o;
  return () => ({
    [WORKER_MCP_SERVER]: createWorkerServer(o.sink),
    ...(o.role.mcpServers?.includes(PLANNER_MCP_SERVER) && {
      [PLANNER_MCP_SERVER]: createPlannerServer({
        db,
        threadId: o.threadId,
        goalId: o.goalId,
        workers: dispatchableWorkers(),
        locations: ctx.locations.map((l) => ({ name: l.name, path: l.path })),
        channelDigest: () =>
          ctx.channelId && (ctx.channelMode ?? "task") === "task"
            ? channelDigestBlock(channelDigest(db, ctx.channelId, o.threadId)).text
            : "",
      }),
    }),
  });
}
