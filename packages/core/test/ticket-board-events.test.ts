import { describe, expect, test } from "bun:test";
import { type Author, type Ticket, TicketBoard } from "../src";
import { FakeClock } from "./fakes/fake-clock";
import { FakeStore } from "./fakes/fake-store";

const bot = (id: string) => ({
  id,
  name: id,
  title: "",
  instructions: "",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
});
const owner: Author = { kind: "user" };
const writer: Author = { kind: "bot", botId: "writer" };

/** A board with one ticket FRI-1 assigned to the writer. */
async function setup() {
  const store = new FakeStore();
  for (const id of ["writer", "editor"]) store.botMap.set(id, bot(id));
  const clock = new FakeClock(1000);
  const changed: Ticket[] = [];
  const board = new TicketBoard({
    store,
    clock,
    wake: async () => {},
    onChange: (t) => void changed.push(t),
  });
  const r = await board.create(writer, { title: "Draft", description: "see FRI-2" });
  if (!r.ok) throw new Error(r.error);
  const afterCreate = [...changed];
  changed.length = 0;
  return { store, clock, board, changed, afterCreate, t: r.ticket };
}

describe("TicketBoard update refusals", () => {
  test("stale expectedUpdatedAt gives conflict and writes no event", async () => {
    const { board, store, t } = await setup();
    const r = await board.update(owner, { id: "FRI-1", status: "doing", expectedUpdatedAt: 1 });
    expect(r).toEqual({ ok: false, code: "conflict", error: "Ticket changed since you read it." });
    expect(await store.ticketEvents.list(t.id)).toHaveLength(1);
    expect((await store.tickets.get(t.id))?.status).toBe("todo");
  });

  test("a conflict writes neither the change nor any event", async () => {
    const { board, store, t } = await setup();
    const before = (await store.tickets.get(t.id))?.updatedAt;
    const r = await board.update(owner, {
      id: "FRI-1",
      status: "review",
      priority: "high",
      expectedUpdatedAt: 1,
    });
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(await store.tickets.get(t.id)).toMatchObject({ status: "todo", priority: "normal" });
    expect((await store.tickets.get(t.id))?.updatedAt).toBe(before);
    expect(await store.ticketEvents.list(t.id)).toHaveLength(1);
  });

  test("blocked without a reason is refused", async () => {
    const { board } = await setup();
    const r = await board.update(owner, { id: "FRI-1", status: "blocked" });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(!r.ok && r.error).toContain("blockedReason");
  });

  test("a blocked reason over 500 chars, or on a non-blocked result, is refused", async () => {
    const { board } = await setup();
    const long = await board.update(owner, {
      id: "FRI-1",
      status: "blocked",
      blockedReason: "x".repeat(501),
    });
    expect(long).toMatchObject({ ok: false, code: "invalid" });
    const stray = await board.update(owner, { id: "FRI-1", blockedReason: "why" });
    expect(stray).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("TicketBoard events", () => {
  test("create writes a created event", async () => {
    const { store, t } = await setup();
    const [e] = await store.ticketEvents.list(t.id);
    expect(e).toMatchObject({ kind: "created", to: "writer", actor: writer });
  });

  test("owner change writes status and assignee events with the owner as actor", async () => {
    const { board, store, t } = await setup();
    await board.update(owner, { id: "FRI-1", status: "review", assigneeBotId: "editor" });
    expect(
      (await store.ticketEvents.list(t.id)).map((e) => [e.kind, e.from, e.to, e.actor.kind]),
    ).toEqual([
      ["created", undefined, "writer", "bot"],
      ["status", "todo", "review", "user"],
      ["assignee", "writer", "editor", "user"],
    ]);
  });

  test("a bot passing its ticket on writes handoff and stores its conversation", async () => {
    const { board, store, t } = await setup();
    await board.update(writer, {
      id: "FRI-1",
      assigneeBotId: "editor",
      conversationId: "bot:writer",
    });
    expect((await store.ticketEvents.list(t.id)).at(-1)).toMatchObject({
      kind: "handoff",
      from: "writer",
      to: "editor",
      actor: writer,
    });
    expect((await store.tickets.get(t.id))?.conversationId).toBe("bot:writer");
  });

  test("priority change writes a priority event; an unchanged field writes none", async () => {
    const { board, store, t } = await setup();
    await board.update(owner, { id: "FRI-1", priority: "high", status: "todo" });
    const events = await store.ticketEvents.list(t.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "priority"]);
    expect(events[1]).toMatchObject({ from: "normal", to: "high" });
  });

  test("blocked keeps its reason and a later status clears it", async () => {
    const { board, store, t } = await setup();
    await board.update(owner, { id: "FRI-1", status: "blocked", blockedReason: "needs key" });
    expect((await store.tickets.get(t.id))?.blockedReason).toBe("needs key");
    await board.update(owner, { id: "FRI-1", status: "doing" });
    expect((await store.tickets.get(t.id))?.blockedReason).toBeUndefined();
  });

  test("owner update leaves the conversation; a bot comment from another one moves it", async () => {
    const { board, store, t } = await setup();
    await board.update(writer, { id: "FRI-1", status: "doing", conversationId: "bot:writer" });
    await board.update(owner, { id: "FRI-1", priority: "low" });
    expect((await store.tickets.get(t.id))?.conversationId).toBe("bot:writer");
    await board.comment(writer, { id: "FRI-1", body: "hi", conversationId: "g:1" });
    expect((await store.tickets.get(t.id))?.conversationId).toBe("g:1");
  });

  test("the owner passing a conversationId leaves it unchanged", async () => {
    const { board, store, t } = await setup();
    await board.update(owner, { id: "FRI-1", priority: "low", conversationId: "dc" });
    expect((await store.tickets.get(t.id))?.conversationId).toBeUndefined();
  });

  test("onChange gets the saved ticket after create, update and comment", async () => {
    const { board, changed, afterCreate } = await setup();
    expect(afterCreate.map((t) => t.status)).toEqual(["todo"]);
    await board.update(owner, { id: "FRI-1", status: "doing" });
    await board.comment(owner, { id: "FRI-1", body: "note" });
    expect(changed.map((t) => t.status)).toEqual(["doing", "doing"]);
  });

  test("a throwing onChange never reaches the caller", async () => {
    const { store } = await setup();
    const throwing = new TicketBoard({
      store,
      clock: new FakeClock(5000),
      wake: async () => {},
      onChange: () => {
        throw new Error("boom");
      },
    });
    expect((await throwing.create(owner, { title: "x" })).ok).toBe(true);
  });

  test("detail merges comments and events and resolves related tickets", async () => {
    const { board } = await setup();
    await board.create(owner, { title: "Other" });
    await board.comment(owner, { id: "FRI-1", body: "also FRI-2 and FRI-99" });
    const r = await board.detail("FRI-1");
    if (!r.ok) throw new Error(r.error);
    expect(r.timeline.map((i) => i.kind)).toEqual(["event", "comment"]);
    expect(r.related.map((t) => t.number)).toEqual([2]);
    expect(r.commentCount).toBe(1);
    expect(await board.detail("FRI-9")).toMatchObject({ ok: false, code: "not_found" });
  });
});
