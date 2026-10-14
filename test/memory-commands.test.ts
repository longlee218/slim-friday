import { expect, test } from "bun:test";
import { parseMemoryCommand } from "../src/memory/memory-commands";
import { parseMessageCommand } from "../src/orchestrator/message-commands";

test("remember / nhớ / /remember are NOT memory commands (the agent gets them as plain messages)", () => {
  for (const t of [
    "remember: use bun",
    "REMEMBER:global use bun",
    "nhớ: chung dùng bun",
    "Nhớ: ws dùng bun",
    "remember: location:Api run make",
    "nh\u1edb: x y z".normalize("NFD"),
    "remember: ab",
    "remember:",
    "/remember use pnpm in location x",
  ])
    expect(parseMemoryCommand(t)).toBeNull();
});

test("forget/quên scope words (only the first word is a scope), compact/gom nén, and non-commands", () => {
  const p = (s: string) => parseMemoryCommand(s);
  expect(p("forget: ws old note")).toEqual({
    kind: "forget",
    scope: { kind: "workspace" },
    needle: "old note",
  });
  expect(p("quên: chung abc")).toMatchObject({ kind: "forget", scope: { kind: "global" } });
  expect(p("forget: location:Api old")).toMatchObject({
    scope: { kind: "location", name: "Api" },
    needle: "old",
  });
  expect(p("forget: note chung stuff")).toMatchObject({
    scope: { kind: "default" },
    needle: "note chung stuff",
  });
  expect(p("/forget abc def")).toMatchObject({ kind: "forget" });
  expect(p("compact memory")).toEqual({ kind: "compact", dryRun: false });
  expect(p("Gom nén dry-run")).toEqual({ kind: "compact", dryRun: true });
  for (const t of [
    "how do I remember things?",
    "remember to run tests",
    "compact memory please",
    "forgetful: x",
  ])
    expect(p(t)).toBeNull();
});

test("bad forget lengths and scope-only commands are invalid (never null, never the agent)", () => {
  expect(parseMemoryCommand("forget: ab")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand(`forget: ws ${"x".repeat(101)}`)).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand("forget: global")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand("forget:")).toMatchObject({ kind: "invalid" });
});

test("parseMessageCommand: forget/compact are memory commands; remember is a plain message for the agent", () => {
  expect(parseMessageCommand("forget: use bun")).toEqual({ kind: "memory" });
  expect(parseMessageCommand("compact memory")).toEqual({ kind: "memory" });
  expect(parseMessageCommand("remember: use bun")).toMatchObject({
    kind: "message",
    text: "remember: use bun",
  });
  expect(parseMessageCommand("nhớ: dùng bun")).toMatchObject({ kind: "message" });
  // the slash form forwards its text as the same ordinary message
  expect(parseMessageCommand("/remember use pnpm in location x")).toMatchObject({
    kind: "message",
    text: "remember: use pnpm in location x",
  });
  expect(parseMessageCommand("what is remember: for?")).toMatchObject({ kind: "message" });
});

test("forget: the pre-v7 `repo:<name>` scope word is an alias of `location:<name>`", () => {
  expect(parseMemoryCommand("forget: repo:api old note")).toEqual({
    kind: "forget",
    scope: { kind: "location", name: "api" },
    needle: "old note",
  });
});
