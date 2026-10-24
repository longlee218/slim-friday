import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type WakeRow } from "../src";
import { RunClaimer } from "../src/runs/run-claimer";
import { RunLease } from "../src/runs/run-lease";
import { FakeClock } from "./fakes/fake-clock";
import { FakeLog } from "./fakes/fake-log";
import { FakeStore } from "./fakes/fake-store";

/** A queued run; each run gets its own scope unless a test says otherwise. */
function queued(id: string, p: Partial<WakeRow> = {}): WakeRow {
  return {
    id,
    chainId: id,
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "hi",
    status: "queued",
    attempts: 0,
    createdAt: 0,
    scopeKey: id,
    priority: "interactive",
    leaseFence: 0,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    ...p,
  };
}

/** Let queued promise callbacks run (a microtask flush; the fakes never wait on real time). */
const settle = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};

/** A claimer whose executions stay open until the test releases them. */
function setup(free = () => 4096) {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  const log = new FakeLog();
  const started: string[] = [];
  const release: (() => void)[] = [];
  const claimer = new RunClaimer({
    store,
    clock,
    limits: CORE_DEFAULTS,
    log,
    owner: "boot1:w1",
    bootId: "boot1",
    freeMemoryMb: free,
    execute: (row) => {
      started.push(row.id);
      return new Promise<void>((r) => release.push(r));
    },
  });
  return { store, clock, log, started, release, claimer };
}

test("claims on hint without waiting for the scan", async () => {
  const s = setup();
  s.claimer.start();
  await s.store.wakes.insert(queued("a"));
  s.claimer.onHint();
  await settle();
  expect(s.started).toEqual(["a"]);
  expect(s.store.wakeMap.get("a")?.status).toBe("running");
  expect(s.store.attemptMap.size).toBe(1);
});

test("scan claims a row whose hint was lost", async () => {
  const s = setup();
  s.claimer.start();
  await s.store.wakes.insert(queued("a"));
  await settle();
  expect(s.started).toEqual([]);
  s.clock.advance(CORE_DEFAULTS.scanMs);
  await settle();
  expect(s.started).toEqual(["a"]);
});

test("stops claiming at runsPerWorker", async () => {
  const s = setup();
  for (let i = 0; i < 6; i++) await s.store.wakes.insert(queued(`r${i}`, { createdAt: i }));
  s.claimer.start();
  s.claimer.onHint();
  await settle();
  expect(s.claimer.running).toBe(CORE_DEFAULTS.runsPerWorker);
  s.release[0]?.();
  await settle();
  expect(s.started.length).toBe(CORE_DEFAULTS.runsPerWorker + 1);
});

test("does not claim under the memory floor", async () => {
  let free = CORE_DEFAULTS.minFreeMemoryMb - 1;
  const s = setup(() => free);
  await s.store.wakes.insert(queued("a"));
  s.claimer.start();
  s.claimer.onHint();
  await settle();
  expect(s.started).toEqual([]);
  free = CORE_DEFAULTS.minFreeMemoryMb;
  s.clock.advance(CORE_DEFAULTS.scanMs);
  await settle();
  expect(s.started).toEqual(["a"]);
});

test("stale worker cannot renew or finish after a reclaim", async () => {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  await store.wakes.insert(queued("a"));
  const claim = (owner: string) =>
    store.wakes.claimNext({
      owner,
      bootId: owner.split(":")[0] as string,
      now: clock.now(),
      leaseMs: CORE_DEFAULTS.leaseMs,
    });
  const a = (await claim("bootA:w1")) as WakeRow;
  // A paused worker: its lease expires, B reclaims, then A wakes up and heartbeats.
  clock.advance(CORE_DEFAULTS.leaseMs + 1);
  const b = await claim("bootB:w1");
  expect(b?.leaseFence).toBe(a.leaseFence + 1);
  expect(await store.wakes.renew("a", "bootA:w1", a.leaseFence, 9e9)).toBe(false);
  const lost: string[] = [];
  // Fence checks are pushed out so the heartbeat is what notices.
  const limits = { ...CORE_DEFAULTS, fenceCheckMs: 10 * CORE_DEFAULTS.heartbeatMs };
  const lease = new RunLease(store, clock, limits, a, "bootA:w1", (why) => lost.push(why));
  lease.start();
  clock.advance(CORE_DEFAULTS.heartbeatMs);
  await settle();
  expect(lost).toEqual(["renew"]);
  expect(
    await store.wakes.transition("a", lease.fence, ["running", "leased"], { status: "done" }),
  ).toBe(false);
  lease.stop();
});

