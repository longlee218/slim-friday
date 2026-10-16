import { expect, test } from "bun:test";
import type { Location } from "../src/locations/location-registry";
import type { DispatchDeps } from "../src/orchestrator/engine/role-run-types";
import { liveTasksOf } from "../src/orchestrator/engine/task-runs";
import { runDetached } from "../src/orchestrator/engine/worker-detached-run";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { insertTurn } from "../src/storage/run-store";
import { listUndelivered } from "../src/storage/thread-event-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { BRIEF, makeEnv, resultMsg, stubGateway } from "./helpers";
import { sleep, until } from "./lead-harness";

/* Detached worker run: it goes on without holding the thread, ends cleanly and frees its slot and registry entry. */

function setup() {
  const env = makeEnv();
  return { env, locations: loadWorkspaces(env.home).workspaces[0]!.locations };
}

let seq = 0;
/** `runDetached` over a fake query: the turn row exists (as `startWorker` leaves it), the slot is taken, then the run starts. */
function start(
  env: ReturnType<typeof makeEnv>,
  locations: Location[],
  deps: Partial<DispatchDeps> & { queryFn: unknown },
  threadId: string,
  limiter = createRunLimiter(5),
) {
  const turnId = `dd-turn-${++seq}`;
  insertTurn(env.db, {
    id: turnId,
    threadId,
    source: "t",
    location: locations[0]!.name,
    role: "developer",
    brief: BRIEF,
  });
  runDetached(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      stopping: () => false,
      ...deps,
    } as DispatchDeps,
    {
      turnId,
      threadId,
      text: BRIEF,
      role: "developer",
      workspace: "main",
      locations,
      ac: new AbortController(),
    },
    {
      language: "en",
      taskId: turnId,
      location: locations[0]!.name,
      locations,
      slot: limiter.tryAcquire() as () => void,
      resultKind: () => undefined,
      onSettled: () => {},
    },
  );
  return limiter;
}

const okQuery = ((_: unknown) =>
  (async function* () {
    yield resultMsg();
  })()) as never;

test("detach: returns at once, the run is registered while it works, slot + registry freed at the end", async () => {
  const { env, locations } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const limiter = start(
    env,
    locations,
    {
      queryFn: ((_: unknown) =>
        (async function* () {
          await gate;
          yield resultMsg();
        })()) as never,
    },
    "dd-th",
  );
  expect(liveTasksOf("dd-th")).toHaveLength(1); // running, thread lock not needed
  expect(limiter.active()).toBe(1); // its own slot
  release();
  await until(() => limiter.active() === 0);
  expect(liveTasksOf("dd-th")).toHaveLength(0);
  expect(env.db.query("SELECT status FROM turns").all()).toEqual([{ status: "done" }]);
});

/** Detached run whose close step throws (`stopping` throws), optionally with the event table gone. */
async function crashedRun(threadId: string, dropEvents: boolean) {
  const { env, locations } = setup();
  if (dropEvents) env.db.run("DROP TABLE thread_events");
  const limiter = start(
    env,
    locations,
    {
      queryFn: okQuery,
      stopping: () => {
        throw new Error("close step crashed");
      },
    },
    threadId,
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
