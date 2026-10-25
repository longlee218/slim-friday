import { expect, test } from "bun:test";
import { type CardRow, reactionOf, runKindOf, silenceAllowed, type WakeRow } from "../src";
import { InProcessHints } from "../src/runs/run-hints";
import { makeHub, tick } from "./bot-hub-harness";

/** A direct chat "dc" with editor; its bot message is stored as the one produced by wake `w0`. */
async function setup() {
  // Own hints: no in-process runner claims the queued runs, as in the intake tests.
  const h = makeHub(undefined, { hints: new InProcessHints() });
  const target = await h.store.messages.append({
    conversationId: "dc",
    author: { kind: "bot", botId: "editor" },
    text: "Draft is ready",
    at: 1,
    wakeId: "w0",
  });
  const react = (emoji: string, to = target, clientNonce?: string) =>
    h.hub.handle({
      conversationId: "dc",
      text: emoji,
      replyTo: to,
      ...(clientNonce && { clientNonce }),
    });
  return { ...h, target, react };
}

const runs = (rows: Map<string, WakeRow>) => [...rows.values()];

function parked(): WakeRow {
  return {
    id: "w0",
    chainId: "w0",
    conversationId: "dc",
    targetBot: "editor",
    sender: { kind: "user" },
    intent: "request",
    hop: 0,
    text: "earlier",
    attempts: 1,
    createdAt: 0,
    scopeKey: "editor",
    priority: "interactive",
    leaseFence: 1,
    cuts: 0,
    transientRetries: 0,
    setupFailures: 0,
    nudges: 0,
    status: "waiting_input",
  };
}

const question = (): CardRow => ({
  id: "q1",
  kind: "question",
  wakeId: "w0",
  botId: "editor",
  conversationId: "dc",
  scopeKey: "editor",
  question: {
    botId: "editor",
    botName: "Editor",
    question: "Ship it?",
    kind: "confirm",
    options: [],
    allowText: true,
  },
  status: "open",
  createdAt: 0,
});

test("reactionOf accepts exactly one listed emoji", () => {
  expect(reactionOf(" 👍 ")).toBe("👍");
  expect(reactionOf("👍👍")).toBeUndefined();
  expect(reactionOf("thanks")).toBeUndefined();
});

test("a reaction to a bot message queues a silent-able reaction run with the quote", async () => {
  const { store, react } = await setup();
  await react("👍");
  const [run] = runs(store.wakeMap);
  expect(run).toMatchObject({
    status: "queued",
    targetBot: "editor",
    reaction: "👍",
    quote: { author: { kind: "bot", botId: "editor" }, text: "Draft is ready" },
  });
  if (!run) throw new Error("no run");
  expect(runKindOf(run)).toBe("reaction");
  expect(silenceAllowed(run, "reaction")).toBe(true);
  expect(store.steerMap.size).toBe(0);
});

test("a second reaction within the cooldown stores the message but starts no run", async () => {
  const { store, clock, react, target } = await setup();
  await react("👍");
  const second = await store.messages.append({
    conversationId: "dc",
    author: { kind: "bot", botId: "editor" },
    text: "More",
    at: 2,
  });
  // The first run is still queued (busy), so cooldown and busy both hold it back; finish it first.
  for (const w of store.wakeMap.values()) w.status = "done";
  await react("🎉", second);
  expect(runs(store.wakeMap)).toHaveLength(1);
  await tick(clock, 31_000);
  await react("🎉", second, "n2");
  expect(runs(store.wakeMap)).toHaveLength(2);
  expect(target).toBeLessThan(second);
});

test("a message after the target means the conversation moved on: no run", async () => {
  const { store, react, target } = await setup();
  await store.messages.append({
    conversationId: "dc",
    author: { kind: "user" },
    text: "next",
    at: 2,
  });
  await react("👍", target);
  expect(store.wakeMap.size).toBe(0);
});

test("a busy bot gets no reaction run and no steering", async () => {
  const { store, react } = await setup();
  await store.wakes.insert({ ...parked(), id: "busy", status: "running" });
  await react("👎");
  expect(runs(store.wakeMap).map((w) => w.id)).toEqual(["busy"]);
  expect(store.steerMap.size).toBe(0);
});

test("a reaction to the owner's own message starts nothing", async () => {
  const { store, react } = await setup();
  const mine = await store.messages.append({
    conversationId: "dc",
    author: { kind: "user" },
    text: "hi",
    at: 2,
  });
  await react("👍", mine);
  expect(store.wakeMap.size).toBe(0);
});

test("👍 on a message of a run parked on a question answers it yes", async () => {
  const { store, react } = await setup();
  await store.wakes.insert(parked());
  await store.cards.insert(question());
  await react("👍");
  expect(store.cardMap.get("q1")).toMatchObject({ status: "answered", answer: { text: "yes" } });
  expect(store.wakeMap.get("w0")?.status).toBe("queued");
  expect(store.wakeMap.size).toBe(1);
});

test("❤️ does not answer the question; it wakes a reaction run instead", async () => {
  const { store, react } = await setup();
  await store.wakes.insert(parked());
  await store.cards.insert(question());
  await react("❤️");
  expect(store.cardMap.get("q1")?.status).toBe("open");
  expect(runs(store.wakeMap).filter((w) => w.reaction)).toHaveLength(1);
});
