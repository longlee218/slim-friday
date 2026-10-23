import { afterEach, expect, test } from "bun:test";
import type { Location } from "../src/locations/location-registry";
import { appendCrashEvent, recoverCrashedRun } from "../src/orchestrator/run/detached-crash";
import { liveRunsOf, registerRun } from "../src/orchestrator/run/live-runs";
import type { DispatchDeps } from "../src/orchestrator/run/role-run-types";
import { runDetached } from "../src/orchestrator/run/run-turn";
import { clearZombieClaims, zombieClaims } from "../src/orchestrator/run/zombie-claims";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { reapAborted } from "../src/orchestrator/worker/abort-reaper";
import {
  type FailureVerdict,
  workerFailurePolicy,
} from "../src/orchestrator/worker/failure-policy";
import { createQuestionRelay } from "../src/orchestrator/worker/question-relay";
import { emitEndEvent } from "../src/orchestrator/worker/worker-end-event";
import type { ResultKind } from "../src/storage/owned-item-store";
import { getItem } from "../src/storage/owned-item-store";
import { insertOwnedTask, linkTurn } from "../src/storage/owned-task-store";
import { insertTurn, turnStatusOf } from "../src/storage/run-store";
import { lastMessageOf } from "../src/storage/task-message-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { BRIEF, makeEnv, resultMsg, stubGateway } from "./helpers";
import { sleep, until } from "./lead-harness";

/* Group C: crash paths of a detached goal-item run (E-M4, E-M5, E-M7), the question relay (E-M6), the cancel race (E-L12). */

let seq = 0;

// `reapAborted` also force-closes aborted writer runs left by other test files: their claims must not outlive this file.
afterEach(clearZombieClaims);
const okQuery = ((_: unknown) =>
  (async function* () {
    yield resultMsg();
  })()) as never;

/** A goal `g` with one running item `it` (key `main`), its turn linked, then `runDetached` wired like `startWorker`. */
function startItem(o: {
  queryFn?: unknown;
  stopping?: () => boolean;
  throwOnCwd?: string;
  report?: ResultKind;
  attempt?: number;
  /** Run as a writer role (a force-close keeps its location claimed). */
  writer?: boolean;
  /** Give the run an artifact scope (its result file is stored under the agent home). */
  scope?: boolean;
}) {
  const env = makeEnv();
  const locations: Location[] = loadWorkspaces(env.home).workspaces[0]!.locations;
  const { db } = env;
  const id = `it${++seq}`;
  const threadId = `crash-th${seq}`;
  const turnId = `tn${seq}`;
  insertOwnedTask(db, {
    id: `g${seq}`,
    threadId,
    ownerRole: "lead",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id,
    threadId,
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
    parentId: `g${seq}`,
    itemKey: "main",
  });
  db.query("UPDATE owned_tasks SET attempt = ? WHERE id = ?").run(o.attempt ?? 0, id);
  insertTurn(db, {
    id: turnId,
    threadId,
    source: "t",
    location: locations[0]!.name,
    role: "developer",
    brief: BRIEF,
  });
  linkTurn(db, turnId, id);
  const verdict: { current?: FailureVerdict } = {};
  const stopping = o.stopping ?? (() => false);
  const resultKind = () => o.report;
  const limiter = createRunLimiter(5);
  const ac = new AbortController();
  runDetached(
    {
      db,
      config: env.config,
      approvals: stubGateway(),
      stopping,
      queryFn: o.queryFn ?? okQuery,
    } as DispatchDeps,
    {
      turnId,
      threadId,
      text: BRIEF,
      role: "developer",
      workspace: "main",
      locations,
      ac,
      ...(o.throwOnCwd && {
        onCwd: () => {
          throw new Error(o.throwOnCwd);
        },
      }),
    },
    {
      language: "en",
      taskId: id,
      location: locations[0]!.name,
      slot: limiter.tryAcquire() as () => void,
      ...(o.writer && { writer: true }),
      ...(o.scope && { artifactScope: { workspace: "main" } }),
      resultKind,
      failurePolicy: workerFailurePolicy({ db, itemId: id, turnId, resultKind, stopping, verdict }),
      // Same as startWorker's onSettled: the end event of the settled item.
      onSettled: (crash) =>
        emitEndEvent(
          db,
          threadId,
          id,
          turnId,
          o.report && ({ status: o.report, summary: "s", requests: [] } as never),
          verdict.current,
          crash,
        ),
    },
  );
  return { env, db, id, threadId, turnId, limiter, ac, location: locations[0]!.name };
}

/** Force-close this thread's live run only (the reaper itself sweeps the whole process-wide registry). */
const forceCloseOf = (threadId: string) => {
  for (const h of liveRunsOf(threadId)) h.forceClose?.();
};

const events = (db: ReturnType<typeof makeEnv>["db"], threadId: string) =>
  listUndelivered(db, threadId);

