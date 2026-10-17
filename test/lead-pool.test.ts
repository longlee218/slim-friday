import { expect, test } from "bun:test";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createLeadQueue, type LeadInput } from "../src/orchestrator/lead/lead-queue";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { until } from "./lead-harness";

/* Lead pool: bounded FIFO wait, one owner notice, /stop cancels a wait; lead runs never take a worker slot. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const input = (threadId: string, kind: LeadInput["kind"] = "owner"): LeadInput => ({
  threadId,
  kind,
  messageIds: [threadId],
  text: threadId,
});

test("limiter.acquire: FIFO hand-over, waiting bound, abort leaves the line, release is idempotent", async () => {
  const l = createRunLimiter(1, 2);
  const first = l.tryAcquire()!;
  const order: string[] = [];
  const a = l.acquire().then((r) => {
    order.push("a");
    return r;
  });
  const ac = new AbortController();
  const b = l.acquire(ac.signal).then((r) => {
    order.push("b");
    return r;
  });
  const c = l.acquire().then((r) => {
    order.push("c");
    return r;
  });
  expect(l.waiting()).toBe(2); // a and b queued; c is past the bound
  expect(await c).toBeNull();
  expect(l.canWait()).toBe(false);
  ac.abort(); // b leaves the line
  expect(await b).toBeNull();
  expect(l.waiting()).toBe(1);
  first();
  first(); // double release hands over once
  const second = (await a)!;
  expect(l.active()).toBe(1); // the slot went to a, the count never dipped
  expect(l.acquire(AbortSignal.abort())).resolves.toBeNull();
  second();
  expect(l.active()).toBe(0);
  expect(order).toEqual(["c", "b", "a"]);
});

test("pool 5: the 6th concurrent thread waits (one notice), the 51st waiting thread is refused with queue full, the rest run FIFO", async () => {
  const pool = createRunLimiter(5, 50);
  const notices: Array<[string, boolean]> = [];
  const ran: string[] = [];
  let live = 0;
  let maxLive = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const q = createLeadQueue({
    debounceMs: 1,
    pool,
    onQueued: (i, full) => void notices.push([i.threadId, full]),
    run: async (i) => {
      live++;
      maxLive = Math.max(maxLive, live);
      ran.push(i.threadId);
      await gate;
      live--;
    },
  });
  for (let n = 0; n < 5; n++) q.push(input(`t${n}`));
  q.push(input("t5"));
  await sleep(40);
  expect(ran).toHaveLength(5); // the 6th waits
  expect(pool.waiting()).toBe(1);
  expect(notices).toEqual([["t5", false]]); // told once, not "full"
  for (let n = 6; n < 55; n++) q.push(input(`t${n}`)); // 49 more waiting: 50 in line in total
  await sleep(40);
  expect(pool.waiting()).toBe(50);
  q.push(input("t55")); // 51st waiting thread
  q.push(input("a56", "announce")); // announce past the bound: dropped silently
  await sleep(40);
  expect(notices.at(-1)).toEqual(["t55", true]);
  expect(notices.filter(([, full]) => full)).toEqual([["t55", true]]);
  expect(notices).toHaveLength(51); // 50 waiting owners told once each + the refused one; announce never
  open();
  await sleep(150);
  expect(maxLive).toBe(5);
  expect(ran.slice(0, 7)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6"]); // FIFO
  expect(ran).toHaveLength(55); // t55 and a56 never ran
  expect(pool.active()).toBe(0);
});

test("thread queue overflow: the dropped owner input gets a queue full notice", async () => {
  const notices: Array<[string, boolean]> = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const q = createLeadQueue({
    debounceMs: 1,
    cap: 2,
    onQueued: (i, full) => void notices.push([i.text ?? "", full]),
    run: () => gate,
  });
  q.push({ ...input("th", "announce"), text: "running" });
  await sleep(5);
  for (const t of ["o1", "o2", "o3"]) {
    q.push({ ...input("th"), text: t });
    await sleep(8); // each owner input is debounced into its own queue entry
  }
  expect(notices).toEqual([["o1", true]]); // oldest dropped past the cap of 2
  open();
});

test("/stop cancels a wait: the input is dropped and its slot never taken", async () => {
  const pool = createRunLimiter(1, 5);
  const hold = pool.tryAcquire()!;
  const ran: string[] = [];
  const q = createLeadQueue({ debounceMs: 1, pool, run: async (i) => void ran.push(i.threadId) });
  q.push(input("th", "announce"));
  await sleep(20);
  expect(pool.waiting()).toBe(1);
  q.stop("th");
  await sleep(10);
  expect(pool.waiting()).toBe(0);
  hold();
  await sleep(20);
  expect(ran).toEqual([]);
  expect(pool.active()).toBe(0);
  expect(q.busy("th")).toBe(false);
});

/** A handler with its own lead pool and worker limiter over a fake query that answers at once. */
function handlerWith(pools: {
  limiter: ReturnType<typeof createRunLimiter>;
  leadPool: ReturnType<typeof createRunLimiter>;
}) {
  const env = makeEnv();
  let calls = 0;
  const queryFn = (() => {
    calls++;
    return (async function* () {
      yield resultMsg();
    })();
  }) as never;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn,
    ...pools,
    leadTiming: { debounceMs: 5, announceWindowMs: 20 },
  });
  const posts: string[] = [];
  const send = (threadId: string) =>
    handle({
      source: "test",
      language: "en" as const,
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId,
      text: "hello",
      notify: async (t: string) => void posts.push(t),
    });
  return { send, posts, calls: () => calls };
}

test("10 busy workers do not block a lead run", async () => {
  const limiter = createRunLimiter(10);
  const held = Array.from({ length: 10 }, () => limiter.tryAcquire()!);
  const { send, calls } = handlerWith({ limiter, leadPool: createRunLimiter(5, 50) });
  await send("th1");
  await until(() => calls() >= 1);
  expect(limiter.active()).toBe(10); // the lead took no worker slot
  for (const r of held) r();
});

test("owner input on a full lead pool: one queue notice, runs when a slot frees; refused with queue full past the bound", async () => {
  const leadPool = createRunLimiter(1, 1);
  const hold = leadPool.tryAcquire()!;
  const { send, posts, calls } = handlerWith({ limiter: createRunLimiter(10), leadPool });
  await send("th1");
  await until(() => posts.length === 1);
  expect(posts[0]).toContain("Received your request"); // `queue` notice, not full
  await send("th2"); // the bound (1 waiting thread) is reached
  await until(() => posts.some((p) => p.includes("queue is full")));
  expect(calls()).toBe(0);
  hold();
  await until(() => calls() === 1);
  expect(posts.filter((p) => p.includes("Received your request"))).toHaveLength(1);
});

test("shutdown: a freed lead slot never starts a new run (waiter and queued inputs are dropped)", async () => {
  const pool = createRunLimiter(1, 5);
  const hold = pool.tryAcquire()!;
  let stopping = false;
  const ran: string[] = [];
  const q = createLeadQueue({
    debounceMs: 1,
    pool,
    stopping: () => stopping,
    run: async (i) => void ran.push(i.threadId),
  });
  q.push(input("th", "announce"));
  q.push({ ...input("th", "announce"), text: "second" });
  await sleep(20);
  expect(pool.waiting()).toBe(1);
  stopping = true; // SIGTERM: tracker.isStopping is true before the queue is stopped
  hold();
  await sleep(20);
  expect(ran).toEqual([]);
  expect(pool.active()).toBe(0);
  expect(q.busy("th")).toBe(false);
});
