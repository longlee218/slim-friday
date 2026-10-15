import { expect, test } from "bun:test";
import type { Location } from "../src/locations/location-registry";
import { runDispatchedTask } from "../src/orchestrator/dispatch/run-dispatched-task";
import type { DispatchDeps } from "../src/orchestrator/engine/role-run-types";
import { liveTasksOf } from "../src/orchestrator/engine/task-runs";
import { listUndelivered } from "../src/orchestrator/events/event-store";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { insertTurn } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { BRIEF, makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { sleep, until } from "./lead-harness";

/* Detached dispatch: the call returns at once, the run goes on without holding the thread and ends cleanly. */

function setup() {
  const env = makeEnv();
  return { env, locations: loadWorkspaces(env.home).workspaces[0]!.locations };
}

let seq = 0;
/** Detached `runDispatchedTask` over a fake query: the turn row exists (as the dispatcher leaves it), then the run starts. */
function start(
  env: ReturnType<typeof makeEnv>,
  locations: Location[],
  deps: Partial<DispatchDeps> & { queryFn: unknown },
  over: { threadId: string; notify?: (t: string) => Promise<void> },
) {
  const turnId = `dd-turn-${++seq}`;
  insertTurn(env.db, {
    id: turnId,
    threadId: over.threadId,
    source: "t",
    location: locations[0]!.name,
    role: "developer",
    brief: BRIEF,
  });
  const message = { ...base, threadId: over.threadId, notify: over.notify };
  return runDispatchedTask(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      stopping: () => false,
      ...deps,
    } as DispatchDeps,
    {
      input: {
        turnId,
        threadId: over.threadId,
        text: BRIEF,
        role: "developer",
        workspace: "main",
        locations,
        ac: new AbortController(),
      },
      message,
      location: locations[0]!.name,
      locations,
      t0: Date.now(),
      head: "source answer",
      posted: false,
      detach: true,
    },
  );
}

const base = {
  source: "t",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "dd-th",
  text: "x",
};

const okQuery = ((_: unknown) =>
  (async function* () {
    yield resultMsg();
  })()) as never;

test("detach: returns the head at once, the run is registered while it works, its result is posted, slot + registry freed", async () => {
  const { env, locations } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const limiter = createRunLimiter(5);
  const posted: string[] = [];
  const reply = await start(
    env,
    locations,
    {
      queryFn: ((_: unknown) =>
        (async function* () {
          await gate;
          yield resultMsg();
        })()) as never,
      limiter,
    },
    { threadId: "dd-th", notify: async (t) => void posted.push(t) },
  );
  expect(reply).toBe("source answer"); // the head, returned at once
  expect(liveTasksOf("dd-th")).toHaveLength(1); // running, thread lock not needed
  expect(limiter.active()).toBe(1); // its own slot
  release();
  await until(() => limiter.active() === 0);
  expect(liveTasksOf("dd-th")).toHaveLength(0);
  expect(posted).toHaveLength(1); // the final result arrived via notify
  expect(env.db.query("SELECT status FROM turns").all()).toEqual([{ status: "done" }]);
});

test("M2: a notify error after a completed run is logged only: no `failure` event; slot and registry freed", async () => {
  const { env, locations } = setup();
  const limiter = createRunLimiter(5);
  await start(
    env,
    locations,
    { queryFn: okQuery, limiter },
    {
      threadId: "dd-th2",
      notify: async () => {
        throw new Error("discord down"); // the final result cannot be posted
      },
    },
  );
  await until(() => limiter.active() === 0);
  expect(listUndelivered(env.db, "dd-th2")).toEqual([]);
  expect(liveTasksOf("dd-th2")).toHaveLength(0);
});

/** Detached run whose close step throws (`stopping` throws), optionally with the event table gone. */
async function crashedRun(threadId: string, dropEvents: boolean) {
  const { env, locations } = setup();
  const limiter = createRunLimiter(5);
  if (dropEvents) env.db.run("DROP TABLE thread_events");
  await start(
    env,
    locations,
    {
      queryFn: okQuery,
      stopping: () => {
        throw new Error("close step crashed");
      },
      limiter,
    },
    { threadId, notify: async () => {} },
  );
  await until(() => limiter.active() === 0);
  return { env, limiter };
}

test("a crash of the detached run appends a `failure` event and frees the slot", async () => {
  const { env, limiter } = await crashedRun("dd-th4", false);
  expect(listUndelivered(env.db, "dd-th4").map((e) => e.kind)).toEqual(["failure"]);
  expect(liveTasksOf("dd-th4")).toHaveLength(0);
  expect(limiter.active()).toBe(0);
});

test("M1: when the failure event cannot be appended either, nothing rejects unhandled and the slot is freed", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  const { limiter } = await crashedRun("dd-th5", true);
  await sleep(50);
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  expect(liveTasksOf("dd-th5")).toHaveLength(0);
  expect(limiter.active()).toBe(0);
});

test("detach with a full limiter: refused with the busy notice, the turn is closed, nothing runs", async () => {
  const { env, locations } = setup();
  const limiter = createRunLimiter(1);
  limiter.tryAcquire();
  const runs: unknown[] = [];
  const reply = await start(
    env,
    locations,
    {
      queryFn: ((a: unknown) => {
        runs.push(a);
        return (async function* () {})();
      }) as never,
      limiter,
    },
    { threadId: "dd-th3" },
  );
  expect(reply).toMatch(/handling other work|đang xử lý việc khác/);
  expect(runs).toEqual([]);
  expect(env.db.query("SELECT status FROM turns").all()).toEqual([{ status: "failed" }]);
});
