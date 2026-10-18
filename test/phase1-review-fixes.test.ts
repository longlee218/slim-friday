import { expect, test } from "bun:test";
import { LEAD_REPLAY_MAX_AGE_MS } from "../src/config/lead-caps";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { forgetBatch, rearm } from "../src/orchestrator/lead/lead-failure";
import { createLeadQueue, type LeadInput } from "../src/orchestrator/lead/lead-queue";
import { liveRunsOf } from "../src/orchestrator/run/live-runs";
import { claimZombieLocation } from "../src/orchestrator/run/zombie-claims";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { recoverInFlight } from "../src/orchestrator/worker/recover-in-flight";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { recordBotThread } from "../src/storage/thread-store";
import { moveTaskTo } from "../src/tasks/task-resolver";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { type Call, leadHarness, sleep, until, workersDone } from "./lead-harness";

/* Review fixes of Phase 1 groups A and C: F1 (dropped owner input is never replayed), F3 (/stop does not wake the lead),
   F4 (a writer location stays claimed), F5 (announce dedupe). */

const owner = (id: string, threadId = "th"): LeadInput => ({
  threadId,
  kind: "owner",
  messageIds: [id],
  text: id,
});
const announce = (threadId = "th"): LeadInput => ({ threadId, kind: "announce", messageIds: [] });
const ownerEvents = (db: any, t: string) =>
  listUndelivered(db, t).filter((e) => e.kind === "owner_message");

test("F1: a queue cap drop and a pool refusal discard the owner input; a shutdown does not", async () => {
  const discarded: string[] = [];
  let release = () => {};
  const q = createLeadQueue({
    run: () => new Promise<void>((r) => (release = r)),
    debounceMs: 1,
    cap: 1,
    onDiscarded: (i) => discarded.push(i.messageIds[0]!),
  });
  q.push(owner("run"));
  await sleep(20);
  q.push(owner("q1"));
  await sleep(10);
  q.push(owner("q2")); // cap 1: q1 is dropped
  await sleep(10);
  expect(discarded).toEqual(["q1"]);
  q.stopAll(); // shutdown: q2 stays undelivered for the boot replay
  release();
  expect(discarded).toEqual(["q1"]);

  const refused: string[] = [];
  const q2 = createLeadQueue({
    run: async () => {},
    debounceMs: 1,
    pool: { tryAcquire: () => null, acquire: async () => null, canWait: () => false },
    onDiscarded: (i) => refused.push(i.messageIds[0]!),
  });
  q2.push(owner("nope"));
  await until(() => refused.length === 1);
  expect(refused).toEqual(["nope"]);
});

test("F1: /stop closes the queued owner message, so the boot replay does not bring it back", async () => {
  const h = leadHarness(async (c) => {
    // The first lead run holds the thread until the owner's /stop aborts it.
    const signal = c.options.abortController.signal as AbortSignal;
    await new Promise<void>((res) => {
      if (signal.aborted) res();
      signal.addEventListener("abort", () => res());
    });
    return "";
  });
  await h.send("first");
  await until(() => h.ofKind("lead").length === 1);
  await h.send("second"); // queued behind the running run
  await sleep(60);
  expect(ownerEvents(h.env.db, "t1").length).toBe(2);
  await h.send("/stop");
  await sleep(100);
  expect(ownerEvents(h.env.db, "t1")).toEqual([]);
  const before = h.calls.length;
  recordBotThread(h.env.db, "t1", TEST_CHANNEL, "main", "x");
  h.handle.wake({ ...recoverInFlight(h.env.db), threads: ["t1"] });
  await sleep(150);
  expect(h.calls.length).toBe(before);
}, 15_000);

test("F1: boot replay skips (and closes) an owner message older than the age bound", async () => {
  const h = leadHarness(async () => "answered");
  recordBotThread(h.env.db, "t1", TEST_CHANNEL, "main", "x");
  appendEvent(h.env.db, {
    id: "owner:old",
    threadId: "t1",
    kind: "owner_message",
    payload: { text: "stale request" },
    createdAt: Date.now() - LEAD_REPLAY_MAX_AGE_MS - 1000,
  });
  h.handle.wake({ ...recoverInFlight(h.env.db), threads: ["t1"] });
  await sleep(200);
  expect(h.ofKind("lead").some((c) => c.prompt.includes("stale request"))).toBe(false);
  expect(ownerEvents(h.env.db, "t1")).toEqual([]);
}, 15_000);

test("F9: the stored owner text is redacted", async () => {
  const h = leadHarness(async () => "ok");
  await h.send("my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  const stored = JSON.stringify(
    h.env.db.query("SELECT payload FROM thread_events WHERE kind = 'owner_message'").all(),
  );
  expect(stored).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
});

