import { expect, test } from "bun:test";
import type { BotHub } from "@friday/core";
import { FakeStore } from "../../../packages/core/test/fakes/fake-store";
import { appCommands } from "../src/app-commands";

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

/** The /tickets handler over a fake store with bots writer and editor. */
function setup() {
  const store = new FakeStore();
  store.botMap.set("writer", bot("writer", "Writer"));
  store.botMap.set("editor", bot("editor", "Editor"));
  const run = appCommands({ hub: {} as BotHub, store, home: "/nowhere" });
  const add = (
    title: string,
    createdAt: number,
    status: "todo" | "done" | "closed",
    assignee?: string,
  ) =>
    store.tickets.create({
      title,
      status,
      priority: "normal",
      createdBy: { kind: "user" },
      createdAt,
      ...(assignee && { assigneeBotId: assignee }),
    });
  const tickets = () => run({ conversationId: "c", name: "tickets" });
  return { add, tickets };
}

test("/tickets lists open tickets newest first with assignee names", async () => {
  const { add, tickets } = setup();
  await add("Old one", 1, "todo", "writer");
  await add("New one", 2, "todo", "editor");
  expect(await tickets()).toBe("FRI-2 [todo] New one — Editor\nFRI-1 [todo] Old one — Writer");
});

test("/tickets with none open answers No open tickets.", async () => {
  const { tickets } = setup();
  expect(await tickets()).toBe("No open tickets.");
});

test("closed and done tickets are left out", async () => {
  const { add, tickets } = setup();
  await add("Finished", 1, "done");
  await add("Gone", 2, "closed");
  await add("Open", 3, "todo");
  expect(await tickets()).toBe("FRI-3 [todo] Open — unassigned");
});

/** /stop and /status over a fake hub that records its stop calls and reports `sessions`. */
function hubSetup(sessions: { botId: string; groupId?: string }[] = []) {
  const store = new FakeStore();
  store.botMap.set("writer", bot("writer", "Writer"));
  store.botMap.set("editor", bot("editor", "Editor"));
  store.groupMap.set("reelme", {
    id: "reelme",
    name: "Reelme",
    members: ["writer", "editor"],
    entryBot: "writer",
    workspaces: [],
    instructions: "",
  });
  store.convMap.set("d", { id: "d", kind: "direct", botId: "editor" });
  store.convMap.set("g", { id: "g", kind: "group", groupId: "reelme" });
  const calls: unknown[][] = [];
  const hub = {
    stop: async (...a: unknown[]) => void calls.push(["stop", ...a]),
    stopGroup: async (...a: unknown[]) => void calls.push(["stopGroup", ...a]),
    status: () => sessions.map((s) => ({ ...s, busy: false, tasks: [] })),
  } as unknown as BotHub;
  const run = appCommands({ hub, store, home: "/nowhere" });
  return { run, calls };
}

test("/stop in a direct channel stops only the bot's direct session", async () => {
  const { run, calls } = hubSetup();
  expect(await run({ conversationId: "d", name: "stop" })).toBe("Stopped Editor.");
  expect(calls).toEqual([["stop", "editor", "direct"]]);
});

test("/stop in a group channel stops only that group's sessions", async () => {
  const { run, calls } = hubSetup();
  expect(await run({ conversationId: "g", name: "stop" })).toBe("Stopped Writer, Editor.");
  expect(calls).toEqual([["stopGroup", "reelme"]]);
});

test("/stop @name stops every session of the bot", async () => {
  const { run, calls } = hubSetup();
  expect(await run({ conversationId: "g", name: "stop", botName: "@Editor" })).toBe(
    "Stopped Editor.",
  );
  expect(calls).toEqual([["stop", "editor"]]);
});

test("/status prints one line per session, with the group of a group session", async () => {
  const { run } = hubSetup([{ botId: "editor" }, { botId: "editor", groupId: "reelme" }]);
  expect(await run({ conversationId: "d", name: "status" })).toBe(
    "Editor: idle, 0 background task(s)\nEditor in reelme: idle, 0 background task(s)",
  );
});
