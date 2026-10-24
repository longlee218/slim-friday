import { expect, test } from "bun:test";
import type { Ticket } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

type NewTicket = Parameters<ReturnType<typeof openEngineStore>["tickets"]["create"]>[0];

/** A new ticket from the owner; tests override what they need. */
const input = (title: string, over: Partial<NewTicket> = {}): NewTicket => ({
  title,
  status: "todo",
  priority: "normal",
  createdBy: { kind: "user" },
  createdAt: 1,
  ...over,
});

test("create numbers tickets 1, 2, 3 and never reuses a number", async () => {
  const s = openEngineStore(":memory:");
  const a = await s.tickets.create(input("a"));
  const b = await s.tickets.create(input("b"));
  const c = await s.tickets.create(input("c"));
  expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
  // The ticket is gone from the list (closed), the next number is still new.
  await s.tickets.update(c.id, { status: "closed" }, 5);
  expect((await s.tickets.create(input("d"))).number).toBe(4);
});

test("two creates in a row get distinct numbers", async () => {
  const s = openEngineStore(":memory:");
  const [a, b] = await Promise.all([s.tickets.create(input("a")), s.tickets.create(input("b"))]);
  expect(a.number).not.toBe(b.number);
});

test("list is newest first, honors before, status, excludeClosed, assignee and limit", async () => {
  const s = openEngineStore(":memory:");
  const t1 = await s.tickets.create(input("one", { createdAt: 10, assigneeBotId: "b1" }));
  const t2 = await s.tickets.create(input("two", { createdAt: 20, status: "doing" }));
  const t3 = await s.tickets.create(input("three", { createdAt: 30, status: "closed" }));
  const titles = (l: Ticket[]) => l.map((t) => t.title);
  expect(titles(await s.tickets.list({ limit: 10 }))).toEqual(["three", "two", "one"]);
  expect(titles(await s.tickets.list({ limit: 10, excludeClosed: true }))).toEqual(["two", "one"]);
  expect(titles(await s.tickets.list({ limit: 10, status: "closed" }))).toEqual(["three"]);
  expect(titles(await s.tickets.list({ limit: 10, assigneeBotId: "b1" }))).toEqual(["one"]);
  expect(titles(await s.tickets.list({ limit: 1 }))).toEqual(["three"]);
  const before = { createdAt: t3.createdAt, id: t3.id };
  expect(titles(await s.tickets.list({ limit: 10, before }))).toEqual(["two", "one"]);
  expect(
    titles(await s.tickets.list({ limit: 10, before: { createdAt: t2.createdAt, id: t2.id } })),
  ).toEqual(["one"]);
  expect(t1.number).toBe(1);
});

test("update sets completedAt for done and keeps it, clears it for todo", async () => {
  const s = openEngineStore(":memory:");
  const t = await s.tickets.create(input("a"));
  const done = await s.tickets.update(t.id, { status: "done" }, 100);
  expect(done?.completedAt).toBe(100);
  const closed = await s.tickets.update(t.id, { status: "closed" }, 200);
  expect(closed?.completedAt).toBe(100);
  const todo = await s.tickets.update(t.id, { status: "todo" }, 300);
  expect(todo?.completedAt).toBeUndefined();
  expect(todo?.updatedAt).toBe(300);
});

test("addComment bumps updatedAt and comments come oldest first", async () => {
  const s = openEngineStore(":memory:");
  const t = await s.tickets.create(input("a"));
  await s.tickets.addComment({
    ticketId: t.id,
    author: { kind: "bot", botId: "b1" },
    body: "first",
    createdAt: 5,
  });
  await s.tickets.addComment({
    ticketId: t.id,
    author: { kind: "user" },
    body: "second",
    createdAt: 9,
  });
  expect((await s.tickets.comments(t.id)).map((c) => c.body)).toEqual(["first", "second"]);
  expect((await s.tickets.comments(t.id))[0]?.author).toEqual({ kind: "bot", botId: "b1" });
  expect((await s.tickets.get(t.id))?.updatedAt).toBe(9);
  expect((await s.tickets.getByNumber(1))?.id).toBe(t.id);
});

test("conversations.direct finds the direct conversation of a bot", async () => {
  const s = openEngineStore(":memory:");
  await s.conversations.put({ id: "g1", kind: "group", groupId: "gr" });
  await s.conversations.put({ id: "d1", kind: "direct", botId: "b1" });
  expect(await s.conversations.direct("b1")).toEqual({ id: "d1", kind: "direct", botId: "b1" });
  expect(await s.conversations.direct("nobody")).toBeUndefined();
});
