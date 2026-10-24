import { describe, expect, test } from "bun:test";
import type { Ticket } from "../src";
import { CONTINUATION_PROMPT } from "../src/runs/run-steering";
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
    const turn = h.runtime.turns().find((x) => x.text.includes("how is FRI-1"));
    expect(turn?.tickets).toContain("FRI-1 [review]");
    expect(turn?.tickets).toContain("First one");
    expect(turn?.tickets).toContain("see the draft");
  });
});

describe("unfinished tickets", () => {
  test("a ticket still todo at turn end re-wakes the assignee once with rewake true", async () => {
    const h = makeHub();
    const t = await assigned(h);
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(h.runtime.turns()[1]).toMatchObject({ text: REWAKE(t.number) });
    const rows = [...h.store.wakeMap.values()];
    expect(rows.find((w) => w.rewake)).toMatchObject({ ticketId: t.id });
  });

  test("an assignee that set the ticket to review gets no re-wake", async () => {
    const h = makeHub();
    const t = await assigned(h);
    await h.hub.tickets.update({ kind: "bot", botId: "editor" }, { id: t.id, status: "review" });
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    // A re-wake would be a new run (a resumed session): count every turn and every run.
    expect(h.runtime.turns()).toHaveLength(1);
    expect(h.runtime.created).toHaveLength(1);
    expect(h.store.wakeMap.size).toBe(1);
  });

  test("second turn end still open: ticket blocked, comment added, notice posted, no third wake", async () => {
    const h = makeHub();
    const t = await assigned(h);
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(h.runtime.turns()).toHaveLength(2);
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
    expect(h.runtime.created).toHaveLength(1);
    expect(h.runtime.turns()).toHaveLength(1);
    expect(h.store.wakeMap.size).toBe(1);
  });
});

describe("ticket wakes and the busy flag", () => {
  test("an owner message during a ticket run steers it; the re-wake still runs after it", async () => {
    const h = makeHub();
    const t = await assigned(h);
    h.surface.deliver({ conversationId: "dc", text: "hello editor" });
    await flush();
    // The owner's message to the busy ticket run is held (a ticket run takes no steering into its turn).
    expect([...h.store.steerMap.values()].map((r) => r.text)).toEqual(["hello editor"]);
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    // The finish hands the held message to a continuation run, which goes before the re-wake.
    expect(h.runtime.turns().map((s) => s.text)).toEqual([
      WAKE(t.number),
      `${CONTINUATION_PROMPT}\n\nNew message from the owner while you work:\nhello editor`,
    ]);
    h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect(h.runtime.turns().at(-1)?.text).toBe(REWAKE(t.number));
    h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
    await flush();
    const running = [...h.store.wakeMap.values()].filter((w) => w.status === "running");
    expect(running).toEqual([]);
  });

  test("a wake that arrives during the re-wake turn waits for it", async () => {
    const h = makeHub();
    const t = await assigned(h);
    h.runtime.nth(0).emit({ type: "turn_end", costUsd: 0 });
    await flush();
    h.surface.deliver({ conversationId: "dc", text: "later" });
    await flush();
    expect(h.runtime.turns()).toHaveLength(2);
    // Held while the re-wake run works (a ticket run takes no steering), not a run of its own.
    expect([...h.store.steerMap.values()].map((r) => r.text)).toEqual(["later"]);
    h.runtime.last().emit({ type: "turn_end", costUsd: 0 });
    await flush();
    expect((await h.store.tickets.get(t.id))?.status).toBe("blocked");
    expect(h.runtime.turns().at(-1)?.text).toContain(CONTINUATION_PROMPT);
  });

  test("a failed wake does not fail the ticket write", async () => {
    const h = makeHub();
    h.runtime.open = async () => {
      throw new Error("session will not open");
    };
    const r = await h.hub.tickets.create(
      { kind: "bot", botId: "writer" },
      { title: "x", assigneeBotId: "editor" },
    );
    expect(r.ok).toBe(true);
    await flush();
    // The run is retried as a setup failure.
    expect([...h.store.wakeMap.values()].map((w) => [w.status, w.setupFailures])).toEqual([
      ["queued", 1],
    ]);
  });

  test("a ticket assigned by a bot is a wake from that bot, so the loop guards apply", async () => {
    const h = makeHub();
    const r = await h.hub.tickets.create(
      { kind: "bot", botId: "writer" },
      { title: "x", assigneeBotId: "editor" },
    );
    if (!r.ok) throw new Error(r.error);
    await flush();
    const first = [...h.store.wakeMap.values()][0];
    expect(first?.sender).toEqual({ kind: "bot", botId: "writer" });
    await h.hub.wakeForTicket(r.ticket, "editor", false, { kind: "bot", botId: "writer" });
    await flush();
    const rows = [...h.store.wakeMap.values()];
    expect(rows[1]).toMatchObject({ status: "blocked", blockReason: "repeat" });
  });
});
