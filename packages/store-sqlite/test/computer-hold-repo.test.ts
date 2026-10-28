import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const fresh = () => openEngineStore(":memory:").computerHolds;
const input = (holder: string, now: number, computer = "pc") => ({
  kind: "input" as const,
  computer,
  botId: holder,
  holder,
  ttlMs: 100,
  now,
});

test("input hold is exclusive across two acquires", async () => {
  const h = fresh();
  const [a, b] = await Promise.all([h.acquire(input("a", 1)), h.acquire(input("b", 1))]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  expect(a ?? b).toMatchObject({ key: "input:pc", fence: 1, expiresAt: 101 });
});

test("input hold is exclusive across two connections to one file", async () => {
  const file = join(tmpdir(), `holds-${crypto.randomUUID()}.db`);
  const one = openEngineStore(file);
  const two = openEngineStore(file);
  const r = await Promise.all([
    one.computerHolds.acquire(input("a", 1)),
    two.computerHolds.acquire(input("b", 1)),
  ]);
  expect(r.filter(Boolean)).toHaveLength(1);
  one.close();
  two.close();
});

test("an expired row is taken with fence + 1", async () => {
  const h = fresh();
  await h.acquire(input("a", 1));
  expect(await h.acquire(input("b", 50))).toBeUndefined();
  expect(await h.acquire(input("b", 101))).toMatchObject({ holder: "b", fence: 2 });
});

test("the same holder re-acquiring keeps the fence and extends the hold", async () => {
  const h = fresh();
  await h.acquire(input("a", 1));
  expect(await h.acquire(input("a", 50))).toMatchObject({ fence: 1, expiresAt: 150 });
});

test("renew is false for a wrong fence or holder", async () => {
  const h = fresh();
  const got = await h.acquire(input("a", 1));
  const base = { key: "input:pc", ttlMs: 100, now: 10 };
  expect(await h.renew({ ...base, holder: "a", fence: 9 })).toBe(false);
  expect(await h.renew({ ...base, holder: "b", fence: got?.fence ?? 0 })).toBe(false);
  expect(await h.renew({ ...base, holder: "a", fence: got?.fence ?? 0 })).toBe(true);
  expect((await h.live(10))[0]?.expiresAt).toBe(110);
});

test("slot limit 1 refuses a second bot and allows the same bot", async () => {
  const h = fresh();
  const slot = (botId: string) => ({
    kind: "slot" as const,
    computer: "pc",
    botId,
    holder: botId,
    ttlMs: 100,
    now: 1,
    slotLimit: 1,
  });
  expect(await h.acquire(slot("a"))).toMatchObject({ key: "slot:a" });
  expect(await h.acquire(slot("b"))).toBeUndefined();
  expect(await h.acquire(slot("a"))).toMatchObject({ key: "slot:a", fence: 1 });
});

test("release with a wrong fence leaves the row; a right one deletes it", async () => {
  const h = fresh();
  const got = await h.acquire(input("a", 1));
  await h.release({ key: "input:pc", holder: "a", fence: (got?.fence ?? 0) + 1 });
  expect(await h.live(2)).toHaveLength(1);
  await h.release({ key: "input:pc", holder: "a", fence: got?.fence ?? 0 });
  expect(await h.live(2)).toHaveLength(0);
});
