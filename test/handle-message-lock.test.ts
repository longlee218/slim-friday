import { expect, test } from "bun:test";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { getSession, setSession } from "../src/storage/session-store";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

const task = (text: string, threadId = "th1") => ({
  source: "test",
  channelId: TEST_CHANNEL,
  userId: "u",
  threadId,
  text,
});

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
      yield resultMsg({ result: "done secret ghp_" + "a".repeat(36) });
    })();
}

test("second message during run -> still working; reply is redacted; session saved", async () => {
  const env = makeEnv();
  const release: { fn?: () => void; ready?: () => void } = {};
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  release.ready = readyResolve;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: slowQuery(release) as never,
  });
  const first = handle(task("hi"));
  await ready; // Wait for slow query to be ready, not timing
  expect(await handle(task("again"))).toBe("still working...");
  release.fn!();
  const reply = await first;
  expect(reply).toContain("done secret");
  expect(reply).not.toContain("ghp_");
  expect(getSession(env.db, "th1")?.session_id).toBe("sess-1");
});

test("stop aborts run and marks task cancelled", async () => {
  const env = makeEnv();
  const release: { fn?: () => void; ready?: () => void } = {};
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  release.ready = readyResolve;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: slowQuery(release) as never,
  });
  const first = handle(task("hi"));
  await ready; // Wait for slow query to be ready
  expect(await handle(task("stop"))).toBe("Stopping...");
  expect(await first).toBe("Stopped.");
  expect(env.db.query<{ status: string }, []>("SELECT status FROM turns").get()?.status).toBe(
    "cancelled",
  );
  // lock released: stop with nothing running
  expect(await handle(task("stop"))).toBe("Nothing is running.");
});

test("H1: DB failure before the run does not leave the thread locked", async () => {
  const env = makeEnv();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: (() => {
      throw new Error("no");
    }) as never,
  });
  env.db.close(); // every DB call now throws
  expect(await handle(task("hi"))).toBe("Agent failed. Check the logs.");
  // A leaked lock would answer "still working..." here.
  expect(await handle(task("again"))).not.toBe("still working...");
});

const okQuery = (a: any) =>
  (async function* () {
    yield resultMsg();
  })();
const failQuery = (a: any) =>
  (async function* () {
    yield resultMsg({ subtype: "error_during_execution", is_error: true, errors: ["boom"] });
  })();

test("M4: session saved on success, not on error/abort outcomes", async () => {
  const env = makeEnv();
  await createTurnHandler({ db: env.db, config: env.config, queryFn: okQuery as never })(
    task("a", "ok"),
  );
  expect(getSession(env.db, "ok")?.session_id).toBe("sess-1");
  await createTurnHandler({ db: env.db, config: env.config, queryFn: failQuery as never })(
    task("a", "bad"),
  );
  expect(getSession(env.db, "bad")).toBeNull();
});

/** Query yielding an error result with the given error text. */
const errQuery = (msg: string) => (_a: any) =>
  (async function* () {
    yield resultMsg({ subtype: "error_during_execution", is_error: true, errors: [msg] });
  })();

test("M4: genuine resume failure clears the session and tells the user", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th9", sessionId: "stale", location: env.home, cwd: env.home });
  const q = errQuery("No conversation found with session ID: stale");
  const reply = await createTurnHandler({ db: env.db, config: env.config, queryFn: q as never })(
    task("a", "th9"),
  );
  expect(reply).toContain("cleared");
  expect(getSession(env.db, "th9")).toBeNull();
});

test("M1: transient error (auth/rate limit) keeps the session", async () => {
  const env = makeEnv();
  setSession(env.db, { threadId: "th8", sessionId: "good", location: env.home, cwd: env.home });
  const q = errQuery("rate limit exceeded, retry later");
  const reply = await createTurnHandler({ db: env.db, config: env.config, queryFn: q as never })(
    task("a", "th8"),
  );
  expect(reply).not.toContain("cleared");
  expect(getSession(env.db, "th8")?.session_id).toBe("good");
});

test("M2: finishTurn failure in the catch path does not throw", async () => {
  const env = makeEnv();
  const q = (() => {
    throw new Error("boom");
  }) as never;
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: q });
  // Close db after insertTurn succeeds: first query throw happens in runAgent, then finishTurn hits a closed db.
  const p = handle(task("hi", "th7"));
  env.db.close();
  expect(typeof (await p)).toBe("string");
});

test("M3: drain aborts runs, waits for them, and leaves no task running", async () => {
  const env = makeEnv();
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: slowQuery({}) as never,
  });
  const p = handle(task("hi", "th6"));
  await Bun.sleep(30);
  await handle.drain(5000);
  expect(await p).toBe("Stopped.");
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
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: stuck as never });
  void handle(task("hi", "th5"));
  await Bun.sleep(50);
  await handle.drain(100);
  expect(env.db.query<{ status: string }, []>("SELECT status FROM turns").get()?.status).toBe(
    "interrupted",
  );
});
