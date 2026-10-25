import { expect, test } from "bun:test";
import type { CardRow } from "@friday/core";
import { bot } from "../../../packages/core/test/bot-hub-harness";
import { FakeStore } from "../../../packages/core/test/fakes/fake-store";
import { FakeSurface } from "../../../packages/core/test/fakes/fake-surface";
import { relayWorkerEvents } from "../src/workers/worker-event-relay";

/** An open approval card of bot b1. */
const card: CardRow = {
  id: "k1",
  kind: "approval",
  wakeId: "w1",
  botId: "b1",
  conversationId: "c1",
  scopeKey: "b1",
  approval: {
    tool: "Bash",
    input: {},
    inputHash: "h",
    summary: "ls",
    scope: {},
    offerAlways: false,
  },
  status: "open",
  createdAt: 0,
};

test("a stored message is read by id and posted; one of another conversation is skipped", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  const id = await store.messages.append({
    conversationId: "c1",
    author: { kind: "bot", botId: "b1" },
    text: "hi",
    at: 1,
  });
  await relayWorkerEvents({ t: "post", messageId: id, conversationId: "c1" }, surface, store);
  await relayWorkerEvents({ t: "post", messageId: id, conversationId: "c2" }, surface, store);
  expect(surface.posts.map((p) => [p.conversationId, p.message.text, p.message.id])).toEqual([
    ["c1", "hi", id],
  ]);
});

test("a card is shown from its open row under the bot's name and closed once answered", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  store.botMap.set("b1", bot("b1", "Builder"));
  store.cardMap.set("k1", { ...card });
  await relayWorkerEvents({ t: "card", cardId: "k1" }, surface, store);
  expect(surface.shown.map((s) => [s.card.id, s.botName])).toEqual([["k1", "Builder"]]);
  store.cardMap.set("k1", { ...card, status: "answered", answer: "once" });
  await relayWorkerEvents({ t: "card", cardId: "k1" }, surface, store);
  expect(surface.closed.map((c) => [c.id, c.status])).toEqual([["k1", "answered"]]);
  await relayWorkerEvents({ t: "card", cardId: "gone" }, surface, store);
  expect(surface.shown).toHaveLength(1);
});

test("activity and run steps go on as they are", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  await relayWorkerEvents(
    { t: "activity", conversationId: "c1", activity: { kind: "typing", botId: "b1" } },
    surface,
    store,
  );
  const step = {
    id: "s",
    kind: "tool" as const,
    label: "Read",
    state: "running" as const,
    startedAt: 1,
  };
  await relayWorkerEvents(
    { t: "run_step", conversationId: "c1", botId: "b1", step },
    surface,
    store,
  );
  expect(surface.activities).toEqual([
    { conversationId: "c1", activity: { kind: "typing", botId: "b1" } },
  ]);
  expect(surface.runs).toEqual([{ conversationId: "c1", botId: "b1", step }]);
});

test("a ticket a worker saved is read by id and given to main's listener; a gone one is skipped", async () => {
  const store = new FakeStore();
  const surface = new FakeSurface();
  const t = await store.tickets.create({
    title: "Fix",
    status: "todo",
    priority: "normal",
    createdBy: { kind: "system" },
    createdAt: 1,
  });
  const seen: string[] = [];
  await relayWorkerEvents({ t: "ticket", ticketId: t.id }, surface, store, (x) => seen.push(x.id));
  await relayWorkerEvents({ t: "ticket", ticketId: "gone" }, surface, store, (x) =>
    seen.push(x.id),
  );
  await relayWorkerEvents({ t: "ticket", ticketId: t.id }, surface, store);
  expect(seen).toEqual([t.id]);
});

test("a finished notice from a worker reaches main's surface", async () => {
  const surface = new FakeSurface();
  await relayWorkerEvents(
    { t: "finished", conversationId: "c1", botId: "b1", preview: "done" },
    surface,
    new FakeStore(),
  );
  expect(surface.finished).toEqual([{ conversationId: "c1", botId: "b1", preview: "done" }]);
});
