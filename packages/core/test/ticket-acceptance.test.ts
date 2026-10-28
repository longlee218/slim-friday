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
const editor: Author = { kind: "bot", botId: "editor" };

function setup() {
  const store = new FakeStore();
  for (const id of ["writer", "editor"]) store.botMap.set(id, bot(id));
  const board = new TicketBoard({
    store,
    clock: new FakeClock(1000),
    wake: async (_t: Ticket, _botId: string) => {},
  });
  return { board };
}

/** A ticket the writer created for the editor. */
async function assigned() {
  const { board } = setup();
  const r = await board.create(writer, { title: "x", assigneeBotId: "editor" });
  if (!r.ok) throw new Error("create");
  return { board, id: r.ticket.id };
}

const NOT_ALLOWED = {
  ok: false,
  code: "not_allowed",
  error: "Only the ticket's creator or the owner sets done or closed.",
} as const;

describe("ticket acceptance", () => {
  test("assignee bot cannot set done on a ticket another bot created", async () => {
    const { board, id } = await assigned();
    expect(await board.update(editor, { id, status: "done" })).toEqual(NOT_ALLOWED);
    const t = await board.get(id);
    expect(t.ok && t.ticket.status).toBe("todo");
  });

  test("assignee bot cannot close it either", async () => {
    const { board, id } = await assigned();
    expect(await board.update(editor, { id, status: "closed" })).toEqual(NOT_ALLOWED);
    const t = await board.get(id);
    expect(t.ok && t.ticket.status).toBe("todo");
  });

  test("assignee may set review", async () => {
    const { board, id } = await assigned();
    expect((await board.update(editor, { id, status: "review" })).ok).toBe(true);
  });

  test("creator bot sets done", async () => {
    const { board, id } = await assigned();
    expect((await board.update(writer, { id, status: "done" })).ok).toBe(true);
  });

  test("self-assigned bot sets done", async () => {
    const { board } = setup();
    const r = await board.create(writer, { title: "mine" });
    if (!r.ok) throw new Error("create");
    expect((await board.update(writer, { id: r.ticket.id, status: "review" })).ok).toBe(true);
    expect((await board.update(writer, { id: r.ticket.id, status: "done" })).ok).toBe(true);
  });

  test("owner and system always may", async () => {
    const { board, id } = await assigned();
    expect((await board.update({ kind: "user" }, { id, status: "done" })).ok).toBe(true);
    expect((await board.update({ kind: "system" }, { id, status: "closed" })).ok).toBe(true);
  });
});
