import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FridayEvent } from "@friday/contracts";
import type { CardRow, RunStep } from "@friday/core";
import { FakeClock } from "../../core/test/fakes/fake-clock";
import { FakeFileStore } from "../../core/test/fakes/fake-file-store";
import { FakeStore } from "../../core/test/fakes/fake-store";
import { WebSurface } from "../src/web-surface";

// A real 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const bot = { kind: "bot", botId: "a" } as const;

let store: FakeStore;
let fileStore: FakeFileStore;
let surface: WebSurface;
let seen: FridayEvent[];
let dir: string;

beforeEach(() => {
  store = new FakeStore();
  fileStore = new FakeFileStore();
  surface = new WebSurface({
    store,
    files: fileStore,
    clock: new FakeClock(1000),
    inboxDir: "/unused",
  });
  seen = [];
  const orig = surface.bus.publish.bind(surface.bus);
  surface.bus.publish = (e) => {
    seen.push(e);
    return orig(e);
  };
  dir = mkdtempSync(join(tmpdir(), "ws-out-"));
});

test("a bot post publishes the message and the unread count", async () => {
  const id = await store.messages.append({
    conversationId: "bot:a",
    author: bot,
    text: "hi",
    at: 1,
  });
  await surface.post("bot:a", { id, conversationId: "bot:a", author: bot, text: "hi", at: 1 });
  expect(seen).toEqual([
    { type: "message", conversationId: "bot:a", message: expect.objectContaining({ id }) },
    { type: "unread", conversationId: "bot:a", unread: 1 },
  ]);
});

test("the owner's own message publishes no unread event", async () => {
  await surface.post("bot:a", {
    id: 1,
    conversationId: "bot:a",
    author: { kind: "user" },
    text: "yo",
    at: 1,
  });
  expect(seen.map((e) => e.type)).toEqual(["message"]);
});

test("a reply quotes the replied message only from the same conversation", async () => {
  await store.messages.append({ conversationId: "bot:a", author: bot, text: "same", at: 1 });
  await store.messages.append({ conversationId: "bot:b", author: bot, text: "other", at: 1 });
  const base = { conversationId: "bot:a", author: { kind: "user" } as const, text: "r", at: 2 };
  await surface.post("bot:a", { ...base, id: 3, replyTo: 1 });
  await surface.post("bot:a", { ...base, id: 4, replyTo: 2 });
  const [a, b] = seen as Extract<FridayEvent, { type: "message" }>[];
  expect(a?.message.replyTo?.excerpt).toBe("same");
  expect(b?.message.replyTo).toBeUndefined();
});

test("showRun and showActivity publish run and activity events", () => {
  const step: RunStep = { id: "s", kind: "tool", label: "Bash", state: "running", startedAt: 1 };
  surface.showRun("bot:a", "a", step);
  surface.showActivity("bot:a", { kind: "typing", botId: "a" });
  expect(seen).toEqual([
    { type: "run", conversationId: "bot:a", botId: "a", step },
    { type: "activity", conversationId: "bot:a", botId: "a", kind: "typing" },
  ]);
});

/** A stored open question card of conversation bot:a. */
const qcard = (id = "c1"): CardRow => ({
  id,
  kind: "question",
  wakeId: "w1",
  botId: "a",
  conversationId: "bot:a",
  scopeKey: "a",
  question: {
    botId: "a",
    botName: "Ann",
    question: "Q?",
    kind: "single",
    options: [{ value: "x", label: "x" }],
    allowText: false,
  },
  status: "open",
  createdAt: 1,
});

test("a shown card publishes unread counting the open card", async () => {
  await store.cards.insert(qcard());
  surface.showCard(qcard(), "Ann");
  await Bun.sleep(5);
  expect(seen.at(-1)).toEqual({ type: "unread", conversationId: "bot:a", unread: 1 });
});

test("a card closing publishes the unread count without it", async () => {
  await store.cards.insert(qcard());
  surface.showCard(qcard(), "Ann");
  await Bun.sleep(5);
  seen.length = 0;
  await store.cards.answer("c1", { choices: ["x"] }, 2);
  surface.closeCard({ ...qcard(), status: "answered", answer: { choices: ["x"] } });
  await Bun.sleep(5);
  expect(seen[0]).toEqual({ type: "question.closed", cardId: "c1", answer: { choices: ["x"] } });
  expect(seen.at(-1)).toEqual({ type: "unread", conversationId: "bot:a", unread: 0 });
});

test("postFile uploads to R2, records the file and posts a file message", async () => {
  const path = join(dir, "x.png");
  writeFileSync(path, PNG);
  await surface.postFile("bot:a", bot, { path, name: "chart one.png" }, "the chart");
  const key = [...fileStore.objects.keys()][0];
  expect(key).toMatch(/^files\/bot:a\/[0-9a-f-]{36}\/chart_one\.png$/);
  expect(store.fileMap.size).toBe(1);
  expect([...store.fileMap.values()][0]?.source).toBe("bot");
  expect(store.msgs.at(-1)).toMatchObject({
    kind: "file",
    text: "the chart",
    files: [{ mimeType: "image/png", width: 1, height: 1 }],
  });
  expect(seen.map((e) => e.type)).toEqual(["message", "unread"]);
});

test("postFile of a text file has the file's type and no size", async () => {
  const path = join(dir, "n.txt");
  writeFileSync(path, "hello");
  await surface.postFile("bot:a", bot, { path, name: "n.txt" });
  const f = [...store.fileMap.values()][0];
  expect(f?.mimeType).toStartWith("text/plain");
  expect(f?.width).toBeUndefined();
});

test("postFile with R2 down rejects and stores nothing", async () => {
  const path = join(dir, "x.png");
  writeFileSync(path, PNG);
  fileStore.failNext("put");
  await expect(surface.postFile("bot:a", bot, { path, name: "x.png" })).rejects.toThrow(
    /Could not store the file/,
  );
  expect(store.fileMap.size).toBe(0);
  expect(store.msgs).toHaveLength(0);
  expect(seen).toHaveLength(0);
});

test("postFile with a failing insert leaves no object and rejects", async () => {
  const path = join(dir, "x.png");
  writeFileSync(path, PNG);
  store.files.insert = async () => {
    throw new Error("db down");
  };
  await expect(surface.postFile("bot:a", bot, { path, name: "x.png" })).rejects.toThrow(
    /Could not store the file: db down/,
  );
  expect(fileStore.objects.size).toBe(0);
  expect(store.msgs).toHaveLength(0);
});

test("a failing unread lookup does not stop a card from showing", async () => {
  store.reads.unread = async () => {
    throw new Error("db down");
  };
  await store.cards.insert(qcard());
  surface.showCard(qcard(), "Ann");
  await Bun.sleep(5);
  expect((await surface.cards.pendingQuestions()).map((c) => c.cardId)).toEqual(["c1"]);
});