test("cancelled row triggers onLost within fenceCheckMs", async () => {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  await store.wakes.insert(queued("a"));
  const row = (await store.wakes.claimNext({
    owner: "b:w",
    bootId: "b",
    now: 1000,
    leaseMs: CORE_DEFAULTS.leaseMs,
  })) as WakeRow;
  const lost: string[] = [];
  const lease = new RunLease(store, clock, CORE_DEFAULTS, row, "b:w", (why) => lost.push(why));
  lease.start();
  clock.advance(CORE_DEFAULTS.fenceCheckMs);
  await settle();
  expect(lost).toEqual([]);
  await store.wakes.update("a", { status: "cancelled" });
  clock.advance(CORE_DEFAULTS.fenceCheckMs);
  await settle();
  expect(lost).toEqual(["cancelled"]);
  lease.stop();
});

test("logs run.queue_delayed for a 31 s old interactive run", async () => {
  const s = setup();
  s.clock.advance(31_000);
  await s.store.wakes.insert(queued("a", { createdAt: s.clock.now() - 31_000 }));
  await s.store.wakes.insert(queued("b", { createdAt: s.clock.now() - 1000 }));
  s.claimer.start();
  s.claimer.onHint();
  await settle();
  const lines = s.log.of("run.queue_delayed");
  expect(lines.length).toBe(1);
  expect(lines[0]?.level).toBe("warn");
  expect(lines[0]?.fields.wakeId).toBe("a");
  expect(Object.keys(lines[0]?.fields ?? {}).sort()).toEqual(["botId", "delayMs", "wakeId"]);
});

test("a failing execute does not kill the claimer and frees the slot", async () => {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  await store.wakes.insert(queued("a"));
  const claimer = new RunClaimer({
    store,
    clock,
    limits: CORE_DEFAULTS,
    log: new FakeLog(),
    owner: "b:w",
    bootId: "b",
    freeMemoryMb: () => 4096,
    execute: async () => {
      throw new Error("boom");
    },
  });
  claimer.start();
  claimer.onHint();
  await settle();
  expect(claimer.running).toBe(0);
  await claimer.stop();
});

/** Claim a row by hand so a lease can be driven alone. */
async function leased(store: FakeStore, id: string, owner: string, now = 1000) {
  await store.wakes.insert(queued(id));
  return (await store.wakes.claimNext({
    owner,
    bootId: owner.split(":")[0] as string,
    now,
    leaseMs: CORE_DEFAULTS.leaseMs,
  })) as WakeRow;
}

test("stop() resolves while idle and after the worker was full", async () => {
  const idle = setup();
  idle.claimer.start();
  await settle();
  await idle.claimer.stop();

  const s = setup();
  for (let i = 0; i < 5; i++) await s.store.wakes.insert(queued(`r${i}`, { createdAt: i }));
  s.claimer.start();
  await settle();
  expect(s.claimer.running).toBe(CORE_DEFAULTS.runsPerWorker);
  s.clock.advance(CORE_DEFAULTS.scanMs);
  await settle();
  for (let i = 0; i < 5; i++) {
    s.release[i]?.();
    await settle();
  }
  for (const r of s.release) r();
  await s.claimer.stop();
  expect(s.claimer.running).toBe(0);
});

test("a hint during a pass triggers exactly one more pass", async () => {
  const s = setup();
  let calls = 0;
  let gate!: () => void;
  const real = s.store.wakes.claimNext;
  s.store.wakes.claimNext = async (o) => {
    calls++;
    if (calls === 1) await new Promise<void>((r) => (gate = r));
    return real(o);
  };
  s.claimer.start();
  await settle();
  s.claimer.onHint();
  s.claimer.onHint();
  s.claimer.onHint();
  gate();
  await settle();
  expect(calls).toBe(2);
});

