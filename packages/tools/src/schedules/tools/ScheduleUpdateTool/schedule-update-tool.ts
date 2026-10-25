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
  // The description is set again on each optional wrapper so it is not tied to how the schema is converted.
  name: TEXT_FIELDS.name.optional().describe(TEXT_FIELDS.name.description ?? ""),
  task: TEXT_FIELDS.task.optional().describe(TEXT_FIELDS.task.description ?? ""),
  notify: TEXT_FIELDS.notify,
  ...RULE_FIELDS,
  repeat: RULE_FIELDS.repeat
    .optional()
    .describe(`${RULE_FIELDS.repeat.description} Set it only to change the rule.`),
  enabled: z.boolean().optional().describe("false pauses the schedule, true resumes it."),
};

/** The rule fields of the input. */
const RULE_KEYS = ["at", "weekday", "every", "unit", "date"] as const;

/** The refusal when rule fields are sent without `repeat` (the rule is replaced whole, never merged). */
function ruleFieldsWithoutRepeat(i: Record<string, unknown>): string | undefined {
  if (i.repeat !== undefined) return undefined;
  const sent = RULE_KEYS.filter((k) => i[k] !== undefined);
  return sent.length === 0
    ? undefined
    : `Rule fields ${sent.join(", ")} were sent without repeat. To change the rule, send repeat with all the fields it needs.`;
}

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
      const noRepeat = ruleFieldsWithoutRepeat(input);
      if (noRepeat) return textResult(noRepeat, true);
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
