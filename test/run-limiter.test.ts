import { expect, test } from "bun:test";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { createRunLimiter } from "../src/orchestrator/turns/run-limiter";
import { makeEnv, resultMsg, TEST_CHANNEL } from "./helpers";

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

/** Query that blocks until released. */
function gated(gate: { open?: () => void; ready?: () => void }) {
  return (_a: unknown) =>
    (async function* () {
      await new Promise<void>((r) => {
        gate.open = r;
        gate.ready?.(); // Signal that gate.open is set up and we're waiting
      });
      yield resultMsg();
    })();
}

test("handleMessage replies busy when cap reached, stop still works, slot released after run", async () => {
  const env = makeEnv();
  const limiter = createRunLimiter(1);
  const gate: { open?: () => void; ready?: () => void } = {};
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  gate.ready = readyResolve;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: gated(gate) as never,
    limiter,
  });
  const t = (text: string, threadId: string) => ({
    source: "test",
    language: "en" as const,
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId,
    text,
  });
  const first = handle(t("a", "th1"));
  await ready; // Wait for query setup, not timing
  expect(await handle(t("b", "th2"))).toBe("I’m handling other work. Please try again shortly.");
  expect(await handle(t("again", "th1"))).toBe(
    "I’m handling other work. Please try again shortly.",
  );
  gate.open!();
  await first;
  expect(limiter.active()).toBe(0);
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

test("abortAll aborts active runs", async () => {
  const env = makeEnv();
  const ready: { signal?: () => void } = {};
  let readyResolve: (() => void) | undefined;
  const readyPromise = new Promise<void>((r) => {
    readyResolve = r;
  });
  ready.signal = readyResolve;
  const q = (a: any) =>
    (async function* () {
      await new Promise<void>((_r, rej) => {
        a.options.abortController.signal.addEventListener("abort", () =>
          rej(new Error("process aborted")),
        );
        ready.signal?.(); // Signal that abort listener is set up
      });
      yield resultMsg();
    })();
  const handle = createTurnHandler({ db: env.db, config: env.config, queryFn: q as never });
  const p = handle({
    source: "test",
    language: "en" as const,
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "t",
    text: "x",
  });
  await readyPromise; // Wait for abort listener to be set up
  handle.abortAll();
  expect(await p).toBe("Stopped.");
});
