import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type WakeRow } from "../src";
import { flush, makeHub, tick } from "./bot-hub-harness";
import type { FakeSession } from "./fakes/fake-runtime";

/** The only stored run (the tests start one run). */
const only = (h: ReturnType<typeof makeHub>): WakeRow => {
  const [w] = [...h.store.wakeMap.values()];
  if (!w) throw new Error("no run stored");
  return w;
};

/** Statuses of every stored attempt. */
const attempts = (h: ReturnType<typeof makeHub>) =>
  [...h.store.attemptMap.values()].map((a) => a.status);

/** Start a run in editor's direct chat whose turn starts a task that finishes before the turn ends. */
async function taskDoneInTurn(h: ReturnType<typeof makeHub>): Promise<FakeSession> {
  h.surface.deliver({ conversationId: "dc", text: "dig" });
  await flush();
  const s = h.runtime.last();
  s.emit({ type: "task_started", taskId: "t1", description: "research" });
  s.emit({ type: "task_done", taskId: "t1", status: "completed", summary: "found" });
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  return s;
}

test("a task done during the turn: the run waits for its follow-up turn and then ends with it", async () => {
  const h = makeHub();
  const s = await taskDoneInTurn(h);
  expect(only(h).status).toBe("running");
  expect(s.stopped).toBe(false);
  s.emit({ type: "text", text: "the findings" });
  await flush();
  // The follow-up started: it is awaited normally, past the grace.
  await tick(h.clock, CORE_DEFAULTS.followUpGraceMs + 1);
  expect(only(h).status).toBe("running");
  s.emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(only(h)).toMatchObject({ status: "done", resultText: "the findings" });
  expect(attempts(h)).toEqual(["done"]);
});

test("a task done during the turn with no follow-up: the run ends done after the grace", async () => {
  const h = makeHub();
  const s = await taskDoneInTurn(h);
  await tick(h.clock, CORE_DEFAULTS.followUpGraceMs - 1);
  expect(only(h).status).toBe("running");
  await tick(h.clock, 1);
  expect(s.stopped).toBe(true);
  expect(only(h)).toMatchObject({ status: "done", transientRetries: 0 });
  expect(attempts(h)).toEqual(["done"]);
});

test("a lease lost after the pump returned done writes no finish", async () => {
  const h = makeHub();
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  const s = h.runtime.last();
  const stop = s.stop.bind(s);
  let lost = false;
  // The lease is lost while the executor closes the session, before it settles.
  s.stop = async () => {
    if (!lost) {
      lost = true;
      only(h).leaseFence = 9;
      await tick(h.clock, CORE_DEFAULTS.fenceCheckMs);
    }
    return stop();
  };
  s.emit({ type: "turn_end", costUsd: 0 });
  // The close waits for the fence check, then the run settles.
  await flush();
  await flush();
  expect(lost).toBe(true);
  expect(only(h)).toMatchObject({ status: "running", leaseFence: 9 });
  expect(attempts(h)).toEqual(["interrupted"]);
});

test("a session open that hangs is cut by the watchdog as transient; a late session is stopped", async () => {
  const h = makeHub();
  let release = () => {};
  const open = h.runtime.open.bind(h.runtime);
  h.runtime.open = (spec) =>
    new Promise<void>((r) => {
      release = r;
    }).then(() => open(spec));
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  await tick(h.clock, CORE_DEFAULTS.streamIdleMs);
  expect(only(h)).toMatchObject({ status: "queued", transientRetries: 1 });
  release();
  await flush();
  expect(h.runtime.nth(0).stopped).toBe(true);
  expect(h.runtime.nth(0).sent).toEqual([]);
});

test("a turn build that hangs is cut by the watchdog as transient", async () => {
  const h = makeHub();
  h.store.tickets.getByNumber = () => new Promise(() => {});
  h.surface.deliver({ conversationId: "dc", text: "see FRI-1" });
  await flush();
  const s = h.runtime.last();
  expect(s.sent).toEqual([]);
  await tick(h.clock, CORE_DEFAULTS.streamIdleMs);
  expect(s.stopped).toBe(true);
  expect(only(h)).toMatchObject({ status: "queued", transientRetries: 1 });
});

test("a resetPending fresh session starts at the bot's effort and clears the stored one", async () => {
  const h = makeHub();
  await h.store.scopes.setEffort("editor", "max");
  await h.store.scopes.markReset("editor");
  h.surface.deliver({ conversationId: "dc", text: "hi" });
  await flush();
  expect(h.runtime.nth(0).spec.bot.effort).toBe(h.editor.effort);
  expect((await h.store.scopes.get("editor"))?.effort).toBeUndefined();
});
