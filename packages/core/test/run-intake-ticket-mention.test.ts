import { describe, expect, test } from "bun:test";
import type { Ticket, WakeRow } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;

/** A hub where the entry bot (writer) has a direct chat "dw" and one open ticket of group "g". */
async function setup(): Promise<{ h: Hub; t: Ticket; before: Set<string> }> {
  const h = makeHub();
  h.store.convMap.set("dw", { id: "dw", kind: "direct", botId: "writer" });
  const r = await h.hub.tickets.create(
    { kind: "user" },
    { title: "Draft the post", assigneeBotId: "writer", groupId: "g" },
  );
  if (!r.ok) throw new Error(r.error);
  await flush();
  return { h, t: r.ticket, before: new Set(h.store.wakeMap.keys()) };
}

/** Runs queued after `before`, as [conversation, ticket]. */
const newRuns = (h: Hub, before: Set<string>) =>
  [...h.store.wakeMap.values()]
    .filter((w: WakeRow) => !before.has(w.id))
    .map((w) => [w.conversationId, w.ticketId]);

/** System lines posted to the group chat. */
const systemLines = (h: Hub) =>
  h.surface.posts
    .filter((p) => p.conversationId === "gc" && p.message.author.kind === "system")
    .map((p) => p.message.text);

describe("owner group chat reaches a ticket only when the bot is addressed", () => {
  test("no mention and no ref -> chat session, even with one open ticket", async () => {
    const { h, t, before } = await setup();
    await h.hub.handle({ conversationId: "gc", text: "xong chưa?" });
    await flush();
    expect(await h.store.tickets.comments(t.id)).toEqual([]);
    expect(newRuns(h, before)).toEqual([["gc", undefined]]);
    expect(systemLines(h)).toEqual([]);
  });

  test("no mention but naming the bot's open FRI-n -> routed to it", async () => {
    const { h, t, before } = await setup();
    await h.hub.handle({ conversationId: "gc", text: `FRI-${t.number} xong chưa?` });
    await flush();
    expect((await h.store.tickets.comments(t.id)).map((c) => c.body)).toEqual([
      `FRI-${t.number} xong chưa?`,
    ]);
    expect(newRuns(h, before)).toEqual([["dw", t.id]]);
  });

  test("a mention and no ref -> the bot's only open ticket", async () => {
    const { h, t, before } = await setup();
    await h.hub.handle({ conversationId: "gc", text: "@Writer xong chưa?" });
    await flush();
    expect((await h.store.tickets.comments(t.id)).map((c) => c.body)).toEqual([
      "@Writer xong chưa?",
    ]);
    expect(newRuns(h, before)).toEqual([["dw", t.id]]);
  });
});
