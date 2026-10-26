import { expect, test } from "bun:test";
import type { Author, StoredMessage } from "@friday/core";
import { ownTurns } from "../src/own-turns";

/** Messages of one conversation, in order: `[who, text]` with `user`, `system` or a bot id. */
const chat = (...lines: [string, string][]): StoredMessage[] =>
  lines.map(([who, text], i) => {
    const author: Author =
      who === "user" || who === "system" ? { kind: who } : { kind: "bot", botId: who };
    return { conversationId: "c", author, text, at: i };
  });

test("keeps the owner line this bot answered", () => {
  const all = chat(["user", "q1"], ["dev", "a1"], ["user", "q2"], ["scout", "a2"]);
  expect(ownTurns(all, "dev").map((m) => m.text)).toEqual(["q1", "a1"]);
});

test("other bot's exchange gives nothing", () => {
  const all = chat(["user", "q"], ["system", "joined"], ["scout", "a"]);
  expect(ownTurns(all, "dev")).toEqual([]);
});

test("owner lines before this bot's answer are kept across a system line; system lines go", () => {
  const all = chat(
    ["user", "q1"],
    ["user", "q2"],
    ["system", "note"],
    ["dev", "a"],
    ["user", "q3"],
  );
  expect(ownTurns(all, "dev").map((m) => m.text)).toEqual(["q1", "q2", "a"]);
});
