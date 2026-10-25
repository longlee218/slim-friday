import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { RULE_FIELDS, TEXT_FIELDS, toRule } from "../../schedule-input";
import { NO_CONVERSATION, type SchedulesContext, scheduleView } from "../../schedules-context";
import { SCHEDULE_CREATE_TOOL } from "./constants";
import { SCHEDULE_CREATE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  ...TEXT_FIELDS,
  ...RULE_FIELDS,
  timeZone: z
    .string()
    .optional()
    .describe('IANA time zone, e.g. "Asia/Saigon"; default: the owner\'s zone.'),
};

/** `ScheduleCreate` for one session: the target is the conversation of the turn, the author this bot. */
export function createScheduleCreateTool(ctx: SchedulesContext) {
  return tool(
    SCHEDULE_CREATE_TOOL,
    SCHEDULE_CREATE_DESCRIPTION,
    SHAPE,
    async ({ name, task, notify, timeZone, ...ruleInput }) => {
      const conversationId = ctx.conversation();
      if (!conversationId) return textResult(NO_CONVERSATION, true);
      const rule = toRule(ruleInput);
      if (typeof rule === "string") return textResult(rule, true);
      const r = await ctx.board.create(
        {
          name,
          botId: ctx.botId,
          task,
          rule,
          conversationId,
          ...(timeZone !== undefined && { timeZone }),
          ...(notify !== undefined && { notify }),
        },
        { kind: "bot", botId: ctx.botId },
      );
      return r.ok
        ? textResult(JSON.stringify(scheduleView(r.schedule)))
        : textResult(r.error, true);
    },
    {
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      alwaysLoad: true,
    },
  );
}
