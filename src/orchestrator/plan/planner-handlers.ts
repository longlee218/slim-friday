import type { Database } from "bun:sqlite";
import { PLAN_GOAL_BUDGET_MAX_USD } from "../../config/model-routing";
import { clip, redactText } from "../../observability/redact";
import { countsTowardCap } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { childrenOf } from "../../storage/owned-item-store";
import { structureOwnerOf, taskScope } from "../../storage/owned-task-store";
import {
  getPlan,
  latestPlan,
  newestApprovedVersion,
  planIdOfGoal,
} from "../../storage/work-plan-store";
import { duplicateRefusal, similarOpenWork } from "../goal/task-reads";
import { type Reply, refuse } from "../reply";
import { docOfRow } from "./plan-doc";
import { createPlan, validateStored } from "./plan-lifecycle";
import type { Fail, PlanEnv } from "./plan-refusal";
import { diffVersions, isNoop, type RevisionDiff } from "./plan-revised";
import { revisePlan } from "./plan-revision";
import type {
  CreatePlanInput,
  GoalInput,
  ProposeRevisionInput,
  ValidatePlanInput,
} from "./plan-schemas";
import { PLANNER_KEY } from "./plan-types";
import { assertStructureOwner } from "./structure-owner";

/* The planner's seven tool handlers. They read the db and write plan rows only; the planner has no other effect. A
   planner run serves ONE goal: every tool refuses another goal's id. */

/** What a planner run's tools need (built per run by the worker runner). */
export interface PlannerCtx {
  db: Database;
  threadId: string;
  /** The goal this run plans for. */
  goalId: string;
  /** The roles a plan may use (the `dispatchable` roles). */
  workers: readonly RoleDefinition[];
  /** Locations of the thread's workspace. */
  locations: readonly { name: string; path: string }[];
  /** Channel digest block ("" = none): what the channel worked on lately. */
  channelDigest: () => string;
  /** Tell the owner in the thread, in one line, what an applied revision or a re-plan changed. Omitted = none. */
  notify?: (d: RevisionDiff) => void;
  /** A plan version was stored (any status): save it as an artifact. Omitted = none. */
  onVersion?: () => void;
}

/** Tell the owner of a diff unless it changed nothing. */
const notifyDiff = (c: PlannerCtx, d: RevisionDiff): void => {
  if (!isNoop(d)) c.notify?.(d);
};

/** Chars of the objective / an excerpt shown to the planner. */
const TEXT_CHARS = 2000;
const EXCERPT_CHARS = 300;

/** Validator facts from the run's registries. */
const planEnvOf = (c: PlannerCtx): PlanEnv => ({
  workerRoles: c.workers.map((w) => w.name),
  locations: c.locations.map((l) => l.name),
  goalBudgetUsd: PLAN_GOAL_BUDGET_MAX_USD, // a plan's own budget is what the goal gets, up to this ceiling (`goalBudgetOf`)
});

/** A lifecycle refusal as a tool reply (the validator's list goes into the message). */
const failReply = (f: Fail): Reply => refuse(f.code, f.message);

/** Refusal for a goal that is not the run's goal. */
export const wrongGoal = (id: string): Reply =>
  refuse("BAD_TASK", `Goal ${id} is not the goal of this run.`);

/** Refusal when the run's goal is not planner-owned (a goal the lead owns takes no plan before Orchestrate request_plan hands it over). */
const notPlannerGoal = (c: PlannerCtx): Reply | undefined => {
  const r = assertStructureOwner(structureOwnerOf(c.db, c.goalId), "planner");
  return r && refuse(r.code, r.message);
};

/** A plan version of this run's goal, or a refusal. */
function ownPlan(c: PlannerCtx, planId: string, version: number) {
  const row = getPlan(c.db, planId, version);
  return row && row.goalId === c.goalId ? row : undefined;
}

/** Deferred items of the goal's newest approved plan: key, role and a clipped brief. */
function deferredOf(db: Database, goalId: string) {
  const row = newestApprovedVersion(db, goalId);
  return (row ? docOfRow(row).items : [])
    .filter((i) => i.deferredScope)
    .map((i) => ({ key: i.key, role: i.role, brief: clip(redactText(i.brief), EXCERPT_CHARS) }));
}

