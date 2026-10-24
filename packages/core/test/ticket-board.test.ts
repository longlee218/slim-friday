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
      error: "Invalid ticket.",
    });
    expect(await board.create(writer, { title: "x".repeat(201) })).toEqual({
      ok: false,
      error: "Invalid ticket.",
    });
    expect(await board.create(writer, { title: "a", assigneeBotId: "ghost" })).toEqual({
      ok: false,
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
    expect(await board.get("FRI-9")).toEqual({ ok: false, error: "Ticket FRI-9 not found." });
    expect(await board.get("ABC-1")).toEqual({ ok: false, error: "Ticket ABC-1 not found." });
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
    expect(await board.list({ cursor: "!!" })).toEqual({ ok: false, error: "cursor is invalid." });
  });

  test("comment refuses an empty body", async () => {
    const { board } = setup();
    const t = await board.create(writer, { title: "a" });
    if (!t.ok) throw new Error("create");
    expect(await board.comment(writer, { id: t.ticket.id, body: "  " })).toEqual({
      ok: false,
      error: "Invalid ticket.",
    });
    expect(await board.comment(writer, { id: "FRI-77", body: "x" })).toEqual({
      ok: false,
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
