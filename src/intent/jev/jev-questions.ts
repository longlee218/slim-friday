import type { RoleDefinition } from "../../roles/role-types";
import type { JevQuestion } from "./jev-client";
import { JEV_UNCLEAR } from "./jev-constants";

/** Longest Choice option description the API accepts. */
const CRITERIA_MAX_CHARS = 255;

/** Facts that decide which questions go into the request. */
export interface QuestionContext {
  /** An open owned task exists (ask `continues_task`). */
  hasTask: boolean;
  /** Last responding role (asked `fits_last_role` only when it has side effects). */
  lastRole?: RoleDefinition;
}

/**
 * The questions of ONE request, from registry data (`whenToUse`, `sideEffects`): ids are local, the model never sees
 * them, so the full meaning is in `instructions`. `role` + `multi_intent` always; `continues_task` with an open task;
 * `fits_last_role` for a last role with side effects. No role names here.
 */
export function buildJevQuestions(
  roles: RoleDefinition[],
  ctx: QuestionContext,
): Record<string, JevQuestion> {
  const criteria: Record<string, string | null> = {};
  for (const r of roles)
    if (r.whenToUse) criteria[r.name] = r.whenToUse.slice(0, CRITERIA_MAX_CHARS);
  criteria[JEV_UNCLEAR] = "No role clearly fits, or the message lacks the information to decide";
  const q: Record<string, JevQuestion> = {
    role: {
      type: "choice",
      instructions:
        "Which role should handle state.message, given the thread (state.thread) and the recent messages (state.recent)? Choose by the outcome the owner wants.",
      criteria,
    },
    multi_intent: {
      type: "noul",
      instructions:
        "Does state.message ask for two or more separate pieces of work that would need different roles?",
    },
  };
  if (ctx.hasTask)
    q.continues_task = {
      type: "noul",
      instructions:
        "Is state.message about the open task in state.thread.task (an answer, approval, correction or next instruction for it), and not a new topic, small talk or thanks?",
    };
  if (ctx.lastRole && ctx.lastRole.sideEffects !== "none")
    q.fits_last_role = {
      type: "noul",
      instructions:
        `Can the role "${ctx.lastRole.name}" (${ctx.lastRole.whenToUse}) handle state.message within its purpose?`.slice(
          0,
          2000,
        ),
    };
  return q;
}
