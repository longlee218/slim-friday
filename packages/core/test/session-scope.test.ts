import { expect, test } from "bun:test";
import type { Conversation, Group } from "../src";
import { sessionScope } from "../src/hub/session-scope";
import { bot } from "./bot-hub-harness";

const editor = { ...bot("editor", "Editor"), workspaces: ["/own"] };
const direct: Conversation = { id: "dc", kind: "direct", botId: "editor" };
const groupConv: Conversation = { id: "gc", kind: "group", groupId: "g" };
const group = (over: Partial<Group> = {}): Group => ({
  id: "g",
  name: "G",
  members: ["editor"],
  entryBot: "editor",
  workspaces: ["/proj"],
  instructions: "",
  ...over,
});

test("a direct conversation scopes the bot by its id with its own workspaces", () => {
  expect(sessionScope(editor, direct, undefined)).toEqual({ key: "editor", bot: editor });
});

test("a group conversation scopes the bot by id@group with the group's workspaces", () => {
  expect(sessionScope(editor, groupConv, group())).toEqual({
    key: "editor@g",
    groupId: "g",
    bot: { ...editor, workspaces: ["/proj"] },
  });
});

test("a group with no workspaces gives the bot none, even when it has its own", () => {
  expect(sessionScope(editor, groupConv, group({ workspaces: [] }))?.bot.workspaces).toEqual([]);
});

test("a group conversation without its group, or whose members lack the bot, has no scope", () => {
  expect(sessionScope(editor, groupConv, undefined)).toBeUndefined();
  expect(sessionScope(editor, groupConv, group({ members: ["writer"] }))).toBeUndefined();
});

test("scopeBot is applied to the bot of both scopes, with the group id on a group scope", () => {
  const seen: (string | undefined)[] = [];
  const scopeBot = (b: typeof editor, groupId?: string) => {
    seen.push(groupId);
    return { ...b, instructions: `scoped ${groupId ?? "direct"}` };
  };
  expect(sessionScope(editor, direct, undefined, scopeBot)?.bot.instructions).toBe("scoped direct");
  expect(sessionScope(editor, groupConv, group(), scopeBot)?.bot.instructions).toBe("scoped g");
  expect(seen).toEqual([undefined, "g"]);
});

test("a ticket wake of a group ticket gets the ticket scope with the group's workspaces", () => {
  expect(sessionScope(editor, direct, undefined, undefined, group())).toEqual({
    key: "editor#ticket@g",
    groupId: "g",
    bot: { ...editor, workspaces: ["/proj"] },
  });
});

test("a ticket of a group the bot is not a member of gets no scope", () => {
  expect(
    sessionScope(editor, direct, undefined, undefined, group({ members: ["writer"] })),
  ).toBeUndefined();
});

test("a direct ticket (no ticketGroup) keeps the direct scope", () => {
  expect(sessionScope(editor, direct, undefined, undefined, undefined)).toEqual({
    key: "editor",
    bot: editor,
  });
});

test("scopeBot shapes a ticket scope with the group id", () => {
  const scopeBot = (b: typeof editor, groupId?: string) => ({
    ...b,
    instructions: `in ${groupId}`,
  });
  expect(sessionScope(editor, direct, undefined, scopeBot, group())?.bot.instructions).toBe("in g");
});
