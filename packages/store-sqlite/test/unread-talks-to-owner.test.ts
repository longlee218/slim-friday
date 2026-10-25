import { expect, test } from "bun:test";
import { type Author, talksToOwner, WAKE_INTENTS, type WakeRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

/** A done wake in conversation `c`; the matrix overrides the fields that decide who the run talks to. */
const wake = (id: string, over: Partial<WakeRow>): WakeRow => ({
  id,
  chainId: id,
  conversationId: "bot:a",
  targetBot: "a",
  sender: { kind: "user" },
  intent: "request",
  hop: 0,
  text: "t",
  status: "done",
  attempts: 1,
  createdAt: 1,
  scopeKey: "a",
  priority: "interactive",
  leaseFence: 0,
  cuts: 0,
  transientRetries: 0,
  setupFailures: 0,
  nudges: 0,
  ...over,
});

/** Every combination of sender, intent, hand-off, ticket, intro and card resume. */
function matrix(): WakeRow[] {
  const senders: Author[] = [{ kind: "user" }, { kind: "bot", botId: "b" }, { kind: "system" }];
  const rows: WakeRow[] = [];
  let n = 0;
  for (const sender of senders)
    for (const intent of WAKE_INTENTS)
      for (const handoff of [undefined, true])
        for (const ticketId of [undefined, "FRI-1"])
          for (const intro of [undefined, true])
            for (const cardId of [undefined, "k1"])
              rows.push(
                wake(`w${n++}`, {
                  sender,
                  intent,
                  ...(handoff && { handoff }),
                  ...(ticketId && { ticketId }),
                  ...(intro && { intro }),
                  ...(cardId && { cardId }),
                }),
              );
  return rows;
}

test("the unread query and core's talksToOwner agree on every kind of run", async () => {
  for (const row of matrix()) {
    // A fresh store per row: the unread count is then exactly this run's one bot message, or none.
    const s = openEngineStore(":memory:");
    await s.wakes.insert(row);
    await s.messages.append({
      conversationId: "bot:a",
      author: { kind: "bot", botId: "a" },
      text: "answer",
      at: 1,
      wakeId: row.id,
    });
    const unread = await s.reads.unread("bot:a");
    expect({ row: row.id, counts: unread === 1 }).toEqual({
      row: row.id,
      counts: talksToOwner(row),
    });
  }
});

test("a bot's relay of a result or status talks to the owner; a bot request or fyi does not", () => {
  const bot: Author = { kind: "bot", botId: "b" };
  expect(talksToOwner(wake("r", { sender: bot, intent: "result" }))).toBe(true);
  expect(talksToOwner(wake("s", { sender: bot, intent: "status" }))).toBe(true);
  expect(talksToOwner(wake("h", { sender: bot, intent: "request", handoff: true }))).toBe(true);
  expect(talksToOwner(wake("q", { sender: bot, intent: "request" }))).toBe(false);
  expect(talksToOwner(wake("f", { sender: bot, intent: "fyi" }))).toBe(false);
});
