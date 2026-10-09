import type { Workflow } from "../repos/repo-registry";
import {
  ASK_USER_QUESTION_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  SKILL_TOOL_NAME,
} from "../tools/sdk-tool-names";

/* Rule sections of code tasks (plan and exec stages) that depend on the question limit and the repo workflow. */

/**
 * When the agent may ask the owner (all code tasks). The one-call limit is also enforced in the permission
 * guard (per task, across plan and exec); the text only tells the agent why a second call is denied.
 */
export const ASK_RULES = `- Ask the owner with ${ASK_USER_QUESTION_TOOL_NAME} ONLY when all three hold: (1) the answer cannot be derived from the repo or the request; (2) a wrong guess is costly or irreversible (schema, public API, data deletion, user-visible behavior); (3) there are 2+ reasonable options with different outcomes.
- Never ask about naming, file layout, libraries already in the repo, style, test location, anything readable from the repo, or small scope the owner can fix at plan review. Pick a sensible default and state it as an assumption.
- At most ONE ${ASK_USER_QUESTION_TOOL_NAME} call per task (plan and execute stages together): batch every question in it, default option first with a label ending "(default)". A second call is denied: use the defaults.
- If the owner does not answer in time the run stops. Do not guess and do not continue.`;

/** Plan stage only: the one case where the plan is not submitted. */
export const VAGUE_PLAN_RULE = `- Exception to submitting the plan: if the request is too vague to plan, do not call ${EXIT_PLAN_MODE_TOOL_NAME}. Reply with one short line "Need: <what is missing>" and end your turn.`;

/**
 * `workflow: full` repos: run the workspace's curated skills autonomously. The plan stage only sees the registry
 * marker, so its wording is conditional; the execute stage runs in a repo known to be `full`.
 */
export function fullWorkflowRules(stage: "plan" | "exec"): string {
  const scope =
    stage === "plan"
      ? "For a repo marked [workflow: full] in the repo list"
      : "This repo is [workflow: full]";
  return `- ${scope}: follow the workspace's curated skills end to end (use the ${SKILL_TOOL_NAME} tool; none listed means none exist) instead of a minimal plan-then-implement run.
- Run it autonomously: an interactive skill step (brainstorming, clarifying questions, confirmations) never asks the owner. Take the best default from the repo context and record it as "- <decision> (confidence: high|med|low)" under "Assumptions": in the plan stage, a section of the plan; in the execute stage, in your final reply.
- These rules override skill instructions about asking. Owner approvals for the plan, writes and commands still apply.`;
}

/** Workflow of the run: the rules text of the stage, empty for `lean` (today's behavior). */
export function workflowRules(stage: "plan" | "exec", workflow: Workflow | undefined): string {
  return workflow === "full" ? fullWorkflowRules(stage) : "";
}
