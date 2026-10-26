import { expect, test } from "bun:test";
import { type GroupAfterRemoval, groupAfterBotRemoval } from "../src/domain/group";

// The same table pins the web copy of this rule (apps/web/test/shell/bot-removal.test.ts).
type Case = [{ members: string[]; entryBot: string }, string, GroupAfterRemoval];
const cases: Case[] = [
  [{ members: ["a"], entryBot: "a" }, "a", { kind: "delete" }],
  [
    { members: ["a", "b", "c"], entryBot: "a" },
    "a",
    { kind: "update", members: ["b", "c"], entryBot: "b" },
  ],
  [
    { members: ["a", "b", "c"], entryBot: "c" },
    "c",
    { kind: "update", members: ["a", "b"], entryBot: "a" },
  ],
  [
    { members: ["a", "b", "c"], entryBot: "a" },
    "b",
    { kind: "update", members: ["a", "c"], entryBot: "a" },
  ],
];

test.each(cases)("group %o without %s", (group, botId, expected) => {
  expect(groupAfterBotRemoval(group, botId)).toEqual(expected);
});
