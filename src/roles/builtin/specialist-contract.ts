import { SONNET_MODEL } from "../../config/model-ids";
import { ARTIFACT_TOOLS } from "../../mcp/artifacts/artifact-tool-names";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import type { RoleDefinition } from "../role-types";

/* Shared by the roster specialists (solution-architect, designer, tester, devops, humanizer-writer, hacker) and the
   researcher: the fields they all set, so each role file holds only what differs (contract, tools, skills). The shared
   contract text lives in `worker-contract.ts`; each role's own text in `roles/prompts/contracts/`. */

/** The process skill every working role loads (data): its folder in `.agents/skills`; preloaded into the system prompt and listed in `skills`. */
export const METHOD_SKILL = "using-skills";

/** The team skill every task worker loads (data): how a run fits the team (inputs, hand-offs, failures, limits); preloaded like the method skill. */
export const TEAM_SKILL = "team-protocol";

/** Owner questions per run: a specialist never asks; it reports NEEDS_CLARIFICATION and the lead asks. */
export const SPECIALIST_MAX_ASK = 0;
/** Budget (USD) of one roster specialist run (one figure for all six; the task ceiling still caps the task). */
export const SPECIALIST_BUDGET_USD = 4;
/** Agent loops (SDK turns) per specialist run. */
export const SPECIALIST_MAX_TURNS = 60;

/** Fields all roster specialists share: a dispatchable Sonnet worker with memory read tools and the Report tool, depth 1. */
export const SPECIALIST_BASE = {
  kind: "worker",
  dispatchable: true,
  noSubagents: true, // subagents: developer and tester only (a role opts in with `noSubagents: false`)
  permissionMode: "auto",
  model: SONNET_MODEL,
  limits: { maxAsk: SPECIALIST_MAX_ASK, maxTurns: SPECIALIST_MAX_TURNS },
  subagents: { parallel: 3, depth: 1 },
  budgetUsd: SPECIALIST_BUDGET_USD,
  mcpTools: [
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    REPORT_TOOL,
  ],
} as const satisfies Partial<RoleDefinition>;
