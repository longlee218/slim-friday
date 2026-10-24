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

test("pending cards and live runs come after messages", () => {
  const items = buildTranscriptItems({
    ...base,
    pages: [[msg({ id: 1 })]],
    approvals: [apprCard()],
    runs: { dev: { botId: "dev", startedAt: 0, steps: [] } },
  });
  expect(items.slice(-2).map((i) => i.kind)).toEqual(["approval", "run"]);
  expect(items.slice(-2).map((i) => i.key)).toEqual(["a:a1", "r:dev"]);
});

test("receipts of another conversation are left out", () => {
  const here: Receipt = { kind: "approval", card: apprCard(), answer: "once" };
  const other: Receipt = {
    kind: "question",
    card: askCard({ cardId: "q9", conversationId: "bot:pia" }),
    answer: null,
  };
  const items = buildTranscriptItems({
    ...base,
    pages: [[]],
    receipts: { a1: here, q9: other },
  });
  expect(items.map((i) => i.key)).toEqual(["a:a1"]);
  expect(items[0]).toMatchObject({ kind: "approval", receipt: here });
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
