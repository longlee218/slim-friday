import { describe, expect, test } from "bun:test";
import type { Ticket } from "../src/tickets/ticket";
import { flush, makeHub } from "./bot-hub-harness";

const OWNER = { kind: "user" } as const;
type Hub = ReturnType<typeof makeHub>;

/** A group ticket made by the owner; optional assignee and blockers (refs). */
async function make(h: Hub, title: string, o: { assignee?: string; blockedBy?: string[] } = {}) {
  const r = await h.hub.tickets.create(OWNER, {
    title,
    groupId: "g",
    ...(o.assignee && { assigneeBotId: o.assignee }),
    ...(o.blockedBy && { blockedBy: o.blockedBy }),
  });
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

const ref = (t: Ticket) => `FRI-${t.number}`;
/** The runs queued for ticket `t`. */
const wakesOf = (h: Hub, t: Ticket) =>
  [...h.store.wakeMap.values()].filter((w) => w.ticketId === t.id);
/** The system messages posted to group g. */
const groupTexts = (h: Hub) =>
  h.surface.posts.filter((p) => p.conversationId === "group:g").map((p) => p.message.text);

async function setStatus(h: Hub, t: Ticket, status: "done" | "closed" | "doing") {
  const r = await h.hub.tickets.update(OWNER, { id: t.id, status });
  if (!r.ok) throw new Error(r.error);
  await flush();
}

describe("ticket dependencies: refusals", () => {
  test("an unknown ref is refused by name", async () => {
    const h = makeHub();
    const r = await h.hub.tickets.create(OWNER, { title: "c", blockedBy: ["FRI-9"] });
    expect(r).toEqual({ ok: false, code: "invalid", error: "Unknown ticket FRI-9." });
  });

  test("a ticket cannot wait on itself", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const r = await h.hub.tickets.update(OWNER, { id: a.id, blockedBy: [ref(a)] });
    expect(r).toEqual({ ok: false, code: "invalid", error: "A ticket cannot wait on itself." });
  });

  test("a cycle is refused, naming the blocker that already waits", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b");
    expect(await h.hub.tickets.update(OWNER, { id: a.id, blockedBy: [ref(b)] })).toMatchObject({
      ok: true,
    });
    const r = await h.hub.tickets.update(OWNER, { id: b.id, blockedBy: [ref(a)] });
    expect(r).toEqual({
      ok: false,
      code: "invalid",
      error: `${ref(a)} already waits on this ticket.`,
    });
  });

  test("more than 10 blockers is refused", async () => {
    const h = makeHub();
    const refs: string[] = [];
    for (let i = 0; i < 11; i++) refs.push(ref(await make(h, `t${i}`)));
    const r = await h.hub.tickets.create(OWNER, { title: "c", blockedBy: refs });
    expect(r).toEqual({ ok: false, code: "invalid", error: "At most 10 blockers." });
  });

  test("a started ticket cannot wait on other tickets", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor" });
    await setStatus(h, c, "doing");
    const r = await h.hub.tickets.update(OWNER, { id: c.id, blockedBy: [ref(a)] });
    expect(r).toEqual({
      ok: false,
      code: "invalid",
      error: "A started ticket cannot wait on other tickets.",
    });
  });
});

describe("ticket dependencies: graph", () => {
  test("a ticket that starts in the same update cannot wait", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor" });
    const r = await h.hub.tickets.update(OWNER, { id: c.id, status: "doing", blockedBy: [ref(a)] });
    expect(r).toEqual({
      ok: false,
      code: "invalid",
      error: "A started ticket cannot wait on other tickets.",
    });
  });

  test("a transitive cycle is refused", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b");
    const c = await make(h, "c");
    await h.hub.tickets.update(OWNER, { id: a.id, blockedBy: [ref(b)] });
    await h.hub.tickets.update(OWNER, { id: b.id, blockedBy: [ref(c)] });
    const r = await h.hub.tickets.update(OWNER, { id: c.id, blockedBy: [ref(a)] });
    expect(r).toEqual({
      ok: false,
      code: "invalid",
      error: `${ref(a)} already waits on this ticket.`,
    });
  });

  test("a diamond is accepted", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b", { blockedBy: [ref(a)] });
    const c = await make(h, "c", { blockedBy: [ref(a)] });
    const d = await make(h, "d", { blockedBy: [ref(b), ref(c)] });
    expect(d.blockedBy).toEqual([b.id, c.id]);
  });
});

