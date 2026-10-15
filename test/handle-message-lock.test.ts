import { expect, test } from "bun:test";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { makeEnv, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";
import { noticeSink, until, workersDone } from "./lead-harness";

/** A `[dev]` message: starts a detached dev worker (the handler returns the start notice, never the worker's text). */
const task = (text: string, threadId = "th1") => ({
  source: "test",
  language: "en" as const,
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId,
  text,
});
const dev = (brief: string, threadId = "th1") => task(`[dev] ${brief}`, threadId);

/** Handler over a fake query; workers run detached, so tests wait with `workersDone`. */
const devHandler = (env: ReturnType<typeof makeEnv>, queryFn: unknown) =>
  createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway(),
    limiter: createRunLimiter(10),
    queryFn: queryFn as never,
  });
const turnStatus = (env: ReturnType<typeof makeEnv>) =>
  env.db.query<{ status: string }, []>("SELECT status FROM turns WHERE role = 'developer'").get()
    ?.status;

/** Query that waits until aborted (or released), simulating a long run. */
function slowQuery(release: { fn?: () => void; ready?: () => void }) {
  return (a: any) =>
    (async function* () {
      await new Promise<void>((res, rej) => {
        release.fn = res;
        a.options.abortController.signal.addEventListener("abort", () =>
          rej(new Error("process aborted")),
        );
        release.ready?.(); // Signal ready once listener is set up
      });
      yield resultMsg({ result: `done secret ghp_${"a".repeat(36)}` });
    })();
}

test("stop aborts the worker run and marks its task cancelled", async () => {
  const env = makeEnv();
  const release: { fn?: () => void; ready?: () => void } = {};
  const ready = new Promise<void>((r) => (release.ready = r));
  const handle = devHandler(env, slowQuery(release));
  const sink = noticeSink();
  expect(await handle({ ...dev("hi"), notify: sink.notify })).toBeUndefined();
  expect(await sink.first()).toBe("I’m starting on your request.");
  await ready; // the worker's query is waiting on its abort signal
  expect(await handle(task("stop"))).toContain("stop");
  await until(() => turnStatus(env) === "cancelled");
  expect(
    env.db
      .query<{ status: string }, []>("SELECT status FROM owned_tasks WHERE status != 'open'")
      .get()?.status,
  ).toBe("cancelled");
  // lock released: stop with nothing running
  expect(await handle(task("stop"))).toBe("Nothing is running.");
});

test("H1: DB failure before the run does not leave the thread locked", async () => {
  const env = makeEnv();
  const handle = devHandler(env, () => {
    throw new Error("no");
  });
  env.db.close(); // every DB call now throws
  // The handler never throws, and the thread stays usable: a second message is answered too (no leaked lock).
  expect(["undefined", "string"]).toContain(typeof (await handle(dev("hi"))));
  expect(["undefined", "string"]).toContain(typeof (await handle(dev("again"))));
});

const okQuery = (_a: any) =>
  (async function* () {
    yield resultMsg();
  })();
const failQuery = (_a: any) =>
  (async function* () {
    yield resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
  })();

test("M4: a success outcome finishes the worker turn; a resumable error fails the turn and holds its task", async () => {
  const ok = makeEnv();
  await devHandler(ok, okQuery)(dev("a", "ok"));
  await workersDone(ok.db);
  expect(turnStatus(ok)).toBe("done");
  const bad = makeEnv();
  await devHandler(bad, failQuery)(dev("a", "bad"));
  await workersDone(bad.db);
  expect(turnStatus(bad)).toStartWith("failed"); // failed_resumable: the run left a session
  expect(
    bad.db
      .query<{ status: string }, []>("SELECT status FROM owned_tasks WHERE status != 'open'")
      .get()?.status,
  ).toBe("waiting_user"); // resumable failure: the task is held for the owner
});

test("M2: finishTurn failure in the catch path does not throw", async () => {
  const env = makeEnv();
  const q = (() => {
    throw new Error("boom");
  }) as never;
  const handle = devHandler(env, q);
  // Close db after insertTurn succeeds: first query throw happens in runAgent, then finishTurn hits a closed db.
  const p = handle(dev("hi", "th7"));
  env.db.close();
  expect(["undefined", "string"]).toContain(typeof (await p)); // never throws
});

test("M3: drain aborts runs, waits for them, and leaves no task running", async () => {
  const env = makeEnv();
  const handle = devHandler(env, slowQuery({}));
  await handle(dev("hi", "th6"));
  await Bun.sleep(30);
  await handle.drain(5000);
  expect(
    env.db.query<{ n: number }, []>("SELECT count(*) n FROM turns WHERE status='running'").get()?.n,
  ).toBe(0);
});

test("M3: drain times out on a stuck run and marks its task interrupted", async () => {
  const env = makeEnv();
  const stuck = (_a: any) =>
    (async function* () {
      await new Promise(() => {});
      yield resultMsg();
    })();
  const handle = devHandler(env, stuck);
  void handle(dev("hi", "th5"));
  await Bun.sleep(50);
  await handle.drain(100);
  expect(env.db.query<{ status: string }, []>("SELECT status FROM turns").get()?.status).toBe(
    "interrupted",
  );
});
