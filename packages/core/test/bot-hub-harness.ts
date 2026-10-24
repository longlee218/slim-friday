import type { Bot, Conversation, Group, Memory } from "../src";
import { BotHub } from "../src/hub/bot-hub";
import { PermissionGate } from "../src/permission/permission-gate";
import { FakeClock } from "./fakes/fake-clock";
import { FakeLog } from "./fakes/fake-log";
import { FakeRuntime } from "./fakes/fake-runtime";
import { FakeStore } from "./fakes/fake-store";
import { FakeSurface } from "./fakes/fake-surface";
import { FakeToolCatalog } from "./fakes/fake-tool-catalog";

export const bot = (id: string, name: string): Bot => ({
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

/** Let queued promises and microtasks settle. */
export const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A hub over fakes with bots writer (entry) and editor in group "g", a group chat "gc", and a direct chat "dc" with editor. */
export function makeHub(memory?: Memory) {
  const store = new FakeStore();
  const runtime = new FakeRuntime();
  const surface = new FakeSurface();
  const clock = new FakeClock(0);
  const log = new FakeLog();
  const writer = bot("writer", "Writer");
  const editor = bot("editor", "Editor");
  store.botMap.set("writer", writer);
  store.botMap.set("editor", editor);
  const group: Group = { id: "g", name: "G", members: ["writer", "editor"], entryBot: "writer" };
  store.groupMap.set("g", group);
  store.convMap.set("gc", { id: "gc", kind: "group", groupId: "g" } satisfies Conversation);
  store.convMap.set("dc", { id: "dc", kind: "direct", botId: "editor" } satisfies Conversation);
  const gate = new PermissionGate({
    store,
    surface,
    clock,
    catalog: new FakeToolCatalog([]),
    settings: () => ({ level: "balanced" }),
  });
  const hub = new BotHub({ runtime, surface, store, clock, gate, log, ...(memory && { memory }) });
  hub.start();
  return { store, runtime, surface, clock, gate, hub, writer, editor, log };
}
