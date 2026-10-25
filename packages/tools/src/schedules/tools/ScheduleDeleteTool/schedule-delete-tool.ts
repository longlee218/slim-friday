import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { type SchedulesContext, scopeOf } from "../../schedules-context";
import { SCHEDULE_DELETE_TOOL } from "./constants";
import { SCHEDULE_DELETE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = { id: z.string().describe("The schedule's id.") };

/** `ScheduleDelete` for one session scope: a schedule outside the scope is not found. */
export function createScheduleDeleteTool(ctx: SchedulesContext) {
  return tool(
    SCHEDULE_DELETE_TOOL,
    SCHEDULE_DELETE_DESCRIPTION,
    SHAPE,
    async ({ id }) => {
      const scope = scopeOf(ctx);
      if (typeof scope === "string") return textResult(scope, true);
      const r = await ctx.board.remove(id, scope);
      return r.ok ? textResult(`Deleted schedule ${id}.`) : textResult(r.error, true);
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
  );
}
