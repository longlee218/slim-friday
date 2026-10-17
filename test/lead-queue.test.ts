import { expect, test } from "bun:test";
import { createLeadQueue, type LeadInput } from "../src/orchestrator/lead/lead-queue";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";

/* Lead queue: debounce merge, FIFO, cap, one run per thread, stop. Real timers with tiny delays. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const owner = (id: string, text: string, threadId = "th"): LeadInput => ({
  threadId,
  kind: "owner",
  messageIds: [id],
  text,
});

test("3 owner messages inside the debounce window -> ONE input with 3 message ids and the joined text", async () => {
  const seen: LeadInput[] = [];
  const q = createLeadQueue({ run: async (i) => void seen.push(i), debounceMs: 30 });
  q.push(owner("m1", "a"));
  q.push(owner("m2", "b"));
  q.push(owner("m3", "c"));
  expect(q.busy("th")).toBe(true); // debouncing counts as busy
  await sleep(90);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.messageIds).toEqual(["m1", "m2", "m3"]);
  expect(seen[0]!.text).toBe("a\nb\nc");
  expect(q.busy("th")).toBe(false);
});

test("max 1 run per thread, FIFO: the next input starts only after the run settled; other threads run in parallel", async () => {
  const order: string[] = [];
  let live = 0;
  let maxLive = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const q = createLeadQueue({
    debounceMs: 5,
    run: async (i) => {
      live++;
      maxLive = Math.max(maxLive, live);
      order.push(`start:${i.text}`);
      if (i.text === "first") await gate;
      order.push(`end:${i.text}`);
      live--;
    },
  });
  q.push(owner("m1", "first"));
  await sleep(30); // first is running (blocked on the gate)
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "second", eventSeqs: [1] });
  await sleep(20);
  expect(order).toEqual(["start:first"]); // second waits
  release();
  await sleep(30);
  expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  expect(maxLive).toBe(1);
});

test("cap: past the cap the oldest queued input is dropped", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const q = createLeadQueue({
    debounceMs: 1,
    cap: 2,
    run: async (i) => {
      ran.push(i.text!);
      if (i.text === "a") await gate;
    },
  });
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "a" });
  await sleep(10); // a runs (blocked)
  for (const t of ["b", "c", "d"])
    q.push({ threadId: "th", kind: "announce", messageIds: [], text: t });
  release();
  await sleep(30);
  expect(ran).toEqual(["a", "c", "d"]); // b was the oldest past the cap of 2
});

test("stop clears debouncing and queued inputs and their timer; later pushes still work", async () => {
  const ran: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const q = createLeadQueue({
    debounceMs: 20,
    run: async (i) => {
      ran.push(i.text!);
      if (i.text === "run") await gate;
    },
  });
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "run" });
  await sleep(5);
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "queued" });
  q.push(owner("m1", "debouncing"));
  q.stop("th");
  release();
  await sleep(60);
  expect(ran).toEqual(["run"]); // nothing queued or debouncing ran after the stop
  expect(q.busy("th")).toBe(false);
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "after" });
  await sleep(20);
  expect(ran).toEqual(["run", "after"]);
});

test("a run takes a lead slot and frees it; a full pool delays the run; a thrown run does not stop the queue", async () => {
  const limiter = createRunLimiter(1, 5);
  const hold = limiter.tryAcquire()!; // the only slot is taken elsewhere
  const ran: string[] = [];
  const q = createLeadQueue({
    debounceMs: 1,
    pool: limiter,
    run: async (i) => {
      ran.push(i.text!);
      if (i.text === "boom") throw new Error("runner failed");
    },
  });
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "boom" });
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "next" });
  await sleep(30);
  expect(ran).toEqual([]); // no slot yet
  hold();
  await sleep(50);
  expect(ran).toEqual(["boom", "next"]); // the throw was contained
  expect(limiter.active()).toBe(0);
});

test("default debounce is 800ms: owner messages 100ms apart merge into one input, emitted 800ms after the last", async () => {
  const seen: LeadInput[] = [];
  const q = createLeadQueue({ run: async (i) => void seen.push(i) }); // no debounceMs: the 800ms default
  q.push(owner("m1", "a"));
  await sleep(100);
  q.push(owner("m2", "b"));
  await sleep(100);
  q.push(owner("m3", "c"));
  await sleep(500); // 500ms after the last message: still debouncing
  expect(seen).toHaveLength(0);
  expect(q.busy("th")).toBe(true);
  await sleep(500); // 1000ms after the last message: the merged input has run
  expect(seen).toHaveLength(1);
  expect(seen[0]!.messageIds).toEqual(["m1", "m2", "m3"]);
});

test("waiting bound reached: the input is refused (run never called), the queue keeps serving later inputs", async () => {
  const limiter = createRunLimiter(1, 0); // nobody may wait
  const hold = limiter.tryAcquire()!;
  const ran: string[] = [];
  const q = createLeadQueue({
    debounceMs: 1,
    pool: limiter,
    run: async (i) => void ran.push(i.text!),
  });
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "lost" });
  await sleep(20);
  expect(ran).toEqual([]); // refused: the input is gone, not run later
  expect(q.busy("th")).toBe(false);
  hold();
  q.push({ threadId: "th", kind: "announce", messageIds: [], text: "later" });
  await sleep(20);
  expect(ran).toEqual(["later"]);
  expect(limiter.active()).toBe(0);
});

test("max debounce wait: a steady stream of owner messages is emitted after 3x debounce, not deferred forever", async () => {
  const seen: LeadInput[] = [];
  const q = createLeadQueue({ run: async (i) => void seen.push(i), debounceMs: 40 }); // max wait 120ms
  for (let n = 0; n < 8; n++) {
    q.push(owner(`m${n}`, "x"));
    await sleep(25); // always inside the quiet window
  }
  expect(seen.length).toBeGreaterThanOrEqual(1); // emitted while messages were still arriving
  expect(seen[0]!.messageIds.length).toBeLessThan(8);
  await sleep(120);
  expect(seen.flatMap((i) => i.messageIds)).toHaveLength(8); // nothing lost
});