test("E-M4: a crash of the close step holds the item with one `failure` event and closes the turn row", async () => {
  let calls = 0;
  const r = startItem({
    stopping: () => {
      if (++calls === 1) throw new Error("close step crashed"); // the close step's call; the policy's later one works
      return false;
    },
  });
  await until(() => r.limiter.active() === 0);
  const it = getItem(r.db, r.id)!;
  expect(it.status).toBe("blocked");
  expect(it.resultKind).toBe("FAILED");
  expect(turnStatusOf(r.db, r.turnId)).not.toBe("running");
  const ev = events(r.db, r.threadId);
  expect(ev.map((e) => e.kind)).toEqual(["failure"]);
  expect((ev[0]!.payload as Record<string, unknown>).key).toBe("main");
  expect(String((ev[0]!.payload as Record<string, unknown>).error)).toContain("close step crashed");
});

test("E-M5: a thrown transient error resumes the item (no terminal failure, no event)", async () => {
  const r = startItem({ throwOnCwd: "read ECONNRESET" });
  await until(() => r.limiter.active() === 0);
  expect(getItem(r.db, r.id)!.status).toBe("ready");
  expect(getItem(r.db, r.id)!.attempt).toBe(1);
  expect(events(r.db, r.threadId)).toEqual([]);
});

test("E-M5: a thrown real error holds the item; the one failure event carries key and error (no id clash)", async () => {
  const r = startItem({ throwOnCwd: "boom" });
  await until(() => r.limiter.active() === 0);
  expect(getItem(r.db, r.id)!.status).toBe("blocked");
  const ev = events(r.db, r.threadId);
  expect(ev.map((e) => e.kind)).toEqual(["failure"]);
  expect(ev[0]).toMatchObject({ itemId: r.id, payload: { key: "main", class: "real" } });
  expect(String((ev[0]!.payload as Record<string, unknown>).error)).toContain("boom");
});

test("E-M5: a thrown run keeps the COMPLETED report it stored", async () => {
  const r = startItem({ throwOnCwd: "boom", report: "COMPLETED" });
  await until(() => r.limiter.active() === 0);
  expect(getItem(r.db, r.id)!.status).toBe("completed");
  expect(events(r.db, r.threadId).map((e) => e.kind)).toEqual(["result"]);
});

test("E-M7: an aborted run that never exits is force-closed after the grace: item held, slot and entry freed", async () => {
  const r = startItem({
    queryFn: ((_: unknown) =>
      (async function* () {
        await new Promise(() => {}); // ignores the abort
        yield resultMsg();
      })()) as never,
  });
  expect(liveRunsOf(r.threadId)).toHaveLength(1);
  r.ac.abort();
  const t0 = Date.now();
  // The live-run registry is process-wide: other test files may leave aborted runs in it, so look at this thread only.
  const mine = (at: number) => reapAborted(at, 1000).filter((x) => x.threadId === r.threadId);
  expect(mine(t0)).toEqual([]); // first sight: the grace starts
  expect(mine(t0 + 500)).toEqual([]);
  expect(mine(t0 + 1500)).toHaveLength(1);
  await until(() => r.limiter.active() === 0);
  expect(liveRunsOf(r.threadId)).toHaveLength(0);
  expect(getItem(r.db, r.id)!.status).toBe("blocked");
  expect(events(r.db, r.threadId).map((e) => e.kind)).toEqual(["failure"]);
  expect(mine(t0 + 9000)).toEqual([]);
});

test("E-L12: emitEndEvent announces a cancelled-but-COMPLETED result, a plain cancel stays silent", () => {
  // The real race (lead cancel and /stop against a report) is in phase1-review-fixes.test.ts; this is the event rule.
  const r = startItem({});
  return until(() => r.limiter.active() === 0).then(() => {
    r.db.query("DELETE FROM thread_events").run();
    r.db.query("UPDATE owned_tasks SET status = 'cancelled' WHERE id = ?").run(r.id);
    const report = { status: "COMPLETED", summary: "pushed", requests: [] } as never;
    emitEndEvent(r.db, r.threadId, r.id, "tn-late", report);
    const ev = events(r.db, r.threadId);
    expect(ev.map((e) => e.kind)).toEqual(["result"]);
    expect(ev[0]!.payload).toMatchObject({ status: "cancelled", summary: "pushed" });
    emitEndEvent(r.db, r.threadId, r.id, "tn-plain");
    expect(events(r.db, r.threadId)).toHaveLength(1);
  });
});

test("F2: the crash path never throws when the db errors", () => {
  const brokenDb = {
    query: () => {
      throw new Error("SQLITE_BUSY");
    },
  } as never;
  const run = { threadId: "t", turnId: "x", taskId: "y", resultKind: () => undefined };
  expect(recoverCrashedRun(brokenDb, run, new Error("boom"))).toBe(false);
  expect(() => appendCrashEvent(brokenDb, run, new Error("boom"))).not.toThrow();
});

