import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createDbEffectPort, type PortIo } from "../src/orchestrator/engine/effect-port-db";
import {
  handleAskOwner,
  handleCancel,
  handleDispatch,
  handleForward,
  handleTaskStatus,
} from "../src/orchestrator/engine/lead-handlers";
import type { DispatchInput } from "../src/orchestrator/engine/lead-schemas";
import { appendEvent, listUndelivered } from "../src/orchestrator/events/event-store";
import { openDb } from "../src/storage/db";
import { getOwnedTask } from "../src/storage/owned-task-store";
import { insertRun } from "../src/storage/run-metrics-store";
import { insertTurn } from "../src/storage/run-store";
import { moveTaskTo } from "../src/tasks/task-resolver";

const TH = "th1";
const ENV = { workerRoles: ["developer", "scout"], locations: ["repo"] };
let db: Database;
afterEach(() => db?.close());

/** A port over a fresh in-memory db; the IO records what it was asked. */
function setup(io: Partial<PortIo> = {}) {
  db = openDb(":memory:");
  const posts: unknown[] = [];
  const port = createDbEffectPort({
    db,
    threadId: TH,
    env: ENV,
    io: {
      steerTask: () => "queued",
      askOwner: async () => ({ answer: "a", timedOut: false }),
      post: async (p) => void posts.push(p),
      ...io,
    },
  });
  const ctx = (turn = "lt1") => ({
    port,
    threadId: TH,
    leadTurnId: turn,
    run: { dispatched: 0 },
    inputId: turn,
  });
  return { port, ctx, posts };
}
const req = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  strategy: "DELEGATE",
  intent: "two steps",
  reason: "r",
  assignments: [
    { key: "a", role: "developer", brief: "first", dependsOn: [] },
    { key: "b", role: "scout", brief: "second", dependsOn: ["a"] },
  ],
  ...over,
});

test("dispatch writes the goal, items (ready / pending), start events, and a replay adds nothing", async () => {
  const { port, ctx } = setup();
  const c = ctx();
  const r = await handleDispatch(c, req());
  expect(r.ok).toBe(true);
  const st = port.state();
  expect(st.items.map((i) => [i.itemKey, i.status, i.dependsOn])).toEqual([
    ["a", "ready", []],
    ["b", "pending", ["a"]],
  ]);
  expect(listUndelivered(db, TH).filter((e) => e.kind === "start")).toHaveLength(2);
  await handleDispatch(c, req()); // same key: replayed
  expect(port.state().items).toHaveLength(2);
  expect(port.recall("nope")).toBeUndefined();
});

test("one open goal: a second dispatch is refused GOAL_OPEN; supersedes cancels the old goal and its items", async () => {
  const { port, ctx } = setup();
  const first = await handleDispatch(ctx("l1"), req());
  const goalId = (first as unknown as { goalId: string }).goalId;
  expect(await handleDispatch(ctx("l2"), req({ intent: "x" }))).toMatchObject({
    code: "GOAL_OPEN",
  });
  const next = await handleDispatch(
    ctx("l3"),
    req({
      intent: "y",
      supersedes: goalId,
      strategy: "DIRECT",
      assignments: [{ key: "m", role: "developer", brief: "b", dependsOn: [] }],
    }),
  );
  expect(next.ok).toBe(true);
  expect(getOwnedTask(db, goalId)?.status).toBe("cancelled");
  expect(port.state().openGoalId).not.toBe(goalId);
});

test("a goal whose items all ended is no longer open", async () => {
  const { port, ctx } = setup();
  await handleDispatch(
    ctx(),
    req({
      strategy: "DIRECT",
      assignments: [{ key: "m", role: "developer", brief: "b", dependsOn: [] }],
    }),
  );
  const id = port.state().items[0]?.id as string;
  moveTaskTo(db, id, "running");
  moveTaskTo(db, id, "completed");
  expect(port.state().openGoalId).toBeUndefined();
});

test("chain cap counts start events after the last owner message", async () => {
  const { port } = setup();
  const ev = (id: string, kind: "start" | "owner_message") =>
    appendEvent(db, { id, threadId: TH, kind, payload: {} });
  ev("s0", "start");
  ev("o1", "owner_message");
  ev("s1", "start");
  ev("s2", "start");
  expect(port.caps().chainCount).toBe(2);
  ev("o2", "owner_message");
  expect(port.caps().chainCount).toBe(0);
});

