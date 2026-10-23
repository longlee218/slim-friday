import type { WorkPlanRow } from "../../storage/work-plan-store";
import { subjectFromBrief } from "../../tasks/task-subject";
import {
  DELIVERY_EFFECT_TOOLS,
  type DeliveryEffect,
  type Envelope,
  normalizeRisk,
  type PlanDoc,
  type PlanItem,
  type Risk,
} from "./plan-types";

/* Plan content in and out: tool input to `PlanDoc` (risk normalized, roles derived), and the stored row to `PlanDoc`. */

/** An item as a tool gives it (risk is free text until normalized). */
export interface ItemInput {
  key: string;
  role: string;
  brief: string;
  /** Absent = the first words of the brief. */
  subject?: string | undefined;
  priority?: number | undefined;
  section?: string | undefined;
  location?: string | undefined;
  dependsOn: string[];
  risk: string;
}

/** The teammate's envelope input (roles are derived, never asked). */
export interface EnvelopeInput {
  locations: string[];
  riskClasses: string[];
  bounds: { maxItems: number; maxGb: number };
}

/** Item input to a plan item: unknown risk becomes R2, absent optional fields are left out. */
export const toPlanItem = (i: ItemInput): PlanItem => ({
  key: i.key,
  role: i.role,
  brief: i.brief,
  subject: i.subject ?? subjectFromBrief(i.brief),
  ...(i.priority && { priority: i.priority }),
  ...(i.section && { section: i.section }),
  ...(i.location && { location: i.location }),
  dependsOn: [...new Set(i.dependsOn)],
  risk: normalizeRisk(i.risk),
});

/** Build the envelope: the plan's limits + the roles the items use (derived) + the code-computed budget (`planBudgetUsd`) and delivery effects (deduped, sorted). */
export function buildEnvelope(
  e: EnvelopeInput,
  items: readonly PlanItem[],
  budgetUsd: number,
  effects: readonly DeliveryEffect[],
): Envelope {
  return {
    roles: [...new Set(items.map((i) => i.role))].sort(),
    locations: [...new Set(e.locations)].sort(),
    riskClasses: [...new Set(e.riskClasses.map(normalizeRisk))].sort() as Risk[],
    bounds: e.bounds,
    budgetUsd,
    effects: [...new Set(effects)].sort(),
  };
}

/** The stored columns of a plan version (JSON text). */
export function rowFieldsOf(doc: PlanDoc) {
  return {
    body: JSON.stringify({ items: doc.items }),
    specMd: doc.spec,
    planMd: doc.plan,
    acceptance: JSON.stringify(doc.acceptanceCriteria),
    envelope: JSON.stringify(doc.envelope),
    budgetUsd: doc.envelope.budgetUsd,
    // The `effects` column holds the comma-joined effect tools.
    effects: doc.envelope.effects.join(",") || null,
  };
}

/** Stored row to content; a corrupt column reads as empty (the validator then refuses it). */
export function docOfRow(r: WorkPlanRow): PlanDoc {
  const parse = <T>(text: string, fallback: T): T => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback;
    }
  };
  const env = parse<Envelope>(r.envelope, {
    roles: [],
    locations: [],
    riskClasses: [],
    bounds: { maxItems: 0, maxGb: 0 },
    budgetUsd: 0,
    effects: [],
  });
  return {
    spec: r.specMd,
    plan: r.planMd,
    // A plan stored before `subject` existed has none: the first words of its brief stand in.
    items: (parse<{ items?: PlanItem[] }>(r.body, {}).items ?? []).map((i) => ({
      ...i,
      subject: i.subject ?? subjectFromBrief(i.brief),
    })),
    acceptanceCriteria: parse<string[]>(r.acceptance, []),
    // A stored `effects` list is filtered through the allowlist: a missing, corrupt or unknown entry grants nothing.
    envelope: {
      ...env,
      effects: Array.isArray(env.effects)
        ? env.effects.filter((t) => (DELIVERY_EFFECT_TOOLS as readonly unknown[]).includes(t))
        : [],
    },
  };
}
