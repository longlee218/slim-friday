import type { Database } from "bun:sqlite";
import {
  ORCHESTRATE_ACTION_CREATE_PLAN,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import {
  TASK_BOARD_ACTION_LIST,
  taskBoardRef,
} from "../../mcp/orchestration/tools/TaskBoardTool/action-names";
import { excerpt } from "../../observability/logger";
import { CHIEF_OF_STAFF_ROLE } from "../../roles/builtin/chief-of-staff-role";
import { planAskSince } from "../../storage/effect-log-store";
import {
  insertOwnedTask,
  setStructureOwner,
  taskScope,
  threadOfTask,
} from "../../storage/owned-task-store";
import { lastOwnerMessageAt } from "../../storage/thread-event-store";
import { getPlan, latestPlan, planIdOfGoal } from "../../storage/work-plan-store";
import { SCOPE_CHARS } from "../../tasks/task-resolver";
import { docOfRow } from "../plan/plan-doc";
import { approvalBlocker, approveVersion, createPlan, rejectVersion } from "../plan/plan-lifecycle";
import type { PlanEnv } from "../plan/plan-refusal";
import { diffVersions } from "../plan/plan-revised";
import { revisePlan } from "../plan/plan-revision";
import type { EffectPort, PlanWriteResult } from "./effect-port";
import { openGoalIdOf } from "./effect-port-queries";
import { duplicateRefusal, similarOpenWork } from "./task-reads";

/* The plan methods of the db-backed EffectPort: store the teammate's plan, read a plan for the owner, record the owner's decision. */

type PlanMethods = Pick<
  EffectPort,
  "createPlan" | "revisePlan" | "plan" | "pendingPlan" | "decidePlan"
>;

/** Thrown inside the create transaction to undo it with the refusal; never leaves this module. */
class Refusal {
  constructor(readonly fail: { code: string; message: string }) {}
}

/** Plan methods of one teammate run on one thread. */
export function createPlanPort(
  db: Database,
  threadId: string,
  correlationId?: string,
  /** Validator facts (roles a plan may use, the thread's locations), read at call time. */
  planEnv: () => PlanEnv = () => ({ workerRoles: [], locations: [] }),
): PlanMethods {
  const mine = (id: string): boolean => threadOfTask(db, id) === threadId;
  return {
    // One transaction: the goal (new, or the open one), the validated plan version and the audit row.
    createPlan: (i) => {
      if (i.goalId && (!mine(i.goalId) || i.goalId !== openGoalIdOf(db, threadId)))
        return {
          ok: false,
          code: "BAD_TASK",
          message: `Goal ${i.goalId} is not this thread's open goal: list and use the open goal's id.`,
        };
      // Search before create: the plan's items against the thread's open or recent work of OTHER goals; `confirmNew` repeats the call.
      if (!i.confirmNew) {
        const dup = duplicateRefusal(
          similarOpenWork(db, threadId, i.items, i.goalId ? [i.goalId] : []),
        );
        if (dup && !dup.ok) return { ok: false, code: dup.code, message: dup.message };
      }
      try {
        return db.transaction((): PlanWriteResult => {
          const goalId = i.goalId ?? crypto.randomUUID();
          const corr = correlationId ?? goalId;
          if (!i.goalId) {
            insertOwnedTask(db, {
              id: goalId,
              threadId,
              ownerRole: CHIEF_OF_STAFF_ROLE.name,
              status: "open",
              scope: excerpt(i.objective, SCOPE_CHARS),
              correlationId: corr,
              structureOwner: "plan",
            });
          } else setStructureOwner(db, goalId, "plan"); // a plan inside a teammate goal: the structure moves teammate -> plan
          const prior = latestPlan(db, planIdOfGoal(db, goalId) ?? "");
          const r = createPlan(db, {
            goalId,
            objective: taskScope(db, goalId) ?? i.objective,
            spec: i.spec,
            plan: i.plan,
            items: i.items,
            acceptanceCriteria: i.acceptanceCriteria,
            envelope: i.envelope,
            effects: i.effects,
            env: planEnv(),
          });
          if (!r.ok) throw new Refusal(r);
          const reply = {
            ok: true as const,
            goalId,
            planId: r.plan.id,
            version: r.plan.version,
            status: r.plan.status,
          };
          // A re-plan after a reject or an expiry: the owner sees the same version line as for a revision.
          return {
            ...reply,
            ...(prior && {
              diff: diffVersions(docOfRow(prior), docOfRow(r.plan), {
                from: prior.version,
                version: r.plan.version,
                reason: "re-plan",
              }),
            }),
          };
        })();
      } catch (err) {
        if (err instanceof Refusal) return { ok: false, ...err.fail };
        throw err;
      }
    },
    revisePlan: (w) => {
      const row = latestPlan(db, w.planId);
      if (!row || !mine(row.goalId))
        return {
          ok: false,
          code: "NO_PLAN",
          message: `Plan ${w.planId} is not a plan of this thread.`,
        };
      const r = revisePlan(db, {
        planId: w.planId,
        baseVersion: w.baseVersion,
        reason: w.reason,
        edit: w.edit,
        env: planEnv(),
      });
      if (!r.ok) return { ok: false, code: r.code, message: r.message };
      return {
        ok: true,
        goalId: row.goalId,
        planId: r.planId,
        version: r.version,
        status: r.status,
      };
    },
    plan: (planId, version) => {
      const row = getPlan(db, planId, version);
      if (!row || !mine(row.goalId)) return undefined;
      // Checked before the owner is asked (a second open goal, a closed goal or a spent budget makes the click useless).
      const blocker =
        openGoalIdOf(db, threadId) !== row.goalId
          ? {
              code: "GOAL_NOT_OPEN",
              message: `Goal ${row.goalId} is not this thread's open goal: the plan cannot start. ${taskBoardRef(TASK_BOARD_ACTION_LIST)}; then ${orchestrateRef(ORCHESTRATE_ACTION_CREATE_PLAN)} with the open goal's id, or without goalId for a fresh plan.`,
            }
          : approvalBlocker(db, row);
      // An ask that ended without a decision is not repeated until the teammate revises the version or the owner writes.
      const askedOutcome = planAskSince(db, planId, version, lastOwnerMessageAt(db, threadId));
      return {
        planId,
        version,
        status: row.status,
        ...(askedOutcome && { askedOutcome }),
        goalId: row.goalId,
        objective: row.objective,
        doc: docOfRow(row),
        ...(blocker && { blocker: { code: blocker.code, message: blocker.message } }),
      };
    },
    pendingPlan: () => {
      const goalId = openGoalIdOf(db, threadId);
      const planId = goalId && planIdOfGoal(db, goalId);
      const row = planId ? latestPlan(db, planId) : undefined;
      if (!row || row.status !== "valid") return undefined;
      // Asked already without a decision (timeout, typed answer, budget): the teammate may talk to the owner freely again.
      if (planAskSince(db, row.id, row.version, lastOwnerMessageAt(db, threadId))) return undefined;
      return { planId: row.id, version: row.version };
    },
    decidePlan: (planId, version, approve, reason) => {
      const row = getPlan(db, planId, version);
      if (!row || !mine(row.goalId))
        return {
          ok: false,
          code: "NO_PLAN",
          message: `Plan ${planId} v${version} not found: get the goal and use the current valid version.`,
        };
      if (!approve) return rejectVersion(db, planId, version, reason ?? "owner rejected");
      const r = approveVersion(db, planId, version);
      return r.ok ? { ok: true, created: r.created } : r;
    },
  };
}
