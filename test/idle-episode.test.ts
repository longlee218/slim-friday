import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { EPISODE_IDLE_MS, EPISODE_MAX_PER_TICK } from "../src/config/memory-caps";
import { writeIdleEpisodes } from "../src/memory/idle-episode";
import { searchIndex } from "../src/memory/index/memory-search";
import type { CompactLlm } from "../src/memory/memory-compaction-llm";
import { openDb } from "../src/storage/db";
import { bumpCycle, getThreadSummary, saveSummary } from "../src/storage/thread-summary-store";

/* Idle episodes: fixed clock, fake model and fake channel resolver; the db and the index are real. */

const T0 = 1_800_000_000_000;
const usage = {} as never;

/** Fake model: counts calls and answers a fixed text. */
function fakeLlm(reply = "The owner asked for a kubernetes ingress rollout. It shipped.") {
  const calls: string[] = [];
  const llm: CompactLlm = async (_system, prompt) => {
    calls.push(prompt);
    return { text: reply, usage };
  };
  return { llm, calls };
}

/** One turn row with explicit times. */
function turn(
  db: Database,
  id: string,
  thread: string,
  role: string,
  status: string,
  start: number,
  end: number | null,
  brief = "",
) {
  db.query(
    "INSERT INTO turns (id, thread_id, source, location, status, started_at, ended_at, brief, role, kind) VALUES (?, ?, 'discord', '*', ?, ?, ?, ?, ?, 'single')",
  ).run(id, thread, status, start, end, brief, role);
}

const resolve = (id: string) => (id === "chan1" ? { workspace: "ws", channel: "ops" } : null);

function setup() {
  const db = openDb(":memory:");
  db.query(
    "INSERT INTO threads (thread_id, channel_id, workspace, origin, title, created_at, updated_at) VALUES ('th1', 'chan1', 'ws', 'bot', 'Ingress rollout', 1, 1)",
  ).run();
  return db;
}

test("an idle thread gets one episode, the second tick writes nothing", async () => {
  const db = setup();
  turn(
    db,
    "u1",
    "th1",
    "chief-of-staff",
    "done",
    T0 - EPISODE_IDLE_MS - 5000,
    T0 - EPISODE_IDLE_MS - 1000,
    "roll out the kubernetes ingress",
  );
  const m = fakeLlm();
  const deps = { db, llm: m.llm, resolve, now: () => T0 };
  expect(await writeIdleEpisodes(deps)).toBe(1);
  expect(m.calls).toHaveLength(1);
  expect(m.calls[0]).toContain("kubernetes ingress");
  expect(m.calls[0]).toContain("Ingress rollout");
  const row = getThreadSummary(db, "th1");
  expect(row).toMatchObject({ workspace: "ws", channel: "ops", updated_at: T0 });
  expect(row?.summary).toContain("ingress rollout");
  expect(row?.abstract).not.toBe("");
  expect(row?.key_topics).toContain("ingress");
  // indexed and searchable in its own channel only
  expect(searchIndex(db, "ws", { query: "ingress", limit: 5, channel: "ops" }).hits).toHaveLength(
    1,
  );
  expect(await writeIdleEpisodes(deps)).toBe(0);
  expect(m.calls).toHaveLength(1);
});

test("not idle yet, a running turn, a failed teammate turn and worker turns do not make an episode", async () => {
  const db = setup();
  const m = fakeLlm();
  const deps = { db, llm: m.llm, resolve, now: () => T0 };
  turn(db, "u1", "th1", "chief-of-staff", "done", T0 - 1000, T0 - 500, "recent"); // ended 500 ms ago
  expect(await writeIdleEpisodes(deps)).toBe(0);
  turn(db, "u2", "th2", "chief-of-staff", "failed", 1, 2, "failed run");
  turn(db, "u3", "th3", "developer", "done", 1, 2, "worker only");
  expect(await writeIdleEpisodes(deps)).toBe(0);
  turn(db, "u4", "th4", "chief-of-staff", "done", 1, 2, "old teammate turn");
  turn(db, "u5", "th4", "developer", "running", 3, null, "still running");
  expect(await writeIdleEpisodes(deps)).toBe(0);
  expect(m.calls).toHaveLength(0);
});

test("a compaction summary written during the last turn is reused with no model call", async () => {
  const db = setup();
  turn(db, "u1", "th1", "chief-of-staff", "done", T0 - 20_000_000, T0 - 10_000_000, "long task");
  saveSummary(db, {
    threadId: "th1",
    workspace: "ws",
    channel: "ops",
    summary: "Compacted summary of the rollout.",
    source: "compaction",
    now: T0 - 15_000_000,
  });
  bumpCycle(db, "th1", "ws", "ops");
  db.query("UPDATE thread_summaries SET updated_at = ? WHERE thread_id = 'th1'").run(
    T0 - 15_000_000,
  );
  const m = fakeLlm();
  expect(await writeIdleEpisodes({ db, llm: m.llm, resolve, now: () => T0 })).toBe(1);
  expect(m.calls).toHaveLength(0);
  expect(getThreadSummary(db, "th1")).toMatchObject({
    summary: "Compacted summary of the rollout.",
    updated_at: T0,
    cycle: 1,
  });
});

