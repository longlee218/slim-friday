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
const writer: Author = { kind: "bot", botId: "writer" };

function setup() {
  const store = new FakeStore();
  for (const id of ["writer", "editor"]) store.botMap.set(id, bot(id));
  const clock = new FakeClock(1000);
  const woken: string[] = [];
  const board = new TicketBoard({
    store,
    clock,
    wake: async (t: Ticket, botId: string) => void woken.push(`${botId}:${t.number}`),
  });
  return { store, clock, woken, board };
}

const group = (id: string, members: string[]) => ({
  id,
  name: `Group ${id}`,
  members,
  entryBot: members[0] ?? "writer",
  workspaces: [],
  instructions: "",
});

/** A setup with group g1 whose only member is writer. */
function setupGroup() {
  const s = setup();
  s.store.groupMap.set("g1", group("g1", ["writer"]));
  return s;
}

describe("TicketBoard group scope", () => {
  const notMember = (bot: string, name: string) => ({
    ok: false as const,
    code: "not_member" as const,
    error: `${bot} is not a member of group ${name}`,
  });

  test("create refuses an assignee outside the ticket's group", async () => {
    const { board, store, woken } = setupGroup();
    const r = await board.create(writer, { title: "x", groupId: "g1", assigneeBotId: "editor" });
    expect(r).toEqual(notMember("editor", "Group g1"));
    expect(store.ticketMap.size).toBe(0);
    expect(woken).toEqual([]);
  });

  test("create in a group records it and self-assigns a member", async () => {
    const { board } = setupGroup();
    const r = await board.create(writer, { title: "x", groupId: "g1" });
    expect(r.ok && r.ticket).toMatchObject({ groupId: "g1", assigneeBotId: "writer" });
  });

  test("create self-assign by a non-member is refused", async () => {
    const { board } = setupGroup();
    const r = await board.create({ kind: "bot", botId: "editor" }, { title: "x", groupId: "g1" });
    expect(r).toEqual(notMember("editor", "Group g1"));
  });

  test("update refuses reassigning a group ticket to a non-member", async () => {
    const { board, woken } = setupGroup();
    const c = await board.create(writer, { title: "x", groupId: "g1" });
    const id = c.ok ? c.ticket.id : "";
    const r = await board.update(writer, { id, assigneeBotId: "editor" });
    expect(r).toEqual(notMember("editor", "Group g1"));
    expect(woken).toEqual([]);
  });

  test("update to a member of the group wakes it", async () => {
    const { board, store, woken } = setupGroup();
    store.groupMap.set("g1", group("g1", ["writer", "editor"]));
    const c = await board.create(writer, { title: "x", groupId: "g1" });
    const id = c.ok ? c.ticket.id : "";
    const r = await board.update(writer, { id, assigneeBotId: "editor" });
    expect(r.ok).toBe(true);
    expect(woken).toEqual(["editor:1"]);
  });

  test("self-assign from a DM session checks the ticket's group", async () => {
    const { board } = setupGroup();
    const c = await board.create(writer, { title: "x", groupId: "g1" });
    const id = c.ok ? c.ticket.id : "";
    const r = await board.update({ kind: "bot", botId: "editor" }, { id, assigneeBotId: "editor" });
    expect(r).toEqual(notMember("editor", "Group g1"));
  });

  test("a ticket without groupId accepts any existing bot", async () => {
    const { board } = setupGroup();
    const r = await board.create(writer, { title: "x", assigneeBotId: "editor" });
    expect(r.ok).toBe(true);
  });

  test("a ticket whose group is gone refuses assignment, naming the id", async () => {
    const { board, store } = setupGroup();
    const c = await board.create(writer, { title: "x", groupId: "g1" });
    const id = c.ok ? c.ticket.id : "";
    store.groupMap.delete("g1");
    expect(await board.update(writer, { id, assigneeBotId: "writer" })).toEqual(
      notMember("writer", "g1"),
    );
  });
});

