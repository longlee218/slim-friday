import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { renderUserNotice } from "../src/ingress/user-copy";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { logger } from "../src/observability/logger";
import { approveVersion, createPlan } from "../src/orchestrator/plan/plan-lifecycle";
import type { DeliveryEffect } from "../src/orchestrator/plan/plan-types";
import { expectedDelivery } from "../src/orchestrator/turns/completion";
import { closeTurn } from "../src/orchestrator/turns/turn-result";
import { beginTurn } from "../src/orchestrator/turns/turn-tracker";
import { ROLES } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { appendEffect } from "../src/storage/effect-log-store";
import { childrenOf } from "../src/storage/owned-item-store";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { openPlanGoal } from "./plan-fixture";

/* Delivery note: expected effects = the approved plan's `effects` list only, judged on the goal's LAST item only. */

let db: Database;
afterEach(() => db?.close());
const NOTE = renderUserNotice({ kind: "note", state: "no-delivery" }, "en");
const dev = ROLES.developer!;
const ENV = { workerRoles: ["developer"], locations: ["repo"] };

/** A goal with a completed planner item and two plan items `a` -> `b` (pending); the plan is approved with `effects`. */
function goalWithPlan(effects: DeliveryEffect[]) {
  db = openDb(":memory:");
  const w = openPlanGoal(db, "th", "o");
  if (!w.ok) throw new Error("no goal");
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE parent_id = ?").run(w.goalId);
  const mk = (key: string, dependsOn: string[]) =>
    ({ key, role: "developer", brief: `do ${key}`, dependsOn, risk: "R1" }) as const;
  const r = createPlan(db, {
    goalId: w.goalId,
    objective: "o",
    items: [mk("a", []), mk("b", ["a"])],
    acceptanceCriteria: [],
    envelope: { locations: ["repo"], riskClasses: ["R1"], bounds: { maxItems: 8, maxGb: 1 } },
    effects,
    env: ENV,
  });
  if (!r.ok) throw new Error(r.message);
  approveVersion(db, r.plan.id, 1);
  // Approval materialized the plan items as children of the goal: look one up by its key.
  const item = (key: string) => childrenOf(db, w.goalId).find((i) => i.itemKey === key)!.id;
  return { goalId: w.goalId, item };
}

/** Run item `id` to a COMPLETED report and return the reply. */
function complete(goalId: string, id: string): string {
  const turnId = `t-${id}`;
  beginTurn(
    db,
    logger,
    { turnId, threadId: "th", source: "test" },
    { location: "*", role: dev.name, ownedTaskId: id },
  );
  const want = expectedDelivery(db, dev, goalId);
  return closeTurn(
    db,
    { turnId, threadId: "th" },
    { text: "done", outcome: "success", sessionId: undefined },
    {
      language: "en",
      stopping: false,
      t0: Date.now(),
      location: "*",
      resultKind: "COMPLETED",
      delivery: want,
    },
  );
}

const pushRow = (goalId: string) =>
  appendEffect(db, {
    id: "e1",
    threadId: "th",
    goalId,
    tool: GIT_PUSH_TOOL,
    scope: "repo",
    grantedBy: "plan",
    result: JSON.stringify({ code: 0 }),
  });

test("an early item of a 2-item plan completes with no note", () => {
  const { goalId, item } = goalWithPlan(["GitPush"]);
  const a = item("a");
  item("b");
  expect(complete(goalId, a)).not.toContain(NOTE);
  expect(getOwnedTask(db, a)?.status).toBe("completed");
});

test("the last item without the plan's effect row gets the note; with the row it does not", () => {
  const { goalId, item } = goalWithPlan(["GitPush"]);
  const a = item("a");
  const b = item("b");
  complete(goalId, a);
  expect(complete(goalId, b)).toContain(NOTE);
  expect(getOwnedTask(db, b)?.status).toBe("completed");
  expect(childrenOf(db, goalId).every((i) => i.status === "completed")).toBe(true);

  const two = goalWithPlan(["GitPush"]);
  const a2 = two.item("a");
  const b2 = two.item("b");
  complete(two.goalId, a2);
  pushRow(two.goalId);
  expect(complete(two.goalId, b2)).not.toContain(NOTE);
});

test("a goal with no approved plan effects (DIRECT) expects nothing", () => {
  const { goalId, item } = goalWithPlan([]);
  expect(expectedDelivery(db, dev, goalId)).toBeUndefined();
  expect(complete(goalId, item("a"))).not.toContain(NOTE);
  expect(expectedDelivery(db, dev, "no-such-goal")).toBeUndefined();
});

test("a read-only role expects nothing even when the plan lists effects", () => {
  const { goalId } = goalWithPlan(["GitPush"]);
  expect(expectedDelivery(db, ROLES.scout!, goalId)).toBeUndefined();
  expect(expectedDelivery(db, dev, goalId)).toEqual({ goalId, tools: ["GitPush"] });
});
