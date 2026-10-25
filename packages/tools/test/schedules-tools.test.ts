import { expect, test } from "bun:test";
import type { RunKind } from "@friday/core";
import { z } from "zod";
import { addSchedule, makeBoard } from "../../core/test/schedules/schedule-harness";
import type { SchedulesContext } from "../src/schedules/schedules-context";
import { scheduleTools } from "../src/schedules/schedules-server";
import { call, textOf } from "./design-fixture";

type Harness = ReturnType<typeof makeBoard>;

/** The four tools of an owner run for `botId` in conversation `conv` (a group session when `group`). */
function tools(h: Harness, over: Partial<SchedulesContext> = {}) {
  const ctx: SchedulesContext = {
    botId: "editor",
    board: h.board,
    conversation: () => "dc",
    groupSession: false,
    runKind: "owner",
    ...over,
  };
  const byName = Object.fromEntries(scheduleTools(ctx).map((t) => [t.name, t]));
  return {
    create: byName.ScheduleCreate!,
    list: byName.ScheduleList!,
    update: byName.ScheduleUpdate!,
    remove: byName.ScheduleDelete!,
  };
}

/** Record the arguments of one board method (the real method still runs). */
function spy<K extends "create" | "update" | "remove" | "list">(h: Harness, name: K) {
  const calls: unknown[][] = [];
  const real = h.board[name].bind(h.board) as (...a: unknown[]) => unknown;
  (h.board as unknown as Record<string, unknown>)[name] = (...a: unknown[]) => {
    calls.push(a);
    return real(...a);
  };
  return calls;
}

const names = (runKind: RunKind) =>
  scheduleTools({
    botId: "editor",
    board: makeBoard().board,
    conversation: () => "dc",
    groupSession: false,
    runKind,
  }).map((t) => t.name);

test("tools by run kind: schedule runs only list, intro runs none, others all four", () => {
  expect(names("schedule")).toEqual(["ScheduleList"]);
  expect(names("intro")).toEqual([]);
  for (const k of ["owner", "bot", "ticket"] as const)
    expect(names(k).sort()).toEqual([
      "ScheduleCreate",
      "ScheduleDelete",
      "ScheduleList",
      "ScheduleUpdate",
    ]);
});

test("ScheduleCreate daily: a daily rule, posts to the current conversation, created by the bot", async () => {
  const h = makeBoard();
  const calls = spy(h, "create");
  const r = await call(tools(h).create, {
    name: "Brief",
    task: "Write the brief.",
    repeat: "daily",
    at: "07:30",
  });
  expect(r.isError).toBeUndefined();
  expect(calls[0]).toEqual([
    {
      name: "Brief",
      botId: "editor",
      task: "Write the brief.",
      rule: { kind: "daily", at: "07:30" },
      conversationId: "dc",
    },
    { kind: "bot", botId: "editor" },
  ]);
  const view = JSON.parse(textOf(r));
  expect(view).toMatchObject({
    name: "Brief",
    when: "Every day 07:30 (UTC)",
    nextRun: "Sun 25 Oct 07:30",
    notify: "always",
    enabled: true,
    postsTo: "dc",
    task: "Write the brief.",
  });
  expect(typeof view.id).toBe("string");
});

test("ScheduleCreate weekly without a weekday is an error result; nothing stored", async () => {
  const h = makeBoard();
  const r = await call(tools(h).create, { name: "W", task: "t", repeat: "weekly", at: "08:00" });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("weekday");
  expect(await h.board.list()).toEqual([]);
});

test("ScheduleCreate weekly maps the weekday name to its number", async () => {
  const h = makeBoard();
  const calls = spy(h, "create");
  await call(tools(h).create, {
    name: "W",
    task: "t",
    repeat: "weekly",
    at: "08:00",
    weekday: "mon",
  });
  expect((calls[0]?.[0] as { rule: unknown } | undefined)?.rule).toEqual({
    kind: "weekly",
    at: "08:00",
    weekday: 1,
  });
});

test("an interval below 15 minutes returns the board's invalid error as an error result", async () => {
  const h = makeBoard();
  const r = await call(tools(h).create, {
    name: "I",
    task: "t",
    repeat: "interval",
    every: 5,
    unit: "minutes",
  });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("at least 15 minutes");
  expect(await h.board.list()).toEqual([]);
});