test("lead budget sums today's lead runs only", () => {
  const { port } = setup();
  const run = (id: string, role: string, cost: number) => {
    insertTurn(db, { id, threadId: TH, source: "s", location: "repo", role });
    insertRun(db, {
      id: `r-${id}`,
      turnId: id,
      model: "m",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: cost,
      turns: 1,
      durationMs: 1,
      outcome: "success",
      compactions: 0,
    });
  };
  run("t1", "lead", 1.25);
  run("t2", "lead", 0.5);
  run("t3", "developer", 9);
  expect(port.caps().leadSpentTodayUsd).toBeCloseTo(1.75);
  const tomorrow = createDbEffectPort({
    db,
    threadId: TH,
    env: ENV,
    io: {} as PortIo,
    now: () => Date.now() + 2 * 86_400_000,
  });
  expect(tomorrow.caps().leadSpentTodayUsd).toBe(0);
});

test("cancel an item cancels its dependents; an item of another thread is invisible", async () => {
  const { port, ctx } = setup();
  await handleDispatch(ctx(), req());
  const [a, b] = port.state().items.map((i) => i.id) as [string, string];
  const r = await handleCancel(ctx(), { taskId: a, reason: "stop" });
  expect(r).toMatchObject({ ok: true });
  expect([getOwnedTask(db, a)?.status, getOwnedTask(db, b)?.status]).toEqual([
    "cancelled",
    "cancelled",
  ]);
  const other = createDbEffectPort({ db, threadId: "other", env: ENV, io: {} as PortIo });
  expect(other.item(a)).toBeUndefined();
  expect(other.snapshot(a)).toBeUndefined();
});

test("snapshot shows the pending worker question until it is answered; steer answers it", async () => {
  let answered = "";
  const { port, ctx } = setup({
    answerPending: (_t, text) => {
      answered = text;
      return true;
    },
  });
  await handleDispatch(ctx(), req());
  const a = port.state().items[0]?.id as string;
  appendEvent(db, {
    id: "q1",
    threadId: TH,
    kind: "question",
    itemId: a,
    taskId: "g",
    payload: { question: "which dir?" },
  });
  expect(port.snapshot()?.items[0]?.pendingQuestion).toBe("which dir?");
  expect(port.steer(a, "src")).toBe("answered");
  expect(answered).toBe("src");
  appendEvent(db, { id: "a1", threadId: TH, kind: "answer", itemId: a, taskId: "g", payload: {} });
  expect(port.snapshot()?.items[0]?.pendingQuestion).toBeUndefined();
});

test("steer without a pending question maps the registry result; none = ended", async () => {
  const { port, ctx } = setup({ steerTask: () => "none" });
  await handleDispatch(ctx(), req());
  expect(port.steer(port.state().items[0]?.id as string, "x")).toBe("ended");
});

test("escalation is granted once and readable by the runner", () => {
  const { port } = setup();
  expect(port.requestEscalation("opus", "hard")).toBe(true);
  expect(port.requestEscalation("high", "again")).toBe(false);
  expect(port.escalation()).toEqual({ to: "opus", reason: "hard" });
});

/** Two items with the same key: the second insert hits the unique (goal, item key) index and throws. */
const DUP_ITEMS = [
  { key: "a", role: "developer", brief: "x", dependsOn: [], status: "ready" as const },
  { key: "a", role: "developer", brief: "y", dependsOn: [], status: "ready" as const },
];

const WRITE = { key: "k1", strategy: "DELEGATE", intent: "two same-key items", reason: "r" };
const count = (sql: string): number => db.query<{ n: number }, []>(sql).get()?.n ?? -1;

test("dispatch is one transaction: a failing items insert leaves no goal, item, event or audit row", () => {
  const { port } = setup();
  expect(() => port.dispatch({ ...WRITE, items: DUP_ITEMS })).toThrow();
  expect(port.state().openGoalId).toBeUndefined();
  expect([
    count("SELECT COUNT(*) AS n FROM owned_tasks"),
    count("SELECT COUNT(*) AS n FROM thread_events"),
    count("SELECT COUNT(*) AS n FROM effect_log"),
  ]).toEqual([0, 0, 0]);
});

