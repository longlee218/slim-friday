import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const open = () => openEngineStore(join(mkdtempSync(join(tmpdir(), "run-state-")), "engine.db"));

const row = (id: string, createdAt: number, wakeId?: string) => ({
  id,
  messageId: 1,
  conversationId: "bot:a",
  scopeKey: "a",
  ...(wakeId && { wakeId }),
  text: id,
  createdAt,
});

test("claim returns only rows bound to the wake and only once", async () => {
  const s = open();
  await s.steering.add(row("s2", 2, "w1"));
  await s.steering.add(row("s1", 1, "w1"));
  await s.steering.add(row("s3", 3, "w2"));
  await s.steering.add(row("s4", 4));
  const first = await s.steering.claim("w1", 10);
  expect(first.map((r) => r.id)).toEqual(["s1", "s2"]);
  expect(first[0]?.claimedAt).toBe(10);
  expect(await s.steering.claim("w1", 11)).toEqual([]);
  await s.steering.releaseClaimed("w1");
  expect((await s.steering.claim("w1", 12)).length).toBe(2);
  await s.steering.deleteClaimed("w1");
  expect(await s.steering.claim("w1", 13)).toEqual([]);
  expect((await s.steering.claim("w2", 13)).length).toBe(1);
  s.close();
});

test("bind skips rows bound to another wake or already claimed", async () => {
  const s = open();
  await s.steering.add(row("b1", 1, "w1"));
  await s.steering.add(row("c1", 2));
  await s.steering.bind(["c1"], "w2");
  await s.steering.claim("w2", 5);
  expect(await s.steering.bind(["b1", "c1"], "w3")).toEqual([]);
  expect((await s.steering.claim("w1", 6)).map((r) => r.id)).toEqual(["b1"]);
  s.close();
});

test("held rows are those without a wake; bind and deleteForScope", async () => {
  const s = open();
  await s.steering.add({
    ...row("h1", 1),
    attachments: [{ name: "f", mimeType: "x/y", path: "/p", size: 1 }],
  });
  await s.steering.add(row("h2", 2));
  await s.steering.add(row("b1", 3, "w1"));
  const held = await s.steering.held("a");
  expect(held.map((r) => r.id)).toEqual(["h1", "h2"]);
  expect(held[0]?.attachments?.[0]?.name).toBe("f");
  expect(held[0]?.wakeId).toBeUndefined();
  expect(await s.steering.bind(["h1", "b1", "nope"], "w9")).toEqual(["h1"]);
  expect((await s.steering.held("a")).map((r) => r.id)).toEqual(["h2"]);
  await s.steering.deleteForScope("a");
  expect(await s.steering.held("a")).toEqual([]);
  expect(await s.steering.claim("w9", 5)).toEqual([]);
  s.close();
});

test("add of a stored id changes nothing; bound reads without claiming; remove deletes", async () => {
  const s = open();
  await s.steering.add(row("s1", 1, "w1"));
  await s.steering.add({ ...row("s1", 1, "w2"), text: "other" });
  await s.steering.add(row("s2", 2, "w1"));
  const bound = await s.steering.bound("w1");
  expect(bound.map((r) => [r.id, r.text])).toEqual([
    ["s1", "s1"],
    ["s2", "s2"],
  ]);
  expect(bound[0]?.claimedAt).toBeUndefined();
  await s.steering.remove(["s1"]);
  expect((await s.steering.claim("w1", 5)).map((r) => r.id)).toEqual(["s2"]);
  expect(await s.steering.bound("w1")).toEqual([]);
});

test("deleteClaimed with upTo keeps later claims; unbind makes unclaimed rows held", async () => {
  const s = open();
  await s.steering.add(row("u1", 1, "w1"));
  await s.steering.claim("w1", 10);
  await s.steering.add(row("u2", 2, "w1"));
  await s.steering.claim("w1", 20);
  await s.steering.add(row("u3", 3, "w1"));
  await s.steering.deleteClaimed("w1", 10);
  await s.steering.releaseClaimed("w1");
  expect((await s.steering.bound("w1")).map((r) => r.id)).toEqual(["u2", "u3"]);
  await s.steering.unbind("w1");
  expect((await s.steering.held("a")).map((r) => r.id)).toEqual(["u2", "u3"]);
  s.close();
});
