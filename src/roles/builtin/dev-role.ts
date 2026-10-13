import type { Capability, RoleDefinition } from "../role-types";
import { askRules, DEV, DEV_RUN_FACTS, worktreeRule } from "./dev-prompts";

/** Owner questions (AskUserQuestion) one run may make. Wired: ask guard + prompt text. */
const MAX_ASK = 6;
/** Budget (USD) of one dev run (the task ceiling `TASK_BUDGET_USD` still caps the task over its resumes). */
const BUDGET_USD = 4.5;

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
 * Code changes: ONE run in the repo's own checkout. Brainstorm, plan, the owner's approval (AskUserQuestion), implement,
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
    ctx.worktreesDir ? worktreeRule(ctx.worktreesDir) : "",
    askRules(MAX_ASK),
  ],
};
