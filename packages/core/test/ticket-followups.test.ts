import { describe, expect, test } from "bun:test";
import type { Author, Ticket } from "../src";
import type { HubContext } from "../src/hub/hub-context";
import { followUpStatus } from "../src/hub/ticket-followups";
import { bot, flush, makeHub } from "./bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;

const WRITER: Author = { kind: "bot", botId: "writer" };
const EDITOR: Author = { kind: "bot", botId: "editor" };
const OWNER: Author = { kind: "user" };

/** The hub's shared context (private), for replaying a status change. */
const ctxOf = (h: Hub) => (h.hub as unknown as { ctx: HubContext }).ctx;

/** A hub where writer also has a direct conversation "wc". */
function hubWithWriterDm(): Hub {
  const h = makeHub();
  h.store.convMap.set("wc", { id: "wc", kind: "direct", botId: "writer" });
  return h;
}

/** A ticket in group g made by `by` for editor; wake side effects settled. */
async function ticketFor(
  h: Hub,
  by: Author = WRITER,
  extra: { groupId?: string } = { groupId: "g" },
) {
  const r = await h.hub.tickets.create(by, {
    title: "Edit the post",
    assigneeBotId: "editor",
    ...extra,
  });
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

/** The stored wake rows aimed at `botId`, oldest first. */
const wakesTo = (h: Hub, botId: string) =>
  [...h.store.wakeMap.values()].filter((w) => w.targetBot === botId);

/** Set a status and let the follow-up wakes settle. */
async function setStatus(
  h: Hub,
  actor: Author,
  t: Ticket,
  status: Ticket["status"],
  blockedReason?: string,
) {
  const r = await h.hub.tickets.update(actor, {
    id: t.id,
    status,
    ...(blockedReason && { blockedReason }),
  });
  await flush();
  return r;
}

describe("ticket follow-ups", () => {
  test("assignee review wakes the creator once", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    await setStatus(h, EDITOR, t, "review");
    const rows = wakesTo(h, "writer");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ conversationId: "wc", ticketId: t.id, sender: EDITOR, hop: 1 });
    expect(rows[0]?.text.startsWith(`Ticket FRI-${t.number} is ready for your review`)).toBe(true);
    expect(rows[0]?.text).toContain("Last comment: (no comment)");
    // Replaying the same saved event finds the first run.
    const ev = (await h.store.ticketEvents.list(t.id)).filter((e) => e.kind === "status").at(-1);
    const saved = (await h.store.tickets.get(t.id)) as Ticket;
    await followUpStatus(ctxOf(h), saved, {
      from: "todo",
      actor: EDITOR,
      eventId: ev?.id ?? "",
      assigneeChanged: false,
    });
    await flush();
    expect(wakesTo(h, "writer")).toHaveLength(1);
  });

  test("assignee blocked wakes the creator with the reason", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    await setStatus(h, EDITOR, t, "blocked", "need the API key");
    const rows = wakesTo(h, "writer");
    expect(rows.map((w) => w.text)).toEqual([
      `Ticket FRI-${t.number} is blocked: need the API key. Unblock it (answer, re-assign, or ask the owner), or close it.`,
    ]);
  });

  test("system auto-block wakes the creator", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    await setStatus(h, { kind: "system" }, t, "blocked", "left open");
    const rows = wakesTo(h, "writer");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sender: { kind: "system" }, hop: 0, ticketId: t.id });
  });

  test("creator done wakes nobody", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    await setStatus(h, EDITOR, t, "review");
    const before = h.store.wakeMap.size;
    const r = await setStatus(h, WRITER, t, "done");
    expect(r.ok).toBe(true);
    expect(h.store.wakeMap.size).toBe(before);
  });

  test("send back wakes the assignee", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    await setStatus(h, EDITOR, t, "review");
    await h.hub.tickets.comment(WRITER, { id: t.id, body: "add tests" });
    await setStatus(h, WRITER, t, "todo");
    const back = wakesTo(h, "editor").filter((w) => w.text.includes("was sent back"));
    expect(back.map((w) => w.text)).toEqual([
      `Ticket FRI-${t.number} was sent back to you: add tests. Fix it and set it to review.`,
    ]);
    expect(back[0]).toMatchObject({ conversationId: "dc", ticketId: t.id, sender: WRITER });
  });

  test("owner send back wakes the original assignee once", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    await setStatus(h, EDITOR, t, "blocked", "need the API key");
    await setStatus(h, OWNER, t, "todo");
    const back = wakesTo(h, "editor").filter((w) => w.text.includes("was sent back"));
    expect(back.map((w) => w.text)).toEqual([
      `Ticket FRI-${t.number} was sent back to you: (no comment). Fix it and set it to review.`,
    ]);
    expect(back[0]).toMatchObject({ conversationId: "dc", sender: OWNER });
  });

  test("a send back that re-assigns wakes the new assignee once with the ticket text", async () => {
    const h = hubWithWriterDm();
    h.store.botMap.set("critic", bot("critic", "Critic"));
    h.store.convMap.set("cc", { id: "cc", kind: "direct", botId: "critic" });
    const g = h.store.groupMap.get("g");
    if (!g) throw new Error("no group");
    h.store.groupMap.set("g", { ...g, members: [...g.members, "critic"] });
    const t = await ticketFor(h);
    await setStatus(h, EDITOR, t, "review");
    const r = await h.hub.tickets.update(WRITER, {
      id: t.id,
      status: "todo",
      assigneeBotId: "critic",
    });
    expect(r.ok).toBe(true);
    await flush();
    expect(wakesTo(h, "critic").map((w) => w.text)).toEqual([
      `Work on ticket FRI-${t.number}. Read it with TicketGet. Keep progress in ticket comments and update its status with TicketUpdate. Use ask or approval cards when owner input is needed.`,
    ]);
    expect(wakesTo(h, "editor").filter((w) => w.text.includes("was sent back"))).toEqual([]);
  });

  test("owner-created ticket review wakes no bot", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h, OWNER);
    const before = h.store.wakeMap.size;
    await setStatus(h, EDITOR, t, "review");
    expect(h.store.wakeMap.size).toBe(before);
  });

  test("owner-created direct ticket review tells its conversation", async () => {
    const h = hubWithWriterDm();
    const r = await h.hub.tickets.create(OWNER, {
      title: "Edit the post",
      assigneeBotId: "editor",
      conversationId: "dc",
    });
    if (!r.ok) throw new Error(r.error);
    await flush();
    await setStatus(h, EDITOR, r.ticket, "review");
    const lines = h.surface.posts
      .filter((p) => p.conversationId === "dc")
      .map((p) => p.message.text);
    expect(lines).toEqual([`FRI-${r.ticket.number} is ready for your review: Edit the post`]);
  });

  test("self-assigned review wakes nobody", async () => {
    const h = hubWithWriterDm();
    const r = await h.hub.tickets.create(EDITOR, { title: "Mine", groupId: "g" });
    if (!r.ok) throw new Error(r.error);
    await flush();
    const before = h.store.wakeMap.size;
    await setStatus(h, EDITOR, r.ticket, "review");
    expect(h.store.wakeMap.size).toBe(before);
  });

  test("creator left the group", async () => {
    const h = hubWithWriterDm();
    const t = await ticketFor(h);
    const g = h.store.groupMap.get("g");
    if (!g) throw new Error("no group");
    h.store.groupMap.set("g", { ...g, members: ["editor"] });
    const r = await setStatus(h, EDITOR, t, "review");
    expect(r.ok).toBe(true);
    expect(wakesTo(h, "writer")).toEqual([]);
    expect(h.log.lines.filter((l) => l.msg === "hub.ticket_creator_gone")).toMatchObject([
      { level: "warn", fields: { ticketId: t.id, botId: "writer" } },
    ]);
  });
});
