import { expect, test } from "bun:test";
import type { FridayEvent } from "@friday/contracts";
import { engineHarness } from "./helpers/engine-deps";

/** A harness with two bots, direct conversations and a recording of the bus's ticket events. */
function setup() {
  const h = engineHarness();
  h.addBot("a", "Ann");
  h.addBot("b", "Ben");
  h.store.convMap.set("bot:a", { id: "bot:a", kind: "direct", botId: "a" });
  h.store.convMap.set("bot:b", { id: "bot:b", kind: "direct", botId: "b" });
  const events: FridayEvent[] = [];
  const publish = h.surface.bus.publish.bind(h.surface.bus);
  h.surface.bus.publish = (e: FridayEvent) => {
    events.push(e);
    return publish(e);
  };
  return { ...h, events };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test("update with a stale expectedUpdatedAt -> CONFLICT", async () => {
  const h = setup();
  await h.client.tickets.create({ title: "t" });
  await expect(
    h.client.tickets.update({ ref: "FRI-1", status: "doing", expectedUpdatedAt: 0 }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("unknown ref -> NOT_FOUND; empty title and unknown bot -> BAD_REQUEST", async () => {
  const h = setup();
  await expect(h.client.tickets.get({ ref: "FRI-9" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(h.client.tickets.comment({ ref: "FRI-9", text: "x" })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(h.client.tickets.create({ title: "   " })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(h.client.tickets.create({ title: "t", assignee: "zz" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: "Unknown bot.",
  });
});

test("blocking without a reason -> BAD_REQUEST with the board message", async () => {
  const h = setup();
  const t = await h.client.tickets.create({ title: "t" });
  await expect(
    h.client.tickets.update({ ref: t.ref, status: "blocked", expectedUpdatedAt: t.updatedAt }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("assigning wakes the assignee once and writes an assignee event by the owner", async () => {
  const h = setup();
  const t = await h.client.tickets.create({ title: "t" });
  await h.client.tickets.update({ ref: t.ref, assignee: "a", expectedUpdatedAt: t.updatedAt });
  const wakes = [...h.store.wakeMap.values()].filter((w) => w.ticketId === t.id);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ targetBot: "a", sender: { kind: "user" } });
  const d = await h.client.tickets.get({ ref: t.ref });
  const ev = d.timeline.find((i) => i.type === "event" && i.event.kind === "assignee");
  expect(ev).toMatchObject({ event: { to: "a", actor: { kind: "user" } } });
});

test("get returns the timeline in merge order and related tickets", async () => {
  const h = setup();
  const one = await h.client.tickets.create({ title: "one" });
  const two = await h.client.tickets.create({ title: "two" });
  await h.client.tickets.comment({ ref: two.ref, text: `after ${one.ref}` });
  const d = await h.client.tickets.get({ ref: two.ref });
  expect(d.timeline.map((i) => i.type)).toEqual(["event", "comment"]);
  expect(d.related.map((r) => r.ref)).toEqual([one.ref]);
  expect(d.ticket.commentCount).toBe(1);
});

test("comment by the owner wakes the assignee; none for a finished ticket", async () => {
  const h = setup();
  const t = await h.client.tickets.create({ title: "t", assignee: "a" });
  const before = h.store.wakeMap.size;
  const c = await h.client.tickets.comment({ ref: t.ref, text: "hello" });
  expect(c).toMatchObject({ body: "hello", author: { kind: "user" } });
  expect(h.store.wakeMap.size).toBe(before + 1);
  const cur = await h.client.tickets.get({ ref: t.ref });
  await h.client.tickets.update({
    ref: t.ref,
    status: "done",
    expectedUpdatedAt: cur.ticket.updatedAt,
  });
  const n = h.store.wakeMap.size;
  await h.client.tickets.comment({ ref: t.ref, text: "late" });
  expect(h.store.wakeMap.size).toBe(n);
});

test("every change publishes one ticket event with the fresh updatedAt", async () => {
  const h = setup();
  const t = await h.client.tickets.create({ title: "t" });
  const u = await h.client.tickets.update({
    ref: t.ref,
    priority: "high",
    expectedUpdatedAt: t.updatedAt,
  });
  await settle();
  const tickets = h.events.filter((e) => e.type === "ticket");
  expect(tickets).toHaveLength(2);
  expect(tickets[1]).toMatchObject({ ticket: { ref: t.ref, updatedAt: u.updatedAt } });
});

test("list pages with nextCursor and filters by status", async () => {
  const h = setup();
  for (let i = 0; i < 51; i++) await h.client.tickets.create({ title: `t${i}` });
  const p1 = await h.client.tickets.list({});
  expect(p1.items).toHaveLength(50);
  expect(p1.nextCursor).toBeDefined();
  const p2 = await h.client.tickets.list({ cursor: p1.nextCursor });
  expect(p2.items).toHaveLength(1);
  expect(p2.nextCursor).toBeUndefined();
  expect((await h.client.tickets.list({ status: "doing" })).items).toHaveLength(0);
  await expect(h.client.tickets.list({ cursor: "garbage" })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
});