test("lease reports fence when another owner or fence holds the row", async () => {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  const row = await leased(store, "a", "b:w");
  const lost: string[] = [];
  const lease = new RunLease(store, clock, CORE_DEFAULTS, row, "b:w", (w) => lost.push(w));
  lease.start();
  await store.wakes.update("a", { leaseOwner: "c:w", leaseFence: row.leaseFence + 1 });
  clock.advance(CORE_DEFAULTS.fenceCheckMs);
  await settle();
  expect(lost).toEqual(["fence"]);
});

test("onLost fires once and no timer runs after a loss or a stop", async () => {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  const row = await leased(store, "a", "b:w");
  let reads = 0;
  const get = store.wakes.get;
  store.wakes.get = async (id) => {
    reads++;
    return get(id);
  };
  const lost: string[] = [];
  const lease = new RunLease(store, clock, CORE_DEFAULTS, row, "b:w", (w) => lost.push(w));
  lease.start();
  await store.wakes.update("a", { status: "cancelled" });
  clock.advance(CORE_DEFAULTS.fenceCheckMs * 5);
  await settle();
  expect(lost).toEqual(["cancelled"]);
  const after = reads;
  clock.advance(CORE_DEFAULTS.heartbeatMs * 3);
  await settle();
  expect(reads).toBe(after);

  const row2 = await leased(store, "z", "b:w");
  const l2 = new RunLease(store, clock, CORE_DEFAULTS, row2, "b:w", (w) => lost.push(w));
  l2.start();
  l2.stop();
  const before = reads;
  clock.advance(CORE_DEFAULTS.heartbeatMs * 3);
  await settle();
  expect(reads).toBe(before);
  expect(lost).toEqual(["cancelled"]);
});

/** A claimer whose store or executor is rigged; reports the lease it was given. */
function rigged(execute: (r: WakeRow, l: RunLease) => Promise<void>) {
  const store = new FakeStore();
  const clock = new FakeClock(1000);
  const log = new FakeLog();
  const leases: RunLease[] = [];
  const claimer = new RunClaimer({
    store,
    clock,
    limits: CORE_DEFAULTS,
    log,
    owner: "b:w",
    bootId: "b",
    freeMemoryMb: () => 4096,
    execute: async (r, l) => {
      leases.push(l);
      await execute(r, l);
    },
  });
  return { store, clock, log, claimer, leases };
}

test("the lease is stopped after execute resolves and after it throws", async () => {
  for (const fail of [false, true]) {
    const s = rigged(async () => {
      if (fail) throw new Error("boom");
    });
    await s.store.wakes.insert(queued("a"));
    s.claimer.start();
    await settle();
    let reads = 0;
    const get = s.store.wakes.get;
    s.store.wakes.get = async (id) => {
      reads++;
      return get(id);
    };
    s.clock.advance(CORE_DEFAULTS.heartbeatMs);
    await settle();
    expect(reads).toBe(0);
    expect(s.leases.length).toBe(1);
    await s.claimer.stop();
  }
});

test("attempts.start throwing stops the lease and frees the slot", async () => {
  const s = rigged(async () => {});
  s.store.attempts.start = async () => {
    throw new Error("db");
  };
  await s.store.wakes.insert(queued("a"));
  s.claimer.start();
  await settle();
  expect(s.claimer.running).toBe(0);
  expect(s.log.of("run.execute_failed").length).toBe(1);
  await s.claimer.stop();
});

test("a failed leased->running transition logs run.claim_lost and skips execute", async () => {
  const s = rigged(async () => {});
  s.store.wakes.transition = async () => false;
  await s.store.wakes.insert(queued("a"));
  s.claimer.start();
  await settle();
  expect(s.leases.length).toBe(0);
  expect(s.log.of("run.claim_lost")[0]?.fields).toEqual({ wakeId: "a" });
  expect(s.claimer.running).toBe(0);
  await s.claimer.stop();
});

test("start twice arms one scan", async () => {
  const s = setup();
  let calls = 0;
  const real = s.store.wakes.claimNext;
  s.store.wakes.claimNext = async (o) => {
    calls++;
    return real(o);
  };
  s.claimer.start();
  s.claimer.start();
  await settle();
  const base = calls;
  s.clock.advance(CORE_DEFAULTS.scanMs);
  await settle();
  expect(calls).toBe(base + 1);
});
