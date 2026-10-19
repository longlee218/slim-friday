import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAIN_CAP, DELEGATE_MAX } from "../src/config/lead-caps";
import { createDbEffectPort } from "../src/orchestrator/goal/effect-port-db";
import { handleDispatch } from "../src/orchestrator/lead/lead-handlers";
import { handleRequestPlan } from "../src/orchestrator/lead/lead-plan-handlers";
import {
  handleAdd,
  handleGet,
  handleSearch,
  handleUpdate,
} from "../src/orchestrator/lead/lead-task-handlers";
import { createPlanHandler, type PlannerCtx } from "../src/orchestrator/plan/planner-handlers";
import { dispatchableWorkers } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { getItem, setTaskResult } from "../src/storage/owned-item-store";
import { appendEvent } from "../src/storage/thread-event-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { item, spend, TH } from "./waves-fixture";

/* Phase 4 step 2A: the lead's add / update / get / search, the duplicate check (rule 3) on dispatch, add and Plan create. */

let db: Database;
const dirs: string[] = [];
afterEach(() => {
  db?.close();
  db = undefined as never; // the next test opens its own
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Real db port; `threadId` lets a test build a second thread on the same db. */
function setup(threadId = TH) {
  if (!db) db = openDb(":memory:");
  const port = createDbEffectPort({
    db,
    threadId,
    env: { workerRoles: ["developer", "scout", "tester"], locations: ["repo"] },
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ answer: "Yes", timedOut: false }),
      post: async () => {},
    },
  });
  let n = 0;
  const ctx = () => ({
    port,
    threadId,
    leadTurnId: `lt${++n}`,
    inputId: `in${threadId}${n}`,
    run: { dispatched: 0 },
  });
  return { port, ctx };
}

/* Subjects and briefs are built from the key so two tasks share almost no word (the duplicate check must stay quiet). */
const asg = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  subject: key,
  role: "developer",
  brief: `${key} work`,
  dependsOn: [] as string[],
  ...over,
});
const dispatch = (over: Record<string, unknown> = {}) => ({
  strategy: "DIRECT" as const,
  intent: "one",
  reason: "r",
  assignments: [asg("main")],
  ...over,
});
const addArgs = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  subject: key,
  role: "scout",
  brief: `${key} work`,
  dependsOn: [] as string[],
  ...over,
});

/** A lead-owned goal with the item `main`; returns the ids. */
async function leadGoal(over: Record<string, unknown> = {}) {
  const s = setup();
  const d = (await handleDispatch(s.ctx(), dispatch(over))) as unknown as {
    goalId: string;
    itemIds: string[];
  };
  return { ...s, goalId: d.goalId, mainId: d.itemIds[0] as string };
}
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

test("dispatch stores subject and priority on the items", async () => {
  const { mainId } = await leadGoal({ assignments: [asg("main", { priority: 100 })] });
  expect(getItem(db, mainId)).toMatchObject({ subject: "main", priority: 100 });
});

test("add: a task joins the open lead goal and starts ready; with a pending dependency it waits", async () => {
  const { ctx, goalId } = await leadGoal();
  expect(await handleAdd(ctx(), addArgs("docs"))).toMatchObject({
    ok: true,
    goalId,
    status: "ready",
  });
  const b = await handleAdd(ctx(), addArgs("report", { dependsOn: ["docs"], priority: 10 }));
  expect(b).toMatchObject({ ok: true, status: "pending" });
  expect(getItem(db, (b as unknown as { itemId: string }).itemId)).toMatchObject({
    dependsOn: ["docs"],
    priority: 10,
    subject: "report",
  });
  // The work order counts in the chain (a `start` event named after the action) and the audit row carries tool + action.
  const starts = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM thread_events WHERE thread_id = ? AND kind = 'start' AND payload LIKE '%\"action\":\"add\"%'",
    )
    .get(TH);
  expect(starts?.n).toBe(2);
  const audit = db
    .query<{ tool: string }, [string]>("SELECT tool FROM effect_log WHERE goal_id = ?")
    .all(goalId)
    .map((r) => r.tool);
  expect(audit).toContain("Orchestrate.add");
});