describe("ticket dependencies: wait ends on update", () => {
  test("clearing blockedBy on a waiting ticket wakes the assignee once", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    await h.hub.tickets.update(OWNER, { id: c.id, blockedBy: [] });
    await flush();
    expect(wakesOf(h, c)).toHaveLength(1);
    expect(wakesOf(h, c)[0]?.targetBot).toBe("editor");
    // A later finish of the removed blocker wakes nobody.
    await setStatus(h, a, "done");
    expect(wakesOf(h, c)).toHaveLength(1);
  });

  test("swapping in finished blockers wakes once", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b");
    await setStatus(h, b, "done");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    await h.hub.tickets.update(OWNER, { id: c.id, blockedBy: [ref(b)] });
    await flush();
    expect(wakesOf(h, c)).toHaveLength(1);
    await setStatus(h, b, "closed");
    expect(wakesOf(h, c)).toHaveLength(1);
  });

  test("shrinking but still waiting wakes nobody", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a), ref(b)] });
    await h.hub.tickets.update(OWNER, { id: c.id, blockedBy: [ref(b)] });
    await flush();
    expect(wakesOf(h, c)).toHaveLength(0);
  });

  test("the assignee ending its own wait is not woken", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    await h.hub.tickets.update({ kind: "bot", botId: "editor" }, { id: c.id, blockedBy: [] });
    await flush();
    expect(wakesOf(h, c)).toHaveLength(0);
  });
});

describe("ticket dependencies: wakes", () => {
  test("waiting ticket does not wake its assignee at create", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    expect(c.blockedBy).toEqual([a.id]);
    expect(wakesOf(h, c)).toHaveLength(0);
  });

  test("re-assigning a waiting ticket does not wake", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { blockedBy: [ref(a)] });
    const r = await h.hub.tickets.update(OWNER, { id: c.id, assigneeBotId: "editor" });
    await flush();
    expect(r).toMatchObject({ ok: true });
    expect(wakesOf(h, c)).toHaveLength(0);
  });

  test("last blocker done wakes the dependent once", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a), ref(b)] });
    await setStatus(h, a, "done");
    expect(wakesOf(h, c)).toHaveLength(0);
    await setStatus(h, b, "done");
    const wakes = wakesOf(h, c);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.targetBot).toBe("editor");
    expect(wakes[0]?.text).toBe(
      `Work on ticket ${ref(c)}. Read it with TicketGet. Keep progress in ticket comments and update its status with TicketUpdate. Use ask or approval cards when owner input is needed.`,
    );
    expect(groupTexts(h)).toContain(`${ref(c)} is ready to start (${ref(a)}, ${ref(b)} finished)`);
  });

  test("closed blocker releases with a note", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    await setStatus(h, a, "closed");
    const wakes = wakesOf(h, c);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toEndWith(
      `\n${ref(a)}, which this waited on, was closed without being done.`,
    );
  });

  test("all blockers already finished at create wakes at once", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    await setStatus(h, a, "done");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    expect(wakesOf(h, c)).toHaveLength(1);
  });

  test("blocker done then closed wakes the dependent once", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    await setStatus(h, a, "done");
    await setStatus(h, a, "closed");
    expect(wakesOf(h, c)).toHaveLength(1);
    expect(groupTexts(h).filter((t) => t.includes("is ready to start"))).toHaveLength(1);
  });

  test("a dependent that is not todo is not woken", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    await h.store.tickets.update(c.id, { status: "closed" }, 5);
    await setStatus(h, a, "done");
    expect(wakesOf(h, c)).toHaveLength(0);
  });

  test("a failing release wake is logged and the blocker still finishes", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    await make(h, "c", { assignee: "editor", blockedBy: [ref(a)] });
    h.store.wakes.insertDeduped = async () => {
      throw new Error("db down");
    };
    const r = await h.hub.tickets.update(OWNER, { id: a.id, status: "done" });
    await flush();
    expect(r).toMatchObject({ ok: true });
    expect(h.log.of("hub.ticket_wake_failed")).toHaveLength(1);
  });

  test("owner comment on a waiting ticket wakes nobody and names the blockers", async () => {
    const h = makeHub();
    const a = await make(h, "a");
    const b = await make(h, "b");
    const c = await make(h, "c", { assignee: "editor", blockedBy: [ref(a), ref(b)] });
    const r = await h.hub.ownerComment(ref(c), "any news?");
    await flush();
    expect(r).toMatchObject({
      ok: true,
      created: true,
      woke: false,
      note: `No one was woken: the ticket waits on ${ref(a)}, ${ref(b)}.`,
    });
    expect((await h.store.tickets.comments(c.id)).map((x) => x.body)).toEqual(["any news?"]);
    expect(wakesOf(h, c)).toHaveLength(0);
  });
});