test("F4: a force-closed writer run keeps its location claimed until the run really returns", async () => {
  let wake!: () => void;
  const gate = new Promise<void>((r) => {
    wake = r;
  });
  const r = startItem({
    writer: true,
    queryFn: ((_: unknown) =>
      (async function* () {
        await gate; // ignores the abort until released
        yield resultMsg();
      })()) as never,
  });
  r.ac.abort();
  forceCloseOf(r.threadId); // what the reaper does after the grace
  await until(() => r.limiter.active() === 0); // slot freed at once
  expect(getItem(r.db, r.id)!.status).toBe("blocked");
  expect(zombieClaims(r.location)).toBe(true); // ... the location is not
  wake(); // the old run returns at last
  await until(() => !zombieClaims(r.location));
});

test("F4: a force-closed read-only run frees at once (no claim)", async () => {
  const r = startItem({
    queryFn: ((_: unknown) =>
      (async function* () {
        await new Promise(() => {});
        yield resultMsg();
      })()) as never,
  });
  r.ac.abort();
  forceCloseOf(r.threadId);
  await until(() => r.limiter.active() === 0);
  expect(zombieClaims(r.location)).toBe(false);
});

test("F6: a thrown run that stored COMPLETED keeps its status; an empty reply leaves no result message", async () => {
  const r = startItem({ throwOnCwd: "boom", report: "COMPLETED", scope: true });
  await until(() => r.limiter.active() === 0);
  const it = getItem(r.db, r.id)!;
  expect(it.status).toBe("completed");
  expect(lastMessageOf(r.db, r.id, "result")).toBeUndefined();
});

test("E-M6: a stale waiter of an aborted run cannot clear the next run's wait or lower its count", async () => {
  const { db } = makeEnv();
  const relay = createQuestionRelay(db, () => {}, 200);
  const q = [
    {
      question: "which?",
      header: "h",
      options: [{ label: "a", description: "" }],
      multiSelect: false,
    },
  ];
  const ask = (turnId: string) =>
    relay.forWorker({ threadId: "t", goalId: "g", itemId: "item", turnId, role: "developer" })(
      q as never,
    );
  // Run 1 asks, then is replaced by run 2 of the same item (a retry) which asks too.
  const settle1 = registerRun({
    kind: "worker",
    threadId: "t",
    role: "developer",
    ac: new AbortController(),
    taskId: "item",
    turnId: "w1",
  });
  const first = ask("w1");
  settle1();
  await sleep(100); // run 2's timer fires 100 ms after run 1's: the order never depends on load
  const run2 = { ac: new AbortController() };
  registerRun({
    kind: "worker",
    threadId: "t",
    role: "developer",
    ac: run2.ac,
    taskId: "item",
    turnId: "w2",
  });
  const second = ask("w2");
  expect(liveRunsOf("t")[0]!.waitingCount).toBe(1);
  await first; // run 1's timer fires first (same wait, earlier start)
  expect(liveRunsOf("t")[0]!.waitingCount).toBe(1); // run 2 still waits
  expect(relay.answer("item", "a")).toBe(true); // and can still be answered
  expect(await second).toEqual({ "which?": "a" });
});

test("E-M6: release(turn) ends the wait of an ended run: a late answer finds nobody", async () => {
  const { db } = makeEnv();
  const relay = createQuestionRelay(db, () => {}, 60_000);
  const q = [{ question: "which?", header: "h", options: [], multiSelect: false }];
  const p = relay.forWorker({
    threadId: "t",
    goalId: "g",
    itemId: "item2",
    turnId: "w9",
    role: "developer",
  })(q as never);
  relay.release("w9");
  expect(await p).toBeUndefined();
  expect(relay.answer("item2", "x")).toBe(false);
});

test("a crash after a report with files keeps the files on a result message", () => {
  const env = makeEnv();
  const { db } = env;
  insertOwnedTask(db, {
    id: "cg",
    threadId: "cth",
    ownerRole: "lead",
    status: "open",
    scope: "g",
    correlationId: "c",
  });
  insertOwnedTask(db, {
    id: "cit",
    threadId: "cth",
    ownerRole: "developer",
    status: "running",
    scope: "s",
    correlationId: "c",
    parentId: "cg",
    itemKey: "main",
  });
  insertTurn(db, {
    id: "ctn",
    threadId: "cth",
    source: "t",
    location: "x",
    role: "developer",
    brief: BRIEF,
  });
  linkTurn(db, "ctn", "cit");
  const files = [{ title: "Doc", base: "scratch" as const, path: "/h/task-files/g/i/t/1-doc.md" }];
  recoverCrashedRun(
    db,
    {
      threadId: "cth",
      turnId: "ctn",
      taskId: "cit",
      resultKind: () => "COMPLETED",
      resultTitle: () => "Done",
      resultFiles: () => files,
    },
    new Error("boom"),
  );
  const msg = lastMessageOf(db, "cit", "result");
  expect(msg).toBeDefined();
  expect(JSON.parse(msg!.files!)).toEqual(files);
});
