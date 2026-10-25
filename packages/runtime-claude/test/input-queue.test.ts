import { expect, test } from "bun:test";
import type { InboundTurn, StoredMessage } from "@friday/core";
import { currentTimeText } from "../src/session/current-time";
import { formatTurn } from "../src/session/format-turn";
import { createInputQueue } from "../src/session/input-queue";

/** Next value of an async iterator, as the text of the user message. */
async function nextText(it: AsyncIterator<{ message: { content: unknown } }>): Promise<unknown> {
  const r = await it.next();
  return r.done ? "<done>" : r.value.message.content;
}

test("push before and after a consumer starts yields in order", async () => {
  const q = createInputQueue();
  q.push("a");
  const it = q.iterable[Symbol.asyncIterator]();
  q.push("b");
  expect(await nextText(it)).toBe("a");
  expect(await nextText(it)).toBe("b");
});

test("a pending next resolves when a message is pushed", async () => {
  const q = createInputQueue();
  const it = q.iterable[Symbol.asyncIterator]();
  const pending = nextText(it);
  q.push("late");
  expect(await pending).toBe("late");
});

test("close ends the iteration after the queue drains", async () => {
  const q = createInputQueue();
  q.push("a");
  q.close();
  const it = q.iterable[Symbol.asyncIterator]();
  expect(await nextText(it)).toBe("a");
  expect(await nextText(it)).toBe("<done>");
});

test("close wakes a waiting consumer", async () => {
  const q = createInputQueue();
  const it = q.iterable[Symbol.asyncIterator]();
  const pending = nextText(it);
  q.close();
  expect(await pending).toBe("<done>");
});

test("push after close is ignored", async () => {
  const q = createInputQueue();
  q.close();
  q.push("x");
  const it = q.iterable[Symbol.asyncIterator]();
  expect(await nextText(it)).toBe("<done>");
});

const msg = (author: StoredMessage["author"], text: string): StoredMessage => ({
  conversationId: "c1",
  author,
  text,
  at: 0,
});
const turn = (over: Partial<InboundTurn>): InboundTurn => ({
  conversationId: "c1",
  from: { kind: "user" },
  text: "hello",
  hop: 0,
  context: [],
  now: 0,
  timeZone: "UTC",
  ...over,
});
const names = { b1: "Ann", b2: "Bob" };

/** The time line every turn ends with (clock 0, UTC). */
const TIME = currentTimeText(0, "UTC");

test("a direct turn has the header and the text, then the time line", () => {
  expect(formatTurn(turn({}), names)).toBe(`[conversation c1] user (hop 0):\nhello\n\n${TIME}`);
});

test("a bot sender is named from the names map, an unknown bot by its id", () => {
  expect(formatTurn(turn({ from: { kind: "bot", botId: "b1" } }), names)).toStartWith(
    "[conversation c1] Ann (hop 0):",
  );
  expect(formatTurn(turn({ from: { kind: "bot", botId: "zz" } }), names)).toStartWith(
    "[conversation c1] zz (hop 0):",
  );
  expect(formatTurn(turn({ from: { kind: "system" } }), names)).toStartWith(
    "[conversation c1] system (hop 0):",
  );
});

test("context omits the last message when it duplicates the turn", () => {
  const out = formatTurn(
    turn({
      hop: 1,
      context: [msg({ kind: "bot", botId: "b2" }, "earlier"), msg({ kind: "user" }, "hello")],
    }),
    names,
  );
  expect(out).toBe(
    `[conversation c1] user (hop 1):\nhello\n\nRecent messages:\nBob: earlier\n\n${TIME}`,
  );
});

test("context keeps the last message when it differs from the turn", () => {
  const out = formatTurn(turn({ context: [msg({ kind: "user" }, "other")] }), names);
  expect(out).toContain("Recent messages:\nuser: other\n");
  expect(out).toStartWith("[conversation c1] user (hop 0):\nhello\n\n");
});
