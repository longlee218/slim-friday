import type { OwnerLanguage } from "../i18n/languages";
import { t } from "../i18n/translate";
import type { UserNotice } from "./user-copy";

/** Notices about the plan lifecycle: a plan that did not start, a revision that changed agreed work. */
export type PlanNotice = Extract<
  UserNotice,
  { kind: "plan-not-started" | "plan-revised" | "plan-supersede-ask" }
>;

/** Type guard: true for the notices this module renders. */
export const isPlanNotice = (event: UserNotice): event is PlanNotice =>
  event.kind === "plan-not-started" ||
  event.kind === "plan-revised" ||
  event.kind === "plan-supersede-ask";

/** Render a plan notice in the owner's language. */
export function renderPlanNotice(event: PlanNotice, language: OwnerLanguage): string {
  if (event.kind === "plan-not-started") return t(language, `plan.notStarted.${event.cause}`);
  if (event.kind === "plan-supersede-ask")
    return t(language, "plan.supersede", { intent: event.intent ? ` "${event.intent}"` : "" });
  // One short line: "Plan v1 → v2: +a, −b, ~c", the cancelled work named, a changed criteria list flagged.
  const counts = `+${event.added.length}, −${event.cancelled.length}, ~${event.modified.length}`;
  const cancelled = event.cancelled.length
    ? t(language, "plan.revised.cancelled", { keys: event.cancelled.join(", ") })
    : "";
  const criteria = event.criteriaChanged ? t(language, "plan.revised.criteria") : "";
  return t(language, "plan.revised", {
    from: event.from,
    to: event.to,
    counts,
    cancelled,
    criteria,
  });
}
