import { EFFORT_LEVELS } from "@friday/core";
import { z } from "zod";

/** Input of `BotDesign` (one flat shape: `action` says which fields count). */
export const DESIGN_SHAPE = {
  action: z
    .enum(["write_bot", "write_group", "write_skill", "install_skill", "set_mcp"])
    .describe("What to write."),
  id: z.string().optional().describe("Bot id, group id, skill name or MCP server name."),
  name: z.string().optional().describe("Bot display name (one word) or group name."),
  title: z.string().optional(),
  model: z.string().optional(),
  instructions: z
    .string()
    .optional()
    .describe("The bot's instructions (the file body), or the group's shared instructions."),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  workspaces: z
    .array(z.string())
    .optional()
    .describe("Absolute paths of existing dirs the owner gave, for a bot or a group."),
  autonomy: z.enum(["careful", "balanced", "autonomous"]).optional(),
  effort: z.enum(EFFORT_LEVELS).optional().describe("Thinking effort the bot starts at."),
  maxEffort: z
    .enum(EFFORT_LEVELS)
    .optional()
    .describe(
      "Highest effort the bot may raise itself to with SetEffort; needs mcp__chat__SetEffort in tools.",
    ),
  avatar: z.string().optional(),
  members: z.array(z.string()).optional(),
  entryBot: z.string().optional(),
  files: z
    .array(z.object({ path: z.string(), content: z.string() }))
    .optional()
    .describe("Skill files: relative path and text; SKILL.md is required."),
  from: z
    .string()
    .optional()
    .describe("install_skill: absolute path of the skill dir in your scratch dir."),
  source: z.string().optional().describe("install_skill: where it came from, e.g. owner/repo."),
  server: z
    .object({
      type: z.enum(["stdio", "http"]),
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  overwrite: z.boolean().optional().describe("Replace what already exists (ask the owner first)."),
};

/** The parsed input. */
export type DesignArgs = z.infer<z.ZodObject<typeof DESIGN_SHAPE>>;
