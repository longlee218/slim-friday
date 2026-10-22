import { expect, test } from "bun:test";
import { ANNOUNCE_MAX_EVENTS } from "../src/config/lead-caps";
import { announceBlock, capNews, settleLeadEvents } from "../src/orchestrator/lead/lead-events";
import { createLeadQueue, type LeadInput } from "../src/orchestrator/lead/lead-queue";
import { recoverInFlight } from "../src/orchestrator/worker/recover-in-flight";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { recordBotThread } from "../src/storage/thread-store";
import { makeEnv, TEST_CHANNEL } from "./helpers";
import { leadHarness, until, workersDone } from "./lead-harness";

/* Group A of the wake-up audit: delivery by id (E-H3), dispatch after any outcome (E-H2), capped announce (E-M9), re-armed drops (E-M10). */

const ev = (db: any, id: string, kind: string, payload: object = {}, taskId?: string) =>
  appendEvent(db, { id, threadId: "t", kind: kind as never, payload, ...(taskId && { taskId }) });

test("E-H3: settle closes only the owner events it was given, never every undelivered one", () => {
  const { db } = makeEnv();
  ev(db, "owner:a", "owner_message");
  ev(db, "owner:b", "owner_message");
  settleLeadEvents(db, "t", [], ["owner:a"]);
  expect(listUndelivered(db, "t").map((e) => e.id)).toEqual(["owner:b"]);
});

test("E-H3: boot replays an undelivered owner message as an owner input", async () => {
  const h = leadHarness(async (c) => (c.kind === "lead" ? "answered" : ""));
  recordBotThread(h.env.db, "t1", TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  appendEvent(h.env.db, {
    id: "owner:m1",
    threadId: "t1",
    kind: "owner_message",
    payload: { text: "please do the thing" },
  });
  h.handle.wake(recoverInFlight(h.env.db));
  await until(() => h.posts.includes("answered"), 8000);
  expect(h.ofKind("lead").some((c) => c.prompt.includes("please do the thing"))).toBe(true);
  expect(listUndelivered(h.env.db, "t1")).toEqual([]);
}, 15_000);

test("E-H2: a lead run that dispatched and then hit the budget still starts the worker", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
      return "done";
    }
    if (c.prompt.includes("<owner_message>")) {
      await c.orchestrate("dispatch", {
        strategy: "DIRECT",
        small: true,
        intent: "work",
        reason: "one specialist",
        assignments: [
          { key: "main", subject: "task", role: "developer", brief: "do it", dependsOn: [] },
        ],
      });
      return { text: "half way", cost: 1, maxBudget: true };
    }
    return "noted";
  });
  await h.send("go");
  await workersDone(h.env.db);
  expect(h.ofKind("worker")).toHaveLength(1);
}, 15_000);

test("E-H2: news left unread by a limit-stopped announce run is announced again", async () => {
  let announces = 0;
  const h = leadHarness(async (c) => {
    if (c.prompt.includes("<events>")) {
      announces++;
      return announces === 1 ? { text: "half way", cost: 1, maxBudget: true } : "caught up";
    }
    return "";
  });
  recordBotThread(h.env.db, "t1", TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  appendEvent(h.env.db, { id: "r1", threadId: "t1", kind: "result", payload: { excerpt: "x" } });
  h.handle.wake(recoverInFlight(h.env.db));
  await until(() => h.posts.includes("caught up"), 8000);
  expect(listUndelivered(h.env.db, "t1")).toEqual([]);
}, 15_000);

test("E-M9: the batch is capped, the overflow is counted, one budget_hit per goal", () => {
  const { db } = makeEnv();
  for (let i = 0; i < ANNOUNCE_MAX_EVENTS + 5; i++) ev(db, `r${i}`, "result");
  const news = listUndelivered(db, "t");
  const batch = capNews(news);
  expect(batch.shown).toHaveLength(ANNOUNCE_MAX_EVENTS);
  expect(batch.more).toBe(5);
  expect(announceBlock(batch.shown, batch.more)).toContain("+5 more");
  const { db: db2 } = makeEnv();
  for (const id of ["b1", "b2", "b3"]) ev(db2, id, "budget_hit", {}, "goal1");
  ev(db2, "b4", "budget_hit", {}, "goal2");
  const b = capNews(listUndelivered(db2, "t"));
  expect(b.shown.map((e) => e.id)).toEqual(["b1", "b4"]);
  expect(b.coalesced).toEqual(["b2", "b3"]);
});

test("E-M9: overflow news is announced in a follow-up run until all is delivered", async () => {
  const h = leadHarness(async (c) => (c.prompt.includes("<events>") ? "ok" : ""));
  recordBotThread(h.env.db, "t1", TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  for (let i = 0; i < ANNOUNCE_MAX_EVENTS + 3; i++)
    appendEvent(h.env.db, { id: `r${i}`, threadId: "t1", kind: "result", payload: {} });
  h.handle.wake(recoverInFlight(h.env.db));
  await until(() => listUndelivered(h.env.db, "t1").length === 0, 8000);
  expect(h.ofKind("lead")).toHaveLength(2);
}, 15_000);

test("E-M10: an announce refused by the pool is reported so it can be re-armed (cap and dedupe: phase1-review-fixes)", async () => {
  const a = (text: string): LeadInput => ({
    threadId: "th",
    kind: "announce",
    messageIds: [],
    text,
  });
  const full: LeadInput[] = [];
  const q2 = createLeadQueue({
    run: async () => {},
    pool: { tryAcquire: () => null, acquire: async () => null, canWait: () => false },
    onDropped: (i) => full.push(i),
  });
  q2.push(a("no slot"));
  await until(() => full.length === 1);
});
