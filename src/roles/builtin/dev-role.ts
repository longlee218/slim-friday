import type { Workflow } from "../../repos/repo-registry";
import { MAX_ASK_CALLS_PER_TASK } from "../../runtime/ask-limit";
import { GIT_GROUPS } from "../../tools/git-tool-groups";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
} from "../../tools/sdk-tool-names";
import type { Capability, RoleDefinition, RoleSkill, StageDefinition } from "../role-types";

/** Code tasks include owner approval waits (10 min each), so their run timeout is at least this. */
const CODE_TASK_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Publisher skills of the dev role (plan and exec share one list): the single switch for what a dev run loads.
 * `needs` gates a skill until the stage can start the subagents it dispatches (registered by the subagent
 * registry; the stages list them in `subagents`). Not loaded on purpose, Friday's own clone + delivery replace them:
 * using-git-worktrees, finishing-a-development-branch, using-superpowers, dispatching-parallel-agents, writing-skills,
 * diagnosing-superpowers.
 */
const DEV_SKILLS: RoleSkill[] = [
  { name: "brainstorming" },
  { name: "writing-plans" },
  { name: "executing-plans" },
  { name: "test-driven-development" },
  { name: "verification-before-completion" },
  { name: "systematic-debugging" },
  { name: "subagent-driven-development", needs: ["implementer", "task-reviewer"] },
  { name: "requesting-code-review", needs: ["task-reviewer"] },
  { name: "receiving-code-review", needs: ["task-reviewer"] },
];

/**
 * When the agent may ask the owner (all code tasks). The call cap is also enforced in the permission guard (per
 * task, across plan and exec, `MAX_ASK_CALLS_PER_TASK`); the text only tells the agent why a later call is denied.
 */
const ASK_RULES = `- Ask the owner with ${ASK_USER_QUESTION_TOOL_NAME} when the answer cannot be derived from the repo or the request and a wrong guess is costly or irreversible (schema, public API, data deletion, user-visible behavior), or when a loaded skill's own process calls for a question (brainstorming).
- Never ask about naming, file layout, libraries already in the repo, style, test location, anything readable from the repo, or small scope the owner can fix at plan review. Pick a sensible default and state it as an assumption.
- At most ${MAX_ASK_CALLS_PER_TASK} ${ASK_USER_QUESTION_TOOL_NAME} calls per task (plan and execute stages together; questions a skill asks count): batch the questions of one round in one call, default option first with a label ending "(default)". A call over the limit is denied: use the defaults.
- If the owner does not answer in time the run stops. Do not guess and do not continue.`;

/** Plan stage only: the one case where the plan is not submitted. */
const VAGUE_PLAN_RULE = `- Exception to submitting the plan: if the request is too vague to plan, do not call ${EXIT_PLAN_MODE_TOOL_NAME}. Reply with one short line "Need: <what is missing>" and end your turn.`;

/**
 * `workflow: full` repos: run the workspace's curated skills autonomously. The plan stage only sees the registry
 * marker, so its wording is conditional; the execute stage runs in a repo known to be `full`. Empty for `lean`.
 */
function workflowRules(stage: "plan" | "exec", workflow: Workflow | undefined): string {
  if (workflow !== "full") return "";
  const scope =
    stage === "plan"
      ? "For a repo marked [workflow: full] in the repo list"
      : "This repo is [workflow: full]";
  return `- ${scope}: follow the workspace's curated skills end to end (use the ${SKILL_TOOL_NAME} tool; none listed means none exist) instead of a minimal plan-then-implement run.
- Skill steps that ask the owner follow the ask rules above. Where you take a default instead of asking (a question not worth a call, or the limit is reached), record it as "- <decision> (confidence: high|med|low)" under "Assumptions": in the plan stage, a section of the plan; in the execute stage, in your final reply.
- Owner approvals for the plan, writes and commands still apply.`;
}

/**
 * Plan stage contract. The SDK's own plan-mode reminder already forbids edits outside the plan file
 * (spike-261007), so that rule is not repeated; the rest is specific to this app's approval flow.
 */
