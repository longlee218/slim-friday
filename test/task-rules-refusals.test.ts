import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { createOrchestrateTool } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-tool";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { type LeadToolContext, leadCall } from "../src/orchestrator/lead/lead-call";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import { handleAdd, handleUpdate } from "../src/orchestrator/lead/lead-task-handlers";
import { ADD_ITEM_SHAPE } from "../src/orchestrator/lead/task-schemas";
import { openDb } from "../src/storage/db";
import { getItem } from "../src/storage/owned-item-store";
import { TH } from "./waves-fixture";

/* Task rules 2, 4, 5, 6 of phase 4 (refusals and edges not covered by task-tools.test.ts): dead dependencies,
   the subject / priority / role params as BAD_PARAMS, and the idempotency key of a lead call. */

let db: Database;
afterEach(() => {
  db?.close();
  db = undefined as never;
});

/** Real db port on thread TH; `ctx()` builds a lead ctx with a new input id per call. */
function setup() {
  db = openDb(":memory:");
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: { workerRoles: ["developer", "scout"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ answer: "Yes", timedOut: false }),
      post: async () => {},
    },
  });
  let n = 0;
  const ctx = (): LeadToolContext => ({
    port,
    threadId: TH,
    leadTurnId: `lt${++n}`,
    inputId: `in${++n}`,
    run: { dispatched: 0 },
  });
  return { port, ctx };
}

/** A DIRECT goal with one item `main` (subject and brief share no word with the adds used below). */
async function openGoal(
  ctx: () => LeadToolContext,
  subject = "Main work",
  brief = "Main work item",
) {
  return (await handleDispatch(ctx(), {
    strategy: "DIRECT",
    small: true,
    intent: "one",
    reason: "r",
    assignments: [{ key: "main", subject, role: "developer", brief, dependsOn: [] }],
  })) as unknown as { goalId: string; itemIds: string[] };
}

const addArgs = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  subject: key,
  role: "scout",
  brief: `${key} work`,
  dependsOn: [] as string[],
  ...over,
});

/** Tool with no lead ctx: BAD_PARAMS is answered before any handler runs. */
const tool = createOrchestrateTool({ lead: {} as never, titleCalls: { n: 0 } });
const callTool = async (action: string, params: object) => {
  const r = await tool.handler({ action, params } as never, {});
  return JSON.parse((r.content[0] as { text: string }).text) as { code: string; message: string };
};

test("rule 5: a dependency on a FAILED task is refused DEAD_DEPENDENCY, as on a cancelled one", async () => {
  const { ctx } = setup();
  await openGoal(ctx);
  expect(await handleAdd(ctx(), addArgs("keeper"))).toMatchObject({ ok: true });
  db.query("UPDATE owned_tasks SET status = 'failed' WHERE item_key = 'main'").run();
  const dead = await handleAdd(ctx(), addArgs("after", { dependsOn: ["main"] }));
  expect(dead).toMatchObject({ ok: false, code: "DEAD_DEPENDENCY" });
  expect((dead as any).message).toContain("Fix: Orchestrate add a replacement");
});

test("rule 3: a similar task that FAILED never blocks a new one; an OPEN one blocks at any age", async () => {
  const twin = { subject: "Fix the login bug", brief: "Fix the login bug in the auth module" };
  const s = setup();
  await openGoal(s.ctx, twin.subject, twin.brief);
  expect(await handleAdd(s.ctx(), addArgs("keeper"))).toMatchObject({ ok: true });
  db.query("UPDATE owned_tasks SET status = 'failed' WHERE item_key = 'main'").run();
  expect(await handleAdd(s.ctx(), { ...addArgs("again"), ...twin })).toMatchObject({ ok: true });

  // A fresh thread: the open twin is old (created long ago) and still matches.
  const t = setup();
  await openGoal(t.ctx, twin.subject, twin.brief);
  db.query("UPDATE owned_tasks SET created_at = 1 WHERE item_key = 'main'").run();
  expect(await handleAdd(t.ctx(), { ...addArgs("again"), ...twin })).toMatchObject({
    ok: false,
    code: "DUPLICATE_SUSPECT",
  });
});

