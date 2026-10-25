import { expect, test } from "bun:test";
import type { WakeRow } from "@friday/core";
import type { ApiDeps } from "../src/index";
import { engineHarness } from "./helpers/engine-deps";

/** A wake row with only the fields a test varies. */
const wake = (id: string, over: Partial<WakeRow>): WakeRow => ({
  id,
  chainId: id,
  conversationId: "bot:a",
  targetBot: "a",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "secret text",
  status: "done",
  attempts: 1,
  createdAt: 100,
  scopeKey: "a",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

test("spend refuses from > to, a bad date and a span over 31 days", async () => {
  const { client } = engineHarness();
  const bad = [
    { from: "2026-10-10", to: "2026-10-01" },
    { from: "2026-1-01", to: "2026-10-01" },
    { from: "2026-10-01", to: "2026-13-45" },
    { from: "2026-09-01", to: "2026-10-11" },
  ];
  for (const input of bad)
    await expect(client.ops.spend(input)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  // 31 days inclusive of both ends is the longest allowed range.
  expect((await client.ops.spend({ from: "2026-10-01", to: "2026-10-31" })).rows).toEqual([]);
});

test("spend returns the rows and the cap from deps", async () => {
  const h = engineHarness();
  await h.store.spend.add("a", "2026-10-02", 1.5);
  await h.store.spend.add("a", "2026-11-30", 9);
  const r = await h.client.ops.spend({ from: "2026-10-01", to: "2026-10-05" });
  expect(r).toEqual({
    rows: [{ botId: "a", day: "2026-10-02", usd: 1.5 }],
    capPerBotPerDayUsd: 10,
  });
});

test("spend reads the cap on every call (a config reload shows at once)", async () => {
  const h = engineHarness();
  let cap = 10;
  // CoreLimits types the cap as its default literal; a reloaded config holds any number.
  h.deps.limits = () => ({ maxSpendPerBotPerDayUsd: cap }) as ReturnType<ApiDeps["limits"]>;
  cap = 25;
  const r = await h.client.ops.spend({ from: "2026-10-01", to: "2026-10-05" });
  expect(r.capPerBotPerDayUsd).toBe(25);
});

test("wakes filters by status and since, newest first, with no text", async () => {
  const h = engineHarness();
  await h.store.wakes.insert(wake("w1", { status: "running", createdAt: 100 }));
  await h.store.wakes.insert(wake("w2", { status: "running", createdAt: 200, ticketId: "t1" }));
  await h.store.wakes.insert(wake("w3", { status: "done", createdAt: 300, handoff: true }));
  await h.store.wakes.insert(wake("w4", { status: "running", createdAt: 50 }));
  const rows = await h.client.ops.wakes({ status: "running", since: 100 });
  expect(rows.map((w) => w.id)).toEqual(["w2", "w1"]);
  expect(rows[0]).toMatchObject({ ticketId: "t1", targetBot: "a", sender: { kind: "user" } });
  expect(JSON.stringify(rows)).not.toContain("secret text");
  expect((await h.client.ops.wakes({ since: 0 })).map((w) => w.id)).toEqual([
    "w3",
    "w2",
    "w1",
    "w4",
  ]);
});

test("sessions equals control.status", async () => {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  await h.client.chat.send({ conversationId: "bot:a", text: "hi" });
  const s = await h.client.ops.sessions();
  expect(s.length).toBeGreaterThan(0);
  expect(s).toEqual(await h.client.control.status());
});