test("ScheduleCreate with no current conversation is an error result", async () => {
  const h = makeBoard();
  const r = await call(tools(h, { conversation: () => undefined }).create, {
    name: "B",
    task: "t",
    repeat: "daily",
    at: "07:30",
  });
  expect(r.isError).toBe(true);
  expect(await h.board.list()).toEqual([]);
});

test("ScheduleList returns the view of each schedule in scope", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  const r = await call(tools(h).list, {});
  expect(JSON.parse(textOf(r))).toEqual([
    {
      id: s.id,
      name: "Brief",
      when: "Every day 07:30 (UTC)",
      nextRun: "Sun 25 Oct 07:30",
      notify: "always",
      enabled: true,
      postsTo: "dc",
      task: "Write the brief.",
    },
  ]);
});

test("ScheduleList in a group session passes the conversation in the scope", async () => {
  const h = makeBoard();
  const calls = spy(h, "list");
  await call(tools(h, { botId: "writer", conversation: () => "gc", groupSession: true }).list, {});
  expect(calls[0]).toEqual([{ botId: "writer", conversationId: "gc" }]);
  // A direct session is scoped to the bot only.
  await call(tools(h).list, {});
  expect(calls[1]).toEqual([{ botId: "editor" }]);
});

test("ScheduleUpdate with a changed rule passes the scope and the patch", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  const calls = spy(h, "update");
  const r = await call(tools(h).update, {
    id: s.id,
    repeat: "weekdays",
    at: "09:00",
    enabled: false,
  });
  expect(r.isError).toBeUndefined();
  expect(calls[0]).toEqual([
    s.id,
    { rule: { kind: "weekdays", at: "09:00" }, enabled: false },
    { botId: "editor" },
  ]);
  expect(JSON.parse(textOf(r))).toMatchObject({ when: "Weekdays 09:00 (UTC)", enabled: false });
});

test("ScheduleDelete of a schedule outside the group scope is not_found and removes nothing", async () => {
  const h = makeBoard();
  // writer's schedule in its direct chat: not in the group conversation's scope.
  const s = await addSchedule(h, undefined, { botId: "writer", conversationId: "dw" });
  const r = await call(
    tools(h, { botId: "writer", conversation: () => "gc", groupSession: true }).remove,
    { id: s.id },
  );
  expect(r.isError).toBe(true);
  expect(textOf(r)).toContain("not found");
  expect((await h.board.list()).map((x) => x.id)).toEqual([s.id]);
});

test("a group session with no current conversation refuses instead of widening the scope", async () => {
  const h = makeBoard();
  await addSchedule(h, undefined, { botId: "writer", conversationId: "dw" });
  const r = await call(
    tools(h, { botId: "writer", conversation: () => undefined, groupSession: true }).list,
    {},
  );
  expect(r.isError).toBe(true);
});

test("the input schema bounds name (1-80) and task (1-4000)", () => {
  const h = makeBoard();
  for (const t of [tools(h).create, tools(h).update]) {
    const schema = z.object(t.inputSchema).partial();
    expect(schema.safeParse({ name: "x".repeat(80), task: "t".repeat(4000) }).success).toBe(true);
    for (const bad of [
      { name: "" },
      { name: "x".repeat(81) },
      { task: "" },
      { task: "t".repeat(4001) },
    ])
      expect(schema.safeParse(bad).success).toBe(false);
  }
});

test("ScheduleUpdate with rule fields but no repeat names the fields in its refusal", async () => {
  const h = makeBoard();
  const s = await addSchedule(h);
  const r = await call(tools(h).update, { id: s.id, at: "09:00", weekday: "mon" });
  expect(r.isError).toBe(true);
  expect(textOf(r)).toBe(
    "Rule fields at, weekday were sent without repeat. To change the rule, send repeat with all the fields it needs.",
  );
});

test("ScheduleCreate and ScheduleList are always loaded; update and delete may be deferred", () => {
  const t = tools(makeBoard());
  const KEY = "anthropic/alwaysLoad";
  expect(t.create._meta?.[KEY]).toBe(true);
  expect(t.list._meta?.[KEY]).toBe(true);
  expect(t.update._meta?.[KEY]).toBeUndefined();
  expect(t.remove._meta?.[KEY]).toBeUndefined();
});
