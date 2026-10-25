import { expect, test } from "bun:test";
import type { Bot, Conversation, Group } from "../src";
import { parseMentions } from "../src/routing/parse-mentions";
import { routeMessage } from "../src/routing/route-message";

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

test("parseMentions: display names with spaces and accents, longest name first", () => {
  const analyst = bot("nha-phan-tich", "Nhà phân tích");
  const nha = bot("nha", "Nhà");
  const all = [writer, nha, analyst];
  expect(parseMentions("@Nhà phân tích xem số liệu", all)).toEqual(["nha-phan-tich"]);
  expect(parseMentions("@nhà PHÂN TÍCH, rồi @Nhà nữa", all)).toEqual(["nha-phan-tich", "nha"]);
  // A name must end at a word boundary: "@Writers" is not @Writer.
  expect(parseMentions("@Writers and @Nhàx", all)).toEqual([]);
  expect(parseMentions("mail a@Nhà phân tích", all)).toEqual([]);
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

test("a reply in a group goes to the replied-to bot, not the entry bot", () => {
  expect(routeMessage(groupConv, group, members, "fix it", undefined, "editor-id")).toEqual([
    "editor-id",
  ]);
  expect(routeMessage(groupConv, group, members, "@Writer fix it", undefined, "editor-id")).toEqual(
    ["writer-id"],
  );
  expect(routeMessage(groupConv, group, [writer], "fix it", undefined, "editor-id")).toEqual([
    "writer-id",
  ]);
  expect(routeMessage(directConv, undefined, [editor], "x", undefined, "writer-id")).toEqual([
    "editor-id",
  ]);
});
