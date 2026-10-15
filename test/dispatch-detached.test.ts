import { expect, test } from "bun:test";
import { dispatchRole } from "../src/orchestrator/dispatch/dispatch-role";
import { liveTasksOf } from "../src/orchestrator/engine/task-runs";
import { listUndelivered } from "../src/orchestrator/events/event-store";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { g, makeLocation } from "./git-fixture";
import {
  addLocation,
  BRIEF,
  clearWorkspaces,
  defaultLocationPath,
  makeEnv,
  resultMsg,
  stubGateway,
  TEST_CHANNEL,
} from "./helpers";

/* Detached dispatch: the call returns at once, the run goes on without holding the thread and ends cleanly. */

async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeLocation("main");
  const clone = defaultLocationPath(env.home, "real", "main");
  addLocation(env.home, "real", { gitAuthor: "T <t@example.com>" }, { path: clone });
  await g(env.home, "clone", "-q", src.location, clone);
  return { env, locations: loadWorkspaces(env.home).workspaces[0]!.locations };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = {
  source: "t",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId: "dd-th",
  text: "x",
};

test("detach: returns the head at once, the run is registered while it works, its result is posted, slot + registry freed", async () => {
  const { env, locations } = await setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const limiter = createRunLimiter(5);
  const posted: string[] = [];
  const deps = {
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: ((_: unknown) =>
      (async function* () {
        await gate;
        yield resultMsg();
      })()) as never,
    stopping: () => false,
    limiter,
  };
  const reply = await dispatchRole(deps, {
    request: { role: "dev", brief: BRIEF },
    message: { ...base, notify: async (t: string) => void posted.push(t) },
    reply: "source answer",
    workspace: "main",
    locations,
    ac: new AbortController(),
    detach: true,
  });
  expect(reply).toBe(""); // head was posted through notify
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("source answer");
  expect(liveTasksOf("dd-th")).toHaveLength(1); // running, thread lock not needed
  expect(limiter.active()).toBe(1); // its own slot
  release();
  await sleep(200);
  expect(liveTasksOf("dd-th")).toHaveLength(0);
  expect(limiter.active()).toBe(0);
  expect(posted).toHaveLength(2); // the final result arrived via notify
  expect(env.db.query("SELECT status FROM turns").all()).toEqual([{ status: "done" }]);
});

test("M2: a notify error after a completed run is logged only: no `failure` event; slot and registry freed", async () => {
  const { env, locations } = await setup();
  const limiter = createRunLimiter(5);
  let calls = 0;
  const deps = {
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    queryFn: ((_: unknown) =>
      (async function* () {
        yield resultMsg();
      })()) as never,
    stopping: () => false,
    limiter,
  };
  await dispatchRole(deps, {
    request: { role: "dev", brief: BRIEF },
    message: {
      ...base,
      threadId: "dd-th2",
      notify: async () => {
        if (++calls > 1) throw new Error("discord down"); // the head posts, the final result cannot
      },
    },
    reply: "",
    workspace: "main",
    locations,
    ac: new AbortController(),
    detach: true,
  });
  await sleep(300);
  expect(listUndelivered(env.db, "dd-th2")).toEqual([]);
  expect(liveTasksOf("dd-th2")).toHaveLength(0);
  expect(limiter.active()).toBe(0);
});

/** Detached dispatch whose close step throws (`stopping` throws), optionally with the event table gone. */
async function crashedRun(threadId: string, dropEvents: boolean) {
  const { env, locations } = await setup();
  const limiter = createRunLimiter(5);
  if (dropEvents) env.db.run("DROP TABLE thread_events");
  await dispatchRole(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: ((_: unknown) =>
        (async function* () {
          yield resultMsg();
        })()) as never,
      stopping: () => {
        throw new Error("close step crashed");
      },
      limiter,
    },
    {
      request: { role: "dev", brief: BRIEF },
      message: { ...base, threadId, notify: async () => {} },
      reply: "",
      workspace: "main",
      locations,
      ac: new AbortController(),
      detach: true,
    },
  );
  await sleep(300);
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
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
  expect(liveTasksOf("dd-th5")).toHaveLength(0);
  expect(limiter.active()).toBe(0);
});

test("detach with a full limiter: refused with the busy notice, the turn is closed, nothing runs", async () => {
  const { env, locations } = await setup();
  const limiter = createRunLimiter(1);
  limiter.tryAcquire();
  const runs: unknown[] = [];
  const reply = await dispatchRole(
    {
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: ((a: unknown) => {
        runs.push(a);
        return (async function* () {})();
      }) as never,
      stopping: () => false,
      limiter,
    },
    {
      request: { role: "dev", brief: BRIEF },
      message: { ...base, threadId: "dd-th3" },
      reply: "",
      workspace: "main",
      locations,
      ac: new AbortController(),
      detach: true,
    },
  );
  expect(reply).toMatch(/handling other work|đang xử lý việc khác/);
  expect(runs).toEqual([]);
  expect(env.db.query("SELECT status FROM turns").all()).toEqual([{ status: "failed" }]);
});
