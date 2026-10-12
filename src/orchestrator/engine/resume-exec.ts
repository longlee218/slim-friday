import type { RoleDefinition } from "../../roles/role-types";
import { type FlowResult, resumeReasonOf } from "../turns/turn-result";
import { DEFAULT_PLAN_FILE } from "./handoff";

/* An exec stage that runs again from its approved plan (a `failed_resumable` task, `/go`): the same handoff as the first
   run plus a note that the work may be half done. */

/** Added to the handoff: the earlier run stopped partway, so the checkout may already hold some of the work. */
export const RESUME_NOTE =
  "An earlier run of this plan stopped before it finished. The checkout may already hold some of the changes: check `git status` and the diff first, then continue the plan.";

/** Plan file name of the role: its handoff's, else the default (where the first run saved the approved plan). */
export const planFileOf = (role: RoleDefinition): string =>
  role.stages.find((s) => s.handoff)?.handoff?.planFile ?? DEFAULT_PLAN_FILE;

/** Tag the failure of an exec stage (it follows the approved plan, this run's or a resumed one) as resumable: the plan is kept. */
export function markResumable(res: FlowResult): FlowResult {
  const reason = resumeReasonOf(res);
  return reason ? { ...res, resumable: reason } : res;
}
