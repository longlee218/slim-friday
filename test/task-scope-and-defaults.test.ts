import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import { handleAdd } from "../src/orchestrator/lead/lead-task-handlers";
import { createPlanHandler, type PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { getItem } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { item } from "./waves-fixture";

/* Phase 4 rule 3 scope and the priority default, not covered by task-tools.test.ts: the duplicate check only looks at
   the caller's own thread and, for Plan create, skips the planner's own goal; `add` without a priority stores 0. */

let db: Database;
afterEach(() => {
  db?.close();
  db = undefined as never;
});

/** A lead port on `threadId` over the shared db; each call gets its own lead ctx. */
function leadPort(threadId: string) {
  const port = createDbEffectPort({
    db,
    threadId,
    env: { workerRoles: ["developer", "scout"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ answer: "Yes", timedOut: false }),
      post: async () => {},
    },
  });
  let n = 0;
  return () => ({
    port,
    threadId,
    leadTurnId: `lt${++n}`,
    inputId: `in-${threadId}-${n}`,
    run: { dispatched: 0 },
  });
}

const SAME = { subject: "Migrate the database", brief: "Migrate the users database to postgres" };
const dispatchSame = (ctx: () => any) =>
  handleDispatch(ctx(), {
    strategy: "DIRECT",
    intent: "migrate",
    reason: "r",
    assignments: [{ key: "m", ...SAME, role: "developer", dependsOn: [] }],
  } as never);

test("rule 3 scope: similar open work of ANOTHER thread is not a duplicate", async () => {
  db = openDb(":memory:");
  const a = leadPort("th-a");
  const b = leadPort("th-b");
  expect(await dispatchSame(a)).toMatchObject({ ok: true });
  expect(await dispatchSame(b)).toMatchObject({ ok: true });
});

test("rule 3 scope: Plan create does not flag the planner's own goal's earlier items (a finished wave or version)", async () => {
  db = openDb(":memory:");
  const w = createPlanPort(db, "th-p").requestPlan({ key: "k1", objective: "migrate" });
  if (!w.ok) throw new Error("no goal");
  // An earlier wave of this very goal: an open item with the same words.
  insertOwnedTask(db, {
    id: "wave-1",
    threadId: "th-p",
    ownerRole: "developer",
    status: "ready",
    scope: SAME.brief,
    correlationId: w.goalId,
    parentId: w.goalId,
    itemKey: "w1",
    dependsOn: [],
    brief: SAME.brief,
    subject: SAME.subject,
  });
  const ctx: PlannerCtx = {
    db,
    threadId: "th-p",
    goalId: w.goalId,
    workers: dispatchableWorkers(),
    locations: [{ name: "repo", path: "/x" }],
    channelDigest: () => "",
  };
  const r = createPlanHandler(ctx, {
    goalId: w.goalId,
    items: [item("p1", SAME)],
    acceptanceCriteria: ["works"],
    envelope: { locations: ["repo"], riskClasses: ["R0", "R1"], bounds: { maxItems: 8, maxGb: 1 } },
    budgetUsd: 3,
    effects: [],
  } as never);
  expect(r).not.toMatchObject({ code: "DUPLICATE_SUSPECT" });
});

test("rule 4 default: an add without priority stores 0 (normal)", async () => {
  db = openDb(":memory:");
  const ctx = leadPort("th-d");
  await handleDispatch(ctx(), {
    strategy: "DIRECT",
    intent: "one",
    reason: "r",
    assignments: [
      { key: "main", subject: "Main work", role: "developer", brief: "Main work", dependsOn: [] },
    ],
  } as never);
  const r = (await handleAdd(ctx(), {
    key: "docs",
    subject: "Write notes",
    role: "scout",
    brief: "Write the notes",
    dependsOn: [],
  } as never)) as unknown as { itemId: string };
  expect(getItem(db, r.itemId)?.priority).toBe(0);
});
