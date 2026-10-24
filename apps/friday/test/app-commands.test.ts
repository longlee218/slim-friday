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
