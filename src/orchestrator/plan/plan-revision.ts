import type { Database } from "bun:sqlite";
import { childrenOf } from "../../storage/owned-item-store";
import { casPlanStatus, insertPlanVersion } from "../../storage/work-plan-store";
import { planBudgetUsd } from "../budget/plan-budget";
import { spentOf } from "../budget/task-budget";
import {
  buildEnvelope,
  docOfRow,
  type EnvelopeInput,
  type ItemInput,
  rowFieldsOf,
  toPlanItem,
} from "./plan-doc";
import {
  deadKeys,
  type Fail,
  fail,
  invalid,
  otherKeys,
  type PlanEnv,
  releasedKeys,
  reviseBase,
} from "./plan-refusal";
import type { DeliveryEffect, PlanDoc } from "./plan-types";
import { stripUndefined } from "./revision-support";
import { validatePlan } from "./validate-plan";

/* Plan revision: a new version from add / cancel / modify, compare-and-set on the base version. History is kept. The new version
   is always `valid`: the owner approves it (approve_plan) before any item changes. */

/** Item statuses a revision may still change. */
const NOT_STARTED = new Set(["pending", "ready"]);

/** What a revision changes. */
export interface Edit {
  add: ItemInput[];
  /** Full replacement of the acceptance criteria; omit to keep them. */
  acceptanceCriteria?: string[] | undefined;
  cancel: string[];
  modify: {
    key: string;
    brief?: string | undefined;
    location?: string | undefined;
    dependsOn?: string[] | undefined;
    risk?: string | undefined;
  }[];
  envelope?: EnvelopeInput | undefined;
  effects?: DeliveryEffect[] | undefined;
}

/** Outcome of a revision: the new version waits for the owner. */
export interface Revised {
  ok: true;
  planId: string;
  version: number;
  status: "valid";
}

/** A new version from edits, checked against `baseVersion` (a stale base is refused). History is kept. */
export function revisePlan(
  db: Database,
  a: { planId: string; baseVersion: number; edit: Edit; reason: string; env: PlanEnv },
): Revised | Fail {
  const found = reviseBase(db, a.planId, a.baseVersion);
  if (!found.ok) return found;
  const { base } = found;
  const baseDoc = docOfRow(base);
  const rows = new Map(childrenOf(db, base.goalId).map((i) => [i.itemKey, i] as const));
  const keys = new Set(baseDoc.items.map((i) => i.key));
  const touched = [...a.edit.cancel, ...a.edit.modify.map((m) => m.key)];
  const unknown = touched.find((k) => !keys.has(k));
  if (unknown) return fail("UNKNOWN_KEY", `Item ${unknown} is not in plan v${base.version}.`);
  // A row that started is never modified, whatever the base (a pending version would show text that the approval cannot run).
  const started = a.edit.modify.find((m) => {
    const row = rows.get(m.key);
    return row !== undefined && !NOT_STARTED.has(row.status);
  });
  if (started)
    return fail(
      "ITEM_STARTED",
      `Item ${started.key} already started: it cannot be modified, cancel it instead.`,
    );
  const items = [
    ...baseDoc.items
      .filter((i) => !a.edit.cancel.includes(i.key))
      .map((i) => {
        const m = a.edit.modify.find((x) => x.key === i.key);
        return m ? toPlanItem({ ...i, ...stripUndefined(m) }) : i;
      }),
    ...a.edit.add.map(toPlanItem),
  ];
  const oldEnv = baseDoc.envelope;
  const acceptanceCriteria = a.edit.acceptanceCriteria ?? baseDoc.acceptanceCriteria;
  const spentUsd = spentOf(db, base.goalId);
  // The budget is recomputed by code on every revision. An approved budget is never lowered: cancelled items may already
  // have spent part of it.
  const computed = planBudgetUsd({ items, verifies: acceptanceCriteria.length > 0, spentUsd });
  const budgetUsd = base.status === "approved" ? Math.max(computed, oldEnv.budgetUsd) : computed;
  const doc: PlanDoc = {
    items,
    acceptanceCriteria,
    envelope: buildEnvelope(
      a.edit.envelope ?? oldEnv,
      items,
      budgetUsd,
      a.edit.effects ?? oldEnv.effects,
    ),
  };
  const errors = validatePlan(doc, {
    ...a.env,
    // The goal's other items stay usable as dependencies.
    existingKeys: otherKeys(db, base.goalId, [...keys]),
    deadKeys: deadKeys(db, base.goalId),
    releasedKeys: releasedKeys(db, base.goalId),
    revisions: base.version,
    spentUsd,
  });
  if (errors.length) return invalid(errors);
  // One transaction: the new version and the supersede of the one nobody approved land together or not at all.
  const next = db.transaction(() => {
    const row = insertPlanVersion(db, {
      id: base.id,
      goalId: base.goalId,
      strategy: base.strategy,
      objective: base.objective,
      reason: a.reason,
      status: "valid",
      ...rowFieldsOf(doc),
    });
    // A version nobody approved is replaced; an approved one stays in force until its successor is approved.
    if (base.status === "valid")
      casPlanStatus(db, base.id, base.version, "valid", "superseded", a.reason);
    return row;
  })();
  return { ok: true, planId: next.id, version: next.version, status: "valid" };
}
