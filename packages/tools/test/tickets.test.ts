import { expect, test } from "bun:test";
import { type Ticket, TicketBoard } from "@friday/core";
import { FakeClock } from "../../core/test/fakes/fake-clock";
import { FakeStore } from "../../core/test/fakes/fake-store";
import { ticketTools } from "../src/tickets/tickets-server";
import { createTicketCommentTool } from "../src/tickets/tools/TicketCommentTool/ticket-comment-tool";
import { createTicketCreateTool } from "../src/tickets/tools/TicketCreateTool/ticket-create-tool";
import { createTicketGetTool } from "../src/tickets/tools/TicketGetTool/ticket-get-tool";
import { createTicketListTool } from "../src/tickets/tools/TicketListTool/ticket-list-tool";
import { createTicketUpdateTool } from "../src/tickets/tools/TicketUpdateTool/ticket-update-tool";
import { call, textOf } from "./design-fixture";

const bot = (id: string, name: string) => ({
  id,
  name,
  title: "",
  instructions: "",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
});

/** A board over a fake store with bots writer and editor; `woken` records the wake calls. */
function setup() {
  const store = new FakeStore();
  store.botMap.set("writer", bot("writer", "Writer"));
  store.botMap.set("editor", bot("editor", "Editor"));
  const woken: string[] = [];
  const clock = new FakeClock(1000);
  const board = new TicketBoard({
    store,
    clock,
    wake: async (t: Ticket, id: string) => void woken.push(`${id}:${t.number}`),
  });
  const ctx = { botId: "writer", board, bots: store.bots };
  return { store, woken, clock, ctx };
}

test("TicketCreate returns the ticket with its ref", async () => {
  const { ctx } = setup();
  const r = await call(createTicketCreateTool(ctx), { title: "Draft the post" });
  expect(r.isError).toBeUndefined();
  expect(JSON.parse(textOf(r))).toMatchObject({ ref: "FRI-1", status: "todo", assignee: "writer" });
});

test("TicketCreate for another bot (by name) calls wake", async () => {
  const { ctx, woken } = setup();
  await call(createTicketCreateTool(ctx), { title: "Edit it", assignee: "editor" });
  expect(woken).toEqual(["editor:1"]);
  const bad = await call(createTicketCreateTool(ctx), { title: "x", assignee: "nobody" });
  expect(bad.isError).toBe(true);
  expect(textOf(bad)).toBe("Unknown bot.");
});

test("TicketUpdate with an unknown status returns the status error", async () => {
  const { ctx } = setup();
  await call(createTicketCreateTool(ctx), { title: "a" });
  const r = await call(createTicketUpdateTool(ctx), { id: "FRI-1", status: "bogus" });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe("status must be one of todo, doing, review, blocked, done, closed.");
});

test("TicketGet returns comments", async () => {
  const { ctx } = setup();
  await call(createTicketCreateTool(ctx), { title: "a" });
  await call(createTicketCommentTool(ctx), { id: "FRI-1", body: "progress" });
  const r = JSON.parse(textOf(await call(createTicketGetTool(ctx), { ref: "fri-1" })));
  expect(r.ticket.ref).toBe("FRI-1");
  expect(r.comments).toEqual([{ author: "writer", body: "progress", at: 1000 }]);
});

test("TicketList pages with nextCursor", async () => {
  const { ctx, clock } = setup();
  for (let i = 0; i < 51; i++) {
    clock.advance(1);
    await call(createTicketCreateTool(ctx), { title: `t${i}` });
  }
  const p1 = JSON.parse(textOf(await call(createTicketListTool(ctx), {})));
  expect(p1.tickets).toHaveLength(50);
  const p2 = JSON.parse(textOf(await call(createTicketListTool(ctx), { cursor: p1.nextCursor })));
  expect(p2.tickets).toHaveLength(1);
  expect(p2.nextCursor).toBeUndefined();
});

test("the actor of every write is the session's bot", async () => {
  const { ctx, store } = setup();
  const editorCtx = { ...ctx, botId: "editor" };
  const made = JSON.parse(textOf(await call(createTicketCreateTool(editorCtx), { title: "a" })));
  await call(createTicketCommentTool(editorCtx), { id: made.id, body: "note" });
  expect(store.ticketMap.get(made.id)?.createdBy).toEqual({ kind: "bot", botId: "editor" });
  expect(store.ticketComments[0]?.author).toEqual({ kind: "bot", botId: "editor" });
});

test("a bot gets only the ticket tools it names", () => {
  const { ctx } = setup();
  expect(ticketTools(ctx, ["mcp__tickets"]).map((t) => t.name)).toHaveLength(5);
  expect(ticketTools(ctx, ["mcp__tickets__TicketGet"]).map((t) => t.name)).toEqual(["TicketGet"]);
  expect(ticketTools(ctx, [])).toEqual([]);
});
