import { expect, test } from "bun:test";
import { recoverInFlight } from "../src/orchestrator/engine/recover-in-flight";
import { appendEvent, listUndelivered } from "../src/orchestrator/events/event-store";
import { recordBotThread } from "../src/storage/thread-store";
import { TEST_CHANNEL } from "./helpers";
import { leadHarness, until, workersDone } from "./lead-harness";

/* Lead tests of the boot path and of the worker's silence: real handler, queue and lead runner over a fake query. */

test("boot: a thread with undelivered worker news wakes its lead; the announce run answers and closes the events", async () => {
  const h = leadHarness(async (c) =>
    c.kind === "lead" ? "the lead told the owner about the result" : "",
  );
  // A thread the bot opened before the crash (the row the boot wake needs to find the channel), and a worker's result
  // left undelivered by it (no owner message, no lead run in flight).
  recordBotThread(h.env.db, "t1", TEST_CHANNEL, "main", "⏳ 10-15 10:00");
  appendEvent(h.env.db, { id: "r1", threadId: "t1", kind: "result", payload: { excerpt: "done" } });
  const report = recoverInFlight(h.env.db);
  expect(report.threads).toEqual(["t1"]);
  // index.ts calls the handler's wake with the recovery report: the thread's lead gets an announce input.
  h.handle.wake(report);
  await until(() => h.posts.includes("the lead told the owner about the result"), 8000);
  expect(h.ofKind("lead")).toHaveLength(1);
  expect(listUndelivered(h.env.db, "t1")).toEqual([]);
}, 15_000);

test("boot: a thread without undelivered work is not woken", async () => {
  const h = leadHarness(async () => "must not run");
  const report = recoverInFlight(h.env.db);
  expect(report.threads).toEqual([]);
  h.handle.wake(report);
  await new Promise((r) => setTimeout(r, 100));
  expect(h.ofKind("lead")).toHaveLength(0);
  expect(h.posts).toEqual([]);
});

test("worker text reaches the owner only through the lead; the worker's own reply is never posted", async () => {
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.tool("ReportResult", { status: "COMPLETED", summary: "ok" });
      return "WORKER-ONLY-TEXT";
    }
    if (c.prompt.includes("Owner message:")) {
      await c.tool("DispatchAgent", {
        strategy: "DIRECT",
        intent: "work",
        reason: "one specialist",
        assignments: [{ key: "main", role: "dev", brief: "do it", dependsOn: [] }],
      });
      return "On it.";
    }
    return "Noted."; // the announce run of the result (a non-empty reply: an empty success reply posts a notice, see report)
  });
  await h.send("do it");
  await workersDone(h.env.db);
  await until(() => h.ofKind("lead").length === 2, 8000); // the announce run of the worker's end
  await new Promise((r) => setTimeout(r, 100));
  expect(h.ofKind("worker")).toHaveLength(1);
  expect(h.posts).toEqual(["On it.", "Noted."]);
  expect(h.posts.some((p) => p.includes("WORKER-ONLY-TEXT"))).toBe(false);
}, 15_000);
