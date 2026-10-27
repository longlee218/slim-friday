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

  test("review and todo post nothing", async () => {
    const h = makeHub();
    const t = await groupTicket(h, "g");
    await h.hub.tickets.update(OWNER, { id: t.id, status: "review" });
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