test("add: refused on a planner-owned goal (NOT_STRUCTURE_OWNER); a closed goal is GOAL_NOT_OPEN", async () => {
  const { ctx, goalId } = await leadGoal();
  expect(await handleRequestPlan(ctx(), { objective: "plan it", goalId })).toMatchObject({
    ok: true,
  });
  expect(await handleAdd(ctx(), addArgs("docs"))).toMatchObject({
    ok: false,
    code: "NOT_STRUCTURE_OWNER",
    message: expect.stringContaining("Orchestrate request_plan"),
  });
  for (const r of db
    .query<{ id: string }, [string]>("SELECT id FROM owned_tasks WHERE thread_id = ?")
    .all(TH))
    moveTaskTo(db, r.id, "cancelled");
  expect(await handleAdd(ctx(), addArgs("docs"))).toMatchObject({ code: "GOAL_NOT_OPEN" });
  expect(await handleAdd(ctx(), addArgs("docs", { goalId }))).toMatchObject({
    code: "GOAL_NOT_OPEN",
  });
});

test("add: dependency, key, role and location rules; a dead dependency is refused", async () => {
  const { ctx, mainId } = await leadGoal();
  expect(await handleAdd(ctx(), addArgs("x1", { dependsOn: ["ghost"] }))).toMatchObject({
    code: "UNKNOWN_DEP",
  });
  expect(
    await handleAdd(ctx(), addArgs("main", { subject: "other", brief: "other thing" })),
  ).toMatchObject({
    code: "DUPLICATE_KEY",
  });
  expect(await handleAdd(ctx(), addArgs("verify-3"))).toMatchObject({ code: "RESERVED_KEY" });
  expect(await handleAdd(ctx(), addArgs("x2", { role: "lead" }))).toMatchObject({
    code: "NOT_WORKER",
  });
  expect(await handleAdd(ctx(), addArgs("x3", { location: "nowhere" }))).toMatchObject({
    code: "BAD_LOCATION",
  });
  // A second live item keeps the goal open after `main` is cancelled.
  expect(await handleAdd(ctx(), addArgs("keeper"))).toMatchObject({ ok: true });
  moveTaskTo(db, mainId, "cancelled");
  expect(await handleAdd(ctx(), addArgs("x4", { dependsOn: ["main"] }))).toMatchObject({
    code: "DEAD_DEPENDENCY",
  });
});

test("add: a full lead goal needs a plan; a goal over budget takes no new task", async () => {
  const { ctx, mainId } = await leadGoal();
  for (const w of WORDS.slice(0, DELEGATE_MAX - 1))
    expect(await handleAdd(ctx(), addArgs(w))).toMatchObject({ ok: true });
  expect(await handleAdd(ctx(), addArgs("hotel"))).toMatchObject({ code: "NEEDS_PLAN" });
  spend(db, mainId, 1000);
  expect(await handleAdd(ctx(), addArgs("india"))).toMatchObject({ code: "NEEDS_PLAN" }); // full wins (checked first)
});

test("add: over budget is refused", async () => {
  const { ctx, mainId } = await leadGoal();
  spend(db, mainId, 1000);
  expect(await handleAdd(ctx(), addArgs("docs"))).toMatchObject({ code: "OVER_BUDGET" });
});

test("add: chain cap counts the start events since the owner's message", async () => {
  const { ctx } = await leadGoal();
  for (let i = 0; i < CHAIN_CAP; i++)
    appendEvent(db, { id: `s${i}`, threadId: TH, kind: "start", payload: {} });
  expect(await handleAdd(ctx(), addArgs("docs"))).toMatchObject({ code: "CHAIN_CAP" });
});