const PLAN = `This run is the plan stage of a code task, in plan mode.
- Write your plan to the plan file, then you MUST call ${EXIT_PLAN_MODE_TOOL_NAME} to submit it. Never end your turn without calling ${EXIT_PLAN_MODE_TOOL_NAME} (only exception: a request too vague to plan, see below).
- Do NOT implement here: after approval the app creates a clone and starts a separate execute run.
- Your plan MUST contain one line exactly like "repo: <name>" naming the repo to change (names are listed below).
- Registered repos are read-only references. Any shell command may need owner approval or be denied: if denied, adapt, do not retry the same call.`;

/** Execute stage contract: work in the clone, follow the approved plan, small commits, repo memory. */
const EXEC = `This run is the execute stage of a code task, in an isolated clone of the repo (your current directory) on its own branch.
- Follow the approved plan. The task scratch dir (read-only for you) holds plan.md.
- A follow-up message may be a pure question: answer it without editing when no change is asked.
- Use the git MCP tools for git (${[...GIT_GROUPS.read, ...GIT_GROUPS.commit].join(", ")}; always pass path = your current directory). Never use the shell for git, never push, never switch branches, never edit outside this directory.
- Commit messages: one short conventional line (optional body). NEVER add Co-Authored-By, "Generated with" or any AI/Claude attribution; commits are made as the owner.
- Run the repo's tests with Bash when a test command is given. If the plan no longer fits, stop and explain instead of improvising.
- Every write and shell command may need owner approval or be denied: if denied, adapt, do not retry the same call.
- When done, reply with a short summary of what changed.
- Last, add a section titled exactly "Memory:" with at most 3 bullets ("- ...") of durable facts about this repo (commands, conventions, pitfalls); no task-specific facts (branch, clone, task ids). Prefix a bullet with "[global]" only for a fact true in every workspace (e.g. an owner preference); at most 2; [global] bullets are reviewed by the owner before they apply. Omit the section if there is nothing.`;

/** Capabilities of a code task. Plan and execute stages share them: the guard narrows what a call may do. */
const CODE_CAPABILITIES: Capability[] = [
  "read",
  "write",
  "shell",
  "skills",
  "subagents",
  "tasks",
  "mcp",
  "feedback",
  "ask",
  "planControl",
];

/** What plan and exec have in common: tools, run timeout and the (read-only) subagents. */
const CODE_STAGE_BASE = {
  capabilities: CODE_CAPABILITIES,
  timeoutMs: CODE_TASK_TIMEOUT_MS,
  streaming: true, // plan and exec are background runs: the owner can steer them
  // OpenRouter: plan mode needs a model that reliably calls ExitPlanMode; deepseek-v4-flash does not (live test), a Claude model does.
  openrouterModel: "anthropic/claude-haiku-4.5",
  subagents: ["explorer"],
} satisfies Partial<StageDefinition>;

/** Code changes: a plan the owner approves, then an execute run in an isolated clone on its own branch. */
export const DEV_ROLE: RoleDefinition = {
  name: "dev",
  whenToUse:
    "Outcome is a change to the code: implement, fix, refactor, add tests; also research, design or plan a FUTURE change of the project. Plans, owner approves, then a PR. Not for: learning how existing code works.",
  output: "pr",
  skills: DEV_SKILLS,
  countsTowardCap: true,
  tag: "[dev]",
  followUp: { startAtStage: "exec" },
  stages: [
    {
      ...CODE_STAGE_BASE,
      name: "plan",
      model: "sonnet",
      classTiers: { mechanical: "sonnet", standard: "sonnet", design: "opus" },
      budgetUsd: 1.5,
      gitGroups: ["read"],
      permissionMode: "plan",
      isolation: "none",
      gate: "plan-approval",
      handoff: {
        planFile: "plan.md",
        template:
          "Approved plan (also saved at {planPath}):\n\n{plan}\n\nOriginal task: {task}\n\n{testLine}",
      },
      promptSections: (ctx) => [
        PLAN,
        ASK_RULES,
        VAGUE_PLAN_RULE,
        workflowRules("plan", ctx.workflow),
      ],
    },
    {
      ...CODE_STAGE_BASE,
      name: "exec",
      permissionMode: "bypassPermissions",
      model: "sonnet",
      classTiers: { mechanical: "haiku", standard: "sonnet", design: "opus" },
      budgetUsd: 3.0,
      gitGroups: ["read", "commit", "change"],
      isolation: "clone",
      gate: "delivery",
      promptSections: (ctx) => [EXEC, ASK_RULES, workflowRules("exec", ctx.workflow)],
    },
  ],
};
