import { describe, expect, test } from "bun:test";
import type { Group, Ticket } from "../src";
import { blockOrphanTickets } from "../src/hub/ticket-orphans";
import { applyConfigChange } from "../src/runs/run-config-change";
import { flush, makeHub } from "./bot-hub-harness";

type Hub = ReturnType<typeof makeHub>;

/** Store a ticket directly (no wake), assigned to `bot` in group `groupId`. */
async function put(h: Hub, status: Ticket["status"], groupId = "g", bot = "editor") {
  return (await h.store.tickets.create({
    title: `t-${status}-${bot}`,
    status,
    priority: "normal",
    assigneeBotId: bot,
    groupId,
    createdBy: { kind: "user" },
    createdAt: 1,
  })) as Ticket;
}

/** Drop `bot` from group g's members. */
function leave(h: Hub, bot: string) {
  const g = h.store.groupMap.get("g");
  if (g) h.store.groupMap.set("g", { ...g, members: g.members.filter((m) => m !== bot) });
  return g?.name ?? "";
}

/** The system messages posted to the group conversation. */
const posts = (h: Hub) =>
  h.surface.posts.filter((p) => p.conversationId === "group:g").map((p) => p.message.text);

const ctxOf = (h: Hub) =>
  (h.hub as unknown as { ctx: Parameters<typeof blockOrphanTickets>[0] }).ctx;

describe("blockOrphanTickets", () => {
  test("a changed group blocks the open tickets of removed members, with one milestone each", async () => {
    const h = makeHub();
    const a = await put(h, "todo");
    const b = await put(h, "doing");
    const name = leave(h, "editor");
    await h.hub.configChanged({
      removedBots: [],
      removedGroups: [],
      changedGroups: ["g"],
      resetScopes: [],
    });
    await flush();
    for (const t of [a, b])
      expect(await h.store.tickets.get(t.id)).toMatchObject({
        status: "blocked",
        blockedReason: `assignee is no longer in group ${name}`,
      });
    expect(posts(h)).toHaveLength(2);
    expect(h.runtime.all()).toEqual([]);
  });

  test("a removed group blocks its open tickets", async () => {
    const h = makeHub();
    const a = await put(h, "todo");
    h.store.groupMap.delete("g");
    await h.hub.configChanged({
      removedBots: [],
      removedGroups: ["g"],
      changedGroups: [],
      resetScopes: [],
    });
    expect(await h.store.tickets.get(a.id)).toMatchObject({
      status: "blocked",
      blockedReason: "group g was removed",
    });
  });

  test("members' tickets and tickets of other groups are untouched", async () => {
    const h = makeHub();
    const member = await put(h, "todo", "g", "writer");
    const other = await put(h, "todo", "other");
    leave(h, "editor");
    await blockOrphanTickets(ctxOf(h), ["g"]);
    expect((await h.store.tickets.get(member.id))?.status).toBe("todo");
    expect((await h.store.tickets.get(other.id))?.status).toBe("todo");
  });

  test("done and blocked tickets are not touched", async () => {
    const h = makeHub();
    const done = await put(h, "done");
    const blocked = await put(h, "blocked");
    leave(h, "editor");
    await blockOrphanTickets(ctxOf(h), ["g"]);
    expect(await h.store.tickets.get(done.id)).toMatchObject({ status: "done" });
    expect(await h.store.tickets.get(blocked.id)).toMatchObject({ status: "blocked" });
    expect(posts(h)).toEqual([]);
  });

  test("a group whose check throws does not stop the other groups, and the reload still hints workers", async () => {
    const h = makeHub();
    const b = await put(h, "todo", "other");
    h.store.groupMap.set("other", {
      ...(h.store.groupMap.get("g") as Group),
      id: "other",
      members: ["writer"],
    });
    const real = h.store.tickets.openOfGroup.bind(h.store.tickets);
    h.store.tickets.openOfGroup = async (id) => {
      if (id === "g") throw new Error("db down");
      return real(id);
    };
    await blockOrphanTickets(ctxOf(h), ["g", "other"]);
    expect((await h.store.tickets.get(b.id))?.status).toBe("blocked");
    expect(h.log.of("hub.ticket_orphan_check_failed")).toHaveLength(1);

    let hinted = 0;
    const ctx = { ...ctxOf(h), hints: { configChanged: () => void hinted++ } } as never;
    await applyConfigChange(ctx, {
      removedBots: [],
      removedGroups: [],
      changedGroups: ["g"],
      resetScopes: [],
    });
    expect(hinted).toBe(1);
  });

  test("the creator cannot reopen an orphan without re-assigning it", async () => {
    const h = makeHub();
    const writer = { kind: "bot", botId: "writer" } as const;
    const c = await h.hub.tickets.create(writer, {
      title: "Edit",
      assigneeBotId: "editor",
      groupId: "g",
    });
    if (!c.ok) throw new Error(c.error);
    await flush();
    leave(h, "editor");
    await blockOrphanTickets(ctxOf(h), ["g"]);
    const id = c.ticket.id;
    for (const status of ["todo", "doing", "review"] as const)
      expect(await h.hub.tickets.update(writer, { id, status })).toMatchObject({
        ok: false,
        code: "not_member",
      });
    expect((await h.store.tickets.get(id))?.status).toBe("blocked");
    const r = await h.hub.tickets.update(writer, { id, status: "todo", assigneeBotId: "writer" });
    expect(r).toMatchObject({ ok: true });
    expect((await h.store.tickets.get(id))?.status).toBe("todo");
  });
});
