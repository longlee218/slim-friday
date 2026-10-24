import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { DesignContext } from "../../design-context";
import { Refused } from "../../design-util";
import { botReport, listRuns, overview, readRun } from "../../insight/insight-actions";
import { BOT_INSIGHT_TOOL } from "./constants";
import { BOT_INSIGHT_DESCRIPTION } from "./prompt";

const SHAPE = {
  action: z.enum(["overview", "bot_report", "list_runs", "read_run"]),
  id: z.string().optional().describe("Bot id for bot_report and list_runs."),
  days: z.number().int().min(1).max(365).optional().describe("Window in days (default 30)."),
  filter: z.enum(["failed", "long"]).optional().describe("list_runs: only failed or long turns."),
  messageId: z
    .number()
    .int()
    .optional()
    .describe("read_run: the bot message that closed the turn."),
  before: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("read_run: earlier messages to show (default 10)."),
};

/** `BotInsight` for one session: reads only the engine's own store and the bot files. */
export function createBotInsightTool(ctx: DesignContext) {
  return tool(BOT_INSIGHT_TOOL, BOT_INSIGHT_DESCRIPTION, SHAPE, async (a) => {
    const days = a.days ?? 30;
    try {
      switch (a.action) {
        case "overview":
          return textResult(await overview(ctx, days));
        case "bot_report":
          return textResult(await botReport(ctx, a.id, days));
        case "list_runs":
          return textResult(await listRuns(ctx, a.id, days, a.filter));
        case "read_run":
          return textResult(await readRun(ctx, a.messageId, a.before ?? 10));
      }
    } catch (err) {
      if (err instanceof Refused) return textResult(`Refused: ${err.message}`, true);
      return textResult(`Failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });
}
