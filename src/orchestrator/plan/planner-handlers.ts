import type { Database } from "bun:sqlite";
import { clip, redactText } from "../../observability/redact";
import { countsTowardCap } from "../../roles/role-registry";
import type { RoleDefinition } from "../../roles/role-types";
import { childrenOf } from "../../storage/owned-item-store";
import { taskScope } from "../../storage/owned-task-store";
import { getPlan, latestPlan, planIdOfGoal } from "../../storage/work-plan-store";
import { GOAL_BUDGET_USD } from "../budget/task-budget";
import { type Reply, refuse } from "../reply";
import { createPlan, type Fail, type PlanEnv, validateStored } from "./plan-lifecycle";
import { revisePlan } from "./plan-revision";
import type {
  CreatePlanInput,
  GoalInput,
  ProposeRevisionInput,
  ValidatePlanInput,
} from "./plan-schemas";
import { PLANNER_KEY } from "./plan-types";

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
}

/** Chars of the objective / an excerpt shown to the planner. */
const TEXT_CHARS = 2000;
const EXCERPT_CHARS = 300;

/** Validator facts from the run's registries. */
const planEnvOf = (c: PlannerCtx): PlanEnv => ({
  workerRoles: c.workers.map((w) => w.name),
  locations: c.locations.map((l) => l.name),
  goalBudgetUsd: GOAL_BUDGET_USD,
});

/** A lifecycle refusal as a tool reply (the validator's list goes into the message). */
const failReply = (f: Fail): Reply => refuse(f.code, f.message);

/** Refusal for a goal that is not the run's goal. */
export const wrongGoal = (id: string): Reply =>
  refuse("BAD_TASK", `Goal ${id} is not the goal of this run.`);

/** A plan version of this run's goal, or a refusal. */
function ownPlan(c: PlannerCtx, planId: string, version: number) {
  const row = getPlan(c.db, planId, version);
  return row && row.goalId === c.goalId ? row : undefined;
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
  };
}

/** The worker roles a plan may use. */
export const getAgentCapabilities = (c: PlannerCtx): Reply => ({
  ok: true,
  roles: c.workers.map((w) => ({
    name: w.name,
    whenToUse: w.whenToUse,
    capabilities: w.capabilities,
    sideEffects: w.sideEffects,
    concurrency: countsTowardCap(w) ? "limited" : "free",
  })),
});

/** Store version 1 of the goal's plan; coded errors when the validator refuses it. */
export function createPlanHandler(c: PlannerCtx, i: CreatePlanInput): Reply {
  if (i.goalId !== c.goalId) return wrongGoal(i.goalId);
  const r = createPlan(c.db, {
    ...i,
    objective: taskScope(c.db, c.goalId) ?? "",
    env: planEnvOf(c),
  });
  return r.ok
    ? { ok: true, planId: r.plan.id, version: r.plan.version, status: r.plan.status }
    : failReply(r);
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
  const { planId, baseVersion, reason, ...edit } = i;
  const r = revisePlan(c.db, { planId, baseVersion, reason, edit, env: planEnvOf(c) });
  if (!r.ok) return failReply(r);
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
