import { expect, test } from "bun:test";
import { collectLimits } from "../src/config/limits-report";
import { LIMIT_GROUPS, type LiveState, renderLimits } from "../src/ingress/limits-copy";
import { ROLES } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { runningItemsByThread } from "../src/storage/running-items-store";

const LIVE: LiveState = {
  teammateUsed: 2,
  teammateWaiting: 1,
  workerUsed: 7,
  readyWaiting: 3,
  running: [{ threadId: "T-9", count: 4 }],
};

test("every collected non-role key is in the text; every role has its line", async () => {
  const limits = await collectLimits();
  const text = renderLimits(limits, { live: LIVE, language: "en" }).text;
  for (const k of limits.keys()) if (!k.startsWith("role.")) expect(text, k).toContain(`${k}:`);
  for (const name of Object.keys(ROLES)) expect(text, name).toContain(`- ${name} (`);
});

test("section groups name only constants that exist (a rename must not hide a limit)", async () => {
  const limits = await collectLimits();
  for (const n of Object.values(LIMIT_GROUPS).flat()) expect(limits.has(n), n).toBe(true);
});

test("a changed value shows without a code edit (pure formatter over the map)", async () => {
  const limits = new Map(await collectLimits());
  limits.set("WORKER_POOL_MAX", 77);
  limits.set("ITEM_MAX_AGE_MS", 3 * 3_600_000);
  limits.set("role.developer.maxTurns", 999);
  limits.set("NEW_LIMIT_MS", 90_000); // a limit no section knows still shows
  const text = renderLimits(limits, { live: LIVE, language: "en" }).text;
  expect(text).toContain("WORKER_POOL_MAX: 77");
  expect(text).toContain("ITEM_MAX_AGE_MS: 3h");
  expect(text).toContain("maxTurns 999");
  expect(text).toContain("NEW_LIMIT_MS: 1.5min");
});

test("live state and language", async () => {
  const limits = await collectLimits();
  const en = renderLimits(limits, { live: LIVE, language: "en" }).text;
  expect(en).toContain(`Worker slots: 7/${limits.get("WORKER_POOL_MAX")} in use`);
  expect(en).toContain("Items ready and waiting for a slot: 3");
  expect(en).toContain(
    `Teammate pool: 2/${limits.get("TEAMMATE_POOL_MAX")} in use, 1 threads waiting`,
  );
  expect(en).toContain("<#T-9>: 4 running");
  const vi = renderLimits(limits, { live: LIVE, language: "vi" }).text;
  expect(vi).toContain("Việc đã sẵn sàng nhưng đang chờ slot: 3");
});

test("role filter shows one role only; unknown role says so", async () => {
  const limits = await collectLimits();
  const one = renderLimits(limits, { role: "developer", live: LIVE, language: "en" }).text;
  expect(one).toContain("- developer (");
  expect(one).not.toContain("- teammate (");
  expect(one).not.toContain("WORKER_POOL_MAX");
  expect(one).toContain("subagents on (parallel");
  expect(renderLimits(limits, { role: "nope", live: LIVE, language: "en" }).text).toBe(
    "I don't know a role called nope.",
  );
});

test("running items per thread counts only running goal items", () => {
  const db = openDb(":memory:");
  const ins = db.query(
    `INSERT INTO owned_tasks (id, thread_id, parent_id, item_key, status, correlation_id, created_at, last_progress_at)
     VALUES (?, ?, ?, ?, ?, 'c', 0, 0)`,
  );
  ins.run("g1", "T1", null, null, "running"); // a goal, not an item
  ins.run("i1", "T1", "g1", "i1", "running");
  ins.run("i2", "T1", "g1", "i2", "running");
  ins.run("i3", "T1", "g1", "i3", "ready");
  ins.run("i4", "T2", "g1", "i4", "running");
  expect(runningItemsByThread(db)).toEqual([
    { threadId: "T1", count: 2 },
    { threadId: "T2", count: 1 },
  ]);
});

test("live thread list is capped at 10 rows with +N more; head holds pools and live state only", async () => {
  const limits = await collectLimits();
  const running = Array.from({ length: 13 }, (_, n) => ({ threadId: `T${n}`, count: 1 }));
  const r = renderLimits(limits, { live: { ...LIVE, running }, language: "en" });
  expect(r.text.match(/<#T\d+>/g)).toHaveLength(10);
  expect(r.text).toContain("and 3 more threads");
  expect(r.head).toContain("**Pools**");
  expect(r.head).toContain("**Right now**");
  expect(r.head).not.toContain("**Roles**");
  expect(r.head.length).toBeLessThan(1900);
  expect(r.text.length).toBeGreaterThan(r.head.length);
});
