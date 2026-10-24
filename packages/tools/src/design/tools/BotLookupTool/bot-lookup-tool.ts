import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { DesignContext } from "../../design-context";
import { ID_RE, listSkills, SKILL_NAME_RE } from "../../design-util";
import { BOT_LOOKUP_TOOL } from "./constants";
import { BOT_LOOKUP_DESCRIPTION } from "./prompt";

const SHAPE = {
  action: z.enum(["list", "read_bot", "read_skill"]),
  id: z.string().optional().describe("Bot id or skill name for read_bot / read_skill."),
};

/** The text of `list`. */
function list(ctx: DesignContext): string {
  const bots = ctx.botSummaries().map((b) => `- ${b.id}: ${b.name}, ${b.title}`);
  const groups = ctx.groupSummaries().map((g) => `- ${g.id}: ${g.name} (${g.members.join(", ")})`);
  const skills = listSkills(ctx.skillDirs).map((s) => `- ${s.name}: ${s.description}`);
  const none = (l: string[]) => (l.length ? l.join("\n") : "- none");
  return [
    `Bots:\n${none(bots)}`,
    `Groups:\n${none(groups)}`,
    `Skills:\n${none(skills)}`,
    `MCP servers (name one as mcp__<server> in a bot's tools):\n${none(ctx.mcpNames().map((n) => `- ${n}`))}`,
    `Tools:\n${ctx.catalogTools().join(", ")}`,
  ].join("\n\n");
}

/** `BotLookup` for one session: no path comes from the model, only a plain id. */
export function createBotLookupTool(ctx: DesignContext) {
  return tool(BOT_LOOKUP_TOOL, BOT_LOOKUP_DESCRIPTION, SHAPE, async ({ action, id }) => {
    if (action === "list") return textResult(list(ctx));
    if (action === "read_bot") {
      if (!id || !ID_RE.test(id)) return textResult("Refused: id must be a plain bot id.", true);
      const file = ctx.botDirs.map((d) => join(d, `${id}.md`)).find((f) => existsSync(f));
      return file
        ? textResult(readFileSync(file, "utf8"))
        : textResult(`Not found: bot ${id}.`, true);
    }
    if (!id || !SKILL_NAME_RE.test(id))
      return textResult("Refused: id must be a plain skill name.", true);
    const found = listSkills(ctx.skillDirs).find((s) => s.name === id);
    return found
      ? textResult(readFileSync(join(found.dir, "SKILL.md"), "utf8"))
      : textResult(`Not found: skill ${id}.`, true);
  });
}
