import { HAIKU_MODEL } from "../../config/model-ids";
import { ARTIFACT_TOOLS } from "../../mcp/artifacts/artifact-tool-names";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import { scoutContract } from "../prompts/contracts/scout-contract";
import type { RoleDefinition } from "../role-types";
import { TEAM_SKILL } from "./specialist-contract";

/** Owner questions per run: a scout answers from what it finds and never asks. */
const MAX_ASK = 0;
/** Budget (USD) of one scout run on the cheap tier. */
const BUDGET_USD = 1.5;
/** Agent loops (SDK turns) one scout run may take. */
const MAX_TURNS = 40;

/**
 * The scout: Haiku, reference search in the locations (files, symbols, call paths, structure) and library docs lookup;
 * changes no location (`sideEffects: "none"`: a report saved by the artifact tool is app-owned data, not a side effect).
 * Web research beyond library docs is the researcher's. Reached only through the lead (`kind: "worker"`, `dispatchable`).
 * Skills are its own list (`skills`).
 */
export const SCOUT_ROLE: RoleDefinition = {
  name: "scout",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Facts inside a location: where something is, how it works, which files touch X; list or summarize files; a library's API as that code uses it. Answers with path:line.",
  notFor: "Changing anything; outside facts not tied to this code.",
  kind: "worker",
  dispatchable: true,
  skills: [TEAM_SKILL, "worker-reporting", "scout", "docs-seeker"],
  preloadSkills: [TEAM_SKILL], // how a run fits the team is in the system prompt
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  sideEffects: "none",
  capabilities: ["read", "web", "shell", "skills"],
  mcpTools: [
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    REPORT_TOOL,
  ],
  noSubagents: true, // subagents: developer and tester only
  permissionMode: "auto",
  model: HAIKU_MODEL,
  budgetUsd: BUDGET_USD,
  promptSections: () => scoutContract(),
};
