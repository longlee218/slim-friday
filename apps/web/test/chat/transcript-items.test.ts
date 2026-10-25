import { expect, test } from "vitest";
import { buildTranscriptItems } from "../../src/components/chat/transcript-items";
import { anchoredScrollTop } from "../../src/components/chat/transcript-scroll";
import type { Receipt } from "../../src/events/client-keys";
import { apprCard, askCard } from "./cards-fixtures";
import { msg, NOW } from "./fixtures";

const DAY = 86_400_000;
const base = {
  approvals: [],
  questions: [],
  receipts: {},
  runs: {},
  conversationId: "bot:dev",
};

test("items are oldest first with day lines", () => {
  // Pages are newest first and so is each page.
  const pages = [
    [msg({ id: 3, at: NOW }), msg({ id: 2, at: NOW - 1000 })],
    [msg({ id: 1, at: NOW - 2 * DAY })],
  ];
  const items = buildTranscriptItems({ ...base, pages });
  expect(items.map((i) => i.kind)).toEqual(["day", "message", "day", "message", "message"]);
  const ids = items.flatMap((i) => (i.kind === "message" ? [i.message.id] : []));
  expect(ids).toEqual([1, 2, 3]);
  expect(items.map((i) => i.key)).toEqual([
    `d:${new Date(NOW - 2 * DAY).setHours(0, 0, 0, 0)}`,
    "m:1",
    `d:${new Date(NOW).setHours(0, 0, 0, 0)}`,
    "m:2",
    "m:3",
  ]);
});

test("live runs, then pending cards, come after messages", () => {
  const items = buildTranscriptItems({
    ...base,
    pages: [[msg({ id: 1 })]],
    approvals: [apprCard()],
    runs: { dev: { botId: "dev", startedAt: 0, steps: [] } },
  });
  expect(items.slice(-2).map((i) => i.kind)).toEqual(["run", "approval"]);
  expect(items.slice(-2).map((i) => i.key)).toEqual(["r:dev", "a:a1"]);
});

test("question receipts of another conversation are left out", () => {
  const here: Receipt = {
    kind: "question",
    card: askCard({ cardId: "q1", conversationId: "bot:dev" }),
    answer: null,
  };
  const other: Receipt = {
    kind: "question",
    card: askCard({ cardId: "q9", conversationId: "bot:pia" }),
    answer: null,
  };
  const items = buildTranscriptItems({
    ...base,
    pages: [[]],
    receipts: { q1: here, q9: other },
  });
  expect(items.map((i) => i.key)).toEqual(["q:q1"]);
  expect(items[0]).toMatchObject({ kind: "question", receipt: here });
});

test("an answered approval leaves the transcript, even if its card is still pending", () => {
  const done: Receipt = { kind: "approval", card: apprCard(), answer: "once" };
  const items = buildTranscriptItems({
    ...base,
    pages: [[]],
    approvals: [apprCard()],
    receipts: { a1: done },
  });
  expect(items).toEqual([]);
});

test("a pending card of another conversation is left out and pending sends are marked", () => {
  const items = buildTranscriptItems({
    ...base,
    pages: [[msg({ id: -1 })]],
    pending: { [-1]: "failed" },
    approvals: [apprCard({ conversationId: "bot:pia" })],
    questions: [askCard({ conversationId: "bot:dev" })],
  });
  expect(items.map((i) => i.kind)).toEqual(["day", "message", "question"]);
  expect(items[1]).toMatchObject({ pending: "failed" });
});

test("a message id on two pages shows once", () => {
  const m = msg({ id: 5 });
  const items = buildTranscriptItems({ ...base, pages: [[m], [m]] });
  expect(items.filter((i) => i.kind === "message")).toHaveLength(1);
});

test("older pages keep the visible message in place", () => {
  // 1000 px of history added above: the offset grows by exactly that.
  expect(anchoredScrollTop(120, 3000, 4000)).toBe(1120);
  expect(anchoredScrollTop(120, 3000, 3000)).toBe(120);
});

test("pin decisions: open once, follow only at the bottom, stay with no rows", async () => {
  const { pinAction } = await import("../../src/components/chat/transcript-scroll");
  expect(pinAction({ started: false, hasRows: true, following: true })).toBe("open");
  expect(pinAction({ started: true, hasRows: true, following: true })).toBe("follow");
  expect(pinAction({ started: true, hasRows: true, following: false })).toBe("stay");
  expect(pinAction({ started: false, hasRows: false, following: true })).toBe("stay");
});
