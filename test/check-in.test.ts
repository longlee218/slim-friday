import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  DIGEST_FLOOR_MS,
  HOLD_ESCALATE_MS,
  HOLD_REESCALATE_MS,
  ITEM_MAX_AGE_MS,
  MAX_ESCALATIONS_PER_TICK,
} from "../src/config/resilience-caps";
import type { LeadRuntime } from "../src/orchestrator/lead/lead-runtime";
import { registerRun } from "../src/orchestrator/run/live-runs";
import { createCheckIn } from "../src/orchestrator/worker/check-in";
import { setProgress } from "../src/orchestrator/worker/run-activity";
import { openDb } from "../src/storage/db";
import { setResultKind } from "../src/storage/owned-item-store";
import { insertOwnedTask } from "../src/storage/owned-task-store";
import { appendEvent, listUndelivered } from "../src/storage/thread-event-store";

/* Check-in over a real db and a fake clock: digest floor, change-only, language, post failure, hold escalation, 0 LLM calls. */

const T0 = 1_000_000_000_000;
let db: Database;
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  db?.close();
});

/** Runtime fake: posts are collected (or rejected when `failPost`), announces counted, `queryFn` counts model calls. */
function rtOf(language: "vi" | "en" = "en") {
  const posts: string[] = [];
  const woken: string[] = [];
  const calls = { query: 0, failPost: false };
  const rt = {
    deps: {
      db,
      queryFn: () => {
        calls.query++;
      },
    },
    announce: (t: string) => void woken.push(t),
    ctxOf: (threadId: string) =>
      threadId === "th"
        ? {
            message: {
              text: "hi",
              language,
              notify: async (text: string) => {
                if (calls.failPost) throw new Error("archived");
                posts.push(text);
              },
            },
          }
        : undefined,
  } as unknown as LeadRuntime;
  return { rt, posts, woken, calls };
}

/** Goal `g` (scope = objective) with item `it`. */
function setup(status = "running", scope = "Ship the thing") {
  db = openDb(":memory:");
  insertOwnedTask(db, {
    id: "g",
    threadId: "th",
    ownerRole: "lead",
    status: "open",
    scope,
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id: "it",
    threadId: "th",
    ownerRole: "developer",
    status: status as never,
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "main",
  });
}
/** A check-in that saw the live work one floor before `T0`: the first sight of work never posts. */
async function primed(rt: Parameters<ReturnType<typeof createCheckIn>>[0]) {
  const tick = createCheckIn();
  await tick(rt, T0 - DIGEST_FLOOR_MS);
  return tick;
}

