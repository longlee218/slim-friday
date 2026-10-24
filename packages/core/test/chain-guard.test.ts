import { expect, test } from "bun:test";
import { CORE_DEFAULTS, type WakeRow } from "../src";
import { ChainGuard } from "../src/routing/chain-guard";
import { FakeClock } from "./fakes/fake-clock";
import { FakeStore } from "./fakes/fake-store";

/** A stored wake sent by the writer bot to the editor bot. */
const row = (id: string, over: Partial<WakeRow> = {}): WakeRow => ({
  id,
  chainId: id,
  conversationId: "c",
  targetBot: "editor-id",
  sender: { kind: "bot", botId: "writer-id" },
  intent: "request",
  hop: 1,
  text: `@editor ${id}`,
  status: "done",
  attempts: 1,
  createdAt: 0,
  scopeKey: "s",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

/** The wake the guard is asked about (not stored unless a test inserts it). */
const wake = (over: Record<string, unknown> = {}) => ({
  conversationId: "c",
  sender: { kind: "bot" as const, botId: "writer-id" },
  target: "editor-id",
  text: "@editor go",
  hop: 1,
  ...over,
});

/** A guard over a fresh store and clock. */
const make = (now = 0) => {
  const store = new FakeStore();
  const clock = new FakeClock(now);
  return { store, clock, guard: new ChainGuard(store, clock, CORE_DEFAULTS) };
};

test("hops over maxHops blocks", async () => {
  const { guard } = make();
  expect(await guard.check(wake({ hop: 8 }))).toEqual({ ok: true });
  expect(await guard.check(wake({ hop: 9 }))).toEqual({ ok: false, reason: "hops" });
});

test("rate counts bot wakes stored by another process", async () => {
  const { store, clock, guard } = make();
  for (let i = 0; i < 60; i++) await store.wakes.insert(row(`w${i}`));
  expect(await guard.check(wake({ text: "new" }))).toEqual({ ok: false, reason: "rate" });
  expect(await guard.check(wake({ sender: { kind: "user" }, text: "from user" }))).toEqual({
    ok: true,
  });
  clock.advance(3_600_001);
  expect(await guard.check(wake({ text: "new" }))).toEqual({ ok: true });
});

test("repeat seen across a restart", async () => {
  const { store, clock } = make();
  await store.wakes.insert(row("w1", { text: "@editor go" }));
  const restarted = new ChainGuard(store, clock, CORE_DEFAULTS); // no memory, rows only
  expect(await restarted.check(wake())).toEqual({ ok: false, reason: "repeat" });
  expect(await restarted.check(wake({ text: "@editor else" }))).toEqual({ ok: true });
  clock.advance(600_001);
  expect(await restarted.check(wake())).toEqual({ ok: true });
});

test("a user may repeat a message; the repeat cap is for bots", async () => {
  const { store, guard } = make();
  await store.wakes.insert(row("w1", { sender: { kind: "user" }, text: "hi" }));
  expect(await guard.check(wake({ sender: { kind: "user" }, text: "hi", hop: 0 }))).toEqual({
    ok: true,
  });
});

test("the wake being checked is not counted against itself", async () => {
  const { store, guard } = make();
  await store.wakes.insert(row("self", { text: "@editor go", status: "queued" }));
  expect(await guard.check(wake({ id: "self" }))).toEqual({ ok: true });
  for (let i = 0; i < 59; i++) await store.wakes.insert(row(`w${i}`));
  expect(await guard.check(wake({ id: "self", text: "other" }))).toEqual({ ok: true });
});

test("a wake that a cap blocked is not counted", async () => {
  const { store, guard } = make();
  await store.wakes.insert(row("b", { text: "@editor go", status: "blocked" }));
  expect(await guard.check(wake())).toEqual({ ok: true });
});

test("two identical bot wakes stored at the same time: the earlier passes, the later is a repeat", async () => {
  const { store, guard } = make();
  const a = row("a", { text: "@editor go", status: "queued", createdAt: 5 });
  const b = row("b", { text: "@editor go", status: "queued", createdAt: 5 });
  await store.wakes.insert(a);
  await store.wakes.insert(b);
  const asWake = (r: WakeRow) => wake({ id: r.id, createdAt: r.createdAt, text: r.text });
  expect(await guard.check(asWake(a))).toEqual({ ok: true });
  expect(await guard.check(asWake(b))).toEqual({ ok: false, reason: "repeat" });
});
