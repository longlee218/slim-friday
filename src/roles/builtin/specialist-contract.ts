import { SONNET_MODEL } from "../../config/model-ids";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import type { RoleDefinition } from "../role-types";
import { ARTIFACT_TOOLS } from "./artifact-tools";
import { WORKER_METHOD_LINE } from "./worker-method";

/* Shared by the roster specialists (solution-architect, designer, tester, devops, humanizer-writer, hacker): one worker
   contract and the fields they all set, so each role file holds only what differs (job, tools, skills, budget). */

/** Owner questions per run: a specialist never asks; it reports NEEDS_CLARIFICATION and the lead asks. */
export const SPECIALIST_MAX_ASK = 0;
/** Budget (USD) of one roster specialist run (one figure for all six; the task ceiling still caps the task). */
export const SPECIALIST_BUDGET_USD = 4;
/** Agent loops (SDK turns) per specialist run. */
export const SPECIALIST_MAX_TURNS = 60;

/** Contract every roster specialist runs under (the role's own job text follows it). Facts and scope only. */
export const SPECIALIST_CONTRACT = `Role: specialist worker dispatched by the lead, for one job from your brief. Your input: the brief and the result files of the items you depend on.
${WORKER_METHOD_LINE}
- Scope: your job and your location(s). No owner contact: if the brief is too unclear to start, report NEEDS_CLARIFICATION with the one question that unblocks you.
- Delivery (push, merge, delete, PR) is the developer's job. The shell does not block these, so do not run them.
- Reporting: use the worker-reporting skill.`;

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
