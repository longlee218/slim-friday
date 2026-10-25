import { tool } from "@anthropic-ai/claude-agent-sdk";
import { textResult } from "../../../tool-result";
import { type SchedulesContext, scheduleView, scopeOf } from "../../schedules-context";
import { SCHEDULE_LIST_TOOL } from "./constants";
import { SCHEDULE_LIST_DESCRIPTION } from "./prompt";

/** `ScheduleList` for one session scope. */
export function createScheduleListTool(ctx: SchedulesContext) {
  return tool(
    SCHEDULE_LIST_TOOL,
    SCHEDULE_LIST_DESCRIPTION,
    {},
    async () => {
      const scope = scopeOf(ctx);
      if (typeof scope === "string") return textResult(scope, true);
      const all = await ctx.board.list(scope);
      return textResult(all.length === 0 ? "No schedules." : JSON.stringify(all.map(scheduleView)));
    },
    { annotations: { readOnlyHint: true } },
  );
}