test("digest: first sight is silent, the tick after the floor posts, none inside the floor, none when unchanged, change after the floor posts", async () => {
  setup();
  const { rt, posts, calls } = rtOf();
  const tick = createCheckIn();
  await tick(rt, T0 - DIGEST_FLOOR_MS);
  expect(posts).toHaveLength(0); // right after the hand-off: no digest
  await tick(rt, T0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("Check-in: Ship the thing");
  expect(posts[0]).toContain("main: running");
  expect(posts[0]).not.toContain("developer");
  await tick(rt, T0 + 60_000);
  expect(posts).toHaveLength(1); // inside the floor
  await tick(rt, T0 + DIGEST_FLOOR_MS + 1);
  expect(posts).toHaveLength(1); // floor passed but nothing changed (ages do not count)
  // Facts change (a second item appears), but only after the floor does it post.
  insertOwnedTask(db, {
    id: "it2",
    threadId: "th",
    ownerRole: "tester",
    status: "ready",
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "qa",
  });
  await tick(rt, T0 + DIGEST_FLOOR_MS + 2);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toContain("qa: ready");
  expect(calls.query).toBe(0); // 0 LLM calls
});

test("digest: live progress shows percent and a redacted note; Vietnamese copy; no result content", async () => {
  setup();
  const stop = registerRun({
    kind: "worker",
    threadId: "th",
    role: "developer",
    ac: new AbortController(),
    taskId: "it",
    turnId: "tn",
  });
  cleanup.push(stop);
  setProgress(db, "it", { percent: 40, note: "key sk-ant-abcdefghijklmnop1234 used" }, T0);
  db.query("UPDATE owned_tasks SET result_excerpt = 'SECRET-EXCERPT' WHERE id = 'it'").run();
  const { rt, posts } = rtOf("vi");
  await (await primed(rt))(rt, T0 + 1000);
  expect(posts[0]).toContain("Cập nhật: Ship the thing");
  expect(posts[0]).toContain("running 40%");
  expect(posts[0]).not.toContain("sk-ant-abcdefghijklmnop1234");
  expect(posts[0]).not.toContain("SECRET-EXCERPT");
});

test("digest: held item is flagged; a failed post keeps state and retries after the floor", async () => {
  setup("blocked");
  setResultKind(db, "it", "FAILED");
  const { rt, posts, calls } = rtOf();
  const tick = await primed(rt);
  calls.failPost = true;
  await tick(rt, T0); // must not throw
  expect(posts).toHaveLength(0);
  calls.failPost = false;
  await tick(rt, T0 + 60_000);
  expect(posts).toHaveLength(0); // retry waits for the floor
  await tick(rt, T0 + DIGEST_FLOOR_MS + 1);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("waiting for your call");
});

test("digest: no live work (all items ended) posts nothing", async () => {
  setup("completed");
  const { rt, posts } = rtOf();
  await createCheckIn()(rt, T0);
  expect(posts).toHaveLength(0);
});

test("escalation: held item undecided for 30 min writes one timeout event and wakes once", async () => {
  setup("blocked");
  setResultKind(db, "it", "FAILED");
  db.query("UPDATE owned_tasks SET dispatch_count = 1 WHERE id = 'it'").run();
  appendEvent(db, {
    id: "failure:it:1",
    threadId: "th",
    taskId: "g",
    itemId: "it",
    kind: "failure",
    payload: {},
    createdAt: T0,
  });
  const { rt, woken, calls } = rtOf();
  const tick = createCheckIn();
  await tick(rt, T0 + HOLD_ESCALATE_MS - 1);
  expect(woken).toEqual([]);
  await tick(rt, T0 + HOLD_ESCALATE_MS);
  await tick(rt, T0 + HOLD_ESCALATE_MS + 60_000);
  expect(woken).toEqual(["th"]);
  const ev = listUndelivered(db, "th").filter((e) => e.kind === "timeout");
  expect(ev).toHaveLength(1);
  expect(ev[0]?.id).toBe(`hold:it:1:${T0 + HOLD_ESCALATE_MS}`); // one inside the repeat floor
  expect(ev[0]?.payload).toMatchObject({ key: "main", cause: "hold_undecided" });
  expect(calls.query).toBe(0);
});

test("escalation: a retry event after the hold, or a newer dispatch, is not escalated twice", async () => {
  setup("blocked");
  setResultKind(db, "it", "FAILED");
  appendEvent(db, {
    id: "f1",
    threadId: "th",
    itemId: "it",
    kind: "failure",
    payload: {},
    createdAt: T0,
  });
  appendEvent(db, {
    id: "r1",
    threadId: "th",
    itemId: "it",
    kind: "retry",
    payload: {},
    createdAt: T0 + 1,
  });
  const { rt, woken } = rtOf();
  await createCheckIn()(rt, T0 + 2 * HOLD_ESCALATE_MS);
  expect(woken).toEqual([]); // the lead already decided
});

/** Hold `it` (blocked + FAILED) with a failure event at `at`. */
function hold(id: string, at: number, dispatch = 1) {
  setResultKind(db, id, "FAILED");
  db.query("UPDATE owned_tasks SET status = 'blocked', dispatch_count = ? WHERE id = ?").run(
    dispatch,
    id,
  );
  appendEvent(db, {
    id: `failure:${id}:${dispatch}`,
    threadId: "th",
    itemId: id,
    kind: "failure",
    payload: {},
    createdAt: at,
  });
}
const timeouts = () => listUndelivered(db, "th").filter((e) => e.kind === "timeout");
const LATE = T0 + HOLD_ESCALATE_MS + 1;

test("digest: floor survives a tick with no live work (A done, B starts inside the floor: no digest; after it: digest)", async () => {
  setup();
  const { rt, posts } = rtOf();
  const tick = await primed(rt);
  await tick(rt, T0);
  expect(posts).toHaveLength(1);
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = 'it'").run();
  await tick(rt, T0 + 60_000); // no live work
  expect(posts).toHaveLength(1);
  insertOwnedTask(db, {
    id: "b",
    threadId: "th",
    ownerRole: "tester",
    status: "running",
    scope: "s",
    correlationId: "c",
    parentId: "g",
    itemKey: "qa",
  });
  await tick(rt, T0 + 120_000);
  expect(posts).toHaveLength(1); // changed facts, still inside the floor
  await tick(rt, T0 + DIGEST_FLOOR_MS + 1);
  expect(posts).toHaveLength(2);
});

test("digest: two open goals digest the newest; an old completed goal is ignored", async () => {
  setup(); // goal g (running item)
  insertOwnedTask(db, {
    id: "g2",
    threadId: "th",
    ownerRole: "lead",
    status: "open",
    scope: "Newer goal",
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id: "i2",
    threadId: "th",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
    parentId: "g2",
    itemKey: "x",
  });
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = 'g'").run(); // old goal done
  const { rt, posts } = rtOf();
  await (await primed(rt))(rt, T0);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain("Newer goal");
  expect(posts[0]).not.toContain("Ship the thing");
  db.query("UPDATE owned_tasks SET status = 'open' WHERE id = 'g'").run(); // both open now
  const again = rtOf();
  const posts2 = again.posts;
  await (await primed(again.rt))(again.rt, T0);
  expect(posts2[0]).toContain("Newer goal");
});

test("escalation: a cancel event suppresses; a retry OLDER than the hold does not", async () => {
  setup("blocked");
  hold("it", T0);
  appendEvent(db, {
    id: "r0",
    threadId: "th",
    itemId: "it",
    kind: "retry",
    payload: {},
    createdAt: T0 - 5,
  });
  const { rt, woken } = rtOf();
  await createCheckIn()(rt, LATE);
  expect(woken).toEqual(["th"]); // old retry does not count
  db.query("DELETE FROM thread_events WHERE kind = 'timeout'").run();
  appendEvent(db, {
    id: "c1",
    threadId: "th",
    itemId: "it",
    kind: "cancel",
    payload: {},
    createdAt: T0 + 5,
  });
  await createCheckIn()(rt, LATE + 1);
  expect(timeouts()).toHaveLength(0);
});

test("escalation: waiting_user and cancelled items never escalate", async () => {
  for (const status of ["waiting_user", "cancelled"]) {
    setup(status);
    hold("it", T0);
    db.query("UPDATE owned_tasks SET status = ? WHERE id = 'it'").run(status);
    const { rt, woken } = rtOf();
    await createCheckIn()(rt, LATE);
    expect(woken).toEqual([]);
    db.close();
  }
});

test("escalation: an item_age hold (failure event) escalates; a second dispatch gets a new id", async () => {
  setup("blocked");
  appendEvent(db, {
    id: "failure:it:1",
    threadId: "th",
    itemId: "it",
    kind: "failure",
    payload: { cause: "item_age" },
    createdAt: T0,
  });
  setResultKind(db, "it", "FAILED");
  db.query("UPDATE owned_tasks SET dispatch_count = 1 WHERE id = 'it'").run();
  const { rt, woken } = rtOf();
  const tick = createCheckIn();
  await tick(rt, LATE);
  expect(timeouts().map((e) => e.id)).toEqual([`hold:it:1:${LATE}`]);
  // Retried, dispatched again, failed again, held again.
  appendEvent(db, {
    id: "r1",
    threadId: "th",
    itemId: "it",
    kind: "retry",
    payload: {},
    createdAt: LATE + 1,
  });
  hold("it", LATE + 2, 2);
  await tick(rt, LATE + 2 + HOLD_ESCALATE_MS);
  expect(timeouts().map((e) => e.id)).toEqual([
    `hold:it:1:${LATE}`,
    `hold:it:2:${LATE + 2 + HOLD_ESCALATE_MS}`,
  ]);
  expect(woken).toEqual(["th", "th"]);
});

test("escalation: a closed goal never escalates", async () => {
  setup("blocked");
  hold("it", T0);
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = 'g'").run();
  const { rt, woken } = rtOf();
  await createCheckIn()(rt, LATE);
  expect(woken).toEqual([]);
});

test("escalation: exactly 3 events per tick (literal, not the constant), the rest on the next ticks, none twice", async () => {
  expect(MAX_ESCALATIONS_PER_TICK).toBe(3);
  setup("blocked");
  hold("it", T0);
  for (let n = 0; n < 7; n++) {
    insertOwnedTask(db, {
      id: `h${n}`,
      threadId: "th",
      ownerRole: "developer",
      status: "blocked",
      scope: "s",
      correlationId: "c",
      parentId: "g",
      itemKey: `k${n}`,
    });
    hold(`h${n}`, T0 + n + 1);
  }
  const { rt, woken } = rtOf(); // 8 eligible holds
  const tick = createCheckIn();
  await tick(rt, LATE + 10);
  expect(timeouts()).toHaveLength(3);
  await tick(rt, LATE + 20);
  expect(timeouts()).toHaveLength(6);
  await tick(rt, LATE + 30);
  expect(timeouts()).toHaveLength(8);
  await tick(rt, LATE + 40);
  expect(timeouts()).toHaveLength(8);
  expect(woken).toHaveLength(8);
});

test("digest: a closed goal that still has a running item gets no digest", async () => {
  setup();
  db.query("UPDATE owned_tasks SET status = 'completed' WHERE id = 'g'").run();
  const { rt, posts } = rtOf();
  await createCheckIn()(rt, T0);
  expect(posts).toHaveLength(0);
});

test("escalation: a hold older than 3 x item age is forgotten", async () => {
  setup("blocked");
  hold("it", T0);
  const { rt, woken } = rtOf();
  await createCheckIn()(rt, T0 + ITEM_MAX_AGE_MS * 3 + 1);
  expect(woken).toEqual([]);
});

test("digest-copy: ago rounds down and keys are clipped", async () => {
  const { renderDigest } = await import("../src/ingress/digest-copy");
  const t = renderDigest(
    {
      objective: "o",
      items: [{ key: "k", role: "r", status: "ready", held: false, ageSeconds: 3570 }],
      done: 0,
      total: 1,
      spentUsd: 0,
      budgetUsd: 15,
    },
    "en",
  );
  expect(t).toContain("59m");
  setup();
  db.query("UPDATE owned_tasks SET item_key = ? WHERE id = 'it'").run("k".repeat(100));
  const { rt, posts } = rtOf();
  await (await primed(rt))(rt, T0);
  expect(posts[0]).not.toContain("k".repeat(41));
});

test("E-H1: a plain blocked item (BLOCKED report, no failure) escalates like any held item", async () => {
  setup("blocked");
  db.query(
    "UPDATE owned_tasks SET result_kind = 'BLOCKED', last_progress_at = ? WHERE id = 'it'",
  ).run(T0);
  const { rt, woken } = rtOf();
  await createCheckIn()(rt, LATE);
  expect(woken).toEqual(["th"]);
  expect(timeouts()).toHaveLength(1);
});

test("E-L13: an undecided hold escalates again after the floor, not before", async () => {
  setup("blocked");
  hold("it", T0);
  const { rt, woken } = rtOf();
  const tick = createCheckIn();
  await tick(rt, LATE);
  await tick(rt, LATE + HOLD_REESCALATE_MS - 1_000);
  expect(timeouts()).toHaveLength(1);
  await tick(rt, LATE + HOLD_REESCALATE_MS + 1_000);
  expect(timeouts()).toHaveLength(2);
  expect(woken).toEqual(["th", "th"]);
});
