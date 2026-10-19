import { clip } from "../../observability/redact";
import type { PlanDoc } from "./plan-types";

/* The owner's view of a plan: one text for one question. Approving it approves the envelope too (what the run may do
   without asking again). Pure. The text carries every brief in full (what the worker receives); the approval gateway
   sends a long text as an attachment under a clipped stem (its first lines), so the head below stays short. */

/** Chars of the objective in the head line (the stem the owner sees above the buttons). */
const HEAD_OBJECTIVE_CHARS = 120;

/** Button labels of the plan question (the lead compares the answer with these). */
export const APPROVE_LABEL = "Approve plan";
export const REJECT_LABEL = "Reject plan";

/** Render a plan version for the owner. */
export function renderPlan(p: { version: number; objective: string; doc: PlanDoc }): string {
  const { doc } = p;
  const e = doc.envelope;
  const rows = doc.items.map(
    (it, n) =>
      `${n + 1}. ${it.key} "${it.subject}" [${it.role}${it.location ? ` @ ${it.location}` : ""}, risk ${it.risk}${it.deferredScope ? ", later" : ""}]${it.dependsOn.length ? ` after ${it.dependsOn.join(", ")}` : ""}: ${it.brief}`,
  );
  return [
    `Plan v${p.version}: ${clip(p.objective.replace(/\s+/g, " "), HEAD_OBJECTIVE_CHARS)}`,
    "Full briefs are in the attachment when this text is long.",
    ...(p.objective.length > HEAD_OBJECTIVE_CHARS ? [`Objective: ${p.objective}`] : []),
    "Steps (run one after another):",
    ...rows,
    ...(doc.acceptanceCriteria.length
      ? ["Done when:", ...doc.acceptanceCriteria.map((c) => `- ${c}`)]
      : []),
    `Limits: roles ${e.roles.join(", ") || "-"}; locations ${e.locations.join(", ") || "-"}; risk ${e.riskClasses.join(", ")}; at most ${e.bounds.maxItems} steps and ${e.bounds.maxGb} GB; budget $${e.budgetUsd}; delivery: ${e.effects.join(", ") || "keep"}.`,
    "Approving runs the whole plan inside these limits without asking again.",
  ].join("\n");
}
