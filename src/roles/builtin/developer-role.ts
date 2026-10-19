import { SONNET_MODEL } from "../../config/model-ids";
import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "../../mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../../mcp/effects/tools/MergeBranchTool/constants";
import { MEMORY_EXPAND_TOOL } from "../../mcp/memory/tools/MemoryExpandTool/constants";
import { MEMORY_GET_TOOL } from "../../mcp/memory/tools/MemoryGetTool/constants";
import { MEMORY_SEARCH_TOOL } from "../../mcp/memory/tools/MemorySearchTool/constants";
import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";
import { AGENT_TOOL_NAME, ASK_USER_QUESTION_TOOL_NAME } from "../../tools/sdk-tool-names";
import type { Capability, RoleDefinition } from "../role-types";
import { ARTIFACT_TOOLS } from "./artifact-tools";

/** Owner questions (the ask tool) one run may make. Wired: ask guard + prompt text. */
const MAX_ASK = 6;
/** Budget (USD) of one developer run (the task ceiling `TASK_BUDGET_USD` still caps the task over its resumes). */
const BUDGET_USD = 8;
/** Agent loops (SDK turns) one developer run may take. */
const MAX_TURNS = 150;
/** Subagents of one run (parallel cap; depth 1 = a subagent starts none); no total cap, the run budget bounds a fan-out. */
const SUBAGENTS = { parallel: 3, depth: 1 };

/**
 * Prompt text of the developer role. Skills are declared in the role data and listed by the SDK, so these texts state
 * only the facts of the run; they never restate or reword a skill step. Each section stays within the 1200 char budget (test/developer-prompts.test.ts).
 */

/**
 * When the agent may ask the owner (all code tasks). The call cap (the role's `maxAsk`, passed in) is also enforced in
 * the permission guard (per run); the text only tells the agent why a later call is denied.
 */
export const askRules = (
  maxAsk: number,
): string => `- Answer it yourself whenever it can be derived from the code, the request or sensible defaults. Ask the owner with ${ASK_USER_QUESTION_TOOL_NAME} only when really necessary: the answer cannot be derived from the location or the request and a wrong guess is costly or irreversible (schema, public API, data deletion, user-visible behavior), or when a loaded skill's own process calls for a question.
- Never ask about naming, file layout, libraries already in the location, style, test location, anything readable from the location, or small scope the owner can fix at plan approval. Pick a sensible default and state it as an assumption.
- At most ${maxAsk} ${ASK_USER_QUESTION_TOOL_NAME} calls per run (questions a skill asks count): batch the questions of one round in one call, default option first with a label ending "(default)". A call over the limit is denied: use the defaults.
- If the owner does not answer in time the run stops. Do not guess and do not continue.`;

/** Run contract of a code task: outcome first, then the no-code-change path, follow-ups, tests and the report shape. */
export const DEVELOPER = `Role: developer, a code worker in the location's own checkout (your current directory), from the owner's request to a reported outcome.
- Outcome: the request implemented, verified, delivered the way the owner chose, and reported. If the request is unclear or the plan no longer fits, ask or stop and explain.
- A request to research, design or improve with no explicit change and no defect or target named: the deliverable may be a design or plan with no code change. Then do not edit or commit; put the result in your reply and say no code change was needed.
- Run the location's tests with Bash when it has some (README, package scripts).
- Reporting: use the worker-reporting skill.`;

/** Run facts that a skill text cannot know: approval before changes, checkout, delivery by the agent, skill scripts, precedence. */
export const DEVELOPER_RUN_FACTS = `- Approval: change no file before the owner approved your plan. Ask with ${ASK_USER_QUESTION_TOOL_NAME} (the skill says when). The owner sees only Discord.
- The checkout is the owner's; git works in the shell. No .git in the location: no git delivery; leave the changes in place and say so in your reply.
- Do not end your turn on a question: ask with ${ASK_USER_QUESTION_TOOL_NAME}, also where a skill says to wait for the human.
- Merge, push or PR only after the owner chose it.
- Text the owner types while a question is open reaches you as a note after they choose an option.
- A denied call: adapt; do not repeat it unchanged. Reach the owner only as the ask rules below allow.
- Up to ${SUBAGENTS.parallel} subagents in parallel (${AGENT_TOOL_NAME}) for independent read, write or shell work. A subagent cannot ask the owner, report or deliver: you do that.
- Skill scripts: run them by absolute path from the skill's base directory. The brief and these rules take precedence over a skill when they differ.`;