test("update: a not-started task changes; dependsOn moves it between pending and ready", async () => {
  const { ctx } = await leadGoal();
  const docs = (await handleAdd(ctx(), addArgs("docs"))) as unknown as { itemId: string };
  const rep = (await handleAdd(ctx(), addArgs("report", { dependsOn: ["docs"] }))) as unknown as {
    itemId: string;
  };
  expect(
    await handleUpdate(ctx(), {
      taskId: rep.itemId,
      subject: "Final report",
      brief: "write it up",
      priority: 100,
      role: "tester",
    }),
  ).toMatchObject({ ok: true });
  expect(getItem(db, rep.itemId)).toMatchObject({
    subject: "Final report",
    brief: "write it up",
    priority: 100,
    ownerRole: "tester",
  });
  // Drop the dependency: nothing left to wait for = ready. Add one back: waits again (a ready task goes back to pending).
  await handleUpdate(ctx(), { taskId: rep.itemId, dependsOn: [] });
  expect(getItem(db, rep.itemId)?.status).toBe("ready");
  await handleUpdate(ctx(), { taskId: rep.itemId, dependsOn: ["docs"] });
  expect(getItem(db, rep.itemId)).toMatchObject({ status: "pending", dependsOn: ["docs"] });
  // A loop is refused.
  expect(await handleUpdate(ctx(), { taskId: docs.itemId, dependsOn: ["report"] })).toMatchObject({
    code: "CYCLE",
  });
  expect(await handleUpdate(ctx(), { taskId: docs.itemId, dependsOn: ["docs"] })).toMatchObject({
    code: "UNKNOWN_DEP",
  });
  expect(await handleUpdate(ctx(), { taskId: docs.itemId })).toMatchObject({ code: "NO_CHANGE" });
  expect(await handleUpdate(ctx(), { taskId: docs.itemId, role: "lead" })).toMatchObject({
    code: "NOT_WORKER",
  });
});

test("update 10 -> 0 -> 10 inside one lead run applies each time (no replay of a stored result)", async () => {
  const { ctx } = await leadGoal();
  const t = (await handleAdd(ctx(), addArgs("flip"))) as unknown as { itemId: string };
  const run = ctx(); // ONE lead run: the same input id for all three calls
  for (const priority of [10, 0, 10] as const) {
    expect(await handleUpdate(run, { taskId: t.itemId, priority })).toMatchObject({ ok: true });
    expect(getItem(db, t.itemId)?.priority).toBe(priority);
  }
});

test("update: running and ended tasks are refused (ITEM_STARTED); a goal id and a foreign task are BAD_TASK", async () => {
  const { ctx, goalId, mainId } = await leadGoal();
  expect(await handleAdd(ctx(), addArgs("docs"))).toMatchObject({ ok: true });
  moveTaskTo(db, mainId, "running");
  expect(await handleUpdate(ctx(), { taskId: mainId, subject: "new" })).toMatchObject({
    ok: false,
    code: "ITEM_STARTED",
  });
  moveTaskTo(db, mainId, "completed");
  expect(await handleUpdate(ctx(), { taskId: mainId, subject: "new" })).toMatchObject({
    code: "ITEM_STARTED",
  });
  expect(await handleUpdate(ctx(), { taskId: goalId, subject: "new" })).toMatchObject({
    code: "BAD_TASK",
  });
  expect(await handleUpdate(ctx(), { taskId: "nope", subject: "new" })).toMatchObject({
    code: "BAD_TASK",
  });
});

test("update: refused on a planner-owned goal (NOT_STRUCTURE_OWNER)", async () => {
  const { ctx, goalId } = await leadGoal();
  const docs = (await handleAdd(ctx(), addArgs("docs"))) as unknown as { itemId: string };
  await handleRequestPlan(ctx(), { objective: "plan it", goalId });
  expect(await handleUpdate(ctx(), { taskId: docs.itemId, subject: "new" })).toMatchObject({
    code: "NOT_STRUCTURE_OWNER",
  });
});

