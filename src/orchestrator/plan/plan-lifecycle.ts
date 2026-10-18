import type { Database } from "bun:sqlite";
import { getOwnedTask } from "../../storage/owned-task-store";
import {
  casPlanStatus,
  getPlan,
  insertPlanVersion,
  planIdOfGoal,
  planVersions,
  type WorkPlanRow,
} from "../../storage/work-plan-store";
import { moveTaskTo } from "../../tasks/task-resolver";
import { spentOf } from "../budget/task-budget";
import { cancelSet } from "../goal/effect-port-queries";
import { type Applied, abortRuns, materialize } from "./materialize-items";
import {
  buildEnvelope,
  docOfRow,
  type EnvelopeInput,
  type ItemInput,
  rowFieldsOf,
  toPlanItem,
} from "./plan-doc";
import { deadKeys, type Fail, fail, invalid, otherKeys, type PlanEnv } from "./plan-refusal";
import {
  budgetSpentMessage,
  type DeliveryEffect,
  type PlanCtx,
  type PlanDoc,
  type PlanError,
} from "./plan-types";
import { validatePlan } from "./validate-plan";

/* Plan lifecycle over the db: create, revise (compare-and-set on the base version), approve, reject. Every version is
   kept; the statuses are draft | valid | approved | superseded | rejected. Pure of IO: the owner question is the caller's. */

/** What the validator reads about the goal: keys the plan does not own, dead keys, revisions so far, spend. */
const validatorCtx = (
  db: Database,
  goalId: string,
  env: PlanEnv,
  planKeys: readonly string[],
  revisions: number,
): PlanCtx => ({
  ...env,
  existingKeys: otherKeys(db, goalId, planKeys),
  deadKeys: deadKeys(db, goalId),
  revisions,
  spentUsd: spentOf(db, goalId),
});

/** Store version 1 of a goal's plan after validation. A second plan for the goal is refused: revise it. */
export function createPlan(
  db: Database,
  a: {
    goalId: string;
    objective: string;
    items: ItemInput[];
    acceptanceCriteria: string[];
    envelope: EnvelopeInput;
    budgetUsd: number;
    effects: DeliveryEffect[];
    env: PlanEnv;
  },
): ({ ok: true } & { plan: WorkPlanRow }) | Fail {
  if (planIdOfGoal(db, a.goalId))
    return fail("PLAN_EXISTS", "This goal has a plan: use ProposePlanRevision.");
  const items = a.items.map(toPlanItem);
  const doc: PlanDoc = {
    items,
    acceptanceCriteria: a.acceptanceCriteria,
    envelope: buildEnvelope(a.envelope, items, a.budgetUsd, a.effects),
  };
  const errors = validatePlan(doc, validatorCtx(db, a.goalId, a.env, [], 0));
  if (errors.length) return invalid(errors);
  const plan = insertPlanVersion(db, {
    id: crypto.randomUUID(),
    goalId: a.goalId,
    strategy: "PLAN",
    objective: a.objective,
    reason: null,
    status: "valid",
    ...rowFieldsOf(doc),
  });
  return { ok: true, plan };
}

/** Re-run the validator on a stored version (read-only). */
export function validateStored(db: Database, row: WorkPlanRow, env: PlanEnv): PlanError[] {
  const doc = docOfRow(row);
  const keys = doc.items.map((i) => i.key);
  return validatePlan(doc, validatorCtx(db, row.goalId, env, keys, row.version - 1));
}

/**
 * Approval core, in the caller's transaction: the goal must still be open, then CAS, older approved versions
 * superseded, items created / changed / cancelled. Returns the run ids to abort after the commit, or a refusal
 * (nothing written: the CAS comes after the check).
 */
export function applyApproval(
  db: Database,
  planId: string,
  version: number,
): (Applied & { abort: string[]; ok: true }) | Fail {
  const row = getPlan(db, planId, version);
  if (!row) return fail("NO_PLAN", `Plan ${planId} v${version} not found.`);
  if (getOwnedTask(db, row.goalId)?.status !== "open")
    return fail("GOAL_CLOSED", `Goal ${row.goalId} is no longer open: the plan cannot start.`);
  // The goal may have spent on since the plan was stored: a budget at or below the spend could never start an item.
  if (row.budgetUsd !== null && row.budgetUsd <= spentOf(db, row.goalId))
    return fail("BUDGET", budgetSpentMessage(row.budgetUsd, spentOf(db, row.goalId)));
  if (!casPlanStatus(db, planId, version, "valid", "approved"))
    return fail("PLAN_NOT_VALID", `Plan v${version} is ${row.status}, not valid.`);
  const prev = planVersions(db, planId).filter(
    (v) => v.version < version && v.status === "approved",
  );
  for (const p of prev)
    casPlanStatus(db, planId, p.version, "approved", "superseded", `superseded by v${version}`);
  const doc = docOfRow(row);
  const keep = new Set(doc.items.map((i) => i.key));
  const dropped = prev
    .flatMap((p) => docOfRow(p).items.map((i) => i.key))
    .filter((k) => !keep.has(k));
  const done = materialize(db, {
    goalId: row.goalId,
    planId,
    version,
    doc,
    cancelKeys: dropped,
    releaseBlocked: prev.length === 0,
  });
  return { ok: true, ...done };
}

/** Approve a `valid` version in one transaction (see `applyApproval`); aborts the cancelled items' runs after the commit. */
export function approveVersion(
  db: Database,
  planId: string,
  version: number,
): (Applied & { ok: true }) | Fail {
  const out = db.transaction(() => applyApproval(db, planId, version))();
  if (!out.ok) return out;
  abortRuns(out.abort);
  return { ok: true, created: out.created, modified: out.modified, cancelled: out.cancelled };
}

/** Reject a `valid` version. A plan that never had an approved version closes its goal (nothing was agreed). */
export function rejectVersion(
  db: Database,
  planId: string,
  version: number,
  reason: string,
): { ok: true } | Fail {
  const row = getPlan(db, planId, version);
  if (!row) return fail("NO_PLAN", `Plan ${planId} v${version} not found.`);
  // One transaction: the CAS and the goal's cancels land together or not at all.
  const out = db.transaction((): { ok: true; abort: string[] } | Fail => {
    if (!casPlanStatus(db, planId, version, "valid", "rejected", reason))
      return fail("PLAN_NOT_VALID", `Plan v${version} is ${row.status}, not valid.`);
    if (planVersions(db, planId).some((v) => v.status === "approved"))
      return { ok: true, abort: [] };
    const ids = cancelSet(db, row.goalId);
    for (const id of ids) moveTaskTo(db, id, "cancelled");
    return { ok: true, abort: ids };
  })();
  if (!out.ok) return out;
  abortRuns(out.abort);
  return { ok: true };
}
