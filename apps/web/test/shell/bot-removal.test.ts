import { expect, test } from "vitest";
import {
  type GroupAfterRemoval,
  groupAfterBotRemoval,
} from "../../src/components/shell/bot-removal";

// The same table pins the core copy of this rule (packages/core/test/bot-removal.test.ts).
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
