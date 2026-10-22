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

/** The stored-document view of a version (plan artifact): its lifecycle state and, for an approved one, each item's live status. */
export interface PlanDocView {
  status: string;
  /** Why the version was rejected / superseded / revised; absent = none. */
  reason?: string | null;
  /** Live status by item key (an item with no row yet reads "not started"). */
  itemStatus?: ReadonlyMap<string, string>;
}

/** Render a plan version for the owner; with `view`, the stored document (status, reason, item status; no approval wording). */
export function renderPlan(
  p: { version: number; objective: string; doc: PlanDoc },
  view?: PlanDocView,
): string {
  const { doc } = p;
  const e = doc.envelope;
  const rows = doc.items.map((it, n) => {
    const live = view?.itemStatus ? `, ${view.itemStatus.get(it.key) ?? "not started"}` : "";
    return `${n + 1}. ${it.key} "${it.subject}" [${it.role}${it.location ? ` @ ${it.location}` : ""}, risk ${it.risk}${it.deferredScope ? ", later" : ""}${live}]${it.dependsOn.length ? ` after ${it.dependsOn.join(", ")}` : ""}: ${it.brief}`;
  });
  const head = clip(p.objective.replace(/\s+/g, " "), HEAD_OBJECTIVE_CHARS);
  // A long objective is shown once in full (the stored view keeps its clipped title line as well).
  const long = p.objective.length > HEAD_OBJECTIVE_CHARS;
  return [
    ...(view
      ? [
          `# Plan v${p.version}: ${head}`,
          `Status: ${view.status}${view.reason ? `. Reason: ${view.reason}` : ""}`,
        ]
      : [long ? `Plan v${p.version}` : `Plan v${p.version}: ${head}`]),
    ...(long ? [`Objective: ${p.objective}`] : []),
    "Steps (run one after another):",
    ...rows,
    ...(doc.acceptanceCriteria.length
      ? ["Done when:", ...doc.acceptanceCriteria.map((c) => `- ${c}`)]
      : []),
    `Limits: roles ${e.roles.join(", ") || "-"}; locations ${e.locations.join(", ") || "-"}; risk ${e.riskClasses.join(", ")}; at most ${e.bounds.maxItems} steps and ${e.bounds.maxGb} GB; budget $${e.budgetUsd}; delivery: ${e.effects.join(", ") || "keep"}.`,
    ...(view ? [] : ["Approving runs the whole plan inside these limits without asking again."]),
  ].join("\n");
}

/**
 * Short owner view of a plan for the approval card (the full `renderPlan` text goes in the attachment): the objective
 * head, one line per step (subject and role) and the limits that matter for the decision.
 */
export function renderPlanStem(p: { version: number; objective: string; doc: PlanDoc }): string {
  const e = p.doc.envelope;
  return [
    `Plan v${p.version}: ${clip(p.objective.replace(/\s+/g, " "), HEAD_OBJECTIVE_CHARS)}`,
    "Steps:",
    ...p.doc.items.map(
      (it, n) => `${n + 1}. ${it.subject} [${it.role}${it.location ? ` @ ${it.location}` : ""}]`,
    ),
    `Budget $${e.budgetUsd}; risk ${e.riskClasses.join(", ")}; delivery: ${e.effects.join(", ") || "keep"}.`,
  ].join("\n");
}
