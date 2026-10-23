import type { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { WORKER_SLOT_NOTICE_MS } from "../src/config/run-caps";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { pendingNews } from "../src/orchestrator/teammate/teammate-events";
import type { TeammateRuntime } from "../src/orchestrator/teammate/teammate-runtime";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { dispatchReady } from "../src/orchestrator/worker/dispatch-ready";
import { clearSlotWait, noteDeferred } from "../src/orchestrator/worker/slot-wait";
import { CHIEF_OF_STAFF_ROLE } from "../src/roles/builtin/chief-of-staff-role";
import { openDb } from "../src/storage/db";
import { childrenOf } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { devTeammateQuery, until } from "./teammate-harness";

/* Slot wait: a ready item the full worker pool defers is shown to the teammate once after 60 s. */

let db: Database | undefined;
afterEach(() => {
  setSystemTime(); // back to the real clock
  db?.close();
  db = undefined;
});

test("noteDeferred: nothing before 60 s, ONE slot_wait event + one wake after it (also when repeated), news for the teammate", () => {
  db = openDb(":memory:");
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: "chief-of-staff",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id: "i",
    threadId: "th",
    ownerRole: "developer",
    status: "ready",
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "main",
  });
  const item = childrenOf(db, "g")[0]!;
  const woken: string[] = [];
  const rt = {
    deps: { db },
    announce: (t: string) => void woken.push(t),
  } as unknown as TeammateRuntime;
  const t0 = 5_000_000;
  noteDeferred(rt, "th", item, t0);
  noteDeferred(rt, "th", item, t0 + WORKER_SLOT_NOTICE_MS - 1);
  expect(pendingNews(db, "th")).toHaveLength(0);
  noteDeferred(rt, "th", item, t0 + WORKER_SLOT_NOTICE_MS);
  noteDeferred(rt, "th", item, t0 + WORKER_SLOT_NOTICE_MS + 3000); // the next 3 s pass repeats the call
  const news = pendingNews(db, "th");
  expect(news.map((e) => e.kind)).toEqual(["slot_wait"]);
  expect(news[0]).toMatchObject({
    itemId: "i",
    taskId: "g",
    payload: { key: "main", waitedSeconds: 60 },
  });
  expect(woken).toEqual(["th"]);
  // A started item forgets its wait: the next deferral counts from scratch.
  clearSlotWait("i");
  noteDeferred(rt, "th", { ...item, dispatchCount: 1 }, t0 + 10 * WORKER_SLOT_NOTICE_MS);
  expect(pendingNews(db, "th")).toHaveLength(1);
});

test("full worker pool: the item stays ready and the teammate hears one slot_wait after 60 s (clock shifted, real dispatch pass)", async () => {
  const env = makeEnv();
  db = env.db;
  const limiter = createRunLimiter(1);
  const hold = limiter.tryAcquire()!; // every worker slot is busy
  const queryFn = (() =>
    (async function* () {
      yield resultMsg();
    })()) as never;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: devTeammateQuery(queryFn),
    limiter,
    teammateTiming: { debounceMs: 5, announceWindowMs: 20 },
  });
  await handle({
    source: "test",
    language: "en" as const,
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "do it",
    notify: async () => {},
  });
  await until(
    () =>
      !!env.db
        .query("SELECT 1 FROM owned_tasks WHERE parent_id IS NOT NULL AND status = 'ready'")
        .get(),
  );
  setSystemTime(Date.now() + WORKER_SLOT_NOTICE_MS + 1000); // 60 s later; the 3 s retry pass reads this clock
  const count = () =>
    (
      env.db.query("SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'slot_wait'").get() as {
        n: number;
      }
    ).n;
  await until(() => count() === 1, 8000);
  await Bun.sleep(3500); // another retry pass: still one event
  expect(count()).toBe(1);
  expect(env.db.query("SELECT status FROM owned_tasks WHERE parent_id IS NOT NULL").get()).toEqual({
    status: "ready",
  });
  hold();
}, 20000);

test("two ready items deferred by a full pool in one pass both get a slot_wait after 60 s", async () => {
  db = openDb(":memory:");
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: CHIEF_OF_STAFF_ROLE.name,
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  for (const id of ["i1", "i2"])
    insertOwnedTask(db, {
      id,
      threadId: "th",
      ownerRole: "scout",
      status: "ready",
      scope: "s",
      correlationId: "c",
      parentId: "g",
      itemKey: id,
    });
  const rt = {
    deps: { db, stopping: () => false, limiter: createRunLimiter(1) },
    ctxOf: () => ({}),
    announce: () => {},
  } as unknown as TeammateRuntime;
  rt.deps.limiter!.tryAcquire(); // the only worker slot is busy
  await dispatchReady(rt, "th");
  expect(pendingNews(db, "th")).toHaveLength(0);
  setSystemTime(Date.now() + WORKER_SLOT_NOTICE_MS + 1000);
  await dispatchReady(rt, "th");
  expect(
    pendingNews(db, "th")
      .map((e) => e.itemId)
      .sort(),
  ).toEqual(["i1", "i2"]);
});
