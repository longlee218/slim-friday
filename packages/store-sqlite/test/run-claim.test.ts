import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WakeRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

/** A queued interactive wake in scope `s1`; tests override what they need. */
const wake = (id: string, over: Partial<WakeRow> = {}): WakeRow => ({
  id,
  chainId: "ch1",
  conversationId: "c1",
  targetBot: "b1",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: `text ${id}`,
  status: "queued",
  attempts: 0,
  createdAt: 1,
  scopeKey: "s1",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  ...over,
});

const claim = (s: ReturnType<typeof openEngineStore>, now = 100, bootId = "boot-a") =>
  s.wakes.claimNext({ owner: `${bootId}:w1`, bootId, now, leaseMs: 10 });

test("claimNext takes the oldest interactive run before an older background run", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("bg", { priority: "background", createdAt: 1, scopeKey: "a" }));
  await s.wakes.insert(wake("i2", { createdAt: 3, scopeKey: "b" }));
  await s.wakes.insert(wake("i1", { createdAt: 2, scopeKey: "c" }));
  const got = await claim(s);
  expect(got).toMatchObject({ id: "i1", status: "leased", leaseFence: 1, leaseExpiresAt: 110 });
  expect(got?.leaseOwner).toBe("boot-a:w1");
});

test("claimNext skips a queued run whose scope has a running run", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(
    wake("r", { status: "running", leaseOwner: "boot-a:w9", leaseExpiresAt: 500 }),
  );
  await s.wakes.insert(wake("q", { createdAt: 2 }));
  expect(await claim(s)).toBeUndefined();
});

test("claimNext does not skip for a waiting_input run", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("w", { status: "waiting_input" }));
  await s.wakes.insert(wake("q", { createdAt: 2 }));
  expect((await claim(s))?.id).toBe("q");
});

test("claimNext respects wakeAt", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("later", { wakeAt: 101 }));
  expect(await claim(s)).toBeUndefined();
  expect((await claim(s, 101))?.id).toBe("later");
});

test("claimNext reclaims an expired lease with fence + 1", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("a"));
  expect((await claim(s, 100))?.leaseFence).toBe(1);
  expect(await claim(s, 105)).toBeUndefined();
  expect((await claim(s, 110))?.leaseFence).toBe(2);
});

test("claimNext reclaims a lease of an older boot at once", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(
    wake("a", {
      status: "running",
      leaseOwner: "boot-old:w1",
      leaseExpiresAt: 9999,
      leaseFence: 3,
    }),
  );
  const got = await claim(s, 100, "boot-new");
  expect(got).toMatchObject({
    id: "a",
    leaseFence: 4,
    leaseOwner: "boot-new:w1",
    status: "leased",
  });
});

test("transition fails with a stale fence", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("a"));
  const got = await claim(s);
  expect(await s.wakes.transition("a", 0, ["leased"], { status: "running" })).toBe(false);
  expect((await s.wakes.get("a"))?.status).toBe("leased");
  expect(await s.wakes.transition("a", 1, ["queued"], { status: "running" })).toBe(false);
  expect(
    await s.wakes.transition("a", got?.leaseFence ?? 0, ["leased"], { status: "running" }),
  ).toBe(true);
  expect((await s.wakes.get("a"))?.status).toBe("running");
});

test("renew extends only for the matching owner and fence", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("a"));
  await claim(s);
  expect(await s.wakes.renew("a", "boot-a:w1", 2, 200)).toBe(false);
  expect(await s.wakes.renew("a", "boot-a:w2", 1, 200)).toBe(false);
  expect(await s.wakes.renew("a", "boot-a:w1", 1, 200)).toBe(true);
  expect((await s.wakes.get("a"))?.leaseExpiresAt).toBe(200);
});

test("activeInScope lists open rows of the scope, oldest first", async () => {
  const s = openEngineStore(":memory:");
  await s.wakes.insert(wake("b", { createdAt: 2, status: "waiting_input" }));
  await s.wakes.insert(wake("a", { createdAt: 1 }));
  await s.wakes.insert(wake("d", { createdAt: 3, status: "done" }));
  await s.wakes.insert(wake("x", { createdAt: 1, scopeKey: "other" }));
  expect((await s.wakes.activeInScope("s1")).map((w) => w.id)).toEqual(["a", "b"]);
});

test("insertDeduped returns the existing row on the same conversation and key", async () => {
  const s = openEngineStore(":memory:");
  expect(await s.wakes.insertDeduped(wake("a", { dedupeKey: "k" }))).toEqual({ inserted: true });
  const again = await s.wakes.insertDeduped(wake("b", { dedupeKey: "k" }));
  expect(again).toMatchObject({ inserted: false, existing: { id: "a", dedupeKey: "k" } });
  expect(await s.wakes.get("b")).toBeUndefined();
  expect(await s.wakes.insertDeduped(wake("c", { dedupeKey: "k", conversationId: "c2" }))).toEqual({
    inserted: true,
  });
});

test("insertDeduped allows two rows with null keys", async () => {
  const s = openEngineStore(":memory:");
  expect(await s.wakes.insertDeduped(wake("a"))).toEqual({ inserted: true });
  expect(await s.wakes.insertDeduped(wake("b"))).toEqual({ inserted: true });
});

// Cross-process atomicity relies on the IMMEDIATE transaction in claimNext; this checks the result only.
test("sequential claims on two connections claim the run once", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "run-claim-")), "engine.db");
  const a = openEngineStore(file);
  const b = openEngineStore(file);
  await a.wakes.insert(wake("only"));
  const [x, y] = await Promise.all([claim(a, 100, "boot-a"), claim(b, 100, "boot-a")]);
  expect([x, y].filter(Boolean)).toHaveLength(1);
  a.close();
  b.close();
});