test("get: an item in full (fields, full result text, last events), a goal with its items; another thread is BAD_TASK", async () => {
  const { ctx, goalId, mainId } = await leadGoal();
  const dir = mkdtempSync(join(tmpdir(), "get-"));
  dirs.push(dir);
  const file = join(dir, "main.md");
  const long = `# Result\n${"line of the result ".repeat(100)}`; // well above the 600-char excerpt
  writeFileSync(file, long);
  setTaskResult(db, mainId, { path: file, excerpt: "short excerpt", kind: "COMPLETED" });
  moveTaskTo(db, mainId, "running");
  appendEvent(db, {
    id: "e1",
    threadId: TH,
    kind: "result",
    taskId: goalId,
    itemId: mainId,
    payload: { x: 1 },
  });
  const got = (await handleGet(ctx(), { taskId: mainId })) as Record<string, any>;
  expect(got).toMatchObject({
    ok: true,
    kind: "item",
    id: mainId,
    key: "main",
    subject: "main",
    priority: 0,
  });
  expect(got.result).toContain("line of the result");
  expect(got.result.length).toBeGreaterThan(600);
  expect(got.events.map((e: { kind: string }) => e.kind)).toContain("result");
  const goal = (await handleGet(ctx(), { taskId: goalId })) as Record<string, any>;
  expect(goal).toMatchObject({ ok: true, kind: "goal", structureOwner: "lead" });
  expect(goal.items[0]).toMatchObject({ key: "main", subject: "main" });
  const other = setup("th-other");
  expect(await handleGet(other.ctx(), { taskId: mainId })).toMatchObject({ code: "BAD_TASK" });
});

test("search: finds this thread's tasks by words, best first; another thread's tasks stay out", async () => {
  const { ctx } = await leadGoal();
  await handleAdd(
    ctx(),
    addArgs("docs", { subject: "Update readme docs", brief: "rewrite the readme" }),
  );
  await handleAdd(ctx(), addArgs("audit", { subject: "Audit billing", brief: "check invoices" }));
  const r = (await handleSearch(ctx(), { query: "readme docs" })) as unknown as {
    matches: { subject: string }[];
  };
  expect(r.matches[0]?.subject).toBe("Update readme docs");
  expect(r.matches.some((m) => m.subject === "Audit billing")).toBe(false);
  const other = setup("th-other");
  await handleDispatch(
    other.ctx(),
    dispatch({ assignments: [asg("zulu", { subject: "readme docs secret" })] }),
  );
  const again = (await handleSearch(ctx(), { query: "secret" })) as unknown as {
    matches: unknown[];
  };
  expect(again.matches).toEqual([]);
});

test("duplicate check: dispatch and add refuse a similar open task with the matches; confirmNew passes", async () => {
  const { ctx, goalId } = await leadGoal({
    assignments: [
      asg("main", { subject: "Fix the login bug", brief: "Fix the login bug in the auth module" }),
    ],
  });
  const twin = addArgs("again", {
    subject: "Fix the login bug",
    brief: "Fix the login bug in the auth module",
  });
  const dup = await handleAdd(ctx(), twin);
  expect(dup).toMatchObject({
    ok: false,
    code: "DUPLICATE_SUSPECT",
    message: expect.stringContaining("Fix the login bug"),
  });
  expect(await handleAdd(ctx(), { ...twin, confirmNew: true })).toMatchObject({ ok: true });
  // A dispatch of the same work is a suspect too (the open goal blocks it first with GOAL_OPEN, so supersede it).
  const again = dispatch({
    supersedes: goalId,
    assignments: [
      asg("main", { subject: "Fix the login bug", brief: "Fix the login bug in the auth module" }),
    ],
  });
  // The goal being replaced is not a duplicate of its own replacement.
  expect(await handleDispatch(ctx(), again)).toMatchObject({ ok: true });
});

