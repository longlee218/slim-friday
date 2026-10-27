import { expect, test } from "bun:test";
import type { Conversation, Group } from "@friday/core";
import {
  GROUP_SCOPE_REFUSED,
  resolveOwner,
  type ToolSessionContext,
} from "../src/memory/memory-owner";

const team: Group = {
  id: "team",
  name: "Team",
  members: ["ann"],
  entryBot: "ann",
  workspaces: [],
  instructions: "",
};
const dm: Conversation = { id: "dm", kind: "direct", botId: "ann" };

/** Ann's context while she answers in her DM, in the session of `groupId` (a ticket session) or the direct one. */
const ctx = (groupId?: string, botId = "ann"): ToolSessionContext => ({
  botId,
  conversation: async () => dm,
  group: async (id) => (id === "team" ? team : undefined),
  ...(groupId && { groupId }),
});

test("group scope resolves from the session group in a ticket session", async () => {
  expect(await resolveOwner("group", ctx("team"))).toEqual({ kind: "group", groupId: "team" });
});

test("group scope stays refused in the direct session", async () => {
  expect(await resolveOwner("group", ctx())).toBe(GROUP_SCOPE_REFUSED);
});

test("group scope of a session group the bot is not a member of, or a missing group, is refused", async () => {
  expect(await resolveOwner("group", ctx("team", "bob"))).toBe(GROUP_SCOPE_REFUSED);
  expect(await resolveOwner("group", ctx("gone"))).toBe(GROUP_SCOPE_REFUSED);
});