test("F5: announces are deduped per thread and never evict an owner input", async () => {
  const dropped: LeadInput[] = [];
  const ran: string[] = [];
  let release = () => {};
  const q = createLeadQueue({
    run: (i) => {
      ran.push(`${i.kind}:${i.text ?? ""}`);
      return new Promise<void>((r) => (release = r));
    },
    debounceMs: 1,
    cap: 1,
    onDropped: (i) => dropped.push(i),
    onQueued: () => {},
  });
  q.push(owner("run"));
  await sleep(20);
  q.push(owner("o1"));
  await sleep(10);
  q.push(announce()); // waits behind the run
  q.push(announce()); // deduped: no second one, no drop, no re-arm
  q.push(announce());
  expect(dropped).toEqual([]);
  release();
  await sleep(20);
  release();
  await sleep(20);
  release();
  await sleep(20);
  expect(ran).toEqual(["owner:run", "owner:o1", "announce:"]); // one announce, the owner input kept
});

/** A worker script: reports COMPLETED, then holds the run until it is aborted. */
const reportThenWait = async (c: Call) => {
  await c.tool("ReportResult", { title: "T", status: "COMPLETED", summary: "pushed" });
  const signal = c.options.abortController.signal as AbortSignal;
  await new Promise<void>((res) => {
    if (signal.aborted) res();
    signal.addEventListener("abort", () => res());
  });
  return "done";
};
const dispatchOne = (c: Call) =>
  c.tool("DispatchAgent", {
    strategy: "DIRECT",
    intent: "work",
    reason: "test",
    assignments: [{ key: "a", role: "scout", brief: "do a", dependsOn: [] }],
  });

test("F3: after /stop a COMPLETED-before-stop result is recorded but does not wake the lead", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") return reportThenWait(c);
    if (c.prompt.includes("Owner message:")) {
      await dispatchOne(c);
      return "started";
    }
    return "announced";
  });
  await h.send("go");
  await until(() => liveRunsOf("t1").some((r) => r.kind === "worker"));
  await sleep(100); // the report is stored
  await h.send("/stop");
  await workersDone(h.env.db);
  await sleep(300); // announce window is 20 ms
  expect(listUndelivered(h.env.db, "t1").map((e) => e.kind)).toContain("result");
  expect(h.ofKind("lead").some((c) => c.prompt.includes("Task events"))).toBe(false);
}, 15_000);

test("E-L12 race: a lead cancel (no /stop) of a run that reported COMPLETED still wakes the lead", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") return reportThenWait(c);
    if (c.prompt.includes("Owner message:")) {
      await dispatchOne(c);
      return "started";
    }
    return "announced";
  });
  await h.send("go");
  await until(() => liveRunsOf("t1").some((r) => r.kind === "worker"));
  await sleep(100);
  const run = liveRunsOf("t1").find((r) => r.kind === "worker")!;
  moveTaskTo(h.env.db, run.taskId!, "cancelled"); // what the lead's CancelTask does
  run.ac.abort();
  await until(() => h.ofKind("lead").some((c) => c.prompt.includes("Task events")), 8000);
}, 15_000);

test("F4: a ready writer item waits while its location is claimed by a force-closed run", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.tool("ReportResult", { title: "T", status: "COMPLETED", summary: "ok" });
      return "done";
    }
    await c.tool("DispatchAgent", {
      strategy: "DIRECT",
      intent: "work",
      reason: "test",
      assignments: [{ key: "a", role: "developer", brief: "do a", dependsOn: [] }],
    });
    return "started";
  });
  const free = claimZombieLocation("*"); // a zombie that may touch any location
  await h.send("go");
  await sleep(500);
  expect(h.ofKind("worker")).toHaveLength(0);
  free(); // the old run returned: the retry timer starts the item
  await until(() => h.ofKind("worker").length === 1, 8000);
}, 15_000);

test("E-M10 wiring: an announce refused by a full lead pool is re-armed and runs once a slot frees", async () => {
  const env = makeEnv();
  let calls = 0;
  const leadPool = createRunLimiter(1, 0); // full, nobody may wait: the announce is refused
  const hold = leadPool.tryAcquire()!;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: (() => {
      calls++;
      return (async function* () {
        yield resultMsg();
      })();
    }) as never,
    leadPool,
    limiter: createRunLimiter(10),
    leadTiming: { debounceMs: 5, announceWindowMs: 20 },
    post: async () => {},
  });
  recordBotThread(env.db, "t1", TEST_CHANNEL, "main", "x");
  appendEvent(env.db, { id: "r1", threadId: "t1", kind: "result", payload: { excerpt: "x" } });
  handle.wake({ ...recoverInFlight(env.db), threads: ["t1"] });
  await sleep(200);
  expect(calls).toBe(0); // refused (and re-armed) while the pool is full
  hold();
  await until(() => calls >= 1, 6000);
}, 15_000);

test("F7: re-arms of a limit-stopped batch do not use up the retry of a failed run", () => {
  const ids = ["f7-a"];
  expect(rearm(ids)).toBe(true); // first limit stop: armed again
  forgetBatch(["other"]); // unrelated
  // the second limit stop is past the cap and deletes its own count only
  expect(rearm(ids)).toBe(false);
  expect(rearm(ids)).toBe(true); // a fresh batch life starts from zero
  forgetBatch(ids);
});
