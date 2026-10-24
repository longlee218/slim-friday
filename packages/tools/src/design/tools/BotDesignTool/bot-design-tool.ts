import { tool } from "@anthropic-ai/claude-agent-sdk";
import { textResult } from "../../../tool-result";
import { addLesson } from "../../actions/add-lesson";
import { deleteBot } from "../../actions/delete-bot";
import { installSkill } from "../../actions/install-skill";
import { setMcp } from "../../actions/set-mcp";
import { writeBot } from "../../actions/write-bot";
import { writeGroup } from "../../actions/write-group";
import { writeSkill } from "../../actions/write-skill";
import { DESIGN_SHAPE } from "../../design-args";
import type { DesignContext } from "../../design-context";
import { Refused } from "../../design-util";
import { BOT_DESIGN_TOOL } from "./constants";
import { BOT_DESIGN_DESCRIPTION } from "./prompt";

/** `BotDesign` for one session: every write of the config dir goes through here. */
export function createBotDesignTool(ctx: DesignContext) {
  return tool(BOT_DESIGN_TOOL, BOT_DESIGN_DESCRIPTION, DESIGN_SHAPE, async (a) => {
    try {
      switch (a.action) {
        case "write_bot":
          return textResult(writeBot(ctx, a));
        case "write_group":
          return textResult(writeGroup(ctx, a));
        case "write_skill":
          return textResult(writeSkill(ctx, a));
        case "install_skill":
          return textResult(await installSkill(ctx, a));
        case "set_mcp":
          return textResult(setMcp(ctx, a));
        case "add_lesson":
          return textResult(await addLesson(ctx, a));
        case "delete_bot":
          return textResult(deleteBot(ctx, a));
      }
    } catch (err) {
      if (err instanceof Refused) return textResult(`Refused: ${err.message}`, true);
      return textResult(`Failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  });
}
