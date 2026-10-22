import type { Database } from "bun:sqlite";
import {
  ORCHESTRATE_ACTION_CREATE_PLAN,
  ORCHESTRATE_ACTION_LIST,
  ORCHESTRATE_ACTION_REVISE_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import { getOwnedTask } from "../../storage/owned-task-store";
import {
  casPlanStatus,
  getPlan,
  insertPlanVersion,
  planIdOfGoal,
  planVersions,
  type WorkPlanRow,
} from "../../storage/work-plan-store";
import { planBudgetUsd } from "../budget/plan-budget";
import { spentOf } from "../budget/task-budget";
import { type Applied, abortRuns, materialize } from "./materialize-items";
import {
  buildEnvelope,
  docOfRow,
  type EnvelopeInput,
  type ItemInput,
  rowFieldsOf,
  toPlanItem,
} from "./plan-doc";
import { type Fail, fail, invalid, type PlanEnv, validatorCtx } from "./plan-refusal";
import { budgetSpentMessage, type DeliveryEffect, type PlanDoc } from "./plan-types";
import { validatePlan } from "./validate-plan";

/* Plan lifecycle over the db: create, revise (compare-and-set on the base version), approve, reject. Every version is
   kept; the statuses are draft | valid | approved | superseded | rejected. Pure of IO: the owner question is the caller's. */

/**
 * Store a new plan for a goal after validation: version 1, or the next version of the goal's plan when every earlier
 * version was rejected (the owner turned it down or it expired: the lead re-plans inside the goal). A goal whose plan is
 * valid or approved is refused: revise it.
 */
export function createPlan(
  db: Database,
  a: {
    goalId: string;
    objective: string;
    items: ItemInput[];
    acceptanceCriteria: string[];
    envelope: EnvelopeInput;
    effects: DeliveryEffect[];
    env: PlanEnv;
  },
): ({ ok: true } & { plan: WorkPlanRow }) | Fail {
  const prior = planIdOfGoal(db, a.goalId);
  if (
    prior &&
    planVersions(db, prior).some((v) => v.status !== "rejected" && v.status !== "superseded")
  )
    return fail(
      "PLAN_EXISTS",
      `This goal has a plan: call ${orchestrateRef(ORCHESTRATE_ACTION_REVISE_PLAN)}.`,
    );
  const items = a.items.map(toPlanItem);
  // The budget is computed by code from the items' role ceilings (the lead never sets it).
  const budgetUsd = planBudgetUsd({
    items,
    verifies: a.acceptanceCriteria.length > 0,
    spentUsd: spentOf(db, a.goalId),
  });
  const doc: PlanDoc = {
    items,
    acceptanceCriteria: a.acceptanceCriteria,
    envelope: buildEnvelope(a.envelope, items, budgetUsd, a.effects),
  };
  const errors = validatePlan(doc, validatorCtx(db, a.goalId, a.env, [], 0));
  if (errors.length) return invalid(errors);
  const plan = insertPlanVersion(db, {
    id: prior ?? crypto.randomUUID(),
    goalId: a.goalId,
    strategy: "PLAN",
    objective: a.objective,
    reason: null,
    status: "valid",
    ...rowFieldsOf(doc),
  });
  return { ok: true, plan };
}

/** Why approving `row` would be refused now (goal closed, budget spent), or undefined. Read-only: nothing is written. */
export function approvalBlocker(db: Database, row: WorkPlanRow): Fail | undefined {
  if (getOwnedTask(db, row.goalId)?.status !== "open")
    return fail(
      "GOAL_CLOSED",
      `Goal ${row.goalId} is no longer open: the plan cannot start. ${orchestrateRef(ORCHESTRATE_ACTION_LIST)}; then ${orchestrateRef(ORCHESTRATE_ACTION_CREATE_PLAN)} with the open goal's id, or without goalId for a fresh plan.`,
    );
  // The goal may have spent on since the plan was stored: a budget at or below the spend could never start an item.
  if (row.budgetUsd !== null && row.budgetUsd <= spentOf(db, row.goalId))
    return fail(
      "BUDGET",
      budgetSpentMessage(
        row.budgetUsd,
        spentOf(db, row.goalId),
        `Fix: ${orchestrateRef(ORCHESTRATE_ACTION_CREATE_PLAN)} with goalId ${row.goalId} so the plan fits, or tell the owner.`,
      ),
    );
  return undefined;
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
  if (!row)
    return fail(
      "NO_PLAN",
      `Plan ${planId} v${version} not found: get the goal and use the current valid version.`,
    );
  const blocked = approvalBlocker(db, row);
  if (blocked) return blocked;
  if (!casPlanStatus(db, planId, version, "valid", "approved"))
    return fail(
      "PLAN_NOT_VALID",
      `Plan v${version} is ${row.status}, not valid: get the goal and use the current valid version.`,
    );
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

/** Reject a `valid` version. The owner turned down the plan, not the goal: it stays open so the lead can re-plan in it (until it is old, see plan-expiry). */
export function rejectVersion(
  db: Database,
  planId: string,
  version: number,
  reason: string,
): { ok: true } | Fail {
  const row = getPlan(db, planId, version);
  if (!row)
    return fail(
      "NO_PLAN",
      `Plan ${planId} v${version} not found: get the goal and use the current valid version.`,
    );
  if (!casPlanStatus(db, planId, version, "valid", "rejected", reason))
    return fail(
      "PLAN_NOT_VALID",
      `Plan v${version} is ${row.status}, not valid: get the goal and use the current valid version.`,
    );
  return { ok: true };
}