describe("TicketBoard", () => {
  test("create defaults the assignee to the creator and wakes nobody", async () => {
    const { board, woken } = setup();
    const r = await board.create(writer, { title: "  Draft  " });
    expect(r.ok && r.ticket).toMatchObject({
      title: "Draft",
      assigneeBotId: "writer",
      number: 1,
      status: "todo",
      priority: "normal",
    });
    expect(woken).toEqual([]);
  });

  test("create for another bot wakes it", async () => {
    const { board, woken } = setup();
    await board.create(writer, { title: "Edit", assigneeBotId: "editor" });
    expect(woken).toEqual(["editor:1"]);
  });

  test("create refuses an empty title, a title over 200, an unknown bot", async () => {
    const { board } = setup();
    expect(await board.create(writer, { title: "   " })).toEqual({
      ok: false,
      code: "invalid",
      error: "Invalid ticket.",
    });
    expect(await board.create(writer, { title: "x".repeat(201) })).toEqual({
      ok: false,
      code: "invalid",
      error: "Invalid ticket.",
    });
    expect(await board.create(writer, { title: "a", assigneeBotId: "ghost" })).toEqual({
      ok: false,
      code: "unknown_bot",
      error: "Unknown bot.",
    });
  });

  test("update that changes the assignee to another bot wakes it", async () => {
    const { board, woken } = setup();
    const t = await board.create(writer, { title: "a" });
    if (!t.ok) throw new Error("create");
    await board.update(writer, { id: t.ticket.id, assigneeBotId: "editor" });
    expect(woken).toEqual(["editor:1"]);
  });

  test("update to the actor, to the same bot, or on a done ticket wakes nobody", async () => {
    const { board, woken } = setup();
    const t = await board.create(writer, { title: "a", assigneeBotId: "editor" });
    if (!t.ok) throw new Error("create");
    woken.length = 0;
    await board.update(writer, { id: t.ticket.id, assigneeBotId: "editor" }); // same bot
    await board.update(writer, { id: t.ticket.id, assigneeBotId: "writer" }); // the actor
    await board.update(writer, { id: t.ticket.id, status: "done" });
    await board.update(writer, { id: t.ticket.id, assigneeBotId: "editor" }); // done ticket
    expect(woken).toEqual([]);
    expect(await board.update(writer, { id: t.ticket.id, assigneeBotId: "ghost" })).toEqual({
      ok: false,
      code: "unknown_bot",
      error: "Unknown bot.",
    });
  });

  test("done sets completedAt, todo clears it", async () => {
    const { board } = setup();
    const t = await board.create(writer, { title: "a" });
    if (!t.ok) throw new Error("create");
    const done = await board.update(writer, { id: t.ticket.id, status: "done" });
    expect(done.ok && done.ticket.completedAt).toBe(1000);
    const todo = await board.update(writer, { id: t.ticket.id, status: "todo" });
    expect(todo.ok && todo.ticket.completedAt).toBeUndefined();
    expect(await board.update(writer, { id: t.ticket.id, status: "bogus" as never })).toEqual({
      ok: false,
      code: "invalid",
      error: "status must be one of todo, doing, review, blocked, done, closed.",
    });
  });

  test("get accepts fri-3, FRI-3 and the id", async () => {
    const { board } = setup();
    for (const t of ["a", "b", "c"]) await board.create(writer, { title: t });
    const byId = await board.list({});
    if (!byId.ok) throw new Error("list");
    const c = byId.tickets[0] as Ticket;
    for (const ref of ["fri-3", "FRI-3", c.id]) {
      const r = await board.get(ref);
      expect(r.ok && r.ticket.title).toBe("c");
    }
    expect(await board.get("FRI-9")).toEqual({
      ok: false,
      code: "not_found",
      error: "Ticket FRI-9 not found.",
    });
    expect(await board.get("ABC-1")).toEqual({
      ok: false,
      code: "not_found",
      error: "Ticket ABC-1 not found.",
    });
  });

  test("list hides closed unless asked, pages by cursor with 50 per page, cuts descriptions to 200", async () => {
    const { board, clock } = setup();
    for (let i = 0; i < 52; i++) {
      clock.advance(1);
      await board.create(writer, { title: `t${i}`, description: "d".repeat(300) });
    }
    const closed = await board.create(writer, { title: "closed" });
    if (!closed.ok) throw new Error("create");
    await board.update(writer, { id: closed.ticket.id, status: "closed" });
    const p1 = await board.list({});
    if (!p1.ok) throw new Error("list");
    expect(p1.tickets).toHaveLength(50);
    expect(p1.tickets.some((t) => t.title === "closed")).toBe(false);
    expect(p1.tickets[0]?.description).toHaveLength(201);
    expect(p1.tickets[0]?.description?.endsWith("…")).toBe(true);
    const p2 = await board.list({ cursor: p1.nextCursor });
    expect(p2.ok && p2.tickets).toHaveLength(2);
    expect(p2.ok && p2.nextCursor).toBeUndefined();
    const only = await board.list({ status: "closed" });
    expect(only.ok && only.tickets.map((t) => t.title)).toEqual(["closed"]);
    expect(await board.list({ cursor: "!!" })).toEqual({
      ok: false,
      code: "invalid",
      error: "cursor is invalid.",
    });
  });

  test("comment refuses an empty body", async () => {
    const { board } = setup();
    const t = await board.create(writer, { title: "a" });
    if (!t.ok) throw new Error("create");
    expect(await board.comment(writer, { id: t.ticket.id, body: "  " })).toEqual({
      ok: false,
      code: "invalid",
      error: "Invalid ticket.",
    });
    expect(await board.comment(writer, { id: "FRI-77", body: "x" })).toEqual({
      ok: false,
      code: "not_found",
      error: "Ticket not found.",
    });
  });

  test("comment and status change wake nobody", async () => {
    const { board, woken } = setup();
    const t = await board.create(writer, { title: "a", assigneeBotId: "editor" });
    if (!t.ok) throw new Error("create");
    woken.length = 0;
    await board.comment(writer, { id: t.ticket.id, body: "note" });
    await board.update(writer, { id: t.ticket.id, status: "doing" });
    expect(woken).toEqual([]);
  });
});
