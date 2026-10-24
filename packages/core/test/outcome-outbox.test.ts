import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type WakeRow } from "../src";
import { outcomeKey } from "../src/runs/outcome-outbox";
import { HOLD_UNTIL } from "../src/runs/run-create";
import { flush, makeHub, tick } from "./bot-hub-harness";

type H = ReturnType<typeof makeHub>;

/** The group chain started: the owner wrote, writer runs a turn. */
async function started(): Promise<H> {
  const h = makeHub();
  h.surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  return h;
}

/** Writer asks editor for work; editor is then running its turn (runtime session 1). */
async function delegated(): Promise<H> {
  const h = await started();
  await h.hub.send("writer@g", { to: "editor", text: "check", intent: "request" });
  await flush();
  h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  return h;
}

/** Texts of the turns writer received. */
const writerTurns = (h: H) =>
  h.runtime.created.filter((s) => s.spec.bot.id === "writer").flatMap((s) => s.sent);

/** A complete wake row for a test to store directly. */
const row = (over: Partial<WakeRow>): WakeRow => ({
  id: "w",
  chainId: "w",
  conversationId: "gc",
  targetBot: "editor",
  sender: { kind: "bot", botId: "writer" },
  intent: "request",
  hop: 1,
  text: "t",
  status: "done",
  attempts: 1,
  createdAt: 1,
  scopeKey: "editor@g",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

/** Run the reconciler once and wait for it. */
async function reconcile(h: H): Promise<void> {
  const stop = h.hub.startReconciler();
  await flush();
  stop();
}

const outcomes = (h: H) =>
  [...h.store.wakeMap.values()].filter((w) => w.dedupeKey?.startsWith("auto-outcome:"));

test("done run returns its result once", async () => {
  const h = await delegated();
  h.runtime.nth(1).emit({ type: "text", text: "done: cut 1" });
  h.runtime.nth(1).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(writerTurns(h).map((t) => t.text)).toEqual(["go", "done: cut 1"]);
  const editorRow = [...h.store.wakeMap.values()].find((w) => w.targetBot === "editor");
  expect(editorRow?.outcomeReturnedAt).toBeDefined();
  await reconcile(h);
  expect(outcomes(h)).toHaveLength(1);
});

test("failed run returns the failure status", async () => {
  const h = await delegated();
  h.runtime.nth(1).emit({ type: "error", message: "boom", retryable: false });
  await flush();
  const back = outcomes(h)[0];
  expect(back).toMatchObject({ intent: "status", targetBot: "writer" });
  expect(back?.text).toStartWith("Could not complete the delegated request: ");
  expect(back?.text).toContain("boom");
});

test("explicit result already sent: nothing more, marked returned", async () => {
  const h = await delegated();
  await h.hub.send("editor@g", { to: "writer", text: "explicit result", intent: "result" });
  h.runtime.nth(1).emit({ type: "text", text: "closing words" });
  h.runtime.nth(1).emit({ type: "turn_end", costUsd: 0 });
  await flush();
  expect(writerTurns(h).map((t) => t.text)).toEqual(["go", "explicit result"]);
  expect(outcomes(h)).toHaveLength(0);
  const editorRow = [...h.store.wakeMap.values()].find((w) => w.targetBot === "editor");
  expect(editorRow?.outcomeReturnedAt).toBeDefined();
});

test("reconciler after crash returns once", async () => {
  const h = await started();
  // The run ended and the process died before it returned the result.
  h.store.wakeMap.set("x", row({ id: "x", startedAt: 1, resultText: "late result" }));
  await reconcile(h);
  expect(outcomes(h).map((w) => [w.dedupeKey, w.text])).toEqual([[outcomeKey("x"), "late result"]]);
  expect(h.store.wakeMap.get("x")?.outcomeReturnedAt).toBeDefined();
  await reconcile(h);
  expect(outcomes(h)).toHaveLength(1);
  // A crash after the delivery and before the mark: the key finds the first run.
  await h.store.wakes.update("x", { outcomeReturnedAt: undefined });
  await reconcile(h);
  expect(outcomes(h)).toHaveLength(1);
});

test("poison row does not block the batch", async () => {
  const h = await started();
  h.store.wakeMap.set("a", row({ id: "a", createdAt: 1, resultText: "ra" }));
  h.store.wakeMap.set("b", row({ id: "b", createdAt: 2, resultText: "rb" }));
  const real = h.store.wakes.botSentSince;
  let first = true;
  h.store.wakes.botSentSince = async (c, s) => {
    if (first) {
      first = false;
      throw new Error("db busy");
    }
    return real(c, s);
  };
  await reconcile(h);
  expect(outcomes(h).map((w) => w.text)).toEqual(["rb"]);
  expect(h.log.of("hub.reconcile_row_failed")).toHaveLength(1);
  // The next pass retries the one that failed.
  await reconcile(h);
  expect(
    outcomes(h)
      .map((w) => w.text)
      .sort(),
  ).toEqual(["ra", "rb"]);
});

test("tool send with the same key twice creates one run", async () => {
  const h = await started();
  const req = { to: "editor", text: "check", intent: "request" as const };
  const a = await h.hub.send("writer@g", req);
  // A cut re-runs the same call: the execution counts its sends from 1 again.
  (h.hub as any).ctx.runs.get("writer@g").sendCounts.clear();
  const b = await h.hub.send("writer@g", req);
  expect(a.ok && b.ok).toBe(true);
  if (a.ok && b.ok) {
    expect(b.wakeId).toBe(a.wakeId);
    expect(b.replayed).toBe(true);
    expect(a.replayed).toBeUndefined();
  }
  expect([...h.store.wakeMap.values()].filter((w) => w.targetBot === "editor")).toHaveLength(1);
});

test("carried a: a run left held by a crash is checked and released", async () => {
  const h = await started();
  h.store.wakeMap.set(
    "held",
    row({
      id: "held",
      status: "queued",
      wakeAt: HOLD_UNTIL,
      createdAt: 0,
      sender: { kind: "user" },
    }),
  );
  await tick(h.clock, CORE_DEFAULTS.reconcileMs + 1);
  await reconcile(h);
  expect(h.store.wakeMap.get("held")?.wakeAt).not.toBe(HOLD_UNTIL);
});

test("carried b: steering bound to an ended run goes back to a continuation run", async () => {
  const h = makeHub();
  h.store.wakeMap.set(
    "end",
    row({ id: "end", conversationId: "dc", scopeKey: "editor", sender: { kind: "user" } }),
  );
  h.store.steerMap.set("s1", {
    id: "s1",
    messageId: 1,
    conversationId: "dc",
    scopeKey: "editor",
    wakeId: "end",
    text: "also this",
    createdAt: 1,
  });
  await reconcile(h);
  const cont = [...h.store.wakeMap.values()].find((w) => w.dedupeKey === "cont:end");
  expect(cont).toBeDefined();
  expect(h.store.steerMap.get("s1")?.wakeId).toBe(cont?.id);
});

test("carried c: held steering in a scope with no open run gets a continuation", async () => {
  const h = makeHub();
  h.store.steerMap.set("s1", {
    id: "s1",
    messageId: 1,
    conversationId: "dc",
    scopeKey: "editor",
    text: "hello?",
    createdAt: 1,
  });
  await reconcile(h);
  const cont = [...h.store.wakeMap.values()].find((w) => w.dedupeKey?.startsWith("cont:"));
  expect(cont).toBeDefined();
  expect(h.store.steerMap.get("s1")?.wakeId).toBe(cont?.id);
});
