import { expect, test } from "bun:test";
import { CHAIN_CAP, DELEGATE_MAX } from "../src/config/teammate-caps";
import {
  handleAskOwner,
  handleCancel,
  handleDispatch,
  handleForward,
  handleSteer,
} from "../src/orchestrator/teammate/teammate-handlers";
import type { DispatchInput } from "../src/orchestrator/teammate/teammate-schemas";
import { FakePort, itemRow, teammateCtx } from "./teammate-fake-port";

const REQ: DispatchInput = {
  strategy: "DIRECT",
  small: true,
  intent: "clean node_modules",
  reason: "one job",
  assignments: [
    { key: "main", subject: "task", role: "developer", brief: "clean it", dependsOn: [] },
  ],
};

test("dispatch: opens the goal, adds items, one start event per item, counts the run", async () => {
  const port = new FakePort();
  const ctx = teammateCtx(port);
  const r = await handleDispatch(ctx, REQ);
  expect(r).toEqual({ ok: true, goalId: "goal1", itemIds: ["goal1-main"] });
  expect(ctx.run.dispatched).toBe(1);
  expect(port.events.map((e) => [e.kind, e.itemId])).toEqual([["start", "goal1-main"]]);
  expect(port.events[0]?.payload).toMatchObject({ by: "teammate", role: "developer" });
});

test("dispatch: a second DIFFERENT dispatch in the same run is refused ONE_PER_RUN, nothing opened", async () => {
  const port = new FakePort();
  const ctx = teammateCtx(port);
  await handleDispatch(ctx, REQ);
  const r = await handleDispatch(ctx, { ...REQ, intent: "other" });
  expect(r).toMatchObject({ ok: false, code: "ONE_PER_RUN" });
  expect(port.goals).toHaveLength(1);
});

test("dispatch refusal: coded, writes a teammate_decision event and no goal", async () => {
  const port = new FakePort();
  port.capsNow = { chainCount: CHAIN_CAP };
  const r = await handleDispatch(teammateCtx(port), REQ);
  expect(r).toMatchObject({ ok: false, code: "CHAIN_CAP" });
  expect(port.goals).toEqual([]);
  expect(port.events[0]).toMatchObject({
    kind: "teammate_decision",
    payload: { code: "CHAIN_CAP" },
  });
});

test("dispatch over DELEGATE_MAX assignments answers NEEDS_PLAN; supersedes passes to openGoal", async () => {
  const port = new FakePort();
  const many = Array.from({ length: DELEGATE_MAX + 1 }, (_, i) => ({
    key: `k${i}`,
    subject: `Task ${i}`,
    role: "developer",
    brief: "b",
    dependsOn: [],
  }));
  expect(
    await handleDispatch(teammateCtx(port), {
      ...REQ,
      strategy: "DELEGATE",
      small: true,
      assignments: many,
    }),
  ).toMatchObject({
    code: "NEEDS_PLAN",
  });
  port.goalState = { openGoalId: "g0", items: [] };
  await handleDispatch(teammateCtx(port, "lt2"), { ...REQ, supersedes: "g0" });
  expect(port.goals[0]?.supersedes).toBe("g0");
});

test("idempotent: the same call twice in one teammate turn is one effect, the stored reply is replayed", async () => {
  const port = new FakePort();
  const ctx = teammateCtx(port);
  const first = await handleDispatch(ctx, REQ);
  const again = await handleDispatch(ctx, REQ);
  expect(again).toEqual(first);
  expect(port.goals).toHaveLength(1);
  expect(port.events).toHaveLength(1);
  // another teammate turn is a new call
  await handleDispatch(teammateCtx(port, "lt2"), REQ);
  expect(port.goals).toHaveLength(2);
});

test("idempotent: steer, cancel, forward act once per key", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow({ resultExcerpt: "x" }));
  port.results.set("t1", { ref: "M1", text: "# R\n\nbody" });
  port.forwards.set("t1", { posts: [{ filePath: "/r.md" }], notes: [] });
  const ctx = teammateCtx(port);
  for (let i = 0; i < 2; i++) {
    await handleSteer(ctx, { taskId: "t1", text: "hi" });
    await handleCancel(ctx, { taskId: "t1", reason: "r" });
    await handleForward(ctx, { taskId: "t1", mode: "verbatim" });
  }
  expect([port.steered.length, port.cancelled.length, port.posts.length]).toEqual([1, 1, 1]);
});

test("steer: result passes through; unknown task refused; writes a steer event", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow());
  port.steerReply = "answered";
  expect(await handleSteer(teammateCtx(port), { taskId: "t1", text: "go" })).toEqual({
    ok: true,
    result: "answered",
  });
  expect(port.events[0]).toMatchObject({ kind: "steer", itemId: "t1" });
  expect(await handleSteer(teammateCtx(port), { taskId: "nope", text: "go" })).toMatchObject({
    code: "BAD_TASK",
  });
});

test("cancel: ended task refused, live task cancelled with a cancel event", async () => {
  const port = new FakePort();
  port.rows.set("done", itemRow({ id: "done", status: "completed" }));
  port.rows.set("t1", itemRow());
  expect(await handleCancel(teammateCtx(port), { taskId: "done", reason: "r" })).toMatchObject({
    code: "ENDED",
  });
  expect(await handleCancel(teammateCtx(port), { taskId: "t1", reason: "r" })).toEqual({
    ok: true,
    cancelled: ["t1"],
  });
  expect(port.events.at(-1)?.kind).toBe("cancel");
});