/** Objective, findings, locations, channel digest, finished items and the plan so far. */
export function getProjectContext(c: PlannerCtx, i: GoalInput): Reply {
  if (i.goalId !== c.goalId) return wrongGoal(i.goalId);
  const items = childrenOf(c.db, c.goalId);
  const asks = items.filter((x) => x.itemKey?.startsWith(PLANNER_KEY));
  const planId = planIdOfGoal(c.db, c.goalId);
  const plan = planId ? latestPlan(c.db, planId) : undefined;
  return {
    ok: true,
    goalId: c.goalId,
    request: clip(redactText(asks.at(-1)?.brief ?? ""), TEXT_CHARS),
    locations: c.locations,
    channelDigest: clip(redactText(c.channelDigest()), TEXT_CHARS),
    finishedItems: items
      .filter((x) => x.status === "completed")
      .map((x) => ({
        key: x.itemKey,
        excerpt: clip(redactText(x.resultExcerpt ?? ""), EXCERPT_CHARS),
      })),
    plan: plan && { planId: plan.id, version: plan.version, status: plan.status },
    // Scope the approved plan left for a later wave (data): a wave planner activates some of it.
    deferredItems: deferredOf(c.db, c.goalId),
  };
}

/** The worker roles a plan may use, with the per-run budget ceiling of each. */
export const getAgentCapabilities = (c: PlannerCtx): Reply => ({
  ok: true,
  roles: c.workers.map((w) => ({
    name: w.name,
    whenToUse: w.whenToUse,
    capabilities: w.capabilities,
    sideEffects: w.sideEffects,
    // Per-run ceiling (USD) of this role: the planner sizes the goal budget from it, not from skill text.
    budgetUsd: w.budgetUsd,
    concurrency: countsTowardCap(w) ? "limited" : "free",
  })),
});

/** Store version 1 of the goal's plan; coded errors when the validator refuses it. */
export function createPlanHandler(c: PlannerCtx, i: CreatePlanInput): Reply {
  if (i.goalId !== c.goalId) return wrongGoal(i.goalId);
  const notOwner = notPlannerGoal(c);
  if (notOwner) return notOwner;
  // Search before create: the plan's items against the thread's open or recent work of OTHER goals (this goal's own
  // earlier plan versions and finished waves are not duplicates). `confirmNew` repeats the call.
  const { confirmNew, ...plan } = i;
  if (!confirmNew) {
    const dup = duplicateRefusal(similarOpenWork(c.db, c.threadId, plan.items, [c.goalId]));
    if (dup) return dup;
  }
  const prior = latestPlan(c.db, planIdOfGoal(c.db, c.goalId) ?? "");
  const r = createPlan(c.db, {
    ...plan,
    objective: taskScope(c.db, c.goalId) ?? "",
    env: planEnvOf(c),
  });
  if (!r.ok) return failReply(r);
  c.onVersion?.();
  // A re-plan after a reject or an expiry: the owner sees the same version line as for a revision.
  if (prior)
    notifyDiff(
      c,
      diffVersions(docOfRow(prior), docOfRow(r.plan), {
        from: prior.version,
        version: r.plan.version,
        reason: "re-plan",
      }),
    );
  return { ok: true, planId: r.plan.id, version: r.plan.version, status: r.plan.status };
}

/** Re-run the validator on a stored version. */
export function validatePlanHandler(c: PlannerCtx, i: ValidatePlanInput): Reply {
  const row = ownPlan(c, i.planId, i.version);
  if (!row) return refuse("NO_PLAN", `Plan ${i.planId} v${i.version} is not a plan of this goal.`);
  const errors = validateStored(c.db, row, planEnvOf(c));
  return { ok: true, valid: errors.length === 0, errors };
}

/** A new plan version from add / cancel / modify. */
export function proposeRevisionHandler(c: PlannerCtx, i: ProposeRevisionInput): Reply {
  const row = latestPlan(c.db, i.planId);
  if (!row || row.goalId !== c.goalId)
    return refuse("NO_PLAN", `Plan ${i.planId} is not a plan of this goal.`);
  const notOwner = notPlannerGoal(c);
  if (notOwner) return notOwner;
  const { planId, baseVersion, reason, ...edit } = i;
  const r = revisePlan(c.db, { planId, baseVersion, reason, edit, env: planEnvOf(c) });
  if (!r.ok) return failReply(r);
  c.onVersion?.();
  if (r.revised) notifyDiff(c, r.revised); // applied at once: the owner hears what changed
  return {
    ok: true,
    planId: r.planId,
    version: r.version,
    status: r.status,
    affected: r.affected,
    note:
      r.status === "valid" ? "The owner must approve this version (the lead asks)." : "Applied.",
  };
}
