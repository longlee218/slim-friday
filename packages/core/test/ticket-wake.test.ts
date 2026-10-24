import { describe, expect, test } from "bun:test";
import type { Ticket } from "../src";
import { flush, makeHub } from "./bot-hub-harness";

const WAKE = (n: number) =>
  `Work on ticket FRI-${n}. Read it with TicketGet. Keep progress in ticket comments and update its status with TicketUpdate. Ask the owner when input is needed.`;
const REWAKE = (n: number) =>
  `Your ticket FRI-${n} is still open. Finish it, or set it to blocked and comment why.`;

/** A ticket the writer made for the editor (wakes the editor in its direct chat). */
async function assigned(h: ReturnType<typeof makeHub>, title = "Edit the post") {
  const r = await h.hub.tickets.create(
    { kind: "bot", botId: "writer" },
    { title, assigneeBotId: "editor" },
  );
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

describe("ticket wakes", () => {
  test("wakeForTicket sends the exact ticket wake text to the assignee's direct conversation and posts nothing", async () => {
    const h = makeHub();
    const t = await assigned(h);
    const sent = h.runtime.nth(0).sent[0];
    expect(sent).toMatchObject({ conversationId: "dc", text: WAKE(t.number) });
    expect(h.surface.posts.filter((p) => p.conversationId === "dc")).toEqual([]);
    const row = [...h.store.wakeMap.values()][0];
    expect(row).toMatchObject({ ticketId: t.id, targetBot: "editor", status: "running" });
  });

  test("a done ticket is not woken", async () => {
    const h = makeHub();
    const t = (await h.store.tickets.create({
      title: "x",
      status: "done",
      priority: "normal",
      createdBy: { kind: "user" },
      createdAt: 1,
    })) as Ticket;
    await h.hub.wakeForTicket(t, "editor");
    await flush();
    expect(h.store.wakeMap.size).toBe(0);
  });

  test("a bot without a direct conversation gets a dropped wake", async () => {
    const h = makeHub();
    h.store.convMap.delete("dc");
    await assigned(h);
    expect([...h.store.wakeMap.values()].map((w) => w.status)).toEqual(["dropped"]);
  });

  test("a wake whose text names FRI-1 carries a tickets block with that ticket", async () => {
    const h = makeHub();
    const t = await assigned(h, "First one");
    await h.hub.tickets.comment({ kind: "user" }, { id: t.id, body: "see the draft" });
    await h.hub.tickets.update({ kind: "bot", botId: "editor" }, { id: t.id, status: "review" });
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    h.surface.deliver({ conversationId: "dc", text: "how is FRI-1 going?" });
    await flush();
    const turn = h.runtime.nth(0).sent.find((x) => x.text.includes("how is FRI-1"));
    expect(turn?.tickets).toContain("FRI-1 [review]");
    expect(turn?.tickets).toContain("First one");
    expect(turn?.tickets).toContain("see the draft");
  });
});

describe("unfinished tickets", () => {
  test("a ticket still todo at turn end re-wakes the assignee once with rewake true", async () => {
    const h = makeHub();
    const t = await assigned(h);
    const ed = h.runtime.nth(0);
    ed.emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(ed.sent[1]).toMatchObject({ text: REWAKE(t.number) });
    const rows = [...h.store.wakeMap.values()];
    expect(rows.find((w) => w.rewake)).toMatchObject({ ticketId: t.id });
  });

  test("an assignee that set the ticket to review gets no re-wake", async () => {
    const h = makeHub();
    const t = await assigned(h);
    await h.hub.tickets.update({ kind: "bot", botId: "editor" }, { id: t.id, status: "review" });
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(h.runtime.nth(0).sent).toHaveLength(1);
  });

  test("second turn end still open: ticket blocked, comment added, notice posted, no third wake", async () => {
    const h = makeHub();
    const t = await assigned(h);
    const ed = h.runtime.nth(0);
    ed.emit({ type: "turn_end", costUsd: 0 });
    await flush();
    ed.emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(ed.sent).toHaveLength(2);
    const after = await h.store.tickets.get(t.id);
    expect(after?.status).toBe("blocked");
    const comments = await h.store.tickets.comments(t.id);
    expect(comments.at(-1)?.body).toBe("Left open after two turns; blocked automatically.");
    expect(
      h.surface.posts.some(
        (p) => p.conversationId === "dc" && p.message.text.includes(`FRI-${t.number}`),
      ),
    ).toBe(true);
  });

  test("an errored turn gets no re-wake", async () => {
    const h = makeHub();
    await assigned(h);
    h.runtime.nth(0).emit({ type: "error", message: "boom", retryable: false });
    await flush();
    expect(h.runtime.opened.length).toBe(1);
    expect(h.runtime.nth(0).sent).toHaveLength(1);
  });
});