test("ask owner: answer returned, TIMEOUT coded, foreign task refused; question event written", async () => {
  const port = new FakePort();
  const q = { question: "ok?", kind: "select" as const, options: ["yes", "no"] };
  expect(await handleAskOwner(teammateCtx(port), q)).toEqual({ ok: true, answer: "yes" });
  expect(port.events[0]?.kind).toBe("question");
  port.answer = { timedOut: true };
  expect(await handleAskOwner(teammateCtx(port, "lt2"), q)).toMatchObject({ code: "TIMEOUT" });
  expect(await handleAskOwner(teammateCtx(port, "lt3"), { ...q, taskId: "nope" })).toMatchObject({
    code: "BAD_TASK",
  });
});

test("ask owner: kind maps to port options; options that do not fit the kind are BAD_OPTIONS", async () => {
  const port = new FakePort();
  const asked: unknown[] = [];
  port.askOwner = async (q) => {
    asked.push(q);
    return { answer: "x", timedOut: false };
  };
  let n = 0;
  const call = (input: Parameters<typeof handleAskOwner>[1]) =>
    handleAskOwner(teammateCtx(port, `lt-k${n++}`), input);
  await call({ question: "q", kind: "yesno" });
  await call({ question: "q", kind: "text" });
  await call({ question: "q", kind: "select", options: ["a", "b", "c", "d", "e", "f"] });
  expect(asked).toMatchObject([
    { options: ["Yes", "No"], yesno: true },
    { options: [], yesno: false },
    { options: ["a", "b", "c", "d", "e", "f"] },
  ]);
  const bad = (i: Parameters<typeof handleAskOwner>[1]) => call(i);
  expect(await bad({ question: "q", kind: "yesno", options: ["a"] })).toMatchObject({
    code: "BAD_OPTIONS",
  });
  expect(await bad({ question: "q", kind: "text", options: ["a", "b"] })).toMatchObject({
    code: "BAD_OPTIONS",
  });
  expect(await bad({ question: "q", kind: "select" })).toMatchObject({ code: "BAD_OPTIONS" });
  expect(await bad({ question: "q", kind: "select", options: ["a"] })).toMatchObject({
    code: "BAD_OPTIONS",
  });
  expect(asked.length).toBe(3);
});

test("forward: verbatim posts the file, summary the excerpt, no result is refused", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow({ resultExcerpt: "short" }));
  port.results.set("t1", { ref: "M1", text: "# R\n\nbody" });
  port.forwards.set("t1", { posts: [{ filePath: "/r.md" }], notes: [] });
  port.rows.set("t2", itemRow({ id: "t2" }));
  await handleForward(teammateCtx(port), { taskId: "t1", mode: "verbatim" });
  await handleForward(teammateCtx(port), { taskId: "t1", mode: "summary" });
  expect(port.posts).toEqual([{ filePath: "/r.md" }, { text: "short" }]);
  expect(await handleForward(teammateCtx(port), { taskId: "t2", mode: "summary" })).toMatchObject({
    code: "NO_RESULT",
  });
});

test("forward verbatim: posts what the port made, passes its notes on; no result message is refused", async () => {
  const port = new FakePort();
  port.rows.set("t1", itemRow({ resultExcerpt: "short" }));
  port.results.set("t1", { ref: "M7", text: "# T\n\nfull report" });
  port.forwards.set("t1", {
    posts: [{ filePath: "/full.md", artifactId: "a1" }, { filePath: "/second.md" }],
    notes: ['FILE_GONE: "Old" (x.md) no longer exists in repo; skipped.'],
  });
  port.rows.set("t2", itemRow({ id: "t2" }));
  const r = await handleForward(teammateCtx(port), { taskId: "t1", mode: "verbatim" });
  expect(port.posts).toEqual([
    { filePath: "/full.md", artifactId: "a1" },
    { filePath: "/second.md" },
  ]);
  expect(r).toMatchObject({ ok: true, files: 2, notes: [expect.stringContaining("FILE_GONE")] });
  expect(await handleForward(teammateCtx(port), { taskId: "t2", mode: "verbatim" })).toMatchObject({
    code: "NO_RESULT",
  });
});

test("ask owner: a plan waiting for approve_plan refuses PLAN_PENDING; a relayed worker question still goes", async () => {
  const port = new FakePort();
  port.pending = { planId: "p1", version: 2 };
  const q = { question: "Duyệt plan này chứ?", kind: "yesno" as const };
  const r = await handleAskOwner(teammateCtx(port), q);
  expect(r).toMatchObject({ ok: false, code: "PLAN_PENDING" });
  expect(JSON.stringify(r)).toContain("approve_plan");
  expect(port.asked).toHaveLength(0);
  expect(
    await handleAskOwner(teammateCtx(port, "lt-w"), { ...q, workerAskId: "w1" }),
  ).toMatchObject({
    ok: true,
  });
  port.pending = undefined;
  expect(await handleAskOwner(teammateCtx(port, "lt-n"), q)).toMatchObject({ ok: true });
  expect(port.asked).toHaveLength(2);
});
