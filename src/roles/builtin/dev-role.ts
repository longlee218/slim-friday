import type { Capability, RoleDefinition, RoleSkill, StageDefinition } from "../role-types";
import {
  ASK_RULES,
  EXEC,
  EXEC_MEMORY,
  EXEC_RUN_FACTS,
  PLAN,
  PLAN_RUN_FACTS,
  SKILL_RUN_FACTS,
  VAGUE_PLAN_RULE,
  workflowRules,
} from "./dev-prompts";
import { subagentRunFacts } from "./dev-subagent-rules";

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
 * Subagents of the exec stage, and the single switch of subagent-driven work: this list also loads the skills that
 * `needs` them (DEV_SKILLS) and adds the run facts to the prompt. Remove implementer and task-reviewer here and the
 * three skills, both subagents and the facts are gone again (kill switch = role data, no env var).
 */
const EXEC_SUBAGENTS = ["explorer", "implementer", "task-reviewer"];

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

/** What plan and exec have in common: tools, run timeout and the (read-only) subagents; exec adds more below. */
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
        PLAN_RUN_FACTS,
        SKILL_RUN_FACTS,
        ASK_RULES,
        VAGUE_PLAN_RULE,
        workflowRules("plan", ctx.workflow),
      ],
    },
    {
      ...CODE_STAGE_BASE,
      name: "exec",
      permissionMode: "bypassPermissions",
      subagents: EXEC_SUBAGENTS,
      model: "sonnet",
      classTiers: { mechanical: "haiku", standard: "sonnet", design: "opus" },
      budgetUsd: 3.0,
      gitGroups: ["read", "commit", "change"],
      isolation: "clone",
      gate: "delivery",
      promptSections: (ctx) => [
        EXEC,
        EXEC_RUN_FACTS,
        SKILL_RUN_FACTS,
        EXEC_MEMORY,
        subagentRunFacts(EXEC_SUBAGENTS),
        ASK_RULES,
        workflowRules("exec", ctx.workflow),
      ],
    },
  ],
};
