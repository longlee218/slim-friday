import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type CoreLimits, type WakeRow } from "../src";
import { dayOf } from "../src/runs/run-rules";
import { flush, makeHub } from "./bot-hub-harness";

type H = ReturnType<typeof makeHub>;

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

const steer = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  messageId: 1,
  conversationId: "dc",
  scopeKey: "editor",
  text: id,
  createdAt: 1,
  ...over,
});

/** Run the reconciler once and wait for it (stop waits for a running pass). */
async function reconcile(h: H): Promise<void> {
  const stop = h.hub.startReconciler();
  await flush();
  await stop();
}

const outcomes = (h: H) =>
  [...h.store.wakeMap.values()].filter((w) => w.dedupeKey?.startsWith("auto-outcome:"));

test("a cancelled run's steering rows are deleted, not turned into a continuation", async () => {
  const h = makeHub();
  h.store.wakeMap.set(
    "c",
    row({
      id: "c",
      status: "cancelled",
      conversationId: "dc",
      scopeKey: "editor",
      sender: { kind: "user" },
    }),
  );
  h.store.steerMap.set("a", steer("a", { wakeId: "c" }));
  h.store.steerMap.set("b", steer("b", { wakeId: "c", claimedAt: 5 }));
  await reconcile(h);
  expect(h.store.steerMap.size).toBe(0);
  expect(
    [...h.store.wakeMap.values()].filter((w) => w.dedupeKey?.startsWith("cont:")),
  ).toHaveLength(0);
});

test("a crash after the park leaves rows bound to a parked run: the reconciler continues them", async () => {
  const h = makeHub();
  h.store.wakeMap.set(
    "p",
    row({
      id: "p",
      status: "waiting_input",
      conversationId: "dc",
      scopeKey: "editor",
      sender: { kind: "user" },
    }),
  );
  h.store.steerMap.set("a", steer("a", { wakeId: "p" }));
  await reconcile(h);
  const cont = [...h.store.wakeMap.values()].find((w) => w.dedupeKey?.startsWith("cont:"));
  expect(cont).toBeDefined();
  expect(h.store.steerMap.get("a")?.wakeId).toBe(cont?.id);
});

test("held rows in a scope that only has a parked run get a continuation", async () => {
  const h = makeHub();
  h.store.wakeMap.set(
    "p",
    row({
      id: "p",
      status: "waiting_input",
      conversationId: "dc",
      scopeKey: "editor",
      sender: { kind: "user" },
    }),
  );
  h.store.steerMap.set("a", steer("a"));
  await reconcile(h);
  const cont = [...h.store.wakeMap.values()].find((w) => w.dedupeKey?.startsWith("cont:"));
  expect(h.store.steerMap.get("a")?.wakeId).toBe(cont?.id);
});

test("a deliberate identical send after a card resume is a new send; a cut re-run is replayed", async () => {
  const h = makeHub(undefined, {
    limits: { ...CORE_DEFAULTS, repeatWindowMs: 0 } as unknown as CoreLimits,
  });
  h.surface.deliver({ conversationId: "gc", text: "go" });
  await flush();
  const exec = (h.hub as any).ctx.runs.get("writer@g");
  const req = { to: "editor", text: "T", intent: "request" as const };
  const first = await h.hub.send("writer@g", req);
  // Parked on a card, answered, resumed: a new execution with the card id on the row.
  exec.row.cardId = "card1";
  exec.sendCounts.clear();
  const again = await h.hub.send("writer@g", req);
  exec.sendCounts.clear();
  const rerun = await h.hub.send("writer@g", req);
  if (!first.ok || !again.ok || !rerun.ok) throw new Error("send failed");
  expect(again.wakeId).not.toBe(first.wakeId);
  expect(again.replayed).toBeUndefined();
  expect(rerun).toMatchObject({ wakeId: again.wakeId, replayed: true });
});

test("a cancelled, dropped and interrupted run each return their status", async () => {
  const h = makeHub();
  h.store.wakeMap.set("a", row({ id: "a", status: "cancelled", createdAt: 1 }));
  h.store.wakeMap.set("b", row({ id: "b", status: "dropped", createdAt: 2 }));
  h.store.wakeMap.set("c", row({ id: "c", status: "interrupted", createdAt: 3 }));
  await reconcile(h);
  expect(
    outcomes(h)
      .map((w) => [w.intent, w.text])
      .sort(),
  ).toEqual([
    ["status", "Could not complete the delegated request: it was interrupted by restarts"],
    ["status", "Could not complete the delegated request: the bot or the conversation is gone"],
    ["status", "Could not complete the delegated request: the owner stopped it"],
  ]);
});

test("a delivery a cap blocks is marked returned", async () => {
  const h = makeHub();
  await h.store.spend.add("writer", dayOf(h.clock.now()), 1_000_000);
  h.store.wakeMap.set("a", row({ id: "a", resultText: "r" }));
  await reconcile(h);
  expect(outcomes(h)[0]?.status).toBe("blocked");
  expect(h.store.wakeMap.get("a")?.outcomeReturnedAt).toBeDefined();
});

test("a ticket wake and a direct chat are marked returned without a run", async () => {
  const h = makeHub();
  h.store.wakeMap.set("t", row({ id: "t", ticketId: "tk", resultText: "r", createdAt: 1 }));
  h.store.wakeMap.set("d", row({ id: "d", conversationId: "dc", resultText: "r", createdAt: 2 }));
  await reconcile(h);
  expect(outcomes(h)).toHaveLength(0);
  expect(h.store.wakeMap.get("t")?.outcomeReturnedAt).toBeDefined();
  expect(h.store.wakeMap.get("d")?.outcomeReturnedAt).toBeDefined();
});
