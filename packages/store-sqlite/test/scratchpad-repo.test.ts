import { expect, test } from "bun:test";
import { openEngineStore } from "../src/engine-store";

const fresh = () => openEngineStore(":memory:");
const item = (scopeKey: string, title: string, status: "open" | "parked" | "done" = "open") => ({
  scopeKey,
  botId: "a",
  title,
  status,
  notes: "",
});

test("add and list per scope, oldest first, with a status filter", async () => {
  const s = fresh();
  const one = await s.scratchpad.add(item("bot:a", "one"), 1);
  await s.scratchpad.add(item("bot:a", "two", "parked"), 2);
  await s.scratchpad.add(item("bot:b", "other"), 3);
  expect(one).toMatchObject({ title: "one", createdAt: 1, updatedAt: 1 });
  expect((await s.scratchpad.list("bot:a")).map((i) => i.title)).toEqual(["one", "two"]);
  expect((await s.scratchpad.list("bot:a", { status: "parked" })).map((i) => i.title)).toEqual([
    "two",
  ]);
  expect(await s.scratchpad.list("bot:b")).toHaveLength(1);
});

test("update patches fields and refuses another scope's id", async () => {
  const s = fresh();
  const one = await s.scratchpad.add(item("bot:a", "one"), 1);
  const upd = await s.scratchpad.update(one.id, "bot:a", { status: "done", notes: "n" }, 5);
  expect(upd).toMatchObject({
    title: "one",
    status: "done",
    notes: "n",
    updatedAt: 5,
    createdAt: 1,
  });
  expect(await s.scratchpad.update(one.id, "bot:b", { title: "x" }, 6)).toBeUndefined();
  expect((await s.scratchpad.list("bot:a"))[0]?.title).toBe("one");
});

test("remove deletes only inside the scope", async () => {
  const s = fresh();
  const one = await s.scratchpad.add(item("bot:a", "one"), 1);
  expect(await s.scratchpad.remove(one.id, "bot:b")).toBe(false);
  expect(await s.scratchpad.remove(one.id, "bot:a")).toBe(true);
  expect(await s.scratchpad.list("bot:a")).toEqual([]);
});

test("deleteDoneBefore removes old done items and keeps open and parked", async () => {
  const s = fresh();
  await s.scratchpad.add(item("bot:a", "old done", "done"), 1);
  await s.scratchpad.add(item("bot:a", "old open"), 2);
  await s.scratchpad.add(item("bot:a", "old parked", "parked"), 3);
  await s.scratchpad.add(item("bot:a", "new done", "done"), 100);
  expect(await s.scratchpad.deleteDoneBefore(50)).toBe(1);
  expect((await s.scratchpad.list("bot:a")).map((i) => i.title)).toEqual([
    "old open",
    "old parked",
    "new done",
  ]);
});
