import { expect, test } from "bun:test";
import { parseTopic, topicFor } from "../src/channel-topic";

test("topics round-trip for a bot and a group", () => {
  expect(topicFor({ kind: "bot", botId: "ann" })).toBe("friday:bot:ann");
  expect(topicFor({ kind: "group", groupId: "team" })).toBe("friday:group:team");
  expect(parseTopic("friday:bot:ann")).toEqual({ kind: "bot", botId: "ann" });
  expect(parseTopic("friday:group:team")).toEqual({ kind: "group", groupId: "team" });
});

test("anything else is not a Friday topic", () => {
  for (const t of [
    null,
    undefined,
    "",
    "friday:bot:",
    "friday:bot:a extra",
    "other",
    "friday:x:a",
    "friday:bot:Bad_Id",
  ])
    expect(parseTopic(t)).toBeUndefined();
});
