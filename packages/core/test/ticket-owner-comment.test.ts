import { describe, expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

/** A ticket the writer made for the editor, with its first wake settled. */
async function assigned(h: ReturnType<typeof makeHub>) {
  const r = await h.hub.tickets.create(
    { kind: "bot", botId: "writer" },
    { title: "Edit the post", assigneeBotId: "editor" },
  );
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

describe("owner ticket comments", () => {
  test("comment on an open ticket wakes the assignee with the comment", async () => {
    const h = makeHub();
    const t = await assigned(h);
    const before = h.store.wakeMap.size;
    const r = await h.hub.ownerComment(`FRI-${t.number}`, "please shorten it");
    await flush();
    expect(r).toMatchObject({ ok: true, created: true, woke: true });
    expect(h.store.wakeMap.size).toBe(before + 1);
    expect([...h.store.wakeMap.values()].at(-1)?.text).toBe(
      `The owner commented on your ticket FRI-${t.number}: please shorten it. Act on it, reply with a ticket comment, and update its status.`,
    );
  });

  test("comment on a done ticket wakes nobody and says why", async () => {
    const h = makeHub();
    const t = await assigned(h);
    await h.store.tickets.update(t.id, { status: "done" }, 5);
    const before = h.store.wakeMap.size;
    const r = await h.hub.ownerComment(`FRI-${t.number}`, "late");
    await flush();
    expect(r).toMatchObject({
      ok: true,
      woke: false,
      note: "No one was woken: the ticket is finished. Reopen it to continue.",
    });
    expect(h.store.wakeMap.size).toBe(before);
  });

  test("a ticket with no assignee wakes nobody and says why", async () => {
    const h = makeHub();
    const c = await h.hub.tickets.create({ kind: "user" }, { title: "loose" });
    if (!c.ok) throw new Error(c.error);
    const r = await h.hub.ownerComment(`FRI-${c.ticket.number}`, "hi");
    expect(r).toMatchObject({
      ok: true,
      woke: false,
      note: "No one was woken: the ticket has no assignee.",
    });
  });

  test("same commentId twice gives one comment and one wake", async () => {
    const h = makeHub();
    const t = await assigned(h);
    const before = h.store.wakeMap.size;
    const a = await h.hub.ownerComment(`FRI-${t.number}`, "once", { commentId: "c-1" });
    const b = await h.hub.ownerComment(`FRI-${t.number}`, "once", { commentId: "c-1" });
    await flush();
    expect(a).toMatchObject({ created: true });
    expect(b).toMatchObject({ created: false });
    expect(await h.store.tickets.comments(t.id)).toHaveLength(1);
    expect(h.store.wakeMap.size).toBe(before + 1);
  });
});
