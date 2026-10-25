import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { SCHEDULES_MCP_SERVER } from "../mcp-server-names";
import type { SchedulesContext } from "./schedules-context";
import { createScheduleCreateTool } from "./tools/ScheduleCreateTool/schedule-create-tool";
import { createScheduleDeleteTool } from "./tools/ScheduleDeleteTool/schedule-delete-tool";
import { createScheduleListTool } from "./tools/ScheduleListTool/schedule-list-tool";
import { createScheduleUpdateTool } from "./tools/ScheduleUpdateTool/schedule-update-tool";

/**
 * The schedule tools of one session by run kind: a `schedule` run gets only `ScheduleList` (it starts untainted, so
 * it must not change schedules), an `intro` run none, every other run all four.
 */
export function scheduleTools(ctx: SchedulesContext) {
  if (ctx.runKind === "intro") return [];
  if (ctx.runKind === "schedule") return [createScheduleListTool(ctx)];
  return [
    createScheduleListTool(ctx),
    createScheduleCreateTool(ctx),
    createScheduleUpdateTool(ctx),
    createScheduleDeleteTool(ctx),
  ];
}

/** The `schedules` server of one session (built per session, bound to its bot and scope). */
export function schedulesServer(ctx: SchedulesContext) {
  return createSdkMcpServer({ name: SCHEDULES_MCP_SERVER, tools: scheduleTools(ctx) });
}
