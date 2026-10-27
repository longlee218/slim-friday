import { expect, test } from "bun:test";
import type { CardRow, WakeRow } from "../src";
import { InProcessHints } from "../src/runs/run-hints";
import { makeHub } from "./bot-hub-harness";

/** The ticket session key of editor in group "g". */
const KEY = "editor#ticket@g";

/** A hub whose queued runs no in-process runner claims, with editor's ticket run's message in the DM. */
async function setup() {
  const h = makeHub(undefined, { hints: new InProcessHints() });
  const target = await h.store.messages.append({
    conversationId: "dc",
    author: { kind: "bot", botId: "editor" },
    text: "Ship the fix?",
    at: 1,
    wakeId: "w0",
  });
  return { ...h, target };
}

/** Editor's ticket run, parked on a question in its DM (or in `status`). */
const ticketRun = (status: WakeRow["status"] = "waiting_input"): WakeRow => ({
  id: "w0",
  chainId: "w0",
  conversationId: "dc",
  targetBot: "editor",
  sender: { kind: "system" },
  intent: "request",
  hop: 0,
  text: "Work on ticket FRI-1.",
  attempts: 1,
  createdAt: 0,
  scopeKey: KEY,
  priority: "background",
  leaseFence: 1,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ticketId: "t1",
  status,
});

/** The ticket run's open question, which takes a typed answer. */
const question = (over: Partial<CardRow> = {}): CardRow => ({
  id: "q1",
  kind: "question",
  wakeId: "w0",
  botId: "editor",
  conversationId: "dc",
  scopeKey: KEY,
  question: {
    botId: "editor",
    botName: "Editor",
    question: "Ship the fix?",
    kind: "confirm",
    options: [],
    allowText: true,
  },
  status: "open",
  // Asked with its message: no bot message after it, so a typed answer is not stale.
  createdAt: 1,
  ...over,
});

test("the owner's typed DM answer answers a ticket run's question; no direct run starts", async () => {
  const h = await setup();
  await h.store.wakes.insert(ticketRun());
  await h.store.cards.insert(question());
  await h.hub.handle({ conversationId: "dc", text: "yes, ship it" });
  expect(h.store.cardMap.get("q1")).toMatchObject({
    status: "answered",
    answer: { text: "yes, ship it" },
  });
  expect(h.store.wakeMap.get("w0")?.status).toBe("queued");
  expect(h.store.wakeMap.size).toBe(1);
});

test("a 👍 in the DM on a ticket run's message answers its question; no direct run starts", async () => {
  const h = await setup();
  await h.store.wakes.insert(ticketRun());
  await h.store.cards.insert(question());
  await h.hub.handle({ conversationId: "dc", text: "👍", replyTo: h.target });
  expect(h.store.cardMap.get("q1")).toMatchObject({ status: "answered", answer: { text: "yes" } });
  expect(h.store.wakeMap.get("w0")?.status).toBe("queued");
  expect(h.store.wakeMap.size).toBe(1);
});

test("another bot's ticket question is not answered from editor's DM", async () => {
  const h = await setup();
  await h.store.wakes.insert({ ...ticketRun(), targetBot: "writer", scopeKey: "writer#ticket@g" });
  await h.store.cards.insert(question({ botId: "writer", scopeKey: "writer#ticket@g" }));
  await h.hub.handle({ conversationId: "dc", text: "yes" });
  expect(h.store.cardMap.get("q1")?.status).toBe("open");
});

test("a free DM message does not steer into a running ticket run; it starts a direct run", async () => {
  const h = await setup();
  await h.store.wakes.insert(ticketRun("running"));
  await h.hub.handle({ conversationId: "dc", text: "unrelated question" });
  expect(h.store.steerMap.size).toBe(0);
  const fresh = [...h.store.wakeMap.values()].filter((w) => w.id !== "w0");
  expect(fresh.map((w) => w.scopeKey)).toEqual(["editor"]);
});
