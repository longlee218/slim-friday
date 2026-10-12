import type { Workflow } from "../../repos/repo-registry";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
} from "../../tools/sdk-tool-names";

/**
 * Prompt text of the dev role (prompt module only, no role data). Skills are declared in the role data and listed by
 * the SDK, so these texts state only the facts of the run; they never restate or reword a skill step. Parsed markers
 * stay verbatim: `repo:` and `Need:` (plan stage), `Memory:` (exec stage).
 */

/**
 * When the agent may ask the owner (all code tasks). The call cap (the role's `maxAsk`, passed in) is also enforced in
 * the permission guard (per task, across plan and exec); the text only tells the agent why a later call is denied.
 */
export const askRules = (
  maxAsk: number,
): string => `- Answer it yourself whenever it can be derived from the code, the request or sensible defaults. Ask the owner with ${ASK_USER_QUESTION_TOOL_NAME} only when really necessary: the answer cannot be derived from the repo or the request and a wrong guess is costly or irreversible (schema, public API, data deletion, user-visible behavior), or when a loaded skill's own process calls for a question.
- Never ask about naming, file layout, libraries already in the repo, style, test location, anything readable from the repo, or small scope the owner can fix at plan review. Pick a sensible default and state it as an assumption.
- At most ${maxAsk} ${ASK_USER_QUESTION_TOOL_NAME} calls per task (plan and execute stages together; questions a skill asks count): batch the questions of one round in one call, default option first with a label ending "(default)". A call over the limit is denied: use the defaults.
- If the owner does not answer in time the run stops. Do not guess and do not continue.`;

/** Plan stage only: the one case where the plan is not submitted. */
export const VAGUE_PLAN_RULE = `- Exception to submitting the plan: if there is no identifiable target (repo, area or goal) and only the owner's answers would let you start (a design or research request with a named subject is not vague), do not call ${EXIT_PLAN_MODE_TOOL_NAME}. Reply with one short line "Need: <what is missing>" and end your turn.`;

/**
 * `workflow: full` repos: run the workspace's curated skills autonomously. The plan stage only sees the registry
 * marker, so its wording is conditional; the execute stage runs in a repo known to be `full`. Empty for `lean`.
 */
export function workflowRules(stage: "plan" | "exec", workflow: Workflow | undefined): string {
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
export const PLAN = `This run is the plan stage of a code task, in plan mode: the owner approves a plan, then a separate execute run implements it.
- Outcome: a plan file, submitted with ${EXIT_PLAN_MODE_TOOL_NAME}. Never end your turn without calling it (only exception: no identifiable target, see below).
- The plan has one line exactly like "repo: <name>" naming the repo to change (names are listed below).
- A request to research, design or improve with no explicit change and no defect or target named: invoke the listed skill whose description matches first, then submit a plan whose first section is the design (options, chosen approach, why), followed by the steps. If no code change is needed, the plan says "no code change; deliverable = <what>".
- Do NOT implement here and commit nothing: after approval the app starts the execute run in the repo.`;

/** Plan stage run facts that a skill text cannot know (scratch dir, docs/ paths, who the owner is, precedence). */
export const PLAN_RUN_FACTS = `- Repos are read-only references; you can write only the plan file and the task scratch dir. A spec, design or plan a skill says to save under docs/ goes in the plan file instead.
- The owner sees only Discord and reviews at ${EXIT_PLAN_MODE_TOOL_NAME}: that call is your "plan complete, please review" step, so do not ask which execution approach they prefer. Reach them only as the ask rules below allow; subagents never ask.
- Any shell command may need owner approval or be denied: if denied, adapt, do not retry the same call.
- Run a skill's scripts by absolute path from the skill's base directory. The owner's instructions and these rules come first when they differ from a skill.`;

/** Execute stage contract: outcome first, then the no-code-change path, follow-ups, tests and the report shape. */
export const EXEC = `This run is the execute stage of a code task, in the repo's own checkout (your current directory).
- Outcome: the approved plan implemented, committed and reported. The approved plan is plan.md in the task scratch dir (read-only for you). If the plan no longer fits, stop and explain instead of improvising.
- Only when the approved plan itself says "no code change" (a design or research deliverable): do not edit or commit; put the result in your reply and say no code change was needed. Otherwise implement the plan.
- A follow-up message may be a pure question: answer it without editing when no change is asked.
- Run the repo's tests with Bash when a test command is given.
- When done, reply with the outcome first: what changed and whether it is verified. Use the workflow skill's report format when it is listed, else a short summary.`;

/** Execute stage run facts: checkout, delivery by the agent, commit rule, skill scripts, precedence. */
export const EXEC_RUN_FACTS = `- You work in the owner's checkout with \`git\` and \`gh\` in the shell; their git config and GitHub login apply. The shell refuses force pushes and direct pushes to main/master; merge only after the owner chose it. Give plan.md's path to a skill script that asks for a plan file.
- The owner sees only Discord. Where a skill says to ask or wait for the human, use ${ASK_USER_QUESTION_TOOL_NAME}; never end your turn on a question. Merge, push or PR only after the owner chose it.
- Commit messages: one short conventional line (optional body). NEVER add Co-Authored-By, "Generated with" or any AI/Claude attribution; commits are made as the owner.
- Any write or shell command may be denied: if denied, adapt, do not retry the same call. Reach the owner only as the ask rules below allow; subagents never ask.
- Run a skill's scripts by absolute path from the skill's base directory. The owner's instructions and these rules come first when they differ from a skill.`;

/** Execute stage, one line: where a git worktree goes (the guard only lets `git worktree add` name a path under it). */
export const worktreeRule = (dir: string): string =>
  `- If you use a git worktree, put it under ${dir}/.`;

/** Execute stage repo memory section (the app parses the "Memory:" title). Original wording, unchanged. */
export const EXEC_MEMORY = `- Last, add a section titled exactly "Memory:" with at most 3 bullets ("- ...") of durable facts about this repo (commands, conventions, pitfalls); no task-specific facts (branch, clone, task ids). Prefix a bullet with "[global]" only for a fact true in every workspace (e.g. an owner preference); at most 2; [global] bullets are reviewed by the owner before they apply. Omit the section if there is nothing.`;

/** Both stages: how to treat skills in this run (no skill names, no workflow mode). Its own section keeps the others in budget. */
export const SKILL_RUN_FACTS = `- When a listed skill's description matches the step you are about to do, invoke it and follow it.
- A skill step that needs something not available here (a browser companion, another skill or subagent type that is not listed): skip it and say so in one line.`;
