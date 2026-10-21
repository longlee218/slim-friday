import { SONNET_MODEL } from "../../config/model-ids";
import { ARTIFACT_TOOLS } from "../../mcp/artifacts/artifact-tool-names";
import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "../../mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../../mcp/effects/tools/MergeBranchTool/constants";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import {
  askRules,
  CODE_STANDARDS,
  COMMIT_RULES,
  DEVELOPER,
  DEVELOPER_STOP_RULES,
  DEVELOPER_WORK,
  developerEnvironment,
  developerOwnerContact,
} from "../prompts/contracts/developer-contract";
import type { Capability, RoleDefinition } from "../role-types";
import { METHOD_SKILL } from "./specialist-contract";
import { workerTeamFacts } from "./worker-contract";

/** Owner questions (the ask tool) one run may make. Wired: ask guard + prompt text. */
const MAX_ASK = 6;
/** Budget (USD) of one developer run (the task ceiling `TASK_BUDGET_USD` still caps the task over its resumes). */
const BUDGET_USD = 8;
/** Agent loops (SDK turns) one developer run may take. */
const MAX_TURNS = 150;
/** Subagents of one run (parallel cap; depth 1 = a subagent starts none); no total cap, the run budget bounds a fan-out. */
const SUBAGENTS = { parallel: 3, depth: 1 };

export { askRules, CODE_STANDARDS, COMMIT_RULES, DEVELOPER, DEVELOPER_WORK };

/** Capabilities of a code task: the guard narrows what a call may do. */
const CODE_CAPABILITIES: Capability[] = [
  "read",
  "write",
  "shell",
  "skills",
  "tasks",
  "mcp",
  "review",
  "feedback",
  "ask",
];

/**
 * Code changes: ONE run in the location's own checkout. Brainstorm, plan, the owner's approval (the ask tool), implement,
 * verify and deliver (commit, push, PR as the owner chose) come from the skills and the run facts: no code enforces an order.
 */
export const DEVELOPER_ROLE: RoleDefinition = {
  name: "developer",
  whenToUse:
    "Implement, fix, refactor, add unit tests of its own change in a location; delivers (merge, PR or keep) after the owner chose. Design or a plan goes to the solution-architect, designer or planner.",
  kind: "worker",
  dispatchable: true, // the lead may start it as a worker
  // Memory read tools (the lead alone saves), the Report tool and the effect tools (a run without the effects ctx just lacks them).
  mcpTools: [
    MEMORY_SEARCH_TOOL,
    MEMORY_GET_TOOL,
    MEMORY_EXPAND_TOOL,
    ...ARTIFACT_TOOLS,
    REPORT_TOOL,
    DELETE_PATHS_TOOL,
    GIT_PUSH_TOOL,
    CREATE_PULL_REQUEST_TOOL,
    MERGE_BRANCH_TOOL,
  ],
  skills: [
    METHOD_SKILL,
    "worker-reporting",
    "dispatching-parallel-agents",
    "executing-plans",
    "finishing-a-development-branch",
    "receiving-code-review",
    "requesting-code-review",
    "subagent-driven-development",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "verification-before-completion",
    "writing-plans",
    "frontend-ui-engineering",
    "frontend-design",
    "vercel-react-best-practices",
    "supabase-postgres-best-practices",
    "api-and-interface-design",
    "performance-optimization",
    "nodejs-backend-patterns",
    "threejs-animation",
    "threejs-asset-pipeline",
    "threejs-fundamentals",
    "threejs-geometry",
    "threejs-interaction",
    "threejs-lighting",
    "threejs-loaders",
    "threejs-materials",
    "threejs-performance",
    "threejs-postprocessing",
    "threejs-react-three-fiber",
    "threejs-shaders",
    "threejs-textures",
  ], // explicit list: a new skill is added here (data)
  preloadSkills: [METHOD_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: [
    "writing-plans",
    "executing-plans",
    "test-driven-development",
    "verification-before-completion",
  ], // called before the first edit or command (named in one prompt line)
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: SUBAGENTS,
  sideEffects: "location",
  capabilities: CODE_CAPABILITIES,
  // The SDK asks nothing; only the guard's hard denies stop a call. Approval of the plan is an ask, not a gate.
  permissionMode: "bypassPermissions",
  streaming: true, // a background run: the owner can steer it
  model: SONNET_MODEL,
  budgetUsd: BUDGET_USD,
  // Prompt order: role, Mission, Method; the shared worker block; scope to collaboration; asking; standards; commits;
  // environment (with the worktree line when the run has a worktrees dir); stop rules.
  promptSections: (ctx) => [
    [
      DEVELOPER,
      workerTeamFacts(developerOwnerContact(MAX_ASK)),
      DEVELOPER_WORK,
      askRules(MAX_ASK),
      CODE_STANDARDS,
      COMMIT_RULES,
      developerEnvironment({
        subagentsParallel: SUBAGENTS.parallel,
        worktreesDir: ctx.worktreesDir,
      }),
      DEVELOPER_STOP_RULES,
    ].join("\n\n"),
  ],
};
