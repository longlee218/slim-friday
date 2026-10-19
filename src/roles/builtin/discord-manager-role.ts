import { HAIKU_MODEL } from "../../config/model-ids";
import { CREATE_SPACE_OR_CHANNEL_TOOL } from "../../mcp/discord-admin/tools/CreateSpaceOrChannelTool/constants";
import { LIST_SPACES_TOOL } from "../../mcp/discord-admin/tools/ListSpacesTool/constants";
import { WRITE_SPACE_FILE_TOOL } from "../../mcp/discord-admin/tools/WriteSpaceFileTool/constants";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../tools/sdk-tool-names";
import type { RoleDefinition } from "../role-types";

/** Owner questions per run (AskUserQuestion): enough to pick a kind, a name and a confirmation. */
const MAX_ASK = 4;
/** Budget (USD) of one run: a short admin chat on the cheap tier. */
const BUDGET_USD = 0.5;
/** Agent loops (SDK turns) one run may take. */
const MAX_TURNS = 30;

/** Run contract (facts): what the role does and the limits of its three tools (the how-to is its skill). */
const CONTRACT = `Role: server manager, in the owner's private control channel. Does: creates Discord spaces (a private category with channels) and edits a space's or channel's persona files, through the discord-admin tools only (no shell, no web, no file write).
- Create tools only create: nothing is deleted, renamed or re-permissioned; an existing name is refused.
- Each write shows the owner a diff and waits for Yes or No; no answer or No means nothing was written. Say a file changed only when the tool reports it written.
- Questions to the owner: at most ${MAX_ASK} per run (${ASK_USER_QUESTION_TOOL_NAME}; enforced).`;

/** The server manager: a control-channel role (no workspace) that creates spaces/channels and edits persona files through guarded tools. */
export const DISCORD_MANAGER_ROLE: RoleDefinition = {
  name: "discord-manager",
  basePrompt: "custom", // writes no code: no SDK coding preset (its tools are the discord-admin MCP tools, Read and Skill)
  whenToUse:
    "Set up the Discord server: create a space or channel, apply a space kind template, edit persona files. Control channel only.",
  kind: "control",
  skills: ["discord-server-manager"],
  mcpTools: [LIST_SPACES_TOOL, CREATE_SPACE_OR_CHANNEL_TOOL, WRITE_SPACE_FILE_TOOL], // a control run has no memory ctx: no memory tools
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  noSubagents: true, // subagents are developer-only (owner)
  model: HAIKU_MODEL,
  thinking: { type: "disabled" }, // a short admin chat: thinking off keeps it cheap
  budgetUsd: BUDGET_USD,
  sideEffects: "external",
  capabilities: ["read", "skills", "ask"],
  promptSections: () => [CONTRACT],
};
