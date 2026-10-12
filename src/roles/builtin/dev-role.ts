import type { Capability, RoleDefinition, StageDefinition } from "../role-types";
import {
  askRules,
  EXEC,
  EXEC_MEMORY,
  EXEC_RUN_FACTS,
  PLAN,
  PLAN_RUN_FACTS,
  SKILL_RUN_FACTS,
  VAGUE_PLAN_RULE,
  workflowRules,
  worktreeRule,
} from "./dev-prompts";

/** Owner questions (AskUserQuestion) the whole task may make, plan and exec together. Wired: ask guard + prompt text. */
const MAX_ASK = 6;
/** Budget (USD) of one task: old plan 1.5 + exec 3.0. Consumed by phase 5 (single run); the stages keep their own budgets until then. */
const BUDGET_USD = 4.5;

/** Capabilities of a code task. Plan and execute stages share them: the guard narrows what a call may do. */
const CODE_CAPABILITIES: Capability[] = [
  "read",
  "write",
  "shell",
  "skills",
  "tasks",
  "mcp",
  "feedback",
  "ask",
  "planControl",
];

/** What plan and exec have in common: tools; exec adds more below. */
const CODE_STAGE_BASE = {
  capabilities: CODE_CAPABILITIES,
  streaming: true, // plan and exec are background runs: the owner can steer them
  // OpenRouter: plan mode needs a model that reliably calls ExitPlanMode; deepseek-v4-flash does not (live test), a Claude model does.
  openrouterModel: "anthropic/claude-haiku-4.5",
} satisfies Partial<StageDefinition>;

/** Code changes: a plan the owner approves, then an execute run in the repo's own checkout; the agent delivers (commit, push, PR). */
export const DEV_ROLE: RoleDefinition = {
  name: "dev",
  whenToUse:
    "Outcome is a change to the code: implement, fix, refactor, add tests; also research, design or plan a FUTURE change of the project. Plans, owner approves, then a PR. Not for: learning how existing code works.",
  output: "result",
  skills: "all", // every installed publisher skill (installing one needs no code change)
  maxAsk: MAX_ASK,
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
      gitGroups: [], // no git MCP: the agent uses `git` in the shell
      permissionMode: "plan",
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
        askRules(MAX_ASK),
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
      gitGroups: [],
      promptSections: (ctx) => [
        EXEC,
        EXEC_RUN_FACTS,
        ctx.worktreesDir ? worktreeRule(ctx.worktreesDir) : "",
        SKILL_RUN_FACTS,
        EXEC_MEMORY,
        askRules(MAX_ASK),
        workflowRules("exec", ctx.workflow),
      ],
    },
  ],
};
