import { expect, test } from "bun:test";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";
import { devLeadQuery, until } from "./lead-harness";

test("limiter caps at max and frees on release (idempotent)", () => {
  const l = createRunLimiter(2);
  const a = l.tryAcquire()!;
  const b = l.tryAcquire()!;
  expect(l.tryAcquire()).toBeNull();
  expect(l.active()).toBe(2);
  a();
  a(); // double release must not free a second slot
  expect(l.active()).toBe(1);
  expect(l.tryAcquire()).not.toBeNull();
  b();
});

/**
 * Handler over a fake `query`: a worker run blocks on `gate` until released or aborted; the lead answers at once. The
 * lead run takes a slot too (released before the worker's end), so two slots leave one for the first worker.
 */
function gatedHandler(env: ReturnType<typeof makeEnv>, limiter = createRunLimiter(2)) {
  const gate: { open?: () => void; entered: number } = { entered: 0 };
  const queryFn = ((a: any) =>
    (async function* () {
      if (a.options.mcpServers?.worker) {
        gate.entered++;
        await new Promise<void>((res, rej) => {
          gate.open = res;
          a.options.abortController.signal.addEventListener("abort", () =>
            rej(new Error("process aborted")),
          );
        });
      }
      yield resultMsg();
    })()) as never;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: devLeadQuery(queryFn),
    limiter,
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
  });
  const send = (text: string, threadId: string) =>
    handle({
      source: "test",
      language: "en" as const,
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId,
      text,
      notify: async () => {},
    });
  return { handle, send, gate, limiter };
}

test("a worker holds the only slot; a second one is deferred (stays ready, no failure) and starts when the first ends", async () => {
  const env = makeEnv();
  const { send, gate, limiter } = gatedHandler(env);
  await send("a", "th1");
  await until(() => gate.entered === 1);
  expect(limiter.active()).toBe(1);
  await send("b", "th2"); // cap reached: the item waits, it never fails
  await until(
    () =>
      !!env.db
        .query("SELECT 1 FROM owned_tasks WHERE parent_id IS NOT NULL AND status = 'ready'")
        .get(),
  );
  await Bun.sleep(100);
  expect(gate.entered).toBe(1);
  expect(
    env.db.query("SELECT COUNT(*) AS n FROM thread_events WHERE kind = 'failure'").get(),
  ).toEqual({ n: 0 });
  const first = gate.open!;
  first();
  await until(() => gate.entered === 2); // the end of the first worker retries the deferred item
  gate.open!();
  await until(() => limiter.active() === 0);
  expect(env.db.query("SELECT COUNT(*) AS n FROM turns WHERE status = 'running'").get()).toEqual({
    n: 0,
  });
});

test("slot released when the run errors", async () => {
  const env = makeEnv();
  const limiter = createRunLimiter(1);
  const boom = (() => {
    throw new Error("boom");
  }) as never;
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: boom, limiter });
  await handle({ source: "test", channelId: TEST_CHANNEL, userId: "u", threadId: "t", text: "x" });
  expect(limiter.active()).toBe(0);
});

test("abortAll aborts active worker runs and frees their slot", async () => {
  const env = makeEnv();
  const { handle, send, gate, limiter } = gatedHandler(env);
  await send("a", "th1");
  await until(() => gate.entered === 1);
  handle.abortAll();
  await until(() => limiter.active() === 0);
  expect(
    env.db
      .query("SELECT COUNT(*) AS n FROM turns WHERE role = 'developer' AND status = 'completed'")
      .get(),
  ).toEqual({ n: 0 });
});
