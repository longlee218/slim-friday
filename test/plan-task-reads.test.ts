import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { buildServers } from "../src/mcp/mcp-servers";
import { PLAN_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import { PLAN_TOOL } from "../src/mcp/plan/tools/PlanTool/constants";
import { createPlanPort } from "../src/orchestrator/goal/effect-port-plan";
import type { PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { dispatchableWorkers, ROLES } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { insertOwnedTask } from "../src/storage/owned-task-store";

/* The planner's `Plan` tool reads of phase 4 rule 3 (`get`, `search`) and the lead's shared read rules, through the real
   MCP server. The lead's goal and item are inserted directly on the same thread (a planner goal is open on it). */

let db: Database;
afterEach(() => {
  db?.close();
  db = undefined as never;
});

/** A planner goal on thread `th1`, a lead goal with one item on the same thread and one item on another thread. */
function setup() {
  db = openDb(":memory:");
  const w = createPlanPort(db, "th1").requestPlan({ key: "k1", objective: "build it" });
  if (!w.ok) throw new Error("no goal");
  insertOwnedTask(db, {
    id: "lead-goal",
    threadId: "th1",
    ownerRole: "lead",
    status: "ready",
    scope: "Update the docs",
    correlationId: "c1",
    structureOwner: "lead",
  });
  insertOwnedTask(db, {
    id: "lead-docs",
    threadId: "th1",
    ownerRole: "scout",
    status: "ready",
    scope: "Update readme docs",
    correlationId: "c1",
    parentId: "lead-goal",
    itemKey: "docs",
    dependsOn: [],
    brief: "rewrite the readme docs",
    subject: "Update readme docs",
  });
  insertOwnedTask(db, {
    id: "other-docs",
    threadId: "th2",
    ownerRole: "scout",
    status: "ready",
    scope: "readme docs secret",
    correlationId: "c2",
    parentId: "other-goal",
    itemKey: "docs",
    dependsOn: [],
    brief: "readme docs secret",
    subject: "readme docs secret",
  });
  const ctx: PlannerCtx = {
    db,
    threadId: "th1",
    goalId: w.goalId,
    workers: dispatchableWorkers(),
    locations: [{ name: "repo", path: "/x" }],
    channelDigest: () => "",
  };
  const server = buildServers(ROLES.planner!, { plan: ctx })[PLAN_MCP_SERVER] as unknown as {
    instance: {
      _registeredTools: Record<string, { handler: (a: object, e: object) => Promise<any> }>;
    };
  };
  /** Call an action of the `Plan` tool; returns the parsed JSON reply. */
  const call = async (action: string, params: object) =>
    JSON.parse(
      (await server.instance._registeredTools[PLAN_TOOL]!.handler({ action, params }, {}))
        .content[0].text,
    );
  return { goalId: w.goalId, call };
}

test("planner search (rule 3): finds this thread's lead tasks by words; another thread stays out", async () => {
  const { call } = setup();
  const r = await call("search", { query: "readme docs" });
  expect(r.ok).toBe(true);
  expect(r.matches.map((m: { id: string }) => m.id)).toContain("lead-docs");
  expect(r.matches.map((m: { id: string }) => m.id)).not.toContain("other-docs");
});

test("planner get: this thread's item in full; a task of another thread is BAD_TASK", async () => {
  const { call } = setup();
  expect(await call("get", { taskId: "lead-docs" })).toMatchObject({
    ok: true,
    kind: "item",
    key: "docs",
    subject: "Update readme docs",
  });
  expect(await call("get", { taskId: "other-docs" })).toMatchObject({
    ok: false,
    code: "BAD_TASK",
  });
});

test("planner get on the lead's goal shows its structure owner (lead) and its items", async () => {
  const { call } = setup();
  expect(await call("get", { taskId: "lead-goal" })).toMatchObject({
    ok: true,
    kind: "goal",
    structureOwner: "lead",
  });
});

test("planner search and get: bad params are BAD_PARAMS (empty query, empty task id)", async () => {
  const { call } = setup();
  expect(await call("search", { query: "" })).toMatchObject({ code: "BAD_PARAMS" });
  expect(await call("get", { taskId: "" })).toMatchObject({ code: "BAD_PARAMS" });
});

test("planner create: an item without a subject is BAD_PARAMS (rule 6 applies to planner items)", async () => {
  const { goalId, call } = setup();
  const r = await call("create", {
    goalId,
    items: [
      {
        key: "a",
        role: "developer",
        brief: "do a",
        dependsOn: [],
        risk: "R1",
      },
    ],
    acceptanceCriteria: ["works"],
    envelope: { locations: ["repo"], riskClasses: ["R0", "R1"], bounds: { maxItems: 8, maxGb: 1 } },
    budgetUsd: 3,
    effects: [],
  });
  expect(r).toMatchObject({ code: "BAD_PARAMS" });
  expect(r.message).toContain("subject");
});

test("the Plan tool refuses an unknown action with BAD_ACTION and the action list", async () => {
  const { call } = setup();
  const r = await call("delete", {});
  expect(r).toMatchObject({ code: "BAD_ACTION" });
  expect(r.message).toContain("search");
});

test("planner get: an item key of the planner's own goal reads that item; a key of another goal stays BAD_TASK", async () => {
  const { goalId, call } = setup();
  insertOwnedTask(db, {
    id: "plan-item-uuid",
    threadId: "th1",
    ownerRole: "developer",
    status: "pending",
    scope: "build b",
    correlationId: "c3",
    parentId: goalId,
    itemKey: "impl-b",
    dependsOn: [],
    brief: "build b",
    subject: "Build b",
  });
  expect(await call("get", { taskId: "impl-b" })).toMatchObject({
    ok: true,
    kind: "item",
    key: "impl-b",
  });
  // "docs" is a key in the lead's goal, not in the planner's: not resolved.
  expect(await call("get", { taskId: "docs" })).toMatchObject({ ok: false, code: "BAD_TASK" });
});
