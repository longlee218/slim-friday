import { expect, test } from "bun:test";
import { formatTurn } from "../src/session/format-turn";

test("group memory is printed before the recent messages", () => {
  const text = formatTurn(
    {
      conversationId: "g1",
      from: { kind: "user" },
      text: "go",
      hop: 0,
      context: [{ conversationId: "g1", author: { kind: "user" }, text: "earlier", at: 1 }],
      groupMemory: "- team uses bun",
    },
    {},
  );
  expect(text.startsWith("Group memory:\n- team uses bun\n\nRecent messages:\nuser: earlier")).toBe(
    true,
  );
});
