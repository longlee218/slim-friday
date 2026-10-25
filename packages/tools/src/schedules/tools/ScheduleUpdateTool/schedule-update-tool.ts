import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { RULE_FIELDS, TEXT_FIELDS, toRule } from "../../schedule-input";
import { type SchedulesContext, scheduleView, scopeOf } from "../../schedules-context";
import { SCHEDULE_UPDATE_TOOL } from "./constants";
import { SCHEDULE_UPDATE_DESCRIPTION } from "./prompt";

/** Input the model sees: the id, then any field to change (no time zone). */
const SHAPE = {
  id: z.string().describe("The schedule's id."),
  name: TEXT_FIELDS.name.optional(),
  task: TEXT_FIELDS.task.optional(),
  notify: TEXT_FIELDS.notify,
  ...RULE_FIELDS,
  repeat: RULE_FIELDS.repeat.optional(),
  enabled: z.boolean().optional().describe("false pauses the schedule, true resumes it."),
};

/** True when a rule field is set without `repeat` (the rule is replaced whole, never merged). */
const ruleFieldWithoutRepeat = (i: Record<string, unknown>) =>
  i.repeat === undefined &&
  ["at", "weekday", "every", "unit", "date"].some((k) => i[k] !== undefined);

/** `ScheduleUpdate` for one session scope. */
export function createScheduleUpdateTool(ctx: SchedulesContext) {
  return tool(
    SCHEDULE_UPDATE_TOOL,
    SCHEDULE_UPDATE_DESCRIPTION,
    SHAPE,
    async (input) => {
      const { id, name, task, notify, enabled, repeat } = input;
      const scope = scopeOf(ctx);
      if (typeof scope === "string") return textResult(scope, true);
      if (ruleFieldWithoutRepeat(input))
        return textResult("To change the rule, send repeat with all the fields it needs.", true);
      const rule = repeat === undefined ? undefined : toRule({ ...input, repeat });
      if (typeof rule === "string") return textResult(rule, true);
      const r = await ctx.board.update(
        id,
        {
          ...(name !== undefined && { name }),
          ...(task !== undefined && { task }),
          ...(notify !== undefined && { notify }),
          ...(rule && { rule }),
          ...(enabled !== undefined && { enabled }),
        },
        scope,
      );
      return r.ok
        ? textResult(JSON.stringify(scheduleView(r.schedule)))
        : textResult(r.error, true);
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  );
}
