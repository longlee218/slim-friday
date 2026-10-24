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
  expect(done).toMatchObject({ completedAt: 100 });
  const closed = await s.tickets.update(t.id, { status: "closed" }, 200);
  expect(closed).toMatchObject({ completedAt: 100 });
  const todo = (await s.tickets.update(t.id, { status: "todo" }, 300)) as Ticket;
  expect(todo.completedAt).toBeUndefined();
  expect(todo.updatedAt).toBe(300);
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

const owner = { kind: "user" } as const;

test("update with a stale ifUpdatedAt returns conflict and changes nothing", async () => {
  const s = openEngineStore(":memory:");
  const t = await s.tickets.create(input("a", { createdAt: 1000 }));
  const a = await s.tickets.update(t.id, { status: "doing" }, 1000, { ifUpdatedAt: 1000 });
  expect(a).toMatchObject({ status: "doing", updatedAt: 1001 }); // same ms: +1
  expect(await s.tickets.update(t.id, { status: "review" }, 1000, { ifUpdatedAt: 1000 })).toBe(
    "conflict",
  );
  expect((await s.tickets.get(t.id))?.status).toBe("doing");
  expect(await s.tickets.update("missing", { status: "doing" }, 5)).toBeUndefined();
});

test("a comment in the same ms still moves updatedAt", async () => {
  const s = openEngineStore(":memory:");
  const t = await s.tickets.create(input("a", { createdAt: 50 }));
  await s.tickets.addComment({ ticketId: t.id, author: owner, body: "x", createdAt: t.updatedAt });
  expect((await s.tickets.get(t.id))?.updatedAt).toBe(t.updatedAt + 1);
});

test("blockedReason is kept while blocked and cleared when the status leaves blocked", async () => {
  const s = openEngineStore(":memory:");
  const t = await s.tickets.create(input("a"));
  const b = await s.tickets.update(t.id, { status: "blocked", blockedReason: "vault" }, 10);
  expect(b).toMatchObject({ blockedReason: "vault" });
  // An unrelated patch keeps the reason while still blocked.
  expect(await s.tickets.update(t.id, { title: "b" }, 11)).toMatchObject({
    blockedReason: "vault",
  });
  const d = (await s.tickets.update(t.id, { status: "doing" }, 12)) as Ticket;
  expect(d.blockedReason).toBeUndefined();
  // A reason given with a non-blocked status is dropped too; null clears while blocked.
  const x = (await s.tickets.update(t.id, { blockedReason: "x" }, 13)) as Ticket;
  expect(x.blockedReason).toBeUndefined();
  await s.tickets.update(t.id, { status: "blocked", blockedReason: "y" }, 14);
  const c = (await s.tickets.update(t.id, { blockedReason: null }, 15)) as Ticket;
  expect(c.blockedReason).toBeUndefined();
});

test("conversationId round-trips", async () => {
  const s = openEngineStore(":memory:");
  const t = await s.tickets.create(input("a"));
  await s.tickets.update(t.id, { conversationId: "bot:dev" }, 10);
  expect((await s.tickets.get(t.id))?.conversationId).toBe("bot:dev");
});

test("commentCounts counts per ticket and omits none", async () => {
  const s = openEngineStore(":memory:");
  const t1 = await s.tickets.create(input("a"));
  const t2 = await s.tickets.create(input("b"));
  for (const body of ["x", "y"])
    await s.tickets.addComment({ ticketId: t1.id, author: owner, body, createdAt: 5 });
  expect(await s.tickets.commentCounts([t1.id, t2.id])).toEqual(
    new Map([
      [t1.id, 2],
      [t2.id, 0],
    ]),
  );
  expect((await s.tickets.commentCounts([])).size).toBe(0);
});

test("events of create and update are written with the change; a conflict writes none", async () => {
  const s = openEngineStore(":memory:");
  const actor = { kind: "user" } as const;
  const t = await s.tickets.create(input("a"), {
    events: (n) => [{ id: "e1", ticketId: n.id, kind: "created", actor, at: 1 }],
  });
  const ev = (id: string, ticketId: string) => ({
    id,
    ticketId,
    kind: "status" as const,
    actor,
    at: 2,
  });
  const stale = await s.tickets.update(t.id, { status: "doing" }, 5, {
    ifUpdatedAt: 99,
    events: (p) => [ev("e2", p.id)],
  });
  expect(stale).toBe("conflict");
  expect((await s.ticketEvents.list(t.id)).map((e) => e.id)).toEqual(["e1"]);
  await s.tickets.update(t.id, { status: "doing" }, 5, {
    ifUpdatedAt: t.updatedAt,
    events: (p, n) => [{ ...ev("e3", p.id), from: p.status, to: n.status }],
  });
  expect((await s.ticketEvents.list(t.id)).map((e) => [e.id, e.to])).toEqual([
    ["e1", undefined],
    ["e3", "doing"],
  ]);
});
