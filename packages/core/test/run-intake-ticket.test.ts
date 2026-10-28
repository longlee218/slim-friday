import { describe, expect, test } from "bun:test";
import type { Ticket, WakeRow } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const OWNER = { kind: "user" } as const;

/** A ticket of group "g" assigned to editor; its first wake settled. */
async function groupTicket(
  h: ReturnType<typeof makeHub>,
  title = "Edit the post",
  extra: { blockedBy?: string[] } = {},
): Promise<Ticket> {
  const r = await h.hub.tickets.create(OWNER, {
    title,
    assigneeBotId: "editor",
    groupId: "g",
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

/** Runs queued after `before` (a snapshot of the wake ids). */
const newRuns = (h: ReturnType<typeof makeHub>, before: Set<string>): WakeRow[] =>
  [...h.store.wakeMap.values()].filter((w) => !before.has(w.id));

/** System lines posted to the group chat. */
const systemLines = (h: ReturnType<typeof makeHub>) =>
  h.surface.posts
    .filter((p) => p.conversationId === "gc" && p.message.author.kind === "system")
    .map((p) => p.message.text);

/** Snapshot of the wake ids so far. */
const ids = (h: ReturnType<typeof makeHub>) => new Set(h.store.wakeMap.keys());

describe("owner group chat about a ticket", () => {
  test("message naming FRI-n becomes a comment and a ticket wake", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    await groupTicket(h, "Other work");
    const before = ids(h);
    await h.hub.handle({ conversationId: "gc", text: `@Editor FRI-${t.number} make it shorter` });
    await flush();
    const comments = await h.store.tickets.comments(t.id);
    expect(comments.map((c) => [c.author.kind, c.body])).toEqual([
      ["user", `@Editor FRI-${t.number} make it shorter`],
    ]);
    const fresh = newRuns(h, before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ conversationId: "dc", ticketId: t.id });
    expect(fresh.some((w) => w.conversationId === "gc")).toBe(false);
    expect(systemLines(h)).toEqual([
      `Added to FRI-${t.number} as a comment; Editor continues it in its ticket work.`,
    ]);
  });

  test("only open ticket is picked without a ref", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const before = ids(h);
    await h.hub.handle({ conversationId: "gc", text: "@Editor also fix the title" });
    await flush();
    expect((await h.store.tickets.comments(t.id)).map((c) => c.body)).toEqual([
      "@Editor also fix the title",
    ]);
    expect(newRuns(h, before).map((w) => [w.conversationId, w.ticketId])).toEqual([["dc", t.id]]);
  });

  test("two open tickets and no ref -> chat session as today", async () => {
    const h = makeHub();
    const a = await groupTicket(h);
    const b = await groupTicket(h, "Other work");
    const before = ids(h);
    await h.hub.handle({ conversationId: "gc", text: "@Editor how is it going?" });
    await flush();
    expect(await h.store.tickets.comments(a.id)).toEqual([]);
    expect(await h.store.tickets.comments(b.id)).toEqual([]);
    expect(newRuns(h, before).map((w) => [w.conversationId, w.ticketId])).toEqual([
      ["gc", undefined],
    ]);
    expect(systemLines(h)).toEqual([]);
  });

  test("message with files or a reply-quote -> chat session as today", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const before = ids(h);
    await h.hub.handle({
      conversationId: "gc",
      text: "@Editor see this",
      files: [{ fileId: "f1", name: "a.png", mimeType: "image/png", size: 1 }],
    });
    const quoted = await h.store.messages.append({
      conversationId: "gc",
      author: { kind: "bot", botId: "editor" },
      text: "draft one",
      at: 0,
    });
    await h.hub.handle({ conversationId: "gc", text: "@Editor shorter", replyTo: quoted });
    await flush();
    expect(await h.store.tickets.comments(t.id)).toEqual([]);
    const fresh = newRuns(h, before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((w) => w.conversationId === "gc" && w.ticketId === undefined)).toBe(true);
  });

  test("finished or waiting ticket is not a target", async () => {
    const h = makeHub();
    const done = await groupTicket(h);
    await h.store.tickets.update(done.id, { status: "done" }, 5);
    const blocker = await h.hub.tickets.create(OWNER, { title: "Blocker", groupId: "g" });
    if (!blocker.ok) throw new Error(blocker.error);
    const waiting = await groupTicket(h, "Later", { blockedBy: [blocker.ticket.id] });
    const before = ids(h);
    await h.hub.handle({
      conversationId: "gc",
      text: `@Editor FRI-${done.number} and FRI-${waiting.number} again`,
    });
    await h.hub.handle({ conversationId: "gc", text: "@Editor no ref" });
    await flush();
    expect(await h.store.tickets.comments(done.id)).toEqual([]);
    expect(await h.store.tickets.comments(waiting.id)).toEqual([]);
    expect(newRuns(h, before).every((w) => w.ticketId === undefined)).toBe(true);
    expect(systemLines(h)).toEqual([]);
  });

  test("replay of the same message gives 1 comment, 1 system line, 1 wake", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const before = ids(h);
    const m = { conversationId: "gc", text: `@Editor FRI-${t.number} once`, clientNonce: "n1" };
    await h.hub.handle(m);
    await flush();
    await h.hub.handle(m);
    await flush();
    expect(await h.store.tickets.comments(t.id)).toHaveLength(1);
    expect(systemLines(h)).toHaveLength(1);
    expect(newRuns(h, before)).toHaveLength(1);
  });

  test("open question card is still answered first", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const asker: WakeRow = {
      id: "asker",
      chainId: "asker",
      conversationId: "gc",
      targetBot: "editor",
      sender: OWNER,
      intent: "request",
      hop: 0,
      text: "earlier",
      status: "waiting_input",
      attempts: 1,
      createdAt: 0,
      scopeKey: "editor@g",
      priority: "interactive",
      leaseFence: 1,
      cuts: 0,
      transientRetries: 0,
      setupFailures: 0,
      nudges: 0,
    };
    await h.store.wakes.insert(asker);
    await h.store.cards.insert({
      id: "q1",
      kind: "question",
      wakeId: "asker",
      botId: "editor",
      conversationId: "gc",
      scopeKey: "editor@g",
      question: {
        botId: "editor",
        botName: "Editor",
        question: "Which one?",
        kind: "single",
        options: [],
        allowText: true,
      },
      status: "open",
      createdAt: 0,
    });
    await h.hub.handle({ conversationId: "gc", text: `@Editor FRI-${t.number} the blue one` });
    await flush();
    expect(h.store.cardMap.get("q1")?.status).toBe("answered");
    expect(await h.store.tickets.comments(t.id)).toEqual([]);
  });

  test("a failure before the comment is saved falls back to the chat session", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    h.store.tickets.addCommentOnce = async () => {
      throw new Error("db down");
    };
    const before = ids(h);
    await h.hub.handle({ conversationId: "gc", text: `@Editor FRI-${t.number} hi` });
    await flush();
    expect(newRuns(h, before).map((w) => [w.conversationId, w.ticketId])).toEqual([
      ["gc", undefined],
    ]);
    expect(h.log.of("hub.ticket_route_failed")).toHaveLength(1);
  });

  test("a failure after the comment is saved does not run the chat session too", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const save = h.store.tickets.addCommentOnce.bind(h.store.tickets);
    h.store.tickets.addCommentOnce = async (c) => {
      await save(c);
      throw new Error("lost the reply");
    };
    const before = ids(h);
    await h.hub.handle({ conversationId: "gc", text: `@Editor FRI-${t.number} hi` });
    await flush();
    expect(await h.store.tickets.comments(t.id)).toHaveLength(1);
    expect(newRuns(h, before).some((w) => w.conversationId === "gc")).toBe(false);
    expect(h.log.of("hub.ticket_route_failed")).toHaveLength(1);
  });

  test("a ref that is not a target -> chat session, even with one other open ticket", async () => {
    const h = makeHub();
    const done = await groupTicket(h, "Old work");
    await h.store.tickets.update(done.id, { status: "done" }, 5);
    const open = await groupTicket(h);
    const before = ids(h);
    await h.hub.handle({ conversationId: "gc", text: `@Editor FRI-${done.number} again?` });
    await flush();
    expect(await h.store.tickets.comments(open.id)).toEqual([]);
    expect(newRuns(h, before).map((w) => [w.conversationId, w.ticketId])).toEqual([
      ["gc", undefined],
    ]);
    // No ref at all: the only open ticket gets it.
    await h.hub.handle({ conversationId: "gc", text: "@Editor and this" });
    await flush();
    expect((await h.store.tickets.comments(open.id)).map((c) => c.body)).toEqual([
      "@Editor and this",
    ]);
  });

  test("a wake lost after the comment is saved is finished by the replay", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const insert = h.store.wakes.insertDeduped.bind(h.store.wakes);
    let fail = true;
    h.store.wakes.insertDeduped = async (w) => {
      if (fail) {
        fail = false;
        throw new Error("crash");
      }
      return insert(w);
    };
    const before = ids(h);
    const m = { conversationId: "gc", text: `@Editor FRI-${t.number} once`, clientNonce: "n1" };
    await h.hub.handle(m);
    await flush();
    expect(newRuns(h, before)).toHaveLength(0);
    await h.hub.handle(m);
    await flush();
    await h.hub.handle(m);
    await flush();
    expect(await h.store.tickets.comments(t.id)).toHaveLength(1);
    expect(newRuns(h, before).map((w) => [w.conversationId, w.ticketId])).toEqual([["dc", t.id]]);
    expect(systemLines(h)).toHaveLength(1);
  });

  test("a group line lost after the comment is saved is not posted twice by the replay", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    const post = h.surface.post.bind(h.surface);
    h.surface.post = async (c, msg) => {
      if (msg.author.kind === "system") throw new Error("surface down");
      return post(c, msg);
    };
    const before = ids(h);
    const m = { conversationId: "gc", text: `@Editor FRI-${t.number} once`, clientNonce: "n1" };
    await h.hub.handle(m);
    await flush();
    h.surface.post = post;
    await h.hub.handle(m);
    await flush();
    const stored = (await h.store.messages.recent("gc", 50)).filter(
      (x) => x.author.kind === "system",
    );
    expect(stored).toHaveLength(1);
    expect(newRuns(h, before)).toHaveLength(1);
    expect(await h.store.tickets.comments(t.id)).toHaveLength(1);
  });
});
