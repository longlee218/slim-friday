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

test("a reaction folds under its target and is no row of its own", () => {
  const react = (id: number, text: string, to: number) =>
    msg({
      id,
      author: { kind: "user" },
      text,
      replyTo: { messageId: to, excerpt: "" },
    });
  const items = buildTranscriptItems({
    ...base,
    pages: [[react(4, "👍", 1), react(3, "👍", 1), react(2, "🎉", 1), msg({ id: 1 })]],
  });
  const rows = items.filter((i) => i.kind === "message");
  expect(rows.map((i) => i.message.id)).toEqual([1]);
  expect(rows[0]?.reactions).toEqual({ "👍": 2, "🎉": 1 });
});

test("a reaction whose target is not loaded, or plain text, stays a row", () => {
  const items = buildTranscriptItems({
    ...base,
    pages: [
      [
        msg({
          id: 3,
          author: { kind: "user" },
          text: "👍",
          replyTo: { messageId: 99, excerpt: "" },
        }),
        msg({
          id: 2,
          author: { kind: "user" },
          text: "thanks",
          replyTo: { messageId: 1, excerpt: "" },
        }),
        msg({ id: 1 }),
      ],
    ],
  });
  expect(items.filter((i) => i.kind === "message").map((i) => i.message.id)).toEqual([1, 2, 3]);
});

test("consecutive messages of one author form a run; a card or a long gap breaks it", () => {
  const MIN = 60_000;
  const user = { kind: "user" as const };
  const pages = [
    [
      msg({ id: 6, at: NOW }),
      msg({ id: 5, at: NOW - 20 * MIN }),
      msg({ id: 4, at: NOW - 21 * MIN }),
      msg({ id: 3, at: NOW - 22 * MIN, author: user }),
      msg({ id: 2, at: NOW - 23 * MIN, author: user }),
      msg({ id: 1, at: NOW - 24 * MIN, author: user }),
    ],
  ];
  const items = buildTranscriptItems({
    ...base,
    pages,
    runs: { dev: { botId: "dev", startedAt: 0, steps: [] } },
    approvals: [apprCard()],
  });
  const places = items.flatMap((i) =>
    i.kind === "message" || i.kind === "run" ? [[i.key, i.place?.head, i.place?.tail]] : [],
  );
  expect(places).toEqual([
    ["m:1", true, false],
    ["m:2", false, false],
    ["m:3", false, true],
    ["m:4", true, false],
    ["m:5", false, true],
    // Twenty minutes later: a new run, joined by the live run of the same bot.
    ["m:6", true, false],
    ["r:dev", false, true],
  ]);
});
