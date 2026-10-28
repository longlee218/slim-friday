import { describe, expect, test } from "bun:test";
import { flush, makeHub } from "./bot-hub-harness";

const OWNER = { kind: "user" } as const;

/** A group ticket assigned to editor, created by the owner; wake side effects settled. */
async function groupTicket(h: ReturnType<typeof makeHub>, groupId?: string) {
  const r = await h.hub.tickets.create(OWNER, {
    title: "Edit the post",
    assigneeBotId: "editor",
    ...(groupId && { groupId }),
  });
  if (!r.ok) throw new Error(r.error);
  await flush();
  return r.ticket;
}

/** The system messages posted to the group conversation. */
const groupPosts = (h: ReturnType<typeof makeHub>) =>
  h.surface.posts.filter((p) => p.conversationId === "group:g").map((p) => p.message);

describe("ticket milestones", () => {
  test("doing, done and blocked post one system message each to the group", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    await h.hub.tickets.update(OWNER, { id: t.id, status: "blocked", blockedReason: "need key" });
    await h.hub.tickets.update(OWNER, { id: t.id, status: "done" });
    const posts = groupPosts(h);
    expect(posts.map((m) => m.text)).toEqual([
      `Editor started FRI-${t.number}: Edit the post`,
      `FRI-${t.number} is blocked: need key`,
      `Editor finished FRI-${t.number}: Edit the post`,
    ]);
    expect(posts.every((m) => m.author.kind === "system")).toBe(true);
  });

  test("no post for a ticket without groupId", async () => {
    const h = makeHub();
    const t = await groupTicket(h);
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    expect(h.surface.posts.filter((p) => p.conversationId.startsWith("group:"))).toEqual([]);
  });

  test("no post when the status did not change or only the title changed", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    await h.hub.tickets.update(OWNER, { id: t.id, title: "Renamed" });
    expect(groupPosts(h)).toHaveLength(1);
  });

  test("todo posts nothing", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "todo" });
    expect(groupPosts(h)).toEqual([]);
  });

  test("a milestone wakes no group member", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    const before = h.store.wakeMap.size;
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    await flush();
    expect(groupPosts(h)).toHaveLength(1);
    expect(h.store.wakeMap.size).toBe(before);
  });

  test("a failing post does not fail the update", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    h.surface.post = async () => {
      throw new Error("surface down");
    };
    const r = await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    expect(r.ok).toBe(true);
    expect((await h.store.tickets.get(t.id))?.status).toBe("doing");
    expect(h.log.of("hub.ticket_milestone_failed")).toHaveLength(1);
  });

  test("a status and assignee change in one update names the new assignee", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing", assigneeBotId: "writer" });
    expect(groupPosts(h).map((m) => m.text)).toEqual([
      `Writer started FRI-${t.number}: Edit the post`,
    ]);
  });
});

describe("ticket review and blocked progress", () => {
  const EDITOR = { kind: "bot", botId: "editor" } as const;

  test("review posts a waiting-for-review line naming the creator", async () => {
    const h = makeHub();
    const r = await h.hub.tickets.create(
      { kind: "bot", botId: "writer" },
      { title: "Edit the post", assigneeBotId: "editor", groupId: "g" },
    );
    if (!r.ok) throw new Error(r.error);
    await flush();
    await h.hub.tickets.update(EDITOR, { id: r.ticket.id, status: "review" });
    expect(groupPosts(h).map((m) => m.text)).toEqual([
      `Editor finished FRI-${r.ticket.number}, waiting for review by Writer: Edit the post`,
    ]);
  });

  test("owner ticket review names the owner", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(EDITOR, { id: t.id, status: "review" });
    expect(groupPosts(h).map((m) => m.text)).toEqual([
      `Editor finished FRI-${t.number}, waiting for review by the owner: Edit the post`,
    ]);
  });

  test("assignee comment on a blocked ticket is posted", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "blocked", blockedReason: "need key" });
    await h.hub.tickets.comment(EDITOR, { id: t.id, body: "MCP has no such tool" });
    expect(groupPosts(h).map((m) => m.text)).toEqual([
      `FRI-${t.number} is blocked: need key`,
      `Editor on FRI-${t.number} (blocked): MCP has no such tool`,
    ]);
  });

  test("comment on a doing ticket posts nothing", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "doing" });
    await h.hub.tickets.comment(EDITOR, { id: t.id, body: "working on it" });
    expect(groupPosts(h)).toHaveLength(1);
  });

  test("new reason on an already blocked ticket posts the blocked line again", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "blocked", blockedReason: "need key" });
    await h.hub.tickets.update(OWNER, {
      id: t.id,
      status: "blocked",
      blockedReason: "key expired",
    });
    expect(groupPosts(h).map((m) => m.text)).toEqual([
      `FRI-${t.number} is blocked: need key`,
      `FRI-${t.number} is blocked: key expired`,
    ]);
  });
});
