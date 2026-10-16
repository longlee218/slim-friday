import { SONNET_MODEL } from "../../config/model-ids";
import { EFFECTS_MCP_SERVER, WORKER_MCP_SERVER } from "../../mcp/mcp-tool-names";
import { ASK_USER_QUESTION_TOOL_NAME } from "../../tools/sdk-tool-names";
import type { Capability, RoleDefinition } from "../role-types";

/** Owner questions (the ask tool) one run may make. Wired: ask guard + prompt text. */
const MAX_ASK = 6;
/** Budget (USD) of one developer run (the task ceiling `TASK_BUDGET_USD` still caps the task over its resumes). */
const BUDGET_USD = 4.5;

/**
 * Prompt text of the developer role. Skills are declared in the role data and listed by the SDK, so these texts state
 * only the facts of the run; they never restate or reword a skill step. Parsed markers stay verbatim: `location:`
 * (last line of the report). Each section stays within the 1200 char budget (test/developer-prompts.test.ts).
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
export const DEVELOPER = `This run is a code task in the location's own checkout (your current directory): from the owner's request to a reported outcome.
- Outcome: the request implemented, verified, delivered the way the owner chose, and reported. If the request is unclear or the plan no longer fits, ask or stop and explain instead of improvising.
- A request to research, design or improve with no explicit change and no defect or target named: invoke the listed skill whose description matches first; the deliverable may be a design or plan with no code change. Then do not edit or commit; put the result in your reply and say no code change was needed.
- A follow-up message may be a pure question: answer it without editing when no change is asked.
- Run the location's tests with Bash when it has some (README, package scripts).
- When done, reply with the outcome first: what changed and whether it is verified, as a short summary.
- The very last line of your final reply is exactly "location: <name>" naming the location you worked in (names are listed below, or the one you run in).`;

/** Run facts that a skill text cannot know: approval before changes, checkout, delivery by the agent, skill scripts, precedence. */
export const DEVELOPER_RUN_FACTS = `- Do not change files before the owner approved your plan; get approval with ${ASK_USER_QUESTION_TOOL_NAME} (the skill says when). The owner sees only Discord.
- You work in the owner's checkout with \`git\` in the shell; the shell rules are in the next section.
- If the location has no .git, skip git delivery: leave the changes in place and say so in your reply.
- Where a skill says to ask or wait for the human, use ${ASK_USER_QUESTION_TOOL_NAME}; never end your turn on a question. Merge, push or PR only after the owner chose it.
- Text the owner types while a question is open reaches you only as a note after they choose an option.
- Any write or shell command may be denied: if denied, adapt, do not retry the same call. Reach the owner only as the ask rules below allow; a subagent's question reaches the owner too and counts toward the same limit.
- Run a skill's scripts by absolute path from the skill's base directory. The owner's instructions and these rules come first when they differ from a skill.`;

/** What the worker's shell accepts and the alternative for what it does not (the gate's denial text says the same). */
export const DEVELOPER_SHELL_RULES = `Shell rules: ONE plain command a call (no pipe, &&, ;, redirect, $, glob, \`..\`); quotes only in git commit -m "msg" (a second -m is fine; no $, backtick, backslash or ! in it).
- Works: status, diff, log, show (\`show REV:path\` too), add, commit, stash, checkout|switch <existing branch> or -b <new> [base], bun test [-t name] [--coverage], bunx tsc --noEmit, biome check, ls/cat/rg/find/sed -n.
- Instead of the shell: rm = DeletePaths, git push = GitPush, git merge = MergeBranch, gh pr create = CreatePullRequest (each per grant); files = Write/Edit; there is no network (no fetch/pull/curl).
- Any other shell line is denied: change it to one of the forms above, or report BLOCKED with what you need.`;

/** Commit rules (live in code, not in the owner's AGENTS.md): message shape, no attribution, what never goes in. */
export const COMMIT_RULES = `- Commit messages: one short conventional line (feat:, fix:, test:, docs:, refactor:, chore:), optional body. NEVER add Co-Authored-By, "Generated with" or any AI/Claude/model attribution; commits are made as the owner.
- Never commit secrets, key or credential files; add only the files of the task to a commit.`;

/**
 * How to write the code (the Karpathy guidelines, condensed). Where they say "ask", the ask rules decide; the location's
 * own conventions and the owner's instructions come first.
 */
export const CODE_STANDARDS = `Code standards (the location's conventions and the owner's instructions come first):
- Think before coding: state your assumptions in the plan. If a simpler approach exists, say so and push back. Settle unclear points by the ask rules below, never by a silent guess.
- Simplicity first: the minimum code that solves the request. No extra features, no abstraction for single-use code, no configurability or error handling nobody asked for. If 200 lines could be 50, rewrite.
- Surgical changes: touch only what the request needs; match the surrounding style; do not refactor, reformat or reword adjacent code. Mention unrelated dead code, do not delete it. Remove only the imports and variables your own change made unused. Every changed line traces to the request.
- Goal-driven: turn the task into a check you can run before coding (a failing test for a bug, tests green before and after for a refactor) and loop until it passes.`;

/** One line: where a git worktree goes (the guard only lets `git worktree add` name a path under it). */
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
  background: true,
  dispatchable: true, // the lead may start it as a worker
  mcpServers: [WORKER_MCP_SERVER, EFFECTS_MCP_SERVER], // ReportResult + the effect tools when dispatched (a run without the servers just lacks them)
  skills: [
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
  limits: { maxAsk: MAX_ASK },
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
