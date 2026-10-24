import { ENV_REF_EXAMPLE } from "../../design-util";

/** Description the model reads for `BotDesign`. */
export const BOT_DESIGN_DESCRIPTION =
  "Write the owner's config: a bot file, a group file, a skill, an installed skill or an MCP server. " +
  "Every call asks the owner first. You give fields, never paths: the tool picks the place, checks every field and " +
  "refuses what is not valid (read the refusal and fix the input). " +
  "write_bot: id, name (one word), title, model, instructions, optional tools, skills, workspaces, autonomy, effort, maxEffort, avatar, subagents (background helpers; their tools must be among the bot's tools). " +
  "write_group: id, name, members, entryBot, optional workspaces (first = main project), instructions. " +
  "write_skill: id (skill name), files (SKILL.md plus others). " +
  "install_skill: id, from (absolute path of the skill dir inside your scratch dir), source (e.g. owner/repo). " +
  `set_mcp: id (server name), server ({type: stdio|http, ...}); env and header values only as ${ENV_REF_EXAMPLE}. ` +
  "add_lesson: id (bot), lesson (one line, at most 300 chars) under Lessons in that bot's memory. " +
  "delete_bot: id; moves the bot file and its memory to the trash for 7 days; refused while the bot is in a group. " +
  "overwrite: true replaces what exists; use it only after the owner said yes to replacing.";
