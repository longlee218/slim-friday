import { expect, test } from "bun:test";
import {
  handleAskOwner,
  handleCancel,
  handleDispatch,
  handleForward,
  handleSteer,
  handleTaskStatus,
} from "../src/orchestrator/engine/lead-handlers";
import type { DispatchInput } from "../src/orchestrator/engine/lead-schemas";
import { FakePort, itemRow, leadCtx } from "./lead-fake-port";

const REQ: DispatchInput = {
  strategy: "DIRECT",
  intent: "clean node_modules",
  reason: "one job",
  assignments: [{ key: "main", role: "developer", brief: "clean it", dependsOn: [] }],
};

test("dispatch: opens the goal, adds items, one start event per item, counts the run", async () => {
  const port = new FakePort();
  const ctx = leadCtx(port);
  const r = await handleDispatch(ctx, REQ);
  expect(r).toEqual({ ok: true, goalId: "goal1", itemIds: ["goal1-main"] });
  expect(ctx.run.dispatched).toBe(1);
  expect(port.events.map((e) => [e.kind, e.itemId])).toEqual([["start", "goal1-main"]]);
  expect(port.events[0]?.payload).toMatchObject({ by: "lead", role: "developer" });
});

test("dispatch: a second DIFFERENT dispatch in the same run is refused ONE_PER_RUN, nothing opened", async () => {
  const port = new FakePort();
  const ctx = leadCtx(port);
  await handleDispatch(ctx, REQ);
  const r = await handleDispatch(ctx, { ...REQ, intent: "other" });
  expect(r).toMatchObject({ ok: false, code: "ONE_PER_RUN" });
  expect(port.goals).toHaveLength(1);
});

test("dispatch refusal: coded, writes a lead_decision event and no goal", async () => {
  const port = new FakePort();
  port.capsNow = { chainCount: 3, leadSpentTodayUsd: 0 };
  const r = await handleDispatch(leadCtx(port), REQ);
  expect(r).toMatchObject({ ok: false, code: "CHAIN_CAP" });
  expect(port.goals).toEqual([]);
  expect(port.events[0]).toMatchObject({ kind: "lead_decision", payload: { code: "CHAIN_CAP" } });
});

test("dispatch with 4 assignments answers NEEDS_PLAN; supersedes passes to openGoal", async () => {
  const port = new FakePort();
  const four = ["a", "b", "c", "d"].map((key) => ({
    key,
    role: "developer",
    brief: "b",
    dependsOn: [],
  }));
  expect(
    await handleDispatch(leadCtx(port), { ...REQ, strategy: "DELEGATE", assignments: four }),
  ).toMatchObject({
    code: "NEEDS_PLAN",
  });
  port.goalState = { openGoalId: "g0", items: [] };
  await handleDispatch(leadCtx(port, "lt2"), { ...REQ, supersedes: "g0" });
  expect(port.goals[0]?.supersedes).toBe("g0");
});

test("idempotent: the same call twice in one lead turn is one effect, the stored reply is replayed", async () => {
  const port = new FakePort();
  const ctx = leadCtx(port);
  const first = await handleDispatch(ctx, REQ);
  const again = await handleDispatch(ctx, REQ);
  expect(again).toEqual(first);
  expect(port.goals).toHaveLength(1);
  expect(port.events).toHaveLength(1);
  // another lead turn is a new call
  await handleDispatch(leadCtx(port, "lt2"), REQ);
  expect(port.goals).toHaveLength(2);
});

test("idempotent: steer, cancel, forward act once per key", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow({ resultPath: "/r.md", resultExcerpt: "x" }));
  const ctx = leadCtx(port);
  for (let i = 0; i < 2; i++) {
    await handleSteer(ctx, { taskId: "t1", text: "hi" });
    await handleCancel(ctx, { taskId: "t1", reason: "r" });
    await handleForward(ctx, { taskId: "t1", mode: "verbatim" });
  }
  expect([port.steered.length, port.cancelled.length, port.posts.length]).toEqual([1, 1, 1]);
});

test("task status: facts, or BAD_TASK for a task of another thread", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow());
  expect(await handleTaskStatus(leadCtx(port), {})).toMatchObject({ ok: true, goalId: "g1" });
  expect(await handleTaskStatus(leadCtx(port), { taskId: "zzz" })).toMatchObject({
    code: "BAD_TASK",
  });
});

test("steer: result passes through; unknown task refused; writes a steer event", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow());
  port.steerReply = "answered";
  expect(await handleSteer(leadCtx(port), { taskId: "t1", text: "go" })).toEqual({
    ok: true,
    result: "answered",
  });
  expect(port.events[0]).toMatchObject({ kind: "steer", itemId: "t1" });
  expect(await handleSteer(leadCtx(port), { taskId: "nope", text: "go" })).toMatchObject({
    code: "BAD_TASK",
  });
});

test("cancel: ended task refused, live task cancelled with a cancel event", async () => {
  const port = new FakePort();
  port.rows.set("done", itemRow({ id: "done", status: "completed" }));
  port.rows.set("t1", itemRow());
  expect(await handleCancel(leadCtx(port), { taskId: "done", reason: "r" })).toMatchObject({
    code: "ENDED",
  });
  expect(await handleCancel(leadCtx(port), { taskId: "t1", reason: "r" })).toEqual({
    ok: true,
    cancelled: ["t1"],
  });
  expect(port.events.at(-1)?.kind).toBe("cancel");
});

test("ask owner: answer returned, TIMEOUT coded, foreign task refused; question event written", async () => {
  const port = new FakePort();
  const q = { question: "ok?", options: ["yes", "no"] };
  expect(await handleAskOwner(leadCtx(port), q)).toEqual({ ok: true, answer: "yes" });
  expect(port.events[0]?.kind).toBe("question");
  port.answer = { timedOut: true };
  expect(await handleAskOwner(leadCtx(port, "lt2"), q)).toMatchObject({ code: "TIMEOUT" });
  expect(await handleAskOwner(leadCtx(port, "lt3"), { ...q, taskId: "nope" })).toMatchObject({
    code: "BAD_TASK",
  });
});

test("forward: verbatim posts the file, summary the excerpt, no result is refused", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow({ resultPath: "/r.md", resultExcerpt: "short" }));
  port.rows.set("t2", itemRow({ id: "t2" }));
  await handleForward(leadCtx(port), { taskId: "t1", mode: "verbatim" });
  await handleForward(leadCtx(port), { taskId: "t1", mode: "summary" });
  expect(port.posts).toEqual([{ filePath: "/r.md" }, { text: "short" }]);
  expect(await handleForward(leadCtx(port), { taskId: "t2", mode: "summary" })).toMatchObject({
    code: "NO_RESULT",
  });
});
