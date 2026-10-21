import { expect, test } from "bun:test";
import type { InboundMessage } from "../src/ingress/discord-message-handler";
import { createLeadIo } from "../src/orchestrator/lead/lead-io";
import type { LeadRuntime, LeadThreadCtx } from "../src/orchestrator/lead/lead-runtime";
import { createLeadSystem } from "../src/orchestrator/lead/lead-system";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";
import { makeEnv, stubGateway, TEST_CHANNEL } from "./helpers";
import { type Call, leadHarness, noticeSink, scriptedQuery, sleep, until } from "./lead-harness";

/* Review fixes of the lead runtime: rollover order, /stop reach, failed-announce cap, direct dispatch queueing, empty reply. */

/** A bare lead system over a fake query (no handler): lets a test see the rollover hooks and the stop reach. */
function system(
  script: Parameters<typeof scriptedQuery>[0],
  o: Partial<Parameters<typeof createLeadSystem>[0]> = {},
) {
  const env = makeEnv();
  const calls: Call[] = [];
  const log: string[] = [];
  const sys = createLeadSystem({
    deps: {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: scriptedQuery(script, calls),
      stopping: () => false,
    },
    debounceMs: 10,
    announceWindowMs: 30,
    ...o,
  });
  const message = (text = "hello", threadId = "t1"): InboundMessage => ({
    source: "discord",
    userId: "owner",
    threadId,
    channelId: TEST_CHANNEL,
    messageId: `m-${crypto.randomUUID()}`,
    text,
    language: "en",
    notify: async (m) => void log.push(`post:${m}`),
    visible: async () => void log.push("visible"),
  });
  return { env, calls, log, sys, message };
}

test("H1: a lead run waits for the thread's rollover; the rollover starts only after the reply is posted", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t = system(async () => "the reply", {
    hold: () => gate,
    afterRun: () => void t.log.push("afterRun"),
  });
  const msg = t.message();
  t.sys.remember(msg);
  t.sys.submit(msg);
  await sleep(150); // past the debounce: the input is queued but the run waits for the rollover
  expect(t.calls).toHaveLength(0);
  release();
  await until(() => t.log.includes("afterRun"));
  expect(t.calls).toHaveLength(1);
  expect(t.log).toEqual(["post:the reply", "afterRun"]); // never afterRun before the post
});

test("M1: /stop cancels the announce timer and ends the thread's worker question waits", async () => {
  const t = system(async () => "must not run");
  const msg = t.message();
  t.sys.remember(msg);
  // A result the lead has not heard of, and a batch timer for it.
  appendEvent(t.env.db, { id: "r1", threadId: "t1", kind: "result", payload: { excerpt: "x" } });
  t.sys.rt.announce("t1");
  // A worker waiting on a question.
  const wait = t.sys.rt.relay.forWorker({
    threadId: "t1",
    goalId: "g",
    itemId: "i1",
    turnId: "u1",
  })([{ question: "Which?", options: [{ label: "a" }, { label: "b" }] }] as never);
  t.sys.stopThread("t1");
  expect(await wait).toBeUndefined(); // the wait ended with no answer
  expect(t.sys.rt.relay.answer("i1", "a")).toBe(false); // a late answer finds nobody waiting
  await sleep(120); // longer than the announce window
  expect(t.calls).toHaveLength(0); // the batch timer was cancelled: no lead run
});

test("M1: Orchestrate ask_owner for a worker that is gone (stopped) is not a success; /stop ends a pending owner question", async () => {
  const ctx = { message: { notify: async () => {} } } as unknown as LeadThreadCtx;
  const gone = {
    deps: { approvals: stubGateway({ askChoice: async () => "b" }) },
    relay: { answer: () => false }, // nobody waits any more
  } as unknown as LeadRuntime;
  const io = createLeadIo(gone, ctx, "t", "turn", new AbortController().signal);
  const late = await io.askOwner({
    question: "q",
    options: ["a", "b"],
    taskId: "i1",
    workerAskId: "w",
  });
  expect(late.timedOut).toBe(true);
  expect(late.answer).toBeUndefined();
  // A pending question ends when the lead run is aborted (`/stop`): buttons are cancelled, no answer.
  let cancelled = false;
  const ac = new AbortController();
  const pending = {
    deps: {
      approvals: stubGateway({
        askChoice: () => new Promise(() => {}),
        cancelTurn: () => {
          cancelled = true;
        },
      }),
    },
    relay: { answer: () => true },
  } as unknown as LeadRuntime;
  const answer = createLeadIo(pending, ctx, "t", "turn", ac.signal).askOwner({
    question: "q",
    options: ["a", "b"],
  });
  ac.abort();
  expect(await answer).toEqual({ answer: undefined, timedOut: true });
  expect(cancelled).toBe(true);
});

test("M3: a failed announce run is retried once, then dropped with ONE notice (not one per later announce)", async () => {
  let announceRuns = 0;
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") {
      await c.report("result", { title: "T", status: "COMPLETED", summary: "ok" });
      return "";
    }
    if (c.prompt.includes("Owner message:")) {
      await c.orchestrate("dispatch", {
        strategy: "DIRECT",
        small: true,
        intent: "work",
        reason: "test",
        assignments: [{ key: "main", subject: "task", role: "scout", brief: "do", dependsOn: [] }],
      });
      return "started";
    }
    announceRuns++;
    throw new Error("lead down");
  });
  await h.send("go");
  await until(() => announceRuns >= 2, 8000);
  await until(() => h.posts.some((p) => p.includes("could not answer")));
  await sleep(300); // a third attempt would show up here
  expect(announceRuns).toBe(2);
  expect(h.posts.filter((p) => p.includes("could not answer"))).toHaveLength(1);
  expect(listUndelivered(h.env.db, "t1")).toEqual([]); // the news is closed, no endless retry
}, 15_000);

test("a lead run that answers with tool calls only posts nothing (no `did not finish` notice) and still marks the message visible", async () => {
  const h = leadHarness(async () => "");
  let visible = 0;
  const sink = noticeSink();
  await h.handle({
    source: "discord",
    userId: "owner",
    threadId: "t1",
    channelId: TEST_CHANNEL,
    messageId: "m1",
    text: "quiet please",
    language: "en",
    notify: sink.notify,
    visible: async () => void visible++,
  });
  await until(() => h.ofKind("lead").length === 1);
  await until(() => visible === 1);
  expect(sink.posts).toEqual([]);
});
