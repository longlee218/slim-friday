import { expect, test } from "bun:test";
import type { Bot, Group } from "@friday/core";
import { DiscordSurface } from "../src/discord-surface";
import { syncChannels } from "../src/sync-channels";
import { FakeDiscordPort } from "./fake-discord-port";

const bot = (id: string, name = id): Bot => ({
  id,
  name,
  title: "t",
  instructions: "i",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
});
const group: Group = {
  id: "team",
  name: "Team",
  members: ["ann", "bob"],
  entryBot: "ann",
  workspaces: [],
  instructions: "",
};
function setup() {
  const port = new FakeDiscordPort();
  const surface = new DiscordSurface(port, () => undefined);
  return { port, surface };
}

test("a fresh guild gets one category and a private channel per bot and group", async () => {
  const { port, surface } = setup();
  const r = await syncChannels(port, surface, [bot("ann", "Ann"), bot("bob", "Bob")], [group]);
  expect(r.errors).toEqual([]);
  expect(port.categoriesCreated).toBe(1);
  const made = port.channels.filter((c) => c.topic);
  expect(made.map((c) => c.topic).sort()).toEqual([
    "friday:bot:ann",
    "friday:bot:bob",
    "friday:group:team",
  ]);
  expect(made.find((c) => c.topic === "friday:bot:ann")?.name).toBe("ann");
  expect(r.conversations).toHaveLength(3);
  expect(r.created).toHaveLength(3);
  const direct = r.conversations.find((c) => c.kind === "direct" && c.botId === "ann");
  expect(direct?.id).toBe(made.find((c) => c.topic === "friday:bot:ann")?.id ?? "");
});

test("a second sync creates nothing and returns the same conversations", async () => {
  const { port, surface } = setup();
  const bots = [bot("ann"), bot("bob")];
  const first = await syncChannels(port, surface, bots, [group]);
  const second = await syncChannels(port, surface, bots, [group]);
  expect(second.created).toEqual([]);
  expect(second.conversations).toEqual(first.conversations);
  expect(port.categoriesCreated).toBe(1);
});

test("an existing channel with a Friday topic is reused", async () => {
  const { port, surface } = setup();
  port.channels.push({ id: "old1", name: "whatever", topic: "friday:bot:ann" });
  const r = await syncChannels(port, surface, [bot("ann")], []);
  expect(r.created).toEqual([]);
  expect(r.conversations).toEqual([{ id: "old1", kind: "direct", botId: "ann" }]);
});

test("a channel of a removed bot is left alone and not mapped", async () => {
  const { port, surface } = setup();
  port.channels.push({ id: "gone", name: "x", topic: "friday:bot:ghost" });
  const got: string[] = [];
  surface.onMessage(async (m) => got.push(m.conversationId));
  const r = await syncChannels(port, surface, [bot("ann")], []);
  expect(r.conversations.map((c) => c.id)).not.toContain("gone");
  port.emitMessage({ channelId: "gone", text: "hi" });
  expect(got).toEqual([]);
  expect(port.channels.some((c) => c.id === "gone")).toBe(true);
});

test("one failing create is an error and the others still get a channel", async () => {
  const { port, surface } = setup();
  port.failNext("createPrivateChannel");
  const r = await syncChannels(port, surface, [bot("ann"), bot("bob")], []);
  expect(r.errors).toHaveLength(1);
  expect(r.conversations).toHaveLength(1);
});

test("mapped channels accept owner messages", async () => {
  const { port, surface } = setup();
  const got: string[] = [];
  surface.onMessage(async (m) => got.push(m.conversationId));
  const r = await syncChannels(port, surface, [bot("ann")], []);
  const id = r.conversations[0]?.id ?? "";
  port.emitMessage({ channelId: id, text: "hi" });
  expect(got).toEqual([id]);
});