test("a model error falls back to the facts text, an aborted run writes nothing", async () => {
  const db = setup();
  turn(db, "u1", "th1", "chief-of-staff", "done", 1, 2, "deploy the cache layer");
  const bad: CompactLlm = async () => {
    throw new Error("model down");
  };
  expect(await writeIdleEpisodes({ db, llm: bad, resolve, now: () => T0 })).toBe(1);
  expect(getThreadSummary(db, "th1")?.summary).toContain("deploy the cache layer");

  const db2 = setup();
  turn(db2, "u1", "th1", "chief-of-staff", "done", 1, 2, "deploy the cache layer");
  const ac = new AbortController();
  const aborting: CompactLlm = async () => {
    ac.abort();
    throw new Error("aborted");
  };
  expect(
    await writeIdleEpisodes({ db: db2, llm: aborting, resolve, now: () => T0, signal: ac.signal }),
  ).toBe(0);
  expect(getThreadSummary(db2, "th1")).toBeNull();
});

test("at most EPISODE_MAX_PER_TICK per tick, the rest on the next one; chat-mode thread uses its id as channel", async () => {
  const db = setup();
  for (let i = 0; i < EPISODE_MAX_PER_TICK + 2; i++)
    turn(db, `u${i}`, `c${i}`, "chief-of-staff", "done", i + 1, i + 2, `topic number ${i}`);
  const m = fakeLlm();
  const seen: string[] = [];
  const deps = {
    db,
    llm: m.llm,
    resolve: (id: string) => {
      seen.push(id);
      return { workspace: "ws", channel: "ops" };
    },
    now: () => T0,
  };
  expect(await writeIdleEpisodes(deps)).toBe(EPISODE_MAX_PER_TICK);
  expect(await writeIdleEpisodes(deps)).toBe(2);
  expect(seen[0]).toBe("c0"); // no threads row: the thread id is the channel id
});

test("M1: a compaction summary saved during the model call is not overwritten by the idle episode", async () => {
  const db = setup();
  turn(db, "u1", "th1", "chief-of-staff", "done", 1, 2, "deploy the cache layer");
  const racing: CompactLlm = async () => {
    // A new turn compacted while the model ran: newer summary, newer updated_at.
    saveSummary(db, {
      threadId: "th1",
      workspace: "ws",
      channel: "ops",
      summary: "Newer compaction summary.",
      source: "compaction",
      now: T0 - 1000,
    });
    return { text: "Older idle text.", usage };
  };
  expect(await writeIdleEpisodes({ db, llm: racing, resolve, now: () => T0 })).toBe(0);
  expect(getThreadSummary(db, "th1")).toMatchObject({
    summary: "Newer compaction summary.",
    updated_at: T0 - 1000,
  });
});

test("M2: the model-failure fallback stores the facts only, no nesting, newest facts kept when clipped", async () => {
  const db = setup();
  turn(db, "u1", "th1", "chief-of-staff", "done", 1, 2, "first request");
  const bad: CompactLlm = async () => {
    throw new Error("model down");
  };
  const deps = { db, llm: bad, resolve, now: () => T0 };
  expect(await writeIdleEpisodes(deps)).toBe(1);
  expect(getThreadSummary(db, "th1")?.summary).not.toContain("Earlier episode");
  // New work after the episode, long enough to need a clip: the tail (newest) survives.
  const big = `${"x".repeat(9000)} NEWEST-FACT`;
  turn(db, "u2", "th1", "chief-of-staff", "done", T0 + 1000, T0 + 2000, big);
  expect(await writeIdleEpisodes({ ...deps, now: () => T0 + 2000 + EPISODE_IDLE_MS })).toBe(1);
  const s = getThreadSummary(db, "th1")?.summary ?? "";
  expect(s).not.toContain("Earlier episode");
  expect(s).toContain("NEWEST-FACT");
  expect(s.length).toBeLessThanOrEqual(8000);
});

test("M3: threads that keep failing do not block newer ones", async () => {
  const db = setup();
  for (let i = 0; i < EPISODE_MAX_PER_TICK + 2; i++)
    turn(db, `u${i}`, `c${i}`, "chief-of-staff", "done", i + 1, i + 2, `topic number ${i}`);
  const m = fakeLlm();
  const deps = {
    db,
    llm: m.llm,
    resolve: (id: string) => {
      if (Number(id.slice(1)) < EPISODE_MAX_PER_TICK) throw new Error("poison");
      return { workspace: "ws", channel: "ops" };
    },
    now: () => T0,
    skip: new Map<string, number>(),
  };
  expect(await writeIdleEpisodes(deps)).toBe(0);
  expect(deps.skip.size).toBe(EPISODE_MAX_PER_TICK);
  expect(await writeIdleEpisodes(deps)).toBe(2);
});

test("empty facts save nothing (no TTL refresh) and the thread is skipped until a new turn", async () => {
  const db = setup();
  turn(db, "u1", "c9", "chief-of-staff", "done", 1, 2, ""); // no title, no brief, no items
  const m = fakeLlm();
  const deps = { db, llm: m.llm, resolve, now: () => T0, skip: new Map<string, number>() };
  expect(await writeIdleEpisodes(deps)).toBe(0);
  expect(getThreadSummary(db, "c9")).toBeNull();
  expect(deps.skip.size).toBe(1);
  expect(m.calls).toHaveLength(0);
  expect(await writeIdleEpisodes(deps)).toBe(0);
});

test("an unmapped channel gets no episode and no model call", async () => {
  const db = setup();
  turn(db, "u1", "c8", "chief-of-staff", "done", 1, 2, "talk in an unmapped channel");
  turn(db, "u2", "th1", "chief-of-staff", "done", 1, 2, "mapped work");
  const m = fakeLlm();
  const deps = { db, llm: m.llm, resolve, now: () => T0, skip: new Map<string, number>() };
  expect(await writeIdleEpisodes(deps)).toBe(1); // only th1 (chan1)
  expect(getThreadSummary(db, "c8")).toBeNull();
  expect(m.calls).toHaveLength(1);
  expect(deps.skip.has("c8")).toBe(true);
});
