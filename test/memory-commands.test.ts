import { expect, test } from "bun:test";
import { parseMemoryCommand } from "../src/memory/memory-commands";
import { parseMessageCommand } from "../src/orchestrator/message-commands";

test("remember / /remember are NOT memory commands (the agent gets them as plain messages)", () => {
  for (const t of [
    "remember: use bun",
    "REMEMBER:global use bun",
    "remember: location:Api run make",
    "remember:",
    "/remember use pnpm in location x",
  ])
    expect(parseMemoryCommand(t)).toBeNull();
});

test("/forget scope words (only the first word is a scope), /compact, and non-commands", () => {
  const p = (s: string) => parseMemoryCommand(s);
  expect(p("/forget workspace old note")).toEqual({
    kind: "forget",
    scope: { kind: "workspace" },
    needle: "old note",
  });
  expect(p("/forget global abc")).toMatchObject({ kind: "forget", scope: { kind: "global" } });
  expect(p("/forget channel abc")).toMatchObject({ kind: "forget", scope: { kind: "channel" } });
  expect(p("/forget location:Api old")).toMatchObject({
    scope: { kind: "location", name: "Api" },
    needle: "old",
  });
  expect(p("/forget note global stuff")).toMatchObject({
    scope: { kind: "default" },
    needle: "note global stuff",
  });
  expect(p("/forget abc def")).toMatchObject({ kind: "forget" });
  expect(p("/compact")).toEqual({ kind: "compact", dryRun: false });
  expect(p("/Compact dry-run")).toEqual({ kind: "compact", dryRun: true });
  // text forms and the old aliases are not commands
  for (const t of [
    "how do I remember things?",
    "remember to run tests",
    "compact memory please",
    "compact memory",
    "forget: x y z",
    "quên: x y z",
    "gom nén",
    "forgetful: x",
  ])
    expect(p(t)).toBeNull();
  // the pre-v7 `repo:` scope word is gone: it is plain needle text in the default scope
  expect(p("/forget repo:api old note")).toMatchObject({ scope: { kind: "default" } });
});

test("bad /forget lengths and scope-only commands are invalid (never null, never the agent)", () => {
  expect(parseMemoryCommand("/forget ab")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand(`/forget workspace ${"x".repeat(101)}`)).toMatchObject({
    kind: "invalid",
  });
  expect(parseMemoryCommand("/forget global")).toMatchObject({ kind: "invalid" });
  expect(parseMemoryCommand("/forget")).toMatchObject({ kind: "invalid" });
});

test("parseMessageCommand: /forget and /compact are memory commands; remember is a plain message for the agent", () => {
  expect(parseMessageCommand("/forget use bun")).toEqual({ kind: "memory" });
  expect(parseMessageCommand("/compact")).toEqual({ kind: "memory" });
  expect(parseMessageCommand("remember: use bun")).toEqual({ kind: "message" });
  expect(parseMessageCommand("/remember use pnpm in location x")).toEqual({ kind: "message" });
  expect(parseMessageCommand("what is remember: for?")).toEqual({ kind: "message" });
});
