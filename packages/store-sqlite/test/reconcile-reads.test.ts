import { expect, test } from "bun:test";
import type { WakeRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

/** A done wake sent by bot a to bot b; tests override what they need. */
const wake = (id: string, over: Partial<WakeRow> = {}): WakeRow => ({
  id,
  chainId: "ch",
  conversationId: "c1",
  targetBot: "b",
  sender: { kind: "bot", botId: "a" },
  intent: "request",
  hop: 1,
  text: id,
  status: "done",
  attempts: 1,
  createdAt: 1,
  scopeKey: "b@g",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ...over,
});

test("pendingOutcomes: only finished bot requests not yet returned, in order, with a cursor", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("w1", { createdAt: 1 }));
  await s.wakes.insert(wake("w2", { createdAt: 2, status: "failed" }));
  await s.wakes.insert(wake("w3", { createdAt: 3, outcomeReturnedAt: 9 }));
  await s.wakes.insert(wake("w4", { createdAt: 4, handoff: true }));
  await s.wakes.insert(wake("w5", { createdAt: 5, sender: { kind: "user" } }));
  await s.wakes.insert(wake("w6", { createdAt: 6, intent: "result" }));
  await s.wakes.insert(wake("w7", { createdAt: 7, status: "blocked" }));
  await s.wakes.insert(wake("w8", { createdAt: 8, status: "cancelled" }));
  const all = await s.wakes.pendingOutcomes(10);
  expect(all.map((w) => w.id)).toEqual(["w1", "w2", "w8"]);
  const page = await s.wakes.pendingOutcomes(1, { createdAt: 1, id: "w1" });
  expect(page.map((w) => w.id)).toEqual(["w2"]);
});

test("staleHeld: queued runs held since before the cut-off", async () => {
  const s = openEngineStore(":memory:");
  const H = Number.MAX_SAFE_INTEGER;
  await s.wakes.insert(wake("h1", { status: "queued", wakeAt: H, createdAt: 1 }));
  await s.wakes.insert(wake("h2", { status: "queued", wakeAt: H, createdAt: 50 }));
  await s.wakes.insert(wake("q", { status: "queued", wakeAt: 1, createdAt: 2 }));
  expect((await s.wakes.staleHeld(H, 10, 10)).map((w) => w.id)).toEqual(["h1"]);
});

test("endedRuns and heldScopes", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("end", { status: "failed" }));
  await s.wakes.insert(wake("live", { status: "running" }));
  const row = (id: string, scopeKey: string, wakeId?: string) => ({
    id,
    messageId: 1,
    conversationId: "c1",
    scopeKey,
    ...(wakeId && { wakeId }),
    text: id,
    createdAt: 1,
  });
  await s.steering.add(row("s1", "x", "end"));
  await s.steering.add(row("s2", "x", "end"));
  await s.steering.add(row("s3", "y", "live"));
  await s.steering.add(row("s4", "z"));
  await s.steering.add(row("s5", "z"));
  expect(await s.steering.endedRuns(10)).toEqual(["end"]);
  expect(await s.steering.endedRuns(10, "end")).toEqual([]);
  expect(await s.steering.heldScopes(10)).toEqual(["z"]);
});
