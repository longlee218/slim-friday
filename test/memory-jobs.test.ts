import { expect, test } from "bun:test";
import { EPISODE_IDLE_MS, EPISODE_TTL_DAYS, PRUNE_INTERVAL_MS } from "../src/config/memory-caps";
import type { CompactLlm } from "../src/memory/memory-compaction-llm";
import { createMemoryJobs } from "../src/memory/memory-jobs";
import { logger } from "../src/observability/logger";
import { emptyUsage } from "../src/observability/run-usage";
import { openDb } from "../src/storage/db";
import { bumpCycle, getThreadSummary } from "../src/storage/thread-summary-store";
import { makeEnv } from "./helpers";

/** Jobs over a real db and config; the model call is a gate the test opens. */
function setup() {
  const env = makeEnv();
  const events: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const llm: CompactLlm = async (_s, prompt) => {
    events.push(`start ${prompt.includes("first") ? "first" : "second"}`);
    await gate;
    events.push("end");
    return { text: '{"items":[]}', usage: emptyUsage() };
  };
  const jobs = createMemoryJobs({ db: env.db, config: env.config, log: logger, llm });
  return { env, events, release, jobs };
}

const flushReq = (threadId: string, summary: string) => ({
  threadId,
  workspace: "location",
  channel: "ops",
  cycle: 1,
  summary,
  tail: [],
});

test("jobs of one thread run one after the other, other threads run side by side", async () => {
  const s = setup();
  for (const t of ["t1", "t2"]) bumpCycle(s.env.db, t, "location");
  s.jobs.flushAfterCompaction(flushReq("t1", "first"));
  s.jobs.flushAfterCompaction(flushReq("t1", "second"));
  s.jobs.flushAfterCompaction(flushReq("t2", "first"));
  await new Promise((r) => setTimeout(r, 30));
  // t1 first + t2 first started; the second t1 job waits behind the first.
  expect(s.events).toEqual(["start first", "start first"]);
  expect(s.jobs.size()).toBe(2);
  s.release();
  await s.jobs.drain(2000);
  expect(s.jobs.size()).toBe(0);
  // the second t1 job found the cycle flushed by the first: skipped, no third model call
  expect(s.events.filter((e) => e.startsWith("start"))).toHaveLength(2);
  expect(getThreadSummary(s.env.db, "t1")?.flushed_cycle).toBe(1);
});

test("drain waits for a pending flush up to the time given, then returns", async () => {
  const s = setup();
  bumpCycle(s.env.db, "t1", "location");
  s.jobs.flushAfterCompaction(flushReq("t1", "first"));
  const t0 = Date.now();
  const left = await s.jobs.drain(80); // the gate is closed: the flush cannot end
  expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  expect(left).toBeLessThan(20);
  expect(s.jobs.size()).toBe(1);
  s.release();
  const left2 = await s.jobs.drain(2000);
  expect(left2).toBeGreaterThan(1500);
  expect(s.jobs.size()).toBe(0);
});

test("abortAll: a queued flush does not start; a throwing model never rejects", async () => {
  const s = setup();
  bumpCycle(s.env.db, "t1", "location");
  s.jobs.flushAfterCompaction(flushReq("t1", "first"));
  s.jobs.flushAfterCompaction(flushReq("t1", "second"));
  await new Promise((r) => setTimeout(r, 30)); // the first job is running
  s.jobs.abortAll();
  s.jobs.flushAfterCompaction(flushReq("t1", "third")); // refused after stop
  s.release();
  await s.jobs.drain(2000);
  expect(s.events.filter((e) => e.startsWith("start"))).toHaveLength(1);

  const db = openDb(":memory:");
  const bad = createMemoryJobs({
    db,
    config: s.env.config,
    log: logger,
    llm: async () => {
      throw new Error("boom");
    },
  });
  bumpCycle(db, "t9", "location");
  bad.flushAfterCompaction(flushReq("t9", "first"));
  expect(await bad.drain(2000)).toBeGreaterThan(0);
});

/* The memory tick: idle episodes first, then the prune once PRUNE_INTERVAL_MS has passed since the last one. */
test("tick writes idle episodes and prunes expired ones only when the prune interval passed", async () => {
  const env = makeEnv();
  let clock = new Date(2026, 9, 21, 12, 0).getTime();
  const llm: CompactLlm = async () => ({ text: "episode text", usage: emptyUsage() });
  const jobs = createMemoryJobs({
    db: env.db,
    config: env.config,
    log: logger,
    llm,
    resolveChannel: () => ({ workspace: "ws", channel: "ops" }),
    now: () => new Date(clock),
  });
  env.db
    .query(
      "INSERT INTO turns (id, thread_id, source, location, status, started_at, ended_at, brief, role, kind) VALUES ('u1', 'th1', 'discord', '*', 'done', ?, ?, 'work', 'chief-of-staff', 'single')",
    )
    .run(clock - EPISODE_IDLE_MS - 2000, clock - EPISODE_IDLE_MS - 1000);
  await jobs.tick();
  expect(getThreadSummary(env.db, "th1")?.summary).toBe("episode text");
  // an expired episode: not pruned before the interval, pruned after it
  env.db
    .query(
      "INSERT INTO thread_summaries (thread_id, workspace, channel, summary, updated_at) VALUES ('old', 'ws', 'ops', 'x', ?)",
    )
    .run(clock - (EPISODE_TTL_DAYS + 1) * 86_400_000);
  clock += PRUNE_INTERVAL_MS - 1;
  await jobs.tick();
  expect(getThreadSummary(env.db, "old")).not.toBeNull();
  clock += 1;
  await jobs.tick();
  expect(getThreadSummary(env.db, "old")).toBeNull();
  jobs.abortAll(); // stops the tick
  await jobs.tick();
});

test("startTick keeps one unref'd timer and abortAll clears it", () => {
  const env = makeEnv();
  const jobs = createMemoryJobs({ db: env.db, config: env.config, log: logger });
  jobs.startTick();
  jobs.startTick();
  jobs.abortAll();
});
