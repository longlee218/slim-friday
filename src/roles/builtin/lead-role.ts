import { SONNET_MODEL } from "../../config/model-ids";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SAVE_TOOL } from "../../mcp/memory/tools/MemorySaveTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { ORCHESTRATE_TOOL } from "../../mcp/orchestration/tools/OrchestrateTool/constants";
import {
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LSP_TOOL_NAME,
  READ_TOOL_NAME,
  SKILL_TOOL_NAME,
} from "../../tools/sdk-tool-names";
import type { RoleDefinition } from "../role-types";
import { ARTIFACT_TOOLS } from "./artifact-tools";

/** The lead's method skill: its folder name in `.agents/skills` (data) and the qualified name the Skill tool takes (`friday:<name>`). */
const LEAD_SKILL = "lead-orchestration";
const LEAD_SKILL_REF = `friday:${LEAD_SKILL}`;

/** The lead asks the owner through its own `Orchestrate ask_owner` action, never AskUserQuestion. */
const MAX_ASK = 0;
/** Budget (USD) of one lead run (a short routing turn). There is no daily lead budget. */
const BUDGET_USD = 1.5;
/** Agent loops (SDK turns) one lead run may take. */
const MAX_TURNS = 30;

/**
 * Run contract (runtime facts and safety only): tools, how the reply is delivered, secrets and privacy. Tone, voice and
 * format style are the owner's (AGENTS.md, SOUL.md). The team (TEAM.md, built per run), the owner's layers and the data
 * block are added by the runner. The delivery line mirrors `src/ingress/reply-bubbles.ts` and `inline-report.ts`.
 */
const CONTRACT = `Role: lead of the team in this thread; name and persona: IDENTITY.md (below).
Tools: memory, artifact and ${ORCHESTRATE_TOOL} actions; read-only ${READ_TOOL_NAME}, ${GLOB_TOOL_NAME}, ${GREP_TOOL_NAME}, ${LSP_TOOL_NAME} and ${SKILL_TOOL_NAME}. No shell, no file writes, no web. Members do the work.
Method for dispatch, plan, retry, cancel and event decisions: skill ${LEAD_SKILL_REF}; load it before such a decision.
A PLAN goal's items belong to the planner: add or update on them is refused. Code adds verify, fix and wave items.
Output (code): your final text reply is posted to the owner, redacted, as Discord messages. Each paragraph (a blank-line block) is one message, at most 4; extra paragraphs join the 4th. A reply over 800 characters, or with a table, is one inline message (max 3900). Text after a line \`---\` is an attached file, named from the first \`# <title>\` in that text (else \`reply\`); a code block over 10 lines also makes a file.
Only your reply and what ${ORCHESTRATE_TOOL} posts (ask_owner, forward) reach the owner; tool results and events do not.
Never claim work that was not done, or a memory save that the tool did not confirm.
In a shared channel, memory and private data of another person or channel never appear in a reply.`;

/**
 * The lead: Sonnet. Chosen by the lead runner (not by `entryRole`), reached only through it (`kind: "lead"`), so intent
 * routing never offers it. Its tools are the `orchestration` server's lead tools (typed actions; handlers hold the rules).
 */
export const LEAD_ROLE: RoleDefinition = {
  name: "lead",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse: "Routes the owner's messages to specialist workers and reports their results.",
  kind: "lead",
  skills: [LEAD_SKILL], // the app-owned method skill; needs the `skills` capability for the Skill tool
  // Memory tools + the lead's `Orchestrate` action tool (the `orchestration` server; a worker run never gets it).
  mcpTools: [
    MEMORY_SAVE_TOOL,
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    ORCHESTRATE_TOOL,
  ],
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  sideEffects: "none",
  capabilities: ["read", "skills"],
  noSubagents: true, // the lead dispatches through its tools only
  permissionMode: "auto",
  model: SONNET_MODEL,
  thinking: { type: "adaptive" }, // the model decides how long to think (a short routing turn)
  budgetUsd: BUDGET_USD,
  promptSections: () => [CONTRACT],
};
