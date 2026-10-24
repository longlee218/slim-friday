import { expect, test } from "bun:test";
import type { Bot, Conversation, Group } from "../src";
import { ChainGuard } from "../src/routing/chain-guard";
import { parseMentions } from "../src/routing/parse-mentions";
import { routeMessage } from "../src/routing/route-message";
import { FakeClock } from "./fakes/fake-clock";

const bot = (id: string, name: string): Bot => ({
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
const writer = bot("writer-id", "Writer");
const editor = bot("editor-id", "Editor");
const group: Group = {
  id: "g",
  name: "G",
  members: ["writer-id", "editor-id"],
  entryBot: "writer-id",
  workspaces: [],
  instructions: "",
};
const groupConv: Conversation = { id: "c", kind: "group", groupId: "g" };
const directConv: Conversation = { id: "d", kind: "direct", botId: "editor-id" };
const members = [writer, editor];

test("parseMentions: whole words, case-insensitive, once each, in text order", () => {
  expect(parseMentions("hi @Writer and @editor, @writer again", members)).toEqual([
    "writer-id",
    "editor-id",
  ]);
  expect(parseMentions("mail a@writer.com", members)).toEqual([]);
  expect(parseMentions("hey @ghost", members)).toEqual([]);
});

test("routeMessage: direct goes to its bot", () => {
  expect(routeMessage(directConv, undefined, [editor], "hello")).toEqual(["editor-id"]);
});

test("routeMessage: group without a mention goes to the entry bot", () => {
  expect(routeMessage(groupConv, group, members, "plan a video")).toEqual(["writer-id"]);
});

test("routeMessage: group mention wakes only the mentioned member", () => {
  expect(routeMessage(groupConv, group, members, "@editor check")).toEqual(["editor-id"]);
});

test("routeMessage: a bot reply with no mention wakes nobody; a self mention is ignored", () => {
  expect(routeMessage(groupConv, group, members, "done", "writer-id")).toEqual([]);
  expect(routeMessage(groupConv, group, members, "@writer me", "writer-id")).toEqual([]);
  expect(routeMessage(groupConv, group, members, "@editor go", "writer-id")).toEqual(["editor-id"]);
});

const wake = (over: Record<string, unknown> = {}) => ({
  conversationId: "c",
  sender: { kind: "bot" as const, botId: "writer-id" },
  target: "editor-id",
  text: "@editor go",
  hop: 1,
  ...over,
});

test("ChainGuard: hops over the limit fail", () => {
  const g = new ChainGuard(new FakeClock(0));
  expect(g.check(wake({ hop: 8 }))).toEqual({ ok: true });
  expect(g.check(wake({ hop: 9 }))).toEqual({ ok: false, reason: "hops" });
});

test("ChainGuard: bot messages per conversation per hour are capped; user wakes are not counted", () => {
  const clock = new FakeClock(0);
  const g = new ChainGuard(clock);
  for (let i = 0; i < 60; i++) g.record(wake({ text: `m${i}` }));
  expect(g.check(wake({ text: "new" }))).toEqual({ ok: false, reason: "rate" });
  expect(g.check(wake({ sender: { kind: "user" }, text: "from user" }))).toEqual({ ok: true });
  clock.advance(3_600_001);
  expect(g.check(wake({ text: "new" }))).toEqual({ ok: true });
});

test("ChainGuard: the same sender, target and text inside the window is a repeat", () => {
  const clock = new FakeClock(0);
  const g = new ChainGuard(clock);
  g.record(wake());
  expect(g.check(wake())).toEqual({ ok: false, reason: "repeat" });
  expect(g.check(wake({ text: "@editor something else" }))).toEqual({ ok: true });
  clock.advance(600_001);
  expect(g.check(wake())).toEqual({ ok: true });
});

test("ChainGuard: a user may repeat a message; the repeat guard is for bots", () => {
  const g = new ChainGuard(new FakeClock(0));
  const w = wake({ sender: { kind: "user" }, hop: 0 });
  g.record(w);
  expect(g.check(w)).toEqual({ ok: true });
});
