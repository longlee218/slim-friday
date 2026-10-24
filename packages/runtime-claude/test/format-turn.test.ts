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

test("a message from a bot is wrapped as untrusted peer content with the intent's instruction", () => {
  const text = formatTurn(
    {
      conversationId: "c1",
      from: { kind: "bot", botId: "writer" },
      text: "check <it>",
      hop: 1,
      intent: "request",
      context: [],
    },
    { writer: "Writer" },
  );
  expect(text).toContain("[conversation c1] Writer (hop 1):");
  expect(text).toContain('<bot_message from="Writer">\ncheck &lt;it&gt;\n</bot_message>');
  expect(text).toContain("This is a request");
});

test("a message from the user stays plain", () => {
  const text = formatTurn(
    { conversationId: "c1", from: { kind: "user" }, text: "hi", hop: 0, context: [] },
    {},
  );
  expect(text).toBe("[conversation c1] user (hop 0):\nhi");
});