/** What the worker's shell is: an OS sandbox; delete, push, merge and PR have checked tools, the shell itself is not filtered. */
export const DEVELOPER_SHELL_RULES = `Shell: an OS sandbox. Writes only in the granted dirs (the location and its scratch dirs); the network is open. Local git works; run the location's tests and checks with Bash.
Delete, push, merge and PR go through their tools (${DELETE_PATHS_TOOL}, ${GIT_PUSH_TOOL}, ${MERGE_BRANCH_TOOL}, ${CREATE_PULL_REQUEST_TOOL}), each only for the goal's grants. The app does not filter these in the shell; the tools are the checked path.
A denied or failed command: adapt; do not repeat it unchanged. If the task needs more than the sandbox or your grants allow, report a blocker with what you need.`;

/** Commit rules (live in code, not in the owner's AGENTS.md): message shape, no attribution, what never goes in. */
export const COMMIT_RULES = `- Commit messages: one short conventional line (feat:, fix:, test:, docs:, refactor:, chore:), optional body. NEVER add Co-Authored-By, "Generated with" or any AI/Claude/model attribution; commits are made as the owner.
- Never commit secrets, key or credential files; add only the files of the task to a commit.`;

/**
 * How to write the code (the Karpathy guidelines, condensed). Where they say "ask", the ask rules decide; the location's
 * own conventions come first.
 */
export const CODE_STANDARDS = `Code standards (the location's conventions come first):
- Think before coding: state your assumptions in the plan. If a simpler approach exists, say so and push back. Settle unclear points by the ask rules below, never by a silent guess.
- Simplicity first: the minimum code that solves the request. No extra features, no abstraction for single-use code, no configurability or error handling nobody asked for. If 200 lines could be 50, rewrite.
- Surgical changes: touch only what the request needs; match the surrounding style; do not refactor, reformat or reword adjacent code. Mention unrelated dead code, do not delete it. Remove only the imports and variables your own change made unused. Every changed line traces to the request.
- Goal-driven: turn the task into a check you can run before coding (a failing test for a bug, tests green before and after for a refactor) and loop until it passes.`;

/** One line: where a git worktree goes (advice to the worker: the OS sandbox only lets it write there). */
const worktreeRule = (dir: string): string =>
  `- If you use a git worktree, put it under ${dir}/: \`git worktree add ${dir}/<name> <existing-branch>\` (or -b <new> ${dir}/<name> <base>); \`git worktree list\` lists them.`;

/** Capabilities of a code task: the guard narrows what a call may do. */
const CODE_CAPABILITIES: Capability[] = [
  "read",
  "write",
  "shell",
  "skills",
  "tasks",
  "mcp",
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
    "A job that changes things or needs a plan the owner approves: implement, fix, refactor, add tests, design or plan a FUTURE change; works in the location and delivers (merge, PR or keep) after the owner chose.",
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
    "worker-reporting",
    "brainstorming",
    "diagnosing-superpowers",
    "dispatching-parallel-agents",
    "executing-plans",
    "finishing-a-development-branch",
    "receiving-code-review",
    "requesting-code-review",
    "subagent-driven-development",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "using-superpowers",
    "verification-before-completion",
    "writing-plans",
    "writing-skills",
  ], // explicit list: a new skill is added here (data)
  limits: { maxAsk: MAX_ASK, maxTurns: MAX_TURNS },
  subagents: SUBAGENTS,
  sideEffects: "location",
  capabilities: CODE_CAPABILITIES,
  // The SDK asks nothing; only the guard's hard denies stop a call. Approval of the plan is an ask, not a gate.
  permissionMode: "bypassPermissions",
  streaming: true, // a background run: the owner can steer it
  model: SONNET_MODEL,
  budgetUsd: BUDGET_USD,
  promptSections: (ctx) => [
    DEVELOPER,
    DEVELOPER_RUN_FACTS,
    DEVELOPER_SHELL_RULES,
    COMMIT_RULES,
    CODE_STANDARDS,
    ctx.worktreesDir ? worktreeRule(ctx.worktreesDir) : "",
    askRules(MAX_ASK),
  ],
};
