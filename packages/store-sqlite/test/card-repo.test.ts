import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEngineStore } from "../src/engine-store";

const open = () => openEngineStore(join(mkdtempSync(join(tmpdir(), "run-state-")), "engine.db"));

const card = {
  id: "c1",
  kind: "approval" as const,
  wakeId: "w1",
  botId: "a",
  conversationId: "bot:a",
  scopeKey: "a",
  approval: {
    tool: "Bash",
    input: { command: "ls" },
    inputHash: "h",
    summary: "run ls",
    scope: { cmd: "ls" },
    offerAlways: true,
  },
  status: "open" as const,
  createdAt: 1,
};

test("answer works once", async () => {
  const s = open();
  await s.cards.insert(card);
  expect(await s.cards.answer("c1", "once", 5)).toBe(true);
  expect(await s.cards.answer("c1", "deny", 6)).toBe(false);
  expect(await s.cards.get("c1")).toMatchObject({
    status: "answered",
    answer: "once",
    answeredAt: 5,
  });
  expect(await s.cards.get("nope")).toBeUndefined();
  s.close();
});

test("open lists, setStatus is guarded, question card round-trips", async () => {
  const s = open();
  await s.cards.insert(card);
  const question = {
    botId: "b",
    botName: "B",
    question: "q?",
    kind: "single" as const,
    options: [{ value: "x", label: "X" }],
    allowText: false,
  };
  await s.cards.insert({
    id: "c2",
    kind: "question",
    wakeId: "w2",
    botId: "b",
    conversationId: "bot:b",
    scopeKey: "b",
    question,
    status: "open",
    createdAt: 2,
  });
  expect((await s.cards.open()).map((c) => c.id)).toEqual(["c1", "c2"]);
  expect((await s.cards.openForScope("b")).map((c) => c.id)).toEqual(["c2"]);
  expect((await s.cards.get("c2"))?.question).toEqual(question);
  expect(await s.cards.setStatus("c1", "answered", "used")).toBe(false);
  expect(await s.cards.setStatus("c1", "open", "withdrawn")).toBe(true);
  expect((await s.cards.open()).map((c) => c.id)).toEqual(["c2"]);
  await s.cards.markReminded("c2", 9);
  expect((await s.cards.get("c2"))?.remindedAt).toBe(9);
  expect(await s.cards.answer("c2", { choices: ["x"], text: "t" }, 10)).toBe(true);
  expect((await s.cards.get("c2"))?.answer).toEqual({ choices: ["x"], text: "t" });
  s.close();
});

test("an answer by text keeps its message id and is found by it", async () => {
  const s = open();
  await s.cards.insert(card);
  await s.cards.insert({ ...card, id: "c2" });
  expect(await s.cards.answer("c1", "once", 5, 42)).toBe(true);
  expect(await s.cards.answer("c2", "deny", 5)).toBe(true);
  const found = await s.cards.answeredByMessage(42);
  expect(found.map((c) => [c.id, c.answeredMessageId])).toEqual([["c1", 42]]);
  expect((await s.cards.get("c2"))?.answeredMessageId).toBeUndefined();
});