test("duplicate check: a dispatch beside a different open goal's similar task is a suspect", async () => {
  const s = setup();
  const same = { subject: "Migrate the database", brief: "Migrate the users database to postgres" };
  await handleDispatch(s.ctx(), dispatch({ assignments: [asg("m1", same)] }));
  // Not superseded here, so the policy answers GOAL_OPEN before the similarity check; end the goal first.
  for (const r of db
    .query<{ id: string }, [string]>(
      "SELECT id FROM owned_tasks WHERE thread_id = ? AND parent_id IS NOT NULL",
    )
    .all(TH)) {
    moveTaskTo(db, r.id, "running");
    moveTaskTo(db, r.id, "completed");
  }
  db.query(
    "UPDATE owned_tasks SET status = 'completed' WHERE thread_id = ? AND parent_id IS NULL",
  ).run(TH);
  expect(await handleDispatch(s.ctx(), dispatch({ assignments: [asg("m2", same)] }))).toMatchObject(
    {
      code: "DUPLICATE_SUSPECT",
    },
  );
  expect(
    await handleDispatch(s.ctx(), dispatch({ confirmNew: true, assignments: [asg("m2", same)] })),
  ).toMatchObject({
    ok: true,
  });
  // The window counts from completion: created long ago but completed just now is still compared.
  db.query("UPDATE owned_tasks SET created_at = 1 WHERE item_key = 'm1'").run();
  for (const r of db
    .query<{ id: string }, [string]>(
      "SELECT id FROM owned_tasks WHERE thread_id = ? AND parent_id IS NULL",
    )
    .all(TH))
    moveTaskTo(db, r.id, "cancelled");
  for (const r of db
    .query<{ id: string }, [string]>(
      "SELECT id FROM owned_tasks WHERE thread_id = ? AND parent_id IS NOT NULL",
    )
    .all(TH))
    db.query("UPDATE owned_tasks SET status = 'cancelled' WHERE id = ? AND item_key = 'm2'").run(
      r.id,
    );
  expect(await handleDispatch(s.ctx(), dispatch({ assignments: [asg("m3", same)] }))).toMatchObject(
    { code: "DUPLICATE_SUSPECT" },
  );
  // Completed longer ago than the window is not compared.
  db.query("UPDATE owned_tasks SET last_progress_at = 1 WHERE item_key = 'm1'").run();
  expect(await handleDispatch(s.ctx(), dispatch({ assignments: [asg("m3", same)] }))).toMatchObject(
    { ok: true },
  );
});

const plannerCtx = (goalId: string): PlannerCtx => ({
  db,
  threadId: TH,
  goalId,
  workers: dispatchableWorkers(),
  locations: [{ name: "repo", path: "/x" }],
  channelDigest: () => "",
});
const planArgs = (
  goalId: string,
  items: ReturnType<typeof item>[],
  over: Record<string, unknown> = {},
) => ({
  goalId,
  items,
  acceptanceCriteria: ["works"],
  envelope: { locations: ["repo"], riskClasses: ["R0", "R1"], bounds: { maxItems: 8, maxGb: 1 } },
  budgetUsd: 3,
  effects: [],
  ...over,
});

test("duplicate check: Plan create compares against OTHER goals only, never its own goal's earlier work", async () => {
  const s = setup();
  // Goal A (lead): similar open work. Goal B (planner): a plan that repeats it.
  await handleDispatch(
    s.ctx(),
    dispatch({
      assignments: [
        asg("m1", {
          subject: "Migrate the database",
          brief: "Migrate the users database to postgres",
        }),
      ],
    }),
  );
  const a = db
    .query<{ id: string }, []>("SELECT id FROM owned_tasks WHERE parent_id IS NULL")
    .get()!.id;
  moveTaskTo(db, a, "cancelled"); // the first goal is replaced by the plan's goal in the thread
  db.query("UPDATE owned_tasks SET status = 'ready' WHERE item_key = 'm1'").run(); // but its task is still open work
  const w = s.port.requestPlan({ key: "k-plan", objective: "migrate" });
  if (!w.ok) throw new Error("no goal");
  const dupItem = item("p1", {
    subject: "Migrate the database",
    brief: "Migrate the users database to postgres",
  });
  expect(createPlanHandler(plannerCtx(w.goalId), planArgs(w.goalId, [dupItem]))).toMatchObject({
    ok: false,
    code: "DUPLICATE_SUSPECT",
  });
  expect(
    createPlanHandler(plannerCtx(w.goalId), planArgs(w.goalId, [dupItem], { confirmNew: true })),
  ).toMatchObject({ ok: true });
});
