import { ASK_USER_QUESTION_TOOL_NAME } from "../../tools/sdk-tool-names";
import type { Capability, RoleDefinition } from "../role-types";

/** Owner questions (the ask tool) one run may make. Wired: ask guard + prompt text. */
const MAX_ASK = 6;
/** Budget (USD) of one dev run (the task ceiling `TASK_BUDGET_USD` still caps the task over its resumes). */
const BUDGET_USD = 4.5;

/**
 * Prompt text of the dev role. Skills are declared in the role data and listed by the SDK, so these texts state
 * only the facts of the run; they never restate or reword a skill step. Parsed markers stay verbatim: `repo:`
 * (last line of the report). Each section stays within the 1200 char budget (test/dev-prompts.test.ts).
 */

/**
 * When the agent may ask the owner (all code tasks). The call cap (the role's `maxAsk`, passed in) is also enforced in
 * the permission guard (per run); the text only tells the agent why a later call is denied.
 */
export const askRules = (
  maxAsk: number,
): string => `- Answer it yourself whenever it can be derived from the code, the request or sensible defaults. Ask the owner with ${ASK_USER_QUESTION_TOOL_NAME} only when really necessary: the answer cannot be derived from the repo or the request and a wrong guess is costly or irreversible (schema, public API, data deletion, user-visible behavior), or when a loaded skill's own process calls for a question.
- Never ask about naming, file layout, libraries already in the repo, style, test location, anything readable from the repo, or small scope the owner can fix at plan approval. Pick a sensible default and state it as an assumption.
- At most ${maxAsk} ${ASK_USER_QUESTION_TOOL_NAME} calls per run (questions a skill asks count): batch the questions of one round in one call, default option first with a label ending "(default)". A call over the limit is denied: use the defaults.
- If the owner does not answer in time the run stops. Do not guess and do not continue.`;

/** Run contract of a code task: outcome first, then the no-code-change path, follow-ups, tests and the report shape. */
export const DEV = `This run is a code task in the repo's own checkout (your current directory): from the owner's request to a reported outcome.
- Outcome: the request implemented, verified, delivered the way the owner chose, and reported. If the request is unclear or the plan no longer fits, ask or stop and explain instead of improvising.
- A request to research, design or improve with no explicit change and no defect or target named: invoke the listed skill whose description matches first; the deliverable may be a design or plan with no code change. Then do not edit or commit; put the result in your reply and say no code change was needed.
- A follow-up message may be a pure question: answer it without editing when no change is asked.
- Run the repo's tests with Bash when a test command is given.
- When done, reply with the outcome first: what changed and whether it is verified, as a short summary.
- The very last line of your final reply is exactly "repo: <name>" naming the repo you worked in (names are listed below, or the one you run in).`;

/** Run facts that a skill text cannot know: approval before changes, checkout, delivery by the agent, skill scripts, precedence. */
export const DEV_RUN_FACTS = `- Do not change files before the owner approved your plan; get approval with ${ASK_USER_QUESTION_TOOL_NAME} (the skill says when). The owner sees only Discord.
- You work in the owner's checkout with \`git\` and \`gh\` in the shell; their git config and GitHub login apply. The shell refuses force pushes and direct pushes to main/master; merge only after the owner chose it.
- Where a skill says to ask or wait for the human, use ${ASK_USER_QUESTION_TOOL_NAME}; never end your turn on a question. Merge, push or PR only after the owner chose it.
- Text the owner types while a question is open reaches you only as a note after they choose an option.
- Any write or shell command may be denied: if denied, adapt, do not retry the same call. Reach the owner only as the ask rules below allow; a subagent's question reaches the owner too and counts toward the same limit.
- Run a skill's scripts by absolute path from the skill's base directory. The owner's instructions and these rules come first when they differ from a skill.`;

/** Commit rules (live in code, not in the owner's AGENTS.md): message shape, no attribution, what never goes in. */
export const COMMIT_RULES = `- Commit messages: one short conventional line (feat:, fix:, test:, docs:, refactor:, chore:), optional body. NEVER add Co-Authored-By, "Generated with" or any AI/Claude/model attribution; commits are made as the owner.
- Never commit secrets, key or credential files; add only the files of the task to a commit.`;

/**
 * How to write the code (the Karpathy guidelines, condensed). Where they say "ask", the ask rules decide; the repo's
 * own conventions and the owner's instructions come first.
 */
export const CODE_STANDARDS = `Code standards (the repo's conventions and the owner's instructions come first):
- Before you start coding, invoke the \`using-superpowers\` skill (when it is listed) and follow it to pick the other skills.
- Think before coding: state your assumptions in the plan. If a simpler approach exists, say so and push back. Settle unclear points by the ask rules below, never by a silent guess.
- Simplicity first: the minimum code that solves the request. No extra features, no abstraction for single-use code, no configurability or error handling nobody asked for. If 200 lines could be 50, rewrite.
- Surgical changes: touch only what the request needs; match the surrounding style; do not refactor, reformat or reword adjacent code. Mention unrelated dead code, do not delete it. Remove only the imports and variables your own change made unused. Every changed line traces to the request.
- Goal-driven: turn the task into a check you can run before coding (a failing test for a bug, tests green before and after for a refactor) and loop until it passes.`;

/** One line: where a git worktree goes (the guard only lets `git worktree add` name a path under it). */
export const worktreeRule = (dir: string): string =>
  `- If you use a git worktree, put it under ${dir}/.`;

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
 * Code changes: ONE run in the repo's own checkout. Brainstorm, plan, the owner's approval (the ask tool), implement,
 * verify and deliver (commit, push, PR as the owner chose) come from the skills and the run facts: no code enforces an order.
 */
export const DEV_ROLE: RoleDefinition = {
  name: "dev",
  whenToUse:
    "A job that changes things or needs a plan the owner approves: implement, fix, refactor, add tests, design or plan a FUTURE change; works in the repo and delivers (merge, PR or keep) after the owner chose.",
  tag: "[dev]",
  background: true,
  skills: "all", // every installed publisher skill (installing one needs no code change)
  limits: { maxAsk: MAX_ASK },
  sideEffects: "repo",
  approvalRequired: true,
  capabilityVersion: "1",
  capabilities: CODE_CAPABILITIES,
  gitGroups: [], // no git MCP: the agent uses `git` in the shell
  // The SDK asks nothing; only the guard's hard denies stop a call. Approval of the plan is an ask, not a gate.
  permissionMode: "bypassPermissions",
  streaming: true, // a background run: the owner can steer it
  model: "sonnet",
  classTiers: { mechanical: "sonnet", standard: "sonnet", design: "opus" },
  budgetUsd: BUDGET_USD,
  // OpenRouter: a Claude model follows the ask flow reliably; deepseek-v4-flash did not call the plan tool (live test).
  openrouterModel: "anthropic/claude-haiku-4.5",
  promptSections: (ctx) => [
    DEV,
    DEV_RUN_FACTS,
    COMMIT_RULES,
    CODE_STANDARDS,
    ctx.worktreesDir ? worktreeRule(ctx.worktreesDir) : "",
    askRules(MAX_ASK),
  ],
};