test("rule 4: priority accepts 0, 10 and 100 only; any other value is a BAD_PARAMS", () => {
  const schema = z.object(ADD_ITEM_SHAPE);
  for (const priority of [0, 10, 100])
    expect(schema.safeParse({ ...addArgs("p"), priority }).success).toBe(true);
  for (const priority of [5, 50, 101, -1])
    expect(schema.safeParse({ ...addArgs("p"), priority }).success).toBe(false);
});

test("rule 6: a missing or empty subject, and a subject over 80 chars, are BAD_PARAMS naming subject", async () => {
  const { subject: _s, ...noSubject } = addArgs("a");
  for (const params of [
    noSubject,
    addArgs("a", { subject: "" }),
    addArgs("a", { subject: "s".repeat(81) }),
  ]) {
    const r = await callTool("add", params);
    expect(r.code).toBe("BAD_PARAMS");
    expect(r.message).toContain("subject");
  }
  const dispatch = await callTool("dispatch", {
    strategy: "DIRECT",
    small: true,
    intent: "x",
    reason: "x",
    assignments: [{ key: "main", role: "developer", brief: "x", dependsOn: [] }],
  });
  expect(dispatch).toMatchObject({ code: "BAD_PARAMS" });
  expect(dispatch.message).toContain("subject");
});

test("rule 2: the assignee (role) is required on add and on each dispatch assignment (BAD_PARAMS)", async () => {
  const { role: _r, ...noRole } = addArgs("a");
  expect(await callTool("add", noRole)).toMatchObject({ code: "BAD_PARAMS" });
  const noAssignee = await callTool("dispatch", {
    strategy: "DIRECT",
    small: true,
    intent: "x",
    reason: "x",
    assignments: [{ key: "main", subject: "x", brief: "x", dependsOn: [] }],
  });
  expect(noAssignee).toMatchObject({ code: "BAD_PARAMS" });
  expect(noAssignee.message).toContain("role");
});

test("rule 4 on update: an out-of-range priority is BAD_PARAMS and changes nothing", async () => {
  expect(await callTool("update", { taskId: "t", priority: 1000 })).toMatchObject({
    code: "BAD_PARAMS",
  });
});

test("rule 4: a priority set by update is stored on a task that has not started", async () => {
  const s = setup();
  const g = await openGoal(s.ctx);
  const add = (await handleAdd(s.ctx(), addArgs("docs"))) as unknown as { itemId: string };
  expect(await handleUpdate(s.ctx(), { taskId: add.itemId, priority: 100 })).toMatchObject({
    ok: true,
  });
  expect(getItem(db, add.itemId)?.priority).toBe(100);
  expect(getItem(db, g.itemIds[0] as string)?.priority).toBe(0);
});

test("idempotency key of a lead call holds the action: two actions with the same args both act; a repeat of one acts once", async () => {
  const s = setup();
  const c = { ...s.ctx(), inputId: "in-fixed" };
  let runs = 0;
  const act = async () => {
    runs++;
    return { reply: { ok: true as const } };
  };
  const args = { taskId: "same" };
  await leadCall(c, "steer", args, act);
  await leadCall(c, "cancel", args, act);
  expect(runs).toBe(2);
  await leadCall(c, "cancel", args, act);
  expect(runs).toBe(2);
});

test("a repeated identical add in one lead turn writes one task", async () => {
  const s = setup();
  await openGoal(s.ctx);
  const c = { ...s.ctx(), inputId: "in-fixed" };
  await handleAdd(c, addArgs("docs"));
  await handleAdd(c, addArgs("docs"));
  const rows = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM owned_tasks WHERE item_key = ?")
    .get("docs");
  expect(rows?.n).toBe(1);
});