test("a failing dispatch that superseded a goal rolls the cancel back too", async () => {
  const { port, ctx } = setup();
  const first = (await handleDispatch(ctx("l1"), req())) as unknown as { goalId: string };
  expect(() =>
    port.dispatch({ ...WRITE, key: "k2", supersedes: first.goalId, items: DUP_ITEMS }),
  ).toThrow();
  expect(getOwnedTask(db, first.goalId)?.status).toBe("open");
  expect(port.state().items.map((i) => i.status)).toEqual(["ready", "pending"]);
});

test("supersedes must be this thread's own open goal: a foreign goal is refused and left untouched", async () => {
  const a = setup();
  const foreign = (await handleDispatch(a.ctx("l1"), req())) as unknown as { goalId: string };
  const other = createDbEffectPort({ db, threadId: "other", env: ENV, io: {} as PortIo });
  const r = other.dispatch({
    ...WRITE,
    key: "k9",
    supersedes: foreign.goalId,
    items: [DUP_ITEMS[0]!],
  });
  expect(r).toMatchObject({ ok: false, code: "BAD_TASK" });
  expect(getOwnedTask(db, foreign.goalId)?.status).toBe("open");
  expect(a.port.state().items.map((i) => i.status)).toEqual(["ready", "pending"]);
  expect(other.state().items).toEqual([]);
  // through the handler the policy refuses first, with the same code
  const ctxOther = {
    port: other,
    threadId: "other",
    leadTurnId: "x",
    inputId: "x",
    run: { dispatched: 0 },
  };
  expect(await handleDispatch(ctxOther, req({ supersedes: foreign.goalId }))).toMatchObject({
    code: "BAD_TASK",
  });
  expect(count("SELECT COUNT(*) AS n FROM owned_tasks WHERE thread_id = 'other'")).toBe(0);
});

test("the status tool is a read: fresh after a cancel, and it leaves no audit row or event", async () => {
  const { port, ctx } = setup();
  const c = ctx("l1");
  await handleDispatch(c, req());
  const before = count("SELECT COUNT(*) AS n FROM effect_log");
  const events = count("SELECT COUNT(*) AS n FROM thread_events");
  const s1 = await handleTaskStatus(c, {});
  await handleCancel(c, { taskId: port.state().items[0]?.id as string, reason: "x" });
  const s2 = await handleTaskStatus(c, {});
  expect(s1.ok && s1.items).not.toEqual(s2.ok && s2.items);
  expect(s2.ok && (s2.items as { status: string }[]).map((i) => i.status)).toEqual([
    "cancelled",
    "cancelled",
  ]);
  // only the cancel wrote a row (effect + event); the two reads wrote nothing
  expect(count("SELECT COUNT(*) AS n FROM effect_log") - before).toBe(1);
  expect(count("SELECT COUNT(*) AS n FROM thread_events") - events).toBe(1);
});

test("an escalation re-run of the same input does not post or ask twice; a refused dispatch is not replayed", async () => {
  const posts: unknown[] = [];
  let asks = 0;
  const { port, ctx } = setup({
    post: async (p) => void posts.push(p),
    askOwner: async () => (asks++, { answer: "y", timedOut: false }),
  });
  const run1 = ctx("in1");
  await handleDispatch(
    run1,
    req({
      strategy: "DIRECT",
      assignments: [{ key: "m", role: "developer", brief: "b", dependsOn: [] }],
    }),
  );
  const id = port.state().items[0]?.id as string;
  db.query("UPDATE owned_tasks SET result_path = '/r.md', result_excerpt = 'x' WHERE id = ?").run(
    id,
  );
  const rerun = { ...run1, leadTurnId: "lt-rerun", run: { dispatched: 0 } }; // same inputId
  for (const c of [run1, rerun]) {
    await handleForward(c, { taskId: id, mode: "verbatim" });
    await handleAskOwner(c, { question: "q?", options: ["y", "n"] });
  }
  expect([posts.length, asks]).toEqual([1, 1]);
  // a dispatch refused by an open goal succeeds after the blocker is cleared (not replayed from a stored refusal)
  const again = req({
    strategy: "DIRECT",
    assignments: [{ key: "n", role: "developer", brief: "b", dependsOn: [] }],
  });
  const c2 = ctx("in2");
  expect(await handleDispatch(c2, again)).toMatchObject({ code: "GOAL_OPEN" });
  moveTaskTo(db, id, "running");
  moveTaskTo(db, id, "completed");
  expect(await handleDispatch({ ...c2, run: { dispatched: 0 } }, again)).toMatchObject({
    ok: true,
  });
});
